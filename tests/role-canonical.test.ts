import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// role-canonical.test.ts — v2.58.4 (user issue 4: role normalization)
//
// THE REGRESSION: validateSession() returned the RAW database role on
// AuthUser. Every direct `user.role === 'admin'` comparison in the
// codebase (~40 sites: company-scope, users, files, ai-bridge, …)
// then DENIED a legacy 'administrator' the admin behavior (scoped
// company list instead of all companies, user management refused,
// isolated-company walls bypassed, …). Login masked it because the
// auth route runs normalizeRole() on the RESPONSE — the session object
// itself was never canonicalized.
//
// THE CONTRACT (v2.58.4):
//   • ONE canonical mapper — src/lib/roles.ts getCanonicalRole():
//     administrator→admin, financial/finance_manager→finance,
//     production_unit→production, unknown/empty→standard;
//   • validateSession() canonicalizes the role at the SOURCE;
//   • getRolePermissions parity: legacy role ≡ canonical role;
//   • a legacy-role login behaves EXACTLY like its canonical twin
//     (company access, admin bypass, permission matrix).
// ═══════════════════════════════════════════════════════════════

const db = new PrismaClient();
const TAG = `r90role-${Date.now().toString(36)}`;

const currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import {
  getCanonicalRole,
  getRolePermissions,
  canAccessCompany,
  validateSession,
  createSession,
  type AuthUser,
} from '@/lib/auth';

function mkAuth(role: string, companyIds: string[] = ['bgl']): AuthUser {
  return {
    id: 'u1', username: 'u', displayName: 'U', role, roleLabel: '',
    jobTitle: null, businessUnitId: 'trading', isActive: true,
    companyIds, impersonator: null,
    territoryMode: 'country', territoryProvinces: null, territoryCenterIds: null,
  } as AuthUser;
}

beforeAll(async () => {
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
});

afterAll(async () => {
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.session.deleteMany({ where: { displayName: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

// ── 1. the canonical mapper ───────────────────────────────────
describe('getCanonicalRole — the ONE mapper (issue 4)', () => {
  it('maps every legacy alias to its canonical role', () => {
    expect(getCanonicalRole('administrator')).toBe('admin');
    expect(getCanonicalRole('financial')).toBe('finance');
    expect(getCanonicalRole('finance_manager')).toBe('finance');
    expect(getCanonicalRole('production_unit')).toBe('production');
  });

  it('keeps canonical roles fixed-point', () => {
    for (const r of ['admin', 'finance', 'production', 'standard']) {
      expect(getCanonicalRole(r)).toBe(r);
    }
  });

  it('fails SAFE on unknown/empty/case variants', () => {
    expect(getCanonicalRole('')).toBe('standard');
    expect(getCanonicalRole('unknown-role')).toBe('standard');
    expect(getCanonicalRole('Administrator')).toBe('admin'); // imported case variant
    expect(getCanonicalRole(' admin ')).toBe('admin');       // stray whitespace
  });

  it('getRolePermissions: legacy role ≡ canonical role (full parity)', () => {
    expect(getRolePermissions('administrator')).toEqual(getRolePermissions('admin'));
    expect(getRolePermissions('financial')).toEqual(getRolePermissions('finance'));
    expect(getRolePermissions('finance_manager')).toEqual(getRolePermissions('finance'));
    expect(getRolePermissions('production_unit')).toEqual(getRolePermissions('production'));
  });
});

// ── 2. canAccessCompany no longer depends on the RAW role ─────
describe('canAccessCompany — legacy admin gets admin behavior (issue 4)', () => {
  it("a legacy 'administrator' can access 'holding' like an admin", () => {
    expect(canAccessCompany(mkAuth('administrator'), 'holding')).toBe(true);
    expect(canAccessCompany(mkAuth('admin'), 'holding')).toBe(true);
  });

  it("a legacy 'financial' still cannot access 'holding'", () => {
    expect(canAccessCompany(mkAuth('financial'), 'holding')).toBe(false);
  });

  it('a legacy standard user is still scoped to their companies', () => {
    expect(canAccessCompany(mkAuth('standard', ['bgl']), 'bgl')).toBe(true);
    expect(canAccessCompany(mkAuth('standard', ['bgl']), 'bazargani')).toBe(false);
  });
});

// ── 3. the SOURCE: validateSession canonicalizes the session role ──
describe('validateSession — canonical role at the source (issue 4)', () => {
  it.each([
    ['administrator', 'admin'],
    ['financial', 'finance'],
    ['production_unit', 'production'],
    ['standard', 'standard'],
  ])('a DB user with role %s logs in with canonical role %s', async (raw, canonical) => {
    const user = await db.user.create({
      data: {
        username: `${TAG}-${raw}`,
        displayName: `${TAG}-${raw}`,
        passwordHash: 'x',
        role: raw,
        companyIds: JSON.stringify(['bgl']),
        businessUnitId: 'trading',
        roleLabel: '',
      },
    });
    const token = await createSession(user.id, `${TAG}-${raw}`, 'test', 'hash');
    try {
      const auth = await validateSession(token);
      expect(auth).not.toBeNull();
      expect(auth!.role).toBe(canonical);
      // permission matrix parity — the login BEHAVES like the canonical twin
      expect(getRolePermissions(auth!.role)).toEqual(getRolePermissions(canonical));
      if (canonical === 'admin') {
        // the admin bypass that raw-role comparisons used to break
        expect(canAccessCompany(auth!, 'holding')).toBe(true);
      }
    } finally {
      await db.session.deleteMany({ where: { userId: user.id } });
    }
  });
});
