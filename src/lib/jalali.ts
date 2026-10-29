// Jalali (Shamsi) date conversion utilities

export function gregorianToJalali(gy: number, gm: number, gd: number): [number, number, number] {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = (gy <= 1600) ? 0 : 979;
  gy -= (gy <= 1600) ? 621 : 1600;
  const gy2 = (gm > 2) ? (gy + 1) : gy;
  let days = 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = (days < 186) ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + ((days < 186) ? (days % 31) : ((days - 186) % 30));
  return [jy, jm, jd];
}

export function toJalaliString(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (!d || isNaN(d.getTime())) return '';
  const [jy, jm, jd] = gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
}

export function jalaliMonthName(month: number): string {
  const names = ['', 'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
  return names[month] || '';
}

// ── Jalali → Gregorian (v2.16.0 — frontend round, calendar/forms) ──
// Round-trips gregorianToJalali (33-year cycle arithmetic; verified
// 1405/06/04 ↔ 2026-08-26 against the astronomically correct table).
export function jalaliToGregorian(jy: number, jm: number, jd: number): [number, number, number] {
  const y = jy + 1595;
  let days =
    -355668 +
    365 * y +
    Math.floor(y / 33) * 8 +
    Math.floor(((y % 33) + 3) / 4) +
    jd +
    (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const gLeap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthDays = [31, gLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < 12 && gd > monthDays[gm]) {
    gd -= monthDays[gm];
    gm++;
  }
  return [gy, gm + 1, gd];
}

/** Number of days in a Jalali month (derived by conversion — no leap tables). */
export function jalaliMonthLength(jy: number, jm: number): number {
  const start = jalaliToGregorian(jy, jm, 1);
  const next = jm === 12 ? jalaliToGregorian(jy + 1, 1, 1) : jalaliToGregorian(jy, jm + 1, 1);
  const msPerDay = 86_400_000;
  return Math.round(
    (Date.UTC(next[0], next[1] - 1, next[2]) - Date.UTC(start[0], start[1] - 1, start[2])) / msPerDay
  );
}

/** Today's Jalali date as a 'YYYY-MM-DD' key (local clock, matches toJalaliString). */
export function toJalaliKey(date: Date = new Date()): string {
  const [jy, jm, jd] = gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return `${jy}-${String(jm).padStart(2, '0')}-${String(jd).padStart(2, '0')}`;
}

/** Parse user-typed Jalali date ('۱۴۰۵/۰۶/۱۵' or '1405-6-15') → [jy, jm, jd] | null. */
export function parseJalaliDate(input: string): [number, number, number] | null {
  // Normalize Persian/Arabic digits to ASCII
  const normalized = input
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[.\-/]/g, '/');
  const parts = normalized.split('/').map((s) => s.trim());
  if (parts.length !== 3) return null;
  const jy = Number(parts[0]);
  const jm = Number(parts[1]);
  const jd = Number(parts[2]);
  if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd)) return null;
  if (jy < 1200 || jy > 1600 || jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
  if (jd > jalaliMonthLength(jy, jm)) return null;
  return [jy, jm, jd];
}

/** Format a Jalali triple as 'YYYY/MM/DD' (Persian-digits display is done by callers). */
export function jalaliPartsToString(jy: number, jm: number, jd: number): string {
  return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
}

// ── v2.36.0 (round 62) — Gregorian ISO ↔ Jalali string bridges ──
// The call-log form stores its date as a native 'YYYY-MM-DD' string;
// the shared JalaliDatePicker speaks Jalali 'YYYY/MM/DD'. Local-time
// anchored (noon), so no UTC off-by-one at the edges of the day.

/** '1405/06/15' → '2026-09-06' (invalid input → ''). */
export function jalaliStringToGregorianIso(jalali: string): string {
  const parts = parseJalaliDate(jalali);
  if (!parts) return '';
  const [gy, gm, gd] = jalaliToGregorian(parts[0], parts[1], parts[2]);
  return `${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
}

/** '2026-09-06' → '1405/06/15' (invalid input → ''). */
export function gregorianIsoToJalaliString(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '').trim());
  if (!m) return '';
  const [jy, jm, jd] = gregorianToJalali(Number(m[1]), Number(m[2]), Number(m[3]));
  return jalaliPartsToString(jy, jm, jd);
}

export function jalaliWeekDay(day: number): string {
  const days = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];
  return days[day] || '';
}

export function formatJalaliFull(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (!d || isNaN(d.getTime())) return '';
  return `${jalaliWeekDay(d.getDay())} ${toJalaliString(d)}`;
}

// ── Jalali year windows (v2.15.0 — sixth-round audit, item 7) ──
// The monthly sales report grouped GREGORIAN months but labeled them with
// Jalali month names (January was rendered «فروردین»). Reports now operate
// on true Jalali years: the window below covers Farvardin 1 → end of
// Esfand, and grouping uses each document's real Jalali (year, month).

/** Current Jalali year (UTC-based, matching the server's clock). */
export function currentJalaliYear(now: Date = new Date()): number {
  return gregorianToJalali(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate())[0];
}

/** Gregorian UTC instant of Farvardin 1st for a Jalali year.
 *  Farvardin 1 falls on March 19–22; scan the window to find the exact day. */
export function jalaliYearStart(jalaliYear: number): Date {
  const gy = jalaliYear + 621;
  const march15 = Date.UTC(gy, 2, 15);
  for (let i = 0; i <= 10; i++) {
    const t = march15 + i * 86_400_000;
    const d = new Date(t);
    const [jy, jm, jd] = gregorianToJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    if (jy === jalaliYear && jm === 1 && jd === 1) return new Date(t);
  }
  return new Date(Date.UTC(gy, 2, 21)); // defensive fallback
}

/** [start, end] Gregorian UTC instants covering a full Jalali year. */
export function jalaliYearWindow(jalaliYear: number): { start: Date; end: Date } {
  return {
    start: jalaliYearStart(jalaliYear),
    end: new Date(jalaliYearStart(jalaliYear + 1).getTime() - 1),
  };
}

