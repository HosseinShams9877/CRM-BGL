import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { getAllowedCompanyIds, COMPANY_ACCESS_DENIED } from '@/lib/company-scope';
import { centerInTerritory, centerTerritoryWhere, resolveTerritoryScope } from '@/lib/territory-scope';
import { recalcCenterAccount, runInTransaction } from '@/lib/finance-sync';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import {
  registerInvoicePayment,
  validateInvoiceItems,
  settlementAmountFor,
  MAX_INVOICE_NUMBER_LEN,
  MAX_PAYMENT_TEXT,
} from '@/lib/invoice-payments';

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'list') return await handleList(body, user);
    if (action === 'get') return await handleGet(body, user);
    if (action === 'create') return await handleCreate(body, user);
    if (action === 'add-payment') return await handleAddPayment(body, user);
    if (action === 'payment-status') return await handlePaymentStatus(body, user);
    if (action === 'mark-paid') return await handleMarkPaid(body, user);
    if (action === 'void') return await handleVoid(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('billing', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST — issued invoices
// ════════════════════════════════════════════════════════
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.accounting_cartable && !perms.finance_write) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده فاکتورها را ندارید.' }, { status: 403 });
  }

  const {
    page = 1,
    pageSize = 20,
    status,
    centerAccountId,
  } = body as {
    page?: number;
    pageSize?: number;
    status?: string;
    centerAccountId?: string;
  };

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (centerAccountId) where.centerAccountId = centerAccountId;

  // v2.11.1: tenant isolation — non-admins only see invoices whose center
  // belongs to one of their companies. The finance_write permission is
  // granted to standard roles, so the permission gate alone previously
  // exposed every company's invoices to any authenticated user.
  // v2.36.0 — + sales territory: a scoped expert's invoice list covers only
  // their territory's customers (فاکتورهای حوزهٔ فروش).
  const allowed = await getAllowedCompanyIds(user);
  if (allowed !== null) {
    where.centerAccount = { center: { companyId: { in: allowed }, ...centerTerritoryWhere(resolveTerritoryScope(user)) } };
  } else {
    const t = centerTerritoryWhere(resolveTerritoryScope(user));
    if (t) where.centerAccount = { center: t };
  }

  // v2.58.1 (audit F4-هـ) — the accounting route now applies the SAME
  // document-ownership rule as the sales route: a standard expert (no
  // view_other_sales_documents) only sees invoices THEY created or that
  // mirror THEIR OWN sales document — company+territory scope alone used
  // to expose colleagues' invoices (and their payment registration) to
  // every finance_write user. Admin/finance keep the full view.
  if (!perms.view_other_sales_documents) {
    where.OR = [
      { createdById: user.id },
      { salesDocument: { createdById: user.id } },
    ];
  }

  // v2.58.0 (audit 85-a #6): page/pageSize clamped — NaN used to throw a
  // Prisma 500, huge pageSize dumped whole tables in one response.
  const p = Math.max(1, Math.min(Number.isFinite(Number(page)) ? Number(page) : 1, 500));
  const ps = Math.max(1, Math.min(Number.isFinite(Number(pageSize)) ? Number(pageSize) : 20, 100));
  const skip = (p - 1) * ps;
  const take = ps;

  const [items, total] = await Promise.all([
    db.issuedInvoice.findMany({
      where,
      skip,
      take,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        centerAccount: {
          // v2.43.0 — phone feeds the collections SMS reminder prefill
          include: { center: { select: { id: true, name: true, phone: true } } },
        },
        creator: { select: { id: true, displayName: true } },
        items: true,
        payments: true,
      },
    }),
    db.issuedInvoice.count({ where }),
  ]);

  return NextResponse.json({
    items,
    total,
    page: p,
    pageSize: take,
    totalPages: Math.ceil(total / take),
  });
}

// ════════════════════════════════════════════════════════
//  GET
// ════════════════════════════════════════════════════════
async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.accounting_cartable && !perms.finance_write) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده فاکتور را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه فاکتور الزامی است.' }, { status: 400 });
  }

  const invoice = await db.issuedInvoice.findUnique({
    where: { id },
    include: {
      centerAccount: {
        include: { center: { select: { id: true, name: true, phone: true, companyId: true, province: true } } },
      },
      creator: { select: { id: true, displayName: true } },
      items: { orderBy: { id: 'asc' } },
      payments: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!invoice) {
    return NextResponse.json({ error: 'فاکتور یافت نشد.' }, { status: 404 });
  }

  // v2.11.1: tenant isolation — 404 (not 403) to avoid leaking existence
  const allowed = await getAllowedCompanyIds(user);
  const invCompany = invoice.centerAccount?.center?.companyId;
  if (allowed !== null && (!invCompany || !allowed.includes(invCompany))) {
    return NextResponse.json({ error: 'فاکتور یافت نشد.' }, { status: 404 });
  }
  // v2.36.0: territory isolation — an out-of-territory invoice reads as
  // not found (same fail-closed rule).
  const invTerritory = resolveTerritoryScope(user);
  const invCenter = invoice.centerAccount?.center;
  if (invTerritory && (!invCenter || !centerInTerritory(invCenter, invTerritory))) {
    return NextResponse.json({ error: 'فاکتور یافت نشد.' }, { status: 404 });
  }

  // v2.58.1 (audit F4-هـ) — ownership (list parity): standard users may
  // only read invoices they created or that mirror their own document.
  const ownershipError = await checkInvoiceOwnership(invoice, user);
  if (ownershipError) return ownershipError;

  return NextResponse.json({ invoice });
}

// ════════════════════════════════════════════════════════
//  CREATE
// ════════════════════════════════════════════════════════
async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.finance_write) {
    return NextResponse.json({ error: 'شما دسترسی ایجاد فاکتور را ندارید.' }, { status: 403 });
  }

  const {
    invoiceNumber,
    centerAccountId,
    totalAmount,
    paidAmount,
    dueDate,
    issuedAt,
    items,
  } = body as {
    invoiceNumber?: string;
    centerAccountId?: string;
    totalAmount?: number;
    paidAmount?: number;
    dueDate?: string;
    issuedAt?: string;
    items?: { description: string; quantity: number; unitPrice: number; totalPrice: number }[];
  };

  // v2.58.1 (audit F3) — server-side validation & computation. The client's
  // totals are NEVER the source of truth: amounts are integer Rial
  // (money.ts invariant — the SAME rounding/currency policy as the sales
  // route's validators), every row is re-validated, and each row total is
  // recomputed server-side (client totalPrice is ignored). A negative
  // quantity, junk price, contradictory grand total or oversized payload
  // answers a clean Persian 400 instead of corrupting a financial document.
  const total = Number(totalAmount);
  if (!Number.isFinite(total) || !Number.isInteger(total) || total <= 0 || total > 1e12) {
    return NextResponse.json(
      { error: 'مبلغ فاکتور باید عددی صحیح (ریال)، مثبت و منطقی باشد.' },
      { status: 400 },
    );
  }

  const paidAmt = Number(paidAmount || 0);
  if (!Number.isFinite(paidAmt) || !Number.isInteger(paidAmt) || paidAmt < 0 || paidAmt > total) {
    return NextResponse.json(
      { error: 'مبلغ پرداخت‌شده باید عددی صحیح بین صفر و مبلغ کل فاکتور باشد.' },
      { status: 400 },
    );
  }

  // Rows: full validation + server-computed totals (client sum not trusted).
  const itemsResult = validateInvoiceItems(items);
  if (!itemsResult.ok) {
    return NextResponse.json({ error: itemsResult.error }, { status: 400 });
  }
  // Grand-total consistency: this endpoint carries no discount/tax fields,
  // so a mismatched sum is contradictory input (documents that need real
  // discount/tax math belong to the sales-document proforma flow).
  if (itemsResult.rows.length > 0 && itemsResult.itemsTotal !== total) {
    return NextResponse.json(
      {
        error: `مبلغ کل فاکتور (${total.toLocaleString('fa-IR')} ریال) با جمع اقلام (${itemsResult.itemsTotal.toLocaleString('fa-IR')} ریال) برابر نیست. مبلغ یا اقلام را اصلاح کنید.`,
      },
      { status: 400 },
    );
  }

  // Bounded strings + parseable dates.
  const invoiceNo =
    typeof invoiceNumber === 'string' ? invoiceNumber.trim().slice(0, MAX_INVOICE_NUMBER_LEN) || null : null;
  const issuedAtDate = issuedAt ? new Date(issuedAt) : new Date();
  const dueDateDate: Date | null = dueDate ? new Date(dueDate) : null;
  if (issuedAt && isNaN(issuedAtDate.getTime())) {
    return NextResponse.json({ error: 'تاریخ صدور نامعتبر است.' }, { status: 400 });
  }
  if (dueDateDate && isNaN(dueDateDate.getTime())) {
    return NextResponse.json({ error: 'تاریخ سررسید نامعتبر است.' }, { status: 400 });
  }

  // v2.11.1: tenant isolation — non-admins must attach the invoice to an
  // account whose center belongs to one of their companies.
  // v2.36.0: …and that center must sit inside the expert's territory.
  const allowed = await getAllowedCompanyIds(user);
  const createTerritory = resolveTerritoryScope(user);
  if (allowed !== null || createTerritory) {
    if (!centerAccountId) {
      return NextResponse.json(
        { error: 'انتخاب حساب مشتری (مرکز) برای صدور فاکتور الزامی است.' },
        { status: 403 },
      );
    }
    const account = await db.centerAccount.findUnique({
      where: { id: centerAccountId },
      select: { center: { select: { id: true, companyId: true, province: true } } },
    });
    if (!account || (allowed !== null && !allowed.includes(account.center.companyId))) {
      return NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 });
    }
    if (!centerInTerritory(account.center, createTerritory)) {
      return NextResponse.json(
        { error: 'مرکز موردنظر در محدودهٔ فروش شما نیست.' },
        { status: 403 },
      );
    }
  }

  // v2.58.0 (audit 85-c CRITICAL): the whole write lands in ONE transaction.
  // v2.58.1 (audit F1/F2): the optional accompanying payment is registered
  // through the SHARED service (registerInvoicePayment, source='issue')
  // inside the SAME transaction — receipt row + paidAmount + mirrored
  // document finance + account totals stay in sync by construction, with
  // the in-transaction balance check active.
  const invoice = await runInTransaction(async (tx) => {
    let created;
    try {
      created = await tx.issuedInvoice.create({
        data: {
          invoiceNumber: invoiceNo,
          centerAccountId: centerAccountId || null,
          totalAmount: total,
          paidAmount: 0,
          issuedAt: issuedAtDate,
          dueDate: dueDateDate,
          status: 'issued',
          createdById: user.id,
          items:
            itemsResult.rows.length > 0
              ? {
                  create: itemsResult.rows.map((row) => ({
                    description: row.description,
                    quantity: row.quantity,
                    unitPrice: row.unitPrice,
                    totalPrice: row.totalPrice,
                  })),
                }
              : undefined,
        },
      });
    } catch (e) {
      // P2002 = duplicate invoiceNumber (v2.58.0 unique key) — a clean 400,
      // never a raw 500.
      if ((e as { code?: string }).code === 'P2002') {
        throw new (await import('@/lib/api-error')).ApiError(
          400,
          `شماره فاکتور «${invoiceNo}» قبلاً استفاده شده است.`,
        );
      }
      throw e;
    }

    if (paidAmt > 0) {
      await registerInvoicePayment(
        {
          invoiceId: created.id,
          amount: paidAmt,
          userId: user.id,
          description: 'پرداخت همراه صدور فاکتور',
          paymentDate: issuedAtDate,
          source: 'issue',
        },
        tx,
      );
    } else if (created.centerAccountId) {
      // No payment — but the new invoice must still be reflected in the
      // center's totals immediately (the payment path gets the same via
      // recalcCenterAccount inside the service).
      const account = await tx.centerAccount.findUnique({
        where: { id: created.centerAccountId },
        select: { centerId: true },
      });
      if (account) {
        await recalcCenterAccount(tx, account.centerId);
      }
    }

    return tx.issuedInvoice.findUnique({
      where: { id: created.id },
      include: {
        centerAccount: {
          include: { center: { select: { id: true, name: true } } },
        },
        items: true,
        payments: true,
      },
    });
  });

  return NextResponse.json({ message: 'فاکتور با موفقیت ایجاد شد.', invoice }, { status: 201 });
}

// ════════════════════════════════════════════════════════
//  ADD PAYMENT
// ════════════════════════════════════════════════════════
async function handleAddPayment(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.finance_write) {
    return NextResponse.json({ error: 'شما دسترسی ثبت پرداخت را ندارید.' }, { status: 403 });
  }

  const { id, amount, referenceNumber, description, idempotencyKey } = body as {
    id?: string;
    amount?: number;
    referenceNumber?: string;
    description?: string;
    idempotencyKey?: string;
  };

  if (!id) {
    return NextResponse.json({ error: 'شناسه فاکتور الزامی است.' }, { status: 400 });
  }

  // v2.13.0 — strict amount validation (integer Rial since v2.58.1: the
  // money.ts invariant — no fractional Rial can enter the ledger here,
  // matching the sales route's policy).
  const amt = Number(amount);
  if (!Number.isFinite(amt) || !Number.isInteger(amt) || amt <= 0) {
    return NextResponse.json(
      { error: 'مبلغ پرداخت باید عددی صحیح و بزرگ‌تر از صفر باشد.' },
      { status: 400 },
    );
  }
  if (amt > 1e12) {
    return NextResponse.json({ error: 'مبلغ پرداخت غیرمنطقی است.' }, { status: 400 });
  }

  const invoice = await db.issuedInvoice.findUnique({
    where: { id },
    include: { centerAccount: { include: { center: { select: { id: true, companyId: true, province: true } } } } },
  });
  if (!invoice) {
    return NextResponse.json({ error: 'فاکتور یافت نشد.' }, { status: 404 });
  }

  // v2.11.1: tenant isolation gate for payment registration
  const scopeError = await checkInvoiceCompanyAccess(invoice, user);
  if (scopeError) return scopeError;

  // v2.58.1 (audit F4-هـ) — ownership gate (sales-route parity): a
  // standard user registers payments ONLY on their own invoices.
  const payOwnershipError = await checkInvoiceOwnership(invoice, user);
  if (payOwnershipError) return payOwnershipError;

  // v2.13.0 + v2.58.1 — advisory business checks (void / overpayment /
  // linked-doc status) run ONLY for keyless requests: with an idempotency
  // key, a REPLAY must reach the service's idempotency-first branch and
  // answer with the stored result — the payment already happened, and
  // re-evaluating today's business state would wrongly 400 it. New-key
  // requests get identical outcomes from the authoritative in-tx checks.
  const idemKey =
    typeof idempotencyKey === 'string' && idempotencyKey.trim()
      ? idempotencyKey.trim().slice(0, 128)
      : null;
  if (!idemKey) {
    if (invoice.status === 'void') {
      return NextResponse.json({ error: 'امکان ثبت پرداخت بر روی فاکتور ابطال‌شده وجود ندارد.' }, { status: 400 });
    }
    if (invoice.paidAmount + amt > invoice.totalAmount) {
      return NextResponse.json(
        {
          error: `مبلغ پرداخت (${amt.toLocaleString('fa-IR')} ریال) از مانده فاکتور (${(invoice.totalAmount - invoice.paidAmount).toLocaleString('fa-IR')} ریال) بیشتر است.`,
        },
        { status: 400 },
      );
    }

    // v2.13.0 — invoices linked to a sales document mirror their payments
    // back onto the document's finance records so the sales and accounting
    // tracks can never diverge. (Re-checked inside the transaction too.)
    const linkedDoc = invoice.salesDocumentId
      ? await db.salesDocument.findUnique({
          where: { id: invoice.salesDocumentId },
          select: { id: true, status: true },
        })
      : null;
    if (linkedDoc && linkedDoc.status !== 'approved') {
      return NextResponse.json(
        { error: 'سند فروش متناظر این فاکتور تأییدشده نیست؛ ثبت پرداخت ممکن نیست.' },
        { status: 400 },
      );
    }
  }

  // v2.58.1 (audit F2) — the shared payment service:
  //  • re-reads the invoice INSIDE the write transaction and enforces the
  //    balance there (concurrent 60+60 on 100 → exactly one committed);
  //  • writes receipt + paidAmount/status + mirrored finance record +
  //    recalcCenterAccount in ONE rollback-able transaction;
  //  • enforces the optional idempotency key via the DB UNIQUE constraint
  //    (userId, idemKey): same key + same payload → same stored result
  //    (one receipt, ever); same key + different payload → 409.
  const result = await registerInvoicePayment({
    invoiceId: id,
    amount: amt,
    userId: user.id,
    referenceNumber: typeof referenceNumber === 'string' ? referenceNumber : null,
    description: typeof description === 'string' ? description : undefined,
    idempotencyKey: idemKey,
    source: 'manual',
    allowedCompanyIds: await getAllowedCompanyIds(user) ?? undefined,
  });

  return NextResponse.json({
    message: result.message,
    payment: result.payment,
    invoiceId: result.invoiceId,
    newStatus: result.newStatus,
    newPaidAmount: result.newPaidAmount,
    replayed: result.replayed,
    // v2.58.10 (carried workstream 3): the honest "nothing was booked"
    // flag joins the response so the client idempotency engine can
    // resolve a settled-invoice answer as a definitive outcome instead
    // of an endless unknown loop (the settle path already exposed it).
    alreadySettled: result.alreadySettled,
  });
}

// ════════════════════════════════════════════════════════
//  PAYMENT STATUS — the تعیین تکلیف path (v2.58.6, user P1)
// ════════════════════════════════════════════════════════
// The client asks what became of a pending payment whose outcome was
// UNKNOWN (a 502/504 from an intermediary, a network cut, a refresh).
// The idempotency row and the receipt land in ONE transaction inside
// registerInvoicePayment, so:
//   • a row under (CURRENT user, key) ⇒ the payment WAS booked — its
//     stored summary is disclosed, but ONLY after the caller's CURRENT
//     company scope and invoice ownership are re-verified (the same
//     guards add-payment applies — a revoked scope learns nothing);
//   • no row ⇒ positive proof nothing was booked under this key.
// The key namespace is per-user: another account's identical query is
// answered 'not-recorded' and discloses nothing.
async function handlePaymentStatus(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.finance_write) {
    return NextResponse.json({ error: 'شما دسترسی ثبت پرداخت را ندارید.' }, { status: 403 });
  }

  const { id, idempotencyKey } = body as { id?: string; idempotencyKey?: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه فاکتور الزامی است.' }, { status: 400 });
  }
  const key = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim().slice(0, 128) : '';
  if (!key) {
    return NextResponse.json({ error: 'کلید یکتایی پرداخت الزامی است.' }, { status: 400 });
  }

  const row = await db.issuedInvoicePaymentIdempotency.findUnique({
    where: { userId_idemKey: { userId: user.id, idemKey: key } },
  });
  if (!row) {
    // the per-user namespace is empty for this key — nothing was booked
    // by THIS user under it (also the honest answer for another user's
    // key: no disclosure of their operation)
    return NextResponse.json({ status: 'not-recorded' });
  }

  // CURRENT-scope guards before ANY disclosure (R1 replay parity):
  const invoice = await db.issuedInvoice.findUnique({
    where: { id: row.invoiceId },
    include: { centerAccount: { include: { center: { select: { id: true, companyId: true, province: true } } } } },
  });
  if (!invoice) {
    return NextResponse.json({ status: 'not-recorded' });
  }
  const scopeError = await checkInvoiceCompanyAccess(invoice, user);
  if (scopeError) return scopeError;
  const ownershipError = await checkInvoiceOwnership(invoice, user);
  if (ownershipError) return ownershipError;

  try {
    const stored = JSON.parse(row.resultJson) as {
      payment?: { id?: string; amount?: number } | null;
      newPaidAmount?: number;
      newStatus?: string;
      message?: string;
    };
    return NextResponse.json({
      status: 'recorded',
      payment: { id: stored.payment?.id ?? null, amount: stored.payment?.amount ?? null },
      newPaidAmount: stored.newPaidAmount ?? null,
      newStatus: stored.newStatus ?? null,
      message: stored.message ?? '',
      replayed: true,
    });
  } catch {
    return NextResponse.json(
      { error: 'کلید یکتایی این پرداخت قبلاً استفاده شده است؛ نتیجهٔ ذخیره‌شده قابل خواندن نیست.' },
      { status: 409 },
    );
  }
}

// ════════════════════════════════════════════════════════
//  MARK PAID — «ثبت دریافت مانده و تسویه»
// ════════════════════════════════════════════════════════
async function handleMarkPaid(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.finance_write) {
    return NextResponse.json({ error: 'شما دسترسی تغییر وضعیت فاکتور را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه فاکتور الزامی است.' }, { status: 400 });
  }

  const invoice = await db.issuedInvoice.findUnique({
    where: { id },
    include: { centerAccount: { include: { center: { select: { id: true, companyId: true, province: true } } } } },
  });
  if (!invoice) {
    return NextResponse.json({ error: 'فاکتور یافت نشد.' }, { status: 404 });
  }

  // v2.11.1: tenant isolation gate before settling
  const scopeError = await checkInvoiceCompanyAccess(invoice, user);
  if (scopeError) return scopeError;

  // v2.58.1 (audit F4-هـ) — ownership gate: a standard user settles ONLY
  // their own invoices (same matrix as add-payment).
  const settleOwnershipError = await checkInvoiceOwnership(invoice, user);
  if (settleOwnershipError) return settleOwnershipError;

  if (invoice.status === 'void') {
    return NextResponse.json({ error: 'امکان تسویه فاکتور ابطال‌شده وجود ندارد.' }, { status: 400 });
  }

  // v2.58.1 (audit F1 — CRITICAL): «تسویه» is no longer a bare
  // status='paid' + paidAmount=totalAmount flip. The old handler left NO
  // IssuedInvoicePayment receipt, NO mirrored sales-document finance
  // record and NO recalcCenterAccount — the center's collected total and
  // the collections report silently diverged from the ledger. Settlement
  // now registers a REAL receipt for the REAL remaining balance through
  // the shared payment service, in one transaction, with:
  //  • in-tx re-read → the amount is recomputed from live state;
  //  • an already-settled invoice answers a NO-OP (never a second receipt
  //    on a re-call — idempotent by construction);
  //  • a voided invoice can never accept a payment (checked in-tx too).
  const remaining = settlementAmountFor(invoice);
  if (remaining <= 0) {
    const current = await db.issuedInvoice.findUnique({
      where: { id },
      include: {
        centerAccount: { include: { center: { select: { id: true, name: true } } } },
        items: true,
        payments: true,
      },
    });
    return NextResponse.json({
      message: 'این فاکتور قبلاً تسویه شده است؛ رسید جدیدی ثبت نشد.',
      invoice: current,
      alreadySettled: true,
    });
  }

  const result = await registerInvoicePayment({
    invoiceId: id,
    amount: remaining,
    userId: user.id,
    description: 'دریافت مانده و تسویه فاکتور',
    source: 'settlement',
    allowedCompanyIds: await getAllowedCompanyIds(user) ?? undefined,
  });

  const updated = await db.issuedInvoice.findUnique({
    where: { id },
    include: {
      centerAccount: { include: { center: { select: { id: true, name: true } } } },
      items: true,
      payments: true,
    },
  });

  return NextResponse.json({
    message: result.alreadySettled
      ? result.message
      : `دریافت مانده (${remaining.toLocaleString('fa-IR')} ریال) ثبت شد و فاکتور تسویه شد.`,
    invoice: updated,
    payment: result.payment,
    newStatus: result.newStatus,
    newPaidAmount: result.newPaidAmount,
    replayed: result.replayed,
    alreadySettled: result.alreadySettled,
  });
}

// ════════════════════════════════════════════════════════
//  VOID
// ════════════════════════════════════════════════════════
async function handleVoid(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.void_financial) {
    return NextResponse.json({ error: 'شما دسترسی ابطال فاکتور را ندارید.' }, { status: 403 });
  }

  const { id, reason } = body as { id: string; reason?: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه فاکتور الزامی است.' }, { status: 400 });
  }

  const invoice = await db.issuedInvoice.findUnique({
    where: { id },
    include: { centerAccount: { include: { center: { select: { id: true, companyId: true, province: true } } } } },
  });
  if (!invoice) {
    return NextResponse.json({ error: 'فاکتور یافت نشد.' }, { status: 404 });
  }

  // v2.11.1: tenant isolation gate before voiding (defense in depth —
  // void_financial is admin-only, so this is a no-op for admins)
  const scopeError = await checkInvoiceCompanyAccess(invoice, user);
  if (scopeError) return scopeError;

  if (invoice.status === 'void') {
    return NextResponse.json({ error: 'این فاکتور قبلاً ابطال شده است.' }, { status: 400 });
  }

  // v2.13.0 — void inside a transaction and recompute the center account:
  // a voided invoice's payments no longer count towards totalPaid.
  const updated = await runInTransaction(async (tx) => {
    const row = await tx.issuedInvoice.update({
      where: { id },
      data: { status: 'void' },
      include: {
        centerAccount: {
          include: { center: { select: { id: true, name: true } } },
        },
        items: true,
        payments: true,
      },
    });
    const centerId = row.centerAccount?.centerId;
    if (centerId) {
      await recalcCenterAccount(tx, centerId);
    }
    return row;
  });

  // Log audit event
  await db.auditEvent.create({
    data: {
      eventType: 'invoice_void',
      category: 'billing',
      subject: `ابطال فاکتور ${invoice.invoiceNumber || id}`,
      details: (typeof reason === 'string' ? reason : '').slice(0, MAX_PAYMENT_TEXT),
      userId: user.id,
    },
  });

  return NextResponse.json({ message: 'فاکتور با موفقیت ابطال شد.', invoice: updated });
}

// ════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════

/**
 * v2.11.1 tenant gate: verify the invoice's center belongs to one of the
 * user's companies. Returns a 403 response, or null when access is OK.
 * Invoices without a center account are not attributable to any company,
 * so they stay admin-only.
 */
async function checkInvoiceCompanyAccess(
  invoice: { centerAccount: { center: { id: string; companyId: string; province: string | null } } | null },
  user: AuthUser,
): Promise<NextResponse | null> {
  const allowed = await getAllowedCompanyIds(user);
  if (allowed === null) {
    // v2.36.0 — admins skip the company gate; they never carry a
    // restricted territory (resolveTerritoryScope nulls non-standard roles).
    const adminCenter = invoice.centerAccount?.center;
    const adminTerritory = resolveTerritoryScope(user);
    if (adminTerritory && (!adminCenter || !centerInTerritory(adminCenter, adminTerritory))) {
      return NextResponse.json({ error: 'فاکتور یافت نشد.' }, { status: 404 });
    }
    return null;
  }
  const companyId = invoice.centerAccount?.center?.companyId;
  if (!companyId || !allowed.includes(companyId)) {
    return NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 });
  }
  // v2.36.0 — territory gate: payment/void/update on an out-of-territory
  // invoice is refused (404-style, no existence leak).
  const t = resolveTerritoryScope(user);
  const center = invoice.centerAccount?.center;
  if (t && (!center || !centerInTerritory(center, t))) {
    return NextResponse.json({ error: 'فاکتور یافت نشد.' }, { status: 404 });
  }
  return null;
}

/**
 * v2.58.1 (audit F4-هـ) — ownership gate (sales-route parity) for the
 * accounting route: a standard user (no view_other_sales_documents) may
 * only reach invoices THEY created, or invoices that mirror THEIR OWN
 * sales document (issueInvoiceForDocument stamps createdById with the
 * approver, so doc-owned invoices follow the document creator). 404 —
 * no existence leak. Admin/finance (view_other) pass unchanged.
 */
async function checkInvoiceOwnership(
  invoice: { id: string; createdById: string | null; salesDocumentId: string | null },
  user: AuthUser,
): Promise<NextResponse | null> {
  const perms = getRolePermissions(user.role);
  if (perms.view_other_sales_documents) return null;
  if (invoice.createdById === user.id) return null;
  if (invoice.salesDocumentId) {
    const doc = await db.salesDocument.findUnique({
      where: { id: invoice.salesDocumentId },
      select: { createdById: true },
    });
    if (doc?.createdById === user.id) return null;
  }
  return NextResponse.json({ error: 'فاکتور یافت نشد.' }, { status: 404 });
}
