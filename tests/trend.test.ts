import { describe, it, expect } from 'vitest';
import {
  jalaliMonthKey,
  jalaliMonthLabel,
  shiftMonthKey,
  lastMonthKeys,
  bucketSumByMonth,
} from '../src/lib/trend';

describe('v2.25.0 — Jalali month helpers (holding-dashboard trend)', () => {
  it('maps Gregorian dates to Persian-calendar YYYY-MM keys', () => {
    // 2026-08-28 is 1405-06-06 (شهریور ۱۴۰۵)
    expect(jalaliMonthKey(new Date(2026, 7, 28))).toBe('1405-06');
    // 2026-03-21 (Nowruz edge) is 1405-01-01
    expect(jalaliMonthKey(new Date(2026, 2, 21))).toBe('1405-01');
    // 2025-03-20 is the last day of 1403 (اسفند)
    expect(jalaliMonthKey(new Date(2025, 2, 20))).toBe('1403-12');
  });

  it('labels keys with Persian month names', () => {
    expect(jalaliMonthLabel('1405-06')).toBe('شهریور');
    expect(jalaliMonthLabel('1405-01')).toBe('فروردین');
    expect(jalaliMonthLabel('1403-12')).toBe('اسفند');
  });

  it('shifts month keys across year boundaries', () => {
    expect(shiftMonthKey('1405-01', -1)).toBe('1404-12');
    expect(shiftMonthKey('1404-12', 1)).toBe('1405-01');
    expect(shiftMonthKey('1405-06', -7)).toBe('1404-11');
    expect(shiftMonthKey('1405-06', 6)).toBe('1405-12');
  });

  it('builds the last N month keys oldest-first ending at the current month', () => {
    const now = new Date(2026, 7, 28); // 1405-06
    expect(lastMonthKeys(7, now)).toEqual([
      '1404-12', '1405-01', '1405-02', '1405-03', '1405-04', '1405-05', '1405-06',
    ]);
    expect(lastMonthKeys(1, now)).toEqual(['1405-06']);
    // clamped to sane bounds
    expect(lastMonthKeys(0, now)).toHaveLength(1);
    expect(lastMonthKeys(99, now)).toHaveLength(24);
  });

  it('sums amounts into Jalali month buckets', () => {
    const rows = [
      { d: new Date(2026, 7, 28), amount: 100 }, // 1405-06 (شهریور)
      { d: new Date(2026, 7, 26), amount: 50 },  // 1405-06 (شهریور)
      { d: new Date(2026, 7, 20), amount: 10 },  // 1405-05 (مرداد)
    ];
    const buckets = bucketSumByMonth(rows, (r) => r.d, (r) => r.amount);
    expect(buckets.get('1405-06')).toBe(150);
    expect(buckets.get('1405-05')).toBe(10);
    expect(buckets.size).toBe(2);
  });
});
