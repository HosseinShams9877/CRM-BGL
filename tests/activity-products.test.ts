// Unit tests for the quick-activity product tags (v2.34.9).
// Pure module — no DB, no Next.js imports.
import { describe, it, expect } from 'vitest';
import {
  sanitizeActivityProducts,
  parseActivityProducts,
  MAX_ACTIVITY_PRODUCTS,
  ACTIVITY_PRODUCT_NAME_MAX,
} from '../src/lib/activity-products';

describe('sanitizeActivityProducts', () => {
  it('serializes a clean array of {id,name}', () => {
    expect(sanitizeActivityProducts([{ id: 'p1', name: 'پالس اکسیژن متر' }]))
      .toBe('[{"id":"p1","name":"پالس اکسیژن متر"}]');
  });

  it('accepts a JSON-encoded string (multipart form field)', () => {
    expect(sanitizeActivityProducts('[{"id":"p1","name":"A"}]'))
      .toBe('[{"id":"p1","name":"A"}]');
  });

  it('returns "[]" for non-array / garbage input', () => {
    for (const bad of [undefined, null, '', 'not json', 42, {}, { id: 'x' }, '[]][', true]) {
      expect(sanitizeActivityProducts(bad), String(bad)).toBe('[]');
    }
  });

  it('drops items missing id or name and trims whitespace', () => {
    expect(sanitizeActivityProducts([
      { id: '  p1  ', name: ' A ' },
      { id: '', name: 'B' },
      { id: 'p3' },
      { name: 'D' },
      'junk',
      null,
    ])).toBe('[{"id":"p1","name":"A"}]');
  });

  it('drops over-long ids and names', () => {
    expect(sanitizeActivityProducts([{ id: 'x'.repeat(65), name: 'A' }])).toBe('[]');
    expect(sanitizeActivityProducts([{ id: 'p1', name: 'x'.repeat(ACTIVITY_PRODUCT_NAME_MAX + 1) }])).toBe('[]');
  });

  it('de-duplicates by id (first wins)', () => {
    expect(sanitizeActivityProducts([
      { id: 'p1', name: 'اول' },
      { id: 'p1', name: 'دوم' },
    ])).toBe('[{"id":"p1","name":"اول"}]');
  });

  it('caps the list at MAX_ACTIVITY_PRODUCTS', () => {
    const many = Array.from({ length: MAX_ACTIVITY_PRODUCTS + 7 }, (_, i) => ({ id: `p${i}`, name: `n${i}` }));
    const out = JSON.parse(sanitizeActivityProducts(many)) as Array<{ id: string }>;
    expect(out).toHaveLength(MAX_ACTIVITY_PRODUCTS);
    expect(out[0].id).toBe('p0');
    expect(out[MAX_ACTIVITY_PRODUCTS - 1].id).toBe(`p${MAX_ACTIVITY_PRODUCTS - 1}`);
  });
});

describe('parseActivityProducts', () => {
  it('round-trips what sanitize writes', () => {
    const src = [{ id: 'p1', name: 'پالس اکسیژن متر' }, { id: 'p2', name: 'دستگاه BP-500' }];
    expect(parseActivityProducts(sanitizeActivityProducts(src))).toEqual(src);
  });

  it('returns [] for empty / null / malformed input', () => {
    for (const bad of [undefined, null, '', '   ', 'not json', '{}', '{"id":"p1"}', '42', 'null']) {
      expect(parseActivityProducts(bad), String(bad)).toEqual([]);
    }
  });

  it('skips malformed entries inside a valid array', () => {
    expect(parseActivityProducts('[{"id":"p1","name":"A"},{"id":"p2"},{"name":"C"},"x",null]'))
      .toEqual([{ id: 'p1', name: 'A' }]);
  });
});
