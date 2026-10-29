// ════════════════════════════════════════════════════════════
// SALES TOTALS — shared validator + exact calculator (v2.58.3,
// round 88, user finding 8).
//
// WHY: the per-row validator checked each row's cap, but the SUM of
// rows and the tax-inclusive final amount could silently pass
// Number.MAX_SAFE_INTEGER (e.g. 1e9 × 1e9 rows), losing integer
// precision in Float storage; quick-sale and update did not even
// run the integer checks. Three routes, three divergent validators.
//
// THE CONTRACT (one shared implementation for create / update /
// quick-sale):
//   • every numeric input is Number.isFinite — NaN / ±Infinity /
//     negative / non-integer values are rejected BEFORE any write;
//   • per-row line totals AND every intermediate accumulation stay
//     exact safe integers (checked after EACH addition, not only at
//     the end — partial overflow cannot slip through);
//   • a logical cap bounds the whole document (MAX_DOCUMENT_TOTAL);
//   • totalAmount / discountAmount / subtotal / taxAmount /
//     finalAmount are ALL validated before returning;
//   • invalid input throws ApiError(400) with a Persian, row-numbered
//     message — the caller writes NOTHING.
// ════════════════════════════════════════════════════════════

import { ApiError } from '@/lib/api-error';

/**
 * Logical document ceiling: 1,000,000,000,000,000 ریال
 * (۱۰۱۵ ریال ≈ ۱۰۰ میلیارد تومان) — no real invoice in this business
 * domain approaches it; anything above is input abuse, not commerce.
 */
export const MAX_DOCUMENT_TOTAL_RIALS = 1_000_000_000_000_000;

/** Same ceiling per row (a single row cannot bypass the document cap). */
export const MAX_LINE_TOTAL_RIALS = MAX_DOCUMENT_TOTAL_RIALS;

/** Max rows per document (sanity guard against sum-overflow-by-volume). */
export const MAX_SALES_ITEM_ROWS = 200;

export interface SalesItemNumericInput {
  productId?: string;
  productName?: string;
  quantity?: unknown;
  unitPrice?: unknown;
  discount?: unknown;
  description?: string;
  unit?: string;
}

export interface NormalizedSalesItem {
  quantity: number;
  unitPrice: number;
  discount: number;
}

export interface SalesTotals {
  totalAmount: number;
  discountAmount: number;
  subtotal: number;
  taxAmount: number;
  finalAmount: number;
}

/**
 * v2.58.4 (user issue 5) — applyVat is a REAL boolean or absent.
 * The routes used `applyVat !== false`, so "false" (string), 0 and null
 * all meant VAT-ON. Callers run this BEFORE any write.
 */
export function assertApplyVatBoolean(applyVat: unknown): void {
  if (applyVat !== undefined && typeof applyVat !== 'boolean') {
    throw new ApiError(400, 'اعمال مالیات باید مقداری بولی (true/false) باشد.');
  }
}

/**
 * Validate the raw item rows (row-numbered Persian 400s). Returns the
 * normalized numeric rows — the caller never touches the raw values again.
 *
 * v2.58.4 (user issue 5) — TYPE-FIRST: the pre-fix helper coerced with
 * Number() before any check, so '2' (string), true (boolean) and null
 * (→ 0 for unitPrice!) all slipped through as numbers. The type is now
 * checked BEFORE any conversion: quantity/unitPrice accept ONLY real
 * numbers; discount accepts absent/null/'' (legacy empty inputs) or a
 * real number. NaN/±Infinity are numbers but still rejected below.
 */
export function validateSalesItems(items: unknown): NormalizedSalesItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'حداقل یک آیتم باید وارد شود.');
  }
  if (items.length > MAX_SALES_ITEM_ROWS) {
    throw new ApiError(400, `تعداد ردیف‌های سند نباید از ${MAX_SALES_ITEM_ROWS} بیشتر باشد.`);
  }

  const normalized: NormalizedSalesItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as SalesItemNumericInput;
    const row = i + 1;

    const name = typeof item?.productName === 'string' ? item.productName.trim() : '';
    if (!name) {
      throw new ApiError(400, `نام محصول در ردیف ${row} الزامی است.`);
    }

    // quantity: a REAL number (typeof-checked FIRST — no string/boolean
    // coercion), finite, positive, integer
    if (typeof item?.quantity !== 'number') {
      throw new ApiError(400, `تعداد در ردیف ${row} باید عدد باشد.`);
    }
    const qty = item.quantity;
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new ApiError(400, `تعداد در ردیف ${row} باید عددی بزرگ‌تر از صفر باشد.`);
    }
    if (!Number.isInteger(qty)) {
      throw new ApiError(400, `تعداد در ردیف ${row} باید عدد صحیح باشد.`);
    }

    // unitPrice: a REAL number, finite, non-negative, integer (Rial)
    if (typeof item?.unitPrice !== 'number') {
      throw new ApiError(400, `قیمت واحد در ردیف ${row} باید عدد باشد.`);
    }
    const price = item.unitPrice;
    if (!Number.isFinite(price) || price < 0) {
      throw new ApiError(400, `قیمت واحد در ردیف ${row} نامعتبر است.`);
    }
    if (!Number.isInteger(price)) {
      throw new ApiError(400, `قیمت واحد در ردیف ${row} باید عدد ریالیِ صحیح باشد.`);
    }

    // discount: optional; a REAL number when present (absent/null/''
    // are documented legacy empty inputs → 0); finite, non-negative,
    // integer, ≤ line total
    let discount = 0;
    const rawDiscount = item?.discount;
    const discountEmpty = rawDiscount === undefined || rawDiscount === null || rawDiscount === '';
    if (!discountEmpty) {
      if (typeof rawDiscount !== 'number') {
        throw new ApiError(400, `تخفیف در ردیف ${row} باید عدد باشد.`);
      }
      if (!Number.isFinite(rawDiscount) || rawDiscount < 0) {
        throw new ApiError(400, `تخفیف در ردیف ${row} نامعتبر است.`);
      }
      if (!Number.isInteger(rawDiscount)) {
        throw new ApiError(400, `تخفیف در ردیف ${row} باید عدد ریالیِ صحیح باشد.`);
      }
      discount = rawDiscount;
    }

    // line total: exact + bounded
    const lineTotal = qty * price;
    if (!Number.isSafeInteger(lineTotal) || lineTotal > MAX_LINE_TOTAL_RIALS) {
      throw new ApiError(
        400,
        `مبلغ ردیف ${row} از سقف مجاز سند بیشتر است (${MAX_LINE_TOTAL_RIALS.toLocaleString('fa-IR')} ریال).`,
      );
    }
    if (discount > lineTotal) {
      throw new ApiError(400, `تخفیف ردیف ${row} نمی‌تواند از مبلغ همان ردیف بیشتر باشد.`);
    }

    normalized.push({ quantity: qty, unitPrice: price, discount });
  }
  return normalized;
}

/** Assert an accumulated value is still an exact, bounded integer. */
function assertExactAccumulation(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new ApiError(400, `محاسبهٔ ${label} از محدودهٔ اعداد صحیح امن خارج شد — ورودی‌ها را بررسی کنید.`);
  }
  if (value > MAX_DOCUMENT_TOTAL_RIALS) {
    throw new ApiError(
      400,
      `${label} سند از سقف منطقی (${MAX_DOCUMENT_TOTAL_RIALS.toLocaleString('fa-IR')} ریال) بیشتر است.`,
    );
  }
  return value;
}

/**
 * Compute the five document totals from NORMALIZED rows (run
 * validateSalesItems first). VAT is applied on the discounted subtotal,
 * as before — every intermediate result is checked for exactness and
 * the logical cap, so the numbers that reach the database are always
 * exact integers within bounds.
 */
export function computeSalesTotals(
  items: NormalizedSalesItem[],
  applyVat = true,
  vatRate = 0.09,
): SalesTotals {
  // totalAmount — checked after EACH row's addition (partial overflow
  // cannot slip through to the final check)
  let totalAmount = 0;
  for (const it of items) {
    totalAmount = assertExactAccumulation(totalAmount + it.quantity * it.unitPrice, 'جمع کل');
  }

  // discountAmount — same discipline
  let discountAmount = 0;
  for (const it of items) {
    discountAmount = assertExactAccumulation(discountAmount + it.discount, 'جمع تخفیف');
  }

  // subtotal
  const subtotal = assertExactAccumulation(totalAmount - discountAmount, 'مبلغ پس از کسر تخفیف');
  if (subtotal < 0) {
    throw new ApiError(400, 'جمع تخفیف‌ها از مبلغ کل سند بیشتر است.');
  }

  // taxAmount — VAT is OPTIONAL per document (caller decides via applyVat)
  const rate = Number.isFinite(vatRate) && vatRate >= 0 && vatRate <= 1 ? vatRate : 0.09;
  const rawTax = applyVat ? Math.round(subtotal * rate) : 0;
  const taxAmount = assertExactAccumulation(rawTax, 'مالیات');

  // finalAmount
  const finalAmount = assertExactAccumulation(subtotal + taxAmount, 'مبلغ نهایی');

  return { totalAmount, discountAmount, subtotal, taxAmount, finalAmount };
}

/**
 * One-call helper: validate raw rows AND compute the totals. Create,
 * update and quick-sale all funnel through this single implementation.
 * (v2.58.4, issue 5) toFiniteNumber was REMOVED — the shared validator is
 * type-first now: a string/boolean/null input is rejected for its TYPE,
 * never silently coerced into a number.
 */
export function validateAndComputeSalesTotals(
  items: unknown,
  applyVat = true,
  vatRate = 0.09,
): { items: NormalizedSalesItem[]; totals: SalesTotals } {
  const normalized = validateSalesItems(items);
  const totals = computeSalesTotals(normalized, applyVat, vatRate);
  return { items: normalized, totals };
}
