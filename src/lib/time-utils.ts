// ════════════════════════════════════════════════════════════════
// time-utils.ts — v2.37.0 (round 63) shared helpers for the
// click-to-select TimePicker and the quick-activity «ثبت در تقویم»
// future detection.
//
// VALUE CONTRACT (identical to the old typed / native time inputs):
//   a time value is ALWAYS the Latin string 'HH:MM' (24h) or '' when
//   nothing is picked yet. Display converts to Persian digits; the
//   state and the API payloads stay Latin — drop-in everywhere.
// ════════════════════════════════════════════════════════════════

import { parseJalaliDate, jalaliToGregorian } from '@/lib/jalali';

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const PERSIAN_TO_LATIN: Record<string, string> = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  // Arabic-Indic twins users sometimes paste
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

/** '09:30' → '۰۹:۳۰' (display only — state stays Latin). */
export function toPersianTime(time: string): string {
  return String(time).replace(/[0-9]/g, (c) => PERSIAN_DIGITS[Number(c)]);
}

/**
 * Tolerant 'HH:MM' parser — accepts Persian/Arabic digits, 'H:M',
 * with or without a colon, surrounding spaces. Returns [hour, minute]
 * or null when the string is not a valid 24h time.
 */
export function timeParts(raw: string): [number, number] | null {
  if (!raw) return null;
  const latin = String(raw).replace(/[۰-۹٠-٩]/g, (c) => PERSIAN_TO_LATIN[c] ?? c).trim();
  const m = latin.match(/^(\d{1,2})\s*[:.]\s*(\d{1,2})$/) ?? latin.match(/^(\d{2})(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return [h, min];
}

/** Normalize any tolerated spelling to canonical 'HH:MM' ('' when invalid). */
export function normalizeTimeInput(raw: string): string {
  const p = timeParts(raw);
  return p ? `${String(p[0]).padStart(2, '0')}:${String(p[1]).padStart(2, '0')}` : '';
}

/** The current wall-clock time as 'HH:MM' (the picker's «الان»). */
export function nowTimeValue(now: Date = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Is the Jalali date + time combination STRICTLY in the future
 * (minute granularity, local clock)?
 *
 *   • a LATER day                     → future
 *   • TODAY with a later minute       → future
 *   • TODAY with the current minute   → NOT future (logging «الان»)
 *   • TODAY with an earlier minute    → NOT future (logging the past)
 *   • empty/invalid time              → treated as 00:00 of that day
 *
 * This drives the quick-activity smart button: future → «ثبت در تقویم».
 */
export function isFutureDateTime(jalaliDate: string, time: string, now: Date = new Date()): boolean {
  const parts = parseJalaliDate(jalaliDate);
  if (!parts) return false;
  const [gy, gm, gd] = jalaliToGregorian(parts[0], parts[1], parts[2]);
  const tp = timeParts(time);
  const h = tp ? tp[0] : 0;
  const min = tp ? tp[1] : 0;
  const picked = new Date(gy, gm - 1, gd, h, min, 0, 0);
  const nowMinute = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
  return picked.getTime() > nowMinute.getTime();
}
