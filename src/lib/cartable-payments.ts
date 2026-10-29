// ════════════════════════════════════════════════════════════
// CARTABLE PAYMENTS — the REAL mutation path (v2.58.3, round 88,
// user finding 3: payment-edit race condition).
//
// WHAT WAS BROKEN: handleUpdatePayment summed the OTHER payments of
// the document BEFORE the write transaction, then performed the edit
// + account/invoice sync inside the transaction without re-validating.
// Two concurrent edits (doc=100, payments 40+40, both raising their
// own row to 60) both passed on the same stale snapshot and committed
// 120 — an overpaid document with no error. The add path read the
// document (finalAmount) outside the transaction too.
//
// THE FIX — everything inside ONE transaction (SQLite serializes
// writers on the single pooled connection):
//   • the target payment row,
//   • the parent document (company access + status + finalAmount),
//   • the sum of the OTHER payments,
//   • the edit itself + linked-invoice rebuild + account recalc.
// A concurrent writer that committed between an outer check and the
// transaction is correctly refused with a controlled Persian error —
// no partial write ever survives (all-or-nothing).
//
// The route handlers are thin adapters over these functions; tests
// exercise THE SAME functions (the real mutation path, real Prisma
// transaction), not a sum helper.
//
// ── v2.58.4 (external audit F03/F04) ──
// F03: the SALES route's add-payment bypassed this service entirely —
//   `Number(amount) > 0` accepted fractional/boolean/string amounts
//   (0.5 Rial reached the receipt path), paymentDate was unvalidated,
//   and the territory scope was never applied. Both entry points now
//   share ONE strict validator (parseAddPaymentBody: zod schema with
//   z.number() — no coercion — integer-Rial, caps) and ONE add
//   service (addSalesDocumentPayment) with an explicit per-route
//   status policy (the sales contract requires 'approved'; the
//   cartable refuses cancelled/rejected — intentionally NOT unified).
// F04: the sales route wrote its audit log AFTER the payment
//   committed — a log failure returned an error while the money was
//   already booked, and a client retry created a SECOND receipt
//   (audit repro: doc 100, payment 20, log failure, retry → total 40).
//   Both add paths now write the SalesDocumentLog INSIDE the
//   transaction and carry a client idempotency key protected by the
//   SalesPaymentIdempotency UNIQUE(userId, idemKey) constraint:
//   same key + same payload → stored result replayed (one receipt,
//   ever); same key + different payload → 409.
// ════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import type { AuthUser } from '@/lib/auth';
import { getRolePermissions } from '@/lib/auth';
import type { Prisma, SalesDocumentFinance } from '@prisma/client';
import { paymentCreateSchema, parseBody } from '@/lib/validators';
import { ApiError } from '@/lib/api-error';
import { getAllowedCompanyIds, assertCompanyAccess, COMPANY_ACCESS_DENIED } from '@/lib/company-scope';
import { centerInTerritory, resolveTerritoryScope, type TerritoryScope } from '@/lib/territory-scope';
import {
  syncPaymentToLinkedInvoice,
  rebuildLinkedInvoicePayments,
  recalcCenterAccount,
  runInTransaction,
} from '@/lib/finance-sync';

export interface CartableAddPaymentInput {
  salesDocumentId: string;
  paymentMethod?: string;
  paymentDate?: string;
  amount: number;
  referenceNumber?: string;
  description?: string;
}

export interface CartableUpdatePaymentInput {
  paymentId: string;
  paymentMethod?: string;
  paymentDate?: string;
  amount?: number;
  referenceNumber?: string;
  description?: string;
}

/** Parse + validate the add-payment body (schema + integer-Rial rules).
 *  v2.58.4 (F03): also validates paymentDate — an unparseable date
 *  previously produced an Invalid Date that Prisma rejected as a raw 500. */
export function parseAddPaymentBody(body: Record<string, unknown>): CartableAddPaymentInput {
  const parsed = parseBody(paymentCreateSchema, body);
  if (!parsed.ok) throw new ApiError(400, parsed.error);
  const amount = Number(parsed.data.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(400, 'مبلغ پرداخت باید بزرگتر از صفر باشد.');
  }
  if (!Number.isInteger(amount)) {
    throw new ApiError(400, 'مبلغ پرداخت باید عدد ریالیِ صحیح باشد.');
  }
  if (parsed.data.paymentDate) {
    const d = new Date(parsed.data.paymentDate);
    if (Number.isNaN(d.getTime())) {
      throw new ApiError(400, 'تاریخ پرداخت نامعتبر است.');
    }
  }
  return { ...parsed.data, amount } as CartableAddPaymentInput;
}

// v2.58.4 (user issue 1) — the cartable's ownership matrix:
// a finance_write-ONLY user (every standard salesperson carries
// finance_write!) is restricted to their OWN documents and their OWN
// payment rows; full cartable holders (accounting_cartable: admin,
// finance) keep the finance-wide reach inside their company scope.
export const PAYMENT_OWNERSHIP_DENIED =
  'عملیات روی پرداخت‌های این سند فروش برای شما مجاز نیست — این سند متعلق به کاربر دیگری است.';
export const PAYMENT_CREATOR_DENIED =
  'این رکورد پرداخت توسط کاربر دیگری ثبت شده است؛ تغییر یا حذف آن برای شما مجاز نیست.';

/** Parse + validate the update-payment body (integer-Rial rules).
 *  v2.58.4 (issue 5): TYPE-FIRST — a string/boolean amount is rejected
 *  for its type instead of being Number()-coerced into a valid value. */
export function parseUpdatePaymentBody(body: Record<string, unknown>): CartableUpdatePaymentInput {
  const { paymentId, paymentMethod, paymentDate, amount, referenceNumber, description } = body as {
    paymentId?: string;
    paymentMethod?: string;
    paymentDate?: string;
    amount?: number;
    referenceNumber?: string;
    description?: string;
  };
  if (!paymentId) throw new ApiError(400, 'شناسه پرداخت الزامی است.');
  if (amount !== undefined) {
    if (typeof amount !== 'number') {
      throw new ApiError(400, 'مبلغ پرداخت باید عدد باشد.');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ApiError(400, 'مبلغ پرداخت باید بزرگتر از صفر باشد.');
    }
    // v2.47.0 — integer-Rial invariant (src/lib/money.ts)
    if (!Number.isInteger(amount)) {
      throw new ApiError(400, 'مبلغ پرداخت باید عدد ریالیِ صحیح باشد.');
    }
  }
  if (paymentDate !== undefined && paymentDate !== null && paymentDate !== '') {
    const d = new Date(paymentDate);
    if (Number.isNaN(d.getTime())) {
      throw new ApiError(400, 'تاریخ پرداخت نامعتبر است.');
    }
  }
  return { paymentId, paymentMethod, paymentDate, amount, referenceNumber, description };
}

/**
 * In-transaction company gate: reads the LIVE parent document inside the
 * transaction and verifies the acting user's company scope. Returns the
 * live row (finalAmount + status from VALID data, per the audit).
 *
 * ⚠ The allowed-company LIST is resolved BEFORE the transaction and passed
 * in — querying the GLOBAL pool from inside an interactive transaction
 * deadlocks Prisma's SQLite engine (the tx holds its own connection; the
 * cross-connection query stalls until the 20s timeout). The list is a
 * per-request constant; the DOCUMENT row is what must be live, and it is.
 *
 * v2.58.4 (user issue 1): the denial convention is caller-controlled —
 * the SALES paths keep 404 (no existence leak); the CARTABLE restores
 * the explicit 403 COMPANY_ACCESS_DENIED of its pre-v2.58.4 behavior
 * (the user's mandatory matrix: cross-company → 403).
 */
async function loadDocInTxGuarded(
  tx: Prisma.TransactionClient,
  salesDocumentId: string,
  allowedCompanyIds: string[] | null,
  denied: { status: number; message: string } = { status: 404, message: 'سند فروش یافت نشد.' },
) {
  const doc = await tx.salesDocument.findUnique({
    where: { id: salesDocumentId },
    // v2.58.10 (final-review P1): id + province join the company stamp so
    // the update/delete territory gate can evaluate the live row without
    // a second fetch (same select shape as the add path).
    include: { center: { select: { id: true, province: true, companyId: true } } },
  });
  if (!doc) throw new ApiError(404, 'سند فروش یافت نشد.');
  // v2.58.4 — company gate aligned with the shared service: the DOCUMENT'S
  // OWN company stamp (center fallback for legacy unstamped rows).
  assertCompanyAccess(doc.companyId ?? doc.center?.companyId ?? null, allowedCompanyIds, denied.message, denied.status);
  return doc;
}

/** Sum of a document's finance rows, read inside the given transaction. */
async function sumPaymentsInTx(
  tx: Prisma.TransactionClient,
  salesDocumentId: string,
  excludePaymentId?: string,
): Promise<number> {
  const rows = await tx.salesDocumentFinance.findMany({
    where: {
      salesDocumentId,
      ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}),
    },
    select: { amount: true },
  });
  return rows.reduce((s, p) => s + p.amount, 0);
}

// ── ADD — the unified service (v2.58.4, F03/F04) ───────────

/** Which documents may receive money (per-route business contract —
 *  intentionally NOT unified: the sales route requires approval, the
 *  accounting cartable refuses dead documents). */
export type PaymentStatusPolicy = 'approved-only' | 'active-documents';

export interface AddSalesPaymentPolicy {
  /** status contract of the calling route (see PaymentStatusPolicy). */
  statusPolicy: PaymentStatusPolicy;
  /** business-unit boundary of the caller — the SALES route enforces it
   *  (findDocOrThrow parity); the cartable keeps its finance-wide reach
   *  (undefined → no BU filter, the pre-v2.58.4 behavior). */
  businessUnitId?: string;
  /** standard salespeople may only register payments on their OWN
   *  documents (the sales route's ownership matrix). */
  requireOwnership?: boolean;
  /** territory scope paired with requireOwnership (fail-closed 404 —
   *  parity with findDocOrThrow on every other sales action). */
  territory?: TerritoryScope | null;
  /** SalesDocumentLog action written INSIDE the same transaction (F04). */
  logAction?: string;
  /** client idempotency key — DB-enforced UNIQUE(userId, idemKey). */
  idempotencyKey?: string | null;
  /** entry point identity (hash namespace + log context). */
  source: 'sales-documents' | 'accounting-cartable';
  /** v2.58.4 (issue 1) — company-mismatch denial convention: the SALES
   *  route keeps 404/no-leak; the CARTABLE restores 403 + the shared
   *  COMPANY_ACCESS_DENIED message (the user's mandatory matrix). */
  companyDenied?: { status: number; message: string };
  /** v2.58.4 (issue 1) — ownership denial convention: the SALES route
   *  keeps 404/no-leak (findDocOrThrow parity); the CARTABLE uses the
   *  explicit 403 (the files-route convention for «not your row»). */
  ownershipDenied?: { status: number; message: string };
}

export interface AddSalesPaymentResult {
  record: SalesDocumentFinance;
  /** True when an idempotency-key hit replayed the stored result. */
  replayed: boolean;
  message: string;
}

interface StoredSalesIdemRow {
  id: string;
  userId: string;
  idemKey: string;
  requestHash: string;
  salesDocumentId: string;
  financeRecordId: string | null;
  resultJson: string;
}

/** Stable hash of the client-visible payment payload (idempotency scope). */
export function hashSalesPaymentRequest(
  input: CartableAddPaymentInput,
  userId: string,
  source: AddSalesPaymentPolicy['source'],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        userId,
        salesDocumentId: input.salesDocumentId,
        amount: input.amount,
        paymentMethod: input.paymentMethod ?? 'cash',
        paymentDate: input.paymentDate ?? null,
        referenceNumber: input.referenceNumber ?? null,
        description: input.description ?? null,
        source,
      }),
    )
    .digest('hex');
}

function parseStoredSalesResult(row: StoredSalesIdemRow): AddSalesPaymentResult {
  try {
    const parsed = JSON.parse(row.resultJson) as AddSalesPaymentResult;
    return { ...parsed, replayed: true };
  } catch {
    // corrupted stored result — treat as a conflict, never re-charge
    throw new ApiError(409, 'کلید یکتایی این پرداخت قبلاً استفاده شده است؛ نتیجهٔ ذخیره‌شده قابل خواندن نیست.');
  }
}

/**
 * THE single add-payment mutation for both sales-side entry points
 * (/api/sales-documents action=add-payment and /api/accounting-cartable
 * action=add-payment). Everything the audit demanded lives here:
 *
 *   • strict input validation happens BEFORE this function (shared
 *     parseAddPaymentBody) — no amount ever reaches money code through
 *     a bare Number() cast;
 *   • the live document row (ownership, territory, company stamp,
 *     status policy, finalAmount) and the paid sum are read INSIDE the
 *     write transaction — guards are authoritative, not advisory;
 *   • the audit log (logAction) is written INSIDE the transaction: a
 *     log failure rolls the payment back (F04 — no committed payment
 *     with a lost trail, no error-after-commit);
 *   • a client idempotency key replays the stored result byte-identically
 *     (same key + same payload), refuses a key reuse with a different
 *     payload (409), and a concurrent duplicate insert loses on the
 *     UNIQUE(userId, idemKey) race and replays the winner.
 */
export async function addSalesDocumentPayment(
  user: AuthUser,
  input: CartableAddPaymentInput,
  policy: AddSalesPaymentPolicy,
): Promise<AddSalesPaymentResult> {
  const newAmount = Number(input.amount);
  if (!Number.isInteger(newAmount) || newAmount <= 0) {
    throw new ApiError(400, 'مبلغ پرداخت باید عدد ریالیِ صحیح و بزرگ‌تر از صفر باشد.');
  }
  const paymentDate = input.paymentDate ? new Date(input.paymentDate) : new Date();
  if (Number.isNaN(paymentDate.getTime())) {
    throw new ApiError(400, 'تاریخ پرداخت نامعتبر است.');
  }
  const allowed = await getAllowedCompanyIds(user); // pre-tx (deadlock guard)
  const idemKey = policy.idempotencyKey?.trim() || null;
  const requestHash = idemKey
    ? hashSalesPaymentRequest(input, user.id, policy.source)
    : null;

  return runInTransaction(async (tx) => {
    // ── 1. Idempotency lookup (in-tx; the UNIQUE constraint below still
    //       guards a concurrent insert between the check and the write).
    //       v2.58.5 (R1): a hit NO LONGER short-circuits — the stored
    //       result is only disclosed AFTER the CURRENT access checks
    //       (step 2) pass. A revoked company/territory/ownership scope
    //       denies the replay exactly like a fresh payment.
    let idemRow: StoredSalesIdemRow | null = null;
    if (idemKey) {
      idemRow = (await tx.salesPaymentIdempotency.findUnique({
        where: { userId_idemKey: { userId: user.id, idemKey } },
      })) as StoredSalesIdemRow | null;
      if (idemRow && idemRow.requestHash !== requestHash) {
        // same key, different payload → refused (never silently re-charge)
        throw new ApiError(409, 'این کلید یکتایی با درخواست متفاوتی قبلاً استفاده شده است.');
      }
    }

    // ── 2. LIVE document row — ownership + territory + company + status
    //       + finalAmount all from the transaction's own read. Runs for
    //       BOTH the fresh write AND the replay (R1).
    const doc = await tx.salesDocument.findFirst({
      where: {
        id: input.salesDocumentId,
        ...(policy.businessUnitId ? { businessUnitId: policy.businessUnitId } : {}),
      },
      include: { center: { select: { id: true, province: true, companyId: true } } },
    });
    if (!doc) throw new ApiError(404, 'سند فروش یافت نشد.');

    // ── GUARD ORDER (v2.58.4, issue 1): the TENANT boundary is checked
    // FIRST — a cross-company user gets the company denial (403 on the
    // cartable), never a misleading ownership/territory message. Then
    // territory, then per-user ownership.
    // company stamp on the live row (center fallback for legacy
    // unstamped rows — still fail-closed); the denial convention follows
    // the caller's policy (sales → 404 no-leak, cartable → 403
    // COMPANY_ACCESS_DENIED).
    const denied = policy.companyDenied ?? { status: 404, message: 'سند فروش یافت نشد.' };
    assertCompanyAccess(doc.companyId ?? doc.center?.companyId ?? null, allowed, denied.message, denied.status);

    // territory parity with findDocOrThrow (own centerless docs pass)
    if (policy.territory && doc.center) {
      if (!centerInTerritory({ id: doc.center.id, province: doc.center.province }, policy.territory)) {
        throw new ApiError(404, 'سند فروش یافت نشد.');
      }
    }

    // ownership (the sales route's matrix: a standard salesperson pays
    // only their OWN documents). v2.58.4 (issue 1): the denial follows
    // the caller's convention — sales → 404 no-leak (findDocOrThrow
    // parity), cartable → explicit 403 (files-route convention).
    // v2.58.5 (R1): also enforced on REPLAY — ownership revoked after
    // the payment denies the stored result.
    if (policy.requireOwnership && doc.createdById !== user.id) {
      const ownDenied = policy.ownershipDenied ?? { status: 404, message: 'سند فروش یافت نشد.' };
      throw new ApiError(ownDenied.status, ownDenied.message);
    }

    // ── 2b. REPLAY (R1): current access verified → return the STORED
    //        result and write NOTHING. The status/balance policies below
    //        apply ONLY to fresh money — an allowed replay must never be
    //        refused (nor grow a receipt) merely because the invoice
    //        settled or the document changed status afterwards.
    if (idemRow) {
      return parseStoredSalesResult(idemRow);
    }

    // status policy — the two routes' contracts, made explicit (F03:
    // deliberately NOT unified)
    if (policy.statusPolicy === 'approved-only') {
      if (doc.status !== 'approved') {
        throw new ApiError(400, 'فقط اسناد تأیید شده قابل ثبت پرداخت هستند.');
      }
    } else if (doc.status === 'cancelled' || doc.status === 'rejected') {
      throw new ApiError(400, 'ثبت پرداخت برای سند لغوشده یا ردشده مجاز نیست.');
    }

    // ── 3. AUTHORITATIVE in-tx overpayment guard.
    const livePaid = await sumPaymentsInTx(tx, input.salesDocumentId);
    if (livePaid + newAmount > doc.finalAmount) {
      throw new ApiError(
        400,
        `مجموع پرداخت‌ها (${(livePaid + newAmount).toLocaleString('fa-IR')} ریال) از مبلغ نهایی سند (${doc.finalAmount.toLocaleString('fa-IR')} ریال) بیشتر است.`,
      );
    }

    // ── 4. The receipt + invoice mirror + account recalc.
    //    v2.58.4 (issue 1): the payment CREATOR is recorded — the
    //    ownership matrix on the cartable needs it.
    const record = await tx.salesDocumentFinance.create({
      data: {
        salesDocumentId: input.salesDocumentId,
        paymentMethod: input.paymentMethod || 'cash',
        paymentDate,
        amount: newAmount,
        referenceNumber: input.referenceNumber || null,
        description: input.description || '',
        createdById: user.id,
      },
    });

    await syncPaymentToLinkedInvoice(tx, doc, {
      amount: newAmount,
      paymentDate,
      referenceNumber: input.referenceNumber || null,
      description: input.description || '',
    });

    if (doc.centerId) {
      await recalcCenterAccount(tx, doc.centerId);
    }

    // ── 5. The audit log, INSIDE the transaction (F04): a log failure
    //       now rolls the payment back — a committed payment can never
    //       lack its trail, and an error response never lies about
    //       "nothing was saved".
    if (policy.logAction) {
      await tx.salesDocumentLog.create({
        data: {
          salesDocumentId: input.salesDocumentId,
          userId: user.id,
          action: policy.logAction,
          details: JSON.stringify({
            amount: newAmount,
            paymentMethod: input.paymentMethod || 'cash',
            referenceNumber: input.referenceNumber ?? null,
            totalPaidBefore: livePaid,
            totalPaidAfter: livePaid + newAmount,
            documentFinalAmount: doc.finalAmount,
            source: policy.source,
          }),
        },
      });
    }

    const result: AddSalesPaymentResult = {
      record,
      replayed: false,
      message: 'پرداخت با موفقیت ثبت شد.',
    };

    // ── 6. Persist the idempotency record; a concurrent duplicate insert
    //       loses on UNIQUE(userId, idemKey) → replay the winner.
    if (idemKey && idemRow === null) {
      try {
        await tx.salesPaymentIdempotency.create({
          data: {
            userId: user.id,
            idemKey,
            requestHash: requestHash!,
            salesDocumentId: input.salesDocumentId,
            financeRecordId: record.id,
            resultJson: JSON.stringify(result),
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          const winner = (await tx.salesPaymentIdempotency.findUnique({
            where: { userId_idemKey: { userId: user.id, idemKey } },
          })) as StoredSalesIdemRow | null;
          if (winner) {
            if (winner.requestHash !== requestHash) {
              throw new ApiError(409, 'این کلید یکتایی با درخواست متفاوتی قبلاً استفاده شده است.');
            }
            return parseStoredSalesResult(winner);
          }
        }
        throw e;
      }
    }

    return result;
  });
}

/**
 * Register a cartable payment (kept as the cartable route's entry point;
 * the real mutation is addSalesDocumentPayment above).
 * v2.58.4: gains an in-transaction audit log (the cartable mutations
 * previously left NO SalesDocumentLog trail) and idempotency-key support.
 *
 * v2.58.4 (user issue 1) — THE OWNERSHIP MATRIX: the route gate lets
 * every finance_write holder through (standard salespeople carry
 * finance_write), but a finance_write-ONLY user is now restricted to
 * their OWN documents (ownership + territory, like the sales route's
 * matrix) instead of the whole company's ledger. Full cartable holders
 * (accounting_cartable: admin, finance) keep the finance-wide reach.
 */
export async function addCartablePayment(
  user: AuthUser,
  input: CartableAddPaymentInput,
  idempotencyKey?: string | null,
) {
  const perms = getRolePermissions(user.role);
  const ownershipRequired = !perms.accounting_cartable; // finance_write-only
  const result = await addSalesDocumentPayment(user, input, {
    statusPolicy: 'active-documents',
    // NO businessUnitId: the accounting cartable keeps its finance-wide
    // reach across units (the pre-v2.58.4 behavior; the SALES route is the
    // one that pins the caller's business unit).
    ...(ownershipRequired
      ? {
          requireOwnership: true,
          territory: resolveTerritoryScope(user),
          // v2.58.4 (issue 1): explicit 403 denials on the cartable —
          // the files-route convention for «not your row», not the
          // sales route's 404 no-leak.
          ownershipDenied: { status: 403, message: PAYMENT_OWNERSHIP_DENIED },
        }
      : {}),
    logAction: 'add_payment',
    idempotencyKey,
    source: 'accounting-cartable',
    // v2.58.4 (issue 1): cross-company on the cartable → explicit 403
    // (restored pre-v2.58.4 behavior; the user's mandatory matrix).
    companyDenied: { status: 403, message: COMPANY_ACCESS_DENIED },
  });
  return result.record;
}

// ── UPDATE (the finding-3 race fix) ─────────────────────────

/**
 * Edit a cartable payment. THE RACE FIX: the target row, the parent
 * document (access + status + finalAmount) and the sum of the OTHER
 * payments are ALL read inside the write transaction; the
 * overpayment guard, the edit, the linked-invoice rebuild and the
 * account recalc commit atomically. Two concurrent edits cannot both
 * pass on a stale snapshot — the later one re-evaluates against the
 * committed state and is refused with a controlled 400 (nothing
// partial survives).
 */
export async function updateCartablePayment(
  user: AuthUser,
  input: CartableUpdatePaymentInput,
) {
  const allowed = await getAllowedCompanyIds(user); // pre-tx (deadlock guard)
  // v2.58.4 (issue 1) — the ownership matrix: finance_write-ONLY users
  // (standard salespeople) may edit only THEIR OWN payment rows on THEIR
  // OWN documents; full cartable holders keep the finance-wide reach.
  const perms = getRolePermissions(user.role);
  const ownershipRequired = !perms.accounting_cartable;
  // v2.58.10 (final-review P1) — territory parity: the SAME scope the add
  // path applies, resolved from the live user (pre-tx is safe — it is
  // user-derived, not DB-derived).
  const territory = ownershipRequired ? resolveTerritoryScope(user) : null;

  return runInTransaction(async (tx) => {
    // LIVE target row (in-tx — a concurrent edit/delete is honored)
    const existing = await tx.salesDocumentFinance.findUnique({
      where: { id: input.paymentId },
    });
    if (!existing) throw new ApiError(404, 'رکورد پرداخت یافت نشد.');

    // LIVE parent document (access + status + finalAmount, in-tx);
    // v2.58.4 (issue 1): cross-company on the cartable → 403.
    const doc = await loadDocInTxGuarded(tx, existing.salesDocumentId, allowed, {
      status: 403,
      message: COMPANY_ACCESS_DENIED,
    });

    // v2.58.10 (final-review P1) — TERRITORY parity with addCartablePayment
    // (guard order company → territory → ownership; own centerless docs
    // pass, mirroring the add path's findDocOrThrow parity).
    if (territory && doc.center) {
      if (!centerInTerritory({ id: doc.center.id, province: doc.center.province }, territory)) {
        throw new ApiError(404, 'سند فروش یافت نشد.');
      }
    }

    // v2.58.4 (issue 1) — ownership for finance_write-only users:
    // BOTH the document AND the payment row must be theirs (a legacy
    // NULL-creator row is NOT theirs — fail-closed).
    if (ownershipRequired) {
      if (doc.createdById !== user.id) throw new ApiError(403, PAYMENT_OWNERSHIP_DENIED);
      if (existing.createdById === null || existing.createdById !== user.id) {
        throw new ApiError(403, PAYMENT_CREATOR_DENIED);
      }
    }

    const amountChanging = input.amount !== undefined && Number(input.amount) !== existing.amount;
    let newAmount = existing.amount;
    if (amountChanging) {
      newAmount = Number(input.amount);
      if (newAmount <= 0) throw new ApiError(400, 'مبلغ پرداخت باید بزرگتر از صفر باشد.');
      if (!Number.isInteger(newAmount)) throw new ApiError(400, 'مبلغ پرداخت باید عدد ریالیِ صحیح باشد.');

      // v2.58.3 (finding 3) — THE FIX: the other payments are re-summed
      // INSIDE this transaction (SQLite serializes writers), so a
      // concurrent edit that already committed is included here. The
      // stale-snapshot race (doc 100 = 40 + 40, both edits to 60 → 120)
      // is impossible: the second transaction sees the first 60 and the
      // 60 + 60 = 120 > 100 check refuses it.
      const otherTotal = await sumPaymentsInTx(tx, existing.salesDocumentId, input.paymentId);
      if (otherTotal + newAmount > doc.finalAmount) {
        throw new ApiError(
          400,
          `مجموع پرداخت‌ها (${(otherTotal + newAmount).toLocaleString('fa-IR')} ریال) از مبلغ نهایی سند (${doc.finalAmount.toLocaleString('fa-IR')} ریال) بیشتر می‌شود.`,
        );
      }
    }

    const record = await tx.salesDocumentFinance.update({
      where: { id: input.paymentId },
      data: {
        ...(input.paymentMethod !== undefined && { paymentMethod: input.paymentMethod }),
        ...(input.paymentDate && { paymentDate: new Date(input.paymentDate) }),
        ...(input.amount !== undefined && { amount: newAmount }),
        ...(input.referenceNumber !== undefined && { referenceNumber: input.referenceNumber || null }),
        ...(input.description !== undefined && { description: input.description || '' }),
      },
    });

    // v2.58.4 (F04) — the audit trail lands INSIDE the same transaction
    // (the cartable mutations previously left NO SalesDocumentLog row).
    await tx.salesDocumentLog.create({
      data: {
        salesDocumentId: existing.salesDocumentId,
        userId: user.id,
        action: 'update_payment',
        details: JSON.stringify({
          paymentId: input.paymentId,
          amountBefore: existing.amount,
          amountAfter: newAmount,
          source: 'accounting-cartable',
        }),
      },
    });

    // rebuild the mirrored invoice payments + account totals in the SAME
    // transaction (v2.13.0 semantics kept, now sharing one tx with the guard)
    await rebuildLinkedInvoicePayments(tx, doc);
    if (doc.centerId) {
      await recalcCenterAccount(tx, doc.centerId);
    }
    return record;
  });
}

// ── DELETE ──────────────────────────────────────────────────

/**
 * Delete a cartable payment: guarded read + delete + rebuild + recalc
 * all inside ONE transaction.
 */
export async function deleteCartablePayment(user: AuthUser, paymentId: string) {
  if (!paymentId) throw new ApiError(400, 'شناسه پرداخت الزامی است.');
  const allowed = await getAllowedCompanyIds(user); // pre-tx (deadlock guard)
  // v2.58.4 (issue 1) — the ownership matrix (same as update).
  const perms = getRolePermissions(user.role);
  const ownershipRequired = !perms.accounting_cartable;
  // v2.58.10 (final-review P1) — territory parity (same as update).
  const territory = ownershipRequired ? resolveTerritoryScope(user) : null;
  return runInTransaction(async (tx) => {
    const existing = await tx.salesDocumentFinance.findUnique({
      where: { id: paymentId },
    });
    if (!existing) throw new ApiError(404, 'رکورد پرداخت یافت نشد.');

    // v2.58.4 (issue 1): cross-company on the cartable → 403.
    const doc = await loadDocInTxGuarded(tx, existing.salesDocumentId, allowed, {
      status: 403,
      message: COMPANY_ACCESS_DENIED,
    });

    // v2.58.10 (final-review P1) — TERRITORY parity (see update above).
    if (territory && doc.center) {
      if (!centerInTerritory({ id: doc.center.id, province: doc.center.province }, territory)) {
        throw new ApiError(404, 'سند فروش یافت نشد.');
      }
    }

    if (ownershipRequired) {
      if (doc.createdById !== user.id) throw new ApiError(403, PAYMENT_OWNERSHIP_DENIED);
      if (existing.createdById === null || existing.createdById !== user.id) {
        throw new ApiError(403, PAYMENT_CREATOR_DENIED);
      }
    }

    await tx.salesDocumentFinance.delete({ where: { id: paymentId } });

    // v2.58.4 (F04) — the audit trail lands INSIDE the same transaction.
    await tx.salesDocumentLog.create({
      data: {
        salesDocumentId: existing.salesDocumentId,
        userId: user.id,
        action: 'delete_payment',
        details: JSON.stringify({
          paymentId,
          amountDeleted: existing.amount,
          source: 'accounting-cartable',
        }),
      },
    });

    await rebuildLinkedInvoicePayments(tx, doc);
    if (doc.centerId) {
      await recalcCenterAccount(tx, doc.centerId);
    }
    return { salesDocumentId: existing.salesDocumentId };
  });
}
