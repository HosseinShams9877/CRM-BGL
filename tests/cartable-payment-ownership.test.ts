import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// cartable-payment-ownership.test.ts — v2.58.4 (user issue 1:
// payment ownership on the accounting cartable).
//
// THE REGRESSION (confirmed on the pre-fix code): the route gate
// `!perms.accounting_cartable && !perms.finance_write` lets EVERY
// standard salesperson through (standard role carries finance_write),
// and the cartable service then applied NO ownership at all — user B
// could add payments to user A's documents and edit/delete ANYONE's
// payment rows inside their company scope. The payment creator was
// never even recorded (no createdById column), so "payment creator"
// could not be checked.
//
// THE CONTRACT (v2.58.4):
//   • SalesDocumentFinance.createdById records WHO registered the
//     payment (migration v2614, additive);
//   • a finance_write-ONLY user (standard salesperson) may operate
//     payments solely on their OWN documents, and may edit/delete
//     only payment rows THEY created (legacy NULL-creator rows are
//     denied — fail-closed);
//   • full cartable holders (accounting_cartable: admin/finance)
//     keep their finance-wide reach within the company scope;
//   • a cross-company payment operation is refused with 403;
//   • everything still runs inside ONE transaction per mutation.
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
const TAG = `r90own-${Date.now().toString(36)}`;

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

async function jsonOf(res: unknown): Promise<Record<string, unknown>> {
  return (await (res as { json: () => Promise<unknown> }).json()) as Record<string, unknown>;
}

async function mkUser(username: string, role: string, companyIds: string[]) {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`,
      displayName: username,
      passwordHash: 'x',
      role,
      companyIds: JSON.stringify(companyIds),
      businessUnitId: 'trading',
      roleLabel: '',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'trading', companyIds, jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: null, territoryCenterIds: null,
  };
}

async function mkDoc(createdById: string, companyId: string, finalAmount = 100) {
  const center = await db.center.create({
    data: {
      name: `${TAG}-${Math.random().toString(36).slice(2, 8)}`,
      customerType: 'b2b', companyId, province: 'تهران', businessUnitId: 'trading',
    },
  });
  return db.salesDocument.create({
    data: {
      businessUnitId: 'trading',
      centerId: center.id,
      companyId,
      documentNumber: `${TAG}-${Math.random().toString(36).slice(2, 8)}`,
      documentType: 'proforma',
      status: 'approved',
      totalAmount: finalAmount,
      finalAmount,
      createdById,
      items: { create: [{ productName: 'x', quantity: 1, unitPrice: finalAmount, totalPrice: finalAmount }] },
    },
  });
}

async function cleanup() {
  const docs = await db.salesDocument.findMany({
    where: { documentNumber: { startsWith: `${TAG}-` } },
    select: { id: true, centerId: true },
  });
  for (const d of docs) {
    await removeDocCascade(d.id, d.centerId);
  }
  await db.salesPaymentIdempotency.deleteMany({ where: { salesDocumentId: { in: docs.map((d) => d.id) } } });
}

/** Remove ONE document and its dependents — the per-test cleanup that
 *  never touches the shared fixtures (docA and the beforeAll payments). */
async function removeDocCascade(docId: string, centerId: string | null) {
  await db.salesDocumentFinance.deleteMany({ where: { salesDocumentId: docId } });
  await db.salesDocumentLog.deleteMany({ where: { salesDocumentId: docId } });
  if (centerId) {
    const invs = await db.issuedInvoice.findMany({ where: { salesDocumentId: docId } });
    for (const inv of invs) {
      await db.issuedInvoicePayment.deleteMany({ where: { issuedInvoiceId: inv.id } });
      await db.issuedInvoice.delete({ where: { id: inv.id } });
    }
    const acc = await db.centerAccount.findFirst({ where: { centerId } });
    if (acc) await db.centerAccount.delete({ where: { id: acc.id } });
    await db.center.delete({ where: { id: centerId } }).catch(() => undefined);
  }
  await db.salesDocument.delete({ where: { id: docId } }).catch(() => undefined);
  await db.salesPaymentIdempotency.deleteMany({ where: { salesDocumentId: docId } });
}

let userA: Awaited<ReturnType<typeof mkUser>>;      // standard, bazargani — owns docA
let userB: Awaited<ReturnType<typeof mkUser>>;      // standard, bazargani — finance_write only
let finUser: Awaited<ReturnType<typeof mkUser>>;    // finance role, bazargani
let foreign: Awaited<ReturnType<typeof mkUser>>;    // standard, yasteb — another company
let bazarganiId: string;
let docA: { id: string };

async function addPayment(actor: unknown, docId: string, amount = 30) {
  return asUser(actor, () =>
    cartablePost(req({ action: 'add-payment', salesDocumentId: docId, amount, paymentMethod: 'cash' })));
}

beforeAll(async () => {
  await cleanup();
  bazarganiId = (await db.company.findFirstOrThrow({ where: { slug: 'bazargani' } })).id;
  userA = await mkUser('a', 'standard', ['bazargani']);
  userB = await mkUser('b', 'standard', ['bazargani']);
  finUser = await mkUser('fin', 'finance', ['bazargani']);
  foreign = await mkUser('foreign', 'standard', ['yasteb']);
  docA = { id: (await mkDoc(userA.id, bazarganiId)).id };
});

afterAll(async () => {
  await cleanup();
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

// ── ADD ───────────────────────────────────────────────────────
describe('issue 1 — ADD payment ownership', () => {
  it('MANDATORY: user B (finance_write only) CANNOT pay user A\u2019s document', async () => {
    const res = await addPayment(userB, docA.id);
    expect(res.status).toBe(403);
    expect(await db.salesDocumentFinance.count({ where: { salesDocumentId: docA.id } })).toBe(0);
    const body = await jsonOf(res);
    expect(String(body.error)).not.toContain('Internal');
  });

  it('user B CAN pay their OWN document through the cartable', async () => {
    const own = await mkDoc(userB.id, bazarganiId);
    try {
      const res = await addPayment(userB, own.id, 40);
      expect(res.status).toBe(200);
      expect(await db.salesDocumentFinance.count({ where: { salesDocumentId: own.id } })).toBe(1);
    } finally {
      // per-doc cleanup ONLY — the shared docA fixture must survive
      await removeDocCascade(own.id, (await db.salesDocument.findUnique({ where: { id: own.id } }))?.centerId ?? null);
    }
  });

  it('the finance role keeps its finance-wide reach (any document in scope)', async () => {
    const res = await addPayment(finUser, docA.id, 30);
    expect(res.status).toBe(200);
    const rows = await db.salesDocumentFinance.findMany({ where: { salesDocumentId: docA.id } });
    expect(rows).toHaveLength(1);
    // the payment CREATOR is now recorded (issue 1: createdById)
    expect(rows[0].createdById).toBe(finUser.id);
  });

  it('MANDATORY: cross-company payment → 403 (no company leak into the row)', async () => {
    const res = await addPayment(foreign, docA.id);
    expect(res.status).toBe(403);
    const body = await jsonOf(res);
    expect(String(body.error)).toContain('شما به داده\u200cهای این شرکت دسترسی ندارید');
    expect(await db.salesDocumentFinance.count({ where: { salesDocumentId: docA.id } })).toBe(1); // only finUser's row
  });
});

// ── UPDATE / DELETE ───────────────────────────────────────────
describe('issue 1 — UPDATE/DELETE payment ownership', () => {
  let paymentByFin: { id: string; amount: number };

  beforeAll(async () => {
    const rows = await db.salesDocumentFinance.findMany({ where: { salesDocumentId: docA.id } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    paymentByFin = rows[0];
  });

  it('MANDATORY: user B cannot EDIT a payment created by someone else on A\u2019s document', async () => {
    const res = await asUser(userB, () =>
      cartablePost(req({ action: 'update-payment', paymentId: paymentByFin.id, amount: 50 })));
    expect(res.status).toBe(403);
    const row = await db.salesDocumentFinance.findUnique({ where: { id: paymentByFin.id } });
    expect(row!.amount).toBe(paymentByFin.amount); // untouched
  });

  it('MANDATORY: user B cannot DELETE a payment on A\u2019s document', async () => {
    const res = await asUser(userB, () =>
      cartablePost(req({ action: 'delete-payment', paymentId: paymentByFin.id })));
    expect(res.status).toBe(403);
    expect(await db.salesDocumentFinance.count({ where: { id: paymentByFin.id } })).toBe(1);
  });

  it('user B CAN edit the payment THEY created on their OWN document', async () => {
    const own = await mkDoc(userB.id, bazarganiId, 500);
    try {
      const add = await addPayment(userB, own.id, 100);
      expect(add.status).toBe(200);
      const mine = await db.salesDocumentFinance.findFirstOrThrow({ where: { salesDocumentId: own.id } });
      const upd = await asUser(userB, () =>
        cartablePost(req({ action: 'update-payment', paymentId: mine.id, amount: 120 })));
      expect(upd.status).toBe(200);
      const row = await db.salesDocumentFinance.findUnique({ where: { id: mine.id } });
      expect(row!.amount).toBe(120);
      const del = await asUser(userB, () =>
        cartablePost(req({ action: 'delete-payment', paymentId: mine.id })));
      expect(del.status).toBe(200);
      expect(await db.salesDocumentFinance.count({ where: { id: mine.id } })).toBe(0);
    } finally {
      await removeDocCascade(own.id, (await db.salesDocument.findUnique({ where: { id: own.id } }))?.centerId ?? null);
    }
  });

  it('the finance role can still edit finance\u2019s payment (finance-wide)', async () => {
    const res = await asUser(finUser, () =>
      cartablePost(req({ action: 'update-payment', paymentId: paymentByFin.id, amount: 40 })));
    expect(res.status).toBe(200);
    const row = await db.salesDocumentFinance.findUnique({ where: { id: paymentByFin.id } });
    expect(row!.amount).toBe(40);
  });

  it('a LEGACY payment row (creator NULL) is denied to finance_write-only users — fail-closed', async () => {
    // simulate a pre-v2614 row: creator column NULL
    await db.salesDocumentFinance.update({
      where: { id: paymentByFin.id },
      data: { createdById: null },
    });
    const res = await asUser(userB, () =>
      cartablePost(req({ action: 'update-payment', paymentId: paymentByFin.id, amount: 10 })));
    expect(res.status).toBe(403);
    await db.salesDocumentFinance.update({
      where: { id: paymentByFin.id },
      data: { createdById: finUser.id },
    });
  });

  it('cross-company update → 403', async () => {
    const res = await asUser(foreign, () =>
      cartablePost(req({ action: 'update-payment', paymentId: paymentByFin.id, amount: 20 })));
    expect(res.status).toBe(403);
  });

  it('update-payment rejects a STRING amount (type-first validation)', async () => {
    const res = await asUser(finUser, () =>
      cartablePost(req({ action: 'update-payment', paymentId: paymentByFin.id, amount: '60' })));
    expect(res.status).toBe(400);
    const row = await db.salesDocumentFinance.findUnique({ where: { id: paymentByFin.id } });
    expect(row!.amount).toBe(40); // untouched
  });
});
