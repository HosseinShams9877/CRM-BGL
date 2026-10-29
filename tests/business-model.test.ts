// Unit tests — business-model primitives: warranty engine + tiered pricing.
// Part of the v2.8.0 test foundation (audit P1-7).
import { describe, it, expect } from 'vitest';
import { computeWarranty, resolveTier, tierDiscountPercent } from '@/lib/business-model';

describe('computeWarranty (serial-driven warranty engine)', () => {
  it('returns unknown when soldAt is missing', () => {
    const r = computeWarranty(null, 12);
    expect(r.warrantyStatus).toBe('unknown');
    expect(r.warrantyUntil).toBeNull();
    expect(r.daysLeft).toBeNull();
  });

  it('marks a recent sale as in warranty', () => {
    const soldAt = new Date(Date.now() - 30 * 86400000); // 30 days ago
    const r = computeWarranty(soldAt, 12);
    expect(r.warrantyStatus).toBe('in_warranty');
    expect(r.daysLeft).toBeGreaterThan(300); // ~11 months left of a 12-month warranty
  });

  it('marks an old sale as out of warranty', () => {
    const soldAt = new Date(Date.now() - 400 * 86400000); // ~13 months ago
    const r = computeWarranty(soldAt, 12);
    expect(r.warrantyStatus).toBe('out_of_warranty');
    expect(r.daysLeft).toBeLessThan(0);
  });

  it('accepts ISO string dates from the API layer', () => {
    const iso = new Date(Date.now() - 5 * 86400000).toISOString();
    const r = computeWarranty(iso, 24);
    expect(r.warrantyStatus).toBe('in_warranty');
  });

  it('falls back to 12 months for a non-positive warrantyMonths', () => {
    const soldAt = new Date(Date.now() - 86400000); // yesterday
    const r = computeWarranty(soldAt, 0);
    expect(r.warrantyStatus).toBe('in_warranty');
    // ~364 days left proves the 12-month fallback was used
    expect(r.daysLeft).toBeGreaterThan(360);
  });
});

describe('resolveTier (tiered partner pricing)', () => {
  const tiers = [
    { minQty: 1, price: 100 },
    { minQty: 10, price: 90 },
    { minQty: 50, price: 80 },
    { minQty: 100, price: 70, active: false }, // disabled tier must not win
  ];

  it('picks the best eligible tier below the quantity', () => {
    expect(resolveTier(tiers, 25)?.price).toBe(90);
    expect(resolveTier(tiers, 60)?.price).toBe(80);
    expect(resolveTier(tiers, 1)?.price).toBe(100);
  });

  it('skips inactive tiers even when they match the quantity', () => {
    expect(resolveTier(tiers, 150)?.price).toBe(80); // not the disabled 70 tier
  });

  it('returns null when nothing qualifies', () => {
    expect(resolveTier(tiers, 0)).toBeNull();
    expect(resolveTier([], 5)).toBeNull();
    expect(resolveTier([{ minQty: 10, price: 1 }], 5)).toBeNull();
  });
});

describe('tierDiscountPercent', () => {
  it('computes the effective discount vs the public price', () => {
    expect(tierDiscountPercent(80, 100)).toBeCloseTo(20);
    expect(tierDiscountPercent(100, 100)).toBeCloseTo(0);
  });

  it('guards against a zero/invalid public price', () => {
    expect(tierDiscountPercent(80, 0)).toBe(0);
    expect(tierDiscountPercent(80, -5)).toBe(0);
  });
});
