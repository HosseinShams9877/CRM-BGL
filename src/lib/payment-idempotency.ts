// ════════════════════════════════════════════════════════════
// PAYMENT IDEMPOTENCY ENGINE v2 (v2.58.6 — user finding P1)
//
// THE BUGS THIS CLOSES (both reproduced red on v2.58.5):
//   1. any JSON-parseable non-ok response was treated as a DEFINITIVE
//      rejection — including a 502/504 JSON body produced by a network
//      intermediary AFTER the server had committed the payment. The
//      client dropped the key; the retry carried a fresh one; the same
//      20-Rial payment was booked twice (20+20 on a 100 invoice).
//   2. the key lived only in a React ref — a page REFRESH lost it, and
//      the server's balance cap cannot stop two small payments.
//
// THE CONTRACT v2:
//   • outcomes are success / definitive rejection / UNKNOWN;
//   • 5xx (any JSON body included), 408/425, network loss, unreadable
//     body and a 2xx response that does NOT match the add-payment API
//     contract ⇒ UNKNOWN — JSON-ness alone proves NOTHING;
//   • a definitive rejection is a 4xx from THIS server (400/401/403/
//     404/409/410/422) with the server's own error contract — its
//     money path is a single transaction, so a rejection never booked
//     anything;
//   • on UNKNOWN the operation key SURVIVES in a durable, OPAQUE,
//     per-invoice record (sessionStorage: the UUID key + a sha-256
//     digest of the fingerprint + a timestamp — no payment data);
//   • refresh / close-reopen restore the SAME key for the SAME
//     logical operation (fingerprint digest match);
//   • resolvePendingPayment() asks the server (action=payment-status)
//     for the recorded outcome BEFORE a new payment is attempted: the
//     idempotency row and the receipt land in ONE transaction, so
//     "no record" is positive proof nothing was booked. Disclosure is
//     gated by the CURRENT user's access (per-user key namespace);
//   • the browser record is one opaque UUID per invoice — a different
//     account gains nothing from it (their server namespace is empty).
// ════════════════════════════════════════════════════════════

export interface PaymentOperation {
  invoiceId: string;
  amount: number;
  description: string;
  referenceNumber?: string | null;
}

/** In-memory identity of ONE logical payment operation. */
export interface PaymentAttemptState {
  key: string;
  fingerprint: string;
}

/** The opaque, durable record for one invoice's pending operation. */
export interface PendingPaymentRecord {
  /** The idempotency key (a UUID — not sensitive payment data). */
  key: string;
  /** sha-256 digest of the operation fingerprint (opaque matcher). */
  fp: string;
  /** When the record was written (ms since epoch). */
  t: number;
}

/** Injectable key-value seam (the default wraps sessionStorage). */
export interface PaymentKvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export type PaymentSubmitOutcome =
  | { kind: 'success'; replayed: boolean; message?: string; state: null }
  | { kind: 'rejected'; status: number; error: string; state: null }
  | { kind: 'unknown'; error: string; state: PaymentAttemptState };

export type PendingResolution =
  | { kind: 'none' }
  | { kind: 'recorded'; paymentId: string; amount: number; newPaidAmount: number; newStatus: string; message: string }
  | { kind: 'not-recorded' }
  | { kind: 'unknown'; error: string };

/** Storage namespace: one pending operation per invoice. */
export function pendingStorageKey(invoiceId: string): string {
  return `bgl-pay-pending:${invoiceId}`;
}

/** The browser sessionStorage-backed store (null where unavailable). */
export function defaultPaymentKvStore(): PaymentKvStore | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const s = sessionStorage;
    return {
      get: (k) => s.getItem(k),
      set: (k, v) => { try { s.setItem(k, v); } catch { /* full/blocked — degrade to memory-only */ } },
      remove: (k) => { try { s.removeItem(k); } catch { /* best-effort */ } },
    };
  } catch {
    return null;
  }
}

/** Stable fingerprint of every payload-affecting field. */
export function fingerprintPaymentOperation(op: PaymentOperation): string {
  return JSON.stringify([
    op.invoiceId,
    op.amount,
    op.description,
    op.referenceNumber ?? null,
  ]);
}

/** Opaque digest of a fingerprint (sha-256 when WebCrypto exists). */
async function digestFingerprint(fp: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const buf = await subtle.digest('SHA-256', new TextEncoder().encode(fp));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* fall through */ }
  // deterministic fallback (non-cryptographic) for exotic environments
  let h = 5381;
  for (let i = 0; i < fp.length; i++) h = ((h * 33) ^ fp.charCodeAt(i)) >>> 0;
  return `djb2-${h.toString(16)}`;
}

/** A fresh client idempotency key (UUID with a graceful fallback). */
export function mintPaymentIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `pay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * The key for the CURRENT operation: the same fingerprint as the
 * previous attempt (a retry of the same logical operation) reuses the
 * SAME key; anything else mints a new one.
 */
export function paymentAttemptFor(
  op: PaymentOperation,
  previous: PaymentAttemptState | null,
): PaymentAttemptState {
  const fingerprint = fingerprintPaymentOperation(op);
  if (previous && previous.fingerprint === fingerprint) {
    return previous;
  }
  return { key: mintPaymentIdempotencyKey(), fingerprint };
}

/** Injectable network seam (the test forwards to the REAL route). */
export type PaymentFetch = (body: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

async function defaultPaymentFetch(body: Record<string, unknown>): Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}> {
  const res = await fetch('/api/billing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res as unknown as { ok: boolean; status: number; json: () => Promise<unknown> };
}

export interface PaymentEngineOpts {
  fetchImpl?: PaymentFetch;
  /**
   * The durable-record store. Default: sessionStorage when available
   * (browser), null otherwise (server/tests without a store). Pass an
   * explicit store in tests to simulate the browser across a refresh.
   */
  storage?: PaymentKvStore | null;
}

function normalizeOpts(
  arg?: PaymentFetch | PaymentEngineOpts,
): { fetchImpl: PaymentFetch; storage: PaymentKvStore | null } {
  if (typeof arg === 'function') return { fetchImpl: arg, storage: null };
  const opts = arg ?? {};
  return {
    fetchImpl: opts.fetchImpl ?? defaultPaymentFetch,
    storage: opts.storage === undefined ? defaultPaymentKvStore() : opts.storage,
  };
}

// ── response classification ──────────────────────────────────

/** The add-payment success contract (exactly what /api/billing returns). */
function isAddPaymentSuccessBody(data: Record<string, unknown>): boolean {
  const payment = data.payment as Record<string, unknown> | null | undefined;
  return (
    typeof data.message === 'string' && data.message.length > 0
    && typeof data.newStatus === 'string' && data.newStatus.length > 0
    && typeof data.newPaidAmount === 'number' && Number.isFinite(data.newPaidAmount)
    && typeof data.replayed === 'boolean'
    && payment !== null && typeof payment === 'object'
    && typeof payment.id === 'string' && payment.id.length > 0
    && typeof payment.amount === 'number' && Number.isFinite(payment.amount)
  );
}

// v2.58.10 (carried workstream 3): a 2xx body is only proof of THIS
// operation's outcome when the identity it describes matches the
// operation we submitted — same invoice, same booked amount. A
// structurally-valid body for ANOTHER operation (a stale proxy cache,
// a mixed-up response, a future route change) must stay UNKNOWN so the
// key survives and a retry cannot double-book.
function successBodyMatchesOperation(
  data: Record<string, unknown>,
  op: PaymentOperation,
): boolean {
  if (typeof data.invoiceId === 'string' && data.invoiceId !== op.invoiceId) return false;
  const payment = data.payment as Record<string, unknown> | null | undefined;
  if (!payment || typeof payment.amount !== 'number') return false;
  return payment.amount === op.amount;
}

// v2.58.10 (carried workstream 3): the server's honest "already settled,
// nothing was booked" answer (the settle path's existing contract). The
// engine must resolve it as a DEFINITIVE outcome — never a dead-end
// unknown loop that pins the pending record forever.
function isAlreadySettledBody(data: Record<string, unknown>): boolean {
  return (
    data.alreadySettled === true
    && typeof data.newStatus === 'string' && data.newStatus.length > 0
    && typeof data.newPaidAmount === 'number' && Number.isFinite(data.newPaidAmount)
  );
}

/**
 * Statuses that can ONLY come from THIS server deciding to refuse the
 * request (its money path is one transaction — nothing was booked).
 * Everything else — 5xx (intermediaries use JSON bodies too), 408/425
 * timeouts — is UNKNOWN without positive proof of non-booking.
 */
const DEFINITIVE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 409, 410, 422]);

function isDefinitiveRejection(status: number, data: Record<string, unknown>): boolean {
  return DEFINITIVE_REJECTION_STATUSES.has(status) && typeof data.error === 'string' && data.error.length > 0;
}

// ── the durable pending record ───────────────────────────────

function readRecord(storage: PaymentKvStore | null, invoiceId: string): PendingPaymentRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.get(pendingStorageKey(invoiceId));
    if (!raw) return null;
    const rec = JSON.parse(raw) as PendingPaymentRecord;
    if (typeof rec.key !== 'string' || typeof rec.fp !== 'string' || typeof rec.t !== 'number') return null;
    return rec;
  } catch {
    return null;
  }
}

async function writeRecord(storage: PaymentKvStore | null, state: PaymentAttemptState): Promise<void> {
  if (!storage) return;
  const invoiceId = JSON.parse(state.fingerprint)[0] as string;
  const rec: PendingPaymentRecord = { key: state.key, fp: await digestFingerprint(state.fingerprint), t: Date.now() };
  try {
    storage.set(pendingStorageKey(invoiceId), JSON.stringify(rec));
  } catch { /* degrade to memory-only */ }
}

function clearRecord(storage: PaymentKvStore | null, invoiceId: string): void {
  if (!storage) return;
  try { storage.remove(pendingStorageKey(invoiceId)); } catch { /* best-effort */ }
}

const UNKNOWN_RETRY_MSG = 'نتیجهٔ ثبت پرداخت از سرور دریافت نشد. دوباره تلاش کنید — همین پرداخت دوباره ثبت نمی‌شود.';

// ── submit (or retry) one logical payment operation ───────────

/**
 * Submit (or retry) one logical payment operation through /api/billing
 * `add-payment`. The key discipline is the engine's, not the caller's:
 *   • previous in-memory state with a matching fingerprint (the dialog
 *     retry) reuses its key;
 *   • otherwise the durable per-invoice record is consulted (a page
 *     refresh restored the same logical operation);
 *   • on UNKNOWN the record is written/kept; on a definite outcome it
 *     is cleared.
 */
export async function submitIdempotentPayment(
  op: PaymentOperation,
  previous: PaymentAttemptState | null,
  opts?: PaymentFetch | PaymentEngineOpts,
): Promise<PaymentSubmitOutcome> {
  const { fetchImpl, storage } = normalizeOpts(opts);

  // 1. resolve this operation's identity
  const fingerprint = fingerprintPaymentOperation(op);
  let attempt: PaymentAttemptState | null =
    previous && previous.fingerprint === fingerprint ? previous : null;
  if (!attempt) {
    // refresh recovery: the durable record's digest matches this op
    const rec = readRecord(storage, op.invoiceId);
    if (rec && rec.fp === await digestFingerprint(fingerprint)) {
      attempt = { key: rec.key, fingerprint };
    }
  }
  if (!attempt) {
    attempt = { key: mintPaymentIdempotencyKey(), fingerprint };
  }

  const body: Record<string, unknown> = {
    action: 'add-payment',
    id: op.invoiceId,
    amount: op.amount,
    description: op.description,
    ...(op.referenceNumber ? { referenceNumber: op.referenceNumber } : {}),
    idempotencyKey: attempt.key,
  };

  // 2. submit + classify
  let res: Awaited<ReturnType<PaymentFetch>>;
  try {
    res = await fetchImpl(body);
  } catch {
    // the request MAY have been booked — the key MUST survive a retry
    await writeRecord(storage, attempt);
    return { kind: 'unknown', error: UNKNOWN_RETRY_MSG, state: attempt };
  }

  let data: Record<string, unknown>;
  try {
    const parsed = await res.json();
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    data = parsed as Record<string, unknown>;
  } catch {
    // headers arrived but the body is unreadable — outcome unknown
    await writeRecord(storage, attempt);
    return { kind: 'unknown', error: UNKNOWN_RETRY_MSG, state: attempt };
  }

  if (res.ok) {
    // v2.58.10: "already settled" is a definitive, nothing-booked outcome.
    if (isAlreadySettledBody(data)) {
      clearRecord(storage, op.invoiceId);
      return {
        kind: 'success',
        replayed: true, // resolved without a new receipt
        message: typeof data.message === 'string' ? data.message : undefined,
        state: null,
      };
    }
    if (!isAddPaymentSuccessBody(data) || !successBodyMatchesOperation(data, op)) {
      // a 2xx with an arbitrary object — or one that does NOT describe
      // THIS operation (invoice/amount mismatch) — is NOT proof the
      // payment was booked: keep the identity and retry safely
      await writeRecord(storage, attempt);
      return { kind: 'unknown', error: UNKNOWN_RETRY_MSG, state: attempt };
    }
    clearRecord(storage, op.invoiceId);
    return {
      kind: 'success',
      replayed: data.replayed === true,
      message: typeof data.message === 'string' ? data.message : undefined,
      state: null,
    };
  }

  if (isDefinitiveRejection(res.status, data)) {
    // this server's own refusal — nothing was booked (single tx)
    clearRecord(storage, op.invoiceId);
    return {
      kind: 'rejected',
      status: res.status,
      error: typeof data.error === 'string' ? data.error : 'خطا در ثبت پرداخت',
      state: null,
    };
  }

  // 5xx / 408 / 425 / anything unproven — the payment MAY be booked
  await writeRecord(storage, attempt);
  return { kind: 'unknown', error: UNKNOWN_RETRY_MSG, state: attempt };
}

// ── the resolution path (تعیین تکلیف) ─────────────────────────

/**
 * Ask the server what became of THIS INVOICE's pending operation —
 * BEFORE the user attempts a new payment. The idempotency row and the
 * receipt are written in one transaction, so:
 *   • 'recorded'  → the payment WAS booked; the record is cleared and
 *                   the stored summary is disclosed (only to the user
 *                   whose namespace holds the key, only within their
 *                   CURRENT company/ownership scope);
 *   • 'not-recorded' → positive proof nothing was booked under this
 *                   key — the pending stays so a retry of the same
 *                   operation stays safe;
 *   • 'unknown'   → the status query itself failed — pending stays.
 */
export async function resolvePendingPayment(
  invoiceId: string,
  opts?: PaymentFetch | PaymentEngineOpts,
): Promise<PendingResolution> {
  const { fetchImpl, storage } = normalizeOpts(opts);
  const rec = readRecord(storage, invoiceId);
  if (!rec) return { kind: 'none' };

  let res: Awaited<ReturnType<PaymentFetch>>;
  try {
    res = await fetchImpl({ action: 'payment-status', id: invoiceId, idempotencyKey: rec.key });
  } catch {
    return { kind: 'unknown', error: UNKNOWN_RETRY_MSG };
  }
  let data: Record<string, unknown>;
  try {
    const parsed = await res.json();
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    data = parsed as Record<string, unknown>;
  } catch {
    return { kind: 'unknown', error: UNKNOWN_RETRY_MSG };
  }

  if (res.ok && data.status === 'recorded') {
    clearRecord(storage, invoiceId);
    const payment = data.payment as Record<string, unknown> | undefined;
    return {
      kind: 'recorded',
      paymentId: typeof payment?.id === 'string' ? payment.id : '',
      amount: typeof payment?.amount === 'number' ? payment.amount : 0,
      newPaidAmount: typeof data.newPaidAmount === 'number' ? data.newPaidAmount : 0,
      newStatus: typeof data.newStatus === 'string' ? data.newStatus : '',
      message: typeof data.message === 'string' ? data.message : '',
    };
  }
  if (res.ok && data.status === 'not-recorded') {
    return { kind: 'not-recorded' }; // the pending record stays (retry-safe)
  }
  // refused (401/403/404 — scope revoked) or an unproven outcome
  return {
    kind: 'unknown',
    error: typeof data.error === 'string' ? data.error : UNKNOWN_RETRY_MSG,
  };
}
