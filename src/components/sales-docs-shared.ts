// ════════════════════════════════════════════════════════
// Shared types, status configs and format helpers for the
// sales-documents module. Extracted from sales-docs.tsx
// (P2-2 God-Component decomposition) — pure move, no
// behavior change.
// ════════════════════════════════════════════════════════
import { toJalaliString } from '@/lib/jalali';

// ==================== TYPES ====================
export type DocTab = 'proformas' | 'invoices' | 'checks' | 'returns';

/** Raw shape returned by /api/sales-documents (list action). */
export interface ApiSalesDocument {
  id: string;
  documentNumber: string | null;
  documentType: 'proforma' | 'invoice' | 'return';
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'cancelled';
  totalAmount: number;
  discountAmount: number;
  taxAmount: number;
  finalAmount: number;
  issuedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** v2.25.0 — numeric CAS token (every write increments it). */
  version?: number;
  centerId: string | null;
  center: { id: string; name: string } | null;
  creator: { id: string; displayName: string } | null;
  _count: { items: number; approvals: number; financeRecords: number; logs: number };
}

/** Detailed document (get action) including items and finance records. */
export interface ApiSalesDocumentDetail extends ApiSalesDocument {
  /** v2.31.7 — issuing company (tenant) for letterhead branding.
   *  Present when the document is company-owned; null for legacy
   *  center-less rows created before company ownership (v2.25.0).
   *  v2.31.8 — tagline feeds the invoice subtitle line.
   *  v2.31.9 — full seller profile (شناسه ملی، نشانی، تلفن، کد پستی) +
   *  bank account feed the Lian proforma format's seller card and
   *  «اطلاعات حساب» box. */
  company: {
    slug: string;
    name: string;
    logo: string | null;
    tagline: string | null;
    nationalId?: string | null;
    address?: string | null;
    phone?: string | null;
    postalCode?: string | null;
    /** v2.35.0 — sender two-address profile (auto-pulled into print). */
    headOfficeAddress?: string | null;
    factoryAddress?: string | null;
    bankName?: string | null;
    bankAccountHolder?: string | null;
    bankAccountNumber?: string | null;
    bankSheba?: string | null;
    /** v2.48.0 — company-level printed terms («توضیحات / شرایط» box);
     *  null → the template's built-in default terms (legacy behavior). */
    proformaNote?: string | null;
    /** v2.52.0 — per-company A4 print template key (null → 'bgl'
     *  default; 'lian' → the بازرگانی reference design). Resolved by
     *  the print sheet via src/lib/print-templates.ts. */
    printTemplate?: string | null;
    /** v2.54.0 — per-company website for the A4 footer contact band
     *  (globe icon); null → the global app.website at print time. */
    website?: string | null;
  } | null;
  description: string;
  /** v2.31.9 — Lian proforma format header + seller contact block. */
  paymentTerms?: string | null;
  salesExpertName?: string | null;
  salesExpertMobile?: string | null;
  /** v2.42.0 — انتخابگر نشانی فرستنده: 'main_office' / 'factory' / null
   *  (null → the v2.35.0 two-address default at print time). */
  senderAddressType?: SenderAddressType | null;
  /** v2.31.9 — buyer identity as confirmed in the data-entry form (JSON
   *  string; '' = no snapshot → print falls back to live center data). */
  buyerSnapshot?: string;
  /** v2.31.9 — buyer master data (live center record) backing the
   *  snapshot fallback on the printout. */
  center: {
    id: string;
    name: string;
    customerType: string;
    nationalId?: string | null;
    economicCode?: string | null;
    postalCode?: string | null;
    contactName?: string | null;
    address?: string | null;
    city?: string | null;
    province?: string | null;
    phone?: string | null;
    mobile?: string | null;
  } | null;
  items: Array<{
    id: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    discount: number;
    description: string;
    /** v2.31.9 — واحد captured by the form (null → product.unit → «عدد»). */
    unit?: string | null;
    /** v2.31.8 — populated since the invoice redesign: کد کالا (printed
     *  under the item name) and واحد (its own table column).
     *  v2.31.9 — ircCode joins the sub-line (کد کالا / IRC). */
    product: { code: string; unit: string; ircCode?: string | null } | null;
  }>;
  financeRecords: Array<{
    id: string;
    paymentMethod: string | null;
    paymentDate: string | null;
    amount: number;
    referenceNumber: string | null;
    description: string;
  }>;
}

/** Flattened check-like financial instrument derived from document finance records. */
export interface CheckRow {
  id: string;
  number: string;
  invoiceNumber: string;
  centerName: string;
  amount: number;
  checkDate: string;
  dueDate: string;
  status: 'pending' | 'cleared';
  description: string;
  /** v2.16.0 — real payment method of the underlying finance record. */
  method?: string;
}

/** v2.16.0 — labels for payment methods seen across quick-sale / cartable / billing. */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'نقدی',
  'نقدی': 'نقدی',
  card: 'کارت‌خوان',
  'کارت': 'کارت‌خوان',
  transfer: 'انتقال بانکی',
  'انتقال بانکی': 'انتقال بانکی',
  cheque: 'چک',
  check: 'چک',
  'چک': 'چک',
  pos: 'POS',
  online: 'پرداخت آنلاین',
};

export function paymentMethodLabel(method: string | null | undefined): string {
  if (!method) return 'ثبت‌شده';
  return PAYMENT_METHOD_LABELS[method.trim()] || method;
}

// ==================== SENDER ADDRESS SELECTOR (v2.42.0) ====================
/**
 * انتخابگر نشانی فرستنده — the per-document print choice captured by the
 * proforma form (SalesDocument.senderAddressType). 'main_office' prints
 * ONLY the registered head-office address, 'factory' prints ONLY the
 * factory address; null keeps the v2.35.0 two-address default. A selection
 * pointing at an UNREGISTERED address silently degrades to the default
 * (the print must never show an empty labelled line). Pure — unit-tested
 * in tests/sender-address.test.ts.
 */
export type SenderAddressType = 'main_office' | 'factory';

export interface SenderAddressLine {
  label: string;
  value: string;
}

const HEAD_OFFICE_LABEL = 'نشانی دفتر مرکزی';
const FACTORY_LABEL = 'نشانی کارخانه';

/** Strict validation for API input: the only accepted values. */
export function isSenderAddressType(v: unknown): v is SenderAddressType {
  return v === 'main_office' || v === 'factory';
}

export function resolveSenderAddressLines(opts: {
  headOffice?: string | null;
  factory?: string | null;
  legacy?: string | null;
  senderAddressType?: string | null;
}): SenderAddressLine[] {
  const headOffice = (opts.headOffice || '').trim();
  const factory = (opts.factory || '').trim();
  const legacy = (opts.legacy || '').trim();
  const selected = opts.senderAddressType;

  // explicit choice → that address ONLY (when actually registered;
  // an unregistered choice falls through to the default behaviour)
  if (selected === 'main_office' && headOffice) {
    return [{ label: HEAD_OFFICE_LABEL, value: headOffice }];
  }
  if (selected === 'factory' && factory) {
    return [{ label: FACTORY_LABEL, value: factory }];
  }

  // default (v2.35.0): both → each under its own label; one → alone;
  // legacy-only → unlabelled; nothing → empty (caller prints dots)
  const lines: SenderAddressLine[] = [];
  if (headOffice) lines.push({ label: HEAD_OFFICE_LABEL, value: headOffice });
  if (factory) lines.push({ label: FACTORY_LABEL, value: factory });
  if (lines.length === 0 && legacy) lines.push({ label: '', value: legacy });
  return lines;
}

// ==================== LETTERHEAD BRANDING (v2.31.7) ====================
/**
 * Letterhead identity for the A4 print template: documents issued under a
 * subsidiary company print with THAT company's name and logo (Company.logo,
 * e.g. آریا مدیکال → /logo-aria.png); everything else falls back to the
 * global settings identity + the holding logo. Pure — unit-tested in
 * tests/letterhead-identity.test.ts.
 */
export interface LetterheadCompany {
  name: string;
  logo?: string | null;
  /** v2.31.8 — subtitle printed under the issuing-company name (invoice
   *  format). Nullable: no tagline → no subtitle line. */
  tagline?: string | null;
}

export function letterheadIdentity(
  docCompany: LetterheadCompany | null | undefined,
  settingsCompany: { companyName: string },
): { orgName: string; logoSrc: string; tagline: string | null; fullLockup: boolean; whiteLogo: boolean } {
  const logoSrc = docCompany?.logo || '/logo-bgl.png';
  return {
    orgName: docCompany?.name || settingsCompany.companyName,
    logoSrc,
    tagline: docCompany?.tagline || null,
    // v2.31.12 — a "-full" logo (e.g. /logo-aria-full.png) is a complete
    // official lockup that already contains the wordmark, the Persian
    // company name AND the tagline. The letterhead prints it as one large
    // brand block and drops the duplicated text name/tagline lines.
    fullLockup: typeof logoSrc === 'string' && logoSrc.includes('-full.'),
    // v2.53.0 — a "-white" logo (e.g. /logo-bgl-white-full.png or
    // /logo-x-white.png) is the all-white rendition of the lockup meant
    // to sit DIRECTLY on the colored print banner (both round-77/78
    // reference proformas show the BGL lockup this way — no white plate
    // behind it). The banner drops the white plate/padding/shadow and
    // prints the marks on the banner color itself. The match requires
    // '-white.' or '-white-' so '-whitening.png' can never trip it;
    // base64 data-URL uploads contain no hyphens at all, so the
    // convention only ever matches shipped asset paths.
    whiteLogo: typeof logoSrc === 'string' && (logoSrc.includes('-white.') || logoSrc.includes('-white-')),
  };
}

// ==================== CONFIGS ====================
export const PROFORMA_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  draft: { label: 'پیش‌نویس', color: '#6b7280', bg: '#f3f4f6' },
  pending_approval: { label: 'در انتظار تأیید', color: '#6366f1', bg: '#eef2ff' },
  approved: { label: 'تأیید شده', color: '#059669', bg: '#ecfdf5' },
  rejected: { label: 'رد شده', color: '#dc2626', bg: '#fef2f2' },
  cancelled: { label: 'لغو شده', color: '#9ca3af', bg: '#f9fafb' },
};

export const INVOICE_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  draft: { label: 'پیش‌نویس', color: '#6b7280', bg: '#f3f4f6' },
  pending_approval: { label: 'در انتظار تأیید', color: '#6366f1', bg: '#eef2ff' },
  approved: { label: 'صادر شده', color: '#059669', bg: '#ecfdf5' },
  rejected: { label: 'رد شده', color: '#dc2626', bg: '#fef2f2' },
  cancelled: { label: 'لغو شده', color: '#9ca3af', bg: '#f9fafb' },
};

export const RETURN_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  draft: { label: 'پیش‌نویس', color: '#6b7280', bg: '#f3f4f6' },
  pending_approval: { label: 'در انتظار تأیید', color: '#6366f1', bg: '#eef2ff' },
  approved: { label: 'تأیید شده', color: '#059669', bg: '#ecfdf5' },
  rejected: { label: 'رد شده', color: '#dc2626', bg: '#fef2f2' },
  cancelled: { label: 'لغو شده', color: '#9ca3af', bg: '#f9fafb' },
};

export const CHECK_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: 'در انتظار', color: '#d97706', bg: '#fffbeb' },
  cleared: { label: 'وصول شده', color: '#059669', bg: '#ecfdf5' },
};

// ==================== HELPERS ====================
export function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

export function formatCurrency(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد ریال';
  if (amount >= 1_000_000) return toPersianNum((amount / 1_000_000).toFixed(0)) + ' میلیون ریال';
  return toPersianNum(Math.round(amount).toLocaleString('en-US')) + ' ریال';
}

export function formatCompact(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد';
  if (amount >= 1_000_000) return toPersianNum((amount / 1_000_000).toFixed(0)) + ' میلیون';
  return toPersianNum(Math.round(amount).toLocaleString('en-US'));
}

export function jdate(iso: string | null | undefined): string {
  return toJalaliString(iso) || '—';
}

// ==================== v2.31.9 — LIAN PROFORMA FORMAT ====================
/** Header payment-terms options (شرایط پرداخت) — the canonical four from
 *  the official Lian proforma; the API also accepts custom free text. */
export const PAYMENT_TERMS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'نقدی', label: 'نقدی' },
  { value: 'اعتباری', label: 'اعتباری' },
  { value: 'چک', label: 'چک' },
  { value: 'توافقی', label: 'طبق توافق طرفین' },
];

/** Default terms text pre-filled into the proforma form's conditions box —
 *  the exact wording of the official Lian proforma (مرجع دور ۳۸). */
export const DEFAULT_PROFORMA_TERMS =
  '۱) اعتبار، نحوهٔ پرداخت، تحویل و نصب طبق توافق طرفین خواهد بود.';

/** Buyer-identity snapshot captured by the data-entry form and stored on
 *  each document (a proforma is a legal snapshot — later center edits must
 *  not rewrite an issued document). */
export interface BuyerSnapshot {
  name?: string;
  nationalId?: string;
  economicCode?: string;
  address?: string;
  city?: string;
  province?: string;
  phone?: string;
  postalCode?: string;
  contactName?: string;
}

/** Parse a stored buyerSnapshot JSON string; malformed/empty → null. Pure. */
export function parseBuyerSnapshot(raw: string | null | undefined): BuyerSnapshot | null {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as BuyerSnapshot;
  } catch {
    return null;
  }
}

/** Center row as returned by /api/centers list since v2.31.9 — the buyer
 *  master data pre-filling the proforma form's «مشخصات خریدار» card. */
export interface ProformaCenterOption {
  id: string;
  name: string;
  nationalId?: string | null;
  economicCode?: string | null;
  postalCode?: string | null;
  contactName?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  phone?: string | null;
  mobile?: string | null;
  company?: { slug: string; name: string } | null;
}

/** Company profile row as returned by GET /api/companies since v2.31.9 —
 *  the read-only seller card + «اطلاعات حساب» box of the proforma form.
 *  v2.35.0 — the two sender addresses (دفتر مرکزی / کارخانه) join the
 *  read model: registered once in company settings, shown on the seller
 *  card and auto-printed on every document. */
export interface CompanyProfileOption {
  slug: string;
  name: string;
  nationalId?: string | null;
  address?: string | null;
  phone?: string | null;
  postalCode?: string | null;
  headOfficeAddress?: string | null;
  factoryAddress?: string | null;
  bankName?: string | null;
  bankAccountHolder?: string | null;
  bankAccountNumber?: string | null;
  bankSheba?: string | null;
  /** v2.54.0 — per-company footer website (globe icon). */
  website?: string | null;
}

/** Product row as returned by /api/products list — feeds the proforma
 *  form's catalog picker (auto-fills شرح/واحد/قیمت and carries کد/IRC). */
export interface ProductCatalogOption {
  id: string;
  code: string;
  name: string;
  price: number;
  unit: string;
  ircCode?: string | null;
  active?: boolean;
}

/** Looser read-side shape: live center rows carry `string | null` values. */
export type BuyerLike = Partial<Record<keyof BuyerSnapshot, string | null | undefined>>;

/** Resolve the buyer identity for print: the document's creation-time
 *  snapshot wins; fields missing from it back-fill from the live center
 *  master data (legacy rows); absent everywhere → undefined (the sheet
 *  prints dotted placeholders). Pure — unit-tested in
 *  tests/buyer-snapshot.test.ts. */
export function resolveBuyerIdentity(
  snapshotRaw: string | null | undefined,
  center: BuyerLike | null | undefined,
): BuyerSnapshot {
  const snap = parseBuyerSnapshot(snapshotRaw) || {};
  const live = center || {};
  const out: BuyerSnapshot = {};
  const keys: Array<keyof BuyerSnapshot> = [
    'name', 'nationalId', 'economicCode', 'address', 'city',
    'province', 'phone', 'postalCode', 'contactName',
  ];
  for (const k of keys) {
    // Trim BEFORE the fallback: a whitespace-only snapshot value is treated
    // as absent, so live master data still back-fills (tested behavior).
    const snapV = snap[k] ? String(snap[k]).trim() : '';
    const liveV = live[k] ? String(live[k]).trim() : '';
    const v = snapV || liveV;
    if (v) out[k] = v;
  }
  return out;
}

/** v2.38.0 (round 64) — buyer-identity LEARNING: when a proforma is issued
 *  for a center, the شناسه ملی / کد اقتصادی typed into the buyer card are
 *  remembered on the center's master data, so the NEXT proforma for the same
 *  center starts pre-filled («یک بار وارد کن — دفعات بعد ذخیره است»).
 *
 *  Semantics — LAST ISSUED WINS: a non-empty snapshot value overwrites the
 *  master value. The form pre-fills from master data, so any deliberate edit
 *  is a correction and must be remembered. Empty/absent snapshot values NEVER
 *  erase what was learned. Returns only the keys that actually change — an
 *  empty object means "nothing to learn". Pure — unit-tested in
 *  tests/buyer-snapshot.test.ts. */
export function buyerIdentityLearning(
  center: { nationalId?: string | null; economicCode?: string | null } | null | undefined,
  snapshot: Partial<Pick<BuyerSnapshot, 'nationalId' | 'economicCode'>> | null | undefined,
): { nationalId?: string; economicCode?: string } {
  const out: { nationalId?: string; economicCode?: string } = {};
  if (!snapshot) return out;
  const pairs = [
    ['nationalId', snapshot.nationalId],
    ['economicCode', snapshot.economicCode],
  ] as const;
  for (const [key, raw] of pairs) {
    const v = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!v) continue; // an emptied form field must not erase learned data
    const master = center ? String(center[key] ?? '').trim() : '';
    if (v !== master) out[key] = v;
  }
  return out;
}

/** Persian number-to-words (sufficient range for invoices). Shared by the
 *  A4 print sheet and the proforma form's live «مبلغ به حروف» preview —
 *  one implementation, one test battery. */
export function numberToPersianWords(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n === 0) return 'صفر';
  const yekan = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
  const dahgan = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
  const dahyek = ['ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده'];
  // v2.34.9 — sadgan[6] was «شصد» (a typo): 600 printed as «شصد» instead of
  // «ششصد» on every proforma/invoice «مبلغ به حروف» line (dialog summary,
  // quick-proforma page AND the print sheet). Found live during round-56
  // browser verification (PF-۲۶۰۸۳۰-۰۰۰۴: ۷٬۷۸۲٬۶۰۰ → «و شصد»).
  const sadgan = ['', 'صد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
  const scales: Array<[number, string]> = [
    [1e12, 'تریلیون'], [1e9, 'میلیارد'], [1e6, 'میلیون'], [1e3, 'هزار'], [1, ''],
  ];

  const threeDigit = (x: number): string => {
    const parts: string[] = [];
    const s = Math.floor(x / 100), d = Math.floor((x % 100) / 10), y = x % 10;
    if (s) parts.push(sadgan[s]);
    if (d === 1) parts.push(dahyek[y]);
    else { if (d) parts.push(dahgan[d]); if (y) parts.push(yekan[y]); }
    return parts.join(' و ');
  };

  let rest = Math.floor(Math.abs(n));
  const chunks: string[] = [];
  for (const [val, name] of scales) {
    if (rest >= val) {
      const c = Math.floor(rest / val);
      rest -= c * val;
      chunks.push(name ? `${threeDigit(c)} ${name}` : threeDigit(c));
    }
  }
  return chunks.join(' و ');
}


// ==================== v2.29.1 — ITEM-ROW VALIDATION ====================
// The three CREATE dialogs (proforma / return / quick-sale) used to silently
// DROP invalid rows with `items.filter(...)` before submitting. A partially
// filled row (name missing, or quantity 0) vanished without any warning
// while the on-screen total still included it — a silent-data-loss /
// frontend-truthfulness violation (the v2.18.0 principle). The EDIT dialog
// already validated per-row with Persian errors matching the server; the
// create dialogs now do the same through this shared pure validator.
//
// Contract rules (mirroring /api/sales-documents route):
//  • a COMPLETELY blank row (no name, default quantity, zero price/discount)
//    is skipped — the user added a row and never touched it; it contributes
//    0 to the displayed total, so skipping it is NOT a truthfulness gap
//  • a row the user touched PARTIALLY must be completed — first problem
//    wins, reported in Persian with the 1-based row number
//  • create action (proforma/return): unitPrice must be > 0 (server
//    rejects falsy prices); quick-sale: unitPrice >= 0 is allowed

export interface ValidatableItemRow {
  productName: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
}

export interface DocItemsValidationOptions {
  /** 'کالا' for quick-sale, 'محصول' for proforma/return — matches each
   *  server path's own error wording so client and server speak alike. */
  noun: 'محصول' | 'کالا';
  /** quick-sale accepts price 0 (only negatives are invalid); the create
   *  action rejects price <= 0. */
  allowZeroPrice?: boolean;
  /** Message when nothing survives validation (all rows blank/empty). */
  emptyMessage: string;
}

export interface DocItemsValidationResult<T extends ValidatableItemRow> {
  /** null = OK; otherwise the Persian error to display as-is. */
  error: string | null;
  /** Rows to submit (blank rows dropped). Empty when error is set. */
  submit: T[];
}

export function validateDocItems<T extends ValidatableItemRow>(
  rows: T[],
  opts: DocItemsValidationOptions,
): DocItemsValidationResult<T> {
  const submit: T[] = [];
  for (let i = 0; i < rows.length; i++) {
    const it = rows[i];
    const name = (it.productName || '').trim();
    const qty = Number(it.quantity);
    const price = Number(it.unitPrice);
    const disc = Number(it.discount || 0);

    // Untouched row: default shape straight out of addItem() — skip.
    const blank = !name && qty === 1 && price === 0 && disc === 0;
    if (blank) continue;

    const rowNo = toPersianNum(i + 1);
    if (!name) return { error: `نام ${opts.noun} در ردیف ${rowNo} الزامی است.`, submit: [] };
    if (!Number.isFinite(qty) || qty <= 0) {
      return { error: `تعداد در ردیف ${rowNo} باید بیشتر از صفر باشد.`, submit: [] };
    }
    if (!Number.isFinite(price) || price < 0 || (!opts.allowZeroPrice && price === 0)) {
      return { error: `قیمت واحد در ردیف ${rowNo} نامعتبر است.`, submit: [] };
    }
    submit.push(it);
  }
  if (submit.length === 0) return { error: opts.emptyMessage, submit: [] };
  return { error: null, submit };
}
