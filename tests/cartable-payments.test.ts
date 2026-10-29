import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  addCartablePayment,
  updateCartablePayment,
  deleteCartablePayment,
  parseAddPaymentBody,
  parseUpdatePaymentBody,
} from '@/lib/cartable-payments';
import { ApiError } from '@/lib/api-error';

// ═══════════════════════════════════════════════════════════════
// cartable-payments.test.ts — v2.58.3 (round 88, finding 3)
//
// THE REVIEWER'S MANDATORY RACE TEST, through the REAL mutation path
// (the same functions the /api/accounting-cartable route executes —
// real Prisma transactions on real SQLite, no mocked sums):
//
//   «Build a 100-unit document with two 40-unit payments. Two
//    concurrent requests each raise one payment to 60. The final
//    total must not exceed 100; one request must be rejected or
//    safely re-evaluated.»
//
// Before the fix, handleUpdatePayment summed the OTHER payments
// BEFORE the transaction, so both edits passed on the same stale
// snapshot and committed 120.
//
// Plus: in-tx guards for the add path (live finalAmount + effective
// status), access checks on in-tx data, integer-Rial validation,
// rollback of partial writes, and delete through the same door.
// ═══════════════════════════════════════════════════════════════

const db = new PrismaClient();
const TAG = `r88-${Date.now()}`;

function adminUser() {
  return {
    id: 'test-admin-user',
    username: 'admin',
    displayName: 'Test Admin',
    role: 'admin' as const,
    roleLabel: 'مدیر سیستم',
    businessUnitId: 'production',
    companyIds: [] as string[],
    jobTitle: null,
    isActive: true,
    impersonator: null,
    territoryMode: 'country' as const,
    territoryProvinces: null,
    territoryCenterIds: null,
  };
}

function foreignUser() {
  // a scoped non-admin of an unrelated company — company-gate checks
  return {
    ...adminUser(),
    id: 'test-foreign-user',
    username: 'foreign',
    displayName: 'Foreign User',
    role: 'standard' as const,
    companyIds: ['yasteb'],
  };
}

async function mkDocAndPayments(finalAmount: number, payments: number[]) {
  const company = await db.company.findFirst({ where: { slug: 'bazargani' } });
  const center = await db.center.create({
    data: {
      name: `کارتابل-آزمون-${TAG}`,
      customerType: 'b2b',
      province: 'تهران',
      companyId: company!.id,
      businessUnitId: 'trading',
    },
  });
  const doc = await db.salesDocument.create({
    data: {
      documentNumber: `R88-${TAG}-${Math.random().toString(36).slice(2, 8)}`,
      documentType: 'invoice',
      status: 'approved',
      totalAmount: finalAmount,
      discountAmount: 0,
      taxAmount: 0,
      finalAmount,
      centerId: center.id,
      companyId: company!.id,
      businessUnitId: 'trading',
    },
  });
  const rows = [];
  for (const amount of payments) {
    rows.push(await db.salesDocumentFinance.create({
      data: {
        salesDocumentId: doc.id,
        paymentMethod: 'cash',
        paymentDate: new Date(),
        amount,
        description: `${TAG}`,
      },
    }));
  }
  return { doc, rows };
}

async function financeSum(salesDocumentId: string) {
  const agg = await db.salesDocumentFinance.aggregate({
    _sum: { amount: true },
    where: { salesDocumentId },
  });
  return agg._sum.amount || 0;
}

async function cleanup() {
  const docs = await db.salesDocument.findMany({
    where: { description: { contains: TAG } },
    select: { id: true, centerId: true },
  });
  // fallback: find by finance description tag
  const fin = await db.salesDocumentFinance.findMany({
    where: { description: { contains: TAG } },
    select: { salesDocumentId: true },
  });
  const docIds = new Set([...docs.map((d) => d.id), ...fin.map((f) => f.salesDocumentId)]);
  for (const id of docIds) {
    await db.salesDocumentFinance.deleteMany({ where: { salesDocumentId: id } });
    const doc = await db.salesDocument.findUnique({ where: { id }, select: { centerId: true } });
    await db.salesDocument.delete({ where: { id } }).catch(() => undefined);
    if (doc?.centerId) {
      await db.center.delete({ where: { id: doc.centerId } }).catch(() => undefined);
    }
  }
}

beforeAll(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe('parse validation (integer-Rial + shape)', () => {
  it('add body: negative / fractional / non-finite amounts are refused', () => {
    expect(() => parseAddPaymentBody({ salesDocumentId: 'x', amount: -5 })).toThrow(ApiError);
    expect(() => parseAddPaymentBody({ salesDocumentId: 'x', amount: 10.5 })).toThrow(ApiError);
    expect(() => parseAddPaymentBody({ salesDocumentId: 'x', amount: NaN })).toThrow(ApiError);
    expect(() => parseAddPaymentBody({ salesDocumentId: 'x', amount: Infinity })).toThrow(ApiError);
  });

  it('update body: paymentId required; amount positive integer', () => {
    expect(() => parseUpdatePaymentBody({})).toThrow(ApiError);
    expect(() => parseUpdatePaymentBody({ paymentId: 'p', amount: 0 })).toThrow(ApiError);
    expect(() => parseUpdatePaymentBody({ paymentId: 'p', amount: 10.5 })).toThrow(ApiError);
    expect(() => parseUpdatePaymentBody({ paymentId: 'p', amount: NaN })).toThrow(ApiError);
    expect(parseUpdatePaymentBody({ paymentId: 'p', amount: 60 })).toMatchObject({ paymentId: 'p', amount: 60 });
  });
});

describe('F3 MANDATORY — concurrent payment edits (the 100 = 40+40, both→60 race)', () => {
  it('final sum never exceeds the document total; exactly one edit survives', async () => {
    const { doc, rows } = await mkDocAndPayments(100, [40, 40]);
    expect(rows).toHaveLength(2);
    expect(await financeSum(doc.id)).toBe(80);

    // TWO CONCURRENT edits through the REAL mutation path — each raises
    // its own payment to 60. Whichever transaction commits second must
    // re-evaluate against the committed state and be refused.
    const results = await Promise.allSettled([
      updateCartablePayment(adminUser(), { paymentId: rows[0].id, amount: 60 }),
      updateCartablePayment(adminUser(), { paymentId: rows[1].id, amount: 60 }),
    ]);

    const settled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // one wins, one is refused (or safely re-evaluated to failure)
    expect(settled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const reason = rejected[0] as PromiseRejectedResult;
    expect(reason.reason).toBeInstanceOf(ApiError);
    expect(reason.reason.status).toBe(400);

    // THE ACCEPTANCE CRITERION: total never exceeds 100
    const total = await financeSum(doc.id);
    expect(total).toBeLessThanOrEqual(100);
    expect(total).toBe(100); // 40 kept + 60 applied = exactly the cap

    // no partial write: the rejected row kept its original amount
    const live = await db.salesDocumentFinance.findMany({ where: { salesDocumentId: doc.id } });
    expect(live.map((r) => r.amount).sort((a, b) => a - b)).toEqual([40, 60]);
  });

  it('run twice more — the race stays closed under repetition', async () => {
    for (let round = 0; round < 2; round++) {
      const { doc, rows } = await mkDocAndPayments(100, [40, 40]);
      const results = await Promise.allSettled([
        updateCartablePayment(adminUser(), { paymentId: rows[0].id, amount: 60 }),
        updateCartablePayment(adminUser(), { paymentId: rows[1].id, amount: 60 }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await financeSum(doc.id)).toBe(100);
    }
  });
});

describe('add path — in-tx document data (finding 3 sibling)', () => {
  it('finalAmount and status come from the in-transaction row', async () => {
    const { doc } = await mkDocAndPayments(100, [30]);
    // 30 + 80 > 100 → refused with the in-tx sum message
    await expect(
      addCartablePayment(adminUser(), { salesDocumentId: doc.id, amount: 80 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await financeSum(doc.id)).toBe(30); // unchanged

    // 30 + 70 = 100 exactly → allowed
    await addCartablePayment(adminUser(), { salesDocumentId: doc.id, amount: 70 });
    expect(await financeSum(doc.id)).toBe(100);
  });

  it('cancelled documents refuse new payments (effective status in-tx)', async () => {
    const { doc } = await mkDocAndPayments(100, []);
    await db.salesDocument.update({ where: { id: doc.id }, data: { status: 'cancelled' } });
    await expect(
      addCartablePayment(adminUser(), { salesDocumentId: doc.id, amount: 10 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await financeSum(doc.id)).toBe(0);
  });

  it('company access is checked against the LIVE document row (foreign user → 403, cartable convention)', async () => {
    const { doc } = await mkDocAndPayments(100, []);
    // v2.58.4 (user issue 1): the cartable restores its explicit 403 +
    // COMPANY_ACCESS_DENIED for a cross-company operation (its pre-v2.58.4
    // behavior and the user's mandatory matrix — «异公司 403»). The SALES
    // route keeps the 404 no-existence-leak convention; the cartable's
    // denial message says "no access to THIS company", not "not found".
    await expect(
      addCartablePayment(foreignUser(), { salesDocumentId: doc.id, amount: 10 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      updateCartablePayment(foreignUser(), { paymentId: 'whatever', amount: 10 }),
    ).rejects.toMatchObject({ status: 404 }); // unknown id first → 404, no leak
    expect(await financeSum(doc.id)).toBe(0);
  });
});

describe('rollback + delete through the same door', () => {
  it('a failed edit leaves the row and the totals untouched', async () => {
    const { doc, rows } = await mkDocAndPayments(100, [50]);
    await expect(
      updateCartablePayment(adminUser(), { paymentId: rows[0].id, amount: 200 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await financeSum(doc.id)).toBe(50);
    const live = await db.salesDocumentFinance.findUnique({ where: { id: rows[0].id } });
    expect(live?.amount).toBe(50);
  });

  it('delete removes the row and keeps the rebuild atomic', async () => {
    const { doc, rows } = await mkDocAndPayments(100, [40, 60]);
    await deleteCartablePayment(adminUser(), rows[0].id);
    expect(await financeSum(doc.id)).toBe(60);
    await expect(deleteCartablePayment(adminUser(), rows[0].id)).rejects.toMatchObject({ status: 404 });
  });
});
