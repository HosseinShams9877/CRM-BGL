import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// partner-pricing-security.test.ts — v2.58.7 (G2 — CRITICAL)
//
// THE REGRESSION (confirmed on the pre-fix v2.58.6 code): the mutation
// gate was `product_create || finance_write` — BOTH are true for every
// standard salesperson, and PartnerPrice is a GROUP-GLOBAL table with
// no companyId column. Any salesperson of ANY company could rewrite or
// delete the tier prices that every other company's B2B quote computes
// from. The `resolve` action's center lookup was BU-only, leaking
// another company's center name/commission/isPartner.
//
// THE CONTRACT (through the REAL route handler):
//   • standard user: create/update/delete → 403, ZERO rows written
//   • finance (accounting_cartable) and admin: mutations succeed
//   • resolve: a cross-company center yields NO center data
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as partnerPricingPost } from '@/app/api/partner-pricing/route';

const db = new PrismaClient();
const TAG = `r97pp-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/partner-pricing', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function asUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
  currentAuthUser = user;
  return fn();
}

async function jsonOf(res: unknown): Promise<Record<string, unknown>> {
  return (await (res as { json: () => Promise<unknown> }).json()) as Record<string, unknown>;
}

interface TestUser {
  id: string; username: string; displayName: string; role: string; roleLabel: string;
  businessUnitId: string; companyIds: string[]; jobTitle: string | null; isActive: boolean;
  impersonator: null; territoryMode: string; territoryProvinces: string | null; territoryCenterIds: string | null;
}

async function mkUser(username: string, role: string, companyIds: string[]): Promise<TestUser> {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`, displayName: username, passwordHash: 'x', role,
      companyIds: JSON.stringify(companyIds), businessUnitId: 'trading',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'trading', companyIds, jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]',
  };
}

let standardA: TestUser;
let standardB: TestUser;
let financeUser: TestUser;
let adminUser: TestUser;
let productCode: string;
let financeRuleId: string;
let otherCompanyCenter: { id: string; name: string; companyId: string };

beforeAll(async () => {
  const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
  const aria = (await db.company.findFirst({ where: { slug: 'aria' } }))!;
  standardA = await mkUser('std-a', 'standard', ['bazargani']);
  standardB = await mkUser('std-b', 'standard', ['aria']);
  financeUser = await mkUser('finance-u', 'finance', ['bazargani']);
  adminUser = await mkUser('admin-u', 'admin', []);

  productCode = `P-${TAG}`;
  await db.product.create({
    data: {
      code: productCode, name: `محصول ${TAG}`, unit: 'عدد', price: 1_000_000,
      companyId: bazargani.id,
    },
  });
  otherCompanyCenter = await db.center.create({
    data: { name: `${TAG}-aria-center`, customerType: 'b2b', companyId: aria.id, province: 'تهران', businessUnitId: 'trading', commissionPercent: 12.5, segment: 'partner' },
  });

  // a rule the finance user owns (for the update/delete matrix)
  const rule = await db.partnerPrice.create({
    data: { productCode, minQty: 5, price: 800_000, discountPercent: 0, commissionPercent: 3, note: '', active: true, version: 1 },
  });
  financeRuleId = rule.id;
});

afterAll(async () => {
  await db.partnerPrice.deleteMany({ where: { productCode } });
  await db.product.deleteMany({ where: { code: productCode } });
  await db.center.deleteMany({ where: { name: { startsWith: `${TAG}-aria` } } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

const createBody = () => ({
  action: 'create', productCode, minQty: 10, price: 850_000, commissionPercent: 2,
});

describe('G2 — partner-pricing mutations are finance/admin-only now', () => {
  it('REGRESSION GUARD: a standard salesperson (finance_write+product_create both true) → 403, nothing written', async () => {
    const before = await db.partnerPrice.count({ where: { productCode } });
    const res = await asUser(standardA, () => partnerPricingPost(req(createBody())));
    expect(res.status).toBe(403);
    expect(await db.partnerPrice.count({ where: { productCode } })).toBe(before);
  });

  it('the same standard user of ANOTHER company → 403 too (group-global blast radius)', async () => {
    const res = await asUser(standardB, () => partnerPricingPost(req(createBody())));
    expect(res.status).toBe(403);
  });

  it('update by a standard user → 403, the rule is untouched', async () => {
    const res = await asUser(standardA, () =>
      partnerPricingPost(req({ action: 'update', id: financeRuleId, price: 1, expectedVersion: 1 })));
    expect(res.status).toBe(403);
    const rule = await db.partnerPrice.findUnique({ where: { id: financeRuleId } });
    expect(rule?.price).toBe(800_000);
  });

  it('delete by a standard user → 403, the rule survives', async () => {
    const res = await asUser(standardA, () => partnerPricingPost(req({ action: 'delete', id: financeRuleId })));
    expect(res.status).toBe(403);
    expect(await db.partnerPrice.findUnique({ where: { id: financeRuleId } })).not.toBeNull();
  });

  it('CONTROL: finance (accounting_cartable) creates the tier successfully', async () => {
    const res = await asUser(financeUser, () => partnerPricingPost(req(createBody())));
    if (res.status !== 201) console.error('DEBUG-BODY', JSON.stringify(await jsonOf(res)));
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.success).toBe(true);
  });

  it('CONTROL: admin updates the finance-owned rule (CAS honored)', async () => {
    const res = await asUser(adminUser, () =>
      partnerPricingPost(req({ action: 'update', id: financeRuleId, price: 790_000, expectedVersion: 1 })));
    expect(res.status).toBe(200);
    const rule = await db.partnerPrice.findUnique({ where: { id: financeRuleId } });
    expect(rule?.price).toBe(790_000);
  });
});

describe('G2 — resolve center lookup is company-scoped now', () => {
  it('a cross-company center yields NO center data (no name/commission leak)', async () => {
    const res = await asUser(standardA, () =>
      partnerPricingPost(req({ action: 'resolve', productCode, quantity: 10, centerId: otherCompanyCenter.id })));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const data = body.data as Record<string, unknown>;
    expect(data.centerName ?? '').toBe('');
    expect(data.isPartner).toBe(false);
    expect(JSON.stringify(body)).not.toContain(otherCompanyCenter.name);
    expect(JSON.stringify(body)).not.toContain('12.5');
  });

  it('CONTROL: an in-company partner center still resolves with its commission', async () => {
    const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
    const ownCenter = await db.center.create({
      data: { name: `${TAG}-own-center`, customerType: 'b2b', companyId: bazargani.id, province: 'تهران', businessUnitId: 'trading', commissionPercent: 7, segment: 'partner' },
    });
    try {
      const res = await asUser(standardA, () =>
        partnerPricingPost(req({ action: 'resolve', productCode, quantity: 10, centerId: ownCenter.id })));
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      const data = body.data as Record<string, unknown>;
      expect(data.centerName).toBe(ownCenter.name);
      expect(data.isPartner).toBe(true);
      expect(data.commissionPercent).toBe(7);
    } finally {
      await db.center.delete({ where: { id: ownCenter.id } });
    }
  });
});
