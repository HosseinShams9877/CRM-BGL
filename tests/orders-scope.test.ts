import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// orders-scope.test.ts — v2.58.4 (external audit F02)
//
// THE AUDIT FINDING (confirmed on the pre-fix code): /api/orders
// filtered only businessUnit + "all centers of the requested company"
// — createdById and the expert's territory were NEVER applied, and
// the company boundary was inferred from the CENTER instead of the
// document's own issuing-company stamp. A Tehran-restricted expert
// received numbers, amounts and creator names of every colleague's
// proforma in every province of the company.
//
// THE REVIEWER'S ACCEPTANCE MATRIX (through the REAL route handler):
//   • expert A NEVER sees colleague B's document — even in a SHARED
//     province (ownership is ownership, territory only narrows);
//   • A's OWN document outside A's territory is hidden (policy parity
//     with handleList / docOwnershipTerritoryWhere);
//   • A's own centerless document stays visible;
//   • finance (view_other_sales_documents) and admin keep company-wide
//     reach in their business unit;
//   • the ISOLATED company (یاس طب) is walled off: unassigned experts
//     get 403, the GROUP ADMIN gets 403, its own user sees only its
//     docs; the admin 'holding' aggregate excludes isolated rows;
//   • a BROKEN/empty restricted scope stays fail-closed (own docs
//     only — never a widening).
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { GET as ordersGet } from '@/app/api/orders/route';

const db = new PrismaClient();
const TAG = `r89o-${Date.now().toString(36)}`;

function req(company: string): NextRequest {
  return new NextRequest(`http://localhost/api/orders?company=${company}&limit=50`);
}

function asUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
  currentAuthUser = user;
  return fn();
}

async function jsonOf(res: unknown): Promise<Array<{ id: string }>> {
  return (await (res as { json: () => Promise<Array<{ id: string }>> }).json()) as Array<{ id: string }>;
}

async function mkUser(username: string, role: string, companyIds: string[], territory?: string[] | 'broken') {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`,
      displayName: username,
      passwordHash: 'x',
      role,
      companyIds: JSON.stringify(companyIds),
      businessUnitId: 'trading',
      territoryMode: territory ? 'provinces' : 'country',
      territoryProvinces: JSON.stringify(territory === 'broken' ? [] : territory ?? []),
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'trading', companyIds, jobTitle: null, isActive: true, impersonator: null,
    territoryMode: territory ? 'provinces' : 'country',
    territoryProvinces: JSON.stringify(territory === 'broken' ? [] : territory ?? []),
    territoryCenterIds: '[]',
  };
}

interface DocSpec {
  centerId: string | null;
  companyId: string;
  createdById: string;
  number: string;
}

let expertA: Awaited<ReturnType<typeof mkUser>>;
let expertB: Awaited<ReturnType<typeof mkUser>>;
let financeUser: Awaited<ReturnType<typeof mkUser>>;
let adminUser: Awaited<ReturnType<typeof mkUser>>;
let isoUser: Awaited<ReturnType<typeof mkUser>>;

const ids = { A_teh: '', A_nocenter: '', A_khz: '', B_teh: '', iso: '' };
let centerIds = { teh: '', khz: '', yasteb: '' };
let companyIds = { bazargani: '', yasteb: '' };

async function mkDoc(spec: DocSpec) {
  const d = await db.salesDocument.create({
    data: {
      businessUnitId: 'trading',
      centerId: spec.centerId,
      companyId: spec.companyId,
      documentNumber: spec.number,
      documentType: 'proforma',
      status: 'approved',
      totalAmount: 1000,
      finalAmount: 1000,
      createdById: spec.createdById,
      items: { create: [{ productName: 'x', quantity: 1, unitPrice: 1000, totalPrice: 1000 }] },
    },
  });
  return d.id;
}

beforeAll(async () => {
  const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
  const yasteb = (await db.company.findFirst({ where: { slug: 'yasteb' } }))!;
  companyIds = { bazargani: bazargani.id, yasteb: yasteb.id };

  expertA = await mkUser('expert-a', 'standard', ['bazargani'], ['تهران']);
  expertB = await mkUser('expert-b', 'standard', ['bazargani'], ['تهران']); // SAME province as A
  financeUser = await mkUser('finance-u', 'finance', ['bazargani']);
  adminUser = await mkUser('admin-u', 'admin', []);
  isoUser = await mkUser('iso-u', 'standard', ['yasteb'], ['تهران']);

  centerIds = {
    teh: (await db.center.create({ data: { name: `${TAG}-تهران`, customerType: 'b2b', companyId: bazargani.id, province: 'تهران', businessUnitId: 'trading' } })).id,
    khz: (await db.center.create({ data: { name: `${TAG}-خوزستان`, customerType: 'b2b', companyId: bazargani.id, province: 'خوزستان', businessUnitId: 'trading' } })).id,
    yasteb: (await db.center.create({ data: { name: `${TAG}-یاس‌طب`, customerType: 'b2b', companyId: yasteb.id, province: 'تهران', businessUnitId: 'trading' } })).id,
  };

  ids.A_teh = await mkDoc({ centerId: centerIds.teh, companyId: bazargani.id, createdById: expertA.id, number: `${TAG}-A-TEH` });
  ids.A_khz = await mkDoc({ centerId: centerIds.khz, companyId: bazargani.id, createdById: expertA.id, number: `${TAG}-A-KHZ` });
  ids.A_nocenter = await mkDoc({ centerId: null, companyId: bazargani.id, createdById: expertA.id, number: `${TAG}-A-NC` });
  ids.B_teh = await mkDoc({ centerId: centerIds.teh, companyId: bazargani.id, createdById: expertB.id, number: `${TAG}-B-TEH` });
  ids.iso = await mkDoc({ centerId: centerIds.yasteb, companyId: yasteb.id, createdById: isoUser.id, number: `${TAG}-ISO` });
});

afterAll(async () => {
  await db.salesDocument.deleteMany({ where: { documentNumber: { startsWith: `${TAG}-` } } });
  await db.center.deleteMany({ where: { name: { startsWith: `${TAG}-` } } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

describe('F02 — /api/orders unified document-visibility policy (mandatory matrix)', () => {
  it('expert A: own in-territory + own centerless docs ONLY (colleague same-province doc and own out-of-territory doc are hidden)', async () => {
    const res = await asUser(expertA, () => ordersGet(req('bazargani')));
    expect(res.status).toBe(200);
    const list = await jsonOf(res);
    const got = list.map((d) => d.id).sort();
    expect(got).toEqual([ids.A_nocenter, ids.A_teh].sort());
  });

  it('expert B (same province as A): own docs only — symmetric isolation', async () => {
    const res = await asUser(expertB, () => ordersGet(req('bazargani')));
    expect(res.status).toBe(200);
    const list = await jsonOf(res);
    expect(list.map((d) => d.id).sort()).toEqual([ids.B_teh].sort());
  });

  it('A with a BROKEN (empty) restricted scope stays fail-closed — own docs (all provinces), never a widening', async () => {
    // deny-all contract (docOwnershipTerritoryWhere, the SHARED policy):
    // a broken assignment keeps the user's OWN documents visible in every
    // province but grants NOTHING beyond them — identical to handleList.
    const broken = { ...expertA, territoryProvinces: JSON.stringify([]) };
    const res = await asUser(broken, () => ordersGet(req('bazargani')));
    expect(res.status).toBe(200);
    const list = await jsonOf(res);
    const got = list.map((d) => d.id).sort();
    expect(got).toEqual([ids.A_khz, ids.A_nocenter, ids.A_teh].sort());
    expect(got).not.toContain(ids.B_teh);
  });

  it('finance keeps company-wide reach (allowed exception preserved)', async () => {
    const res = await asUser(financeUser, () => ordersGet(req('bazargani')));
    expect(res.status).toBe(200);
    const list = await jsonOf(res);
    expect(list.map((d) => d.id).sort()).toEqual([ids.A_khz, ids.A_nocenter, ids.A_teh, ids.B_teh].sort());
  });

  it('admin sees the company\u2019s docs, is walled off from the isolated company, and the holding aggregate excludes isolated rows', async () => {
    const byCompany = await asUser(adminUser, () => ordersGet(req('bazargani')));
    expect(byCompany.status).toBe(200);
    expect((await jsonOf(byCompany)).map((d) => d.id).sort()).toEqual(
      [ids.A_khz, ids.A_nocenter, ids.A_teh, ids.B_teh].sort(),
    );

    const isolated = await asUser(adminUser, () => ordersGet(req('yasteb')));
    expect(isolated.status).toBe(403);

    const holding = await asUser(adminUser, () => ordersGet(req('holding')));
    expect(holding.status).toBe(200);
    const holdingIds = (await jsonOf(holding)).map((d) => d.id);
    expect(holdingIds).not.toContain(ids.iso);
    expect(holdingIds).toContain(ids.A_teh);
  });

  it('the isolated company\u2019s own user sees its docs; an unassigned expert gets 403; non-admin cannot use the holding view', async () => {
    const own = await asUser(isoUser, () => ordersGet(req('yasteb')));
    expect(own.status).toBe(200);
    expect((await jsonOf(own)).map((d) => d.id).sort()).toEqual([ids.iso].sort());

    const outsider = await asUser(expertA, () => ordersGet(req('yasteb')));
    expect(outsider.status).toBe(403);

    const noHolding = await asUser(expertA, () => ordersGet(req('holding')));
    expect(noHolding.status).toBe(403);
  });

  it('a document whose companyId stamp escapes the requested company is filtered by the DOCUMENT\u2019S own company (not its center)', async () => {
    // a doc stamped with the isolated company but sitting on a bazargani
    // center: the center must NEVER widen the company boundary.
    const smuggled = await mkDoc({ centerId: centerIds.teh, companyId: companyIds.yasteb, createdById: expertB.id, number: `${TAG}-SMUG` });
    try {
      const res = await asUser(financeUser, () => ordersGet(req('bazargani')));
      const list = await jsonOf(res);
      expect(list.map((d) => d.id)).not.toContain(smuggled);
    } finally {
      await db.salesDocument.delete({ where: { id: smuggled } });
    }
  });
});
