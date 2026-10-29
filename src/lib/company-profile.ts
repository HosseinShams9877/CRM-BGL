// ══════════════════════════════════════════════════════════════
// v2.48.0 — Company sender-profile validation & print-terms helpers.
//
// The company sender profile (name, tagline, logo, national id,
// addresses, bank account) is registered ONCE in company settings
// and auto-pulled into every proforma/invoice print. This module is
// the SINGLE source of truth for validating/normalizing that data:
//   • the /api/companies update-profile route enforces it server-side
//   • the settings form imports the same pure functions for live
//     client-side feedback (Persian messages, identical semantics)
//
// PURE by design — no Node-only APIs, no Prisma, no sharp — so it is
// importable from client components AND unit-testable (see
// tests/company-profile.test.ts).
// ══════════════════════════════════════════════════════════════

/** Iranian IBAN (شبا) total length: 'IR' + 24 digits = 26 chars. */
export const SHEBA_LENGTH = 26;

/** Max decoded bytes accepted for an uploaded logo BEFORE re-encoding. */
export const LOGO_MAX_INPUT_BYTES = 2 * 1024 * 1024; // 2 MB
/** Max bytes of the re-encoded PNG data-URL that may be STORED in DB. */
export const LOGO_MAX_STORED_BYTES = 64 * 1024; // 64 KB
/** Logos are downscaled to at most this pixel edge before storing. */
export const LOGO_MAX_EDGE_PX = 480;
/** Accepted logo MIME types (SVG is rejected on purpose — data-URL SVG
 *  in an <img> is a script-injection vector and offers no benefit). */
export const LOGO_MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type FieldOk = { ok: true; value: string };
export type FieldErr = { ok: false; error: string };
export type FieldResult = FieldOk | FieldErr;

// ── digit normalization ────────────────────────────────────────
// Persian (۰-۹) and Arabic-Indic (٠-٩) digits → Latin 0-9.
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function toLatinDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) { out += String(p); continue; }
    const a = ARABIC_DIGITS.indexOf(ch);
    if (a >= 0) { out += String(a); continue; }
    out += ch;
  }
  return out;
}

// ── شبا (Iranian IBAN, ISO 13616 / mod-97) ─────────────────────

/** ISO 7064 mod-97 of the rearranged IBAN (IR-prefixed, 26 chars). */
export function shebaMod97(iban: string): number {
  // Move the first 4 chars (IR + check digits) to the end, then map
  // letters to numbers (A=10 … Z=35; I=18, R=27).
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const expanded: string[] = [];
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) expanded.push(ch);
    else if (code >= 65 && code <= 90) expanded.push(String(code - 55)); // A=10
    else return -1; // invalid character — caller treats as bad input
  }
  // Chunked mod (the expanded number can exceed Number.MAX_SAFE_INTEGER).
  const digits = expanded.join('');
  let mod = 0;
  for (let i = 0; i < digits.length; i += 9) {
    const chunk = digits.slice(i, i + 9);
    mod = (mod * 10 ** chunk.length + Number(chunk)) % 97;
  }
  return mod;
}

/**
 * Normalize + checksum-validate an Iranian IBAN (شبا).
 * Accepts: 'IR8205…', 'ir8205…', '8205…' (24 digits — 'IR' auto-prefixed),
 * spaced/dashed groups, Persian digits. Returns the canonical
 * 'IR' + 24 digits form, or a Persian error.
 */
export function normalizeSheba(input: unknown): FieldResult {
  if (input === null || input === undefined) return { ok: false, error: 'شماره شبا وارد نشده است.' };
  if (typeof input !== 'string') return { ok: false, error: 'شماره شبا باید متن باشد.' };

  let v = toLatinDigits(input);
  // strip separators & zero-width chars (chained single-char removes — a
  // combined character class with ZW*/BOM trips no-misleading-character-class)
  v = v
    .replace(/[\s\-_.,()]/g, '')
    .replace(/\u200b/g, '')
    .replace(/\u200c/g, '')
    .replace(/\u200d/g, '')
    .replace(/\ufeff/g, '')
    .toUpperCase();

  if (v === '') return { ok: false, error: 'شماره شبا وارد نشده است.' };

  // 24 bare digits → auto-prefix IR (common entry style in Iran)
  if (/^\d{24}$/.test(v)) v = 'IR' + v;

  if (!/^[A-Z]{2}\d{24}$/.test(v)) {
    return { ok: false, error: 'شبای ایرانی باید ۲۴ رقم باشد (با یا بدون IR).' };
  }
  if (!v.startsWith('IR')) {
    return { ok: false, error: 'پیش‌شمارهٔ غیرایرانی پذیرفته نمی‌شود — شبا باید با IR شروع شود.' };
  }
  if (shebaMod97(v) !== 1) {
    return { ok: false, error: 'رقم کنترلی شبا نامعتبر است — شماره را بازبینی کنید.' };
  }
  return { ok: true, value: v };
}

/** Bank account number: 4–19 digits (Persian digits accepted). */
export function normalizeBankAccountNumber(input: unknown): FieldResult {
  if (input === null || input === undefined || typeof input !== 'string') {
    return { ok: false, error: 'شماره حساب وارد نشده است.' };
  }
  const v = toLatinDigits(input).replace(/[\s\-_.,]/g, '');
  if (v === '') return { ok: false, error: 'شماره حساب وارد نشده است.' };
  if (!/^\d+$/.test(v)) return { ok: false, error: 'شماره حساب فقط باید رقم باشد.' };
  if (v.length < 4 || v.length > 19) {
    return { ok: false, error: 'شماره حساب باید بین ۴ تا ۱۹ رقم باشد.' };
  }
  return { ok: true, value: v };
}

// ── text field limits ─────────────────────────────────────────

/** Company display name (printed letterhead): 1–120 chars. */
export function validateProfileName(input: unknown): FieldResult {
  if (typeof input !== 'string') return { ok: false, error: 'نام شرکت باید متن باشد.' };
  const t = input.trim();
  if (t === '') return { ok: false, error: 'نام شرکت نمی‌تواند خالی باشد.' };
  if (t.length > 120) return { ok: false, error: 'نام شرکت حداکثر ۱۲۰ نویسه است.' };
  return { ok: true, value: t };
}

/** Letterhead tagline: '' → null (cleared); ≤ 200 chars. */
export function validateProfileTagline(input: unknown): FieldOk | FieldErr {
  if (input === null || input === undefined) return { ok: true, value: '' };
  if (typeof input !== 'string') return { ok: false, error: 'شعار شرکت باید متن باشد.' };
  const t = input.trim();
  if (t.length > 200) return { ok: false, error: 'شعار شرکت حداکثر ۲۰۰ نویسه است.' };
  return { ok: true, value: t };
}

export const PROFORMA_NOTE_MAX_LINES = 8;
export const PROFORMA_NOTE_LINE_MAX = 200;

/**
 * Company-level printed terms (شرایط چاپی شرکت): newline-separated,
 * at most 8 non-empty lines of ≤ 200 chars. '' → null (cleared — the
 * print template falls back to its built-in default terms).
 */
export function validateProformaNote(input: unknown): FieldOk | FieldErr {
  if (input === null || input === undefined) return { ok: true, value: '' };
  if (typeof input !== 'string') return { ok: false, error: 'یادداشت پیش‌فاکتور باید متن باشد.' };
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length > PROFORMA_NOTE_MAX_LINES) {
    return { ok: false, error: `یادداشت حداکثر ${PROFORMA_NOTE_MAX_LINES} سطر می‌تواند داشته باشد.` };
  }
  for (const l of lines) {
    if (l.length > PROFORMA_NOTE_LINE_MAX) {
      return { ok: false, error: `هر سطر یادداشت حداکثر ${PROFORMA_NOTE_LINE_MAX} نویسه است.` };
    }
  }
  return { ok: true, value: lines.join('\n') };
}

// ── logo data-URL (pure pre-check; sharp re-encodes server-side) ──

export type LogoCheckOk = {
  ok: true;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
  decodedBytes: number;
};
export type LogoCheck = LogoCheckOk | FieldErr;

/**
 * Parse + sanity-check an uploaded logo as a data-URL
 * (`data:image/png;base64,…`). Only the STRUCTURE is validated here
 * (mime whitelist, base64 charset, size caps); pixel decoding and
 * re-encoding happen in the API route with sharp.
 */
export function checkLogoDataUrl(input: unknown): LogoCheck {
  if (typeof input !== 'string') return { ok: false, error: 'لوگو باید به‌صورت data-URL ارسال شود.' };
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(input.trim());
  if (!m) {
    return {
      ok: false,
      error: 'قالب لوگو معتبر نیست — فقط PNG، JPEG یا WebP (به‌صورت data-URL) پذیرفته می‌شود.',
    };
  }
  const mime = m[1] as 'image/png' | 'image/jpeg' | 'image/webp';
  const base64 = m[2];
  // base64 sanity: length must be a multiple of 4
  if (base64.length % 4 !== 0) {
    return { ok: false, error: 'دادهٔ لوگو ناقص است — فایل را دوباره انتخاب کنید.' };
  }
  const decodedBytes = Math.floor((base64.length / 4) * 3) - (base64.match(/=+$/)?.[0].length ?? 0);
  if (decodedBytes <= 0) {
    return { ok: false, error: 'فایل لوگو خالی است.' };
  }
  if (decodedBytes > LOGO_MAX_INPUT_BYTES) {
    return { ok: false, error: 'حجم لوگو نباید از ۲ مگابایت بیشتر باشد.' };
  }
  return { ok: true, mime, base64, decodedBytes };
}

// ── printed terms («توضیحات / شرایط» box) ─────────────────────

export interface ProformaTermsOpts {
  /** Official (ماده ۱۶۹) invoice vs proforma/unofficial print mode. */
  official: boolean;
  documentType: 'proforma' | 'invoice' | 'return';
}

/**
 * Lines printed in the «توضیحات / شرایط» box of the A4 template.
 * A company-level proformaNote (v2.48.0, registered once in company
 * settings) REPLACES the built-in default terms; null/empty keeps the
 * pre-v2.48.0 defaults exactly (zero regression for legacy rows).
 */
export function proformaTermsLines(
  note: string | null | undefined,
  opts: ProformaTermsOpts,
): string[] {
  const lines = (note ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length > 0) return lines.slice(0, PROFORMA_NOTE_MAX_LINES);

  // ── built-in defaults (unchanged from the pre-v2.48.0 template) ──
  if (opts.official) {
    return [
      'این صورتحساب دارای شماره سریال بوده و مطابق مادهٔ ۱۶۹ قانون مالیات‌های مستقیم صادر شده است.',
      'مهر و امضای هر دو طرف معامله الزامی است؛ صورتحساب بدون امضا از نظر قانونی قابل استناد نیست.',
    ];
  }
  return [
    `این ${opts.documentType === 'invoice' ? 'فاکتور' : 'پیش‌فاکتور'} در سامانهٔ فروش شرکت صادر شده و مورد تأیید واحد فروش است.`,
    'اعتبار پیش‌فاکتور: ۱۵ روز از تاریخ صدور؛ ارسال کالا پس از تأیید نهایی و تسویه انجام می‌شود.',
    'کالا پس از تحویل، مشمول شرایط گارانتی و خدمات پس از فروش شرکت است.',
  ];
}
