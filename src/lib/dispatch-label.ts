// ════════════════════════════════════════════════════════════════
// dispatch-label.ts — v2.39.0 (round 65) pure helpers for the
// «سند ارسال مراسلات» (dispatch label) that is issued
// AUTOMATICALLY when a sales invoice is issued, for printing and
// sticking on the cartons (user request: «سند ارسال مراسلات کالاها
// بعد از صدور فاکتور به صورت اتوماتیک برای درج در روی کارتون‌ها
// صادر شود» + «ساعت تحویل کالا به مقصد» must appear on the label).
//
// Everything here is PURE — no db, no react — so it is unit-tested
// in tests/dispatch-label.test.ts and safely importable from both
// the API routes (auto-issue summary) and the label component
// (parcel-type chips).
// ════════════════════════════════════════════════════════════════

/** Minimal item shape shared by the API summary builder. */
export interface DispatchItemLike {
  productName: string | null | undefined;
  quantity: number | null | undefined;
}

/** Trims, collapses inner whitespace and drops ZWNJ issues around «،». */
function cleanName(raw: string | null | undefined): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    // a ZWNJ glued to a separator reads broken on the printed label
    .replace(/\u200c+(?=[،,])/g, '')
    .replace(/(?<=[،,])\u200c+/g, '');
}

/** Persian-digit conversion (same table as sales-docs-shared). */
function toPersianDigits(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c, 10)]);
}

/** Integer quantity for display (2.5 stays ۲/۵ — rare but honest). */
function qtyLabel(q: number): string {
  if (Number.isInteger(q)) return toPersianDigits(q);
  return toPersianDigits(String(q));
}

/**
 * Compact contents line for the carton label: «۲ دستگاه ای‌سی‌پی · ۱ عدد
 * ماسک …». Rules:
 *  - empty / whitespace-only product names are skipped
 *  - non-positive / invalid quantities render as just the name
 *  - at most `maxItems` entries; overflow becomes «+ن مورد دیگر»
 *  - the final string is hard-capped (DB column is String, label space
 *    is one strip) so pathological catalogs can never blow the layout
 */
export function buildItemsSummary(
  items: DispatchItemLike[],
  maxItems = 4,
  maxChars = 180,
): string {
  const rows: string[] = [];
  let overflow = 0;
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    const name = cleanName(list[i]?.productName);
    if (!name) continue;
    const q = Number(list[i]?.quantity);
    const entry = Number.isFinite(q) && q > 0 ? `${qtyLabel(q)} ${name}` : name;
    if (rows.length < maxItems) rows.push(entry);
    else overflow++;
  }
  if (overflow > 0) rows.push(`+${toPersianDigits(overflow)} مورد دیگر`);
  const joined = rows.join(' · ');
  if (joined.length <= maxChars) return joined;
  // cap without cutting a word in half; keep the ellipsis visible
  return `${joined.slice(0, Math.max(0, maxChars - 3)).replace(/ [^ ]*$/, '')}…`;
}

/** Parcel-type chip options printed on the label (نوع مرسوله). */
export const PARCEL_TYPES = [
  { value: 'carton', label: 'کارتن' },
  { value: 'parcel', label: 'بسته' },
  { value: 'envelope', label: 'پاکت' },
  { value: 'fragile', label: 'شکستنی' },
] as const;

export type ParcelType = (typeof PARCEL_TYPES)[number]['value'];

export function isParcelType(v: unknown): v is ParcelType {
  return typeof v === 'string' && PARCEL_TYPES.some((p) => p.value === v);
}

export function parcelTypeLabel(v: string): string {
  return PARCEL_TYPES.find((p) => p.value === v)?.label ?? v;
}

/** Default dispatch label parcel type (goods travel in cartons). */
export const DEFAULT_PARCEL_TYPE: ParcelType = 'carton';

// ── v2.46.0 (round 71) — carton serial + payment-method helpers ──

/** Payment-method tick boxes printed on the label («نحوه پرداخت هزینه»
 *  box of the user's sample design). `null` = neither box ticked — the
 *  desk decides at print time; the derived default comes from the
 *  invoice's payment terms text. */
export const PAYMENT_METHODS = [
  { value: 'prepaid', label: 'پیش‌پرداخت' },
  { value: 'collect', label: 'پس‌کرایه' },
] as const;

export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number]['value'];

export function isPaymentMethod(v: unknown): v is PaymentMethodValue {
  return typeof v === 'string' && PAYMENT_METHODS.some((p) => p.value === v);
}

export function paymentMethodLabel(v: string): string {
  return PAYMENT_METHODS.find((p) => p.value === v)?.label ?? v;
}

/** Default tick derived from the invoice's payment-terms free text.
 *  Only explicit keywords decide («پیش» → prepaid، «پس‌پرداخت» یا
 *  «عندالاستلام» → collect); anything else stays unticked — honest,
 *  never a guess. */
export function derivePaymentMethod(
  paymentTerms: string | null | undefined,
): PaymentMethodValue | null {
  const t = String(paymentTerms ?? '').replace(/[\u200c\u200f\u200e]/g, ' ').trim();
  if (!t) return null;
  if (/(^|[\s،,(])\s*پیش\s*(پرداخت|کرایه|کساب|ساب)?/.test(t)) return 'prepaid';
  if (/(^|[\s،,(])\s*(پس\s*(پرداخت|کرایه)|عند\s*الاستلام)/.test(t)) return 'collect';
  return null;
}

/** «کارتون ۱ از ۳» — position line of one carton sheet. */
export function formatCartonPosition(index: number, total: number): string {
  const i = Number.isInteger(index) && index > 0 ? index : 1;
  const t = Number.isInteger(total) && total > 0 ? total : 1;
  return `کارتون ${toPersianDigits(i)} از ${toPersianDigits(t)}`;
}

/**
 * Delivery-time line for the label («ساعت تحویل کالا به مقصد»).
 * '' renders as the dotted placeholder so the label still prints
 * when the desk hasn't confirmed the slot yet.
 */
export function deliveryTimeLabel(hhmm: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return '';
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return '';
  return toPersianDigits(String(h).padStart(2, '0')).concat(
    ':',
    toPersianDigits(m[2]),
  );
}
