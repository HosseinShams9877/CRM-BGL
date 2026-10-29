import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { optionalCompanyWhere, getAllowedCompanyIds } from '@/lib/company-scope';
import { apiErrorMessage, apiErrorStatus, ApiError } from '@/lib/api-error';

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
    if (action === 'update-status') return await handleUpdateStatus(body, user);
    if (action === 'list-inbox') return await handleListInbox(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('production', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST — purchase requests
// ════════════════════════════════════════════════════════
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده درخواست‌های خرید را ندارید.' }, { status: 403 });
  }

  const {
    page = 1,
    pageSize = 20,
    status,
  } = body as {
    page?: number;
    pageSize?: number;
    status?: string;
  };

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  // v2.25.0 — company tenant isolation: purchase requests stay a SHARED
  // internal queue by design (companyId null = visible to everyone); if a
  // request is ever stamped with a company, only that company's users
  // (and admins) see it.
  const listCompanyScope = optionalCompanyWhere(await getAllowedCompanyIds(user));
  if (listCompanyScope) Object.assign(where, listCompanyScope);

  // v2.58.0 (audit 85-a #6): page/pageSize clamped — NaN used to throw a
  // Prisma 500, huge pageSize dumped whole tables in one response.
  const p = Math.max(1, Math.min(Number.isFinite(Number(page)) ? Number(page) : 1, 500));
  const ps = Math.max(1, Math.min(Number.isFinite(Number(pageSize)) ? Number(pageSize) : 20, 100));
  const skip = (p - 1) * ps;
  const take = ps;

  const [items, total] = await Promise.all([
    db.productionPurchaseRequest.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    db.productionPurchaseRequest.count({ where }),
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
  if (!perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده درخواست خرید را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه درخواست الزامی است.' }, { status: 400 });
  }

  // v2.25.0 — same optional-company predicate as the list action.
  const getCompanyScope = optionalCompanyWhere(await getAllowedCompanyIds(user));
  const item = await db.productionPurchaseRequest.findFirst({
    where: { id, ...(getCompanyScope ?? {}) },
  });

  if (!item) {
    return NextResponse.json({ error: 'درخواست یافت نشد.' }, { status: 404 });
  }

  return NextResponse.json({ item });
}

// ════════════════════════════════════════════════════════
//  CREATE
// ════════════════════════════════════════════════════════
async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی ایجاد درخواست خرید را ندارید.' }, { status: 403 });
  }

  const { title, description } = body as {
    title?: string;
    description?: string;
  };

  if (!title) {
    return NextResponse.json({ error: 'عنوان درخواست الزامی است.' }, { status: 400 });
  }

  const item = await db.productionPurchaseRequest.create({
    data: {
      title,
      description: description || '',
      status: 'pending',
      requestedBy: user.id,
    },
  });

  return NextResponse.json({ message: 'درخواست خرید با موفقیت ایجاد شد.', item }, { status: 201 });
}

// ════════════════════════════════════════════════════════
//  UPDATE STATUS
// ════════════════════════════════════════════════════════
async function handleUpdateStatus(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی تغییر وضعیت درخواست را ندارید.' }, { status: 403 });
  }

  const { id, status } = body as {
    id?: string;
    status?: string;
  };

  if (!id || !status) {
    return NextResponse.json({ error: 'شناسه و وضعیت جدید الزامی است.' }, { status: 400 });
  }

  const validStatuses = ['pending', 'approved', 'rejected', 'ordered'];
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: 'وضعیت نامعتبر است. مقادیر مجاز: pending, approved, rejected, ordered' }, { status: 400 });
  }

  const existing = await db.productionPurchaseRequest.findFirst({
    where: { id, ...(optionalCompanyWhere(await getAllowedCompanyIds(user)) ?? {}) },
  });
  if (!existing) {
    return NextResponse.json({ error: 'درخواست یافت نشد.' }, { status: 404 });
  }

  // v2.21.0 — the guards used to run against a snapshot read OUTSIDE the
  // write, so a concurrent `approve` and `reject` BOTH passed (an approved
  // request can't be rejected and a rejected one can't be approved — but
  // neither writer ever saw the other's result) and the request ended in
  // whichever state committed last, bypassing the rule entirely. The live
  // row is now re-read INSIDE the transaction; exactly one concurrent
  // writer wins.
  // v2.58.7 (G3): the in-tx live read ALSO carries the company fragment now
  // — previously the WRITE path ignored the very scope that list/get/get-inbox
  // enforced (write scope ≠ read scope: a company-stamped request outside
  // the caller's companies was transitionable while invisible in their UI).
  const txCompanyScope = optionalCompanyWhere(await getAllowedCompanyIds(user)) ?? {};
  let item;
  try {
    item = await db.$transaction(async (tx) => {
      const live = await tx.productionPurchaseRequest.findFirst({
        where: { id, ...txCompanyScope },
      });
      if (!live) throw new ApiError(404, 'درخواست یافت نشد.');

      if (live.status === 'approved' && status === 'rejected') {
        throw new ApiError(400, 'درخواست تأییدشده قابل رد شدن نیست.');
      }
      if (live.status === 'rejected' && (status === 'approved' || status === 'ordered')) {
        throw new ApiError(400, 'درخواست ردشده قابل تأیید نیست.');
      }
      if (live.status === status) {
        throw new ApiError(400, `درخواست از قبل در وضعیت «${status}» است.`);
      }

      return tx.productionPurchaseRequest.update({
        where: { id },
        data: { status },
      });
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  return NextResponse.json({ message: 'وضعیت درخواست با موفقیت تغییر کرد.', item });
}

// ════════════════════════════════════════════════════════
//  LIST INBOX — pending requests for production unit
// ════════════════════════════════════════════════════════
async function handleListInbox(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده صندوق درخواست‌ها را ندارید.' }, { status: 403 });
  }

  const {
    page = 1,
    pageSize = 20,
  } = body as {
    page?: number;
    pageSize?: number;
  };

  // v2.58.0 (audit 85-a #6): page/pageSize clamped — NaN used to throw a
  // Prisma 500, huge pageSize dumped whole tables in one response.
  const p = Math.max(1, Math.min(Number.isFinite(Number(page)) ? Number(page) : 1, 500));
  const ps = Math.max(1, Math.min(Number.isFinite(Number(pageSize)) ? Number(pageSize) : 20, 100));
  const skip = (p - 1) * ps;
  const take = ps;

  // v2.58.7 (G3): list-inbox previously returned EVERY pending request with
  // no company fragment while list/get were scoped — same asymmetry, fixed
  // the same way (shared companyId-null queue stays visible to all).
  const where: Record<string, unknown> = { status: 'pending' };
  const inboxCompanyScope = optionalCompanyWhere(await getAllowedCompanyIds(user));
  if (inboxCompanyScope) Object.assign(where, inboxCompanyScope);

  const [items, total] = await Promise.all([
    db.productionPurchaseRequest.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    db.productionPurchaseRequest.count({ where }),
  ]);

  return NextResponse.json({
    items,
    total,
    page: p,
    pageSize: take,
    totalPages: Math.ceil(total / take),
  });
}