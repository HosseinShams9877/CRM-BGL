// Unit tests — demo team spec + drift guard (v2.31.0).
// The seed's security banner promised SEED_DEMO_USERS behavior since v2.22.0
// with zero implementation; the implementation now lives in prisma/demo-team.ts
// and these tests pin it to the REAL registry/API contracts so future edits
// to either side cannot silently drift apart again.
import { describe, it, expect } from 'vitest';
import {
  DEMO_TEAM,
  validateDemoTeam,
  DEMO_COMPANY_SLUGS,
  USERNAME_RE,
  DemoUserSpec,
} from '../prisma/demo-team';
import {
  DEFAULT_JOB_TITLES,
  DEFAULT_MENU_ACCESS,
} from '@/lib/access-config';
import { getRolePermissions } from '@/lib/auth';

const validUser = (): DemoUserSpec => ({
  username: 'test.user',
  displayName: 'کاربر آزمایشی',
  jobTitle: 'sales_expert',
  companyIds: ['bazargani'],
  businessUnitId: 'production',
});

describe('DEMO_TEAM vs the real registry (drift guard)', () => {
  it('ships with zero validation errors', () => {
    expect(validateDemoTeam(DEMO_TEAM)).toEqual([]);
  });

  it('has unique usernames', () => {
    const names = DEMO_TEAM.map((u) => u.username);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every jobTitle exists in DEFAULT_JOB_TITLES', () => {
    const keys = new Set(DEFAULT_JOB_TITLES.map((t) => t.key));
    for (const u of DEMO_TEAM) expect(keys.has(u.jobTitle)).toBe(true);
  });

  it('restriction exists for every demo account (matrix menus OR role permissions)', () => {
    // Two REAL restriction mechanisms in this codebase:
    //  1. Matrix-driven titles (in DEFAULT_PARENT_ACCESS) → sidebar filtered
    //     by DEFAULT_MENU_ACCESS rows. A missing row means FULL access
    //     (resolveAllowedKeys → null) — exactly what a demo of restricted
    //     accounts must NOT silently do.
    //  2. Role-driven titles (finance/production — intentionally absent from
    //     the matrix) → restriction comes from getRolePermissions(baseRole).
    //     Their permission set must differ from an unrestricted standard user.
    const baseRoles = new Map(DEFAULT_JOB_TITLES.map((t) => [t.key, t.baseRole]));
    const matrixTitles = new Set(Object.keys(DEFAULT_MENU_ACCESS));

    for (const u of DEMO_TEAM) {
      if (matrixTitles.has(u.jobTitle)) {
        for (const company of u.companyIds) {
          expect(DEFAULT_MENU_ACCESS[u.jobTitle]?.[company]).toBeDefined();
        }
      } else {
        const role = baseRoles.get(u.jobTitle)!;
        expect(['finance', 'production']).toContain(role);
        const restricted = getRolePermissions(role);
        const standard = getRolePermissions('standard');
        expect(JSON.stringify(restricted)).not.toBe(JSON.stringify(standard));
      }
    }
  });

  it('no demo account is an admin', () => {
    const baseRoles = new Map(DEFAULT_JOB_TITLES.map((t) => [t.key, t.baseRole]));
    for (const u of DEMO_TEAM) expect(baseRoles.get(u.jobTitle)).not.toBe('admin');
  });
});

describe('validateDemoTeam — contract enforcement', () => {
  it('rejects a malformed username', () => {
    const errs = validateDemoTeam([{ ...validUser(), username: 'bad name!' }]);
    expect(errs.some((e) => e.includes('نام کاربری نامعتبر'))).toBe(true);
  });

  it('rejects a too-short username', () => {
    const errs = validateDemoTeam([{ ...validUser(), username: 'ab' }]);
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects duplicate usernames', () => {
    const errs = validateDemoTeam([validUser(), validUser()]);
    expect(errs.some((e) => e.includes('تکراری'))).toBe(true);
  });

  it('rejects an unknown jobTitle', () => {
    const errs = validateDemoTeam([{ ...validUser(), jobTitle: 'nonexistent_title' }]);
    expect(errs.some((e) => e.includes('رجیستری'))).toBe(true);
  });

  it('rejects the admin-only holding company', () => {
    const errs = validateDemoTeam([{ ...validUser(), companyIds: ['holding'] }]);
    expect(errs.some((e) => e.includes('holding'))).toBe(true);
  });

  it('rejects an invalid company slug', () => {
    const errs = validateDemoTeam([{ ...validUser(), companyIds: ['unknownco'] }]);
    expect(errs.some((e) => e.includes('شرکت نامعتبر'))).toBe(true);
  });

  it('rejects more than 3 companies', () => {
    const errs = validateDemoTeam([{ ...validUser(), companyIds: ['bazargani', 'aria', 'bgl', 'bgl'] }]);
    expect(errs.some((e) => e.includes('بیش از ۳'))).toBe(true);
  });

  it('rejects an empty company list', () => {
    const errs = validateDemoTeam([{ ...validUser(), companyIds: [] }]);
    expect(errs.some((e) => e.includes('بدون شرکت'))).toBe(true);
  });

  it('rejects an unknown business unit', () => {
    const errs = validateDemoTeam([{ ...validUser(), businessUnitId: 'nowhere' }]);
    expect(errs.some((e) => e.includes('واحد کسب‌وکار نامعتبر'))).toBe(true);
  });
});

describe('username regex (mirrors sales-users.tsx)', () => {
  it('accepts latin letters, digits, dot, dash, underscore', () => {
    expect(USERNAME_RE.test('sales.ali')).toBe(true);
    expect(USERNAME_RE.test('a-b_c.9')).toBe(true);
  });

  it('rejects spaces, Persian letters and empty strings', () => {
    expect(USERNAME_RE.test('علی')).toBe(false);
    expect(USERNAME_RE.test('has space')).toBe(false);
    expect(USERNAME_RE.test('')).toBe(false);
  });
});

describe('DEMO_COMPANY_SLUGS', () => {
  it('matches the /api/users update-companies whitelist (no holding)', () => {
    expect([...DEMO_COMPANY_SLUGS].sort()).toEqual(['aria', 'bazargani', 'bgl']);
  });
});
