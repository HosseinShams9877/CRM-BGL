import { describe, it, expect } from 'vitest';
import {
  NavFocus, encodeFocus, decodeFocus, buildNavQuery, parseNavSearch,
} from '@/lib/nav-url';

describe('nav-url — real-URL contract (v2.34.0 §9)', () => {
  it('round-trips a person focus', () => {
    const f: NavFocus = { type: 'person', id: 'CC-C0140', label: 'حمیدی' };
    const enc = encodeFocus(f);
    expect(enc).toBe(`person:CC-C0140:${encodeURIComponent('حمیدی')}`);
    expect(decodeFocus(enc)).toEqual(f);
  });

  it('round-trips a center focus without label', () => {
    const f: NavFocus = { type: 'center', id: 'C0001' };
    const enc = encodeFocus(f);
    expect(decodeFocus(enc)).toEqual(f);
  });

  it('rejects unknown focus types and junk', () => {
    expect(decodeFocus('')).toBeNull();
    expect(decodeFocus('foo:1')).toBeNull();
    expect(decodeFocus(':x')).toBeNull();
  });

  it('builds a query with company+module+focus and parses it back', () => {
    const q = buildNavQuery({ company: 'aria', module: 'centers-contacts', focus: { type: 'person', id: 'P1', label: 'علی' } });
    expect(q.startsWith('?')).toBe(true);
    const state = parseNavSearch(q);
    expect(state.company).toBe('aria');
    expect(state.module).toBe('centers-contacts');
    expect(state.focus).toEqual({ type: 'person', id: 'P1', label: 'علی' });
  });

  it('omits the default company (holding) for clean shareable URLs', () => {
    const q = buildNavQuery({ company: 'holding', module: 'dashboard', focus: null });
    expect(q).not.toContain('company=');
    const state = parseNavSearch(q);
    expect(state.company).toBeNull();
    expect(state.module).toBe('dashboard');
  });

  it('parses a raw search string with a leading ?', () => {
    const state = parseNavSearch('?company=bazargani&module=quick-activity');
    expect(state.company).toBe('bazargani');
    expect(state.module).toBe('quick-activity');
    expect(state.focus).toBeNull();
  });

  it('keeps focus ids with colons impossible (ids are slug-safe)', () => {
    // ids never contain ':' by construction (cuid / CC- / C0…), but a
    // malicious label must not corrupt the type/id split
    const f: NavFocus = { type: 'person', id: 'X1', label: 'a:b:c' };
    const back = decodeFocus(encodeFocus(f));
    expect(back?.type).toBe('person');
    expect(back?.id).toBe('X1');
    expect(back?.label).toBe('a:b:c');
  });
});
