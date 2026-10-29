// ════════════════════════════════════════════════════════════
// PERFORMANCE CENTER CONTRACT (v2.51.0 — round 76)
//
// «مرکز گزارش حرفه‌ای» — company sales performance + sales-expert
// performance in one professional report with PDF export.
//
// Same discipline as src/lib/staff-perf.ts (v2.43.1): the API handler
// (/api/reports action 'performance-center') and the UI component
// (src/components/reports-center.tsx) BOTH derive from THIS single
// module, so an API↔UI field-name drift becomes a compile error
// instead of a runtime crash.
//
// Pure module: no DB, no React — safe on client & server.
// ════════════════════════════════════════════════════════════

import { buildStaffPerfRow, type StaffPerfInput, type StaffPerfRow } from './staff-perf';
import { gregorianToJalali, jalaliToGregorian, jalaliMonthName } from './jalali';

// ── Period ──────────────────────────────────────────────────

/** Rolling window: last N months (Gregorian month arithmetic), or all-time. */
export type PeriodMonths = 1 | 3 | 6 | 12 | null;

export const PERIOD_MONTHS_OPTIONS: readonly PeriodMonths[] = [null, 1, 3, 6, 12];

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** '۰'…'۹' digit substitution (display only — never stored). */
export function toPersianDigits(value: number | string): string {
  return String(value).replace(/[0-9]/g, (c) => PERSIAN_DIGITS[parseInt(c, 10)]);
}

/** Human label of a rolling period ('کل دوره' / '۳ ماه اخیر' / …). */
export function periodLabel(months: PeriodMonths): string {
  if (months === null) return 'کل دوره';
  return `${toPersianDigits(months)} ماه اخیر`;
}

/** [from, to] window of a rolling period; `from` is null for all-time. */
export function periodWindow(months: PeriodMonths, now: Date = new Date()): { from: Date | null; to: Date } {
  if (months === null) return { from: null, to: now };
  const from = new Date(now.getTime());
  from.setMonth(from.getMonth() - months);
  return { from, to: now };
}

export interface PeriodSpec {
  months: PeriodMonths;
  label: string;
  fromISO: string | null;
  toISO: string;
}

// ── Company rows ────────────────────────────────────────────

export interface CompanyPerfRow {
  companyId: string;
  name: string;
  slug: string;
  color: string;
  /** approved purchase total (Rial, double-count-guarded) */
  sales: number;
  orders: number;
  /** distinct centers with ≥1 approved purchase */
  centers: number;
  avgDeal: number;
  /** share of the scoped total sale, 0–100 (rounded) */
  share: number;
}

/** Every field the UI reads — regression-tested. */
export const COMPANY_PERF_ROW_FIELDS: readonly (keyof CompanyPerfRow)[] = [
  'companyId', 'name', 'slug', 'color', 'sales', 'orders', 'centers', 'avgDeal', 'share',
];

// ── Expert rows ─────────────────────────────────────────────

/** StaffPerfRow + operational activity depth (performed calls/visits). */
export interface ExpertPerfRow extends StaffPerfRow {
  calls: number;
  visits: number;
}

/** Every field the UI reads — regression-tested. */
export const EXPERT_PERF_ROW_FIELDS: readonly (keyof ExpertPerfRow)[] = [
  'userId', 'userName', 'role', 'sales', 'orders', 'centers', 'pipeline',
  'winRate', 'avgDealSize', 'calls', 'visits',
];

/** PURE — extend the shared staff row with activity counts. */
export function buildExpertPerfRow(input: StaffPerfInput, calls: number, visits: number): ExpertPerfRow {
  return { ...buildStaffPerfRow(input), calls, visits };
}

// ── 12-month Jalali trend ───────────────────────────────────

export interface TrendPoint {
  /** Jalali month name (فروردین…اسفند) — chart x-axis label */
  label: string;
  /** Jalali year of the bucket (for multi-year edges) */
  jy: number;
  jm: number;
  total: number;
  byCompany: Record<string, number>;
}

export const TREND_MONTHS = 12;

export interface TrendBucket {
  label: string;
  jy: number;
  jm: number;
  /** [start, end] Gregorian UTC instants of the Jalali month */
  start: Date;
  end: Date;
}

/**
 * The last TREND_MONTHS Jalali months (oldest→newest), each with exact
 * Gregorian boundaries derived by jalaliToGregorian round-trips (no leap
 * tables). The trend is ALWAYS a 12-month context — it is independent of
 * the period selector (which filters the KPIs/tables/totals only).
 */
export function last12JalaliMonthBuckets(now: Date = new Date()): TrendBucket[] {
  const [cy, cm] = gregorianToJalali(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  const buckets: TrendBucket[] = [];
  for (let i = TREND_MONTHS - 1; i >= 0; i--) {
    let jy = cy, jm = cm - i;
    while (jm <= 0) { jm += 12; jy--; }
    const [sy, sm, sd] = jalaliToGregorian(jy, jm, 1);
    const next = jm === 12 ? jalaliToGregorian(jy + 1, 1, 1) : jalaliToGregorian(jy, jm + 1, 1);
    buckets.push({
      label: jalaliMonthName(jm),
      jy, jm,
      start: new Date(Date.UTC(sy, sm - 1, sd)),
      end: new Date(Date.UTC(next[0], next[1] - 1, next[2]) - 1),
    });
  }
  return buckets;
}

/** Map an issued-at instant to a bucket index (−1 when outside the window). */
export function trendBucketIndex(buckets: TrendBucket[], at: Date): number {
  const t = at.getTime();
  for (let i = 0; i < buckets.length; i++) {
    if (t >= buckets[i].start.getTime() && t <= buckets[i].end.getTime()) return i;
  }
  return -1;
}

// ── KPIs + report envelope ──────────────────────────────────

export interface PerformanceKpis {
  totalSales: number;
  totalOrders: number;
  /** distinct centers with ≥1 approved purchase (scoped) */
  activeCenters: number;
  companiesWithSales: number;
  expertCount: number;
  /** average winRate over experts with won+lost > 0 (0 when none) */
  avgWinRate: number;
  /** totalSales / totalOrders (0 when no orders) */
  avgDealSize: number;
  totalCalls: number;
  totalVisits: number;
}

export const PERFORMANCE_KPI_FIELDS: readonly (keyof PerformanceKpis)[] = [
  'totalSales', 'totalOrders', 'activeCenters', 'companiesWithSales',
  'expertCount', 'avgWinRate', 'avgDealSize', 'totalCalls', 'totalVisits',
];

export interface PerformanceReport {
  period: PeriodSpec;
  kpis: PerformanceKpis;
  companies: CompanyPerfRow[];
  monthlyTrend: TrendPoint[];
  experts: ExpertPerfRow[];
  generatedAt: string;
}
