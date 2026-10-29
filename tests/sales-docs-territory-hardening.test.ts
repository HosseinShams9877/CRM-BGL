import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// sales-docs-territory-hardening.test.ts — v2.58.7 (G1 + A4)
//
// THE REGRESSION (confirmed on the pre-fix v2.58.6 code):
//   • G1 (CRITICAL): quick-sale checked the COMPANY scope but never the
//     TERRITORY — a provinces/centers-mode expert issued an already-
//     APPROVED invoice + full payment + loyalty points + auto-dispatch
//     for any in-company, out-of-territory center. One request, four
//     financial writes, zero territory guards.
//   • A4: update / submit-approval / cancel fetched the document via
//     findDocOrThrow WITHOUT the territory argument (get/move-stage/
//     add-payment pass it) — own-doc mutations escaped the territory.
//
// THE CONTRACT (all through the REAL route handler):
//   • every out-of-territory attempt → 404 no-leak
//   • every rejected request leaves ZERO financial side effects
//   • in-territory flows keep working (control case)
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as salesDocsPost } from '@/app/api/sales-documents/route';

const db = new PrismaClient();
const TAG = `r97qs-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/sales-documents', {
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

async function mkUser(username: string, role: string, companyIds: string[], territory?: string[]): Promise<TestUser> {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`, displayName: username, passwordHash: 'x', role,
      companyIds: JSON.stringify(companyIds), businessUnitId: 'trading',
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
  };
}

let expertTeh: TestUser; // provinces=['تهران'] — the scoped expert
let countryUser: TestUser; // country-mode control
let centerTeh: { id: string; mobile: string | null };
let centerKhz: { id: string; mobile: string | null };

const ITEMS = [{ productName: 'دستگاه تست', quantity: 1, unitPrice: 1_000_000 }];

async function mkCenter(name: string, companyId: string, province: string, mobile: string) {
  return db.center.create({
    data: {
      name: `${TAG}-${name}`, customerType: 'b2b', companyId, province,
      businessUnitId: 'trading', mobile,
    },
  });
}

async function countsForCenter(centerId: string) {
  const [docs, pays, loyalty, ships, invoices] = await Promise.all([
    db.salesDocument.count({ where: { centerId } }),
    db.salesDocumentFinance.count({ where: { salesDocument: { centerId } } }),
    db.loyaltyTransaction.count({ where: { centerId } }),
    db.salesShipment.count({ where: { salesDocument: { centerId } } }),
    db.issuedInvoice.count({ where: { salesDocument: { centerId } } }),
  ]);
  return { docs, pays, loyalty, ships, invoices };
}

async function cleanupCenter(centerId: string) {
  const docs = await db.salesDocument.findMany({ where: { centerId }, select: { id: true } });
  for (const d of docs) {
    await db.salesShipment.deleteMany({ where: { salesDocumentId: d.id } });
    await db.cartonLabel.deleteMany({ where: { salesDocumentId: d.id } });
    await db.issuedInvoicePayment.deleteMany({ where: { issuedInvoice: { salesDocumentId: d.id } } });
    await db.issuedInvoice.deleteMany({ where: { salesDocumentId: d.id } });
    await db.salesDocumentFinance.deleteMany({ where: { salesDocumentId: d.id } });
    await db.salesDocumentLog.deleteMany({ where: { salesDocumentId: d.id } });
    await db.salesDocumentVersion.deleteMany({ where: { salesDocumentId: d.id } });
    await db.salesDocumentItem.deleteMany({ where: { salesDocumentId: d.id } });
    await db.salesDocumentApproval.deleteMany({ where: { salesDocumentId: d.id } });
    await db.salesDocument.delete({ where: { id: d.id } });
  }
  await db.loyaltyTransaction.deleteMany({ where: { centerId } });
}

beforeAll(async () => {
  const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
  expertTeh = await mkUser('expert-teh', 'standard', ['bazargani'], ['تهران']);
  countryUser = await mkUser('country-u', 'standard', ['bazargani']);
  centerTeh = await mkCenter('تهران', bazargani.id, 'تهران', `0912${Date.now().toString().slice(-7)}`);
  centerKhz = await mkCenter('خوزستان', bazargani.id, 'خوزستان', `0935${Date.now().toString().slice(-7)}`);
});

afterAll(async () => {
  for (const c of [centerTeh.id, centerKhz.id]) await cleanupCenter(c).catch(() => undefined);
  await db.center.deleteMany({ where: { name: { startsWith: `${TAG}-` } } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

describe('G1 — quick-sale territory (the cross-territory money write)', () => {
  it('REGRESSION GUARD: an out-of-territory existing customer → 404 and ZERO financial writes', async () => {
    const before = await countsForCenter(centerKhz.id);
    const res = await asUser(expertTeh, () =>
      salesDocsPost(req({
        action: 'quick-sale', centerId: centerKhz.id,
        customerName: 'مشتری خارج از حوزه', items: ITEMS, paymentMethod: 'cash',
      })));
    expect(res.status).toBe(404);
    const after = await countsForCenter(centerKhz.id);
    expect(after).toEqual(before);
  });

  it('the mobile-lookup path gets the SAME gate (found customer out of territory → 404, zero writes)', async () => {
    const before = await countsForCenter(centerKhz.id);
    const res = await asUser(expertTeh, () =>
      salesDocsPost(req({
        action: 'quick-sale', customerMobile: centerKhz.mobile,
        customerName: 'مشتری موبایلی', items: ITEMS, paymentMethod: 'cash',
      })));
    expect(res.status).toBe(404);
    const after = await countsForCenter(centerKhz.id);
    expect(after).toEqual(before);
  });

  it('CONTROL: the in-territory customer still quick-sells (approved invoice + payment + loyalty)', async () => {
    const res = await asUser(expertTeh, () =>
      salesDocsPost(req({
        action: 'quick-sale', centerId: centerTeh.id,
        customerName: 'مشتری داخل حوزه', items: ITEMS, paymentMethod: 'cash',
      })));
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.success).toBe(true);
    const counts = await countsForCenter(centerTeh.id);
    expect(counts.docs).toBe(1);
    expect(counts.pays).toBe(1);
    expect(counts.invoices).toBe(1);
  });

  it('CONTROL: a country-mode user of the same company is NOT restricted', async () => {
    const res = await asUser(countryUser, () =>
      salesDocsPost(req({
        action: 'quick-sale', centerId: centerKhz.id,
        customerName: 'مشتری کشور', items: ITEMS, paymentMethod: 'cash',
      })));
    expect(res.status).toBe(201);
    const counts = await countsForCenter(centerKhz.id);
    expect(counts.docs).toBe(1);
    expect(counts.pays).toBe(1);
  });
});

describe('A4 — update / submit-approval / cancel territory parity', () => {
  let ownDocKhz: { id: string; version: number };

  beforeAll(async () => {
    // the expert's OWN draft document on the OUT-of-territory center —
    // exactly the pre-fix escape: ownership passes, company passes,
    // geography must not.
    const d = await db.salesDocument.create({
      data: {
        documentNumber: `D-${TAG}-ownkhz`, documentType: 'proforma', status: 'draft',
        totalAmount: 1_000_000, discountAmount: 0, taxAmount: 0, finalAmount: 1_000_000,
        centerId: centerKhz.id, companyId: (await db.company.findFirst({ where: { slug: 'bazargani' } }))!.id,
        businessUnitId: 'trading', createdById: expertTeh.id,
        items: { create: [{ productName: 'x', quantity: 1, unitPrice: 1_000_000, totalPrice: 1_000_000 }] },
      },
    });
    ownDocKhz = { id: d.id, version: d.version };
  });

  it('update on own out-of-territory doc → 404, nothing changes', async () => {
    const res = await asUser(expertTeh, () =>
      salesDocsPost(req({
        action: 'update', id: ownDocKhz.id, description: 'تغییر غیرمجاز',
        expectedVersion: ownDocKhz.version,
      })));
    expect(res.status).toBe(404);
    const doc = await db.salesDocument.findUnique({ where: { id: ownDocKhz.id } });
    expect(doc?.description).not.toBe('تغییر غیرمجاز');
  });

  it('submit-approval on own out-of-territory doc → 404, status stays draft', async () => {
    const res = await asUser(expertTeh, () =>
      salesDocsPost(req({ action: 'submit-approval', id: ownDocKhz.id })));
    expect(res.status).toBe(404);
    const doc = await db.salesDocument.findUnique({ where: { id: ownDocKhz.id } });
    expect(doc?.status).toBe('draft');
  });

  it('cancel on own out-of-territory doc → 404, status stays draft', async () => {
    const res = await asUser(expertTeh, () =>
      salesDocsPost(req({ action: 'cancel', id: ownDocKhz.id, reason: 'r' })));
    expect(res.status).toBe(404);
    const doc = await db.salesDocument.findUnique({ where: { id: ownDocKhz.id } });
    expect(doc?.status).toBe('draft');
  });

  it('update RE-ASSIGNMENT to an out-of-territory center → 404, center unchanged', async () => {
    // an own, in-territory draft
    const docTeh = await db.salesDocument.create({
      data: {
        documentNumber: `D-${TAG}-ownteh`, documentType: 'proforma', status: 'draft',
        totalAmount: 500_000, discountAmount: 0, taxAmount: 0, finalAmount: 500_000,
        centerId: centerTeh.id, companyId: (await db.company.findFirst({ where: { slug: 'bazargani' } }))!.id,
        businessUnitId: 'trading', createdById: expertTeh.id,
        items: { create: [{ productName: 'x', quantity: 1, unitPrice: 500_000, totalPrice: 500_000 }] },
      },
    });
    try {
      const res = await asUser(expertTeh, () =>
        salesDocsPost(req({
          action: 'update', id: docTeh.id, centerId: centerKhz.id,
          expectedVersion: docTeh.version,
        })));
      expect(res.status).toBe(404);
      const doc = await db.salesDocument.findUnique({ where: { id: docTeh.id } });
      expect(doc?.centerId).toBe(centerTeh.id);
    } finally {
      await cleanupCenter(centerTeh.id).catch(() => undefined);
      await db.salesDocument.deleteMany({ where: { id: docTeh.id } }).catch(() => undefined);
    }
  });
});
