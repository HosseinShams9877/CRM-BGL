import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// shipments-label-territory.test.ts — v2.58.7 (A5)
//
// THE REGRESSION (confirmed on the pre-fix v2.58.6 code): 'label' and
// 'issue-label-serials' were the only shipment WRITE paths without the
// territory dimension — loadLabelDocOrThrow checked BU + company only,
// while every list/update path composes docTerritoryWhereFragment. The
// label actions WRITE (auto-backfill a dispatch row, issue carton
// serials) — a scoped expert could run them for out-of-territory
// documents.
//
// THE CONTRACT (through the REAL route handler):
//   • out-of-territory label / issue-label-serials → 404, ZERO dispatch
//     backfill, ZERO carton labels
//   • CONTROL: the same document via a country-mode user works
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as shipmentsPost } from '@/app/api/shipments/route';

const db = new PrismaClient();
const TAG = `r97lbl-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/shipments', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function asUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
  currentAuthUser = user;
  return fn();
}

interface TestUser {
  id: string; username: string; displayName: string; role: string; roleLabel: string;
  businessUnitId: string; companyIds: string[]; jobTitle: string | null; isActive: boolean;
  impersonator: null; territoryMode: string; territoryProvinces: string | null; territoryCenterIds: string | null;
}

async function mkUser(username: string, role: string, territory?: string[]): Promise<TestUser> {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`, displayName: username, passwordHash: 'x', role,
      companyIds: JSON.stringify(['bazargani']), businessUnitId: 'trading',
      territoryMode: territory ? 'provinces' : 'country',
      territoryProvinces: territory ? JSON.stringify(territory) : '[]',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'trading', companyIds: ['bazargani'], jobTitle: null, isActive: true, impersonator: null,
    territoryMode: territory ? 'provinces' : 'country',
    territoryProvinces: territory ? JSON.stringify(territory) : '[]',
    territoryCenterIds: '[]',
  };
}

let expertTeh: TestUser;
let countryUser: TestUser;
let docKhzId: string; // approved invoice on the OUT-of-territory center

beforeAll(async () => {
  const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
  expertTeh = await mkUser('expert-teh', 'standard', ['تهران']);
  countryUser = await mkUser('country-u', 'standard');

  const centerKhz = await db.center.create({
    data: { name: `${TAG}-khz`, customerType: 'b2b', companyId: bazargani.id, province: 'خوزستان', businessUnitId: 'trading' },
  });

  const doc = await db.salesDocument.create({
    data: {
      documentNumber: `INV-${TAG}`, documentType: 'invoice', status: 'approved',
      totalAmount: 1_000, discountAmount: 0, taxAmount: 0, finalAmount: 1_000,
      centerId: centerKhz.id, companyId: bazargani.id, businessUnitId: 'trading',
      issuedAt: new Date(), createdById: expertTeh.id,
      items: { create: [{ productName: 'x', quantity: 2, unitPrice: 500, totalPrice: 1_000 }] },
    },
  });
  docKhzId = doc.id;
});

afterAll(async () => {
  const docs = await db.salesDocument.findMany({ where: { documentNumber: { startsWith: `INV-${TAG}` } }, select: { id: true } });
  for (const d of docs) {
    await db.cartonLabel.deleteMany({ where: { salesDocumentId: d.id } });
    await db.salesShipment.deleteMany({ where: { salesDocumentId: d.id } });
    await db.salesDocumentItem.deleteMany({ where: { salesDocumentId: d.id } });
    await db.salesDocumentLog.deleteMany({ where: { salesDocumentId: d.id } });
    await db.salesDocument.delete({ where: { id: d.id } });
  }
  await db.center.deleteMany({ where: { name: { startsWith: `${TAG}-` } } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

describe('A5 — label / issue-label-serials obey the territory', () => {
  it('REGRESSION GUARD: out-of-territory label → 404 and NO dispatch backfill', async () => {
    const before = await db.salesShipment.count({ where: { salesDocumentId: docKhzId } });
    const res = (await asUser(expertTeh, () =>
      shipmentsPost(req({ action: 'label', salesDocumentId: docKhzId })))!)!;
    expect(res.status).toBe(404);
    expect(await db.salesShipment.count({ where: { salesDocumentId: docKhzId } })).toBe(before);
  });

  it('REGRESSION GUARD: out-of-territory issue-label-serials → 404, ZERO carton labels', async () => {
    const beforeLabels = await db.cartonLabel.count({ where: { salesDocumentId: docKhzId } });
    const beforeShips = await db.salesShipment.count({ where: { salesDocumentId: docKhzId } });
    const res = (await asUser(expertTeh, () =>
      shipmentsPost(req({ action: 'issue-label-serials', salesDocumentId: docKhzId, cartonCount: 3 })))!)!;
    expect(res.status).toBe(404);
    expect(await db.cartonLabel.count({ where: { salesDocumentId: docKhzId } })).toBe(beforeLabels);
    expect(await db.salesShipment.count({ where: { salesDocumentId: docKhzId } })).toBe(beforeShips);
  });

  it('CONTROL: a country-mode user of the same company gets the label (with the auto-backfilled dispatch)', async () => {
    const res = (await asUser(countryUser, () =>
      shipmentsPost(req({ action: 'label', salesDocumentId: docKhzId })))!)!;
    expect(res.status).toBe(200);
    // the legacy-invoice auto-backfill created the dispatch row
    expect(await db.salesShipment.count({ where: { salesDocumentId: docKhzId } })).toBe(1);
  });
});
