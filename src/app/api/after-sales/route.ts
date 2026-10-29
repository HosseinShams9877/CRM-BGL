import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { computeWarranty } from '@/lib/business-model';
import { assertConcurrencyToken } from '@/lib/concurrency';
import { ticketCreateSchema, parseBody } from '@/lib/validators';
import { parseIntRial } from '@/lib/money';
import { logApiError } from '@/lib/logger';
import {
  getAllowedCompanyIds, centerCompanyWhere, ownerScopedCenterWhere, COMPANY_ACCESS_DENIED,
} from '@/lib/company-scope';
import { apiErrorMessage, apiErrorStatus, ApiError } from '@/lib/api-error';
import { TICKET_STATUS_LABELS } from '@/lib/business-model';
import { activityTerritoryWhere, resolveTerritoryScope, centerInTerritory } from '@/lib/territory-scope';

// ════════════════════════════════════════════════════════════════
//  AFTER-SALES API — خدمات پس از فروش و گارانتی سریال‌محور
//  تیکت خدمات + گردش وضعیت + استعلام گارانتی بر اساس سریال انبار
//  گارانتی = تاریخ فروش سریال + ماه‌های گارانتی محصول
// ════════════════════════════════════════════════════════════════

const TICKET_TYPES = ['repair', 'maintenance', 'installation', 'training', 'replacement'];
const TICKET_STATUSES = ['open', 'in_progress', 'waiting_parts', 'resolved', 'closed', 'rejected'];
const TICKET_PRIORITIES = ['low', 'normal', 'high', 'critical'];

// v2.21.0 — server-side ticket lifecycle. The frontend already restricted
// buttons to these transitions (NEXT_STATUSES in after-sales.tsx), but the
// API accepted ANY from→to pair: an API caller could resurrect a `closed`
// ticket to `in_progress`, or "resolve" an already `rejected` one. The rule
// now lives on the server — the UI is just a courtesy.
const TICKET_TRANSITIONS: Record<string, string[]> = {
  open: ['in_progress', 'rejected'],
  in_progress: ['waiting_parts', 'resolved', 'rejected'],
  waiting_parts: ['in_progress', 'resolved'],
  resolved: ['closed'],
  closed: [],
  rejected: [],
};

// v2.58.7: safeFloat removed — cost was its ONLY call site and money is
// integer-Rial now (parseIntRial, see stage 6 / D1).

// ═══ v2.58.3 (round 88, finding 1) — SALES TERRITORY on every ticket path ══
// ServiceTicket carries the same row shape as Activity (optional center
// relation + createdById/assignedTo), so the activity territory fragment
// applies verbatim: a scoped expert sees/edits ONLY tickets of their
// territory's centers plus their OWN center-less tickets. Admin / finance /
// production / country-mode users are unaffected (null scope). Every
// composition below APPENDS to where.AND — never overwrites it.
function withTicketTerritory(where: Record<string, unknown>, user: AuthUser): void {
  const t = resolveTerritoryScope(user);
  if (!t) return;
  where.AND = [...(Array.isArray(where.AND) ? (where.AND as unknown[]) : []), activityTerritoryWhere(t, user.id)];
}

/** Fail-closed gate for a center referenced by id on write paths. */
async function centerInUserTerritory(user: AuthUser, centerId: string): Promise<boolean> {
  const center = await db.center.findUnique({ where: { id: centerId }, select: { province: true } });
  if (!center) return false;
  return centerInTerritory({ id: centerId, province: center.province }, resolveTerritoryScope(user));
}

// v2.22.0 — the number used to be `count() + 1`: two concurrent creates
// both read the same count and minted the SAME ticket number, and worse,
// deleting a ticket LOWERED the count so the next create re-issued a
// number that already belonged to a live ticket. Same atomic Meta
// sequence as docseq/shipseq (v2.13.0 pattern) — SQLite serialises the
// UPSERT, so every caller gets a distinct value.
async function nextTicketNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const metaKey = `tktseq.TS.${year}`;

  const rows = await tx.$queryRaw<Array<{ value: string }>>`
    INSERT INTO Meta (key, value, updatedAt) VALUES (${metaKey}, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(CAST(Meta.value AS INTEGER) + 1 AS TEXT),
      updatedAt = datetime('now')
    RETURNING value
  `;
  const seq = Number(rows[0]?.value);
  if (!Number.isFinite(seq) || seq < 1) {
    throw new ApiError(500, 'خطا در تولید شماره تیکت (شمارندهٔ اتمیک).');
  }
  return `TS-${year}-${String(seq).padStart(4, '0')}`;
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
    if (action === 'update') return await handleUpdate(body, user);
    if (action === 'set-status') return await handleSetStatus(body, user);
    if (action === 'resolve') return await handleResolve(body, user);
    if (action === 'warranty-lookup') return await handleWarrantyLookup(body, user);
    if (action === 'stats') return await handleStats(user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('after-sales', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ── 1. LIST ──
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers && !perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده تیکت‌های خدمات را ندارید.' }, { status: 403 });
  }

  const { status, type, priority, warrantyStatus, search, limit = 100 } = body as {
    status?: string;
    type?: string;
    priority?: string;
    warrantyStatus?: string;
    search?: string;
    limit?: number;
  };

  const where: Record<string, unknown> = { businessUnitId: user.businessUnitId };

  // v2.31.2: owner-aware tenant isolation (round-30 leak fix) — center-less
  // tickets are visible only to colleagues of their creator/assignee, not
  // to every user of the business unit. (businessUnitId alone isolates
  // nothing — everyone shares a unit.)
  const ticketScope = await ownerScopedCenterWhere(user);
  if (ticketScope) where.AND = [ticketScope];
  withTicketTerritory(where, user);

  if (status && TICKET_STATUSES.includes(status)) where.status = status;
  if (type && TICKET_TYPES.includes(type)) where.type = type;
  if (priority && TICKET_PRIORITIES.includes(priority)) where.priority = priority;
  if (warrantyStatus && ['in_warranty', 'out_of_warranty'].includes(warrantyStatus)) where.warrantyStatus = warrantyStatus;
  if (search && typeof search === 'string' && search.trim()) {
    const q = search.trim().toLowerCase();
    where.OR = [
      { ticketNumber: { contains: q } },
      { serialNumber: { contains: q } },
      { contactName: { contains: q } },
      { contactPhone: { contains: q } },
      { issue: { contains: q } },
    ];
  }

  const tickets = await db.serviceTicket.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.max(1, Math.min(Number(limit) || 100, 300)),
    include: {
      center: { select: { id: true, name: true, customerType: true, mobile: true, phone: true } },
      _count: { select: { logs: true } },
    },
  });

  return NextResponse.json({ success: true, data: tickets });
}

// ── 2. GET — ticket + logs ──
async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers && !perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده تیکت‌های خدمات را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id?: string };
  if (!id) return NextResponse.json({ error: 'شناسه تیکت الزامی است.' }, { status: 400 });

  const getWhere: Record<string, unknown> = {
    id,
    businessUnitId: user.businessUnitId,
  };
  // v2.31.2: owner-aware tenant isolation on single-ticket reads
  Object.assign(getWhere, await ownerScopedCenterWhere(user));
  // v2.58.3: territory gate on single reads — an out-of-territory ticket
  // reads as not found (404, no existence leak).
  withTicketTerritory(getWhere, user);

  const ticket = await db.serviceTicket.findFirst({
    where: getWhere,
    include: {
      center: { select: { id: true, name: true, customerType: true, mobile: true, phone: true, address: true } },
      logs: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!ticket) return NextResponse.json({ error: 'تیکت یافت نشد.' }, { status: 404 });

  return NextResponse.json({ success: true, data: ticket });
}

// ── 3. CREATE — ثبت تیکت با تشخیص خودکار گارانتی از سریال ──
async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.edit_centers && !perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی ثبت تیکت خدمات را ندارید.' }, { status: 403 });
  }

  const parsed = parseBody(ticketCreateSchema, body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const {
    serialNumber, centerId: parsedCenterId, contactName, contactPhone,
    type, priority, issue, warrantyStatus,
  } = parsed.data;
  const centerId = parsedCenterId ?? undefined;

  let productCode: string | null = null;
  let resolvedCenterId = centerId || null;
  let warrantyUntil: Date | null = null;
  let resolvedWarrantyStatus = 'unknown';

  // Tenant guard: a center explicitly referenced must belong to the caller's
  // company scope (v2.12.0 — previously only the ineffective businessUnitId
  // was checked).
  if (resolvedCenterId) {
    const center = await db.center.findFirst({
      where: { id: resolvedCenterId, ...(centerCompanyWhere(await getAllowedCompanyIds(user)) ?? {}) },
      select: { id: true },
    });
    if (!center) {
      return NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 });
    }
    // v2.58.3: the referenced center must ALSO sit inside the expert's
    // sales territory (fail-closed write).
    if (!(await centerInUserTerritory(user, resolvedCenterId))) {
      return NextResponse.json({ error: 'مرکز موردنظر در محدودهٔ فروش شما نیست.' }, { status: 403 });
    }
  }

  // If a serial is given → auto-resolve product, center and warranty
  if (serialNumber && serialNumber.trim()) {
    const serial = await db.inventorySerial.findUnique({ where: { serialNumber: serialNumber.trim() } });
    if (!serial) {
      return NextResponse.json({ error: 'شماره سریال در انبار یافت نشد.' }, { status: 404 });
    }
    // Tenant guard: serial linked to another company's center is not accessible
    if (serial.centerId) {
      const serialCenter = await db.center.findFirst({
        where: { id: serial.centerId, ...(centerCompanyWhere(await getAllowedCompanyIds(user)) ?? {}) },
        select: { id: true, province: true },
      });
      if (!serialCenter) {
        return NextResponse.json({ error: 'شماره سریال در انبار واحد کسب‌وکار شما یافت نشد.' }, { status: 404 });
      }
      // v2.58.3: a serial bound to an out-of-territory center cannot seed a
      // ticket (the serial's center would leak the other province's data).
      if (!centerInTerritory({ id: serial.centerId, province: serialCenter.province }, resolveTerritoryScope(user))) {
        return NextResponse.json({ error: 'شماره سریال در محدودهٔ فروش شما نیست.' }, { status: 404 });
      }
    }
    productCode = serial.productCode;
    if (serial.centerId) resolvedCenterId = serial.centerId;

    const product = serial.productCode
      ? await db.product.findUnique({ where: { code: serial.productCode } })
      : null;
    const warranty = computeWarranty(serial.soldAt, product?.warrantyMonths ?? 12);
    warrantyUntil = warranty.warrantyUntil;
    resolvedWarrantyStatus = warranty.warrantyStatus;
  }

  // Explicit warranty status overrides auto-detection (e.g. without serial)
  if (warrantyStatus && ['in_warranty', 'out_of_warranty', 'unknown'].includes(warrantyStatus) && !serialNumber) {
    resolvedWarrantyStatus = warrantyStatus;
  }

  // v2.22.0 — create + first log row land in ONE transaction, and the
  // number comes from the atomic sequence INSIDE it. A crash between the
  // two writes used to leave a ticket with no `created` log row. The retry
  // loop absorbs collisions with legacy count-based numbers imported from
  // an old database (sequence restarts at 1; a live TS-…-0003 could exist).
  const created = await db.$transaction(async (tx) => {
    let ticketNumber = '';
    for (let attempt = 0; attempt < 50; attempt++) {
      ticketNumber = await nextTicketNumber(tx);
      const clash = await tx.serviceTicket.findFirst({
        where: { ticketNumber },
        select: { id: true },
      });
      if (!clash) break;
      ticketNumber = ''; // legacy row owns this number — burn one seq and retry
    }
    if (!ticketNumber) {
      throw new ApiError(500, 'تولید شماره تیکت یکتا ممکن نشد. لطفاً دوباره تلاش کنید.');
    }

    const ticket = await tx.serviceTicket.create({
      data: {
        businessUnitId: user.businessUnitId,
        ticketNumber,
        serialNumber: serialNumber?.trim() || null,
        productCode,
        centerId: resolvedCenterId,
        contactName: contactName?.trim() || null,
        contactPhone: contactPhone?.trim() || null,
        type: type && TICKET_TYPES.includes(type) ? type : 'repair',
        priority: priority && TICKET_PRIORITIES.includes(priority) ? priority : 'normal',
        status: 'open',
        warrantyStatus: resolvedWarrantyStatus,
        warrantyUntil,
        issue: issue.trim(),
        createdById: user.id,
      },
    });

    await tx.serviceTicketLog.create({
      data: {
        ticketId: ticket.id,
        action: 'created',
        details: JSON.stringify({ ticketNumber, warrantyStatus: resolvedWarrantyStatus, serialNumber: serialNumber || null }),
        createdByName: user.displayName,
      },
    });
    return { ticket, ticketNumber };
  });

  return NextResponse.json({
    success: true,
    message: `تیکت ${created.ticketNumber} ثبت شد.`,
    data: created.ticket,
  }, { status: 201 });
}

// ── 4. UPDATE — edit fields ──
async function handleUpdate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.edit_centers && !perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش تیکت را ندارید.' }, { status: 403 });
  }

  const { id, type, priority, issue, contactName, contactPhone, cost, assignedTo, expectedVersion } = body as {
    id?: string;
    type?: string;
    priority?: string;
    issue?: string;
    contactName?: string;
    contactPhone?: string;
    cost?: number;
    assignedTo?: string;
    expectedVersion?: number | string | null;
  };
  // v2.58.7 (stage 6 — D1): ServiceTicket.cost is MONEY (Rial) and was the
  // ONLY unguarded money write left (safeFloat silently accepted
  // fractions — 12.5 became 12.5 Rial on a Float column). The integer-Rial
  // invariant (lib/money) now rejects fractional/non-numeric costs with a
  // 400 BEFORE any write — same rule as every other money field.
  if (cost !== undefined) {
    const costValue = parseIntRial(cost);
    if (costValue === null) {
      return NextResponse.json(
        { error: 'هزینهٔ سرویس باید عدد ریالیِ صحیح باشد.' },
        { status: 400 },
      );
    }
  }
  if (!id) return NextResponse.json({ error: 'شناسه تیکت الزامی است.' }, { status: 400 });

  const updWhere: Record<string, unknown> = {
    id,
    businessUnitId: user.businessUnitId,
  };
  // v2.31.2: owner-aware tenant isolation on updates
  Object.assign(updWhere, await ownerScopedCenterWhere(user));
  // v2.58.3: territory gate on updates
  withTicketTerritory(updWhere, user);
  const ticket = await db.serviceTicket.findFirst({ where: updWhere });
  if (!ticket) return NextResponse.json({ error: 'تیکت یافت نشد.' }, { status: 404 });

  const updateData: Record<string, unknown> = { version: { increment: 1 } };
  if (type && TICKET_TYPES.includes(type)) updateData.type = type;
  if (priority && TICKET_PRIORITIES.includes(priority)) updateData.priority = priority;
  if (issue !== undefined && String(issue).trim()) updateData.issue = String(issue).trim();
  if (contactName !== undefined) updateData.contactName = String(contactName).trim() || null;
  if (contactPhone !== undefined) updateData.contactPhone = String(contactPhone).trim() || null;
  if (cost !== undefined) updateData.cost = Math.max(0, parseIntRial(cost) ?? -1);
  if (assignedTo !== undefined) updateData.assignedTo = String(assignedTo).trim() || null;

  // v2.22.0 — the update + its log row land in ONE transaction (a crash
  // between them used to leave silent edits with no audit trail).
  // v2.25.0 — the concurrency token is now the EXACT numeric CAS `version`
  // (supersedes the 1000ms updatedAt tolerance); a missing token answers
  // 428 on this edit path.
  let updated;
  try {
    updated = await db.$transaction(async (tx) => {
      const live = await tx.serviceTicket.findFirst({
        where: updWhere,
        select: { id: true, updatedAt: true, version: true },
      });
      if (!live) throw new ApiError(404, 'تیکت یافت نشد.');

      assertConcurrencyToken({
        expectedVersion: expectedVersion ?? null,
        liveVersion: live.version,
        entityLabel: 'تیکت',
        required: true,
      });

      const row = await tx.serviceTicket.update({ where: { id }, data: updateData });
      await tx.serviceTicketLog.create({
        data: {
          ticketId: id,
          action: 'update',
          details: JSON.stringify({ fields: Object.keys(updateData) }),
          createdByName: user.displayName,
        },
      });
      return row;
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  return NextResponse.json({ success: true, message: 'تیکت به‌روزرسانی شد.', data: updated });
}

// ── 5. SET-STATUS — گردش وضعیت ──
async function handleSetStatus(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.edit_centers && !perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی تغییر وضعیت تیکت را ندارید.' }, { status: 403 });
  }

  const { id, status, note } = body as { id?: string; status?: string; note?: string };
  if (!id || !status || !TICKET_STATUSES.includes(status)) {
    return NextResponse.json({ error: 'شناسه تیکت و وضعیت معتبر الزامی است.' }, { status: 400 });
  }

  const stWhere: Record<string, unknown> = {
    id,
    businessUnitId: user.businessUnitId,
  };
  // v2.31.2: owner-aware tenant isolation on status changes
  Object.assign(stWhere, await ownerScopedCenterWhere(user));
  // v2.58.3: territory gate on status changes
  withTicketTerritory(stWhere, user);
  const ticket = await db.serviceTicket.findFirst({ where: stWhere });
  if (!ticket) return NextResponse.json({ error: 'تیکت یافت نشد.' }, { status: 404 });

  // v2.21.0 — the transition was previously validated against a snapshot
  // read OUTSIDE the write: a double-click sent two `set-status` calls that
  // BOTH passed the same-status check and BOTH appended a log row, and the
  // update + log writes were not atomic. The live row is now re-read INSIDE
  // the transaction, the transition machine is enforced server-side, and
  // the status write + log row land together.
  let updated;
  try {
    updated = await db.$transaction(async (tx) => {
      const live = await tx.serviceTicket.findFirst({ where: stWhere });
      if (!live) throw new ApiError(404, 'تیکت یافت نشد.');

      const from = live.status;
      if (from === status) {
        throw new ApiError(400, 'تیکت از قبل در این وضعیت است.');
      }
      const allowedNext = TICKET_TRANSITIONS[from] ?? [];
      if (!allowedNext.includes(status)) {
        throw new ApiError(
          400,
          `گذار وضعیت تیکت از «${TICKET_STATUS_LABELS[from] || from}» به «${TICKET_STATUS_LABELS[status] || status}» مجاز نیست.`,
        );
      }

      const row = await tx.serviceTicket.update({
        where: { id },
        data: { status, version: { increment: 1 } },
      });
      await tx.serviceTicketLog.create({
        data: {
          ticketId: id,
          action: 'status_changed',
          details: JSON.stringify({ from, to: status, note: note?.trim() || '' }),
          createdByName: user.displayName,
        },
      });
      return row;
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  return NextResponse.json({ success: true, message: 'وضعیت تیکت تغییر کرد.', data: updated });
}

// ── 6. RESOLVE — ثبت اقدام و هزینه ──
async function handleResolve(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.edit_centers && !perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی بستن تیکت را ندارید.' }, { status: 403 });
  }

  const { id, resolution, cost } = body as { id?: string; resolution?: string; cost?: number };
  if (!id) return NextResponse.json({ error: 'شناسه تیکت الزامی است.' }, { status: 400 });
  // v2.58.7 (stage 6 — D1): same integer-Rial invariant as handleUpdate —
  // the resolve path ALSO writes cost (in-tx).
  if (cost !== undefined) {
    const costValue = parseIntRial(cost);
    if (costValue === null) {
      return NextResponse.json(
        { error: 'هزینهٔ سرویس باید عدد ریالیِ صحیح باشد.' },
        { status: 400 },
      );
    }
  }

  const resWhere: Record<string, unknown> = {
    id,
    businessUnitId: user.businessUnitId,
  };
  // v2.31.2: owner-aware tenant isolation on resolve
  Object.assign(resWhere, await ownerScopedCenterWhere(user));
  // v2.58.3: territory gate on resolve
  withTicketTerritory(resWhere, user);
  const ticket = await db.serviceTicket.findFirst({ where: resWhere });
  if (!ticket) return NextResponse.json({ error: 'تیکت یافت نشد.' }, { status: 404 });

  // v2.21.0 — `resolve` used to force status='resolved' from ANY state: a
  // closed or rejected ticket could be silently "resolved" (bypassing the
  // transition machine). Per the lifecycle, `resolved` is only reachable
  // from in_progress / waiting_parts. The guard runs on the LIVE row inside
  // the transaction and the write lands atomically with its log row.
  let updated;
  try {
    updated = await db.$transaction(async (tx) => {
      const live = await tx.serviceTicket.findFirst({ where: resWhere });
      if (!live) throw new ApiError(404, 'تیکت یافت نشد.');

      if (live.status !== 'in_progress' && live.status !== 'waiting_parts') {
        throw new ApiError(
          400,
          `تیکت در وضعیت «${TICKET_STATUS_LABELS[live.status] || live.status}» قابل حل‌شدن نیست. فقط تیکت در حال انجام یا در انتظار قطعه قابل حل است.`,
        );
      }

      const row = await tx.serviceTicket.update({
        where: { id },
        data: {
          resolution: resolution?.trim() || live.resolution,
          cost: cost !== undefined ? Math.max(0, parseIntRial(cost) ?? live.cost) : live.cost,
          status: 'resolved',
          version: { increment: 1 },
        },
      });
      await tx.serviceTicketLog.create({
        data: {
          ticketId: id,
          action: 'resolved',
          details: JSON.stringify({ resolution: resolution?.trim() || '', cost: cost !== undefined ? Math.max(0, parseIntRial(cost) ?? live.cost) : live.cost }),
          createdByName: user.displayName,
        },
      });
      return row;
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  return NextResponse.json({ success: true, message: 'تیکت حل شد.', data: updated });
}

// ── 7. WARRANTY-LOOKUP — استعلام گارانتی با شماره سریال ──
async function handleWarrantyLookup(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers && !perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی استعلام گارانتی را ندارید.' }, { status: 403 });
  }

  const { serialNumber } = body as { serialNumber?: string };
  if (!serialNumber?.trim()) {
    return NextResponse.json({ error: 'شماره سریال الزامی است.' }, { status: 400 });
  }

  const serial = await db.inventorySerial.findUnique({
    where: { serialNumber: serialNumber.trim() },
  });
  if (!serial) {
    return NextResponse.json({ error: 'شماره سریال در انبار یافت نشد.' }, { status: 404 });
  }

  // Resolve center manually + tenant guard (v2.12.0: company scope instead
  // of the ineffective businessUnitId filter)
  const serialCenter = serial.centerId
    ? await db.center.findFirst({
        where: { id: serial.centerId, ...(centerCompanyWhere(await getAllowedCompanyIds(user)) ?? {}) },
        select: { id: true, name: true, customerType: true, mobile: true, phone: true, province: true },
      })
    : null;
  if (serial.centerId && !serialCenter) {
    return NextResponse.json({ error: 'شماره سریال در انبار واحد کسب‌وکار شما یافت نشد.' }, { status: 404 });
  }
  // v2.58.3: warranty data of an out-of-territory center is not readable —
  // 404 (no existence leak), same discipline as the centers route.
  if (serialCenter && !centerInTerritory({ id: serialCenter.id, province: serialCenter.province }, resolveTerritoryScope(user))) {
    return NextResponse.json({ error: 'شماره سریال در محدودهٔ فروش شما نیست.' }, { status: 404 });
  }

  const product = serial.productCode
    ? await db.product.findUnique({ where: { code: serial.productCode } })
    : null;

  const warranty = computeWarranty(serial.soldAt, product?.warrantyMonths ?? 12);

  const histWhere: Record<string, unknown> = {
    serialNumber: serial.serialNumber,
    businessUnitId: user.businessUnitId,
    // v2.31.2: owner-aware tenant isolation on the ticket history of the serial
    ...((await ownerScopedCenterWhere(user)) ?? {}),
  };
  // v2.58.3: the serial's ticket history applies the SAME territory
  // visibility as the list — an out-of-territory serial's history is empty.
  withTicketTerritory(histWhere, user);
  const tickets = await db.serviceTicket.findMany({
    where: histWhere,
    orderBy: { createdAt: 'desc' },
    select: { id: true, ticketNumber: true, type: true, status: true, createdAt: true, cost: true },
  });

  const daysLeft = warranty.warrantyUntil
    ? Math.ceil((warranty.warrantyUntil.getTime() - Date.now()) / 86400000)
    : null;

  return NextResponse.json({
    success: true,
    data: {
      serial: {
        serialNumber: serial.serialNumber,
        productCode: serial.productCode,
        status: serial.status,
        soldAt: serial.soldAt,
        center: serialCenter,
      },
      product: product ? { code: product.code, name: product.name, warrantyMonths: product.warrantyMonths, price: product.price } : null,
      warranty: {
        status: warranty.warrantyStatus,
        until: warranty.warrantyUntil,
        daysLeft,
      },
      ticketHistory: tickets,
      ticketCount: tickets.length,
    },
  });
}

// ── 8. STATS ──
async function handleStats(user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers && !perms.production_unit) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده آمار خدمات را ندارید.' }, { status: 403 });
  }

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  // v2.31.2: owner-aware tenant isolation — every stat is scoped to the
  // user's companies AND colleagues
  const buScope: Record<string, unknown> = { businessUnitId: user.businessUnitId };
  Object.assign(buScope, await ownerScopedCenterWhere(user));
  // v2.58.3: stats respect the sales territory too
  withTicketTerritory(buScope, user);

  const [open, inProgress, waitingParts, resolvedThisMonth, inWarranty, outOfWarranty, totalCostThisMonth] = await Promise.all([
    db.serviceTicket.count({ where: { ...buScope, status: 'open' } }),
    db.serviceTicket.count({ where: { ...buScope, status: 'in_progress' } }),
    db.serviceTicket.count({ where: { ...buScope, status: 'waiting_parts' } }),
    db.serviceTicket.count({ where: { ...buScope, status: 'resolved', updatedAt: { gte: startOfMonth } } }),
    db.serviceTicket.count({ where: { ...buScope, warrantyStatus: 'in_warranty', status: { in: ['open', 'in_progress', 'waiting_parts'] } } }),
    db.serviceTicket.count({ where: { ...buScope, warrantyStatus: 'out_of_warranty', status: { in: ['open', 'in_progress', 'waiting_parts'] } } }),
    db.serviceTicket.aggregate({
      where: { ...buScope, status: 'resolved', updatedAt: { gte: startOfMonth } },
      _sum: { cost: true },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      open,
      inProgress,
      waitingParts,
      resolvedThisMonth,
      inWarranty,
      outOfWarranty,
      totalCostThisMonth: totalCostThisMonth._sum.cost || 0,
    },
  });
}
