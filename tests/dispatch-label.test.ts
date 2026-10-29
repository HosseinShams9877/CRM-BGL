// ════════════════════════════════════════════════════════════════
// v2.39.0 (round 65) — dispatch-label pure helpers
// (سند ارسال مراسلات: auto-issued when an invoice is issued)
// ════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  buildItemsSummary,
  PARCEL_TYPES,
  DEFAULT_PARCEL_TYPE,
  isParcelType,
  parcelTypeLabel,
  deliveryTimeLabel,
} from '../src/lib/dispatch-label';

describe('buildItemsSummary (v2.39.0)', () => {
  it('joins name+quantity entries with « · » in Persian digits', () => {
    expect(
      buildItemsSummary([
        { productName: 'دستگاه سی‌پاپ', quantity: 2 },
        { productName: 'ماسک', quantity: 10 },
      ]),
    ).toBe('۲ دستگاه سی‌پاپ · ۱۰ ماسک');
  });

  it('skips empty / whitespace product names', () => {
    expect(
      buildItemsSummary([
        { productName: '   ', quantity: 2 },
        { productName: 'دستگاه', quantity: 1 },
        { productName: null, quantity: 3 },
      ]),
    ).toBe('۱ دستگاه');
  });

  it('renders the bare name for invalid / non-positive quantities', () => {
    expect(
      buildItemsSummary([
        { productName: 'دستگاه', quantity: 0 },
        { productName: 'لوله', quantity: -2 },
        { productName: 'شلنگ', quantity: Number.NaN },
      ]),
    ).toBe('دستگاه · لوله · شلنگ');
  });

  it('keeps decimal quantities honest (۲.۵)', () => {
    expect(buildItemsSummary([{ productName: 'متر', quantity: 2.5 }])).toBe('۲.۵ متر');
  });

  it('folds entries beyond maxItems into «+ن مورد دیگر»', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      productName: `کالا ${i + 1}`,
      quantity: 1,
    }));
    // product names pass through verbatim (only quantities are digit-converted)
    expect(buildItemsSummary(items, 4)).toBe('۱ کالا 1 · ۱ کالا 2 · ۱ کالا 3 · ۱ کالا 4 · +۳ مورد دیگر');
  });

  it('hard-caps pathological length without splitting a word', () => {
    const items = [{ productName: 'د'.repeat(300), quantity: 1 }];
    const out = buildItemsSummary(items, 4, 180);
    expect(out.length).toBeLessThanOrEqual(180);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns an empty string for an empty list', () => {
    expect(buildItemsSummary([])).toBe('');
    expect(buildItemsSummary(undefined as unknown as [])).toBe('');
  });
});

describe('parcel types (v2.39.0)', () => {
  it('offers the four chip options with کارتن as the default', () => {
    expect(PARCEL_TYPES.map((p) => p.label)).toEqual(['کارتن', 'بسته', 'پاکت', 'شکستنی']);
    expect(DEFAULT_PARCEL_TYPE).toBe('carton');
  });

  it('isParcelType accepts only known values', () => {
    expect(isParcelType('carton')).toBe(true);
    expect(isParcelType('fragile')).toBe(true);
    expect(isParcelType('rocket')).toBe(false);
    expect(isParcelType(42)).toBe(false);
  });

  it('parcelTypeLabel maps values and passes unknown ones through', () => {
    expect(parcelTypeLabel('carton')).toBe('کارتن');
    expect(parcelTypeLabel('fragile')).toBe('شکستنی');
    expect(parcelTypeLabel('???')).toBe('???');
  });
});

describe('deliveryTimeLabel (ساعت تحویل کالا به مقصد)', () => {
  it('renders HH:MM in Persian digits', () => {
    expect(deliveryTimeLabel('08:00')).toBe('۰۸:۰۰');
    expect(deliveryTimeLabel('18:30')).toBe('۱۸:۳۰');
    expect(deliveryTimeLabel('9:05')).toBe('۰۹:۰۵');
  });

  it('returns an empty string for absent / malformed values (dotted placeholder at print)', () => {
    expect(deliveryTimeLabel('')).toBe('');
    expect(deliveryTimeLabel(null)).toBe('');
    expect(deliveryTimeLabel(undefined)).toBe('');
    expect(deliveryTimeLabel('25:00')).toBe('');
    expect(deliveryTimeLabel('12:99')).toBe('');
    expect(deliveryTimeLabel('صبح')).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════
// v2.46.0 (round 71) — carton serial + payment-method helpers
// (شماره سریال برچسب کارتون + نحوه پرداخت هزینه)
// ════════════════════════════════════════════════════════════════
import {
  PAYMENT_METHODS,
  isPaymentMethod,
  paymentMethodLabel,
  derivePaymentMethod,
  formatCartonPosition,
} from '../src/lib/dispatch-label';

describe('PAYMENT_METHODS / isPaymentMethod / paymentMethodLabel (v2.46.0)', () => {
  it('exposes exactly the two sample-design tick boxes', () => {
    expect(PAYMENT_METHODS.map((m) => m.value)).toEqual(['prepaid', 'collect']);
    expect(PAYMENT_METHODS.map((m) => m.label)).toEqual(['پیش‌پرداخت', 'پس‌کرایه']);
  });
  it('isPaymentMethod narrows known values and rejects everything else', () => {
    expect(isPaymentMethod('prepaid')).toBe(true);
    expect(isPaymentMethod('collect')).toBe(true);
    expect(isPaymentMethod('cod')).toBe(false);
    expect(isPaymentMethod(null)).toBe(false);
    expect(isPaymentMethod(undefined)).toBe(false);
  });
  it('paymentMethodLabel maps values and passes unknowns through', () => {
    expect(paymentMethodLabel('prepaid')).toBe('پیش‌پرداخت');
    expect(paymentMethodLabel('collect')).toBe('پس‌کرایه');
    expect(paymentMethodLabel('x')).toBe('x');
  });
});

describe('derivePaymentMethod (tick default from payment terms)', () => {
  it('matches explicit «پیش» family terms → prepaid', () => {
    expect(derivePaymentMethod('پیش‌پرداخت')).toBe('prepaid');
    expect(derivePaymentMethod('پیش پرداخت نقدی')).toBe('prepaid');
    expect(derivePaymentMethod('پیش‌کساب ۵۰٪')).toBe('prepaid');
    expect(derivePaymentMethod('پیشکرایه')).toBe('prepaid');
  });
  it('matches «پس …» family + عندالاستلام terms → collect', () => {
    expect(derivePaymentMethod('پس‌پرداخت')).toBe('collect');
    expect(derivePaymentMethod('پس کرایه')).toBe('collect');
    expect(derivePaymentMethod('عندالاستلام')).toBe('collect');
    expect(derivePaymentMethod('عند الاستلام تحویل شود')).toBe('collect');
  });
  it('never guesses for unknown / blank / cheques-only terms', () => {
    expect(derivePaymentMethod('')).toBeNull();
    expect(derivePaymentMethod(null)).toBeNull();
    expect(derivePaymentMethod(undefined)).toBeNull();
    expect(derivePaymentMethod('چک ۳۰ روزه')).toBeNull();
    expect(derivePaymentMethod('اعتباری ۶۰ روزه')).toBeNull();
    expect(derivePaymentMethod('نقدی کامل')).toBeNull();
  });
  it('first keyword wins when both families appear', () => {
    expect(derivePaymentMethod('پیش‌پرداخت، مابقی پس‌پرداخت')).toBe('prepaid');
  });
});

describe('formatCartonPosition («کارتون ۱ از ۳»)', () => {
  it('renders 1-based position with Persian digits', () => {
    expect(formatCartonPosition(1, 3)).toBe('کارتون ۱ از ۳');
    expect(formatCartonPosition(2, 12)).toBe('کارتون ۲ از ۱۲');
    expect(formatCartonPosition(12, 12)).toBe('کارتون ۱۲ از ۱۲');
  });
  it('defends against zero / negative / fractional junk (prints ۱ از ۱)', () => {
    expect(formatCartonPosition(0, 5)).toBe('کارتون ۱ از ۵');
    expect(formatCartonPosition(-3, 5)).toBe('کارتون ۱ از ۵');
    expect(formatCartonPosition(1, 0)).toBe('کارتون ۱ از ۱');
    expect(formatCartonPosition(1.5, 2)).toBe('کارتون ۱ از ۲');
    expect(formatCartonPosition(NaN, NaN)).toBe('کارتون ۱ از ۱');
  });
});
