import { db } from '@/lib/db';
import type { Prisma, SalesDocument, IssuedInvoice } from '@prisma/client';

/**
 * Finance synchronization helpers (v2.13.0 — fourth-round audit fixes).
 *
 * Before v2.13.0 the sales flow and the accounting flow were two parallel
 * worlds that only met by accident:
 *  - quick-sale invoices never created a CenterAccount or an IssuedInvoice;
 *  - directly-approved invoices only got accounting effects when they were
 *    proforma-derived;
 *  - payments were applied to "the newest open invoice of the same customer
 *    and approver" — a guess with no definitive link;
 *  - cancelling an approved document reverted nothing.
 *
 * This module is the single place where sales documents and the accounting
 * ledger (CenterAccount + IssuedInvoice + IssuedInvoicePayment) meet.
 *
 * Involved models:
 *  - SalesDocument (proforma / invoice / return) — the sales world
 *  - CenterAccount (1:1 per center) — totalSales / totalPaid / balance
 *  - IssuedInvoice — the accounting invoice; v2.13.0 adds the definitive
 *    `salesDocumentId` link
 *  - IssuedInvoicePayment — invoice-level payment records
 *
 * Account math (authoritative, recomputed by recalcCenterAccount):
 *  totalSales = Σ finalAmount(approved invoice docs)
 *             − Σ finalAmount(approved return docs)
 *             + Σ totalAmount(non-void hand-created invoices)
 *  totalPaid  = Σ payments on non-void invoices of the account
 *             + Σ finance records on approved docs whose linked invoice is
 *               missing (legacy rows approved before the link existed)
 *  balance    = totalSales − totalPaid
 */

type Tx = Prisma.TransactionClient;
type DbOrTx = typeof db | Tx;

/**
 * v2.13.0 — interactive-transaction runner tuned for SQLite write contention.
 * Concurrent writers queue on the database's single write lock, so Prisma's
 * default 5s interactive-transaction timeout expired under bursts of parallel
 * requests (observed as 500s with "Transaction already closed … 10044 ms").
 * 20s timeout / 5s connection-acquisition keeps bursts durable.
 */
export async function runInTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.$transaction(fn, { timeout: 20_000, maxWait: 5_000 });
}

/** Minimal document shape needed by the sync helpers. */
export type SyncDoc = Pick<
  SalesDocument,
  'id' | 'centerId' | 'documentNumber' | 'documentType' | 'finalAmount' | 'status'
>;

// ════════════════════════════════════════════════════════════
//  Center account
// ════════════════════════════════════════════════════════════

/** Find-or-create the 1:1 CenterAccount row for a center. */
export async function ensureCenterAccount(tx: DbOrTx, centerId: string) {
  const existing = await tx.centerAccount.findUnique({ where: { centerId } });
  if (existing) return existing;
  return tx.centerAccount.create({
    data: { centerId, totalSales: 0, totalPaid: 0, balance: 0 },
  });
}

/**
 * Recompute a center's account from the authoritative sources (see module
 * doc). Every mutation path — approval, payment, cancel, void — funnels
 * through here, so incremental drift is impossible by construction.
 */
export async function recalcCenterAccount(tx: DbOrTx, centerId: string) {
  await ensureCenterAccount(tx, centerId);

  const invoiceSalesAgg = await tx.salesDocument.aggregate({
    _sum: { finalAmount: true },
    where: { centerId, status: 'approved', documentType: 'invoice' },
  });
  const returnAgg = await tx.salesDocument.aggregate({
    _sum: { finalAmount: true },
    where: { centerId, status: 'approved', documentType: 'return' },
  });

  // Hand-created (billing screen) invoices have no sales document; their
  // totals still count as sales for the center.
  const handInvoiceAgg = await tx.issuedInvoice.aggregate({
    _sum: { totalAmount: true },
    where: {
      salesDocumentId: null,
      status: { not: 'void' },
      centerAccount: { centerId },
    },
  });

  // Invoice-level payments (mirrored from finance records for linked docs,
  // or registered directly on the billing screen for hand invoices).
  const invoicePaidAgg = await tx.issuedInvoicePayment.aggregate({
    _sum: { amount: true },
    where: {
      issuedInvoice: {
        status: { not: 'void' },
        centerAccount: { centerId },
      },
    },
  });

  // Finance records count ONLY when their document has no live (non-void)
  // linked invoice — legacy docs approved before v2.13.0, or docs whose
  // invoice was voided on the billing side. Otherwise the same money would
  // be counted twice (finance record + mirrored invoice payment).
  const legacyPaidDocs = await tx.salesDocument.findMany({
    where: {
      centerId,
      status: 'approved',
      NOT: { issuedInvoices: { some: { status: { not: 'void' } } } },
    },
    select: { id: true },
  });
  let legacyPaid = 0;
  if (legacyPaidDocs.length > 0) {
    const legacyPaidAgg = await tx.salesDocumentFinance.aggregate({
      _sum: { amount: true },
      where: { salesDocumentId: { in: legacyPaidDocs.map((d) => d.id) } },
    });
    legacyPaid = legacyPaidAgg._sum.amount || 0;
  }

  const totalSales =
    (invoiceSalesAgg._sum.finalAmount || 0) -
    (returnAgg._sum.finalAmount || 0) +
    (handInvoiceAgg._sum.totalAmount || 0);
  const totalPaid = (invoicePaidAgg._sum.amount || 0) + legacyPaid;

  await tx.centerAccount.update({
    where: { centerId },
    data: { totalSales, totalPaid, balance: totalSales - totalPaid },
  });

  return { totalSales, totalPaid, balance: totalSales - totalPaid };
}

// ════════════════════════════════════════════════════════════
//  Definitive document ↔ invoice link
// ════════════════════════════════════════════════════════════

/**
 * The invoice DEFINITIVELY linked to this sales document:
 *  1. the v2.13.0 `salesDocumentId` foreign key;
 *  2. legacy fallback — invoiceNumber === documentNumber (invoice docs).
 * Never a guess by customer/approver/date.
 */
export async function findLinkedInvoice(
  tx: DbOrTx,
  doc: Pick<SyncDoc, 'id' | 'documentType' | 'documentNumber'>,
): Promise<IssuedInvoice | null> {
  const byFk = await tx.issuedInvoice.findFirst({
    where: { salesDocumentId: doc.id },
  });
  if (byFk) return byFk;
  if (doc.documentType === 'invoice' && doc.documentNumber) {
    return tx.issuedInvoice.findFirst({
      where: { invoiceNumber: doc.documentNumber },
    });
  }
  return null;
}

/**
 * Create the linked accounting invoice for an approved invoice-type sales
 * document (direct approval, proforma-derived, or quick-sale). Idempotent:
 * if a linked invoice already exists it is returned unchanged.
 */
export async function issueInvoiceForDocument(
  tx: Tx,
  doc: SyncDoc & { totalAmount: number; discountAmount: number; taxAmount: number },
  items: Array<{ productName: string; quantity: number; unitPrice: number; totalPrice: number }>,
  userId: string,
): Promise<{ invoice: IssuedInvoice; created: boolean }> {
  const existing = await findLinkedInvoice(tx, doc);
  if (existing) return { invoice: existing, created: false };
  if (!doc.centerId) {
    throw new Error('سند بدون مشتری قابل صدور فاکتور حسابداری نیست.');
  }

  const account = await ensureCenterAccount(tx, doc.centerId);

  const invoice = await tx.issuedInvoice.create({
    data: {
      invoiceNumber: doc.documentNumber,
      salesDocumentId: doc.id,
      centerAccountId: account.id,
      status: 'issued',
      totalAmount: doc.finalAmount,
      paidAmount: 0,
      issuedAt: new Date(),
      createdById: userId,
      items: {
        create: items.map((item) => ({
          description: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
        })),
      },
    },
  });

  return { invoice, created: true };
}

// ════════════════════════════════════════════════════════════
//  Payment synchronization
// ════════════════════════════════════════════════════════════

export interface PaymentSyncInput {
  amount: number;
  paymentDate: Date;
  referenceNumber?: string | null;
  description?: string;
}

/**
 * Mirror a sales-document payment onto its DEFINITIVELY linked invoice:
 * bumps paidAmount/status and writes the IssuedInvoicePayment row.
 * No-op when the document has no linked (or voided) invoice.
 */
export async function syncPaymentToLinkedInvoice(
  tx: Tx,
  doc: Pick<SyncDoc, 'id' | 'documentType' | 'documentNumber'>,
  payment: PaymentSyncInput,
): Promise<IssuedInvoice | null> {
  const invoice = await findLinkedInvoice(tx, doc);
  if (!invoice || invoice.status === 'void') return null;

  const newPaid = invoice.paidAmount + payment.amount;
  const newStatus = newPaid >= invoice.totalAmount ? 'paid' : 'issued';

  await tx.issuedInvoicePayment.create({
    data: {
      issuedInvoiceId: invoice.id,
      amount: payment.amount,
      paymentDate: payment.paymentDate,
      referenceNumber: payment.referenceNumber ?? null,
      description: payment.description ?? '',
    },
  });

  return tx.issuedInvoice.update({
    where: { id: invoice.id },
    data: { paidAmount: newPaid, status: newStatus },
  });
}

/**
 * Rebuild the mirrored payment rows of a linked invoice from the document's
 * finance records (used after a payment is edited or deleted in the
 * accounting cartable, where records are not 1:1 addressable).
 */
export async function rebuildLinkedInvoicePayments(
  tx: Tx,
  doc: Pick<SyncDoc, 'id' | 'documentType' | 'documentNumber'>,
): Promise<IssuedInvoice | null> {
  const invoice = await findLinkedInvoice(tx, doc);
  if (!invoice) return null;

  const records = await tx.salesDocumentFinance.findMany({
    where: { salesDocumentId: doc.id },
    orderBy: { createdAt: 'asc' },
  });

  await tx.issuedInvoicePayment.deleteMany({
    where: { issuedInvoiceId: invoice.id },
  });
  if (records.length > 0) {
    await tx.issuedInvoicePayment.createMany({
      data: records.map((r) => ({
        issuedInvoiceId: invoice.id,
        amount: r.amount,
        paymentDate: r.paymentDate,
        referenceNumber: r.referenceNumber,
        description: r.description,
      })),
    });
  }

  const paid = records.reduce((s, r) => s + r.amount, 0);
  return tx.issuedInvoice.update({
    where: { id: invoice.id },
    data: {
      paidAmount: paid,
      status: invoice.status === 'void' ? 'void' : paid >= invoice.totalAmount ? 'paid' : 'issued',
    },
  });
}

// ════════════════════════════════════════════════════════════
//  Reversal (document cancellation)
// ════════════════════════════════════════════════════════════

/**
 * Reverse the loyalty points that were awarded for this document
 * (quick-sale awards points tagged with the document number). Idempotent —
 * a reversal row per document number is created exactly once.
 */
export async function reverseLoyaltyForDocument(
  tx: Tx,
  doc: Pick<SyncDoc, 'documentNumber'>,
  userId: string,
  userDisplayName: string,
): Promise<number> {
  if (!doc.documentNumber) return 0;

  const already = await tx.loyaltyTransaction.findFirst({
    where: { documentNumber: doc.documentNumber, reason: 'purchase_reversal' },
  });
  if (already) return 0;

  const awarded = await tx.loyaltyTransaction.findMany({
    where: { documentNumber: doc.documentNumber, reason: 'purchase', points: { gt: 0 } },
    select: { points: true, centerId: true },
  });
  if (awarded.length === 0) return 0;

  const total = awarded.reduce((s, t) => s + t.points, 0);
  // All purchase-award rows for one document share the same center.
  const centerId = awarded[0].centerId;

  await tx.loyaltyTransaction.create({
    data: {
      centerId,
      points: -total,
      reason: 'purchase_reversal',
      note: `برگشت امتیاز خرید به‌دلیل لغو سند ${doc.documentNumber}`,
      documentNumber: doc.documentNumber,
      createdById: userId,
      createdByName: userDisplayName,
    },
  });
  await tx.center.update({
    where: { id: centerId },
    data: { loyaltyPoints: { decrement: total } },
  });
  return total;
}

/**
 * Revert the accounting effects of an approved document that is being
 * cancelled: void its linked invoice (payments drop out of the account via
 * the void status) and reverse awarded loyalty points. Account totals are
 * NOT touched here — callers must run recalcCenterAccount afterwards.
 */
export async function revertDocumentEffects(
  tx: Tx,
  doc: Pick<SyncDoc, 'id' | 'documentType' | 'documentNumber'>,
  userId: string,
  userDisplayName: string,
): Promise<{ invoiceVoided: boolean; pointsReversed: number }> {
  const invoice = await findLinkedInvoice(tx, doc);
  let invoiceVoided = false;
  if (invoice && invoice.status !== 'void') {
    await tx.issuedInvoice.update({
      where: { id: invoice.id },
      data: { status: 'void' },
    });
    invoiceVoided = true;
  }
  const pointsReversed = await reverseLoyaltyForDocument(tx, doc, userId, userDisplayName);
  return { invoiceVoided, pointsReversed };
}
