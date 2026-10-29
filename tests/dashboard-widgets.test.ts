// ════════════════════════════════════════════════════════════
// DASHBOARD WIDGETS — pure unit tests (v2.43.0)
// Catalog integrity, save-path validation, forward-compatible
// resolution and default fallback semantics.
// ════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  WIDGET_KEYS, WIDGET_CATALOG, validateWidgets, defaultWidgets,
  resolveWidgets, visibleWidgetKeys, widgetTitle, type UserWidget,
} from '../src/lib/dashboard-widgets';

describe('catalog integrity', () => {
  it('every catalog key is a known WidgetKey and unique', () => {
    const keys = WIDGET_CATALOG.map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(WIDGET_KEYS).toContain(k);
    expect(WIDGET_CATALOG.length).toBe(WIDGET_KEYS.length);
  });
  it('widgetTitle maps keys to Persian titles', () => {
    expect(widgetTitle('kpi')).toBe('شاخص‌های کلیدی');
    expect(widgetTitle('schedule')).toBe('برنامهٔ روزانه');
  });
});

describe('validateWidgets (save path)', () => {
  it('accepts a valid subset in any order', () => {
    const v = validateWidgets([
      { key: 'schedule', visible: true },
      { key: 'kpi', visible: false },
    ]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.widgets).toHaveLength(2);
  });
  it('rejects unknown / duplicate / empty / all-hidden layouts', () => {
    expect(validateWidgets([{ key: 'weather', visible: true }]).ok).toBe(false);
    expect(validateWidgets([
      { key: 'kpi', visible: true }, { key: 'kpi', visible: true },
    ]).ok).toBe(false);
    expect(validateWidgets([]).ok).toBe(false);
    expect(validateWidgets('nope').ok).toBe(false);
    expect(validateWidgets([
      { key: 'kpi', visible: false }, { key: 'schedule', visible: false },
    ]).ok).toBe(false);
  });
  it('visible defaults to true when omitted', () => {
    const v = validateWidgets([{ key: 'kpi' }]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.widgets[0].visible).toBe(true);
  });
});

describe('resolveWidgets (render path)', () => {
  it('null / empty → system defaults, all visible in catalog order', () => {
    const d = resolveWidgets(null);
    expect(d.map((w) => w.key)).toEqual([...WIDGET_KEYS]);
    expect(d.every((w) => w.visible)).toBe(true);
    expect(resolveWidgets([])).toEqual(defaultWidgets());
  });
  it('preserves saved order and visibility (missing keys appended after)', () => {
    const saved: UserWidget[] = [
      { key: 'schedule', visible: true },
      { key: 'kpi', visible: true },
      { key: 'pipeline', visible: false },
    ];
    const resolved = resolveWidgets(saved).map((w) => w.key);
    // saved order first, then the unlisted catalog keys appended (forward-compat)
    expect(resolved.slice(0, 3)).toEqual(['schedule', 'kpi', 'pipeline']);
    expect(resolved).toHaveLength(WIDGET_KEYS.length);
    // hidden pipeline stays hidden; appended keys appear after the saved ones
    expect(visibleWidgetKeys(saved).slice(0, 2)).toEqual(['schedule', 'kpi']);
    expect(visibleWidgetKeys(saved)).not.toContain('pipeline');
    expect(visibleWidgetKeys(saved)).toHaveLength(WIDGET_KEYS.length - 1);
  });
  it('forward-compat: unknown saved keys dropped, new catalog keys appended visible', () => {
    const saved = [
      { key: 'old_removed_widget', visible: true },
      { key: 'kpi', visible: true },
    ] as Array<{ key: string; visible: boolean }>;
    const r = resolveWidgets(saved as UserWidget[]);
    expect(r.some((w) => (w.key as string) === 'old_removed_widget')).toBe(false);
    expect(r.some((w) => w.key === 'schedule' && w.visible)).toBe(true); // appended
  });
  it('all-hidden (corrupted) saved layout falls back to defaults, never a blank page', () => {
    const saved = WIDGET_KEYS.map((key) => ({ key, visible: false }));
    expect(visibleWidgetKeys(saved)).toEqual([...WIDGET_KEYS]);
  });
  it('visibleWidgetKeys(null) → all keys', () => {
    expect(visibleWidgetKeys(null)).toEqual([...WIDGET_KEYS]);
  });
});
