// ════════════════════════════════════════════════════════════════
// jalali-date-picker.test.ts — v2.36.0 (round 62) unit tests for
// the Gregorian-ISO ↔ Jalali-string bridges used by the shared
// JalaliDatePicker (popup Shamsi calendar, click-to-select).
//
// The picker replaces every TYPED date field in the project; the
// call-log form keeps its 'YYYY-MM-DD' state so its API contract
// is unchanged — these bridges guarantee the two formats can never
// disagree, and that TODAY (local clock) round-trips exactly.
// ════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  jalaliStringToGregorianIso,
  gregorianIsoToJalaliString,
  parseJalaliDate,
  toJalaliKey,
  jalaliMonthLength,
  gregorianToJalali,
} from '@/lib/jalali';

describe('jalaliStringToGregorianIso — Jalali string → ISO bridge', () => {
  it('converts a plain Jalali date (verified against the astronomical table)', () => {
    // 1405/06/04 ↔ 2026-08-26 is the known-good pair from v2.16.0
    expect(jalaliStringToGregorianIso('1405/06/04')).toBe('2026-08-26');
  });

  it('zero-pads month and day on both sides', () => {
    expect(jalaliStringToGregorianIso('1405/01/01')).toBe('2026-03-21');
  });

  it('accepts Persian digits typed by hand (parseJalaliDate semantics)', () => {
    expect(jalaliStringToGregorianIso('۱۴۰۵/۰۶/۰۴')).toBe('2026-08-26');
  });

  it('accepts dash separators too', () => {
    expect(jalaliStringToGregorianIso('1405-6-4')).toBe('2026-08-26');
  });

  it('returns "" for invalid dates (32nd day, month 13, garbage)', () => {
    expect(jalaliStringToGregorianIso('1405/07/31')).toBe(''); // مرداد has 30 days
    expect(jalaliStringToGregorianIso('1405/13/01')).toBe('');
    expect(jalaliStringToGregorianIso('')).toBe('');
    expect(jalaliStringToGregorianIso('سلام')).toBe('');
  });

  it('handles the leap-year month اسفند correctly', () => {
    // 1403 is a leap Jalali year → اسفند has 30 days
    expect(jalaliMonthLength(1403, 12)).toBe(30);
    expect(jalaliStringToGregorianIso('1403/12/30')).toBe('2025-03-20');
    // 1404 is NOT leap → 30th of اسفند must be rejected
    expect(jalaliMonthLength(1404, 12)).toBe(29);
    expect(jalaliStringToGregorianIso('1404/12/30')).toBe('');
  });
});

describe('gregorianIsoToJalaliString — ISO → Jalali string bridge', () => {
  it('converts the known-good pair back', () => {
    expect(gregorianIsoToJalaliString('2026-08-26')).toBe('1405/06/04');
  });

  it('round-trips with jalaliStringToGregorianIso for a whole year', () => {
    // walk Farvardin 1 → end of Esfand of 1405 through both bridges
    let iso = jalaliStringToGregorianIso('1405/01/01');
    const days = 365; // 1405 is not a leap year
    for (let i = 0; i < days; i++) {
      const back = gregorianIsoToJalaliString(iso);
      expect(back).not.toBe('');
      const nextIso = jalaliStringToGregorianIso(back);
      expect(nextIso).toBe(iso); // no drift
      // advance one day via Date (noon-anchored, no TZ edge)
      const d = new Date(`${iso}T12:00:00`);
      d.setDate(d.getDate() + 1);
      iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  });

  it('returns "" for garbage / partial ISO strings', () => {
    expect(gregorianIsoToJalaliString('')).toBe('');
    expect(gregorianIsoToJalaliString('2026')).toBe('');
    expect(gregorianIsoToJalaliString('not-a-date')).toBe('');
  });

  it('accepts a full ISO timestamp by matching the date prefix', () => {
    expect(gregorianIsoToJalaliString('2026-08-26T09:30:00.000Z')).toBe('1405/06/04');
  });
});

describe('today round-trip — the sales-calls default', () => {
  it("local today → Jalali → ISO is exactly today's local date", () => {
    const now = new Date();
    const jalaliToday = (() => {
      const [jy, jm, jd] = gregorianToJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
      return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
    })();
    const iso = jalaliStringToGregorianIso(jalaliToday);
    const localIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(iso).toBe(localIso);
    expect(gregorianIsoToJalaliString(iso)).toBe(jalaliToday);
    expect(jalaliToday.replace(/\//g, '-')).toBe(toJalaliKey()); // same local day as the picker's «امروز» key
  });
});

describe('parseJalaliDate — what the picker feeds the consumers', () => {
  it('parses every value the picker can emit (YYYY/MM/DD)', () => {
    expect(parseJalaliDate('1405/06/15')).toEqual([1405, 6, 15]);
    expect(parseJalaliDate('1405/12/29')).toEqual([1405, 12, 29]);
  });

  it('rejects out-of-range components', () => {
    expect(parseJalaliDate('1405/00/10')).toBeNull();
    expect(parseJalaliDate('999/01/01')).toBeNull();
    expect(parseJalaliDate('1405/01/00')).toBeNull();
  });
});
