import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// access-policy.test.ts — v2.58.7 (production-hardening, stage 1)
//
// The central policy layer's OWN contract:
//   • assertPermission      — 403 unless the (canonicalized) role holds it
//   • assertCompanyAccess   — tenant boundary on a live row (403/404)
//   • assertTerritoryAccess — sales-territory boundary (404 no-leak)
//   • assertCenterAccess    — guarded fetch: company + territory together
//   • assertResourceOwnership — per-user ownership, fail-closed on NULL
// All asserts THROW ApiError (client-safe Persian message + status).
// ═══════════════════════════════════════════════════════════════

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    // the policy layer never calls getCurrentUser itself, but keeping the
    // seam stubbed keeps this file hermetic if that ever changes.
    getCurrentUser: async () => null,
  };
});

import {
  assertPermission,
  assertCompanyAccess,
  assertTerritoryAccess,
  assertResourceOwnership,
  assertCenterAccess,
  territoryAllows,
  ApiError,
} from '@/lib/access-policy';
import type { AuthUser } from '@/lib/auth';

const db = new PrismaClient();
const TAG = `r97pol-${Date.now().toString(36)}`;

async function mkUserRow(username: string, role: string, companyIds: string[], territory?: string[]) {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`,
      displayName: username,
      passwordHash: 'x',
      role,
      companyIds: JSON.stringify(companyIds),
      businessUnitId: 'trading',
      territoryMode: territory ? 'provinces' : 'country',
      territoryProvinces: territory ? JSON.stringify(territory) : '[]',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'trading', companyIds, jobTitle: null, isActive: true, impersonator: null,
    territoryMode: territory ? 'provinces' : 'country',
    territoryProvinces: territory ? JSON.stringify(territory) : '[]',
    territoryCenterIds: '[]',
  } as AuthUser;
}

function mkAuthUser(overrides: Partial<AuthUser>): AuthUser {
  return {
    id: 'u-x', username: 'x', displayName: 'x', role: 'standard', roleLabel: '',
    businessUnitId: 'trading', companyIds: ['bazargani'], jobTitle: null, isActive: true,
    impersonator: null, territoryMode: 'country', territoryProvinces: null, territoryCenterIds: null,
    ...overrides,
  };
}

let bazarganiId: string;
let ariaId: string;
let adminUser: AuthUser;
let financeUser: AuthUser;
let standardUser: AuthUser;
let centerIn: { id: string };
let centerOut: { id: string };

beforeAll(async () => {
  const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
  const aria = (await db.company.findFirst({ where: { slug: 'aria' } }))!;
  bazarganiId = bazargani.id;
  ariaId = aria.id;
  adminUser = await mkUserRow('admin', 'admin', []);
  financeUser = await mkUserRow('finance', 'finance', ['bazargani']);
  standardUser = await mkUserRow('standard', 'standard', ['bazargani']);
  centerIn = await db.center.create({
    data: { name: `${TAG}-in`, customerType: 'b2b', companyId: bazargani.id, province: 'تهران', businessUnitId: 'trading' },
  });
  centerOut = await db.center.create({
    data: { name: `${TAG}-out`, customerType: 'b2b', companyId: bazargani.id, province: 'خوزستان', businessUnitId: 'trading' },
  });
});

afterAll(async () => {
  await db.center.deleteMany({ where: { name: { startsWith: `${TAG}-` } } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

function expectApiError(fn: () => unknown, status: number): void {
  try {
    fn();
    expect.fail('expected an ApiError to be thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    expect((e as ApiError).message.length).toBeGreaterThan(0);
  }
}

describe('assertPermission — the role/permission gate', () => {
  it('passes when the canonical role holds the permission', () => {
    expect(() => assertPermission(financeUser, 'finance_write')).not.toThrow();
    expect(() => assertPermission(adminUser, 'ai_prompt_manage')).not.toThrow();
    expect(() => assertPermission(standardUser, 'finance_write')).not.toThrow();
  });

  it('throws 403 with a Persian message when the permission is missing', () => {
    expectApiError(() => assertPermission(standardUser, 'ai_prompt_manage'), 403);
    expectApiError(() => assertPermission(financeUser, 'ai_calls_read'), 403);
    expectApiError(() => assertPermission(standardUser, 'void_financial'), 403);
  });

  it('normalizes legacy role spellings (administrator → admin)', () => {
    const legacy = mkAuthUser({ role: 'administrator' });
    expect(() => assertPermission(legacy, 'manage_users')).not.toThrow();
  });

  it('honors a custom denial message', () => {
    try {
      assertPermission(standardUser, 'manage_database', 'پیام اختصاصی');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toBe('پیام اختصاصی');
    }
  });
});

describe('assertCompanyAccess — the tenant boundary', () => {
  it('admin (unrestricted scope) passes any company row', async () => {
    await expect(assertCompanyAccess(adminUser, ariaId)).resolves.toBeUndefined();
    await expect(assertCompanyAccess(adminUser, bazarganiId)).resolves.toBeUndefined();
  });

  it('a scoped user passes their own company and is denied another (403 by default)', async () => {
    await expect(assertCompanyAccess(standardUser, bazarganiId)).resolves.toBeUndefined();
    await expect(assertCompanyAccess(standardUser, ariaId)).rejects.toMatchObject({ status: 403 });
  });

  it('company-neutral rows (null companyId) always pass', async () => {
    await expect(assertCompanyAccess(standardUser, null)).resolves.toBeUndefined();
  });

  it('the denial convention is caller-controlled (sales 404 no-leak)', async () => {
    await expect(
      assertCompanyAccess(standardUser, ariaId, { status: 404, message: 'یافت نشد.' }),
    ).rejects.toMatchObject({ status: 404, message: 'یافت نشد.' });
  });
});

describe('assertTerritoryAccess — the sales-territory boundary', () => {
  const teh = { id: 'c1', province: 'تهران' };
  const khz = { id: 'c2', province: 'خوزستان' };

  it('country-mode / admin users pass everywhere', () => {
    expect(() => assertTerritoryAccess(mkAuthUser({ role: 'admin' }), khz)).not.toThrow();
    expect(() => assertTerritoryAccess(mkAuthUser({}), khz)).not.toThrow();
  });

  it('a provinces-mode expert passes in-province and is denied (404 no-leak) out-of-province', () => {
    const expert = mkAuthUser({ territoryMode: 'provinces', territoryProvinces: '["تهران"]' });
    expect(() => assertTerritoryAccess(expert, teh)).not.toThrow();
    expectApiError(() => assertTerritoryAccess(expert, khz), 404);
  });

  it('centers-mode: only the listed centers pass; a null province fails closed', () => {
    const expert = mkAuthUser({ territoryMode: 'centers', territoryCenterIds: `["${centerIn.id}"]` });
    expect(() => assertTerritoryAccess(expert, { id: centerIn.id, province: 'تهران' })).not.toThrow();
    expectApiError(() => assertTerritoryAccess(expert, { id: centerOut.id, province: 'خوزستان' }), 404);
    expectApiError(() => assertTerritoryAccess(expert, { id: 'c-null', province: null }), 404);
  });

  it('the territoryAllows predicate mirrors the assert', () => {
    const expert = mkAuthUser({ territoryMode: 'provinces', territoryProvinces: '["تهران"]' });
    expect(territoryAllows(expert, teh)).toBe(true);
    expect(territoryAllows(expert, khz)).toBe(false);
  });
});

describe('assertCenterAccess — guarded fetch (company + territory in one call)', () => {
  it('returns the center for an in-scope, in-territory request', async () => {
    const expert: AuthUser = { ...standardUser, territoryMode: 'provinces', territoryProvinces: '["تهران"]' };
    const c = await assertCenterAccess(expert, centerIn.id);
    expect(c.id).toBe(centerIn.id);
    expect(c.companyId).toBe(bazarganiId);
  });

  it('missing center → 404, cross-company → 403, out-of-territory → 404', async () => {
    const expert: AuthUser = { ...standardUser, territoryMode: 'provinces', territoryProvinces: '["تهران"]' };
    await expect(assertCenterAccess(expert, 'nonexistent-id')).rejects.toMatchObject({ status: 404 });
    // cross company: an aria-owned center
    const ariaCenter = await db.center.create({
      data: { name: `${TAG}-aria`, customerType: 'b2b', companyId: ariaId, province: 'تهران', businessUnitId: 'trading' },
    });
    try {
      await expect(assertCenterAccess(expert, ariaCenter.id)).rejects.toMatchObject({ status: 403 });
      await expect(assertCenterAccess(expert, centerOut.id)).rejects.toMatchObject({ status: 404 });
    } finally {
      await db.center.delete({ where: { id: ariaCenter.id } });
    }
  });
});

describe('assertResourceOwnership — the per-user ownership rule', () => {
  it("the owner's own row passes", () => {
    expect(() => assertResourceOwnership(standardUser, standardUser.id)).not.toThrow();
  });

  it("another user's row and NULL-owner rows are denied (fail-closed)", () => {
    expectApiError(() => assertResourceOwnership(standardUser, financeUser.id), 403);
    expectApiError(() => assertResourceOwnership(standardUser, null), 403);
  });

  it('an explicit override expresses a route-level exception', () => {
    expect(() => assertResourceOwnership(standardUser, financeUser.id, { override: true })).not.toThrow();
  });
});
