// ════════════════════════════════════════════════════════════════
// center-search.test.ts — v2.34.11 (round 58) unit tests for the
// shared Persian search normalization used by the centers list,
// the quick-activity/quick-proforma combobox and the contacts search.
//
// The round-58 defects these lock down:
//   • ZWNJ used to be DELETED on the query side but stored keys use
//     ZWNJ→space — a query typed «ام‌البنین» collapsed to «امالبنین»
//     and could never match the stored «ام البنین».
//   • The combobox skipped searchKey/province entirely.
//   • buildSearchKey must stay byte-identical to the r55 backfill so
//     API-written and backfilled rows are interchangeable.
// ════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { normalizePersian, buildSearchKey, centerSearchOr } from '@/lib/center-search';

describe('normalizePersian — ZWNJ as a word separator (round 58)', () => {
  it('turns ZWNJ into a space so query and stored forms converge', () => {
    expect(normalizePersian('ام‌البنین')).toBe('ام البنین');
    expect(normalizePersian('خاتم‌الانبیا')).toBe('خاتم الانبیا');
  });

  it('a space-typed query and a ZWNJ-typed query normalize identically', () => {
    expect(normalizePersian('مرکز ام البنین')).toBe(normalizePersian('مرکز ام‌البنین'));
  });

  it('ZWJ is treated as a separator too', () => {
    expect(normalizePersian('سید\u200dمحمد')).toBe('سید محمد');
  });

  it('collapses runs of whitespace (incl. produced by ZWNJ→space)', () => {
    expect(normalizePersian('  بیمارستان   ولیعصر ')).toBe('بیمارستان ولیعصر');
    expect(normalizePersian('آزمایشگاه\u200c\u200cتشخیص')).toBe('آزمایشگاه تشخیص');
  });
});

describe('normalizePersian — character unification', () => {
  it('maps Arabic ی/ي to Persian ی', () => {
    expect(normalizePersian('كیان' + 'يگانه')).toBe('کیانیگانه');
  });

  it('maps Arabic ك to Persian ک', () => {
    expect(normalizePersian('كلینیک')).toBe('کلینیک');
  });

  it('maps ة to ه', () => {
    expect(normalizePersian('داروخانهة')).toBe('داروخانهه');
  });

  it('lowercases Latin text (phone/model names)', () => {
    expect(normalizePersian('Model X-200')).toBe('model x-200');
  });

  it('leaves digits and separators intact', () => {
    expect(normalizePersian('021-1234567')).toBe('021-1234567');
  });
});

describe('buildSearchKey — byte-identical to the r55 backfill', () => {
  it('joins name + province + city + phone + mobile + address, skipping nulls', () => {
    expect(
      buildSearchKey({
        name: 'مرکز ام‌البنین',
        province: 'مازندران',
        city: 'ساری',
        phone: '11-42193873',
        mobile: null,
        address: undefined,
      }),
    ).toBe('مرکز ام البنین مازندران ساری 11-42193873');
  });

  it('an all-null row still yields the normalized name', () => {
    expect(buildSearchKey({ name: 'کلینیک كوثر' })).toBe('کلینیک کوثر');
  });

  it('ZWNJ-spelled and space-spelled names produce the SAME key', () => {
    const zwnj = buildSearchKey({ name: 'بیمارستان خاتم‌الانبیا خلیل آباد' });
    const space = buildSearchKey({ name: 'بیمارستان خاتم الانبیا خلیل آباد' });
    expect(zwnj).toBe(space);
  });
});

describe('centerSearchOr — shared OR-filter shape', () => {
  it('matches through searchKey, name, city and province with norm + raw', () => {
    const or = centerSearchOr('مرکز');
    const fields = or.map((c) => Object.keys(c)[0]);
    expect(fields).toEqual(['searchKey', 'name', 'name', 'city', 'city', 'province', 'province']);
    // normalized form first so ZWNJ-typed queries hit the stored keys
    expect(or[0]).toEqual({ searchKey: { contains: 'مرکز' } });
  });

  it('raw keeps the user’s exact text (fallback for un-normalized columns)', () => {
    const or = centerSearchOr('ام‌البنین');
    expect(or).toContainEqual({ name: { contains: 'ام‌البنین' } });
    expect(or).toContainEqual({ searchKey: { contains: 'ام البنین' } });
  });

  it('a digit-only query (phone) reaches searchKey where phone text lives', () => {
    const or = centerSearchOr('42193873');
    expect(or[0]).toEqual({ searchKey: { contains: '42193873' } });
  });
});
