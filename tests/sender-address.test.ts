// ═══════════════════════════════════════════════════════════
// v2.42.0 — resolveSenderAddressLines / isSenderAddressType:
// انتخابگر نشانی فرستنده (sender address selector). An explicit
// per-document choice ('main_office' / 'factory') prints ONLY that
// registered address; null keeps the v2.35.0 two-address default
// (both → each under its own label; one → alone; legacy-only →
// unlabelled; nothing → empty, the caller prints dots). A choice
// pointing at an UNREGISTERED address must silently degrade to the
// default — the print must never show an empty labelled line.
// ═══════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { resolveSenderAddressLines, isSenderAddressType } from '../src/components/sales-docs-shared';

const HEAD = 'تهران، خیابان ولیعصر، کوچهٔ بهبود، پلاک ۸';
const FACTORY = 'شهرک صنعتی شمس‌آباد، خیابان پنجم شمالی';

describe('resolveSenderAddressLines — explicit per-document choice (v2.42.0)', () => {
  it('main_office selection → ONLY the head-office line', () => {
    const r = resolveSenderAddressLines({
      headOffice: HEAD, factory: FACTORY, senderAddressType: 'main_office',
    });
    expect(r).toEqual([{ label: 'نشانی دفتر مرکزی', value: HEAD }]);
  });

  it('factory selection → ONLY the factory line', () => {
    const r = resolveSenderAddressLines({
      headOffice: HEAD, factory: FACTORY, senderAddressType: 'factory',
    });
    expect(r).toEqual([{ label: 'نشانی کارخانه', value: FACTORY }]);
  });

  it('selection for an UNREGISTERED address degrades to the default (no empty labelled line)', () => {
    const r = resolveSenderAddressLines({
      headOffice: null, factory: FACTORY, senderAddressType: 'main_office',
    });
    expect(r).toEqual([{ label: 'نشانی کارخانه', value: FACTORY }]);

    const r2 = resolveSenderAddressLines({
      headOffice: HEAD, factory: null, senderAddressType: 'factory',
    });
    expect(r2).toEqual([{ label: 'نشانی دفتر مرکزی', value: HEAD }]);
  });

  it('empty-string addresses count as unregistered (degradation, not an empty line)', () => {
    const r = resolveSenderAddressLines({
      headOffice: '   ', factory: FACTORY, senderAddressType: 'main_office',
    });
    expect(r).toEqual([{ label: 'نشانی کارخانه', value: FACTORY }]);
  });

  it('junk senderAddressType values are ignored (default behaviour)', () => {
    const r = resolveSenderAddressLines({
      headOffice: HEAD, factory: FACTORY, senderAddressType: 'both' as string,
    });
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ label: 'نشانی دفتر مرکزی', value: HEAD });
    expect(r[1]).toEqual({ label: 'نشانی کارخانه', value: FACTORY });
  });
});

describe('resolveSenderAddressLines — v2.35.0 default (null / absent selection)', () => {
  it('both registered → two labelled lines in order', () => {
    const r = resolveSenderAddressLines({ headOffice: HEAD, factory: FACTORY });
    expect(r).toHaveLength(2);
    expect(r[0].label).toBe('نشانی دفتر مرکزی');
    expect(r[1].label).toBe('نشانی کارخانه');
  });

  it('only head office → single labelled line', () => {
    const r = resolveSenderAddressLines({ headOffice: HEAD, factory: null });
    expect(r).toEqual([{ label: 'نشانی دفتر مرکزی', value: HEAD }]);
  });

  it('only factory → single labelled line', () => {
    const r = resolveSenderAddressLines({ headOffice: null, factory: FACTORY });
    expect(r).toEqual([{ label: 'نشانی کارخانه', value: FACTORY }]);
  });

  it('legacy address only → single UNLABELLED line (print backwards-compat)', () => {
    const r = resolveSenderAddressLines({ headOffice: null, factory: null, legacy: HEAD });
    expect(r).toEqual([{ label: '', value: HEAD }]);
  });

  it('nothing registered → empty array (caller prints dotted placeholder)', () => {
    expect(resolveSenderAddressLines({})).toEqual([]);
    expect(resolveSenderAddressLines({ legacy: '  ' })).toEqual([]);
  });

  it('selection ignored when NOTHING is registered at all', () => {
    const r = resolveSenderAddressLines({ senderAddressType: 'factory' });
    expect(r).toEqual([]);
  });
});

describe('isSenderAddressType — strict API validation', () => {
  it('accepts the two known values', () => {
    expect(isSenderAddressType('main_office')).toBe(true);
    expect(isSenderAddressType('factory')).toBe(true);
  });

  it('rejects null / undefined / junk', () => {
    expect(isSenderAddressType(null)).toBe(false);
    expect(isSenderAddressType(undefined)).toBe(false);
    expect(isSenderAddressType('')).toBe(false);
    expect(isSenderAddressType('both')).toBe(false);
    expect(isSenderAddressType(42)).toBe(false);
    expect(isSenderAddressType({})).toBe(false);
  });
});
