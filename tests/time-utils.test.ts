// ════════════════════════════════════════════════════════════════
// time-utils.test.ts — v2.37.0 (round 63) unit tests for the shared
// time helpers behind the click-to-select TimePicker and the
// quick-activity «ثبت در تقویم» future detection.
//
// Contract under test: a time value is ALWAYS Latin 'HH:MM' (or '');
// display is Persian; the future check drives the smart button.
// ════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  toPersianTime,
  timeParts,
  normalizeTimeInput,
  nowTimeValue,
  isFutureDateTime,
} from '@/lib/time-utils';
import { toJalaliKey, jalaliPartsToString } from '@/lib/jalali';

describe('toPersianTime — display conversion (state stays Latin)', () => {
  it('converts every digit but keeps the colon', () => {
    expect(toPersianTime('09:30')).toBe('۰۹:۳۰');
    expect(toPersianTime('23:59')).toBe('۲۳:۵۹');
    expect(toPersianTime('00:00')).toBe('۰۰:۰۰');
  });

  it('leaves empty strings untouched (optional time fields)', () => {
    expect(toPersianTime('')).toBe('');
  });
});

describe('timeParts — tolerant HH:MM parsing', () => {
  it('parses canonical values', () => {
    expect(timeParts('09:30')).toEqual([9, 30]);
    expect(timeParts('00:00')).toEqual([0, 0]);
    expect(timeParts('23:59')).toEqual([23, 59]);
  });

  it('parses Persian and Arabic digits users might paste', () => {
    expect(timeParts('۰۹:۳۰')).toEqual([9, 30]);
    expect(timeParts('١٧:٤٥')).toEqual([17, 45]);
  });

  it('tolerates single digits, dots and missing separators', () => {
    expect(timeParts('9:5')).toEqual([9, 5]);
    expect(timeParts('09.30')).toEqual([9, 30]);
    expect(timeParts('0930')).toEqual([9, 30]);
  });

  it('rejects out-of-range and garbage input', () => {
    expect(timeParts('24:00')).toBeNull();
    expect(timeParts('12:60')).toBeNull();
    expect(timeParts('')).toBeNull();
    expect(timeParts('سلام')).toBeNull();
    expect(timeParts('99:99')).toBeNull();
  });
});

describe('normalizeTimeInput — canonical output for state/API', () => {
  it('zero-pads both components', () => {
    expect(normalizeTimeInput('9:5')).toBe('09:05');
    expect(normalizeTimeInput('۰۹:۳۰')).toBe('09:30');
  });

  it('returns "" for invalid input instead of throwing', () => {
    expect(normalizeTimeInput('25:00')).toBe('');
    expect(normalizeTimeInput('')).toBe('');
  });
});

describe('nowTimeValue — the «الان» chip', () => {
  it('formats the current clock as HH:MM', () => {
    expect(nowTimeValue(new Date(2026, 8, 1, 9, 5))).toBe('09:05');
    expect(nowTimeValue(new Date(2026, 8, 1, 23, 59))).toBe('23:59');
    expect(nowTimeValue(new Date(2026, 8, 1, 0, 0))).toBe('00:00');
  });
});

describe('isFutureDateTime — the «ثبت در تقویم» trigger', () => {
  // a fixed "now": 1405/06/08 (2026-08-30) at 14:05 local
  const NOW = new Date(2026, 7, 30, 14, 5, 30);
  const TODAY = (() => {
    const [y, m, d] = toJalaliKey(NOW).split('-');
    return jalaliPartsToString(Number(y), Number(m), Number(d));
  })();
  const TOMORROW = (() => {
    const t = new Date(NOW); t.setDate(t.getDate() + 1);
    const [y, m, d] = toJalaliKey(t).split('-');
    return jalaliPartsToString(Number(y), Number(m), Number(d));
  })();
  const YESTERDAY = (() => {
    const t = new Date(NOW); t.setDate(t.getDate() - 1);
    const [y, m, d] = toJalaliKey(t).split('-');
    return jalaliPartsToString(Number(y), Number(m), Number(d));
  })();

  it('a later day is future regardless of time', () => {
    expect(isFutureDateTime(TOMORROW, '08:00', NOW)).toBe(true);   // earlier clock, later day
    expect(isFutureDateTime(TOMORROW, '23:59', NOW)).toBe(true);
  });

  it('today with a later minute is future', () => {
    expect(isFutureDateTime(TODAY, '14:06', NOW)).toBe(true);
    expect(isFutureDateTime(TODAY, '23:00', NOW)).toBe(true);
  });

  it('today with the CURRENT minute is NOT future (logging «الان»)', () => {
    expect(isFutureDateTime(TODAY, '14:05', NOW)).toBe(false);
  });

  it('today with an earlier minute is NOT future (logging the past)', () => {
    expect(isFutureDateTime(TODAY, '14:04', NOW)).toBe(false);
    expect(isFutureDateTime(TODAY, '08:00', NOW)).toBe(false);
  });

  it('yesterday is never future', () => {
    expect(isFutureDateTime(YESTERDAY, '23:59', NOW)).toBe(false);
  });

  it('an empty/invalid time is treated as 00:00 of that day', () => {
    expect(isFutureDateTime(TOMORROW, '', NOW)).toBe(true);
    expect(isFutureDateTime(TOMORROW, 'نامعتبر', NOW)).toBe(true);
    expect(isFutureDateTime(TODAY, '', NOW)).toBe(false); // 00:00 < 14:05
  });

  it('an invalid Jalali date is never future (fails closed → normal save)', () => {
    expect(isFutureDateTime('', '23:00', NOW)).toBe(false);
    expect(isFutureDateTime('1405/13/01', '23:00', NOW)).toBe(false);
  });

  it('works exactly at midnight of a future day', () => {
    expect(isFutureDateTime(TOMORROW, '00:00', NOW)).toBe(true);
  });
});
