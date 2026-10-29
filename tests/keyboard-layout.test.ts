// ════════════════════════════════════════════════════════════════
// keyboard-layout.test.ts — v2.35.1 (round 61) unit tests for the
// Latin→Persian keyboard-layout auto-detection.
//
// The user's report this locks down: searching «بیمارستان ساسان»
// while the OS keyboard is on the ENGLISH layout types «shk» /
// «shshk» (س→S, ا→H, ن→K) and the search used to return nothing.
// Search surfaces now OR-match the query's Persian-layout twins
// (base + shift-aware «آ» from uppercase H).
// ════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  latinToPersianLayout,
  latinToPersianLayoutShiftAware,
  detectLayoutFix,
  hasPersianScript,
  searchVariants,
} from '@/lib/keyboard-layout';
import { centerSearchOr, normalizePersian } from '@/lib/center-search';

describe('latinToPersianLayout — ISIRI 9147 base map', () => {
  it('the reported case: «shk» is «سان» typed on the English layout', () => {
    expect(latinToPersianLayout('shk')).toBe('سان');
  });

  it('«shshk» recovers «ساسان»', () => {
    expect(latinToPersianLayout('shshk')).toBe('ساسان');
  });

  it('a full center name round-trips: «fdlhvsjhk shshk» → «بیمارستان ساسان»', () => {
    expect(latinToPersianLayout('fdlhvsjhk shshk')).toBe('بیمارستان ساسان');
  });

  it('is case-insensitive (CAPS/Capitalized queries map to the same letters)', () => {
    expect(latinToPersianLayout('SHK')).toBe('سان');
    expect(latinToPersianLayout('Shk')).toBe('سان');
  });

  it('passes unmapped chars through (digits, symbols, spaces)', () => {
    expect(latinToPersianLayout('shk 2')).toBe('سان 2');
    expect(latinToPersianLayout('fdlhvsjhk-2')).toBe('بیمارستان-2');
  });

  it('maps the punctuation keys too (و ک گ ج چ)', () => {
    // «ستو» = س(s) ت(j) و(,) — و lives on the comma key
    expect(latinToPersianLayout('sj,')).toBe('ستو');
    expect(latinToPersianLayout('kd')).toBe('نی');
    expect(latinToPersianLayout('[hl')).toBe('جام');
    expect(latinToPersianLayout("'g")).toBe('گل');
  });
});

describe('latinToPersianLayoutShiftAware — «آ» from uppercase H', () => {
  it('«Hrhd» → «آقای» (the greeting stored in half the contact rows)', () => {
    expect(latinToPersianLayoutShiftAware('Hrhd')).toBe('آقای');
  });

  it('«Hclhda\'hi lhs;» → «آزمایشگاه ماسک» (آ opens lab names too)', () => {
    expect(latinToPersianLayoutShiftAware("Hclhda'hi lhs;")).toBe('آزمایشگاه ماسک');
  });

  it('lowercase h still maps to plain ا', () => {
    expect(latinToPersianLayoutShiftAware('hrhd')).toBe('اقای');
  });

  it('non-H uppercase letters fall back to the base map', () => {
    expect(latinToPersianLayoutShiftAware('SHK')).toBe('سآن'); // H→آ; base twin «سان» still searched
    expect(latinToPersianLayoutShiftAware('Pldn')).toBe('حمید'); // P (Shift+p) has no shifted Persian letter
  });
});

describe('hasPersianScript', () => {
  it('detects Persian letters (incl. Arabic and presentation forms)', () => {
    expect(hasPersianScript('مرکز')).toBe(true);
    expect(hasPersianScript('كx')).toBe(true); // Arabic ك — layout was right
  });

  it('Latin/digit/symbol text is not Persian script', () => {
    expect(hasPersianScript('shk')).toBe(false);
    expect(hasPersianScript('42193873')).toBe(false);
    expect(hasPersianScript('')).toBe(false);
  });
});

describe('searchVariants — shared consumer helper', () => {
  it('a lowercase Latin query yields [raw, base twin]', () => {
    expect(searchVariants('shk')).toEqual(['shk', 'سان']);
  });

  it('a mixed-case query with H yields BOTH twins («آقای» case)', () => {
    expect(searchVariants('Hrhd')).toEqual(['Hrhd', 'اقای', 'آقای']);
  });

  it('a uniform-CAPS query yields base + shift twins (آ from H)', () => {
    expect(searchVariants('SHK')).toEqual(['SHK', 'سان', 'سآن']);
  });

  it('a Persian query yields just the raw text (no behavior change)', () => {
    expect(searchVariants('مرکز')).toEqual(['مرکز']);
    expect(searchVariants('42193873')).toEqual(['42193873']);
  });
});

describe('detectLayoutFix — the DISPLAY twin', () => {
  it('lowercase and uniform-CAPS queries show the base twin', () => {
    expect(detectLayoutFix('shk')).toBe('سان');
    expect(detectLayoutFix('SHK')).toBe('سان'); // caps-lock reads as base letters
    expect(detectLayoutFix('  shshk ')).toBe('ساسان'); // trims first
  });

  it('mixed-case queries show the shift-aware twin (آ)', () => {
    expect(detectLayoutFix('Hrhd')).toBe('آقای');
  });

  it('returns null when the query already contains Persian script', () => {
    expect(detectLayoutFix('بیمارستان')).toBeNull();
    expect(detectLayoutFix('مرکز sasan')).toBeNull(); // mixed → user typed deliberately
  });

  it('returns null for text with no mappable Latin letters', () => {
    expect(detectLayoutFix('42193873')).toBeNull(); // phone query path untouched
    expect(detectLayoutFix('')).toBeNull();
    expect(detectLayoutFix('   ')).toBeNull();
    expect(detectLayoutFix('---')).toBeNull();
  });
});

describe('centerSearchOr — layout twins join the OR set (round 61)', () => {
  it('«shk» also matches searchKey/name/city/province with «سان»', () => {
    const or = centerSearchOr('shk');
    expect(or).toContainEqual({ searchKey: { contains: 'سان' } });
    expect(or).toContainEqual({ name: { contains: 'سان' } });
    expect(or).toContainEqual({ city: { contains: 'سان' } });
    expect(or).toContainEqual({ province: { contains: 'سان' } });
  });

  it('«Hrhd» matches BOTH «اقای» and «آقای»', () => {
    const or = centerSearchOr('Hrhd');
    expect(or).toContainEqual({ searchKey: { contains: 'اقای' } });
    expect(or).toContainEqual({ searchKey: { contains: 'آقای' } });
  });

  it('the original Latin text stays searchable (codes / Latin names)', () => {
    const or = centerSearchOr('shk');
    expect(or).toContainEqual({ searchKey: { contains: 'shk' } });
    expect(or).toContainEqual({ name: { contains: 'shk' } });
  });

  it('Persian queries keep the exact round-58 seven-clause shape', () => {
    const or = centerSearchOr('مرکز');
    expect(or.map((c) => Object.keys(c)[0])).toEqual(
      ['searchKey', 'name', 'name', 'city', 'city', 'province', 'province'],
    );
  });

  it('the twins pass the same normalizePersian as stored keys', () => {
    // «fdlhvsjhk» → «بیمارستان» — normalized identically for contains
    const or = centerSearchOr('fdlhvsjhk');
    expect(or).toContainEqual({ searchKey: { contains: normalizePersian('بیمارستان') } });
  });
});
