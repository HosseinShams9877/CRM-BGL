// ════════════════════════════════════════════════════════════
// ACCESS CONFIG — job-title registry defaults + per-company
// menu-access matrix defaults + resolution helpers.
// Pure module (no DB, no React) — safe to import on client & server.
//
// Model:
//   User.role      → base system role (admin/finance/production/standard)
//                    → drives ALL backend API permissions (unchanged).
//   User.jobTitle  → job-title key from the registry
//                    → drives sidebar menu visibility per company.
//   Matrix[company][jobTitle] = array of allowed menu keys
//                    (parents AND children). null/undefined → full access.
// ════════════════════════════════════════════════════════════

import { CompanySlug, COMPANY_MENUS, expandParentKeys } from './menu-catalog';
import { getCanonicalRole } from './roles';

// ── Job titles ─────────────────────────────────────────────
export interface JobTitle {
  key: string;          // latin slug, stored on User.jobTitle
  label: string;        // فارسی — displayed everywhere
  baseRole: string;     // admin | finance | production | standard
  desc?: string;        // توضیح اختیارات
  isSystem?: boolean;   // system titles cannot be deleted / key immutable
}

export const BASE_ROLES: { key: string; label: string; desc: string }[] = [
  { key: 'admin', label: 'مدیر سیستم', desc: 'دسترسی کامل به همهٔ بخش‌ها، مدیریت کاربران و تنظیمات' },
  { key: 'finance', label: 'واحد مالی', desc: 'کارتابل حسابداری، صورت‌حساب‌ها و اسناد همهٔ کاربران' },
  { key: 'production', label: 'واحد تولید', desc: 'فضای تولید، انبار و درخواست‌های خرید' },
  { key: 'standard', label: 'کاربر عادی', desc: 'دسترسی‌های عملیاتی پایه (فروش، مراکز، تقویم)' },
];

/** Built-in job titles. Admin can extend this registry from the panel. */
export const DEFAULT_JOB_TITLES: JobTitle[] = [
  { key: 'admin', label: 'مدیر سیستم', baseRole: 'admin', isSystem: true, desc: 'دسترسی کامل به همهٔ بخش‌ها + مدیریت کاربران و تنظیمات' },
  { key: 'finance', label: 'کارشناس مالی', baseRole: 'finance', isSystem: true, desc: 'کارتابل حسابداری، صورت‌حساب‌ها، اسناد همهٔ کاربران (بدون ویرایش مراکز)' },
  { key: 'production', label: 'واحد تولید', baseRole: 'production', isSystem: true, desc: 'فضای تولید، انبار و درخواست‌های خرید' },
  { key: 'standard', label: 'کاربر عادی', baseRole: 'standard', isSystem: true, desc: 'کارشناس فروش: مراکز، اسناد خودش، تقویم، پیگیری و گزارش‌های پایه' },
  { key: 'sales_expert', label: 'کارشناس فروش', baseRole: 'standard', desc: 'داشبورد شخصی، اسناد فروش، کاریز، پیگیری، تماس‌ها، مراکز و تقویم' },
  { key: 'collections', label: 'کارشناس وصول مطالبات', baseRole: 'standard', desc: 'تمرکز بر وصول مطالبات، اسناد مالی و اطلاعات مراکز' },
  { key: 'sales_support', label: 'پشتیبان فروش', baseRole: 'standard', desc: 'پشتیبانی تیم فروش: تماس‌ها، مراکز، تقویم و گزارش‌ها' },
  { key: 'warehouse', label: 'انباردار', baseRole: 'standard', desc: 'موجودی و حرکت کالا، ارسال بار و گزارش‌های انبار' },
  { key: 'clerk', label: 'کارپرداز', baseRole: 'standard', desc: 'اسناد اداری، وصول مطالبات، صورت‌حساب و تقویم' },
  { key: 'mail_dispatch', label: 'کارشناس مراسلات', baseRole: 'standard', desc: 'ارسال و پیگیری مراسلات، تقویم و اطلاعات مراکز' },
];

export function isValidJobTitleKey(key: string): boolean {
  return /^[a-z][a-z0-9_]{2,29}$/.test(key);
}

// ── Menu access matrix ─────────────────────────────────────
export type MenuAccessMatrix = Record<string, Record<string, string[]>>;

/**
 * Built-in defaults: per company × job title → parent keys.
 * Children are auto-expanded (all children of an allowed parent are visible).
 * A missing entry means FULL access (admin, finance, production, standard, unknown titles).
 *
 * v2.50.0 — holding rows dropped 'quick-proforma' / 'sales-system' (the
 *   holding never issued documents). v2.56.0 (r81) — REVERSED: the
 *   holding issues its own proformas/invoices with its royal-indigo
 *   print template, so its rows mirror the trading companies again.
 */
const DEFAULT_PARENT_ACCESS: Record<string, Record<string, string[]>> = {
  sales_expert: {
    holding:    ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'followup', 'calls', 'ai-intelligence', 'centers', 'calendar', 'reports'],
    bazargani:  ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'followup', 'calls', 'ai-intelligence', 'centers', 'calendar', 'reports', 'partner-pricing'],
    aria:       ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'followup', 'calls', 'ai-intelligence', 'centers', 'calendar', 'reports', 'loyalty'],
    bgl:        ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'followup', 'calls', 'ai-intelligence', 'centers', 'calendar', 'reports', 'loyalty', 'aftersales'],
    // v2.35.0 — یاس طب (isolated): mirror of the bgl production company.
    yasteb:     ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'followup', 'calls', 'ai-intelligence', 'centers', 'calendar', 'reports', 'loyalty', 'aftersales'],
  },
  collections: {
    holding:    ['sales-expert', 'quick-activity', 'mailbox', 'sales-system', 'collections', 'centers', 'reports', 'calendar'],
    bazargani:  ['sales-expert', 'quick-activity', 'mailbox', 'sales-system', 'collections', 'centers', 'reports', 'calendar', 'partner-pricing'],
    aria:       ['sales-expert', 'quick-activity', 'mailbox', 'sales-system', 'centers', 'reports', 'calendar', 'loyalty'],
    bgl:        ['sales-expert', 'quick-activity', 'mailbox', 'sales-system', 'centers', 'reports', 'calendar', 'loyalty'],
    yasteb:     ['sales-expert', 'quick-activity', 'mailbox', 'sales-system', 'centers', 'reports', 'calendar', 'loyalty'],
  },
  sales_support: {
    holding:    ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'calls', 'centers', 'calendar', 'reports'],
    bazargani:  ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'calls', 'centers', 'calendar', 'reports'],
    aria:       ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'calls', 'centers', 'calendar', 'reports', 'loyalty'],
    bgl:        ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'calls', 'centers', 'calendar', 'reports', 'loyalty', 'aftersales'],
    yasteb:     ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'calls', 'centers', 'calendar', 'reports', 'loyalty', 'aftersales'],
  },
  warehouse: {
    holding:    ['sales-expert', 'quick-activity', 'sales-system-stages', 'mailbox', 'inventory', 'production', 'centers', 'reports'],
    bazargani:  ['sales-expert', 'quick-activity', 'mailbox', 'inventory', 'centers', 'reports'],
    aria:       ['sales-expert', 'quick-activity', 'mailbox', 'inventory', 'centers', 'reports'],
    bgl:        ['sales-expert', 'quick-activity', 'mailbox', 'inventory', 'production', 'centers', 'reports', 'aftersales'],
    yasteb:     ['sales-expert', 'quick-activity', 'mailbox', 'inventory', 'production', 'centers', 'reports', 'aftersales'],
  },
  clerk: {
    holding:    ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'collections', 'reports', 'calendar'],
    bazargani:  ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'collections', 'reports', 'calendar', 'partner-pricing'],
    aria:       ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'reports', 'calendar'],
    bgl:        ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'reports', 'calendar'],
    yasteb:     ['sales-expert', 'quick-activity', 'quick-proforma', 'mailbox', 'sales-system', 'reports', 'calendar'],
  },
  mail_dispatch: {
    holding:    ['sales-expert', 'quick-activity', 'sales-system-stages', 'mailbox', 'calendar', 'centers', 'reports'],
    bazargani:  ['sales-expert', 'quick-activity', 'mailbox', 'calendar', 'centers', 'reports'],
    aria:       ['sales-expert', 'quick-activity', 'mailbox', 'calendar', 'centers', 'reports'],
    bgl:        ['sales-expert', 'quick-activity', 'mailbox', 'calendar', 'centers', 'reports'],
    yasteb:     ['sales-expert', 'quick-activity', 'mailbox', 'calendar', 'centers', 'reports'],
  },
};

/** Fully-expanded default matrix (parents + children keys). */
export const DEFAULT_MENU_ACCESS: MenuAccessMatrix = (() => {
  const matrix: MenuAccessMatrix = {};
  for (const [title, companies] of Object.entries(DEFAULT_PARENT_ACCESS)) {
    matrix[title] = {};
    for (const [company, parentKeys] of Object.entries(companies)) {
      matrix[title][company] = expandParentKeys(company as CompanySlug, parentKeys);
    }
  }
  return matrix;
})();

/**
 * Resolve the effective allowed menu keys for a user in a company.
 * Returns null → full access.
 */
export function resolveAllowedKeys(
  company: CompanySlug,
  jobTitle: string | null | undefined,
  role: string,
  savedMatrix: MenuAccessMatrix | null | undefined,
): string[] | null {
  // v2.58.4 (issue 4): canonicalize — a legacy 'administrator' sees all menus.
  // (roles.ts is a pure module — safe for client bundles too)
  if (getCanonicalRole(role) === 'admin') return null; // admins always see everything
  // Legacy users (no job title assigned yet): keep the previous full-access behavior
  if (!jobTitle) return null;
  const saved = savedMatrix?.[jobTitle]?.[company];
  if (Array.isArray(saved)) return saved;
  const def = DEFAULT_MENU_ACCESS[jobTitle]?.[company];
  if (Array.isArray(def)) return def;
  return null;
}

/** Filter a company menu tree by allowed keys (parents AND children). */
export function filterMenuByAccess<T extends { key: string; children?: { key: string }[] }>(
  items: T[],
  allowedKeys: string[] | null,
): T[] {
  if (!allowedKeys) return items;
  return items
    .filter((it) => allowedKeys.includes(it.key))
    .map((it) =>
      it.children
        ? { ...it, children: it.children.filter((c) => allowedKeys.includes(c.key)) }
        : it,
    )
    // a parent whose children were all hidden becomes an empty expander → drop it
    .filter((it) => !it.children || it.children.length > 0);
}

/** Effective matrix = defaults merged under saved rows (for the admin editor). */
export function effectiveMatrix(saved: MenuAccessMatrix | null | undefined): MenuAccessMatrix {
  const out: MenuAccessMatrix = {};
  const titles = new Set([...Object.keys(DEFAULT_MENU_ACCESS), ...Object.keys(saved || {})]);
  for (const title of titles) {
    out[title] = {};
    const companies = new Set([
      ...Object.keys(DEFAULT_MENU_ACCESS[title] || {}),
      ...Object.keys(saved?.[title] || {}),
    ]);
    for (const company of companies) {
      const savedRow = saved?.[title]?.[company];
      out[title][company] = Array.isArray(savedRow) ? savedRow : DEFAULT_MENU_ACCESS[title]?.[company] || [];
    }
  }
  return out;
}

/** Normalize/save helper: keep only keys that exist in the company catalog. */
export function sanitizeMatrixRow(company: CompanySlug, keys: string[]): string[] {
  const valid = new Set<string>();
  for (const m of COMPANY_MENUS[company] || []) {
    valid.add(m.key);
    if (m.children) for (const c of m.children) valid.add(c.key);
  }
  return keys.filter((k) => valid.has(k));
}
