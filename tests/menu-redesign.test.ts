import { describe, it, expect } from 'vitest';
import {
  COMPANY_MENUS, COMPANY_SLUGS, allMenuKeys, expandParentKeys, normalizeNavKey,
} from '@/lib/menu-catalog';
import { DEFAULT_MENU_ACCESS, resolveAllowedKeys } from '@/lib/access-config';

const PRIMARY_EXPECTED = [
  'sales-expert',        // ۱. داشبورد من
  'dashboard',           // ۲. داشبورد مدیریت
  'quick-activity',      // ۳. ثبت سریع فعالیت‌ها
  'quick-proforma',      // ۴. صدور سریع پیش‌فاکتور
  'sales-system-stages', // ۵. کاریز مراحل فروش
  'followup',            // ۶. پیگیری دوره‌ای
  'calls',               // ۷. تماس‌ها
];

// v2.50.0 (r75): the HOLDING was a pure oversight entity — no quick-proforma,
// no «اسناد فروش» group. v2.56.0 (r81) — REVERSED: the holding issues its
// own proformas (royal-indigo print template, user round 81), so its menu
// contract is identical to the other companies again.

describe('menu redesign (v2.34.0 §10) — daily-work primary menus', () => {
  it('leads EVERY company menu with the daily-work primaries in the user-specified order', () => {
    for (const slug of COMPANY_SLUGS) {
      const expected = PRIMARY_EXPECTED;
      const menus = COMPANY_MENUS[slug];
      const primaries = menus.filter((m) => m.group === 'primary').map((m) => m.key);
      expect(primaries, `primary order for ${slug}`).toEqual(expected);
      // primaries must physically be the FIRST entries
      expect(menus.slice(0, expected.length).map((m) => m.key)).toEqual(expected);
    }
  });

  it('keeps exactly one labeled separator: first secondary follows a primary', () => {
    for (const slug of COMPANY_SLUGS) {
      const menus = COMPANY_MENUS[slug];
      const groups = menus.map((m) => m.group);
      const firstSecondary = groups.indexOf('secondary');
      expect(firstSecondary, `first secondary index for ${slug}`).toBe(PRIMARY_EXPECTED.length);
      expect(groups[firstSecondary - 1]).toBe('primary');
    }
  });

  it('retires the duplicate «کاریز فروش» parent everywhere', () => {
    for (const slug of COMPANY_SLUGS) {
      expect(allMenuKeys(slug)).not.toContain('pipeline');
    }
  });

  it('maps legacy pipeline links to the stage kanban', () => {
    expect(normalizeNavKey('pipeline')).toBe('sales-system-stages');
    expect(normalizeNavKey('centers-list')).toBe('centers-list');
  });

  it('has unique PARENT keys and unique children per parent', () => {
    for (const slug of COMPANY_SLUGS) {
      const menus = COMPANY_MENUS[slug];
      const parentKeys = menus.map((m) => m.key);
      expect(new Set(parentKeys).size, `unique parents for ${slug}`).toBe(parentKeys.length);
      for (const m of menus) {
        if (!m.children) continue;
        const childKeys = m.children.map((c) => c.key);
        expect(new Set(childKeys).size, `unique children of ${m.key}`).toBe(childKeys.length);
      }
    }
  });

  it('deliberately dual-homes sales-system-stages (primary leaf + اسناد فروش child)', () => {
    // v2.34.0 §10: کاریز مراحل فروش was PROMOTED to a top-level item but
    // stays reachable inside its logical group for muscle-memory users.
    // v2.56.0 (r81): the holding joins the dual-home too — it has the
    // «اسناد فروش» group now (issuance unlocked, user round 81).
    for (const slug of COMPANY_SLUGS) {
      const menus = COMPANY_MENUS[slug];
      expect(menus.some((m) => m.key === 'sales-system-stages' && m.group === 'primary'), `${slug} primary leaf`).toBe(true);
      const group = menus.find((m) => m.key === 'sales-system');
      expect(group?.children?.some((c) => c.key === 'sales-system-stages'), `${slug} dual-home child`).toBe(true);
    }
  });

  it('keeps every legacy key reachable (no module disappears after the redesign)', () => {
    const legacyKeys = [
      'sales-expert', 'dashboard', 'sales-system', 'sales-system-stages', 'sales-proformas',
      'sales-invoices', 'sales-returns', 'mailbox', 'followup', 'calls', 'calls-log',
      'calls-history', 'calls-scheduled', 'ai-intelligence', 'ai-dashboard', 'centers-list',
      'centers-contacts', 'products-list', 'calendar', 'reports-sales', 'settings-general',
      'inventory-stock', 'inventory-movements',
    ];
    for (const slug of COMPANY_SLUGS) {
      const keys = allMenuKeys(slug);
      for (const k of legacyKeys) {
        // each legacy key must exist in at least the companies that had it —
        // check against the union to catch accidental drops
        expect(COMPANY_SLUGS.some((s) => allMenuKeys(s).includes(k)), `${k} vanished from every company`).toBe(true);
      }
      expect(keys.length, `${slug} menu size`).toBeGreaterThan(15);
    }
  });

  it('ships the انبارداری group with the hesabfa tab for ALL four companies', () => {
    for (const slug of COMPANY_SLUGS) {
      const keys = allMenuKeys(slug);
      expect(keys, `${slug} inventory`).toContain('inventory');
      expect(keys, `${slug} inventory-hesabfa`).toContain('inventory-hesabfa');
    }
  });
});

describe('menu redesign — permission gates', () => {
  it('grants the quick actions to sales_expert (holding issues too)', () => {
    for (const slug of COMPANY_SLUGS) {
      const allowed = resolveAllowedKeys(slug, 'sales_expert', 'standard', null) ?? [];
      expect(allowed).toContain('quick-activity');
      expect(allowed).toContain('sales-system-stages');
      // v2.56.0 (r81): the holding sales experts issue documents now
      // (the r75 oversight-only exception is reversed).
      expect(allowed, `${slug} sales_expert can issue`).toContain('quick-proforma');
    }
  });

  it('hides «داشبورد مدیریت» from sales_expert (only their own dashboard)', () => {
    for (const slug of COMPANY_SLUGS) {
      const allowed = resolveAllowedKeys(slug, 'sales_expert', 'standard', null) ?? [];
      expect(allowed).not.toContain('dashboard');
    }
  });

  it('gives warehouse NO quick-proforma (no sales-system world)', () => {
    for (const slug of COMPANY_SLUGS) {
      const allowed = resolveAllowedKeys(slug, 'warehouse', 'standard', null) ?? [];
      expect(allowed).toContain('quick-activity');
      expect(allowed).not.toContain('quick-proforma');
    }
  });

  it('full access (admin/no jobTitle) sees all seven primaries', () => {
    const allowed = resolveAllowedKeys('bazargani', null, 'admin', null);
    expect(allowed).toBeNull(); // null = full access
  });

  it('expandParentKeys still expands secondary groups (access customization)', () => {
    const expanded = expandParentKeys('bazargani', ['inventory']);
    expect(expanded).toContain('inventory-hesabfa');
    expect(expanded).toContain('inventory-stock');
  });

  it('DEFAULT_MENU_ACCESS matrix is coherent with the new catalog', () => {
    for (const [title, companies] of Object.entries(DEFAULT_MENU_ACCESS)) {
      for (const [slug, keys] of Object.entries(companies)) {
        const catalog = new Set(allMenuKeys(slug as keyof typeof COMPANY_MENUS));
        for (const k of keys) {
          expect(catalog.has(k), `${title}/${slug}: granted key ${k} missing from catalog`).toBe(true);
        }
      }
    }
  });
});
