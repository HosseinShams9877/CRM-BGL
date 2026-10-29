import { describe, it, expect } from 'vitest';
import { validateDocItems } from '../src/components/sales-docs-shared';

// ════════════════════════════════════════════════════════
// v2.29.1 — the create-dialog item-row validator.
//
// Regression context: the three create dialogs used to silently drop
// invalid rows with items.filter(...) before submit — a partially filled
// row vanished without warning while the on-screen total still counted
// it (silent data loss / truthfulness violation). These tests pin the
// new contract: blank rows are skipped, partial rows block with a
// Persian row-numbered error, and the submit list is exactly what the
// user saw counted in the total.
// ════════════════════════════════════════════════════════

const PROFORMA = { noun: 'محصول' as const, emptyMessage: 'حداقل یک آیتم باید وارد شود.' };
const QS = { noun: 'کالا' as const, allowZeroPrice: true, emptyMessage: 'حداقل یک کالا وارد کنید.' };

const row = (over: Partial<{ productName: string; quantity: number; unitPrice: number; discount: number }> = {}) => ({
  productName: '', quantity: 1, unitPrice: 0, discount: 0, ...over,
});

describe('validateDocItems — blank rows', () => {
  it('skips a completely untouched row', () => {
    const v = validateDocItems([row({ productName: 'دستگاه', unitPrice: 100 }), row()], PROFORMA);
    expect(v.error).toBeNull();
    expect(v.submit).toHaveLength(1);
    expect(v.submit[0].productName).toBe('دستگاه');
  });

  it('errors when ALL rows are blank', () => {
    const v = validateDocItems([row(), row()], PROFORMA);
    expect(v.error).toBe('حداقل یک آیتم باید وارد شود.');
    expect(v.submit).toHaveLength(0);
  });

  it('empty list errors with the caller message', () => {
    const v = validateDocItems([], QS);
    expect(v.error).toBe('حداقل یک کالا وارد کنید.');
  });
});

describe('validateDocItems — partial rows must block (the v2.29.1 fix)', () => {
  it('name missing but price filled → Persian row-numbered error', () => {
    const v = validateDocItems([row(), row({ unitPrice: 5000, quantity: 2 })], PROFORMA);
    // Row 2 contributed 2×5000=10000 to the displayed total — it must NOT
    // be silently dropped (the old filter would have submitted []).
    expect(v.error).toBe('نام محصول در ردیف ۲ الزامی است.');
    expect(v.submit).toHaveLength(0);
  });

  it('quantity zero on a named row → error (old filter dropped it silently)', () => {
    const v = validateDocItems([row({ productName: 'ونتیلاتور', quantity: 0, unitPrice: 9000 })], PROFORMA);
    expect(v.error).toBe('تعداد در ردیف ۱ باید بیشتر از صفر باشد.');
  });

  it('row number counts blank rows too (matches what the user sees)', () => {
    const v = validateDocItems([row(), row(), row({ quantity: 0, unitPrice: 10, productName: 'x' })], PROFORMA);
    expect(v.error).toBe('تعداد در ردیف ۳ باید بیشتر از صفر باشد.');
  });
});

describe('validateDocItems — price rules per action', () => {
  it('create path (proforma/return): price 0 is invalid — server rejects it', () => {
    const v = validateDocItems([row({ productName: 'قلم', quantity: 1, unitPrice: 0 })], PROFORMA);
    // Not blank (name filled) → validated → price must be > 0, mirroring
    // the server's `!item.unitPrice` check on the create action.
    expect(v.error).toBe('قیمت واحد در ردیف ۱ نامعتبر است.');
  });

  it('quick-sale: price 0 is allowed (server only rejects negatives there)', () => {
    const v = validateDocItems([row({ productName: 'هدیه', quantity: 1, unitPrice: 0 })], QS);
    expect(v.error).toBeNull();
    expect(v.submit).toHaveLength(1);
  });

  it('quick-sale: negative price still invalid', () => {
    const v = validateDocItems([row({ productName: 'کالا', quantity: 1, unitPrice: -5 })], QS);
    expect(v.error).toBe('قیمت واحد در ردیف ۱ نامعتبر است.');
  });
});

describe('validateDocItems — submit list is truthful', () => {
  it('discount-only row is NOT blank (it changes the total) and blocks on name', () => {
    // discount 500 on an otherwise default row lowers the displayed total
    // by 500 — treating it as blank would silently change the amount.
    const v = validateDocItems([row({ discount: 500 })], PROFORMA);
    expect(v.error).toBe('نام محصول در ردیف ۱ الزامی است.');
  });

  it('valid multi-row submit preserves every row in order', () => {
    const rows = [
      row({ productName: 'الف', quantity: 2, unitPrice: 100, discount: 10 }),
      row({ productName: 'ب', quantity: 1, unitPrice: 50 }),
      row(), // trailing blank — skipped
    ];
    const v = validateDocItems(rows, PROFORMA);
    expect(v.error).toBeNull();
    expect(v.submit.map((r) => r.productName)).toEqual(['الف', 'ب']);
  });

  it('noun wording follows the caller (کالا for quick-sale)', () => {
    const v = validateDocItems([row({ unitPrice: 100, quantity: 2 })], QS);
    expect(v.error).toBe('نام کالا در ردیف ۱ الزامی است.');
  });
});
