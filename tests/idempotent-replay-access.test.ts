import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// idempotent-replay-access.test.ts — v2.58.5 (user finding R1)
//
// THE AUDIT REPRO (confirmed on the v2.58.4 code):
//   the idempotency fast path returned the STORED result BEFORE any
//   access check — a user whose company/territory/ownership access
//   was REVOKED could replay an old key and still read the payment
//   result (and, on the invoice path, bypass the company scope).
//
// THE CONTRACT (real service + real SQLite, no mocks):
//   • replay re-checks CURRENT access (company, business unit,
//     territory, ownership) with the SAME policy as a fresh payment;
//   • the replay ACCESS policy is separate from the NEW-payment
//     policy: an allowed replay NEVER creates a second receipt merely
//     because the invoice has since settled (or the doc changed
//     status) — it returns the stored one;
//   • same key + different payload → 409, zero data change;
//   • zero financial writes on a denied replay or a 409.
// Mirror path: registerInvoicePayment (billing) — same contract on
// its company scope.
// ═══════════════════════════════════════════════════════════════

import {
  addSalesDocumentPayment,
  type CartableAddPaymentInput,
} from '@/lib/cartable-payments';
import { registerInvoicePayment } from '@/lib/invoice-payments';
import { ApiError } from '@/lib/api-error';

const db = new PrismaClient();
const TAG = `r1replay-${Date.now().toString(36)}`;

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

type FixtureUser = Awaited<ReturnType<typeof mkUser>>;

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
    data: {
      name: `${TAG}-${Math.random().toString(36).slice(2, 8)}`,
      customerType: 'b2b', companyId: company.id, province: spec.province ?? 'تهران', businessUnitId: 'trading',
    },
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
        centerAccountId: account.id, salesDocumentId: doc.id,
        totalAmount: spec.finalAmount ?? 100, paidAmount: 0, status: 'issued', createdById: null,
      },
    });
    return { doc, invoiceAccount: account };
  }
  return { doc };
}

function payInput(docId: string, amount: number, date?: string): CartableAddPaymentInput {
  return {
    salesDocumentId: docId,
    amount,
    paymentMethod: 'cash',
    paymentDate: date ?? new Date().toISOString(),
    referenceNumber: '',
    description: `replay-test ${TAG}`,
  };
}
/** One STABLE logical-operation payload (R2 discipline at the service
 *  boundary too): the retry sends the SAME bytes, including the date. */
function stableInput(docId: string, amount: number): CartableAddPaymentInput {
  return payInput(docId, amount, '2026-09-06T00:00:00.000Z');
}

/** The CARTABLE policy (finance user — no ownership, no territory). */
function cartablePolicy(key: string) {
  return {
    statusPolicy: 'active-documents' as const,
    source: 'accounting-cartable' as const,
    companyDenied: { status: 403, message: 'COMPANY_ACCESS_DENIED' },
    idempotencyKey: key,
  };
}

/** The SALES policy (standard salesperson — ownership + territory). */
function salesPolicy(key: string, user: FixtureUser) {
  return {
    statusPolicy: 'approved-only' as const,
    source: 'sales-documents' as const,
    businessUnitId: 'trading',
    requireOwnership: true,
    territory: {
      mode: user.territoryMode === 'provinces' ? 'provinces' : 'country',
      provinces: user.territoryMode === 'provinces' ? JSON.parse(user.territoryProvinces as string) : [],
      centerIds: [],
    } as never,
    companyDenied: { status: 404, message: 'سند فروش یافت نشد.' },
    ownershipDenied: { status: 404, message: 'سند فروش یافت نشد.' },
    idempotencyKey: key,
  };
}

let financeUser: FixtureUser;
let sellerTeh: FixtureUser;

async function financeCount(docId: string): Promise<number> {
  return db.salesDocumentFinance.count({ where: { salesDocumentId: docId } });
}

async function cleanup() {
  const docs = await db.salesDocument.findMany({ where: { documentNumber: { startsWith: `${TAG}-` } }, select: { id: true, centerId: true } });
  for (const d of docs) {
    await db.salesPaymentIdempotency.deleteMany({ where: { salesDocumentId: d.id } }).catch(() => undefined);
    await db.salesDocumentFinance.deleteMany({ where: { salesDocumentId: d.id } });
    await db.salesDocumentLog.deleteMany({ where: { salesDocumentId: d.id } });
    if (d.centerId) {
      const invs = await db.issuedInvoice.findMany({ where: { salesDocumentId: d.id } });
      for (const inv of invs) {
        await db.issuedInvoicePaymentIdempotency.deleteMany({ where: { invoiceId: inv.id } }).catch(() => undefined);
        await db.issuedInvoicePayment.deleteMany({ where: { issuedInvoiceId: inv.id } });
        await db.issuedInvoice.delete({ where: { id: inv.id } });
      }
      await db.centerAccount.deleteMany({ where: { centerId: d.centerId } });
      await db.center.delete({ where: { id: d.centerId } }).catch(() => undefined);
    }
    await db.salesDocument.delete({ where: { id: d.id } }).catch(() => undefined);
  }
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

// ── R1.1: company access revoked between payment and replay ──
describe('R1.1 — replay after company access revocation (cartable)', () => {
  it('denies the replay WITHOUT disclosing the stored result; zero new receipts', async () => {
    const { doc } = await mkDoc({ createdById: financeUser.id, withLinkedInvoice: true });
    try {
      const payload = stableInput(doc.id, 20);
      const first = await addSalesDocumentPayment(financeUser, payload, cartablePolicy('r1-company-key'));
      expect(first.replayed).toBe(false);
      expect(await financeCount(doc.id)).toBe(1);

      // access revoked: the user's company scope shrinks to nothing
      await db.user.update({ where: { id: financeUser.id }, data: { companyIds: '[]' } });
      const revokedUser = { ...financeUser, companyIds: [] as string[] };

      await expect(
        addSalesDocumentPayment(revokedUser, payload, cartablePolicy('r1-company-key')),
      ).rejects.toMatchObject({ status: 403 });

      // still exactly one receipt — a denied replay wrote NOTHING
      expect(await financeCount(doc.id)).toBe(1);
    } finally {
      await db.user.update({ where: { id: financeUser.id }, data: { companyIds: JSON.stringify(['bazargani']) } });
      await cleanup();
    }
  }, 20_000);
});

// ── R1.2: territory change → current policy applies on replay ──
describe('R1.2 — replay after territory change (sales policy)', () => {
  it('denies the replay when the doc left the user\u2019s current territory', async () => {
    const { doc } = await mkDoc({ createdById: sellerTeh.id, province: 'تهران' });
    try {
      const payload = stableInput(doc.id, 10);
      const first = await addSalesDocumentPayment(sellerTeh, payload, salesPolicy('r1-territory-key', sellerTeh));
      expect(first.replayed).toBe(false);

      // territory shrinks to a different province
      await db.user.update({ where: { id: sellerTeh.id }, data: { territoryProvinces: JSON.stringify(['خراسان رضوی']) } });
      const movedUser = { ...sellerTeh, territoryProvinces: JSON.stringify(['خراسان رضوی']) };

      await expect(
        addSalesDocumentPayment(movedUser, payload, salesPolicy('r1-territory-key', movedUser)),
      ).rejects.toMatchObject({ status: 404 });
      expect(await financeCount(doc.id)).toBe(1);
    } finally {
      await db.user.update({ where: { id: sellerTeh.id }, data: { territoryProvinces: JSON.stringify(['تهران']) } });
      await cleanup();
    }
  }, 20_000);

  it('denies the replay when ownership of the doc moved to a colleague', async () => {
    const { doc } = await mkDoc({ createdById: sellerTeh.id, province: 'تهران' });
    try {
      const payload = stableInput(doc.id, 10);
      const first = await addSalesDocumentPayment(sellerTeh, payload, salesPolicy('r1-own-key', sellerTeh));
      expect(first.replayed).toBe(false);

      // the doc is reassigned to a colleague → the seller no longer owns it
      const colleague = await mkUser('colleague', 'standard', ['bazargani'], ['تهران']);
      await db.salesDocument.update({ where: { id: doc.id }, data: { createdById: colleague.id } });

      await expect(
        addSalesDocumentPayment(sellerTeh, payload, salesPolicy('r1-own-key', sellerTeh)),
      ).rejects.toMatchObject({ status: 404 });
      expect(await financeCount(doc.id)).toBe(1);
      await db.user.delete({ where: { id: colleague.id } });
    } finally {
      await cleanup();
    }
  }, 20_000);
});

// ── R1.3: an ALLOWED replay never creates a second receipt ──
describe('R1.3 — allowed replay returns the SAME receipt, creates none', () => {
  it('settled invoice + valid access → same payment id, replayed=true, one receipt', async () => {
    const { doc } = await mkDoc({ createdById: financeUser.id, finalAmount: 20, withLinkedInvoice: true });
    try {
      const payload = stableInput(doc.id, 20);
      const first = await addSalesDocumentPayment(financeUser, payload, cartablePolicy('r1-allow-key'));
      expect(first.replayed).toBe(false);

      // invoice is now fully settled — replay must NOT grow a receipt
      const replay = await addSalesDocumentPayment(financeUser, payload, cartablePolicy('r1-allow-key'));
      expect(replay.replayed).toBe(true);
      expect(replay.record.id).toBe(first.record.id);
      expect(await financeCount(doc.id)).toBe(1);
      const paid = await db.salesDocumentFinance.aggregate({ where: { salesDocumentId: doc.id }, _sum: { amount: true } });
      expect(paid._sum.amount ?? 0).toBe(20);
    } finally {
      await cleanup();
    }
  }, 20_000);
});

// ── R1.4: same key + different payload → 409, zero data change ──
describe('R1.4 — key reuse with a different payload stays a 409', () => {
  it('409 + no new receipt + no stored-result mutation', async () => {
    const { doc } = await mkDoc({ createdById: financeUser.id, withLinkedInvoice: true });
    try {
      await addSalesDocumentPayment(financeUser, payInput(doc.id, 20), cartablePolicy('r1-conflict-key'));
      const before = await financeCount(doc.id);

      await expect(
        addSalesDocumentPayment(financeUser, payInput(doc.id, 30), cartablePolicy('r1-conflict-key')),
      ).rejects.toMatchObject({ status: 409 });
      expect(await financeCount(doc.id)).toBe(before);
    } finally {
      await cleanup();
    }
  }, 20_000);
});

// ── R1 mirror path: registerInvoicePayment (billing) ──
describe('R1 mirror — registerInvoicePayment replay honors the CURRENT company scope', () => {
  it('allowed payment → company revoked → replay denied (404) without disclosure', async () => {
    const company = await db.company.findFirstOrThrow({ where: { slug: 'bazargani' } });
    const { doc, invoiceAccount } = await mkDoc({ createdById: financeUser.id, withLinkedInvoice: true });
    try {
      const invoice = await db.issuedInvoice.findFirstOrThrow({ where: { salesDocumentId: doc.id } });
      const base = {
        invoiceId: invoice.id,
        referenceNumber: '',
        description: `mirror ${TAG}`,
        source: 'manual' as const,
        userId: financeUser.id,
      };
      const first = await registerInvoicePayment({ ...base, amount: 15, allowedCompanyIds: [company.id], idempotencyKey: 'r1-inv-key' });
      expect(first.replayed).toBe(false);
      expect(await db.issuedInvoicePayment.count({ where: { issuedInvoiceId: invoice.id } })).toBe(1);

      // company scope revoked for the caller
      const denied = await registerInvoicePayment({ ...base, amount: 15, allowedCompanyIds: [], idempotencyKey: 'r1-inv-key' })
        .catch((e: unknown) => e as ApiError);
      expect(denied instanceof ApiError).toBe(true);
      expect((denied as ApiError).status).toBe(404);
      expect(await db.issuedInvoicePayment.count({ where: { issuedInvoiceId: invoice.id } })).toBe(1);

      // allowed again → same receipt, no second payment
      const replay = await registerInvoicePayment({ ...base, amount: 15, allowedCompanyIds: [company.id], idempotencyKey: 'r1-inv-key' });
      expect(replay.replayed).toBe(true);
      expect(replay.payment?.id ?? replay.payment).not.toBeNull();
      expect(await db.issuedInvoicePayment.count({ where: { issuedInvoiceId: invoice.id } })).toBe(1);
      void invoiceAccount;
    } finally {
      await cleanup();
    }
  }, 20_000);
});
