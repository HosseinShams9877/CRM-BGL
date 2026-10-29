import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { logApiError } from '@/lib/logger';
import {
  getAllowedCompanyIds, optionalCompanyCenterWhere, centerCompanyWhere, COMPANY_ACCESS_DENIED,
  strictIsolatedCompanyWhere, allowedCenterIds,
} from '@/lib/company-scope';
import { apiErrorMessage, apiErrorStatus, ApiError } from '@/lib/api-error';
import { resolveTerritoryScope, territoryVisibleCenterIds, centerInTerritory } from '@/lib/territory-scope';

// v2.21.0 — serial lifecycle state machine. Previously ANY status could be
// written over ANY other status: a sold unit could be resurrected to
// `available`, a `defective` unit could be marked `sold`, and re-selling a
// `sold` serial appended a second "sold" history row. Transitions follow
// the physical life of a unit:
//   available → sold / defective            (sell it, or scrap it)
//   sold      → returned / defective        (customer sent it back)
//   returned  → available / defective       (restock after inspection)
//   defective → available / returned        (repaired, or re-classified)
const SERIAL_TRANSITIONS: Record<string, string[]> = {
  available: ['sold', 'defective'],
  sold: ['returned', 'defective'],
  returned: ['available', 'defective'],
  defective: ['available', 'returned'],
};
const SERIAL_STATUS_LABELS: Record<string, string> = {
  available: 'موجود', sold: 'فروخته‌شده', returned: 'مرجوعی', defective: 'معیوب',
};

// ═══ v2.58.3 (round 88, finding 1) — SALES TERRITORY on inventory ══
// A scoped expert (standard role, provinces/centers mode) only sees and
// mutates serials whose CENTER sits inside their sales territory.
// Warehouse stock (centerId null) carries no center data and stays
// visible. InventorySerial has no center RELATION (raw centerId), so the
// provinces mode resolves the visible center-id list up front — the same
// discipline the files route uses. Admin / finance / production and
// country-mode users are unaffected. Deny-all (broken assignment):
// centerless stock only.
async function withSerialTerritory(
  where: Record<string, unknown>,
  user: AuthUser,
  allowedCompanyIds: string[] | null,
): Promise<void> {
  const t = resolveTerritoryScope(user);
  if (!t) return;
  const companyCenterIds = allowedCompanyIds === null ? null : await allowedCenterIds(allowedCompanyIds);
  const visible = await territoryVisibleCenterIds(user, companyCenterIds);
  where.AND = [
    ...(Array.isArray(where.AND) ? (where.AND as unknown[]) : []),
    { OR: [{ centerId: null }, { centerId: { in: visible } }] },
  ];
}

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
    if (action === 'update-status') return await handleUpdateStatus(body, user);
    if (action === 'history') return await handleHistory(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('inventory', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST — with status & product filter
// ════════════════════════════════════════════════════════
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده انبار را ندارید.' }, { status: 403 });
  }

  const {
    page = 1,
    pageSize = 20,
    status,
    productCode,
    serialNumber,
    companySlug,
  } = body as {
    page?: number;
    pageSize?: number;
    status?: string;
    productCode?: string;
    serialNumber?: string;
    companySlug?: string;
  };

  // v2.12.0: tenant isolation — serials tied to a center (sold units) are
  // restricted to the user's companies; unassigned warehouse stock carries
  // no company data and stays visible. Previously there was NO filter at
  // all — every company's sold units were listable by any user.
  // v2.25.0 — the filter now reads the DIRECT companyId column (backfilled
  // from the center) instead of pre-computing the allowed center-id set.
  // v2.35.0 — exclusively-isolated users (یاس طب) get a STRICT filter:
  // their own warehouse only; the shared neutral pool is group stock.
  const listCompanyScope = (await strictIsolatedCompanyWhere(user))
    ?? optionalCompanyCenterWhere(await getAllowedCompanyIds(user));

  const where: Record<string, unknown> = {};
  // v2.34.12 — per-company warehouse view. Admins may pass the active
  // company slug (the top-navbar context) to narrow the list to that
  // company's warehouse ONLY. Scoped users IGNORE the param — their
  // OR-scope (own companies + shared neutral stock) already applies and
  // must never be widenable from the client.
  // v2.35.0 — isolated warehouses (یاس طب) are off-limits to admins too.
  const isAdmin = getCanonicalRole(user.role) === 'admin';
  if (isAdmin && companySlug && companySlug !== 'holding') {
    const companyRow = await db.company.findUnique({
      where: { slug: companySlug },
      select: { id: true, isIsolated: true },
    });
    if (!companyRow) {
      return NextResponse.json({ error: 'شرکت نامعتبر است.' }, { status: 400 });
    }
    if (companyRow.isIsolated) {
      return NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 });
    }
    where.companyId = companyRow.id;
  } else if (listCompanyScope) {
    Object.assign(where, listCompanyScope);
  }
  // v2.58.3 — sales territory: only serials of the expert's territory's
  // centers (plus centerless warehouse stock).
  await withSerialTerritory(where, user, await getAllowedCompanyIds(user));
  if (status) where.status = status;
  if (productCode) where.productCode = productCode;
  if (serialNumber) {
    where.serialNumber = { contains: serialNumber };
  }

  const skip = (Number(page) - 1) * Number(pageSize);
  const take = Number(pageSize);

  const [items, total] = await Promise.all([
    db.inventorySerial.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      // v2.34.12 — warehouse owner label for the UI rows («انبار …»).
      include: { company: { select: { slug: true, name: true } } },
    }),
    db.inventorySerial.count({ where }),
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
//  GET
// ════════════════════════════════════════════════════════
async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده انبار را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه الزامی است.' }, { status: 400 });
  }

  // v2.12.0: tenant isolation on single-serial reads (404 — no leak).
  // v2.25.0 — direct companyId column (backfilled from the center).
  // v2.35.0 — isolated users: strict private-warehouse scope.
  const getWhere: Record<string, unknown> = { id };
  const getCompanyScope = (await strictIsolatedCompanyWhere(user))
    ?? optionalCompanyCenterWhere(await getAllowedCompanyIds(user));
  if (getCompanyScope) Object.assign(getWhere, getCompanyScope);
  // v2.58.3 — territory gate on single-serial reads (out-of-territory = 404)
  await withSerialTerritory(getWhere, user, await getAllowedCompanyIds(user));
  const item = await db.inventorySerial.findFirst({
    where: getWhere,
    include: {
      history: { orderBy: { createdAt: 'desc' } },
      // v2.34.12 — same warehouse-owner label the list carries.
      company: { select: { slug: true, name: true } },
    },
  });

  if (!item) {
    return NextResponse.json({ error: 'آیتم یافت نشد.' }, { status: 404 });
  }

  return NextResponse.json({ item });
}

// ════════════════════════════════════════════════════════
//  CREATE — enter serial
// ════════════════════════════════════════════════════════
async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.upload_files) {
    return NextResponse.json({ error: 'شما دسترسی ثبت کالای جدید را ندارید.' }, { status: 403 });
  }

  const { productCode, serialNumber, notes, centerId, companySlug } = body as {
    productCode?: string;
    serialNumber?: string;
    notes?: string;
    centerId?: string;
    companySlug?: string;
  };

  if (!serialNumber) {
    return NextResponse.json({ error: 'شماره سریال الزامی است.' }, { status: 400 });
  }

  // v2.12.0: tenant isolation — a serial may only be registered against a
  // center belonging to one of the user's companies.
  // v2.25.0 — the row is stamped with the center's companyId so the list
  // predicate above can filter directly on the column.
  // v2.34.12 — per-company warehouses: an entry made while a company is
  // active (top-navbar context) lands in THAT company's warehouse.
  // Priority: an explicit center assignment still wins (the unit's owner
  // is the center's company); otherwise the explicit companySlug; otherwise
  // a single-company user's only company (their entries can no longer leak
  // into the shared neutral pool). Admins without any company context
  // still create shared/neutral stock, same as before.
  let stampedCompanyId: string | null = null;
  const createAllowedIds = await getAllowedCompanyIds(user);
  if (companySlug && companySlug !== 'holding') {
    const companyRow = await db.company.findUnique({
      where: { slug: companySlug },
      select: { id: true },
    });
    if (!companyRow) {
      return NextResponse.json({ error: 'شرکت نامعتبر است.' }, { status: 400 });
    }
    if (createAllowedIds !== null && !createAllowedIds.includes(companyRow.id)) {
      return NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 });
    }
    stampedCompanyId = companyRow.id;
  } else if (createAllowedIds !== null && createAllowedIds.length === 1) {
    stampedCompanyId = createAllowedIds[0];
  }
  if (centerId) {
    const centerRow = await db.center.findFirst({
      where: { id: centerId, ...(centerCompanyWhere(createAllowedIds) ?? {}) },
      select: { id: true, companyId: true, province: true },
    });
    if (!centerRow) {
      return NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 });
    }
    // v2.58.3 — a scoped expert registers serials only for centers inside
    // their sales territory (fail-closed write).
    if (!centerInTerritory({ id: centerId, province: centerRow.province }, resolveTerritoryScope(user))) {
      return NextResponse.json({ error: 'مرکز موردنظر در محدودهٔ فروش شما نیست.' }, { status: 403 });
    }
    stampedCompanyId = centerRow.companyId;
  }

  const existing = await db.inventorySerial.findUnique({
    where: { serialNumber },
  });
  if (existing) {
    return NextResponse.json({ error: 'این شماره سریال قبلاً ثبت شده است.' }, { status: 409 });
  }

  // v2.21.0 — the pre-check above is only a fast path: two clerks entering
  // the same serial at the same time both pass it, and the loser used to
  // surface the raw unique-constraint error as a 500. The DB constraint is
  // the real guard; a P2002 is translated into the same Persian 409. The
  // serial row and its "entered" history row are also written in ONE
  // transaction now — a crash between the two writes used to leave a serial
  // whose audit trail started mid-life.
  let item;
  try {
    item = await db.$transaction(async (tx) => {
      const created = await tx.inventorySerial.create({
        data: {
          productCode: productCode || null,
          serialNumber,
          notes: notes || '',
          centerId: centerId || null,
          companyId: stampedCompanyId,
          status: 'available',
          createdById: user.id,
        },
      });
      await tx.inventorySerialHistory.create({
        data: {
          serialId: created.id,
          action: 'entered',
          toStatus: 'available',
          description: 'ورود کالا به انبار',
          createdById: user.id,
        },
      });
      return created;
    });
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === 'P2002') {
      return NextResponse.json({ error: 'این شماره سریال قبلاً ثبت شده است.' }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ message: 'کالا با موفقیت به انبار اضافه شد.', item }, { status: 201 });
}

// ════════════════════════════════════════════════════════
//  UPDATE STATUS
// ════════════════════════════════════════════════════════
async function handleUpdateStatus(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.upload_files) {
    return NextResponse.json({ error: 'شما دسترسی تغییر وضعیت کالا را ندارید.' }, { status: 403 });
  }

  const { id, status, notes } = body as {
    id?: string;
    status?: string;
    notes?: string;
  };

  if (!id || !status) {
    return NextResponse.json({ error: 'شناسه و وضعیت جدید الزامی است.' }, { status: 400 });
  }

  const validStatuses = ['available', 'sold', 'returned', 'defective'];
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: 'وضعیت نامعتبر است. مقادیر مجاز: available, sold, returned, defective' }, { status: 400 });
  }

  // v2.12.0: tenant isolation on status changes (404 — no leak).
  // v2.25.0 — direct companyId column (backfilled from the center).
  // v2.35.0 — isolated users: strict private-warehouse scope.
  // v2.58.3 — sales territory: an out-of-territory serial cannot be
  // mutated (status/history both gated).
  const updWhere: Record<string, unknown> = { id };
  const updCompanyScope = (await strictIsolatedCompanyWhere(user))
    ?? optionalCompanyCenterWhere(await getAllowedCompanyIds(user));
  if (updCompanyScope) Object.assign(updWhere, updCompanyScope);
  await withSerialTerritory(updWhere, user, await getAllowedCompanyIds(user));
  const existing = await db.inventorySerial.findFirst({ where: updWhere });
  if (!existing) {
    return NextResponse.json({ error: 'آیتم یافت نشد.' }, { status: 404 });
  }

  // v2.21.0 — the transition was previously validated (or rather: NOT
  // validated) against a snapshot read OUTSIDE the write, so two concurrent
  // transitions both passed (e.g. `sold` + `returned` for the same unit,
  // both logging history) and any illegal jump (sold → available) went
  // straight through. The live row is now re-read INSIDE the transaction:
  // exactly one concurrent writer wins, illegal jumps get a 400, and the
  // status write + its history row land atomically.
  let item;
  try {
    item = await db.$transaction(async (tx) => {
      const live = await tx.inventorySerial.findFirst({ where: updWhere });
      if (!live) throw new ApiError(404, 'آیتم یافت نشد.');

      if (live.status === status) {
        throw new ApiError(400, `کالا از قبل در وضعیت «${SERIAL_STATUS_LABELS[live.status] || live.status}» است.`);
      }
      const allowedNext = SERIAL_TRANSITIONS[live.status] ?? [];
      if (!allowedNext.includes(status)) {
        throw new ApiError(
          400,
          `گذار از «${SERIAL_STATUS_LABELS[live.status] || live.status}» به «${SERIAL_STATUS_LABELS[status] || status}» مجاز نیست. گذارهای مجاز از این وضعیت: ${allowedNext.map((s) => SERIAL_STATUS_LABELS[s] || s).join('، ')}.`,
        );
      }

      const updated = await tx.inventorySerial.update({
        where: { id },
        data: {
          status,
          // soldAt semantics (v2.58.3, finding 2): the timestamp of the
          // LAST sale event. It is (re)written on every `sold` transition
          // and PRESERVED through returned/defective/available — the sales
          // history and the warranty window (soldAt + product months) stay
          // intact across a return; it is only replaced when the unit is
          // actually sold again. Never wiped without a review decision.
          soldAt: status === 'sold' ? new Date() : (live.soldAt || null),
          // Detaching the customer's center on `returned` is NOT a company
          // transfer (v2.58.3, finding 2): the serial keeps its center while
          // sold and drops ONLY the center link when it comes back — the
          // owning company NEVER changes through a status transition.
          centerId: status === 'sold' ? (live.centerId || null) : (status === 'returned' ? null : live.centerId),
          // v2.58.3 — THE FIX: `returned` used to null companyId, silently
          // dropping an isolated company's (or any company's) returned unit
          // into the SHARED neutral pool — visible to everyone and outside
          // the strict isolated-warehouse filter after restock. Company
          // ownership now survives every status change; the only sanctioned
          // cross-company transfer is the explicit admin inventory flow.
          companyId: live.companyId
            ?? (status === 'sold' && live.centerId
              ? (await tx.center.findUnique({ where: { id: live.centerId }, select: { companyId: true } }))?.companyId ?? null
              : null),
        },
      });
      await tx.inventorySerialHistory.create({
        data: {
          serialId: id,
          action: status,
          fromStatus: live.status,
          toStatus: status,
          description: notes || `تغییر وضعیت از ${live.status} به ${status}`,
          createdById: user.id,
        },
      });
      return updated;
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  return NextResponse.json({ message: 'وضعیت کالا با موفقیت تغییر کرد.', item });
}

// ════════════════════════════════════════════════════════
//  HISTORY — serial history
// ════════════════════════════════════════════════════════
async function handleHistory(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده سابقه کالا را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه الزامی است.' }, { status: 400 });
  }

  // v2.12.0: tenant isolation on serial history (404 — no leak).
  // v2.25.0 — direct companyId column (backfilled from the center).
  // v2.35.0 — isolated users: strict private-warehouse scope.
  // v2.58.3 — territory gate on history reads.
  const histWhere: Record<string, unknown> = { id };
  const histCompanyScope = (await strictIsolatedCompanyWhere(user))
    ?? optionalCompanyCenterWhere(await getAllowedCompanyIds(user));
  if (histCompanyScope) Object.assign(histWhere, histCompanyScope);
  await withSerialTerritory(histWhere, user, await getAllowedCompanyIds(user));
  const serial = await db.inventorySerial.findFirst({
    where: histWhere,
  });

  if (!serial) {
    return NextResponse.json({ error: 'آیتم یافت نشد.' }, { status: 404 });
  }

  const history = await db.inventorySerialHistory.findMany({
    where: { serialId: id },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ serial, history });
}
