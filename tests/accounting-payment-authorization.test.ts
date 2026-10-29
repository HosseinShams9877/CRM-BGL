import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// accounting-payment-authorization.test.ts — v2.58.7 (stage 2)
//
// THE USER'S MANDATORY MATRIX (production-hardening round, stage 2),
// executed through the REAL accounting-cartable route handler on real
// SQLite — the exact scenarios as specified:
//
//   User A: Document A. User B: finance_write (standard salesperson).
//   User B tries: Payment CREATE / UPDATE / DELETE  → 403 (all three)
//   Finance of the SAME company: succeeds
//   Finance of ANOTHER company: 403
//   Controls stay inside the transaction (concurrent edit race)
//
// This documents the v2.58.4 ownership matrix, which the round-97 audit
// re-verified is enforced INSIDE the write transaction
// (cartable-payments.ts:572-585 / 662-675). The tests pin the contract
// so no future refactor can silently drop a dimension.
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as cartablePost } from '@/app/api/accounting-cartable/route';

const db = new PrismaClient();
const TAG = `r97pay-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/accounting-cartable', {
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

let userA: TestUser; // document owner (standard)
let userB: TestUser; // standard salesperson with finance_write, SAME company as A
let financeSame: TestUser; // finance role, same company
let financeOther: TestUser; // finance role, another company
let docAId: string;
let paymentAId: string; // a payment user A registered on their own doc
let centerId: string;

beforeAll(async () => {
  const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
  userA = await mkUser('user-a', 'standard', ['bazargani']);
  userB = await mkUser('user-b', 'standard', ['bazargani']);
  financeSame = await mkUser('fin-same', 'finance', ['bazargani']);
  financeOther = await mkUser('fin-other', 'finance', ['aria']);

  const center = await db.center.create({
    data: { name: `${TAG}-center`, customerType: 'b2b', companyId: bazargani.id, province: 'تهران', businessUnitId: 'trading' },
  });
  centerId = center.id;

  const docA = await db.salesDocument.create({
    data: {
      documentNumber: `D-${TAG}`, documentType: 'proforma', status: 'approved',
      totalAmount: 1_000_000, discountAmount: 0, taxAmount: 0, finalAmount: 1_000_000,
      centerId, companyId: bazargani.id, businessUnitId: 'trading', createdById: userA.id,
      items: { create: [{ productName: 'x', quantity: 1, unitPrice: 1_000_000, totalPrice: 1_000_000 }] },
    },
  });
  docAId = docA.id;

  // a payment registered by USER A on their own document
  const payment = await db.salesDocumentFinance.create({
    data: { salesDocumentId: docAId, paymentMethod: 'cash', paymentDate: new Date(), amount: 400_000, description: '', createdById: userA.id },
  });
  paymentAId = payment.id;
});

afterAll(async () => {
  await db.salesDocumentFinance.deleteMany({ where: { salesDocumentId: docAId } });
  await db.salesDocumentLog.deleteMany({ where: { salesDocumentId: docAId } });
  await db.salesDocumentItem.deleteMany({ where: { salesDocumentId: docAId } });
  await db.salesDocument.deleteMany({ where: { id: docAId } });
  await db.center.deleteMany({ where: { id: centerId } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

async function paymentCount(): Promise<number> {
  return db.salesDocumentFinance.count({ where: { salesDocumentId: docAId } });
}

describe('SCENARIO 1 (the user\'s mandatory matrix) — User B (finance_write) on User A\'s document', () => {
  it('Payment CREATE → 403, zero new rows', async () => {
    const before = await paymentCount();
    const res = await asUser(userB, () =>
      cartablePost(req({ action: 'add-payment', salesDocumentId: docAId, amount: 100_000, paymentMethod: 'cash' })));
    expect(res.status).toBe(403);
    expect(await paymentCount()).toBe(before);
  });

  it('Payment UPDATE → 403, the row is untouched', async () => {
    const res = await asUser(userB, () =>
      cartablePost(req({ action: 'update-payment', paymentId: paymentAId, amount: 999_999 })));
    expect(res.status).toBe(403);
    const row = await db.salesDocumentFinance.findUnique({ where: { id: paymentAId } });
    expect(row?.amount).toBe(400_000);
  });

  it('Payment DELETE → 403, the row survives', async () => {
    const res = await asUser(userB, () =>
      cartablePost(req({ action: 'delete-payment', paymentId: paymentAId })));
    expect(res.status).toBe(403);
    expect(await db.salesDocumentFinance.findUnique({ where: { id: paymentAId } })).not.toBeNull();
  });
});

describe('SCENARIO 2 — Finance of the SAME company succeeds (company scope, no ownership wall)', () => {
  it('Payment CREATE → success (in-tx, receipt recorded)', async () => {
    const before = await paymentCount();
    const res = await asUser(financeSame, () =>
      cartablePost(req({ action: 'add-payment', salesDocumentId: docAId, amount: 200_000, paymentMethod: 'cash' })));
    expect(res.status).toBe(200);
    expect(await paymentCount()).toBe(before + 1);
  });

  it('Payment UPDATE → success (the finance-wide reach)', async () => {
    const res = await asUser(financeSame, () =>
      cartablePost(req({ action: 'update-payment', paymentId: paymentAId, amount: 300_000 })));
    expect(res.status).toBe(200);
    const row = await db.salesDocumentFinance.findUnique({ where: { id: paymentAId } });
    expect(row?.amount).toBe(300_000);
  });
});

describe('SCENARIO 3 — Finance of ANOTHER company → 403 (tenant wall)', () => {
  it('Payment CREATE → 403', async () => {
    const before = await paymentCount();
    const res = await asUser(financeOther, () =>
      cartablePost(req({ action: 'add-payment', salesDocumentId: docAId, amount: 100_000, paymentMethod: 'cash' })));
    expect(res.status).toBe(403);
    expect(await paymentCount()).toBe(before);
  });

  it('Payment UPDATE → 403, row untouched', async () => {
    const res = await asUser(financeOther, () =>
      cartablePost(req({ action: 'update-payment', paymentId: paymentAId, amount: 1 })));
    expect(res.status).toBe(403);
    const row = await db.salesDocumentFinance.findUnique({ where: { id: paymentAId } });
    expect(row?.amount).toBe(300_000);
  });

  it('Payment DELETE → 403, row survives', async () => {
    const res = await asUser(financeOther, () =>
      cartablePost(req({ action: 'delete-payment', paymentId: paymentAId })));
    expect(res.status).toBe(403);
    expect(await db.salesDocumentFinance.findUnique({ where: { id: paymentAId } })).not.toBeNull();
  });
});

describe('IN-TRANSACTION CONTROL — concurrent payment updates', () => {
  it('two simultaneous edits: exactly ONE lands, the other is refused with a controlled error', async () => {
    // doc total 1_000_000; payments now 300_000 + 200_000 = 500_000.
    // both editors try to raise THEIR payment by 400_000 → 300→700 and 200→600
    // 700+200=900 ok alone; 300+600=900 ok alone; 700+600=1_300 > 1_000_000 →
    // exactly one may commit; the second must see the first's live sum.
    const otherPayment = (await db.salesDocumentFinance.findFirst({
      where: { salesDocumentId: docAId, id: { not: paymentAId } },
    }))!;
    const [r1, r2] = await Promise.all([
      asUser(financeSame, () =>
        cartablePost(req({ action: 'update-payment', paymentId: paymentAId, amount: 700_000 }))),
      asUser(financeSame, () =>
        cartablePost(req({ action: 'update-payment', paymentId: otherPayment.id, amount: 600_000 }))),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 400]);
    // final state: consistent — total payments ≤ finalAmount, no partial edit
    const rows = await db.salesDocumentFinance.findMany({ where: { salesDocumentId: docAId } });
    const total = rows.reduce((a, r) => a + r.amount, 0);
    expect(total).toBeLessThanOrEqual(1_000_000);
    expect(total).toBe(900_000); // 700 + 200 or 300 + 600
  });
});
