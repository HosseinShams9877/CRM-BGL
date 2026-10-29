// ═══════════════════════════════════════════════════════════
// DEMO TEAM — v2.31.0
//
// Pure spec + validator for the optional demo staff accounts created by
// prisma/seed.ts when SEED_DEMO_USERS=true. The seed's security banner has
// promised this behavior since v2.22.0 ("Demo staff accounts are NOT
// created unless SEED_DEMO_USERS=true") but no code ever implemented it —
// this module is that implementation.
//
// Kept PURE (no DB, no side effects) so the SAME drift-guard validator runs:
//   • in the seed before touching the database, and
//   • in the unit battery (tests/demo-team.test.ts).
//
// The validator mirrors the REAL API contracts, not aspirations:
//   • username: /^[a-zA-Z0-9_.-]{3,30}$/  (sales-users.tsx client rule)
//   • jobTitle must exist in DEFAULT_JOB_TITLES (access registry)
//   • companyIds ⊆ ['bazargani','aria','bgl'], 1..3 entries
//     ('holding' is admin-only; '/api/users update-companies' enforces this)
//   • businessUnitId ∈ ['production','trading']
// ═══════════════════════════════════════════════════════════
import { DEFAULT_JOB_TITLES } from '../src/lib/access-config';

export interface DemoUserSpec {
  username: string;
  displayName: string;
  /** Key from the access registry (drives base role + label + menus). */
  jobTitle: string;
  /** Company slugs the user may access (holding excluded — admin-only). */
  companyIds: string[];
  businessUnitId: string;
  province?: string;
}

/** Slugs the /api/users update-companies handler accepts for non-admins. */
export const DEMO_COMPANY_SLUGS = ['bazargani', 'aria', 'bgl'] as const;

/** Business units seeded by prisma/seed.ts. */
export const DEMO_BUSINESS_UNITS = ['production', 'trading'] as const;

export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;

/**
 * A realistic starter team covering every menu-matrix job title that has a
 * meaningful per-company view. All on the 'production' business unit —
 * the same scope the app's own user-creation UI hardcodes, so the demo
 * team is visible to the admin in «کاربران و دسترسی‌ها».
 */
export const DEMO_TEAM: DemoUserSpec[] = [
  {
    username: 'sales.ali',
    displayName: 'علی محمدی',
    jobTitle: 'sales_expert',
    companyIds: ['bazargani'],
    businessUnitId: 'production',
    province: 'تهران',
  },
  {
    username: 'sales.sara',
    displayName: 'سارا کریمی',
    jobTitle: 'sales_expert',
    companyIds: ['aria'],
    businessUnitId: 'production',
    province: 'اصفهان',
  },
  {
    username: 'finance.maryam',
    displayName: 'مریم حسینی',
    jobTitle: 'finance',
    companyIds: ['bazargani', 'bgl'],
    businessUnitId: 'production',
  },
  {
    username: 'production.reza',
    displayName: 'رضا احمدی',
    jobTitle: 'production',
    companyIds: ['bgl'],
    businessUnitId: 'production',
  },
  {
    username: 'warehouse.hossein',
    displayName: 'حسین رضایی',
    jobTitle: 'warehouse',
    companyIds: ['bazargani', 'bgl'],
    businessUnitId: 'production',
  },
  {
    username: 'collections.zahra',
    displayName: 'زهرا موسوی',
    jobTitle: 'collections',
    companyIds: ['bazargani'],
    businessUnitId: 'production',
  },
];

/**
 * Drift guard: validate a demo team against the real registry/API contracts.
 * Returns a list of human-readable errors (Persian-first, matching app tone).
 * Empty array ⇒ safe to seed.
 */
export function validateDemoTeam(team: DemoUserSpec[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const registryKeys = new Set(DEFAULT_JOB_TITLES.map((t) => t.key));

  for (const u of team) {
    if (!USERNAME_RE.test(u.username)) {
      errors.push(`نام کاربری نامعتبر: «${u.username}» (۳ تا ۳۰ کاراکتر لاتین/نقطه/خط تیره)`);
    }
    if (seen.has(u.username)) {
      errors.push(`نام کاربری تکراری: «${u.username}»`);
    }
    seen.add(u.username);

    if (!u.displayName || !u.displayName.trim()) {
      errors.push(`نام نمایشی خالی برای «${u.username}»`);
    }

    if (!registryKeys.has(u.jobTitle)) {
      errors.push(`عنوان شغلی «${u.jobTitle}» (کاربر ${u.username}) در رجیستری وجود ندارد`);
    }

    if (!Array.isArray(u.companyIds) || u.companyIds.length === 0) {
      errors.push(`کاربر «${u.username}» بدون شرکت است (حداقل یکی الزامی)`);
    } else {
      if (u.companyIds.length > 3) {
        errors.push(`کاربر «${u.username}» بیش از ۳ شرکت دارد`);
      }
      for (const slug of u.companyIds) {
        if (!(DEMO_COMPANY_SLUGS as readonly string[]).includes(slug)) {
          errors.push(`شرکت نامعتبر «${slug}» برای ${u.username} (holding فقط برای مدیر)`);
        }
      }
    }

    if (!(DEMO_BUSINESS_UNITS as readonly string[]).includes(u.businessUnitId)) {
      errors.push(`واحد کسب‌وکار نامعتبر «${u.businessUnitId}» برای ${u.username}`);
    }
  }

  return errors;
}
