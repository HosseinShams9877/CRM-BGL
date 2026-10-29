// ════════════════════════════════════════════════════════════
// PERSIAN RELATIVE DATE PARSER (v2.27.0)
//
// «پس‌فردا تماس بگیرید» → a concrete Gregorian date (ISO), parsed
// from natural Persian. Pure module — unit-testable, no DB, no I/O.
// Backend stores standard dates; UI renders Jalali (lib/jalali).
// ════════════════════════════════════════════════════════════

import { jalaliToGregorian, gregorianToJalali } from '@/lib/jalali';

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Convert Persian/Arabic digits to ASCII digits. */
export function normalizeDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (ch) => {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) return String(p);
    return String(ARABIC_DIGITS.indexOf(ch));
  });
}

export const PERSIAN_WEEKDAYS: Record<string, number> = {
  'شنبه': 0, 'یکشنبه': 1, 'دوشنبه': 2, 'سه‌شنبه': 3, 'سه شنبه': 3,
  'چهارشنبه': 4, 'چهار شنبه': 4, 'پنج‌شنبه': 5, 'پنج شنبه': 5, 'پنجشنبه': 5,
  'جمعه': 6, 'جمعه‌ها': 6,
};

/** Jalali month names → month number. */
const PERSIAN_MONTHS: Record<string, number> = {
  'فروردین': 1, 'اردیبهشت': 2, 'خرداد': 3, 'تیر': 4, 'مرداد': 5, 'شهریور': 6,
  'مهر': 7, 'آبان': 8, 'آذر': 9, 'دی': 10, 'بهمن': 11, 'اسفند': 12,
};

export interface ParsedFollowupDate {
  date: Date;
  matchedText: string;
  rule: string;
}

/**
 * Parse a Persian relative/fatural date expression against a reference date.
 * Supported patterns (case-tolerant, zero-width-non-joiner tolerant):
 *   امروز، فردا، پس‌فردا، پس فردا، ۳ روز بعد، هفته بعد، هفته آینده/آینده،
 *   دو هفته بعد، ماه بعد، ماه آینده، اول ماه بعد، نیم‌ماه دیگر،
 *   شنبه / روز شنبه / شنبه هفته بعد، ۱۵ اسفند، ۲۱ ماه،
 *   «سر ماه»، «اول ماه آینده»، «نیمه ماه»
 * Returns null when nothing matches — the caller must NOT guess.
 */
export function parsePersianRelativeDate(text: string, now: Date = new Date()): ParsedFollowupDate | null {
  if (!text) return null;
  const t = normalizeDigits(text).replace(/\u200c/g, ' ').replace(/\s+/g, ' ').trim();

  // ── Simple offsets ──
  const simple: { re: RegExp; days: number; label: string }[] = [
    { re: /(?:امروز|همین امروز|برای امروز)/, days: 0, label: 'امروز' },
    // پس‌فردا MUST be tested before فردا — after ZWNJ normalization
    // «پس فردا» contains «فردا» and would shadow it.
    { re: /(?:پس فردا|پسفردا|دو روز بعد|دو روز دیگه|دو روز دیگر)/, days: 2, label: 'پس‌فردا' },
    { re: /(?:فردا|برای فردا|تا فردا)/, days: 1, label: 'فردا' },
    { re: /(?:سه روز بعد|سه روز دیگر|سه روز دیگه)/, days: 3, label: 'سه روز بعد' },
  ];
  for (const s of simple) {
    const m = t.match(s.re);
    if (m) return { date: addDays(now, s.days), matchedText: m[0], rule: s.label };
  }

  // ── «N روز بعد / دیگر / دیگه» ──
  const nDays = t.match(/(\d{1,3})\s*(?:روز|روز دیگر|روز دیگه)\s*(?:بعد|دیگر|دیگه|بعدش)?/);
  if (nDays) {
    const n = parseInt(nDays[1], 10);
    if (n > 0 && n <= 365) return { date: addDays(now, n), matchedText: nDays[0], rule: `${n} روز بعد` };
  }

  // ── Weeks ──
  const nWeeks = t.match(/(\d{1,2})\s*هفته\s*(?:بعد|دیگر|دیگه|آینده|اینده)?/);
  if (nWeeks) {
    const n = parseInt(nWeeks[1], 10);
    if (n > 0 && n <= 52) return { date: addDays(now, n * 7), matchedText: nWeeks[0], rule: `${n} هفته بعد` };
  }
  // «دو هفته بعد» contains «هفته بعد» → the multi-week check must run first.
  if (/دو هفته/.test(t)) {
    return { date: addDays(now, 14), matchedText: 'دو هفته', rule: 'دو هفته بعد' };
  }
  if (/(?:هفته بعد|هفته آینده|هفته اینده|هفته دیگر|هفته دیگه|هفته بعدی)/.test(t)) {
    return { date: addDays(now, 7), matchedText: 'هفته بعد', rule: 'هفته بعد' };
  }

  // ── «اول ماه بعد / سر ماه» → 1st of next month ──
  // MUST run before the generic «ماه بعد» (substring collision).
  if (/(?:اول ماه بعد|اول ماه آینده|اول ماه اینده|سر ماه|اول سر ماه)/.test(t)) {
    const d = addMonths(now, 1);
    d.setDate(1);
    return { date: d, matchedText: 'اول ماه بعد', rule: 'اول ماه بعد' };
  }

  // ── Months ──
  if (/(?:نیم ?ماه|نیمه ماه|۱۵ روز دیگر|15 روز دیگر)/.test(t)) {
    return { date: addDays(now, 15), matchedText: 'نیم ماه', rule: 'نیم ماه بعد' };
  }
  if (/(?:دو ماه|دو ماه بعد)/.test(t)) {
    return { date: addMonths(now, 2), matchedText: 'دو ماه', rule: 'دو ماه بعد' };
  }
  if (/(?:ماه بعد|ماه آینده|ماه اینده|ماه دیگر|ماه دیگه|ماه بعدی|یک ماه دیگر|یک ماه دیگه)/.test(t)) {
    return { date: addMonths(now, 1), matchedText: 'ماه بعد', rule: 'ماه بعد' };
  }

  // ── Weekday names → next occurrence (this week or next) ──
  // Longest names first: «شنبه» is a substring of «دوشنبه/سه شنبه/…», so
  // checking it first would mis-classify every compound weekday.
  const weekdayEntries = Object.entries(PERSIAN_WEEKDAYS)
    .map(([k, v]) => [k.replace(/\u200c/g, ' '), v] as [string, number])
    .sort((a, b) => b[0].length - a[0].length);
  for (const [day, idx] of weekdayEntries) {
    const escaped = day.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:روز\\s*)?${escaped}(?:\\s*(?:هفته بعد|هفته آینده|هفته اینده))?`);
    const m = t.match(re);
    if (m) {
      const nextWeek = /هفته (?:بعد|آینده|اینده)/.test(m[0]);
      // JS getDay(): Sunday=0 … Saturday=6 — Persian week starts Saturday.
      // Persian index (Sat=0) from JS day: (jsDay + 1) % 7
      const nowIdx = (now.getDay() + 1) % 7;
      let diff = idx - nowIdx;
      if (diff <= 0 || nextWeek) diff += 7;
      if (nextWeek && diff <= 7) diff += 7; // explicit «شنبه هفته بعد»
      if (diff > 14) diff = ((diff - 1) % 7) + 8; // clamp to at most next week
      return { date: addDays(now, diff), matchedText: m[0], rule: `${day} (${diff} روز بعد)` };
    }
  }

  // ── «N <ماه‌نام>» (e.g. ۱۵ اسفند) → that Jalali date in current/next Jalali year ──
  for (const [monthName, monthNo] of Object.entries(PERSIAN_MONTHS)) {
    const re = new RegExp(`(\\d{1,2})\\s*${monthName}`);
    const m = t.match(re);
    if (m) {
      const day = parseInt(m[1], 10);
      if (day >= 1 && day <= 31) {
        const jToday = jalaliToday(now);
        let jy = jToday[0];
        // If the date already passed this Jalali year → next year
        if (monthNo < jToday[1] || (monthNo === jToday[1] && day < jToday[2])) jy += 1;
        const [gy, gm, gd] = jalaliToGregorian(jy, monthNo, day);
        const dt = new Date(Date.UTC(gy, gm - 1, gd, 9, 0, 0));
        if (!isNaN(dt.getTime())) return { date: dt, matchedText: m[0], rule: `${day} ${monthName}` };
      }
    }
  }

  // ── Bare «N ماه» (e.g. ۲۱ ماه) → day N of next month ──
  const nMonthDay = t.match(/(\d{1,2})\s*ماه\b/);
  if (nMonthDay) {
    const day = parseInt(nMonthDay[1], 10);
    if (day >= 1 && day <= 31) {
      const d = addMonths(now, 1);
      d.setDate(Math.min(day, 28));
      return { date: d, matchedText: nMonthDay[0], rule: `${day} ماه بعد` };
    }
  }

  return null;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d;
}

function addMonths(base: Date, months: number): Date {
  const d = new Date(base);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  d.setDate(Math.min(day, 28));
  d.setHours(9, 0, 0, 0);
  return d;
}

function jalaliToday(d: Date): [number, number, number] {
  return gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/**
 * Scan an AI-extracted action/analysis text bundle for the FIRST relative
 * date expression. Order matters: caller passes the most authoritative
 * field first (e.g. suggestedFollowupReason, then commitments, then summary).
 */
export function findFollowupDateInTexts(texts: (string | null | undefined)[], now: Date = new Date()): ParsedFollowupDate | null {
  for (const t of texts) {
    if (!t) continue;
    const parsed = parsePersianRelativeDate(t, now);
    if (parsed) return parsed;
  }
  return null;
}
