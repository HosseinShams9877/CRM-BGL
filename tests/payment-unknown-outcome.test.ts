import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// payment-unknown-outcome.test.ts — v2.58.6 (user finding P1)
//
// THE AUDIT REPRO (confirmed on the v2.58.5 engine — Section A):
//   • a JSON 502/504 from a network INTERMEDIARY was treated as a
//     DEFINITIVE rejection (any parsed JSON body, any status) → the
//     client dropped the idempotency key → the retry carried a FRESH
//     key → the SAME 20-Rial payment was booked TWICE (20+20 on 100);
//   • the key lived only in a React ref: a page REFRESH lost it, and
//     the server's balance cap cannot stop two small payments.
//
// THE CONTRACT (Section B — the real route handler, the real service,
// the real engine the form calls; ONLY the network + browser-storage
// seams are stubbed, and the network stub FORWARDS to the real API):
//   • outcomes are success / definitive rejection / UNKNOWN;
//   • 5xx (502/504…), 408/425, network loss, unreadable body and a
//     2xx response that does NOT match the API contract ⇒ UNKNOWN —
//     the key SURVIVES (in a durable, opaque, per-invoice record);
//   • refresh / close-reopen keep the SAME key for the SAME logical
//     operation; the retry replays the stored result (ONE receipt);
//   • resolvePendingPayment asks the server for the recorded outcome
//     BEFORE a new payment is attempted (definite answer: recorded /
//     not-recorded) — gated by the CURRENT user's access;
//   • a different account can neither read nor replay the previous
//     user's stored result (per-user key namespace server-side);
//   • after a DEFINITIVE success a new independent payment with the
//     same amount gets a NEW identity;
//   • same key + different payload ⇒ 409, zero financial writes.
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
  resolvePendingPayment,
  type PaymentOperation,
  type PaymentKvStore,
} from '@/lib/payment-idempotency';

const db = new PrismaClient();
const TAG = `p1uo-${Date.now().toString(36)}`;

// ── fixtures ──────────────────────────────────────────────────
async function mkUser(username: string, role: 'finance' | 'admin' = 'finance') {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`,
      displayName: username,
      passwordHash: 'x',
      role,
      companyIds: JSON.stringify(['bazargani']),
      businessUnitId: 'trading',
      territoryMode: 'country',
      territoryProvinces: '[]',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
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

/** Fake browser sessionStorage seam — survives an "engine re-instantiation". */
function fakeKv(): PaymentKvStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); }, remove: (k) => { m.delete(k); } };
}

let financeUser: Awaited<ReturnType<typeof mkUser>>;

beforeAll(async () => {
  await cleanup();
  financeUser = await mkUser('finance');
});
afterAll(async () => {
  await cleanup();
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

/** Wrap the real handler so the FIRST response is replaced by `transform`. */
function makeSeam(transform: (real: Response) => Response) {
  const calls: Array<Record<string, unknown>> = [];
  const wrap = async (body: Record<string, unknown>) => {
    calls.push(body);
    const real = (await billingPost(billingReq(body))) as unknown as Response;
    if (calls.length === 1) return transform(real);
    return real;
  };
  return { wrap, calls };
}


// ── Section A: the v2.58.5 engine = double booking ────────────
describe('P1.A — repro: JSON 502 is mistaken for a definitive rejection', () => {
  it('A1: the pre-fix discipline (502 → "rejected", fresh key on retry) double-books the payment', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    try {
      const op = { id: invoice.id, amount: 20, description: `p1a ${TAG}` } as const;
      // the v2.58.5 engine read the intermediary's JSON 502 as a DEFINITIVE
      // rejection, dropped the key and minted a FRESH one on retry — against
      // the real server that discipline books the SAME payment twice:
      const first = await billingPost(billingReq({ action: 'add-payment', ...op, idempotencyKey: `old-${TAG}-a` }));
      expect(first.status).toBe(200);
      const second = await billingPost(billingReq({ action: 'add-payment', ...op, idempotencyKey: `old-${TAG}-b` }));
      expect(second.status).toBe(200);
      const receipts = await receiptsOf(invoice.id);
      expect(receipts).toHaveLength(2); // ← the double booking the bug produced
      const inv = await db.issuedInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(inv.paidAmount).toBe(40);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('A2: refresh loses the in-memory key → the retry carries a NEW key → double booking', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const storage = fakeKv(); // the browser's sessionStorage seam
    const seam = makeSeam(() => { throw new TypeError('Failed to fetch'); });
    try {
      const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `p1b ${TAG}` };
      const first = await submitIdempotentPayment(op, null, { fetchImpl: seam.wrap, storage });
      expect(first.kind).toBe('unknown');

      // page REFRESH: the React ref is gone; only the durable record remains
      const afterRefresh = await submitIdempotentPayment(op, null, { fetchImpl: directFetch, storage });
      void afterRefresh;
      const receipts = await receiptsOf(invoice.id);
      expect(receipts.length).toBe(1); // ← red: TWO receipts on the current engine
    } finally {
      await cleanup();
    }
  }, 20_000);
});

// a plain seam that forwards everything (used when the first call must
// REALLY book and only the RESPONSE is lost)
function directFetch(body: Record<string, unknown>) {
  return billingPost(billingReq(body)) as unknown as Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

// ── Section B: the new contract ────────────────────────────────
describe('P1.B — unknown outcomes keep the operation identity', () => {
  it('B1: JSON 502 → unknown; retry with the SAME key → ONE receipt, replayed', async () => {
    const { invoice, account } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const storage = fakeKv();
    const seam = makeSeam(() => new Response(JSON.stringify({ error: 'Bad Gateway' }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
    try {
      const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `p1c ${TAG}` };
      const first = await submitIdempotentPayment(op, null, { fetchImpl: seam.wrap, storage });
      expect(first.kind).toBe('unknown');
      expect(first.state).not.toBeNull();

      const retry = await submitIdempotentPayment(op, first.state, { fetchImpl: seam.wrap, storage });
      expect(retry.kind).toBe('success');
      if (retry.kind !== 'success') throw new Error('unreachable');
      expect(retry.replayed).toBe(true);
      expect(seam.calls[1]?.idempotencyKey).toBe(seam.calls[0]?.idempotencyKey);

      const receipts = await receiptsOf(invoice.id);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].amount).toBe(20);
      const inv = await db.issuedInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(inv.paidAmount).toBe(20);
      const acc = await db.centerAccount.findUniqueOrThrow({ where: { id: account.id } });
      expect(acc.totalPaid).toBe(20);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('B2: JSON 504, network cut and unreadable body are all UNKNOWN — same key, one receipt', async () => {
    const cases: Array<{ name: string; transform: () => Response | never }> = [
      { name: '504', transform: () => new Response(JSON.stringify({ error: 'Gateway Timeout' }), { status: 504, headers: { 'Content-Type': 'application/json' } }) },
      { name: 'network-cut', transform: () => { throw new TypeError('Failed to fetch'); } },
      { name: 'unreadable-body', transform: () => new Response('<<not-json>>', { status: 200, headers: { 'Content-Type': 'application/json' } }) },
    ];
    for (const c of cases) {
      const { invoice } = await mkInvoice(100);
      currentAuthUser = financeUser;
      const storage = fakeKv();
      const seam = makeSeam(c.transform as () => Response);
      try {
        const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `p1d-${c.name} ${TAG}` };
        const first = await submitIdempotentPayment(op, null, { fetchImpl: seam.wrap, storage });
        expect(first.kind).toBe('unknown');
        const retry = await submitIdempotentPayment(op, first.state, { fetchImpl: seam.wrap, storage });
        expect(retry.kind).toBe('success');
        const receipts = await receiptsOf(invoice.id);
        expect(receipts).toHaveLength(1);
        expect(receipts[0].amount).toBe(20);
      } finally {
        await cleanup();
      }
    }
  }, 30_000);

  it('B3: REFRESH after an unknown outcome — the durable record restores the SAME key; one receipt', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const storage = fakeKv();
    const seam = makeSeam(() => { throw new TypeError('Failed to fetch'); });
    try {
      const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `p1e ${TAG}` };
      const first = await submitIdempotentPayment(op, null, { fetchImpl: seam.wrap, storage });
      expect(first.kind).toBe('unknown');
      expect(first.state).not.toBeNull();

      // refresh: in-memory state (the parent ref) is GONE; the storage record
      // (opaque: key + fingerprint digest + timestamp) survives
      const retry = await submitIdempotentPayment(op, null, { fetchImpl: directFetch, storage });
      expect(retry.kind).toBe('success');
      if (retry.kind !== 'success') throw new Error('unreachable');
      expect(retry.replayed).toBe(true);

      const receipts = await receiptsOf(invoice.id);
      expect(receipts).toHaveLength(1);
      const inv = await db.issuedInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(inv.paidAmount).toBe(20);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('B4: close + reopen the dialog (the parent ref survives) — SAME key, same result', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const storage = fakeKv();
    const seam = makeSeam(() => { throw new TypeError('Failed to fetch'); });
    try {
      const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `p1f ${TAG}` };
      const first = await submitIdempotentPayment(op, null, { fetchImpl: seam.wrap, storage });
      const retry = await submitIdempotentPayment(op, first.state, { fetchImpl: directFetch, storage });
      expect(retry.kind).toBe('success');
      expect(await receiptsOf(invoice.id)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('B5: after a DEFINITIVE success a new independent payment with the same amount is a NEW operation', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const storage = fakeKv();
    try {
      const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `p1g ${TAG}` };
      const first = await submitIdempotentPayment(op, null, { fetchImpl: directFetch, storage });
      expect(first.kind).toBe('success');
      expect(first.state).toBeNull();

      // a SECOND, independent 20-Rial payment — new identity, legitimately booked
      const second = await submitIdempotentPayment(op, null, { fetchImpl: directFetch, storage });
      expect(second.kind).toBe('success');
      if (second.kind !== 'success') throw new Error('unreachable');
      expect(second.replayed).toBe(false);

      const receipts = await receiptsOf(invoice.id);
      expect(receipts).toHaveLength(2);
      const inv = await db.issuedInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(inv.paidAmount).toBe(40);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('B6: a 2xx response that does NOT match the API contract is UNKNOWN — the key is not cleared early', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const storage = fakeKv();
    const seam = makeSeam(() => new Response(JSON.stringify({ arbitrary: 'object' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    try {
      const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `p1h ${TAG}` };
      const first = await submitIdempotentPayment(op, null, { fetchImpl: seam.wrap, storage });
      expect(first.kind).toBe('unknown'); // ← a random 2xx object is NOT proof of booking
      expect(first.state).not.toBeNull();

      const retry = await submitIdempotentPayment(op, first.state, { fetchImpl: directFetch, storage });
      expect(retry.kind).toBe('success');
      if (retry.kind !== 'success') throw new Error('unreachable');
      expect(retry.replayed).toBe(true);
      expect(await receiptsOf(invoice.id)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('B7: the same key with a DIFFERENT payload → 409 from the server, zero financial writes', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    try {
      const first = await billingPost(billingReq({ action: 'add-payment', id: invoice.id, amount: 20, description: `p1i ${TAG}`, idempotencyKey: `same-key-${TAG}` }));
      expect(first.status).toBe(200);
      const conflict = await billingPost(billingReq({ action: 'add-payment', id: invoice.id, amount: 30, description: `p1i-drift ${TAG}`, idempotencyKey: `same-key-${TAG}` }));
      expect(conflict.status).toBe(409);
      const receipts = await receiptsOf(invoice.id);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].amount).toBe(20);
      const inv = await db.issuedInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(inv.paidAmount).toBe(20);
    } finally {
      await cleanup();
    }
  }, 20_000);
});

// ── Section C: the resolution path (تعیین تکلیف) ───────────────
describe('P1.C — resolvePendingPayment asks the server before a new payment', () => {
  it('C1: no pending record → none; unknown outcome then recorded → the stored summary comes back and the record clears', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const storage = fakeKv();
    try {
      expect(await resolvePendingPayment(invoice.id, { fetchImpl: directFetch, storage })).toMatchObject({ kind: 'none' });

      const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `p1j ${TAG}` };
      const seam = makeSeam(() => { throw new TypeError('Failed to fetch'); });
      const first = await submitIdempotentPayment(op, null, { fetchImpl: seam.wrap, storage });
      expect(first.kind).toBe('unknown');

      const outcome = await resolvePendingPayment(invoice.id, { fetchImpl: directFetch, storage });
      expect(outcome.kind).toBe('recorded');
      if (outcome.kind !== 'recorded') throw new Error('unreachable');
      expect(outcome.amount).toBe(20);
      expect(outcome.paymentId).toBeTruthy();

      // the record is cleared after a DEFINITE answer — a fresh payment is free
      const fresh = await submitIdempotentPayment(op, null, { fetchImpl: directFetch, storage });
      expect(fresh.kind).toBe('success');
      if (fresh.kind !== 'success') throw new Error('unreachable');
      expect(fresh.replayed).toBe(false); // a NEW operation, not a replay
      expect(await receiptsOf(invoice.id)).toHaveLength(2);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('C2: a NOT-recorded pending (request never reached the server) stays available for a safe retry', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const storage = fakeKv();
    // the request DIED BEFORE reaching the API (nothing booked server-side);
    // the client saw a network error and kept the pending record
    const deadWire: typeof directFetch = async () => { throw new TypeError('Failed to fetch'); };
    try {
      const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `p1k ${TAG}` };
      const first = await submitIdempotentPayment(op, null, { fetchImpl: deadWire, storage });
      expect(first.kind).toBe('unknown');
      const outcome = await resolvePendingPayment(invoice.id, { fetchImpl: directFetch, storage });
      expect(outcome.kind).toBe('not-recorded');

      // retry of the same logical operation — SAME key (safe), ONE receipt
      const retry = await submitIdempotentPayment(op, null, { fetchImpl: directFetch, storage });
      expect(retry.kind).toBe('success');
      expect(await receiptsOf(invoice.id)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('C3: a DIFFERENT account cannot read the previous user\'s stored result', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const storage = fakeKv();
    const seam = makeSeam(() => { throw new TypeError('Failed to fetch'); });
    const otherUser = await mkUser('other');
    try {
      const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `p1l ${TAG}` };
      await submitIdempotentPayment(op, null, { fetchImpl: seam.wrap, storage });

      // account switch: the new session cannot resolve the old operation
      currentAuthUser = otherUser;
      const outcome = await resolvePendingPayment(invoice.id, { fetchImpl: directFetch, storage });
      expect(outcome.kind).toBe('not-recorded'); // per-user key namespace — no disclosure

      // and a replay attempt under the new account books the NEW user's own
      // payment (a fresh operation in their namespace), never the stored result
      const asOther = await submitIdempotentPayment(op, null, { fetchImpl: directFetch, storage });
      expect(asOther.kind).toBe('success');
      if (asOther.kind !== 'success') throw new Error('unreachable');
      expect(asOther.replayed).toBe(false);

      // both payments are real and distinct
      const receipts = await receiptsOf(invoice.id);
      expect(receipts).toHaveLength(2);
    } finally {
      currentAuthUser = financeUser;
      await cleanup();
    }
  }, 20_000);

  it('C4: revoked company access blocks BOTH the status disclosure and the replay', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const storage = fakeKv();
    const seam = makeSeam(() => { throw new TypeError('Failed to fetch'); });
    try {
      const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `p1m ${TAG}` };
      await submitIdempotentPayment(op, null, { fetchImpl: seam.wrap, storage });

      // revoke: the finance user loses every company
      const revoked = { ...financeUser, companyIds: [], role: 'finance' as const };
      currentAuthUser = revoked;
      const outcome = await resolvePendingPayment(invoice.id, { fetchImpl: directFetch, storage });
      expect(outcome.kind).toBe('unknown'); // the server refused (403/404) — no disclosure

      const replay = await submitIdempotentPayment(op, null, { fetchImpl: directFetch, storage });
      expect(replay.kind).toBe('rejected');
      if (replay.kind !== 'rejected') throw new Error('unreachable');
      expect([403, 404]).toContain(replay.status);
      expect(replay.state).toBeNull();
      // the payment that WAS booked is still exactly one
      expect(await receiptsOf(invoice.id)).toHaveLength(1);
    } finally {
      currentAuthUser = financeUser;
      await cleanup();
    }
  }, 20_000);

  it('C5: unauthenticated callers get 401 from the status endpoint (no result after logout)', async () => {
    const { invoice } = await mkInvoice(100);
    currentAuthUser = financeUser;
    const storage = fakeKv();
    const seam = makeSeam(() => { throw new TypeError('Failed to fetch'); });
    try {
      const op: PaymentOperation = { invoiceId: invoice.id, amount: 20, description: `p1n ${TAG}` };
      await submitIdempotentPayment(op, null, { fetchImpl: seam.wrap, storage });

      currentAuthUser = null; // logged out
      const res = await billingPost(billingReq({ action: 'payment-status', id: invoice.id, idempotencyKey: (seam.calls[0]?.idempotencyKey as string) }));
      expect(res.status).toBe(401);
    } finally {
      currentAuthUser = financeUser;
      await cleanup();
    }
  }, 20_000);
});
