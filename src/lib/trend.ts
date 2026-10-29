/**
 * v2.25.0 — Jalali (Persian calendar) month bucketing for the holding
 * dashboard's REAL monthly sales trend. Pure functions, unit-tested
 * (tests/trend.test.ts).
 *
 * Month keys are 'YYYY-MM' strings in the Persian calendar
 * (e.g. '1404-06' = شهریور ۱۴۰۴). Node ships full ICU by default, so
 * Intl.DateTimeFormat with the 'persian' calendar is authoritative —
 * no third-party date library is involved.
 */

const KEY_FMT = new Intl.DateTimeFormat('en-US-u-ca-persian', {
  year: 'numeric',
  month: '2-digit',
});

const PERSIAN_MONTHS = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
];

/** 'YYYY-MM' in the Persian calendar for the given date. */
export function jalaliMonthKey(d: Date): string {
  const parts = KEY_FMT.formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0';
  const month = parts.find((p) => p.type === 'month')?.value ?? '1';
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Persian month name for a 'YYYY-MM' key (e.g. '1404-06' → 'شهریور'). */
export function jalaliMonthLabel(key: string): string {
  const m = Number(key.split('-')[1]);
  return PERSIAN_MONTHS[m - 1] || key;
}

/** Shift a 'YYYY-MM' key by `delta` months (negative = back in time). */
export function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** The last `n` Jalali month keys ending at `now`'s month, oldest first. */
export function lastMonthKeys(n: number, now = new Date()): string[] {
  const count = Math.max(1, Math.min(Math.floor(n) || 1, 24));
  const current = jalaliMonthKey(now);
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) keys.push(shiftMonthKey(current, -i));
  return keys;
}

/** Sum `amountOf(row)` into Jalali-month buckets keyed by `dateOf(row)`. */
export function bucketSumByMonth<T>(
  rows: T[],
  dateOf: (row: T) => Date,
  amountOf: (row: T) => number,
): Map<string, number> {
  const buckets = new Map<string, number>();
  for (const row of rows) {
    const key = jalaliMonthKey(dateOf(row));
    buckets.set(key, (buckets.get(key) || 0) + amountOf(row));
  }
  return buckets;
}
