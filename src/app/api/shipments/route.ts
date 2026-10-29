import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { ApiError } from '@/lib/api-error';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import {
  getAllowedCompanyIds,
  COMPANY_ACCESS_DENIED,
} from '@/lib/company-scope';
import { resolveTerritoryScope, centerInTerritory } from '@/lib/territory-scope';
import {
  isShipmentStatus,
  canTransition,
  ShipmentStatus,
  SHIPMENT_STATUS_INFO,
} from '@/lib/shipment-status';
// v2.39.0 (round 65) — auto-issued dispatch document (سند ارسال مراسلات)
// + shared atomic shipment numbering; buyer identity resolution for the
// label payload reuses the pure sales-docs-shared helper.
// v2.46.0 (round 71) — carton-label serials (شماره سریال) issued per
// printed carton: action 'issue-label-serials' + rows in 'label'.
import { autoIssueDispatch, generateShipmentNumber, issueCartonLabels, type CartonLabelRow } from '@/lib/dispatch-issue';
import { resolveBuyerIdentity } from '@/components/sales-docs-shared';

// ════════════════════════════════════════════════════════════
//  Shipments (ارسال بار) — v2.17.0
//
//  A shipment is the REAL dispatch record for an approved sales
//  document. Until this route existed the pipeline's «ارسال بار»
//  column was honestly empty (v2.16.0) because no send was ever
//  persisted anywhere. Registering / advancing a shipment here is
//  what moves a document into — and eventually out of — that column.
//
//  Tenant isolation (v2.12.0 rules):
//   • reads outside the user's companies → 404 (or filtered out of list)
//   • referencing a document outside the scope on create → 403
//   • admins are unrestricted
// ════════════════════════════════════════════════════════════

const SHIPMENT_SELECT = {
  id: true,
  shipmentNumber: true,
  salesDocumentId: true,
  status: true,
  carrierName: true,
  trackingCode: true,
  itemsSummary: true,
  weight: true,
  notes: true,
  dispatchedAt: true,
  deliveredAt: true,
  createdAt: true,
  updatedAt: true,
  creator: { select: { id: true, displayName: true } },
  salesDocument: {
    select: {
      id: true,
      documentNumber: true,
      documentType: true,
      status: true,
      finalAmount: true,
      centerId: true,
      center: { select: { id: true, name: true, city: true, province: true, companyId: true } },
    },
  },
} satisfies Prisma.SalesShipmentSelect;

function canRead(perms: ReturnType<typeof getRolePermissions>): boolean {
  // Anyone who can see the pipeline, the production workspace or the
  // documents themselves may read shipments.
  return perms.production_unit || perms.view_centers || perms.view_other_sales_documents;
}

function canWrite(perms: ReturnType<typeof getRolePermissions>): boolean {
  // Warehouse/production registers sends; sales experts (edit_centers)
  // can register one straight from the pipeline card. Finance: read-only.
  return perms.production_unit || perms.edit_centers;
}

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
    if (action === 'update') return await handleUpdate(body, user);
    if (action === 'update-status') return await handleUpdateStatus(body, user);
    if (action === 'delete') return await handleDelete(body, user);
    // v2.39.0 — carton-label payload (سند ارسال مراسلات) for an issued
    // invoice: idempotent, backfills the auto dispatch row for legacy
    // invoices that were approved before this round.
    if (action === 'label') return await handleLabel(body, user);
    // v2.46.0 — issue carton-label serials (شماره سریال) for the print run
    if (action === 'issue-label-serials') return await handleIssueLabelSerials(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('shipments', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

/** Company-scope fragment on the shipment's owning document. */
function docScopeWhere(allowedIds: string[] | null) {
  if (allowedIds === null) return undefined;
  return {
    salesDocument: {
      OR: [
        { centerId: null },
        { center: { companyId: { in: allowedIds } } },
      ],
    },
  };
}

// ═══ v2.58.3 (round 88, finding 1) — SALES TERRITORY on shipments ══
// A scoped expert only sees and touches shipments of documents whose
// CENTER sits inside their sales territory. Centerless documents carry
// no geographic data and stay visible inside the company scope.
// Admin / finance / production / country-mode: unaffected.
function docTerritoryWhereFragment(t: ReturnType<typeof resolveTerritoryScope>): Record<string, unknown> {
  if (t === null || t === undefined) return {};
  if (t.mode === 'none') return { salesDocument: { centerId: null } };
  if (t.mode === 'provinces') {
    return { salesDocument: { OR: [{ centerId: null }, { center: { province: { in: t.provinces } } }] } };
  }
  return { salesDocument: { OR: [{ centerId: null }, { centerId: { in: t.centerIds } }] } };
}

// ════════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════════
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!canRead(perms)) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده ارسال‌ها را ندارید.' }, { status: 403 });
  }

  const {
    status,
    documentId,
    search = '',
    page = 1,
    pageSize = 20,
  } = body as {
    status?: string;
    documentId?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  };

  const p = Math.max(1, Math.min(Number(page) || 1, 500));
  const ps = Math.max(1, Math.min(Number(pageSize) || 20, 100));
  const skip = (p - 1) * ps;

  const allowedIds = await getAllowedCompanyIds(user);

  const where: Record<string, unknown> = {
    salesDocument: { businessUnitId: user.businessUnitId },
    ...docScopeWhere(allowedIds),
  };
  // v2.58.3 — territory narrows the list (composed with company scope).
  const territoryFragment = docTerritoryWhereFragment(resolveTerritoryScope(user));
  if (Object.keys(territoryFragment).length > 0) {
    where.AND = [territoryFragment];
  }
  if (status && isShipmentStatus(status)) where.status = status;
  if (documentId && typeof documentId === 'string') where.salesDocumentId = documentId;
  if (search && typeof search === 'string' && search.trim()) {
    const q = search.trim();
    where.OR = [
      { shipmentNumber: { contains: q } },
      { carrierName: { contains: q } },
      { trackingCode: { contains: q } },
      { salesDocument: { documentNumber: { contains: q } } },
      { salesDocument: { center: { name: { contains: q } } } },
    ];
  }

  const [items, total] = await Promise.all([
    db.salesShipment.findMany({
      where,
      select: SHIPMENT_SELECT,
      orderBy: { createdAt: 'desc' },
      skip,
      take: ps,
    }),
    db.salesShipment.count({ where }),
  ]);

  return NextResponse.json({
    success: true,
    data: items,
    total,
    page: p,
    pageSize: ps,
    totalPages: Math.ceil(total / ps),
    pagination: {
      page: p,
      pageSize: ps,
      total,
      totalPages: Math.ceil(total / ps),
      hasNext: p < Math.ceil(total / ps),
      hasPrev: p > 1,
    },
  });
}

// ════════════════════════════════════════════════════════════
//  GET
// ════════════════════════════════════════════════════════════
async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!canRead(perms)) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده ارسال‌ها را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id?: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه ارسال الزامی است.' }, { status: 400 });
  }

  const shipment = await findShipmentOrThrow(id, user);
  return NextResponse.json({
    item: shipment,
    statusLabel: SHIPMENT_STATUS_INFO[shipment.status as ShipmentStatus]?.label || shipment.status,
  });
}

// ════════════════════════════════════════════════════════════
//  CREATE
// ════════════════════════════════════════════════════════════
async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!canWrite(perms)) {
    return NextResponse.json({ error: 'شما دسترسی ثبت ارسال را ندارید.' }, { status: 403 });
  }

  const {
    salesDocumentId,
    carrierName = '',
    trackingCode = '',
    itemsSummary = '',
    weight = '',
    notes = '',
    status = 'preparing',
  } = body as {
    salesDocumentId?: string;
    carrierName?: string;
    trackingCode?: string;
    itemsSummary?: string;
    weight?: string;
    notes?: string;
    status?: string;
  };

  if (!salesDocumentId) {
    return NextResponse.json({ error: 'انتخاب سند فروش الزامی است.' }, { status: 400 });
  }
  if (!isShipmentStatus(status) || status === 'delivered' || status === 'returned') {
    // A brand-new send starts at the beginning of the flow; delivery and
    // returns are reached through update-status transitions.
    return NextResponse.json(
      { error: 'وضعیت اولیهٔ ارسال معتبر نیست (preparing / ready / in-transit).' },
      { status: 400 },
    );
  }
  for (const [field, value] of [
    ['نام حمل‌کننده', carrierName],
    ['کد رهگیری', trackingCode],
    ['اقلام', itemsSummary],
    ['وزن', weight],
    ['توضیحات', notes],
  ] as const) {
    if (typeof value !== 'string' || value.length > 500) {
      return NextResponse.json({ error: `${field} نامعتبر است.` }, { status: 400 });
    }
  }

  // ── Document checks: same BU, shippable status, inside company scope ──
  const doc = await db.salesDocument.findFirst({
    where: { id: salesDocumentId, businessUnitId: user.businessUnitId },
    select: {
      id: true,
      status: true,
      documentType: true,
      documentNumber: true,
      centerId: true,
      center: { select: { companyId: true, province: true } },
    },
  });
  if (!doc) {
    throw new ApiError(404, 'سند فروش یافت نشد.');
  }
  // v2.12.0 rule: creating a row that references company data outside the
  // user's scope is a 403.
  if (doc.centerId && doc.center?.companyId) {
    const allowedIds = await getAllowedCompanyIds(user);
    if (allowedIds !== null && !allowedIds.includes(doc.center.companyId)) {
      return NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 });
    }
  }
  // v2.58.3 — a scoped expert ships documents whose center is inside
  // their sales territory (fail-closed write).
  if (doc.centerId && !centerInTerritory(
    { id: doc.centerId, province: doc.center?.province ?? null },
    resolveTerritoryScope(user),
  )) {
    return NextResponse.json(
      { error: 'مرکز سند موردنظر در محدودهٔ فروش شما نیست.' },
      { status: 403 },
    );
  }
  if (doc.documentType === 'return') {
    return NextResponse.json(
      { error: 'برای اسناد برگشت از فروش نمی‌توان ارسال ثبت کرد.' },
      { status: 400 },
    );
  }
  if (doc.status !== 'approved') {
    return NextResponse.json(
      { error: 'فقط اسناد تأییدشده (فاکتورشده) قابل ارسال هستند.' },
      { status: 400 },
    );
  }

  // Numbering + insert in one transaction; the counter is the same atomic
  // INSERT … ON CONFLICT pattern the sales documents use (v2.13.0).
  const shipment = await db.$transaction(
    async (tx) => {
      const created = await tx.salesShipment.create({
        data: {
          shipmentNumber: await generateShipmentNumber(tx),
          salesDocumentId: doc.id,
          status,
          carrierName: (carrierName || '').trim(),
          trackingCode: (trackingCode || '').trim(),
          itemsSummary: (itemsSummary || '').trim(),
          weight: (weight || '').trim(),
          notes: (notes || '').trim(),
          dispatchedAt: status === 'in-transit' ? new Date() : null,
          createdById: user.id,
        },
        select: SHIPMENT_SELECT,
      });
      await tx.salesDocumentLog.create({
        data: {
          salesDocumentId: doc.id,
          userId: user.id,
          action: 'shipment-created',
          details: JSON.stringify({
            shipmentId: created.id,
            shipmentNumber: created.shipmentNumber,
            status,
          }),
        },
      });
      // v2.45.0 — a REAL send is the authoritative dispatch event: any
      // manual drag & drop pin is cleared so the card lands in «ارسال بار»
      // on live data (the pin would otherwise fight the shipment).
      await tx.salesDocument.update({
        where: { id: doc.id },
        data: { pipelineStage: null },
      });
      return created;
    },
    { timeout: 20_000, maxWait: 5_000 },
  );

  return NextResponse.json(
    { message: 'ارسال با موفقیت ثبت شد.', item: shipment },
    { status: 201 },
  );
}

// ════════════════════════════════════════════════════════════
//  UPDATE (details only — carrier / tracking / items / notes)
// ════════════════════════════════════════════════════════════
async function handleUpdate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!canWrite(perms)) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش ارسال را ندارید.' }, { status: 403 });
  }

  const { id, carrierName, trackingCode, itemsSummary, weight, notes } = body as {
    id?: string;
    carrierName?: string;
    trackingCode?: string;
    itemsSummary?: string;
    weight?: string;
    notes?: string;
  };
  if (!id) {
    return NextResponse.json({ error: 'شناسه ارسال الزامی است.' }, { status: 400 });
  }

  const existing = await findShipmentOrThrow(id, user);
  if (existing.status === 'delivered' || existing.status === 'returned') {
    return NextResponse.json(
      { error: 'ارسال تحویل‌شده یا برگشتی دیگر قابل ویرایش نیست.' },
      { status: 400 },
    );
  }

  const data: Record<string, string> = {};
  for (const [key, value] of [
    ['carrierName', carrierName],
    ['trackingCode', trackingCode],
    ['itemsSummary', itemsSummary],
    ['weight', weight],
    ['notes', notes],
  ] as const) {
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length > 500) {
        return NextResponse.json({ error: 'مقدار فیلد نامعتبر است.' }, { status: 400 });
      }
      data[key] = value.trim();
    }
  }

  const item = await db.salesShipment.update({
    where: { id },
    data,
    select: SHIPMENT_SELECT,
  });
  return NextResponse.json({ message: 'اطلاعات ارسال به‌روزرسانی شد.', item });
}

// ════════════════════════════════════════════════════════════
//  UPDATE STATUS — the documented transition graph
// ════════════════════════════════════════════════════════════
async function handleUpdateStatus(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!canWrite(perms)) {
    return NextResponse.json({ error: 'شما دسترسی تغییر وضعیت ارسال را ندارید.' }, { status: 403 });
  }

  const { id, status } = body as { id?: string; status?: string };
  if (!id || !status) {
    return NextResponse.json({ error: 'شناسه ارسال و وضعیت جدید الزامی است.' }, { status: 400 });
  }
  if (!isShipmentStatus(status)) {
    return NextResponse.json(
      { error: 'وضعیت نامعتبر است. مقادیر مجاز: preparing, ready, in-transit, delivered, returned' },
      { status: 400 },
    );
  }

  // Fast-path scope/404 gate (the authoritative re-check happens in-tx below).
  await findShipmentOrThrow(id, user);
  const to = status as ShipmentStatus;

  // v2.21.0 — the transition used to be validated against a snapshot read
  // OUTSIDE the write. Two concurrent transitions (e.g. `delivered` vs
  // `returned`, both from `in-transit`) BOTH passed `canTransition`, both
  // wrote, and both appended a document-log row: the parcel ended in
  // whichever state wrote last while its trail claimed BOTH a delivery and
  // a return — and the shipment report counts both. The live row is now
  // re-read INSIDE the transaction (SQLite serialises writers); exactly one
  // concurrent writer wins, the latecomer receives a clean 400, and the
  // status write + document-log row land atomically.
  // NOTE: company scope is resolved BEFORE the transaction — querying the
  // global client inside a tx deadlocks the single SQLite connection (the
  // same trap the v2.20.0 document-update handler hit with getVatRate).
  const allowedCompanyIds = await getAllowedCompanyIds(user);
  let item;
  try {
    item = await db.$transaction(async (tx) => {
      const live = await tx.salesShipment.findFirst({
        where: {
          id,
          salesDocument: { businessUnitId: user.businessUnitId },
        },
        select: { ...SHIPMENT_SELECT, dispatchedAt: true },
      });
      if (!live) throw new ApiError(404, 'ارسال یافت نشد.');
      if (live.salesDocument.centerId) {
        const companyId = live.salesDocument?.center?.companyId;
        if (allowedCompanyIds !== null && companyId && !allowedCompanyIds.includes(companyId)) {
          throw new ApiError(404, 'ارسال یافت نشد.');
        }
      }

      const from = live.status as ShipmentStatus;
      if (from === to) {
        throw new ApiError(400, 'ارسال از قبل در این وضعیت است.');
      }
      if (!canTransition(from, to)) {
        throw new ApiError(
          400,
          `گذار وضعیت «${SHIPMENT_STATUS_INFO[from].label}» به «${SHIPMENT_STATUS_INFO[to].label}» مجاز نیست.`,
        );
      }

      const data: Record<string, unknown> = { status: to };
      if (to === 'in-transit' && !live.dispatchedAt) data.dispatchedAt = new Date();
      if (to === 'delivered') {
        data.deliveredAt = new Date();
        if (!live.dispatchedAt) data.dispatchedAt = new Date();
      }

      const updated = await tx.salesShipment.update({ where: { id }, data, select: SHIPMENT_SELECT });
      await tx.salesDocumentLog.create({
        data: {
          salesDocumentId: live.salesDocumentId,
          userId: user.id,
          action: 'shipment-status',
          details: JSON.stringify({ shipmentId: id, from, to }),
        },
      });
      // v2.45.0 — a returned parcel un-ships the document: clear any
      // manual pin so the board honestly follows the live shipment state.
      if (to === 'returned') {
        await tx.salesDocument.update({
          where: { id: live.salesDocumentId },
          data: { pipelineStage: null },
        });
      }
      return updated;
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  return NextResponse.json({
    message: 'وضعیت ارسال با موفقیت تغییر کرد.',
    item,
    statusLabel: SHIPMENT_STATUS_INFO[to].label,
  });
}

// ════════════════════════════════════════════════════════════
//  DELETE — only while the parcel has not been delivered
// ════════════════════════════════════════════════════════════
async function handleDelete(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!canWrite(perms)) {
    return NextResponse.json({ error: 'شما دسترسی حذف ارسال را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id?: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه ارسال الزامی است.' }, { status: 400 });
  }

  const existing = await findShipmentOrThrow(id, user);
  if (existing.status === 'delivered') {
    return NextResponse.json(
      { error: 'ارسال تحویل‌شده قابل حذف نیست — سابقهٔ تحویل باید بماند.' },
      { status: 400 },
    );
  }

  await db.salesDocumentLog.create({
    data: {
      salesDocumentId: existing.salesDocumentId,
      userId: user.id,
      action: 'shipment-deleted',
      details: JSON.stringify({ shipmentId: id, status: existing.status }),
    },
  });
  await db.salesShipment.delete({ where: { id } });
  // v2.45.0 — the send is gone; a manual pin would strand the card in
  // «ارسال بار» with no shipment behind it. Clear it → derived stage.
  await db.salesDocument.update({
    where: { id: existing.salesDocumentId },
    data: { pipelineStage: null },
  });

  return NextResponse.json({ message: 'ارسال حذف شد.' });
}

// ════════════════════════════════════════════════════════════
//  LABEL — v2.39.0 (round 65) carton-label payload for an issued
//  invoice (سند ارسال مراسلات — «برچسب مرسولات» that sticks on the
//  cartons). Idempotent: returns the document's LATEST dispatch row
//  and, when none exists yet (legacy invoices approved before this
//  round), auto-issues one first — so EVERY issued invoice can
//  print its label, not just post-v2.39.0 ones.
// ════════════════════════════════════════════════════════════
/** Label document + checks shared by 'label' and 'issue-label-serials'
 *  (v2.46.0 — extracted verbatim from handleLabel so both actions run
 *  the SAME gates: BU, company scope, not a return, invoice issued). */
async function loadLabelDocOrThrow(salesDocumentId: string, user: AuthUser) {
  if (!salesDocumentId || typeof salesDocumentId !== 'string') {
    return { bad: NextResponse.json({ error: 'شناسه فاکتور الزامی است.' }, { status: 400 }) } as const;
  }
  // v2.58.7 (A5): 'label' and 'issue-label-serials' were the only shipment
  // WRITE paths without the territory dimension (findShipmentOrThrow and
  // every list/update path compose docTerritoryWhereFragment). The label
  // actions backfill a dispatch row + issue carton serials — they must
  // obey the same geography rule (scoped expert: centerless or
  // in-territory documents only, fail-closed 404 no-leak).
  // (The fragment's inner shape — {centerId: null} / {OR: [...]} — is what
  // a SalesDocument where needs; the outer {salesDocument: …} wrapper is
  // for the shipment queries.)
  const labelTerritoryInner = (docTerritoryWhereFragment(resolveTerritoryScope(user)) as {
    salesDocument?: Record<string, unknown>;
  }).salesDocument;
  const doc = await db.salesDocument.findFirst({
    where: {
      id: salesDocumentId,
      businessUnitId: user.businessUnitId,
      ...(labelTerritoryInner ?? {}),
    },
    select: {
      id: true,
      documentNumber: true,
      documentType: true,
      status: true,
      issuedAt: true,
      createdAt: true,
      paymentTerms: true,
      salesExpertName: true,
      salesExpertMobile: true,
      buyerSnapshot: true,
      centerId: true,
      center: {
        select: {
          id: true, name: true, address: true, city: true, province: true,
          contactName: true, phone: true, mobile: true, postalCode: true,
          companyId: true,
        },
      },
      company: {
        select: { name: true, logo: true, tagline: true, address: true, phone: true },
      },
      items: {
        orderBy: { createdAt: 'asc' },
        select: { productName: true, quantity: true, unit: true },
      },
    },
  });
  if (!doc) {
    throw new ApiError(404, 'فاکتور یافت نشد.');
  }
  if (doc.centerId && doc.center?.companyId) {
    const allowedIds = await getAllowedCompanyIds(user);
    if (allowedIds !== null && !allowedIds.includes(doc.center.companyId)) {
      throw new ApiError(404, 'فاکتور یافت نشد.');
    }
  }
  if (doc.documentType === 'return') {
    throw new ApiError(400, 'برای برگشت از فروش سند ارسال صادر نمی‌شود.');
  }
  if (doc.status !== 'approved') {
    throw new ApiError(400, 'برچسب ارسال فقط برای فاکتور صادرشده قابل دریافت است.');
  }
  return { doc } as const;
}

/** Latest dispatch row for an issued invoice; backfills an auto one for
 *  legacy invoices approved before v2.39.0 (idempotent, shared by both
 *  label actions since v2.46.0). */
async function findOrBackfillShipment(
  doc: { id: string; documentNumber: string | null },
  user: AuthUser,
  items: Array<{ productName: string | null; quantity: number | null }>,
) {
  const shipment = await db.salesShipment.findFirst({
    where: { salesDocumentId: doc.id },
    orderBy: { createdAt: 'desc' },
    select: SHIPMENT_SELECT,
  });
  if (shipment) return shipment;
  const created = await db.$transaction(
    async (tx) =>
      autoIssueDispatch(
        tx,
        { id: doc.id, documentNumber: doc.documentNumber },
        user.id,
        items,
      ),
    { timeout: 20_000, maxWait: 5_000 },
  );
  return db.salesShipment.findUniqueOrThrow({
    where: { id: created.id },
    select: SHIPMENT_SELECT,
  });
}

/** v2.46.0 — carton-label rows of a shipment (ordered for printing). */
async function loadCartonLabels(shipmentId: string): Promise<CartonLabelRow[]> {
  return db.cartonLabel.findMany({
    where: { shipmentId },
    orderBy: { cartonIndex: 'asc' },
    select: { id: true, serial: true, cartonIndex: true, cartonTotal: true },
  });
}

async function handleLabel(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  // Printers of the label: anyone who may read shipments (pipeline /
  // production / documents) or register one (sales experts).
  if (!canRead(perms) && !canWrite(perms)) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده سند ارسال را ندارید.' }, { status: 403 });
  }

  const { salesDocumentId } = body as { salesDocumentId?: string };
  const gate = await loadLabelDocOrThrow(salesDocumentId ?? '', user);
  if ('bad' in gate) return gate.bad;
  const doc = gate.doc;

  // ── Latest dispatch row; backfill an auto one for legacy invoices ──
  const shipment = await findOrBackfillShipment(doc, user, doc.items);

  // v2.46.0 — already-issued carton serials ride along so the dialog can
  // show (and re-print) them without a second round-trip.
  const cartonLabels = await loadCartonLabels(shipment.id);

  // ── Buyer identity: creation-time snapshot first (legal semantics),
  //     live center master data as the fallback (same rule as the A4
  //     invoice print) ──
  const buyer = resolveBuyerIdentity(doc.buyerSnapshot, {
    name: doc.center?.name,
    address: doc.center?.address,
    city: doc.center?.city,
    province: doc.center?.province,
    phone: doc.center?.phone || doc.center?.mobile,
    postalCode: doc.center?.postalCode,
    contactName: doc.center?.contactName,
  });

  return NextResponse.json({
    success: true,
    data: {
      shipment,
      cartonLabels,
      document: {
        id: doc.id,
        documentNumber: doc.documentNumber,
        documentType: doc.documentType,
        issuedAt: doc.issuedAt,
        createdAt: doc.createdAt,
        paymentTerms: doc.paymentTerms,
        salesExpertName: doc.salesExpertName,
        salesExpertMobile: doc.salesExpertMobile,
        itemCount: doc.items.length,
      },
      items: doc.items,
      buyer,
      company: doc.company,
    },
  });
}

/**
 * v2.46.0 (round 71) — «شماره سریال هم صادر شود»: issue (or re-use) the
 * carton-label serials of an issued invoice's dispatch. Append-only and
 * idempotent — see lib/dispatch-issue.issueCartonLabels. Every print run
 * passes through here first so a printed sheet ALWAYS carries a serial.
 */
async function handleIssueLabelSerials(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  // Same gate as 'label' — the desk that may print may issue serials.
  if (!canRead(perms) && !canWrite(perms)) {
    return NextResponse.json({ error: 'شما دسترسی صدور شماره سریال برچسب را ندارید.' }, { status: 403 });
  }

  const { salesDocumentId, cartonCount } = body as {
    salesDocumentId?: string;
    cartonCount?: unknown;
  };
  const count = Number(cartonCount);
  if (!Number.isInteger(count) || count < 1 || count > 99) {
    return NextResponse.json(
      { error: 'تعداد کارتون باید عددی بین ۱ تا ۹۹ باشد.' },
      { status: 400 },
    );
  }

  const gate = await loadLabelDocOrThrow(salesDocumentId ?? '', user);
  if ('bad' in gate) return gate.bad;
  const doc = gate.doc;

  const shipment = await findOrBackfillShipment(doc, user, doc.items);

  const cartonLabels = await db.$transaction(
    async (tx) => {
      const rows = await issueCartonLabels(tx, {
        shipmentId: shipment.id,
        salesDocumentId: doc.id,
        cartonCount: count,
        userId: user.id,
      });
      await tx.salesDocumentLog.create({
        data: {
          salesDocumentId: doc.id,
          userId: user.id,
          action: 'label-serials-issued',
          details: JSON.stringify({
            shipmentId: shipment.id,
            requested: count,
            issued: rows.map((r) => ({ serial: r.serial, carton: `${r.cartonIndex}/${r.cartonTotal}` })),
          }),
        },
      });
      return rows;
    },
    { timeout: 20_000, maxWait: 5_000 },
  );

  return NextResponse.json({ success: true, data: { cartonLabels } });
}

// ════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════

/** Fetch + scope-gate a shipment. Out-of-scope reads are a 404 (v2.12.0). */
async function findShipmentOrThrow(id: string, user: AuthUser) {
  const territoryFragment = docTerritoryWhereFragment(resolveTerritoryScope(user));
  const shipment = await db.salesShipment.findFirst({
    where: {
      id,
      salesDocument: { businessUnitId: user.businessUnitId },
      ...(Object.keys(territoryFragment).length > 0 ? { AND: [territoryFragment] } : {}),
    },
    select: SHIPMENT_SELECT,
  });
  if (!shipment) {
    throw new ApiError(404, 'ارسال یافت نشد.');
  }
  if (shipment.salesDocument.centerId) {
    const allowedIds = await getAllowedCompanyIds(user);
    const companyId = shipment.salesDocument.center?.companyId;
    if (allowedIds !== null && companyId && !allowedIds.includes(companyId)) {
      throw new ApiError(404, 'ارسال یافت نشد.');
    }
  }
  return shipment;
}

/** Atomic sequential shipment number: SHP-YYMMDD-NNNN — v2.39.0: moved to
 *  src/lib/dispatch-issue.ts (shared with the sales-documents auto-issue
 *  paths so BOTH routes race the same Meta counter row). */

