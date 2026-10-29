import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// payment-key-stability.test.ts — v2.58.5 (user finding R2)
//
// THE AUDIT REPRO (Section A — confirmed on the v2.58.4 form):
//   the collections dialog minted a FRESH idempotency key inside
//   every submit. A payment of 20 was booked on a 100 invoice, the
//   response never reached the client, the user clicked again → a
//   NEW key → the server booked the SAME 20 twice.
//
// THE CONTRACT (Section B — the real form path, real handler, real
// service, real SQLite; ONLY the network is stubbed, and it is
// stubbed AROUND the real route call):
//   • first submit: the server really books 20, then the response is
//     deliberately lost (fetch throws on the client side);
//   • the engine returns 'unknown' and KEEPS the operation key;
//   • the retry — through the SAME engine the form calls — sends the
//     SAME key; the server replays the stored result;
//   • final state: exactly ONE receipt of 20, ONE accounting effect
//     (paidAmount=20, centerAccount.totalPaid=20), ONE success.
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
  paymentAttemptFor,
  fingerprintPaymentOperation,
  mintPaymentIdempotencyKey,
  type PaymentOperation,
} from '@/lib/payment-idempotency';

const db = new PrismaClient();
const TAG = `r2key-${Date.now().toString(36)}`;

async function mkUser(username: string) {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`,
      displayName: username,
      passwordHash: 'x',
      role: 'finance',
      companyIds: JSON.stringify(['bazargani']),
      businessUnitId: 'trading',
      territoryMode: 'country',
      territoryProvinces: '[]',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role: 'finance', roleLabel: '',
    businessUnitId: 'trading', companyIds: ['bazargani'], jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]',
  };
}

async function mkInvoice(total: number) {
  const company = await db.company.findFirstOrThrow({ where: { slug: 'bazargani' } });
  const center = await db.center.create({
    data: { name: `${TAG}-${Math.random().toString(36).slice(2, 8)}`, customerType: 'b2b', companyId: company.id, province: 'تهران', businessUnitId: 'trading' },
  });
  const account = await db.centerAccount.create({
    data: { centerId: center.id, totalSales: total, totalPaid: 0, balance: total },
  });
  const invoice = await db.issuedInvoice.create({
    data: { centerAccountId: account.id, totalAmount: total, paidAmount: 0, status: 'issued', createdById: null },
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

async function receiptsOf(invoiceId: string) {
  return db.issuedInvoicePayment.findMany({ where: { issuedInvoiceId: invoiceId }, orderBy: { createdAt: 'asc' } });
}

let financeUser: Awaited<ReturnType<typeof mkUser>>;

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
  financeUser = await mkUser('finance');
});

afterAll(async () => {
  await cleanup();
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

// ── Section A: the v2.58.4 form behavior = double booking ──
describe('R2.A — repro: a fresh key per submission double-books a lost response', () => {
  it('two submits with two FRESH keys (the old form) → TWO receipts, 40 paid', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    try {
      const op = { id: invoice.id, amount: 20, description: `dup ${TAG}` } as const;
      // exactly what the pre-fix dialog did: a NEW key on every submit
      const first = await billingPost(billingReq({ action: 'add-payment', ...op, idempotencyKey: `old-${Date.now()}-a` }));
      const second = await billingPost(billingReq({ action: 'add-payment', ...op, idempotencyKey: `old-${Date.now()}-b` }));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const receipts = await receiptsOf(invoice.id);
      expect(receipts.length).toBe(2); // ← THE BUG: the same logical payment, booked twice
      const inv = await db.issuedInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(inv.paidAmount).toBe(40);
    } finally {
      await cleanup();
    }
  }, 20_000);
});

// ── Section B: the engine contract — the REAL form path ──
describe('R2.B — lost response + retry through the engine → ONE receipt', () => {
  it('the retry sends the SAME key; one receipt, one accounting effect, one success', async () => {
    const { invoice, account } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const sentKeys: string[] = [];

    // the network seam: forwards to the REAL billing handler. The FIRST
    // call is fully processed server-side, then its response is LOST.
    const seam = async (body: Record<string, unknown>) => {
      sentKeys.push(String(body.idempotencyKey));
      const real = await billingPost(billingReq(body));
      if (sentKeys.length === 1) {
        throw new TypeError('Failed to fetch'); // ← the response never reaches the client
      }
      return real as unknown as { ok: boolean; status: number; json: () => Promise<unknown> };
    };

    try {
      const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `retry ${TAG}` };

      // FIRST submit — server books 20, client sees a network error
      const first = await submitIdempotentPayment(op, null, seam);
      expect(first.kind).toBe('unknown');
      expect(first.state).not.toBeNull();
      expect(sentKeys.length).toBe(1);

      // the form shows the "unknown outcome" message; the user retries
      const retry = await submitIdempotentPayment(op, first.state, seam);
      expect(retry.kind).toBe('success');
      if (retry.kind !== 'success') throw new Error('unreachable');
      expect(retry.replayed).toBe(true);
      expect(sentKeys.length).toBe(2);

      // THE key discipline: the retry carried the SAME key
      expect(sentKeys[1]).toBe(sentKeys[0]);
      expect(sentKeys[0]).not.toBeNull();

      // exactly ONE receipt of 20 — the DB never saw a second payment
      const receipts = await receiptsOf(invoice.id);
      expect(receipts.length).toBe(1);
      expect(receipts[0].amount).toBe(20);

      // ONE accounting effect
      const inv = await db.issuedInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(inv.paidAmount).toBe(20);
      const acc = await db.centerAccount.findUniqueOrThrow({ where: { id: account.id } });
      expect(acc.totalPaid).toBe(20);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('a definite server rejection drops the key; the next attempt is a new operation', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const keys: string[] = [];
    const seam = async (body: Record<string, unknown>) => {
      keys.push(String(body.idempotencyKey));
      return (await billingPost(billingReq(body))) as unknown as { ok: boolean; status: number; json: () => Promise<unknown> };
    };
    try {
      // overpayment → definite 400 (server booked nothing)
      const rejected = await submitIdempotentPayment(
        { invoiceId: invoice.id, amount: 500, description: `over ${TAG}` }, null, seam,
      );
      expect(rejected.kind).toBe('rejected');
      expect(rejected.state).toBeNull();
      expect((rejected as { status: number }).status).toBe(400);
      expect(await receiptsOf(invoice.id)).toHaveLength(0);

      // a later, honest payment is a NEW operation with a NEW key
      const next = await submitIdempotentPayment(
        { invoiceId: invoice.id, amount: 20, description: `honest ${TAG}` }, null, seam,
      );
      expect(next.kind).toBe('success');
      expect(keys[1]).not.toBe(keys[0]);
      expect(await receiptsOf(invoice.id)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('changing a payload-affecting field is explicitly a NEW operation (new key)', async () => {
    const opA: PaymentOperation = { invoiceId: 'inv-1', amount: 20, description: 'a' };
    const opB: PaymentOperation = { invoiceId: 'inv-1', amount: 30, description: 'a' }; // amount drift
    const opC: PaymentOperation = { invoiceId: 'inv-2', amount: 20, description: 'a' }; // invoice drift
    const opD: PaymentOperation = { invoiceId: 'inv-1', amount: 20, description: 'b' }; // description drift
    const stA = paymentAttemptFor(opA, null);
    expect(paymentAttemptFor(opA, stA).key).toBe(stA.key); // retry → SAME key
    expect(paymentAttemptFor(opB, stA).key).not.toBe(stA.key);
    expect(paymentAttemptFor(opC, stA).key).not.toBe(stA.key);
    expect(paymentAttemptFor(opD, stA).key).not.toBe(stA.key);
    // fingerprints differ; keys are unique per operation
    expect(mintPaymentIdempotencyKey()).not.toBe(mintPaymentIdempotencyKey());
    expect(fingerprintPaymentOperation(opA)).not.toBe(fingerprintPaymentOperation(opB));
  });
});
