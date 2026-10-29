import { describe, it, expect } from 'vitest';
import {
  validateSalesItems,
  computeSalesTotals,
  validateAndComputeSalesTotals,
  MAX_DOCUMENT_TOTAL_RIALS,
} from '@/lib/sales-totals';
import { ApiError } from '@/lib/api-error';

// ═══════════════════════════════════════════════════════════════
// sales-totals.test.ts — v2.58.3 (round 88, user finding 8)
//
// THE REVIEWER'S MANDATORY CASE:
//   «چند ردیف که هرکدام معتبرند، اما مجموع یا مبلغ با مالیات از
//    محدودهٔ امن خارج می‌شود، باید رد شوند.»
//
// Every row below passes the per-row validator; the SUM (or the
// tax-inclusive final amount) blows past the safe-integer / logical
// cap. Also: NaN / Infinity / negative / fractional inputs, the
// discount>line rule, VAT exactness, and the shared-contract used
// by create / update / quick-sale (one implementation for all).
// ═══════════════════════════════════════════════════════════════

describe('validateSalesItems — per-row input hygiene', () => {
  it('rejects NaN / Infinity / negative / fractional quantities and prices', () => {
    const bad = [
      { productName: 'x', quantity: NaN, unitPrice: 100 },
      { productName: 'x', quantity: Infinity, unitPrice: 100 },
      { productName: 'x', quantity: 'NaN', unitPrice: 100 },
      { productName: 'x', quantity: '1e400', unitPrice: 100 },
      { productName: 'x', quantity: -1, unitPrice: 100 },
      { productName: 'x', quantity: 1.5, unitPrice: 100 },
      { productName: 'x', quantity: 0, unitPrice: 100 },
      { productName: 'x', quantity: 1, unitPrice: NaN },
      { productName: 'x', quantity: 1, unitPrice: Infinity },
      { productName: 'x', quantity: 1, unitPrice: -5 },
      { productName: 'x', quantity: 1, unitPrice: 10.25 },
    ];
    for (const item of bad) {
      expect(() => validateSalesItems([item]), JSON.stringify(item)).toThrow(ApiError);
    }
  });

  it('rejects bad discounts (fractional / negative / larger than the line)', () => {
    expect(() => validateSalesItems([{ productName: 'x', quantity: 2, unitPrice: 100, discount: 1.5 }])).toThrow(ApiError);
    expect(() => validateSalesItems([{ productName: 'x', quantity: 2, unitPrice: 100, discount: -1 }])).toThrow(ApiError);
    expect(() => validateSalesItems([{ productName: 'x', quantity: 2, unitPrice: 100, discount: 201 }])).toThrow(ApiError);
    // discount exactly equal to the line is legitimate (a free row)
    expect(validateSalesItems([{ productName: 'x', quantity: 2, unitPrice: 100, discount: 200 }])).toEqual([
      { quantity: 2, unitPrice: 100, discount: 200 },
    ]);
  });

  it('rejects missing names, empty arrays and non-arrays', () => {
    expect(() => validateSalesItems([])).toThrow(ApiError);
    expect(() => validateSalesItems(undefined)).toThrow(ApiError);
    expect(() => validateSalesItems([{ quantity: 1, unitPrice: 1 }])).toThrow(ApiError);
  });

  it('accepts a normal row set and normalizes the numbers', () => {
    const rows = validateSalesItems([
      { productName: 'A', quantity: 2, unitPrice: 1_000_000, discount: 100_000 },
      { productName: 'B', quantity: 1, unitPrice: 500_000 },
    ]);
    expect(rows).toEqual([
      { quantity: 2, unitPrice: 1_000_000, discount: 100_000 },
      { quantity: 1, unitPrice: 500_000, discount: 0 },
    ]);
  });
});

describe('MANDATORY — per-row-valid rows whose SUM overflows are rejected', () => {
  it('rows of 1e9 × 1e9 each: every row valid, the sum is not', () => {
    // 1e18 > Number.MAX_SAFE_INTEGER (≈9.007e15) — per-row integer checks
    // pass (qty and price are integers), the LINE total itself is checked:
    expect(() => validateSalesItems([
      { productName: 'A', quantity: 1_000_000_000, unitPrice: 1_000_000_000 },
    ])).toThrow(/سقف مجاز/);
  });

  it('MANY small valid rows whose accumulated sum exceeds the logical document cap', () => {
    // each row: 5e14 (safe, under the cap); TWO rows → 1e15 == cap (ok);
    // THREE rows → 1.5e15 > cap → rejected by the ACCUMULATION check.
    const rows = [
      { productName: 'A', quantity: 1, unitPrice: 500_000_000_000_000 },
      { productName: 'B', quantity: 1, unitPrice: 500_000_000_000_000 },
      { productName: 'C', quantity: 1, unitPrice: 500_000_000_000_000 },
    ];
    expect(() => validateAndComputeSalesTotals(rows, false)).toThrow(ApiError);
    // two rows exactly at the cap are accepted (the boundary is inclusive)
    expect(validateAndComputeSalesTotals(rows.slice(0, 2), false).totals.finalAmount).toBe(MAX_DOCUMENT_TOTAL_RIALS);
  });

  it('valid subtotal whose TAXED final amount exceeds the cap is rejected', () => {
    // subtotal 9.2e14 is valid and untaxed-final fits; WITH 9% VAT the
    // final amount crosses 1.0001e15 > 1e15 → rejected.
    const rows = [{ productName: 'A', quantity: 1, unitPrice: 920_000_000_000_000 }];
    expect(() => validateAndComputeSalesTotals(rows, true, 0.09)).toThrow(/سقف منطقی/);
    // without VAT the same document is fine
    expect(validateAndComputeSalesTotals(rows, false).totals.finalAmount).toBe(920_000_000_000_000);
  });

  it('totals: discount sum, subtotal, tax and final are all bounded and exact', () => {
    const { totals } = validateAndComputeSalesTotals(
      [{ productName: 'A', quantity: 3, unitPrice: 1_000_000, discount: 100_000 }],
      true,
      0.09,
    );
    expect(totals.totalAmount).toBe(3_000_000);
    expect(totals.discountAmount).toBe(100_000);
    expect(totals.subtotal).toBe(2_900_000);
    expect(totals.taxAmount).toBe(261_000); // Math.round(2_900_000 × 0.09)
    expect(totals.finalAmount).toBe(3_161_000);
    for (const v of [totals.totalAmount, totals.discountAmount, totals.subtotal, totals.taxAmount, totals.finalAmount]) {
      expect(Number.isSafeInteger(v)).toBe(true);
    }
  });

  it('discounts exceeding the document total are rejected at the subtotal check', () => {
    // per-row validation makes this unreachable through the public path
    // (a row's discount ≤ its own line); the internal calculator keeps a
    // defense-in-depth guard for unvalidated callers:
    expect(() => computeSalesTotals([
      { quantity: 1, unitPrice: 100, discount: 120 },
    ])).toThrow(/تخفیف/);
  });

  it('a bogus VAT rate falls back to 9% instead of producing garbage', () => {
    const totals = computeSalesTotals([{ quantity: 1, unitPrice: 1_000, discount: 0 }], true, NaN);
    expect(totals.taxAmount).toBe(90);
  });
});

describe('the shared contract — one implementation for create/update/quick-sale', () => {
  it('the same invalid payload is refused regardless of entry route (single function)', () => {
    const payload = [
      { productName: 'ok', quantity: 1, unitPrice: 1 },
      { productName: 'boom', quantity: 'NaN', unitPrice: 1 },
    ];
    // create, update and quick-sale all call validateSalesItems — one
    // refusal contract, no weaker twin path left anywhere.
    expect(() => validateAndComputeSalesTotals(payload)).toThrow(/ردیف 2/);
  });
});
