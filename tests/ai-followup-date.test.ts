import { describe, it, expect } from 'vitest';
import {
  parsePersianRelativeDate,
  findFollowupDateInTexts,
  normalizeDigits,
} from '../src/lib/ai/followup-date';

// Fixed reference: Thursday 2026-08-27 (1405-06-05, پنجشنبه)
const NOW = new Date(2026, 7, 27, 10, 0, 0);

describe('v2.27.0 — Persian relative date parser (AI follow-up extraction)', () => {
  it('parses امروز / فردا / پس‌فردا', () => {
    expect(parsePersianRelativeDate('امروز تماس بگیرید', NOW)?.rule).toBe('امروز');
    expect(parsePersianRelativeDate('فردا هم می‌آیم', NOW)?.rule).toBe('فردا');
    const pasfarda = parsePersianRelativeDate('پس‌فردا تماس بگیرید', NOW);
    expect(pasfarda?.rule).toBe('پس‌فردا');
    expect(pasfarda?.date.getDate()).toBe(29); // 27 + 2
    // ZWNJ variant (پس فردا with space)
    expect(parsePersianRelativeDate('پس فردا بفرستید', NOW)?.rule).toBe('پس‌فردا');
  });

  it('parses N روز بعد with Persian and ASCII digits', () => {
    const a = parsePersianRelativeDate('۳ روز بعد خبر بدهید', NOW);
    expect(a?.date.getDate()).toBe(30);
    const b = parsePersianRelativeDate('تا 5 روز دیگر بررسی می‌کنیم', NOW);
    expect(b?.date.getDate()).toBe(1); // rolls into September
    expect(b?.date.getMonth()).toBe(8); // September (0-based)
  });

  it('parses week expressions', () => {
    expect(parsePersianRelativeDate('هفته بعد تماس بگیر', NOW)?.date.getDate()).toBe(3); // 27+7 → Sep 3
    expect(parsePersianRelativeDate('دو هفته بعد', NOW)?.date.getDate()).toBe(10);
    const three = parsePersianRelativeDate('3 هفته دیگر', NOW);
    expect(three?.date.getDate()).toBe(17);
  });

  it('parses month expressions including «اول ماه بعد»', () => {
    const nextMonth = parsePersianRelativeDate('ماه بعد دوباره صحبت کنیم', NOW);
    expect(nextMonth?.date.getMonth()).toBe(8); // September
    const firstOfNext = parsePersianRelativeDate('اول ماه بعد اعلام نتیجه می‌دهیم', NOW);
    expect(firstOfNext?.date.getDate()).toBe(1);
    expect(firstOfNext?.date.getMonth()).toBe(8);
    expect(parsePersianRelativeDate('سر ماه', NOW)?.date.getDate()).toBe(1);
    expect(parsePersianRelativeDate('نیم‌ماه دیگر', NOW)?.date.getDate()).toBe(11); // 27+15 → Sep 11
  });

  it('parses weekday names to the NEXT occurrence (Persian week starts Saturday)', () => {
    // NOW is Thursday 2026-08-27. Next شنبه (Saturday) = 2026-08-29.
    const sat = parsePersianRelativeDate('شنبه صبح تماس بگیرید', NOW);
    expect(sat?.date.getDate()).toBe(29);
    expect(sat?.date.getDay()).toBe(6); // Saturday
    // Next دوشنبه (Monday) = 2026-08-31
    const mon = parsePersianRelativeDate('روز دوشنبه مراجعه می‌کنیم', NOW);
    expect(mon?.date.getDate()).toBe(31);
    // «جمعه» — Friday is TOMORROW (28th)
    const fri = parsePersianRelativeDate('جمعه می‌آید', NOW);
    expect(fri?.date.getDate()).toBe(28);
  });

  it('parses explicit Jalali dates like ۱۵ اسفند', () => {
    const d = parsePersianRelativeDate('تا ۱۵ اسفند فرصت داریم', NOW);
    expect(d).not.toBeNull();
    // 15 اسفند 1405 = 2027-03-06 (astronomical table)
    expect(d?.date.getUTCFullYear()).toBe(2027);
    expect(d?.date.getUTCMonth()).toBe(2); // March
    expect(d?.date.getUTCDate()).toBe(6);
  });

  it('returns null for text without any date expression — never guesses', () => {
    expect(parsePersianRelativeDate('قیمت‌ها را بفرستید', NOW)).toBeNull();
    expect(parsePersianRelativeDate('', NOW)).toBeNull();
    expect(parsePersianRelativeDate('در مورد گارانتی صحبت کنیم', NOW)).toBeNull();
  });

  it('normalizes Persian and Arabic digits', () => {
    expect(normalizeDigits('۱۲۳٤٥٦')).toBe('123456');
  });

  it('findFollowupDateInTexts scans in priority order', () => {
    const found = findFollowupDateInTexts(['اول ماه بعد امضا می‌کنیم', 'بحث‌های دیگری...'], NOW);
    expect(found?.rule).toBe('اول ماه بعد');
    expect(findFollowupDateInTexts([null, undefined, 'بدون تاریخ'], NOW)).toBeNull();
  });
});
