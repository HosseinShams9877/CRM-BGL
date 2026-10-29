// ═══════════════════════════════════════════════════════════
// v2.48.0 — company sender-profile validation library
// (src/lib/company-profile.ts): شبا mod-97 checksum, bank account
// digits, name/tagline/proforma-note limits, logo data-URL checks
// and the «توضیحات / شرایط» print-terms selection.
// ═══════════════════════════════════════════════════════════
import { describe, expect, it } from 'vitest';
import {
  PROFORMA_NOTE_MAX_LINES,
  checkLogoDataUrl,
  normalizeBankAccountNumber,
  normalizeSheba,
  proformaTermsLines,
  shebaMod97,
  toLatinDigits,
  validateProformaNote,
  validateProfileName,
  validateProfileTagline,
} from '@/lib/company-profile';

// ── INDEPENDENT mod-97 (BigInt) — deliberately a second
//    implementation so a bug in the lib's chunked arithmetic cannot
//    validate itself. Crafts a checksum-valid IR IBAN from a 22-digit
//    BBAN by brute-forcing the two check digits.
function craftSheba(bban22: string): string {
  const attempt = (check: string): boolean => {
    const iban = `IR${check}${bban22}`;
    const rearranged = iban.slice(4) + iban.slice(0, 4);
    const expanded = [...rearranged]
      .map((c) => (/[0-9]/.test(c) ? c : String(c.charCodeAt(0) - 55)))
      .join('');
    return BigInt(expanded) % BigInt(97) === BigInt(1);
  };
  for (let i = 0; i < 100; i++) {
    const check = String(i).padStart(2, '0');
    if (attempt(check)) return `IR${check}${bban22}`;
  }
  throw new Error('test bug: no check digits found');
}

const VALID1 = craftSheba('0198000000001234567890'); // بانک ملی style
const VALID2 = craftSheba('62000000000087399876540');

describe('toLatinDigits', () => {
  it('converts Persian and Arabic-Indic digits', () => {
    expect(toLatinDigits('۱۲۳۴۵')).toBe('12345');
    expect(toLatinDigits('٠١٢٣٤')).toBe('01234');
    expect(toLatinDigits('IR۱۲')).toBe('IR12');
    expect(toLatinDigits('mixed ۴x')).toBe('mixed 4x');
  });
  it('leaves Latin text untouched', () => {
    expect(toLatinDigits('IR820540')).toBe('IR820540');
  });
});

describe('shebaMod97', () => {
  it('returns 1 for checksum-valid IBANs', () => {
    expect(shebaMod97(VALID1)).toBe(1);
    expect(shebaMod97(VALID2)).toBe(1);
  });
  it('returns something ≠ 1 (or -1) for a broken checksum', () => {
    const broken = VALID1.slice(0, 2) + String((Number(VALID1[2]) + 5) % 10) + VALID1.slice(3);
    expect(shebaMod97(broken)).not.toBe(1);
  });
});

describe('normalizeSheba', () => {
  it('accepts a canonical IR + 24 digits value', () => {
    expect(normalizeSheba(VALID1)).toEqual({ ok: true, value: VALID1 });
  });
  it('auto-prefixes IR for 24 bare digits', () => {
    expect(normalizeSheba(VALID1.slice(2))).toEqual({ ok: true, value: VALID1 });
  });
  it('strips spaces, dashes and zero-width chars', () => {
    const spaced = `${VALID1.slice(0, 4)} ${VALID1.slice(4, 8)}-${VALID1.slice(8, 16)} ${VALID1.slice(16)}\u200c`;
    expect(normalizeSheba(spaced)).toEqual({ ok: true, value: VALID1 });
  });
  it('converts Persian digits', () => {
    expect(normalizeSheba(VALID1.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])))
      .toEqual({ ok: true, value: VALID1 });
  });
  it('uppercases a lowercase ir prefix', () => {
    expect(normalizeSheba(VALID1.toLowerCase())).toEqual({ ok: true, value: VALID1 });
  });
  it('rejects a wrong checksum with the Persian control-digit error', () => {
    const broken = VALID1.slice(0, 2) + String((Number(VALID1[2]) + 5) % 10) + VALID1.slice(3);
    const r = normalizeSheba(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('رقم کنترلی');
  });
  it('rejects wrong lengths (23 / 25 digits)', () => {
    expect(normalizeSheba(VALID1.slice(0, 25)).ok).toBe(false); // IR + 23 digits
    expect(normalizeSheba(`IR${VALID1.slice(2)}0`).ok).toBe(false); // IR + 25 digits
  });
  it('rejects a non-Iran country prefix', () => {
    const foreign = `GB${VALID1.slice(2)}`;
    const r = normalizeSheba(foreign);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ایرانی');
  });
  it('rejects junk, empty and non-string input', () => {
    expect(normalizeSheba('سلام این شبا نیست').ok).toBe(false);
    expect(normalizeSheba('').ok).toBe(false);
    expect(normalizeSheba(null).ok).toBe(false);
    expect(normalizeSheba(12345).ok).toBe(false);
  });
});

describe('normalizeBankAccountNumber', () => {
  it('accepts a plain digit account number', () => {
    expect(normalizeBankAccountNumber('0123456789')).toEqual({ ok: true, value: '0123456789' });
  });
  it('normalizes Persian digits and separators', () => {
    expect(normalizeBankAccountNumber('۰۱۲۳-۴۵۶ ۷۸۹')).toEqual({ ok: true, value: '0123456789' });
  });
  it('rejects non-digits', () => {
    expect(normalizeBankAccountNumber('012345678a').ok).toBe(false);
  });
  it('rejects too-short and too-long values', () => {
    expect(normalizeBankAccountNumber('123').ok).toBe(false);
    expect(normalizeBankAccountNumber('1'.repeat(20)).ok).toBe(false);
  });
  it('rejects missing/non-string input', () => {
    expect(normalizeBankAccountNumber('').ok).toBe(false);
    expect(normalizeBankAccountNumber(null).ok).toBe(false);
  });
});

describe('validateProfileName', () => {
  it('accepts a trimmed name', () => {
    expect(validateProfileName('  شرکت نمونه  ')).toEqual({ ok: true, value: 'شرکت نمونه' });
  });
  it('rejects empty and oversized names', () => {
    expect(validateProfileName('   ').ok).toBe(false);
    expect(validateProfileName('x'.repeat(121)).ok).toBe(false);
    expect(validateProfileName(null).ok).toBe(false);
  });
});

describe('validateProfileTagline', () => {
  it('treats null/undefined as cleared (empty value)', () => {
    expect(validateProfileTagline(null)).toEqual({ ok: true, value: '' });
    expect(validateProfileTagline(undefined)).toEqual({ ok: true, value: '' });
  });
  it('trims and accepts ≤200 chars, rejects longer', () => {
    expect(validateProfileTagline(' تولیدکنندهٔ دستگاه‌های خلوص‌سنج ')).toEqual({
      ok: true,
      value: 'تولیدکنندهٔ دستگاه‌های خلوص‌سنج',
    });
    expect(validateProfileTagline('x'.repeat(201)).ok).toBe(false);
  });
});

describe('validateProformaNote', () => {
  it('treats null/undefined as cleared', () => {
    expect(validateProformaNote(null)).toEqual({ ok: true, value: '' });
  });
  it('trims lines and drops empties (CRLF safe)', () => {
    expect(validateProformaNote('سطر یک\r\n\r\n  سطر دو  \n')).toEqual({
      ok: true,
      value: 'سطر یک\nسطر دو',
    });
  });
  it('rejects more than 8 lines', () => {
    expect(validateProformaNote(Array.from({ length: 9 }, (_, i) => `سطر ${i + 1}`).join('\n')).ok).toBe(false);
  });
  it('rejects an over-long line', () => {
    expect(validateProformaNote(`x`.repeat(201)).ok).toBe(false);
  });
});

describe('checkLogoDataUrl', () => {
  const tinyPng = 'data:image/png;base64,iVBORw0KGgo='; // 12B payload, %4==0
  it('accepts a well-formed PNG data-URL', () => {
    const r = checkLogoDataUrl(tinyPng);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mime).toBe('image/png');
      expect(r.base64).toBe('iVBORw0KGgo=');
      expect(r.decodedBytes).toBe(8);
    }
  });
  it('accepts jpeg and webp mimes', () => {
    expect(checkLogoDataUrl('data:image/jpeg;base64,AAAA').ok).toBe(true);
    expect(checkLogoDataUrl('data:image/webp;base64,AAAA').ok).toBe(true);
  });
  it('rejects svg and other mimes', () => {
    expect(checkLogoDataUrl('data:image/svg+xml;base64,AAAA').ok).toBe(false);
    expect(checkLogoDataUrl('data:image/gif;base64,AAAA').ok).toBe(false);
  });
  it('rejects a non-multiple-of-4 base64 payload', () => {
    expect(checkLogoDataUrl('data:image/png;base64,AAA').ok).toBe(false);
  });
  it('rejects an oversized payload (> 2MB decoded)', () => {
    const big = 'A'.repeat(Math.ceil((2 * 1024 * 1024 + 8) / 3) * 4); // >2MB decoded
    expect(checkLogoDataUrl(`data:image/png;base64,${big}`).ok).toBe(false);
  });
  it('rejects non-string input', () => {
    expect(checkLogoDataUrl(null).ok).toBe(false);
    expect(checkLogoDataUrl(42).ok).toBe(false);
  });
});

describe('proformaTermsLines', () => {
  it('returns the company note lines when a note exists', () => {
    expect(proformaTermsLines('شرایط اول\nشرایط دوم', { official: false, documentType: 'proforma' }))
      .toEqual(['شرایط اول', 'شرایط دوم']);
  });
  it('trims/derives lines exactly like validateProformaNote', () => {
    expect(proformaTermsLines('  یک  \n\n دو \n', { official: false, documentType: 'invoice' }))
      .toEqual(['یک', 'دو']);
  });
  it('caps at PROFORMA_NOTE_MAX_LINES lines', () => {
    const many = Array.from({ length: 12 }, (_, i) => `سطر ${i + 1}`).join('\n');
    expect(proformaTermsLines(many, { official: false, documentType: 'proforma' })).toHaveLength(PROFORMA_NOTE_MAX_LINES);
  });
  it('null/empty note → built-in default terms (legacy behavior)', () => {
    const unofficial = proformaTermsLines(null, { official: false, documentType: 'proforma' });
    expect(unofficial).toHaveLength(3);
    expect(unofficial[0]).toContain('پیش‌فاکتور');
    const asInvoice = proformaTermsLines('', { official: false, documentType: 'invoice' });
    expect(asInvoice[0]).toContain('فاکتور');
    const official = proformaTermsLines(undefined, { official: true, documentType: 'invoice' });
    expect(official).toHaveLength(2);
    expect(official[0]).toContain('۱۶۹');
  });
});
