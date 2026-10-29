// ════════════════════════════════════════════════════════════
// hesabfa-serial.ts — v2.57.0 (round 83) pure serial logic
//
// Spec (upload/حسابفا.txt):
//   • production unit is SERIAL-managed; current prefixes: OXP, OX, SC
//   • a purchase invoice that carries a serial puts the item INTO stock
//   • a sale invoice that carries a serial marks it SOLD
//   • a serial holding an OPERATIONAL status in the CRM (demo /
//     reserved / نزد کارشناس=expert) must NEVER be clobbered by a sync
//   • history rows are appended for every applied transition
//
// Everything in this file is PURE (no DB, no fetch) so the unit tests
// in tests/hesabfa-serial.test.ts pin the exact semantics.
// ════════════════════════════════════════════════════════════

/** Serial prefixes of BGL's manufactured lines (case-insensitive match). */
export const SERIAL_PREFIXES = ['OXP', 'OX', 'SC'] as const;

/** InventorySerial.status values that represent CRM-side operational
 * state — a Hesabfa sync may RECORD metadata on them but must never
 * flip their status (spec: «بدون دلیل پاک نشود»). */
export const OPERATIONAL_SERIAL_STATUSES = new Set(['demo', 'reserved', 'expert']);

/** Minimal serial word: prefix + ≥4 word/dash chars that CONTAIN at least
 * one digit (rejects letter-words like «SCUFFER»/«OXAN»); lowercase
 * variants existed in the legacy data — 'o15…'. */
const SERIAL_WORD = new RegExp(`\\b(?:${SERIAL_PREFIXES.join('|')})(?=[0-9A-Za-z-]*\\d)[0-9A-Za-z-]{4,}\\b`, 'i');

/** Extract serial candidates from a free-text field (Persian-safe:
 * \b does not fire between Persian letters and digits, so the word
 * boundary is also approximated by scanning token boundaries). */
export function extractSerialsFromText(text: unknown): string[] {
  if (typeof text !== 'string' || !text) return [];
  const out: string[] = [];
  // normalize separators the regex \b won't catch (، ؛ Persian comma etc.)
  const tokens = text.split(/[\s,;،؛\n\r\t|]+/);
  for (const tok of tokens) {
    const m = SERIAL_WORD.exec(tok);
    if (m) {
      const up = m[0].toUpperCase();
      if (!out.includes(up)) out.push(up);
    }
  }
  return out;
}

/** Invoice item fields where serials may hide, in scan order. */
const ITEM_TEXT_FIELDS = ['Description', 'Note', 'Notes', 'Tag', 'Explanation', 'RowDescription', 'Name'] as const;

export interface InvoiceItemLike { [k: string]: unknown }

/** Serials of one invoice line, scanned across its text fields. */
export function extractSerialsFromItem(item: InvoiceItemLike): string[] {
  const out: string[] = [];
  for (const f of ITEM_TEXT_FIELDS) {
    for (const s of extractSerialsFromText(item[f])) {
      if (!out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** Serials of a whole invoice (deduped, order-preserving). */
export function extractSerialsFromItems(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const s of extractSerialsFromItem(item as InvoiceItemLike)) {
      if (!out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** Legacy mapping kept verbatim: 0 = فروش (sale), 1 = خرید (purchase). */
export const HESABFA_INVOICE_SALE = 0;
export const HESABFA_INVOICE_PURCHASE = 1;

export function hesabfaInvoiceTypeLabel(type: number): string {
  return type === HESABFA_INVOICE_PURCHASE ? 'خرید' : type === HESABFA_INVOICE_SALE ? 'فروش' : String(type);
}

/** What the sync must do with one (serial, invoiceType) pair given the
 * serial's current CRM state. Pure decision — the caller applies it. */
export type SerialSyncAction =
  | { kind: 'create-available' }          // purchase: unknown serial → enters stock
  | { kind: 'create-sold' }               // sale: unknown serial → already sold (late discovery)
  | { kind: 'mark-sold' }                 // sale: available serial → becomes sold
  | { kind: 'restock' }                   // purchase: returned/defective serial → back to available
  | { kind: 'update-meta' }               // correct status already matches → refresh provenance only
  | { kind: 'skip-operational' }          // demo / reserved / expert — NEVER touched
  | { kind: 'skip-kept' };                // e.g. sale on a defective unit — kept as-is (no clobber)

export function decideSerialSync(
  invoiceType: number,
  currentStatus: string | null,
): SerialSyncAction {
  const st = (currentStatus || '').toLowerCase();
  if (OPERATIONAL_SERIAL_STATUSES.has(st)) return { kind: 'skip-operational' };
  const isSale = invoiceType === HESABFA_INVOICE_SALE;
  const isPurchase = invoiceType === HESABFA_INVOICE_PURCHASE;
  if (currentStatus === null || st === '') return isPurchase ? { kind: 'create-available' } : { kind: 'create-sold' };
  if (isSale) {
    if (st === 'available') return { kind: 'mark-sold' };
    if (st === 'sold') return { kind: 'update-meta' };
    return { kind: 'skip-kept' }; // returned/defective: operational reality wins
  }
  if (isPurchase) {
    if (st === 'sold') return { kind: 'update-meta' }; // historical purchase re-synced: keep sold
    if (st === 'returned' || st === 'defective') return { kind: 'restock' };
    if (st === 'available') return { kind: 'update-meta' };
    return { kind: 'skip-kept' };
  }
  return { kind: 'skip-kept' };
}

/** History action string for an applied sync action. */
export function historyActionFor(action: SerialSyncAction, _invoiceType: number): string {
  switch (action.kind) {
    case 'create-available': return 'entered';
    case 'create-sold': return 'sold';
    case 'mark-sold': return 'sold';
    case 'restock': return 'adjusted';
    default: return 'synced';
  }
}

/** History description (same wording family as the legacy PHP). */
export function historyDescriptionFor(action: SerialSyncAction, invoiceType: number, invoiceNumber: string): string {
  const type = hesabfaInvoiceTypeLabel(invoiceType);
  const num = invoiceNumber ? ` ${invoiceNumber}` : '';
  switch (action.kind) {
    case 'create-available': return `سینک ورود/موجودی سریال از فاکتور ${type} حسابفا${num}`;
    case 'create-sold': return `سینک فروش سریال از فاکتور ${type} حسابفا${num}`;
    case 'mark-sold': return `سینک فروش سریال از فاکتور ${type} حسابفا${num}`;
    case 'restock': return `بازگشت به موجود — فاکتور ${type} حسابفا${num}`;
    default: return `به‌روزرسانی اطلاعات حسابفا از فاکتور ${type}${num}`;
  }
}

/** Available-For-Sale (spec formula): Hesabfa total stock minus ACTIVE
 * reservations. An expired reservation no longer reduces availability;
 * the floor of 0 protects against double-counting. Pure. */
export function availableForSale(hesabfaStock: number, activeReservations: Array<{ expiresAt: Date | null }>): number {
  const now = Date.now();
  const active = activeReservations.filter((r) => !r.expiresAt || r.expiresAt.getTime() > now).length;
  return Math.max(0, hesabfaStock - active);
}
