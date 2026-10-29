import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { logApiError } from '@/lib/logger';
import {
  getAllowedCompanyIds, centerInCompanyScope,
  ownerScopedCenterWhere, NON_COMPANY_SLUGS,
  COMPANY_ACCESS_DENIED, assigneeInScope,
} from '@/lib/company-scope';
import { activityTerritoryWhere, resolveTerritoryScope, centerInTerritory } from '@/lib/territory-scope';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { sanitizeActivityProducts } from '@/lib/activity-products';

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده‌ است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'list') return await handleList(body, user);
    if (action === 'get') return await handleGet(body, user);
    if (action === 'create') return await handleCreate(body, user);
    if (action === 'update') return await handleUpdate(body, user);
    if (action === 'delete') return await handleDelete(body, user);
    // v2.34.7 — assignee picker for the quick-activity form: display names
    // of the colleagues the user already shares a company with (the same
    // visibility set the activity tenant-isolation engine uses).
    if (action === 'colleagues') return await handleColleagues(user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('activities', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.calendar) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده فعالیت‌ها را ندارید.' }, { status: 403 });
  }

  const {
    page = 1,
    pageSize = 20,
    dateFrom,
    dateTo,
    centerId,
    status,
    assignedTo,
    mineOnly,
    // v2.44.0 (round 69) — call list pagination: the ثبت تماس screen now
    // pages through CALLS ONLY on the server (30 revealed at a time),
    // instead of pulling 200 mixed activities and filtering client-side.
    // Optional + validated, so every existing caller is unaffected.
    isPhoneCall,
  } = body as {
    page?: number;
    pageSize?: number;
    dateFrom?: string;
    dateTo?: string;
    centerId?: string;
    status?: string;
    assignedTo?: string;
    mineOnly?: boolean;
    isPhoneCall?: boolean;
  };

  const where: Record<string, unknown> = { businessUnitId: user.businessUnitId };

  // v2.31.2: owner-aware tenant isolation (round-30 leak fix). The old
  // optionalCenterCompanyWhere() treated center-less rows (personal tasks
  // created from the calendar without picking a center — the UI default) as
  // company-neutral, so ANY user of the business unit could read and edit
  // them across companies. A center-less row is now visible only to
  // colleagues (users sharing a company with its creator/assignee).
  Object.assign(where, await ownerScopedCenterWhere(user));

  // v2.41.0 (r57 port) — sales territory: scoped experts see activities of their
  // territory's centers plus their OWN center-less tasks («فعالیت‌های
  // خودم یا مراکز تحت مدیریت») — center-less colleague rows stay hidden.
  const listTerritory = resolveTerritoryScope(user);
  if (listTerritory) {
    where.AND = [...(Array.isArray(where.AND) ? (where.AND as unknown[]) : []), activityTerritoryWhere(listTerritory, user.id)];
  }

  if (dateFrom || dateTo) {
    // v2.34.7 — date-only bounds (YYYY-MM-DD) are now DAY-INCLUSIVE.
    // Rows are anchored two different ways: legacy quick-activity rows at
    // UTC midnight (the old client sent a date-only string) and calendar/
    // quick-form rows at local noon. The old exact-midnight gte/lte missed
    // every noon-anchored row, so a from==to "today" query returned nothing
    // for them. Date-only bounds now span the whole UTC day; full ISO
    // timestamps keep their exact meaning.
    const dateFilter: Record<string, unknown> = {};
    if (dateFrom) {
      dateFilter.gte = /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)
        ? new Date(`${dateFrom}T00:00:00.000Z`)
        : new Date(dateFrom);
    }
    if (dateTo) {
      dateFilter.lte = /^\d{4}-\d{2}-\d{2}$/.test(dateTo)
        ? new Date(`${dateTo}T23:59:59.999Z`)
        : new Date(dateTo);
    }
    where.activityDate = dateFilter;
  }

  if (centerId) where.centerId = centerId;
  if (status) where.status = status;
  if (assignedTo) where.assignedTo = assignedTo;

  // v2.44.0 (round 69) — optional call-only / non-call filter. Boolean-typed
  // (a truthy string like "true" is rejected) so the semantics can never be
  // accidentally widened; combined with page/pageSize it lets the ثبت تماس
  // screen page through exactly the call rows in scope.
  if (isPhoneCall !== undefined) {
    if (typeof isPhoneCall !== 'boolean') {
      return NextResponse.json({ error: 'پارامتر isPhoneCall باید بولین باشد.' }, { status: 400 });
    }
    where.isPhoneCall = isPhoneCall;
  }

  // v2.34.7 — quick-activity personal task board: rows the acting user
  // created OR is responsible for (their own to-do list), still inside the
  // tenant scope applied above.
  // v2.58.3 (round 88, finding 1) — APPEND, never overwrite: this line
  // previously REPLACED where.AND, wiping the sales-territory fragment
  // pushed above — a scoped expert's "my activities" view then leaked
  // their out-of-territory rows. The ownership condition now COMPOSES
  // with every prior scope (tenant + territory).
  if (mineOnly) {
    where.AND = [
      ...(Array.isArray(where.AND) ? (where.AND as unknown[]) : []),
      { OR: [{ assignedTo: user.id }, { createdById: user.id }] },
    ];
  }

  const skip = (Number(page) - 1) * Number(pageSize);
  const take = Number(pageSize);

  const [items, total] = await Promise.all([
    db.activity.findMany({
      where,
      skip,
      take,
      // v2.58.0 (audit 85-c): unique tiebreaker — legacy bulk imports share
      // (activityDate, createdAt) across up to 126 rows; without a unique
      // final sort key, skip/take pagination silently drops/duplicates rows.
      orderBy: [{ activityDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      include: {
        center: { select: { id: true, name: true } },
        assignedUser: { select: { id: true, displayName: true } },
        creator: { select: { id: true, displayName: true } },
      },
    }),
    db.activity.count({ where }),
  ]);

  return NextResponse.json({
    items,
    total,
    page: Number(page),
    pageSize: take,
    totalPages: Math.ceil(total / take),
  });
}

// ════════════════════════════════════════════════════════
//  COLLEAGUES (v2.34.7 — assignee picker, display names only)
// ════════════════════════════════════════════════════════
async function handleColleagues(user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.calendar) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده فعالیت‌ها را ندارید.' }, { status: 403 });
  }

  // Same colleague definition the tenant-isolation engine uses: users
  // sharing at least one company with the requester. Admins see the whole
  // business unit. Only id/displayName are exposed — no usernames, no roles.
  let where: Record<string, unknown> = { businessUnitId: user.businessUnitId, isActive: true };
  if (getCanonicalRole(user.role) !== 'admin') {
    const slugs = user.companyIds.filter((s) => !NON_COMPANY_SLUGS.has(s));
    if (slugs.length === 0) return NextResponse.json({ items: [] });
    where = {
      ...where,
      OR: slugs.map((s) => ({ companyIds: { contains: `"${s}"` } })),
    };
  }

  const users = await db.user.findMany({
    where,
    select: { id: true, displayName: true },
    orderBy: { displayName: 'asc' },
    take: 200,
  });
  return NextResponse.json({ items: users.map((u) => ({ ...u, me: u.id === user.id })) });
}

// ════════════════════════════════════════════════════════
//  GET
// ════════════════════════════════════════════════════════
async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.calendar) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده فعالیت‌ها را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه فعالیت الزامی است.' }, { status: 400 });
  }

  const where: Record<string, unknown> = {
    id,
    businessUnitId: user.businessUnitId,
  };

  // v2.31.2: owner-aware tenant isolation on single-activity reads
  Object.assign(where, await ownerScopedCenterWhere(user));

  // v2.41.0 (r57 port): territory gate on single reads — out-of-territory activity
  // reads as not found.
  const getTerritory = resolveTerritoryScope(user);
  if (getTerritory) {
    where.AND = [...(Array.isArray(where.AND) ? (where.AND as unknown[]) : []), activityTerritoryWhere(getTerritory, user.id)];
  }

  const activity = await db.activity.findFirst({
    where,
    include: {
      center: { select: { id: true, name: true, phone: true } },
      assignedUser: { select: { id: true, displayName: true } },
      creator: { select: { id: true, displayName: true } },
      updater: { select: { id: true, displayName: true } },
    },
  });

  if (!activity) {
    return NextResponse.json({ error: 'فعالیت یافت نشد.' }, { status: 404 });
  }

  return NextResponse.json({ activity });
}

// ════════════════════════════════════════════════════════
//  CREATE
// ════════════════════════════════════════════════════════
async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.calendar) {
    return NextResponse.json({ error: 'شما دسترسی ایجاد فعالیت را ندارید.' }, { status: 403 });
  }

  const { title, description, activityDate, activityTime, isPhoneCall, isOnsiteVisit, isUnansweredCall, centerId, assignedTo, products } = body as {
    title?: string;
    description?: string;
    activityDate?: string;
    activityTime?: string;
    isPhoneCall?: boolean;
    isOnsiteVisit?: boolean;
    isUnansweredCall?: boolean;
    centerId?: string;
    assignedTo?: string;
    /** v2.34.9 — optional product tags [{id,name}] (snapshot semantics). */
    products?: unknown;
  };

  if (!title || !activityDate) {
    return NextResponse.json({ error: 'عنوان و تاریخ فعالیت الزامی است.' }, { status: 400 });
  }

  // v2.12.0: tenant isolation — an activity may only be attached to a
  // center belonging to one of the user's companies. v2.34.9: an unknown
  // center id used to surface as a raw FK-violation 500 for admins (scope
  // check passes unrestricted, then the create trips the constraint) —
  // it is now a clean 404, same translation discipline as P2025.
  if (centerId) {
    const center = await db.center.findUnique({ where: { id: centerId }, select: { companyId: true } });
    if (!center) {
      return NextResponse.json({ error: 'مرکز مشخص‌شده یافت نشد.' }, { status: 404 });
    }
    const allowed = await getAllowedCompanyIds(user);
    if (allowed !== null && !allowed.includes(center.companyId)) {
      return NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 });
    }
  }

  // v2.41.0 (r57 port): territory isolation — the target center must also sit inside
  // the expert's sales territory (fail-closed write, 404-style message).
  if (centerId) {
    const createTerritory = resolveTerritoryScope(user);
    if (createTerritory) {
      const center = await db.center.findUnique({
        where: { id: centerId },
        select: { province: true },
      });
      if (!center || !centerInTerritory({ id: centerId, province: center.province }, createTerritory)) {
        return NextResponse.json({ error: 'مرکز موردنظر در محدودهٔ فروش شما نیست.' }, { status: 403 });
      }
    }
  }

  // v2.58.0 (audit 85-a #4): assignedTo is validated as a visible colleague
  // — an unknown id used to surface as a raw Prisma P2025 500, and a group
  // user could assign a task to an isolated (یاس‌طب) user who then saw the
  // row through the assignee-in-colleague-set scope. Same helper the voice
  // twin has used since v2.47.0.
  if (assignedTo && !(await assigneeInScope(assignedTo, user))) {
    return NextResponse.json({ error: 'کاربر تعیین‌شده برای واگذاری یافت نشد یا در دسترس شما نیست.' }, { status: 404 });
  }

  const activity = await db.activity.create({
    data: {
      title,
      description: description || '',
      activityDate: new Date(activityDate),
      activityTime: activityTime || '',
      isPhoneCall: isPhoneCall || false,
      isOnsiteVisit: isOnsiteVisit || false,
      isUnansweredCall: isUnansweredCall || false,
      centerId: centerId || null,
      assignedTo: assignedTo || null,
      createdById: user.id,
      businessUnitId: user.businessUnitId,
      // v2.34.9 — optional product tags; invalid payloads degrade to "[]"
      // (the picker is optional, never worth failing the whole save).
      products: sanitizeActivityProducts(products),
    },
    include: {
      center: { select: { id: true, name: true } },
      assignedUser: { select: { id: true, displayName: true } },
      creator: { select: { id: true, displayName: true } },
    },
  });

  return NextResponse.json({ message: 'فعالیت با موفقیت ایجاد شد.', activity }, { status: 201 });
}

// ════════════════════════════════════════════════════════
//  UPDATE (status change, complete)
// ════════════════════════════════════════════════════════
async function handleUpdate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.calendar) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش فعالیت را ندارید.' }, { status: 403 });
  }

  const { id, title, description, activityDate, activityTime, status, isPhoneCall, centerId, assignedTo } = body as {
    id?: string;
    title?: string;
    description?: string;
    activityDate?: string;
    activityTime?: string;
    status?: string;
    isPhoneCall?: boolean;
    centerId?: string;
    assignedTo?: string;
  };

  if (!id) {
    return NextResponse.json({ error: 'شناسه فعالیت الزامی است.' }, { status: 400 });
  }

  const existingWhere: Record<string, unknown> = {
    id,
    businessUnitId: user.businessUnitId,
  };
  // v2.31.2: owner-aware tenant isolation on updates
  Object.assign(existingWhere, await ownerScopedCenterWhere(user));
  // v2.41.0 (r57 port): territory gate on updates (same visibility as reads)
  const updTerritory = resolveTerritoryScope(user);
  if (updTerritory) {
    existingWhere.AND = [...(Array.isArray(existingWhere.AND) ? (existingWhere.AND as unknown[]) : []), activityTerritoryWhere(updTerritory, user.id)];
  }
  const existing = await db.activity.findFirst({
    where: existingWhere,
  });
  if (!existing) {
    return NextResponse.json({ error: 'فعالیت یافت نشد.' }, { status: 404 });
  }

  // v2.12.0: re-assigning the activity to an out-of-scope center is forbidden
  if (centerId !== undefined && centerId
    && !(await centerInCompanyScope(centerId, await getAllowedCompanyIds(user)))) {
    return NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 });
  }
  // v2.41.0 (r57 port): re-assigning to an out-of-TERRITORY center is forbidden too
  if (centerId !== undefined && centerId) {
    const reassignTerritory = resolveTerritoryScope(user);
    if (reassignTerritory) {
      const center = await db.center.findUnique({
        where: { id: centerId },
        select: { province: true },
      });
      if (!center || !centerInTerritory({ id: centerId, province: center.province }, reassignTerritory)) {
        return NextResponse.json({ error: 'مرکز موردنظر در محدودهٔ فروش شما نیست.' }, { status: 403 });
      }
    }
  }
  const validStatuses = ['pending', 'done', 'cancelled'];
  // v2.58.0 (audit 85-a #4): same assignee validation on update — the
  // update path previously trusted assignedTo exactly like create did.
  if (assignedTo !== undefined && assignedTo && !(await assigneeInScope(assignedTo, user))) {
    return NextResponse.json({ error: 'کاربر تعیین‌شده برای واگذاری یافت نشد یا در دسترس شما نیست.' }, { status: 404 });
  }
  const data: Record<string, unknown> = { updatedById: user.id };
  if (title !== undefined) data.title = title;
  if (description !== undefined) data.description = description;
  if (activityDate !== undefined) data.activityDate = new Date(activityDate);
  if (activityTime !== undefined) data.activityTime = activityTime;
  if (isPhoneCall !== undefined) data.isPhoneCall = isPhoneCall;
  if (centerId !== undefined) data.centerId = centerId || null;
  if (assignedTo !== undefined) data.assignedTo = assignedTo || null;
  if (status !== undefined) {
    if (!validStatuses.includes(status)) {
      return NextResponse.json({ error: 'وضعیت نامعتبر است. مقادیر مجاز: pending, done, cancelled' }, { status: 400 });
    }
    data.status = status;
    if (status === 'done') {
      data.completedAt = new Date();
    }
  }

  // v2.21.0 — the existence check above used to be the only guard: when a
  // concurrent delete removed the row between the check and the write, the
  // raw Prisma P2025 error surfaced as a 500. A vanished row is now a clean
  // 404 ("فعالیت یافت نشد") for both update and delete.
  let activity;
  try {
    activity = await db.activity.update({
      where: { id },
      data,
      include: {
        center: { select: { id: true, name: true } },
        assignedUser: { select: { id: true, displayName: true } },
        creator: { select: { id: true, displayName: true } },
      },
    });
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === 'P2025') {
      return NextResponse.json({ error: 'فعالیت یافت نشد (ممکن است هم‌زمان حذف شده باشد).' }, { status: 404 });
    }
    throw e;
  }

  return NextResponse.json({ message: 'فعالیت با موفقیت به‌روزرسانی شد.', activity });
}

// ════════════════════════════════════════════════════════
//  DELETE
// ════════════════════════════════════════════════════════
async function handleDelete(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.calendar) {
    return NextResponse.json({ error: 'شما دسترسی حذف فعالیت را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه فعالیت الزامی است.' }, { status: 400 });
  }

  const deleteWhere: Record<string, unknown> = {
    id,
    businessUnitId: user.businessUnitId,
  };
  // v2.31.2: owner-aware tenant isolation on deletes
  Object.assign(deleteWhere, await ownerScopedCenterWhere(user));
  // v2.41.0 (r57 port): territory gate on deletes
  const delTerritory = resolveTerritoryScope(user);
  if (delTerritory) {
    deleteWhere.AND = [...(Array.isArray(deleteWhere.AND) ? (deleteWhere.AND as unknown[]) : []), activityTerritoryWhere(delTerritory, user.id)];
  }
  const existing = await db.activity.findFirst({
    where: deleteWhere,
  });
  if (!existing) {
    return NextResponse.json({ error: 'فعالیت یافت نشد.' }, { status: 404 });
  }

  // v2.21.0 — same P2025→404 translation as update (concurrent double-delete).
  try {
    await db.activity.delete({ where: { id } });
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === 'P2025') {
      return NextResponse.json({ error: 'فعالیت یافت نشد (ممکن است هم‌زمان حذف شده باشد).' }, { status: 404 });
    }
    throw e;
  }

  return NextResponse.json({ message: 'فعالیت با موفقیت حذف شد.' });
}
