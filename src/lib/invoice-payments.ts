import { createHash } from 'crypto';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api-error';
import { parseIntRial, RIAL_MAX, sumRial } from '@/lib/money';
import { recalcCenterAccount, runInTransaction } from '@/lib/finance-sync';
import type { Prisma, IssuedInvoicePayment } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// invoice-payments.ts — v2.58.1 (round 86, audits F1 + F2 + F3)
//
// THE SINGLE SERVER-SIDE SERVICE that registers a payment on an
// issued invoice. Every money-writing entry point funnels through
// registerInvoicePayment():
//   • /api/billing action=add-payment   (source 'manual')
//   • /api/billing action=mark-paid     (source 'settlement' —
//     «ثبت دریافت مانده و تسویه»: settles the REAL remaining balance,
//     never a bare status flip)
//   • /api/billing action=create        (source 'issue' — the optional
//     payment accompanying a hand-created invoice, inside the same
//     transaction as the invoice row itself)
//
// Contract (all guarantees verified on real SQLite in
// tests/billing-payments.test.ts):
//  1. The invoice (and its linked sales document) is re-read INSIDE the
//     write transaction — the balance check is authoritative, not a
//     stale pre-transaction snapshot. Two concurrent 60-Rial payments
//     on a 100-Rial invoice: exactly one is committed.
//  2. A client-supplied idempotency key is protected by the DB UNIQUE
//     constraint IssuedInvoicePaymentIdempotency(userId, idemKey):
//     same key + same payload → the stored result is replayed
//     byte-identically (one receipt, ever); same key + different
//     payload → 409. The key namespace is per-user (ownership scope).
//  3. Receipt row + invoice paidAmount/status + mirrored
//     SalesDocumentFinance row + recalcCenterAccount all land in ONE
//     transaction — a mid-flight failure leaves zero financial effect.
//  4. Void invoices refuse payments; a settlement of an
//     already-settled invoice is a no-op that creates NO new receipt.
//
// Pure helpers (validateInvoiceItems / hashPaymentRequest /
// settlementAmountFor) are unit-tested without a DB.
// ═══════════════════════════════════════════════════════════════

type Tx = Prisma.TransactionClient;

export type PaymentSource = 'manual' | 'settlement' | 'issue';

// ── Input caps (F3: bounded rows, bounded text) ────────────────
export const MAX_INVOICE_ITEMS = 500;
export const MAX_PAYMENT_TEXT = 500;
export const MAX_INVOICE_NUMBER_LEN = 64;
/** Max sane quantity in one invoice row (unitPrice is capped by RIAL_MAX). */
export const MAX_ROW_QUANTITY = 1e9;

// ═══════════════════════════════════════════════════════════════
//  PURE VALIDATORS (F3)
// ═══════════════════════════════════════════════════════════════

export interface ValidatedInvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
  /** Server-computed: Math.round(quantity × unitPrice) — integer Rial. */
  totalPrice: number;
}

export type ItemsValidation =
  | { ok: true; rows: ValidatedInvoiceItem[]; itemsTotal: number }
  | { ok: false; error: string };

/**
 * F3 — validate raw invoice rows from an untrusted request body.
 *  • at most MAX_INVOICE_ITEMS rows;
 *  • description: trimmed non-empty string ≤ MAX_PAYMENT_TEXT chars;
 *  • quantity: finite number, strictly > 0, ≤ MAX_ROW_QUANTITY;
 *  • unitPrice: integer Rial ≥ 0 (parseIntRial) ≤ RIAL_MAX;
 *  • row total is ALWAYS server-computed — the client's totalPrice is
 *    never persisted (a client sum is not a source of truth);
 *  • itemsTotal = exact integer-Rial sum of the server-computed rows.
 */
export function validateInvoiceItems(items: unknown): ItemsValidation {
  if (items === undefined || items === null) return { ok: true, rows: [], itemsTotal: 0 };
  if (!Array.isArray(items)) {
    return { ok: false, error: 'اقلام فاکتور باید به‌صورت فهرست ارسال شوند.' };
  }
  if (items.length > MAX_INVOICE_ITEMS) {
    return { ok: false, error: `حداکثر ${MAX_INVOICE_ITEMS} ردیف در هر فاکتور مجاز است.` };
  }
  const rows: ValidatedInvoiceItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] as Record<string, unknown> | null;
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: `ردیف ${i + 1} نامعتبر است.` };
    }
    const description =
      typeof raw.description === 'string' ? raw.description.trim().slice(0, MAX_PAYMENT_TEXT) : '';
    if (!description) {
      return { ok: false, error: `شرح ردیف ${i + 1} الزامی است.` };
    }
    const quantity = Number(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_ROW_QUANTITY) {
      return { ok: false, error: `تعداد ردیف ${i + 1} باید عددی بزرگ‌تر از صفر و منطقی باشد.` };
    }
    const unitPrice = parseIntRial(raw.unitPrice);
    if (unitPrice === null || unitPrice < 0) {
      return { ok: false, error: `قیمت واحد ردیف ${i + 1} باید عددی صحیح و غیرمنفی باشد.` };
    }
    if (unitPrice > RIAL_MAX) {
      return { ok: false, error: `قیمت واحد ردیف ${i + 1} غیرمنطقی است.` };
    }
    // Rounding policy (money.ts integer-Rial invariant): quantities may be
    // fractional (1.5 kg) but money is always integer Rial — half-up.
    const rowTotal = Math.round(quantity * unitPrice);
    if (rowTotal > RIAL_MAX) {
      return { ok: false, error: `مبلغ ردیف ${i + 1} از سقف مجاز بیشتر است.` };
    }
    rows.push({ description, quantity, unitPrice, totalPrice: rowTotal });
  }
  return { ok: true, rows, itemsTotal: rows.length > 0 ? sumRial(rows.map((r) => r.totalPrice)) : 0 };
}

export interface AmountValidation {
  ok: boolean;
  amount?: number;
  error?: string;
}

/** F3 — integer-Rial validation for a payment/receipt amount. */
export function validatePaymentAmount(raw: unknown): AmountValidation {
  const amount = parseIntRial(raw);
  if (amount === null || amount <= 0) {
    return { ok: false, error: 'مبلغ پرداخت باید عددی صحیح و بزرگ‌تر از صفر باشد.' };
  }
  if (amount > RIAL_MAX) {
    return { ok: false, error: 'مبلغ پرداخت غیرمنطقی است.' };
  }
  return { ok: true, amount };
}

/** F1 — the REAL remaining balance of an invoice (never negative). */
export function settlementAmountFor(invoice: { totalAmount: number; paidAmount: number }): number {
  return Math.max(0, Math.round(invoice.totalAmount) - Math.round(invoice.paidAmount));
}

/** Stable hash of the client-visible payment payload (idempotency scope). */
export function hashPaymentRequest(input: {
  invoiceId: string;
  amount: number;
  referenceNumber?: string | null;
  description?: string | null;
  source: PaymentSource;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        invoiceId: input.invoiceId,
        amount: input.amount,
        referenceNumber: input.referenceNumber ?? null,
        description: input.description ?? null,
        source: input.source,
      }),
    )
    .digest('hex');
}

// ═══════════════════════════════════════════════════════════════
//  THE SERVICE
// ═══════════════════════════════════════════════════════════════

export interface RegisterPaymentInput {
  invoiceId: string;
  amount: number;
  userId: string;
  referenceNumber?: string | null;
  description?: string;
  paymentDate?: Date;
  /** Optional client idempotency key (scoped to userId). */
  idempotencyKey?: string | null;
  source: PaymentSource;
  /**
   * In-transaction company re-assertion (fail-closed, 404 — no existence
   * leak): when provided, the invoice's center company must be in the list.
   * Mirrors guardInTx in the sales-documents route. Omitted = caller opts
   * out (e.g. source='issue', where the invoice row was just created).
   */
  allowedCompanyIds?: string[];
}

export interface RegisterPaymentResult {
  payment: IssuedInvoicePayment | null;
  newPaidAmount: number;
  newStatus: string;
  invoiceId: string;
  /** True when an idempotency-key hit replayed the stored result. */
  replayed: boolean;
  /** True when a settlement found the invoice already settled (no receipt). */
  alreadySettled: boolean;
  message: string;
}

interface StoredIdemRow {
  id: string;
  userId: string;
  idemKey: string;
  requestHash: string;
  invoiceId: string;
  paymentId: string;
  resultJson: string;
}

function parseStoredResult(row: StoredIdemRow): RegisterPaymentResult {
  try {
    const parsed = JSON.parse(row.resultJson) as RegisterPaymentResult;
    return { ...parsed, replayed: true };
  } catch {
    // corrupted stored result — treat as a conflict, never re-charge
    throw new ApiError(409, 'کلید یکتایی این پرداخت قبلاً استفاده شده است؛ نتیجهٔ ذخیره‌شده قابل خواندن نیست.');
  }
}

/**
 * Register a payment on an issued invoice (see module contract).
 *
 * @param externalTx pass the caller's transaction for source='issue'
 *        (the invoice row is created in the SAME transaction); omit for
 *        sources 'manual'/'settlement' — the service opens its own.
 */
export async function registerInvoicePayment(
  input: RegisterPaymentInput,
  externalTx?: Tx,
): Promise<RegisterPaymentResult> {
  const amt = input.amount;
  if (!Number.isFinite(amt) || amt < 0 || (amt === 0 && input.source !== 'settlement')) {
    throw new ApiError(400, 'مبلغ پرداخت باید عددی بزرگ‌تر از صفر باشد.');
  }
  // A settlement of amount 0 means "nothing remains" — the no-op answer
  // (an already-settled invoice never grows a new receipt). The route's
  // pre-transaction check normally catches this; the service accepts it
  // so the semantic holds even when the live state changed mid-flight.
  if (amt === 0) {
    const invoice = await (externalTx ?? db).issuedInvoice.findUnique({
      where: { id: input.invoiceId },
    });
    if (!invoice) throw new ApiError(404, 'فاکتور یافت نشد.');
    return {
      payment: null,
      newPaidAmount: Math.round(invoice.paidAmount),
      newStatus: invoice.status,
      invoiceId: invoice.id,
      replayed: false,
      alreadySettled: invoice.status === 'paid' || invoice.paidAmount >= invoice.totalAmount,
      message: 'این فاکتور قبلاً تسویه شده است؛ رسید جدیدی ثبت نشد.',
    };
  }

  const run = async (tx: Tx): Promise<RegisterPaymentResult> => {
    // ── 1. Idempotency lookup (inside the tx — the UNIQUE constraint
    //       below still guards a concurrent insert between check and write).
    //       v2.58.5 (R1): a hit NO LONGER short-circuits — the stored
    //       result is disclosed only AFTER the CURRENT company scope is
    //       re-verified against the live invoice row (step 2).
    let idemRow: StoredIdemRow | null = null;
    if (input.idempotencyKey) {
      idemRow = (await tx.issuedInvoicePaymentIdempotency.findUnique({
        where: { userId_idemKey: { userId: input.userId, idemKey: input.idempotencyKey } },
      })) as StoredIdemRow | null;
      if (idemRow) {
        const expectedHash = hashPaymentRequest({
          invoiceId: input.invoiceId,
          amount: amt,
          referenceNumber: input.referenceNumber ?? null,
          description: input.description ?? null,
          source: input.source,
        });
        if (idemRow.requestHash !== expectedHash) {
          // same key, different payload → rejected (never silently re-charge)
          throw new ApiError(409, 'این کلید یکتایی با درخواست متفاوتی قبلاً استفاده شده است.');
        }
      }
    }

    // ── 2. Authoritative re-read INSIDE the transaction (F2 core). Runs
    //       for BOTH the fresh write AND the replay (R1) — the company
    //       scope below is the CALLER'S CURRENT scope, not the one that
    //       held when the payment was first registered.
    const invoice = await tx.issuedInvoice.findUnique({
      where: { id: input.invoiceId },
      include: {
        centerAccount: {
          include: { center: { select: { id: true, companyId: true, province: true } } },
        },
      },
    });
    if (!invoice) {
      throw new ApiError(404, 'فاکتور یافت نشد.');
    }

    // In-transaction company re-assertion (defense in depth — the route
    // checked pre-transaction for a clean 404; this catches races).
    // `allowedCompanyIds` undefined = caller opted out (none provided).
    // v2.58.5 (R1): enforced on the REPLAY path too — a revoked scope
    // must not be able to read the stored payment result.
    if (input.allowedCompanyIds) {
      const invCompany = invoice.centerAccount?.center?.companyId;
      // Invoices without a company-attributable account stay admin-only.
      if (!invCompany || !input.allowedCompanyIds.includes(invCompany)) {
        throw new ApiError(404, 'فاکتور یافت نشد.');
      }
    }

    // ── 2b. REPLAY (R1): current scope verified → the STORED result,
    //        zero writes. The void/status/balance checks below govern
    //        FRESH money only — an allowed replay must never be refused
    //        (nor grow a receipt) merely because the invoice settled.
    if (idemRow) {
      return parseStoredResult(idemRow);
    }

    if (invoice.status === 'void') {
      throw new ApiError(400, 'امکان ثبت پرداخت بر روی فاکتور ابطال‌شده وجود ندارد.');
    }

    // Linked sales document: re-read status inside the tx (F2 — the
    // pre-transaction check is advisory only).
    if (invoice.salesDocumentId) {
      const linkedDoc = await tx.salesDocument.findUnique({
        where: { id: invoice.salesDocumentId },
        select: { status: true },
      });
      if (!linkedDoc || linkedDoc.status !== 'approved') {
        throw new ApiError(400, 'سند فروش متناظر این فاکتور تأییدشده نیست؛ ثبت پرداخت ممکن نیست.');
      }
    }

    // ── 3. Balance check INSIDE the transaction (F2 acceptance:
    //       60+60 on 100 → one rejected; 40+60 → exactly 100 & settled).
    const currentPaid = Math.round(invoice.paidAmount);
    const total = Math.round(invoice.totalAmount);
    if (input.source === 'settlement') {
      const remaining = Math.max(0, total - currentPaid);
      if (remaining <= 0) {
        // F1: an already-settled invoice must never grow a new receipt.
        return {
          payment: null,
          newPaidAmount: currentPaid,
          newStatus: invoice.status,
          invoiceId: invoice.id,
          replayed: false,
          alreadySettled: true,
          message: 'این فاکتور قبلاً تسویه شده است؛ رسید جدیدی ثبت نشد.',
        };
      }
      if (remaining < amt) {
        throw new ApiError(
          409,
          `ماندهٔ فاکتور هم‌اکنون ${(remaining).toLocaleString('fa-IR')} ریال است — کمتر از مبلغ درخواستی. عملیات ثبت نشد.`,
        );
      }
    } else {
      if (currentPaid + amt > total) {
        throw new ApiError(
          400,
          `مبلغ پرداخت (${amt.toLocaleString('fa-IR')} ریال) از مانده فاکتور (${(total - currentPaid).toLocaleString('fa-IR')} ریال) بیشتر است.`,
        );
      }
    }

    // ── 4. Write the receipt + mirror + account totals atomically.
    const payment = await tx.issuedInvoicePayment.create({
      data: {
        issuedInvoiceId: invoice.id,
        amount: amt,
        paymentDate: input.paymentDate ?? new Date(),
        referenceNumber: input.referenceNumber ? input.referenceNumber.trim().slice(0, MAX_PAYMENT_TEXT) || null : null,
        description: input.description ? input.description.trim().slice(0, MAX_PAYMENT_TEXT) : '',
      },
    });

    const newPaidAmount = currentPaid + amt;
    const newStatus = newPaidAmount >= total ? 'paid' : 'issued';
    await tx.issuedInvoice.update({
      where: { id: invoice.id },
      data: { paidAmount: newPaidAmount, status: newStatus },
    });

    // Mirror onto the sales document's finance records (same rule the
    // sales-side add-payment applies through syncPaymentToLinkedInvoice —
    // here the direction is billing → document).
    if (invoice.salesDocumentId) {
      await tx.salesDocumentFinance.create({
        data: {
          salesDocumentId: invoice.salesDocumentId,
          paymentMethod: 'transfer',
          paymentDate: input.paymentDate ?? new Date(),
          amount: amt,
          referenceNumber: input.referenceNumber ? input.referenceNumber.trim().slice(0, MAX_PAYMENT_TEXT) || null : null,
          description: input.description?.trim().slice(0, MAX_PAYMENT_TEXT) || 'ثبت‌شده از صفحه فاکتور حسابداری',
        },
      });
    }

    const centerId = invoice.centerAccount?.centerId;
    if (centerId) {
      await recalcCenterAccount(tx, centerId);
    }

    const result: RegisterPaymentResult = {
      payment,
      newPaidAmount,
      newStatus,
      invoiceId: invoice.id,
      replayed: false,
      alreadySettled: false,
      message: newStatus === 'paid' ? 'پرداخت ثبت شد و فاکتور تسویه شد.' : 'پرداخت با موفقیت ثبت شد.',
    };

    // ── 5. Persist the idempotency record. A concurrent duplicate insert
    //       loses on the UNIQUE(userId, idemKey) race → replay the winner.
    if (input.idempotencyKey && idemRow === null) {
      try {
        await tx.issuedInvoicePaymentIdempotency.create({
          data: {
            userId: input.userId,
            idemKey: input.idempotencyKey,
            requestHash: hashPaymentRequest({
              invoiceId: input.invoiceId,
              amount: amt,
              referenceNumber: input.referenceNumber ?? null,
              description: input.description ?? null,
              source: input.source,
            }),
            invoiceId: invoice.id,
            paymentId: payment.id,
            resultJson: JSON.stringify(result),
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          const winner = (await tx.issuedInvoicePaymentIdempotency.findUnique({
            where: { userId_idemKey: { userId: input.userId, idemKey: input.idempotencyKey } },
          })) as StoredIdemRow | null;
          if (winner) {
            const expectedHash = hashPaymentRequest({
              invoiceId: input.invoiceId,
              amount: amt,
              referenceNumber: input.referenceNumber ?? null,
              description: input.description ?? null,
              source: input.source,
            });
            if (winner.requestHash !== expectedHash) {
              throw new ApiError(409, 'این کلید یکتایی با درخواست متفاوتی قبلاً استفاده شده است.');
            }
            return parseStoredResult(winner);
          }
        }
        throw e;
      }
    }

    return result;
  };

  if (externalTx) return run(externalTx);
  return runInTransaction(run);
}
