// ════════════════════════════════════════════════════════════════
// performance-center.test.ts — v2.51.0 (r76) regression tests for
// the «مرکز گزارش حرفه‌ای» shared contract.
//
// The API handler and the ReportsCenter UI (screen + A4 PDF sheets)
// both derive from src/lib/performance-center.ts; these tests pin
// the exact runtime shape both sides depend on: period windows,
// 12-month Jalali trend buckets (boundary math), expert rows and
// the field constants the regression suite greps for.
// ════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  PERIOD_MONTHS_OPTIONS, periodLabel, periodWindow, toPersianDigits,
  last12JalaliMonthBuckets, trendBucketIndex, buildExpertPerfRow,
  COMPANY_PERF_ROW_FIELDS, EXPERT_PERF_ROW_FIELDS, PERFORMANCE_KPI_FIELDS, TREND_MONTHS,
} from '@/lib/performance-center';
import { gregorianToJalali, jalaliToGregorian } from '@/lib/jalali';
import type { StaffPerfInput } from '@/lib/staff-perf';

const baseInput: StaffPerfInput = {
  userId: 'u1',
  displayName: 'علی قزاقی',
  jobTitle: 'sales_expert',
  roleLabel: 'کارشناس فروش',
  sales: 4_500_000_000.4,
  orders: 9,
  centers: 14,
  pipeline: 6,
  won: 5,
  lost: 2,
};

describe('period — rolling window', () => {
  it('labels: all-time + Persian-digit rolling months', () => {
    expect(periodLabel(null)).toBe('کل دوره');
    expect(periodLabel(1)).toBe('۱ ماه اخیر');
    expect(periodLabel(3)).toBe('۳ ماه اخیر');
    expect(periodLabel(12)).toBe('۱۲ ماه اخیر');
  });

  it('window: null → no lower bound; N → about N months back', () => {
    const now = new Date('2026-09-04T12:00:00Z');
    expect(periodWindow(null, now).from).toBeNull();
    const w3 = periodWindow(3, now);
    expect(w3.from).not.toBeNull();
    const monthsBack =
      (now.getFullYear() - w3.from!.getFullYear()) * 12 + (now.getMonth() - w3.from!.getMonth());
    expect(monthsBack).toBe(3);
    expect(w3.to.getTime()).toBe(now.getTime());
  });

  it('accepts only the five canonical options', () => {
    expect(PERIOD_MONTHS_OPTIONS).toEqual([null, 1, 3, 6, 12]);
  });
});

describe('toPersianDigits — display formatting', () => {
  it('converts ASCII digits and keeps everything else', () => {
    expect(toPersianDigits(1405)).toBe('۱۴۰۵');
    expect(toPersianDigits('1,234')).toBe('۱,۲۳۴');
    expect(toPersianDigits('abc')).toBe('abc');
  });
});

describe('last12JalaliMonthBuckets — trend boundary math', () => {
  it('returns exactly 12 buckets, oldest → newest, ending on the current month', () => {
    const now = new Date('2026-09-04T12:00:00Z'); // 1405/06/13
    const buckets = last12JalaliMonthBuckets(now);
    expect(buckets).toHaveLength(TREND_MONTHS);
    const [cy, cm] = gregorianToJalali(2026, 9, 4);
    expect(buckets[buckets.length - 1].jy).toBe(cy);
    expect(buckets[buckets.length - 1].jm).toBe(cm);
    // strictly increasing boundaries
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].start.getTime()).toBeGreaterThan(buckets[i - 1].start.getTime());
    }
    // consecutive: each start = previous end + 1ms
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].start.getTime() - buckets[i - 1].end.getTime()).toBe(1);
    }
  });

  it('bucket start round-trips to day 1 of the same Jalali month', () => {
    const buckets = last12JalaliMonthBuckets(new Date('2026-09-04T12:00:00Z'));
    for (const b of buckets) {
      const [gy, gm, gd] = jalaliToGregorian(b.jy, b.jm, 1);
      expect(b.start.getUTCFullYear()).toBe(gy);
      expect(b.start.getUTCMonth() + 1).toBe(gm);
      expect(b.start.getUTCDate()).toBe(gd);
    }
  });

  it('trendBucketIndex maps a mid-month instant to its bucket and rejects outsiders', () => {
    const now = new Date('2026-09-04T12:00:00Z');
    const buckets = last12JalaliMonthBuckets(now);
    // today's month is the LAST bucket
    expect(trendBucketIndex(buckets, now)).toBe(buckets.length - 1);
    // a month-start instant lands in its own bucket
    expect(trendBucketIndex(buckets, buckets[0].start)).toBe(0);
    expect(trendBucketIndex(buckets, buckets[5].end)).toBe(5);
    // far past → -1
    expect(trendBucketIndex(buckets, new Date('2019-01-01T00:00:00Z'))).toBe(-1);
  });
});

describe('buildExpertPerfRow — the shared API↔UI contract', () => {
  it('extends the staff row with performed calls/visits', () => {
    const row = buildExpertPerfRow(baseInput, 4_560, 12);
    expect(row.calls).toBe(4_560);
    expect(row.visits).toBe(12);
    // inherited computation from buildStaffPerfRow
    expect(row.sales).toBe(4_500_000_000); // rounded integer Rial
    expect(row.winRate).toBe(71); // 5 / (5+2)
    expect(row.avgDealSize).toBe(500_000_000); // 4.5B / 9
    expect(row.userName).toBe('علی قزاقی');
    expect(row.role).toBe('sales_expert');
  });

  it('every field the UI reads is on the row (regression: field drift)', () => {
    const row = buildExpertPerfRow(baseInput, 0, 0);
    for (const field of EXPERT_PERF_ROW_FIELDS) {
      expect(row[field], `field ${field} must be present`).not.toBeUndefined();
    }
  });
});

describe('field constants — grep anchors for the e2e/packaging gates', () => {
  it('companies: 9 fields', () => {
    expect(COMPANY_PERF_ROW_FIELDS).toHaveLength(9);
  });
  it('kpis: 9 fields', () => {
    expect(PERFORMANCE_KPI_FIELDS).toHaveLength(9);
  });
  it('experts: 11 fields (9 staff + calls + visits)', () => {
    expect(EXPERT_PERF_ROW_FIELDS).toHaveLength(11);
  });
});
