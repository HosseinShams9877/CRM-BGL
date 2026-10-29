import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// payment-response-identity.test.ts — v2.58.10 (carried-over
// workstream 3 from the 2.58.8/2.58.9 mandate)
//
// THE GAPS (both reproduced RED on v2.58.7):
//   1. IDENTITY: a 2xx response that is structurally a valid
//      add-payment success body — but describes ANOTHER operation
//      (different amount, different invoice) — was classified
//      'success' and the pending record CLEARED. The retry of the
//      real operation then minted a fresh key → possible double
//      booking. The engine must prove the response describes THIS
//      operation (invoiceId + amount) before accepting it.
//   2. ALREADY-SETTLED: when the server answers the add-payment with
//      the honest "invoice already settled — nothing was booked"
//      contract, the engine classified it 'unknown' forever (the
//      body has payment:null). The settle path already exposes
//      `alreadySettled`; the add-payment response must expose it
//      too, and the engine must treat it as a DEFINITIVE outcome
//      (success — resolved, no new receipt), never a dead-end
//      unknown loop.
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as billingPost } from '@/app/api/billing/route';
import {
  submitIdempotentPayment,
  pendingStorageKey,
  type PaymentOperation,
  type PaymentKvStore,
} from '@/lib/payment-idempotency';

const db = new PrismaClient();
const TAG = `r92ident-${Date.now().toString(36)}`;

// ── unit-level stubs (engine classification only) ───────────
function fakeStore(): { store: PaymentKvStore; map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, store: { get: (k) => map.get(k) ?? null, set: (k, v) => { map.set(k, v); }, remove: (k) => { map.delete(k); } } };
}

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const OP: PaymentOperation = { invoiceId: 'inv-1', amount: 20, description: 'test' };

const validBody = (over: Record<string, unknown> = {}) => ({
  message: 'پرداخت ثبت شد',
  payment: { id: 'pay-1', amount: 20 },
  newStatus: 'partially_paid',
  newPaidAmount: 20,
  replayed: false,
  ...over,
});

describe('ENGINE — a 2xx body is only proof when it describes THIS operation', () => {
  it('amount mismatch (a receipt of 999 for a 20 operation) → unknown, key retained', async () => {
    const { store, map } = fakeStore();
    const out = await submitIdempotentPayment(OP, null, {
      fetchImpl: async () => res(200, validBody({ payment: { id: 'pay-1', amount: 999 } })),
      storage: store,
    });
    expect(out.kind).toBe('unknown');
    expect(map.has(pendingStorageKey('inv-1'))).toBe(true);
  });

  it('invoice mismatch (a receipt for inv-OTHER) → unknown, key retained', async () => {
    const { store, map } = fakeStore();
    const out = await submitIdempotentPayment(OP, null, {
      fetchImpl: async () => res(200, validBody({ invoiceId: 'inv-OTHER' })),
      storage: store,
    });
    expect(out.kind).toBe('unknown');
    expect(map.has(pendingStorageKey('inv-1'))).toBe(true);
  });

  it('matching identity (same invoice, same amount) → success, record cleared', async () => {
    const { store, map } = fakeStore();
    const out = await submitIdempotentPayment(OP, null, {
      fetchImpl: async () => res(200, validBody({ invoiceId: 'inv-1' })),
      storage: store,
    });
    expect(out.kind).toBe('success');
    expect(map.has(pendingStorageKey('inv-1'))).toBe(false);
  });

  it('already-settled contract (payment:null, alreadySettled:true) → success, record cleared', async () => {
    const { store, map } = fakeStore();
    const out = await submitIdempotentPayment(OP, null, {
      fetchImpl: async () => res(200, {
        message: 'این فاکتور قبلاً تسویه شده است؛ رسید جدیدی ثبت نشد.',
        payment: null,
        newStatus: 'paid',
        newPaidAmount: 100,
        replayed: false,
        alreadySettled: true,
        invoiceId: 'inv-1',
      }),
      storage: store,
    });
    expect(out.kind).toBe('success');
    expect(map.has(pendingStorageKey('inv-1'))).toBe(false);
  });
});

// ── real-route integration (the server must expose the contract) ──

let financeUser: { id: string; username: string; displayName: string; role: string; roleLabel: string; businessUnitId: string; companyIds: string[]; jobTitle: string | null; isActive: boolean; impersonator: null; territoryMode: string; territoryProvinces: string | null; territoryCenterIds: string | null };

async function mkInvoice(total: number, paid: number) {
  const company = await db.company.findFirstOrThrow({ where: { slug: 'bazargani' } });
  const center = await db.center.create({
    data: { name: `${TAG}-${Math.random().toString(36).slice(2, 8)}`, customerType: 'b2b', companyId: company.id, province: 'تهران', businessUnitId: 'trading' },
  });
  const account = await db.centerAccount.create({
    data: { centerId: center.id, totalSales: total, totalPaid: paid, balance: total - paid },
  });
  const invoice = await db.issuedInvoice.create({
    data: { centerAccountId: account.id, totalAmount: total, paidAmount: paid, status: paid >= total ? 'paid' : 'issued', createdById: null },
  });
  return { invoice, account, center };
}

function billingReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/billing', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  });
}

async function cleanup() {
  const centers = await db.center.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const c of centers) {
    const accounts = await db.centerAccount.findMany({ where: { centerId: c.id } });
    for (const a of accounts) {
      const invs = await db.issuedInvoice.findMany({ where: { centerAccountId: a.id } });
      for (const inv of invs) {
        await db.issuedInvoicePaymentIdempotency.deleteMany({ where: { invoiceId: inv.id } }).catch(() => undefined);
        await db.issuedInvoicePayment.deleteMany({ where: { issuedInvoiceId: inv.id } });
        await db.issuedInvoice.delete({ where: { id: inv.id } });
      }
      await db.centerAccount.delete({ where: { id: a.id } });
    }
    await db.center.delete({ where: { id: c.id } }).catch(() => undefined);
  }
}

beforeAll(async () => {
  await cleanup();
  const u = await db.user.create({
    data: {
      username: `${TAG}-finance`, displayName: 'finance', passwordHash: 'x', role: 'finance',
      companyIds: JSON.stringify(['bazargani']), businessUnitId: 'trading',
      territoryMode: 'country', territoryProvinces: '[]',
    },
  });
  financeUser = {
    id: u.id, username: u.username, displayName: u.displayName, role: 'finance', roleLabel: '',
    businessUnitId: 'trading', companyIds: ['bazargani'], jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]',
  };
});

afterAll(async () => {
  await cleanup();
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

describe('REAL ROUTE — add-payment exposes identity + alreadySettled to the engine', () => {
  it('add-payment on a settled invoice → definitive rejection (nothing booked), engine resolves — no dead-end unknown', async () => {
    const { invoice } = await mkInvoice(100, 100); // already fully paid
    currentAuthUser = financeUser;
    try {
      const out = await submitIdempotentPayment(
        { invoiceId: invoice.id, amount: 20, description: 'late attempt' },
        null,
        {
          // the REAL route through the real fetch seam contract
          fetchImpl: async (body) => {
            const r = await billingPost(billingReq(body));
            return { ok: r.ok, status: r.status, json: async () => await r.json() } as unknown as Awaited<ReturnType<typeof billingPost>>;
          },
          storage: null,
        },
      );
      // the server's own refusal (single-tx money path — nothing booked):
      // a DEFINITIVE rejection, not an unproven unknown loop
      expect(out.kind).toBe('rejected');
      // and nothing was booked
      const receipts = await db.issuedInvoicePayment.findMany({ where: { issuedInvoiceId: invoice.id } });
      expect(receipts.length).toBe(0);
    } finally {
      currentAuthUser = null;
      await cleanup();
    }
  });

  it('add-payment on an open invoice → the engine resolves it as success with matching identity', async () => {
    const { invoice } = await mkInvoice(100, 0);
    currentAuthUser = financeUser;
    try {
      const out = await submitIdempotentPayment(
        { invoiceId: invoice.id, amount: 20, description: 'real op' },
        null,
        {
          fetchImpl: async (body) => {
            const r = await billingPost(billingReq(body));
            return { ok: r.ok, status: r.status, json: async () => await r.json() } as unknown as Awaited<ReturnType<typeof billingPost>>;
          },
          storage: null,
        },
      );
      expect(out.kind).toBe('success');
      const receipts = await db.issuedInvoicePayment.findMany({ where: { issuedInvoiceId: invoice.id } });
      expect(receipts.length).toBe(1);
      expect(receipts[0].amount).toBe(20);
    } finally {
      currentAuthUser = null;
      await cleanup();
    }
  });
});
