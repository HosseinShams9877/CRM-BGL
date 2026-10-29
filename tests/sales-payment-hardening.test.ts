import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// sales-payment-hardening.test.ts — v2.58.4 (external audit F03/F04)
//
// THE AUDIT REPROS (both confirmed on the pre-fix code):
//   F03 — handleAddPayment validated money with `Number(amount) > 0`:
//   0.5 (fractional Rial) reached the receipt path and was written
//   (SALES_FRACTIONAL_PAYMENT {status:200, writtenAmount:0.5}); the
//   territory scope was never applied; paymentDate was unvalidated.
//   F04 — the audit log was written AFTER the payment committed:
//   a log failure returned an error with the money already booked, and
//   a client retry created a SECOND receipt (PAYMENT_RETRY_AFTER_
//   LOG_FAILURE: payments=2, total=40 on a 20-Rial payment).
//
// THE MANDATORY MATRIX (real handler + real service + real SQLite):
//   • invalid types/amounts/dates → 400 with ZERO side effects;
//   • out-of-territory document → 404; cancelled/rejected → 400;
//   • concurrent 60+60 on a 100 document → exactly one committed;
//   • an audit-log failure (injected via a real FK violation on
//     SalesDocumentLog.userId) rolls the payment back — a retry with a
//     real user books EXACTLY ONE receipt and ONE balance effect;
//   • idempotency: same key + payload → replayed result (one receipt);
//     same key + different payload → 409;
//   • the finance mirror stays consistent after create/replay.
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as salesPost } from '@/app/api/sales-documents/route';
import {
  parseAddPaymentBody,
  addSalesDocumentPayment,
} from '@/lib/cartable-payments';
import { ApiError } from '@/lib/api-error';

const db = new PrismaClient();
const TAG = `r89p-${Date.now().toString(36)}`;

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

async function mkUser(username: string, role: string, companyIds: string[], territory?: string[]) {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`,
      displayName: username,
      passwordHash: 'x',
      role,
      companyIds: JSON.stringify(companyIds),
      businessUnitId: 'trading',
      territoryMode: territory ? 'provinces' : 'country',
      territoryProvinces: JSON.stringify(territory ?? []),
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'trading', companyIds, jobTitle: null, isActive: true, impersonator: null,
    territoryMode: territory ? 'provinces' : 'country',
    territoryProvinces: JSON.stringify(territory ?? []), territoryCenterIds: '[]',
  };
}

async function mkDoc(spec: {
  createdById: string;
  status?: string;
  province?: string;
  companyId?: string;
  finalAmount?: number;
  withLinkedInvoice?: boolean;
}) {
  const company = spec.companyId
    ? { id: spec.companyId }
    : await db.company.findFirstOrThrow({ where: { slug: 'bazargani' } });
  const center = await db.center.create({
    data: { name: `${TAG}-${Math.random().toString(36).slice(2, 8)}`, customerType: 'b2b', companyId: company.id, province: spec.province ?? 'تهران', businessUnitId: 'trading' },
  });
  const doc = await db.salesDocument.create({
    data: {
      businessUnitId: 'trading',
      centerId: center.id,
      companyId: company.id,
      documentNumber: `${TAG}-${Math.random().toString(36).slice(2, 8)}`,
      documentType: 'proforma',
      status: spec.status ?? 'approved',
      totalAmount: spec.finalAmount ?? 100,
      finalAmount: spec.finalAmount ?? 100,
      createdById: spec.createdById,
      items: { create: [{ productName: 'x', quantity: 1, unitPrice: spec.finalAmount ?? 100, totalPrice: spec.finalAmount ?? 100 }] },
    },
  });
  if (spec.withLinkedInvoice) {
    const account = await db.centerAccount.create({
      data: { centerId: center.id, totalSales: spec.finalAmount ?? 100, totalPaid: 0, balance: spec.finalAmount ?? 100 },
    });
    await db.issuedInvoice.create({
      data: {
        centerAccountId: account.id,
        salesDocumentId: doc.id,
        totalAmount: spec.finalAmount ?? 100,
        paidAmount: 0,
        status: 'issued',
        createdById: null,
      },
    });
  }
  return doc;
}

let financeUser: Awaited<ReturnType<typeof mkUser>>;
let sellerTeh: Awaited<ReturnType<typeof mkUser>>;

async function financeCount(docId: string): Promise<number> {
  return db.salesDocumentFinance.count({ where: { salesDocumentId: docId } });
}

async function cleanup() {
  const docs = await db.salesDocument.findMany({ where: { documentNumber: { startsWith: `${TAG}-` } }, select: { id: true, centerId: true } });
  for (const d of docs) {
    await db.salesDocumentFinance.deleteMany({ where: { salesDocumentId: d.id } });
    await db.salesDocumentLog.deleteMany({ where: { salesDocumentId: d.id } });
    if (d.centerId) {
      const invs = await db.issuedInvoice.findMany({ where: { salesDocumentId: d.id } });
      for (const inv of invs) {
        await db.issuedInvoicePayment.deleteMany({ where: { issuedInvoiceId: inv.id } });
        await db.issuedInvoice.delete({ where: { id: inv.id } });
      }
      const acc = await db.centerAccount.findFirst({ where: { centerId: d.centerId } });
      if (acc) await db.centerAccount.delete({ where: { id: acc.id } });
      await db.center.delete({ where: { id: d.centerId } }).catch(() => undefined);
    }
    await db.salesDocument.delete({ where: { id: d.id } }).catch(() => undefined);
  }
  // NOTE: fixture USERS survive the per-test cleanup (documents reference
  // them by FK); they are removed once in afterAll.
}

beforeAll(async () => {
  await cleanup();
  financeUser = await mkUser('finance', 'finance', ['bazargani']);
  sellerTeh = await mkUser('seller-teh', 'standard', ['bazargani'], ['تهران']);
});

afterAll(async () => {
  await cleanup();
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

describe('F03 — strict input validation (mandatory matrix, through the REAL handler)', () => {
  const badPayloads: Array<[string, unknown]> = [
    ['fractional 0.5', { amount: 0.5 }],
    ['string amount', { amount: '20000' }],
    ['boolean amount', { amount: true }],
    ['null amount', { amount: null }],
    ['NaN', { amount: NaN }],
    ['Infinity', { amount: Infinity }],
    ['negative', { amount: -1000 }],
    ['zero', { amount: 0 }],
    ['over-cap', { amount: 1e13 }],
    ['array amount', { amount: [1000] }],
    ['invalid date', { amount: 1000, paymentDate: 'not-a-date' }],
  ];

  it.each(badPayloads)('rejects %s with 400 and ZERO side effects', async (label, overrides) => {
    const doc = await mkDoc({ createdById: financeUser.id, withLinkedInvoice: true });
    try {
      const res = await asUser(financeUser, () => salesPost(req({
        action: 'add-payment', id: doc.id, paymentMethod: 'cash', ...(overrides as Record<string, unknown>),
      })));
      expect(res.status).toBe(400);
      expect(await financeCount(doc.id)).toBe(0);
      const body = await jsonOf(res);
      expect(String(body.error)).not.toContain('Internal');
      expect(String(body.error)).not.toContain('Prisma');
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('accepts a VALID amount once (regression guard — the matrix must not reject honest money)', async () => {
    const doc = await mkDoc({ createdById: financeUser.id, withLinkedInvoice: true });
    try {
      const res = await asUser(financeUser, () => salesPost(req({
        action: 'add-payment', id: doc.id, paymentMethod: 'cash', amount: 40,
      })));
      expect(res.status).toBe(200);
      expect(await financeCount(doc.id)).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('out-of-territory document → 404 (the pre-fix path never applied territory)', async () => {
    // sellerTeh owns a document whose center sits OUTSIDE their territory
    const doc = await mkDoc({ createdById: sellerTeh.id, province: 'خوزستان' });
    try {
      const res = await asUser(sellerTeh, () => salesPost(req({
        action: 'add-payment', id: doc.id, paymentMethod: 'cash', amount: 10,
      })));
      expect(res.status).toBe(404);
      expect(await financeCount(doc.id)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('cancelled / rejected documents refuse money (controlled 400)', async () => {
    for (const status of ['cancelled', 'rejected', 'draft'] as const) {
      const doc = await mkDoc({ createdById: financeUser.id, status });
      try {
        const res = await asUser(financeUser, () => salesPost(req({
          action: 'add-payment', id: doc.id, paymentMethod: 'cash', amount: 10,
        })));
        expect(res.status).toBe(400);
        expect(await financeCount(doc.id)).toBe(0);
      } finally {
        await cleanup();
      }
    }
  }, 30_000);

  it('ownership: a standard salesperson cannot pay a COLLEAGUE\u2019s document', async () => {
    const otherSeller = await mkUser('other-seller', 'standard', ['bazargani']);
    const doc = await mkDoc({ createdById: otherSeller.id });
    try {
      const res = await asUser(sellerTeh, () => salesPost(req({
        action: 'add-payment', id: doc.id, paymentMethod: 'cash', amount: 10,
      })));
      expect(res.status).toBe(404);
      expect(await financeCount(doc.id)).toBe(0);
    } finally {
      await cleanup();
      await db.user.delete({ where: { id: otherSeller.id } });
    }
  });
});

describe('F04 — atomic audit log + idempotency (real service, real SQLite)', () => {
  it('an audit-log failure ROLLS THE PAYMENT BACK (the pre-fix flow committed it)', async () => {
    const doc = await mkDoc({ createdById: financeUser.id, finalAmount: 100, withLinkedInvoice: true });
    // REAL failure injection on real SQLite: a BEFORE-INSERT trigger on
    // SalesDocumentLog that ABORTs the log write for THIS document — the
    // payment row is already written when the log insert fires, exactly
    // the audit's "failure after the operation" scenario.
    await db.$executeRawUnsafe(
      `CREATE TRIGGER r89_fail_log_${doc.id.replace(/-/g, '_')} BEFORE INSERT ON "SalesDocumentLog"
       WHEN NEW."salesDocumentId" = '${doc.id}'
       BEGIN SELECT RAISE(ABORT, 'injected audit-log failure'); END`,
    );
    const input = parseAddPaymentBody({ action: 'add-payment', salesDocumentId: doc.id, amount: 20, paymentMethod: 'cash' });
    try {
      await expect(
        addSalesDocumentPayment(financeUser, input, {
          statusPolicy: 'approved-only', businessUnitId: 'trading', logAction: 'add_payment', source: 'sales-documents',
        }),
      ).rejects.toThrow();

      // THE audit assertion: NOTHING survived the log failure
      expect(await financeCount(doc.id)).toBe(0);
      const invoice = await db.issuedInvoice.findFirst({ where: { salesDocumentId: doc.id } });
      expect(invoice?.paidAmount ?? 0).toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS r89_fail_log_${doc.id.replace(/-/g, '_')}`);
    }

    // retry with the log healthy again → exactly ONE receipt, ONE balance effect
    const retryInput = parseAddPaymentBody({ action: 'add-payment', salesDocumentId: doc.id, amount: 20, paymentMethod: 'cash' });
    await addSalesDocumentPayment(financeUser, retryInput, {
      statusPolicy: 'approved-only', businessUnitId: 'trading', logAction: 'add_payment', source: 'sales-documents',
    });
    expect(await financeCount(doc.id)).toBe(1);
    const invoiceAfter = await db.issuedInvoice.findFirst({ where: { salesDocumentId: doc.id } });
    expect(invoiceAfter?.paidAmount).toBe(20);
    await cleanup();
  });

  it('same key + same payload → replayed result (ONE receipt ever); same key + different payload → 409', async () => {
    const doc = await mkDoc({ createdById: financeUser.id, finalAmount: 100, withLinkedInvoice: true });
    const mk = (amount: number) => parseAddPaymentBody({ action: 'add-payment', salesDocumentId: doc.id, amount, paymentMethod: 'cash' });
    const policy = {
      statusPolicy: 'approved-only' as const, businessUnitId: 'trading', logAction: 'add_payment', source: 'sales-documents' as const,
    };

    const first = await addSalesDocumentPayment(financeUser, mk(20), { ...policy, idempotencyKey: 'key-1' });
    expect(first.replayed).toBe(false);

    const replay = await addSalesDocumentPayment(financeUser, mk(20), { ...policy, idempotencyKey: 'key-1' });
    expect(replay.replayed).toBe(true);
    expect(replay.record.id).toBe(first.record.id);

    await expect(
      addSalesDocumentPayment(financeUser, mk(30), { ...policy, idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({ status: 409 });

    expect(await financeCount(doc.id)).toBe(1); // ONE receipt, ever
    await cleanup();
  });

  it('two CONCURRENT 60-Rial payments on a 100 document → exactly one committed', async () => {
    const doc = await mkDoc({ createdById: financeUser.id, finalAmount: 100, withLinkedInvoice: true });
    const mk = () => parseAddPaymentBody({ action: 'add-payment', salesDocumentId: doc.id, amount: 60, paymentMethod: 'cash' });
    const policy = {
      statusPolicy: 'approved-only' as const, businessUnitId: 'trading', logAction: 'add_payment', source: 'sales-documents' as const,
    };
    const results = await Promise.allSettled([
      addSalesDocumentPayment(financeUser, mk(), { ...policy, idempotencyKey: 'race-a' }),
      addSalesDocumentPayment(financeUser, mk(), { ...policy, idempotencyKey: 'race-b' }),
    ]);
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected');
    expect(okCount).toBe(1);
    expect(refused).toHaveLength(1);
    for (const r of refused) {
      expect((r.reason as ApiError).status).toBe(400); // controlled overpayment refusal
    }
    const rows = await db.salesDocumentFinance.findMany({ where: { salesDocumentId: doc.id } });
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(60); // never 120
    await cleanup();
  });

  it('mirror consistency after create + replay (finance rows = invoice payments = account)', async () => {
    const doc = await mkDoc({ createdById: financeUser.id, finalAmount: 100, withLinkedInvoice: true });
    const mk = () => parseAddPaymentBody({ action: 'add-payment', salesDocumentId: doc.id, amount: 40, paymentMethod: 'cash' });
    const policy = {
      statusPolicy: 'approved-only' as const, businessUnitId: 'trading', logAction: 'add_payment', source: 'sales-documents' as const,
    };
    await addSalesDocumentPayment(financeUser, mk(), { ...policy, idempotencyKey: 'mirror-1' });
    await addSalesDocumentPayment(financeUser, mk(), { ...policy, idempotencyKey: 'mirror-1' }); // replay

    const financeSum = (await db.salesDocumentFinance.aggregate({ _sum: { amount: true }, where: { salesDocumentId: doc.id } }))._sum.amount || 0;
    const invoice = await db.issuedInvoice.findFirst({ where: { salesDocumentId: doc.id } });
    const invoicePayments = (await db.issuedInvoicePayment.aggregate({ _sum: { amount: true }, where: { issuedInvoiceId: invoice!.id } }))._sum.amount || 0;
    expect(financeSum).toBe(40); // the replay added nothing
    expect(invoicePayments).toBe(40);
    expect(invoice!.paidAmount).toBe(40);
    const account = await db.centerAccount.findFirst({ where: { centerId: doc.centerId ?? undefined } });
    expect(account?.totalPaid).toBe(40);
    await cleanup();
  });
});
