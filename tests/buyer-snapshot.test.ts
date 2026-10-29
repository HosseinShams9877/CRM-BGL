// ═══════════════════════════════════════════════════════════
// v2.31.9 — Lian proforma format pure helpers:
// parseBuyerSnapshot / resolveBuyerIdentity / numberToPersianWords
// ═══════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  parseBuyerSnapshot,
  resolveBuyerIdentity,
  buyerIdentityLearning,
  numberToPersianWords,
  PAYMENT_TERMS_OPTIONS,
  DEFAULT_PROFORMA_TERMS,
} from '../src/components/sales-docs-shared';

describe('parseBuyerSnapshot (v2.31.9)', () => {
  it('returns null for empty / whitespace / non-string input', () => {
    expect(parseBuyerSnapshot('')).toBeNull();
    expect(parseBuyerSnapshot('   ')).toBeNull();
    expect(parseBuyerSnapshot(null)).toBeNull();
    expect(parseBuyerSnapshot(undefined)).toBeNull();
  });

  it('returns null for malformed JSON and non-object JSON', () => {
    expect(parseBuyerSnapshot('{not json')).toBeNull();
    expect(parseBuyerSnapshot('[1,2,3]')).toBeNull();
    expect(parseBuyerSnapshot('"plain string"')).toBeNull();
    expect(parseBuyerSnapshot('42')).toBeNull();
  });

  it('parses a valid snapshot object', () => {
    const snap = parseBuyerSnapshot('{"name":"بیمارستان بقیه الله","nationalId":"14003587460"}');
    expect(snap).toEqual({ name: 'بیمارستان بقیه الله', nationalId: '14003587460' });
  });
});

describe('resolveBuyerIdentity (v2.31.9)', () => {
  const liveCenter = {
    name: 'مرکز زنده',
    nationalId: '111',
    economicCode: '222',
    address: 'نشانی مرکز',
    city: 'تهران',
    province: 'تهران',
    phone: '021',
    postalCode: '333',
    contactName: 'رابط مرکز',
  };

  it('snapshot wins over live center data (legal snapshot semantics)', () => {
    const out = resolveBuyerIdentity(
      JSON.stringify({ name: 'خریدار لحظهٔ صدور', nationalId: '999' }),
      liveCenter,
    );
    expect(out.name).toBe('خریدار لحظهٔ صدور');
    expect(out.nationalId).toBe('999');
  });

  it('missing snapshot fields back-fill from live center data (legacy rows)', () => {
    const out = resolveBuyerIdentity(
      JSON.stringify({ name: 'فقط نام' }),
      liveCenter,
    );
    expect(out.name).toBe('فقط نام');
    expect(out.nationalId).toBe('111');
    expect(out.address).toBe('نشانی مرکز');
    expect(out.contactName).toBe('رابط مرکز');
  });

  it('no snapshot at all → full live center identity', () => {
    const out = resolveBuyerIdentity('', liveCenter);
    expect(out).toEqual(liveCenter);
  });

  it('neither snapshot nor center → empty identity (print shows dots)', () => {
    const out = resolveBuyerIdentity('', null);
    expect(out).toEqual({});
  });

  it('blank/whitespace snapshot values are ignored, not copied', () => {
    const out = resolveBuyerIdentity(
      JSON.stringify({ name: '   ', phone: '' }),
      { name: 'نام مرکز' },
    );
    expect(out.name).toBe('نام مرکز');
    expect(out.phone).toBeUndefined();
  });

  it('null-valued live center fields are tolerated', () => {
    const out = resolveBuyerIdentity(null, { name: 'مرکز', nationalId: null, phone: undefined });
    expect(out.name).toBe('مرکز');
    expect(out.nationalId).toBeUndefined();
    expect(out.phone).toBeUndefined();
  });
});

describe('buyerIdentityLearning (v2.38.0 · round 64)', () => {
  it('learns both ids onto a center with empty master data (the user story)', () => {
    const patch = buyerIdentityLearning(
      { nationalId: null, economicCode: null },
      { nationalId: '14003587460', economicCode: '411356789012' },
    );
    expect(patch).toEqual({ nationalId: '14003587460', economicCode: '411356789012' });
  });

  it('returns an empty patch when master data already matches (no redundant writes)', () => {
    const patch = buyerIdentityLearning(
      { nationalId: '14003587460', economicCode: '411356789012' },
      { nationalId: '14003587460', economicCode: '411356789012' },
    );
    expect(patch).toEqual({});
  });

  it('LAST ISSUED WINS — a corrected value overwrites stale master data', () => {
    const patch = buyerIdentityLearning(
      { nationalId: '00000000000', economicCode: '111' },
      { nationalId: '14003587460', economicCode: '111' },
    );
    expect(patch).toEqual({ nationalId: '14003587460' });
  });

  it('an emptied/absent form value never erases learned master data', () => {
    expect(buyerIdentityLearning(
      { nationalId: '14003587460', economicCode: '411' },
      { nationalId: '', economicCode: undefined },
    )).toEqual({});
    expect(buyerIdentityLearning({ nationalId: '14003587460' }, {})).toEqual({});
    expect(buyerIdentityLearning({ nationalId: '14003587460' }, null)).toEqual({});
  });

  it('partial learning — only the field that actually differs is patched', () => {
    const patch = buyerIdentityLearning(
      { nationalId: '14003587460', economicCode: null },
      { nationalId: ' 14003587460 ', economicCode: '411356789012' },
    );
    // whitespace-only difference is normalized away → nationalId untouched
    expect(patch).toEqual({ economicCode: '411356789012' });
  });

  it('null/undefined center (no center picked) still yields the snapshot values', () => {
    expect(buyerIdentityLearning(null, { nationalId: '123' })).toEqual({ nationalId: '123' });
    expect(buyerIdentityLearning(undefined, { economicCode: '456' })).toEqual({ economicCode: '456' });
  });
});

describe('numberToPersianWords (shared since v2.31.9)', () => {
  it('renders the reference proforma amount exactly', () => {
    // 892,500,000 ریال from the official Lian proforma (مرجع دور ۳۸)
    expect(numberToPersianWords(892_500_000)).toBe('هشتصد و نود و دو میلیون و پانصد هزار');
  });

  it('handles zero, small and large amounts', () => {
    expect(numberToPersianWords(0)).toBe('صفر');
    expect(numberToPersianWords(7)).toBe('هفت');
    expect(numberToPersianWords(15)).toBe('پانزده');
    expect(numberToPersianWords(125)).toBe('صد و بیست و پنج');
    expect(numberToPersianWords(2_000)).toBe('دو هزار');
    expect(numberToPersianWords(1_000_000_000)).toBe('یک میلیارد');
    expect(numberToPersianWords(1_500_000_000_000)).toBe('یک تریلیون و پانصد میلیارد');
  });

  it('rejects non-finite input with an empty string', () => {
    expect(numberToPersianWords(Number.NaN)).toBe('');
    expect(numberToPersianWords(Number.POSITIVE_INFINITY)).toBe('');
  });

  // v2.34.9 — sadgan[6] typo regression («شصد» → «ششصد», found live during
  // round-56 browser verification on the quick-proforma success panel).
  it('renders the 600-hundreds digit correctly (ششصد, not شصد)', () => {
    expect(numberToPersianWords(600)).toBe('ششصد');
    expect(numberToPersianWords(1_600)).toBe('یک هزار و ششصد');
    expect(numberToPersianWords(7_782_600)).toBe('هفت میلیون و هفتصد و هشتاد و دو هزار و ششصد');
    expect(numberToPersianWords(600_000)).toBe('ششصد هزار');
  });
});

describe('Lian proforma format catalogs (v2.31.9)', () => {
  it('payment-terms options include the canonical four', () => {
    const values = PAYMENT_TERMS_OPTIONS.map((o) => o.value);
    expect(values).toContain('نقدی');
    expect(values).toContain('اعتباری');
    expect(values).toContain('چک');
    expect(values).toContain('توافقی');
  });

  it('default terms text matches the official proforma wording', () => {
    expect(DEFAULT_PROFORMA_TERMS).toContain('اعتبار، نحوهٔ پرداخت، تحویل و نصب طبق توافق طرفین');
  });
});
