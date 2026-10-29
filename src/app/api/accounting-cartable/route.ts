import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, type AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { ApiError } from '@/lib/api-error';
import { getAllowedCompanyIds } from '@/lib/company-scope';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import {
  addCartablePayment,
  updateCartablePayment,
  deleteCartablePayment,
  parseAddPaymentBody,
  parseUpdatePaymentBody,
} from '@/lib/cartable-payments';

// ════════════════════════════════════════════════════════
//  POST — action router
// ════════════════════════════════════════════════════════
export async function POST(req: NextRequest) {
  try {
    // ── Auth (central — includes sliding 12h session expiry) ──
    const user = await getCurrentUser();
    if (!user)
      return NextResponse.json({ error: 'احراز هویت نشده' }, { status: 401 });

    // ── Route ─────────────────────────────────────────
    const body = await req.json();
    const { action } = body;

    if (action === 'list') return await handleList(body, user);
    if (action === 'add-payment') return await handleAddPayment(body, user);
    if (action === 'update-payment') return await handleUpdatePayment(body, user);
    if (action === 'delete-payment') return await handleDeletePayment(body, user);
    if (action === 'summary') return await handleSummary(body, user);
    if (action === 'overdue') return await handleOverdue(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('accounting-cartable', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST — approved docs or docs with finance records
// ════════════════════════════════════════════════════════
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.accounting_cartable) {
    return NextResponse.json({ error: 'شما دسترسی کارتابل حسابداری را ندارید.' }, { status: 403 });
  }
  const {
    page = 1,
    pageSize = 20,
    status,
    search,
    centerId,
    documentType,
  } = body as {
    page?: number;
    pageSize?: number;
    status?: string;
    search?: string;
    centerId?: string;
    documentType?: string;
  };

  // v2.11.1: tenant isolation — non-admins only see documents whose center
  // belongs to one of their assigned companies. Previously the list exposed
  // every company's invoices to anyone passing the permission gate.
  const allowed = await getAllowedCompanyIds(user);

  const where: Record<string, unknown> = {
    OR: [
      { status: 'approved' },
      { financeRecords: { some: {} } },
    ],
  };

  if (allowed !== null) {
    where.center = { companyId: { in: allowed } };
  }

  if (status) {
    (where as Record<string, unknown>).status = status;
  }

  if (centerId) {
    (where as Record<string, unknown>).centerId = centerId;
  }

  if (documentType) {
    (where as Record<string, unknown>).documentType = documentType;
  }

  if (search) {
    (where as Record<string, unknown>).documentNumber = {
      contains: search,
      mode: 'insensitive',
    };
  }

  // v2.58.0 (audit 85-a #6): page/pageSize clamped — NaN used to throw a
  // Prisma 500, huge pageSize dumped whole tables in one response.
  const p = Math.max(1, Math.min(Number.isFinite(Number(page)) ? Number(page) : 1, 500));
  const ps = Math.max(1, Math.min(Number.isFinite(Number(pageSize)) ? Number(pageSize) : 20, 100));
  const skip = (p - 1) * ps;
  const take = ps;

  const [items, total] = await Promise.all([
    db.salesDocument.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        center: {
          select: { id: true, name: true },
        },
        creator: {
          select: { id: true, displayName: true },
        },
        financeRecords: {
          orderBy: { paymentDate: 'desc' },
        },
      },
    }),
    db.salesDocument.count({ where }),
  ]);

  // Compute paid amount per document
  const enriched = items.map((doc) => {
    const totalPaid = doc.financeRecords.reduce((sum, r) => sum + r.amount, 0);
    const remaining = doc.finalAmount - totalPaid;
    return {
      ...doc,
      // expose under the historical `createdBy` key as well so existing UI
      // consumers don't break — schema relation is `creator`.
      createdBy: doc.creator,
      _totalPaid: totalPaid,
      _remaining: remaining,
      _isFullyPaid: totalPaid >= doc.finalAmount,
      _paymentCount: doc.financeRecords.length,
    };
  });

  return NextResponse.json({
    items: enriched,
    total,
    page: p,
    pageSize: take,
    totalPages: Math.ceil(total / take),
  });
}

// ════════════════════════════════════════════════════════
//  ADD PAYMENT — thin adapter over lib/cartable-payments.ts
//  (v2.58.3, finding 3): the document row, company-access check,
//  effective status, finalAmount and the live paid-sum are ALL read
//  inside the ONE write transaction — the guard is authoritative.
// ════════════════════════════════════════════════════════
async function handleAddPayment(
  body: Record<string, unknown>,
  user: AuthUser,
) {
  const perms = getRolePermissions(user.role);
  if (!perms.accounting_cartable && !perms.finance_write) {
    return NextResponse.json({ error: 'شما دسترسی ثبت پرداخت را ندارید.' }, { status: 403 });
  }
  try {
    const input = parseAddPaymentBody(body);
    // v2.58.4 (external audit F04): the client idempotency key rides the
    // shared service — same key + same payload replays the stored result
    // (one receipt, ever); same key + different payload → 409.
    const idemKey =
      typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim().slice(0, 128)
        : null;
    const payment = await addCartablePayment(user, input, idemKey);
    return NextResponse.json({ message: 'پرداخت با موفقیت ثبت شد.', payment });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

// ════════════════════════════════════════════════════════
//  UPDATE PAYMENT — thin adapter over lib/cartable-payments.ts
//  (v2.58.3, finding 3 — the race fix). The target payment, the parent
//  document (company + status + finalAmount) and the sum of the OTHER
//  payments are ALL re-read inside the ONE write transaction; the edit,
//  the linked-invoice rebuild and the account recalc commit atomically.
//  The pre-transaction snapshot race (100 = 40+40, both edits to 60 →
//  120 committed) is structurally impossible now.
// ════════════════════════════════════════════════════════
async function handleUpdatePayment(
  body: Record<string, unknown>,
  user: AuthUser,
) {
  const perms = getRolePermissions(user.role);
  if (!perms.accounting_cartable && !perms.finance_write) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش پرداخت را ندارید.' }, { status: 403 });
  }
  try {
    const input = parseUpdatePaymentBody(body);
    const payment = await updateCartablePayment(user, input);
    return NextResponse.json({ message: 'رکورد پرداخت با موفقیت بروزرسانی شد.', payment });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

// ════════════════════════════════════════════════════════
//  DELETE PAYMENT — thin adapter (v2.58.3): guarded read + delete +
//  rebuild + recalc share ONE transaction.
// ════════════════════════════════════════════════════════
async function handleDeletePayment(
  body: Record<string, unknown>,
  user: AuthUser,
) {
  const perms = getRolePermissions(user.role);
  if (!perms.accounting_cartable && !perms.finance_write) {
    return NextResponse.json({ error: 'شما دسترسی حذف پرداخت را ندارید.' }, { status: 403 });
  }
  const { paymentId } = body as { paymentId?: string };
  try {
    await deleteCartablePayment(user, paymentId || '');
    return NextResponse.json({ message: 'رکورد پرداخت با موفقیت حذف شد.' });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

// ════════════════════════════════════════════════════════
//  SUMMARY — financial overview
// ════════════════════════════════════════════════════════
async function handleSummary(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.accounting_cartable) {
    return NextResponse.json({ error: 'شما دسترسی کارتابل حسابداری را ندارید.' }, { status: 403 });
  }
  const { centerId } = body as { centerId?: string };

  // v2.11.1: tenant isolation for the financial overview
  const allowed = await getAllowedCompanyIds(user);

  const whereSales: Record<string, unknown> = { status: 'approved' };
  if (centerId) {
    (whereSales as Record<string, unknown>).centerId = centerId;
  }
  if (allowed !== null) {
    whereSales.center = { companyId: { in: allowed } };
  }

  const whereFinance: Record<string, unknown> = {
    salesDocument: { status: 'approved' },
  };
  if (centerId) {
    (whereFinance as Record<string, unknown>).salesDocument = {
      status: 'approved',
      centerId,
    };
  }
  if (allowed !== null) {
    const docFilter = (whereFinance as Record<string, unknown>).salesDocument as Record<string, unknown>;
    docFilter.center = { companyId: { in: allowed } };
  }

  const [totalSalesResult, totalCollectedResult, documentCount] = await Promise.all([
    db.salesDocument.aggregate({
      _sum: { finalAmount: true },
      where: whereSales,
    }),
    db.salesDocumentFinance.aggregate({
      _sum: { amount: true },
      where: whereFinance,
    }),
    db.salesDocument.count({ where: whereSales }),
  ]);

  const totalSales = totalSalesResult._sum.finalAmount || 0;
  const totalCollected = totalCollectedResult._sum.amount || 0;
  const totalOutstanding = totalSales - totalCollected;

  return NextResponse.json({
    totalSales,
    totalCollected,
    totalOutstanding,
    documentCount,
    collectionRate: totalSales > 0 ? Math.round((totalCollected / totalSales) * 100) : 0,
  });
}

// ════════════════════════════════════════════════════════
//  OVERDUE — approved docs with no/partial payments
// ════════════════════════════════════════════════════════
async function handleOverdue(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.accounting_cartable) {
    return NextResponse.json({ error: 'شما دسترسی کارتابل حسابداری را ندارید.' }, { status: 403 });
  }
  const { centerId, page = 1, pageSize = 20 } = body as {
    centerId?: string;
    page?: number;
    pageSize?: number;
  };

  const where: Record<string, unknown> = { status: 'approved' };
  if (centerId) {
    (where as Record<string, unknown>).centerId = centerId;
  }

  // v2.11.1: tenant isolation for the overdue list
  const allowed = await getAllowedCompanyIds(user);
  if (allowed !== null) {
    where.center = { companyId: { in: allowed } };
  }

  // v2.58.0 (audit 85-c): this handler used to findMany EVERY approved
  // document WITH its full financeRecords include and then filter+paginate
  // in JS — `skip`/`take` were computed but never passed to the query. The
  // paid-sum filter still has to run over all approved docs (Prisma cannot
  // express "SUM(relation) < column" in a where), but the per-row include
  // payload is gone: ONE groupBy computes every document's paid total, and
  // page/pageSize are clamped so NaN can no longer 500 the route.
  const p = Math.max(1, Math.min(Number.isFinite(Number(page)) ? Number(page) : 1, 500));
  const ps = Math.max(1, Math.min(Number.isFinite(Number(pageSize)) ? Number(pageSize) : 20, 100));

  const [allDocs, paidByDoc] = await Promise.all([
    db.salesDocument.findMany({
      where,
      orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
      include: {
        center: { select: { id: true, name: true } },
        creator: { select: { id: true, displayName: true } },
        _count: { select: { financeRecords: true } },
      },
    }),
    db.salesDocumentFinance.groupBy({
      by: ['salesDocumentId'],
      _sum: { amount: true },
      where: { salesDocument: where },
    }),
  ]);

  const paidMap = new Map(paidByDoc.map((r) => [r.salesDocumentId, r._sum.amount || 0]));

  // Filter to only documents that are not fully paid
  const overdue = allDocs.filter((doc) => (paidMap.get(doc.id) ?? 0) < doc.finalAmount);

  // Paginate the filtered results
  const paginated = overdue.slice((p - 1) * ps, (p - 1) * ps + ps);
  const enriched = paginated.map((doc) => {
    const totalPaid = paidMap.get(doc.id) ?? 0;
    return {
      ...doc,
      // expose under the historical `createdBy` key as well so existing UI
      // consumers don't break — schema relation is `creator`.
      createdBy: doc.creator,
      _totalPaid: totalPaid,
      _remaining: doc.finalAmount - totalPaid,
      _paymentCount: doc._count.financeRecords,
      _daysSinceIssue: doc.issuedAt
        ? Math.floor((Date.now() - doc.issuedAt.getTime()) / (1000 * 60 * 60 * 24))
        : null,
    };
  });

  return NextResponse.json({
    items: enriched,
    total: overdue.length,
    page: p,
    pageSize: ps,
    totalPages: Math.ceil(overdue.length / ps),
  });
}

// ════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════

// (v2.58.3) checkDocCompanyAccess moved INTO lib/cartable-payments.ts
// (loadDocInTxGuarded) — the company gate now runs on the LIVE in-tx row
// of every payment mutation instead of a pre-transaction snapshot.

// (v2.13.0) the local recalcCenterAccount moved to lib/finance-sync.ts as the
// authoritative implementation shared by every financial mutation path. It
// now also subtracts approved return documents and counts invoice payments.
