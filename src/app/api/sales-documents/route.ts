import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, type AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { resolveScopedCompanyId, getAllowedCompanyIds, optionalCompanyCenterWhere, assertCompanyAccess, COMPANY_ACCESS_DENIED } from '@/lib/company-scope';
import { centerInTerritory, docOwnershipTerritoryWhere, resolveTerritoryScope, TerritoryScope } from '@/lib/territory-scope';
// v2.58.7 — the central policy layer (stage 1): the territory dimension
// this route enforces is also importable from one authoritative module.
import { assertTerritoryAccess } from '@/lib/access-policy';
import { validateSalesItems, computeSalesTotals, assertApplyVatBoolean, type SalesTotals } from '@/lib/sales-totals';
import { assertConcurrencyToken } from '@/lib/concurrency';
import {
  issueInvoiceForDocument,
  syncPaymentToLinkedInvoice,
  revertDocumentEffects,
  recalcCenterAccount,
  runInTransaction,
} from '@/lib/finance-sync';
import { ApiError, apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
// v2.58.4 (external audit F03/F04) — the shared payment mutation service:
// strict validation + in-transaction log + idempotency for add-payment.
import { parseAddPaymentBody, addSalesDocumentPayment } from '@/lib/cartable-payments';
import { normalizePersian } from '@/lib/center-search';
// v2.45.0 — drag & drop stage pinning (کاریز فروش): shared contract for
// the move-stage action (valid keys, labels, pin clearing on workflow events).
import {
  isPinnableStage,
  PIPELINE_STAGE_LABELS,
  type PipelineStageKey,
} from '@/lib/pipeline-stage-override';
// v2.38.0 — buyer-identity learning pure helpers (shared with the client
// forms; the module has zero client-only imports).
import { parseBuyerSnapshot, buyerIdentityLearning, isSenderAddressType } from '@/components/sales-docs-shared';
// v2.39.0 — AUTO dispatch document (سند ارسال مراسلات) issued with every
// invoice (quick-sale + approve paths) and cleaned up on cancel.
import { autoIssueDispatch, removePreparingShipments } from '@/lib/dispatch-issue';

// ── Helpers ──────────────────────────────────────────────

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  proforma: 'پیش‌فاکتور',
  invoice: 'فاکتور',
  return: 'برگشت از فروش',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'پیش‌نویس',
  pending_approval: 'در انتظار تأیید',
  approved: 'تأیید شده',
  rejected: 'رد شده',
  cancelled: 'لغو شده',
};

const VALID_TYPES = ['proforma', 'invoice', 'return'];
const VALID_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'cancelled'];
const EDITABLE_STATUSES = ['draft', 'rejected'];
const SUBMITTABLE_STATUSES = ['draft', 'rejected'];

// v2.58.3 (round 88, finding 8) — the local calculateTotals was REMOVED:
// create / update / quick-sale all share validateSalesItems +
// computeSalesTotals from src/lib/sales-totals.ts (per-row AND
// document-level exact-integer + logical-cap checks).

/** Read the configurable VAT rate from settings (app.vat_rate), defaulting to 9%.
 *  v2.20.0: accepts a transaction client — querying the GLOBAL pool from
 *  inside an interactive transaction deadlocks Prisma's SQLite engine
 *  (the tx holds its own connection; the cross-connection query stalls
 *  until the 20s interactive-transaction timeout). */
async function getVatRate(tx?: Prisma.TransactionClient): Promise<number> {
  try {
    const client = tx ?? db;
    const meta = await client.meta.findUnique({ where: { key: 'app.vat_rate' } });
    const rate = Number(meta?.value);
    if (!Number.isNaN(rate) && rate >= 0 && rate <= 100) return rate / 100;
  } catch { /* default */ }
  return 0.09;
}

/** Sequential per-prefix/per-day document number (replaces Math.random — P1-6).
 *  v2.13.0: the read-modify-write race (findUnique → upsert) is gone.
 *  Counter increment is now ONE atomic statement — INSERT … ON CONFLICT …
 *  DO UPDATE … RETURNING — so concurrent requests can never receive the
 *  same sequence number. */
async function generateDocumentNumber(
  type: string,
  tx?: Prisma.TransactionClient,
): Promise<string> {
  const prefix = type === 'proforma' ? 'PF' : type === 'invoice' ? 'INV' : 'RET';
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dayKey = `${y}${m}${d}`;
  const metaKey = `docseq.${prefix}.${dayKey}`;
  const client = tx ?? db;

  const rows = await client.$queryRaw<Array<{ value: string }>>`
    INSERT INTO Meta (key, value, updatedAt) VALUES (${metaKey}, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(CAST(Meta.value AS INTEGER) + 1 AS TEXT),
      updatedAt = datetime('now')
    RETURNING value
  `;
  const seq = Number(rows[0]?.value);
  if (!Number.isFinite(seq) || seq < 1) {
    throw new Error('خطا در تولید شماره سند (شمارنده اتمیک).');
  }

  return `${prefix}-${dayKey}-${String(seq).padStart(4, '0')}`;
}

async function findDocOrThrow(
  id: string,
  buId: string,
  checkOwnership = false,
  userId?: string,
  territory: TerritoryScope | null = null,
) {
  const doc = await db.salesDocument.findFirst({
    where: { id, businessUnitId: buId },
    include: {
      // v2.31.7 — issuing company branding (letterhead name + logo).
      // v2.31.8 — tagline joins the letterhead identity (invoice format).
      // v2.31.9 — full seller profile (شناسه ملی، نشانی، تلفن، کد پستی) +
      // bank account feed «مشخصات فروشنده» and the «اطلاعات حساب» box of
      // the Lian proforma format.
      // v2.35.0 — the two-address sender profile (دفتر مرکزی / کارخانه)
      // joins the pull: registered once in company settings, auto-printed.
      company: {
        select: {
          slug: true, name: true, logo: true, tagline: true,
          nationalId: true, address: true, phone: true, postalCode: true,
          headOfficeAddress: true, factoryAddress: true,
          bankName: true, bankAccountHolder: true, bankAccountNumber: true, bankSheba: true,
          // v2.48.0 — company-level printed terms («توضیحات / شرایط» box);
          // null → the template's built-in default terms (legacy behavior).
          proformaNote: true,
          // v2.52.0 — per-company A4 print template (تفکیک قالب چاپ):
          // null → 'bgl' default; 'lian' → the بازرگانی reference design.
          printTemplate: true,
          // v2.54.0 — per-company footer website (globe icon); null →
          // the global app.website at print time.
          website: true,
        },
      },
      // v2.31.9 — buyer identity block: live center master data backs the
      // print-time fallback when a document carries no buyerSnapshot
      // (legacy rows created before this round).
      center: {
        select: {
          id: true, name: true, customerType: true,
          nationalId: true, economicCode: true, postalCode: true, contactName: true,
          address: true, city: true, province: true, phone: true, mobile: true,
        },
      },
      creator: { select: { id: true, displayName: true } },
      updater: { select: { id: true, displayName: true } },
      approver: { select: { id: true, displayName: true } },
      items: {
        orderBy: { createdAt: 'asc' },
        // v2.31.8 — product code + unit feed the redesigned invoice table
        // (کد کالا زیر شرح، ستون «واحد»). This also makes the long-declared
        // `items[].product.code` in ApiSalesDocumentDetail actually populate.
        // v2.31.9 — ircCode joins the sub-line (کد کالا / IRC).
        include: { product: { select: { code: true, unit: true, ircCode: true } } },
      },
      approvals: { orderBy: { createdAt: 'desc' } },
      financeRecords: { orderBy: { createdAt: 'desc' } },
      logs: { orderBy: { createdAt: 'desc' } },
      versions: { orderBy: { versionNumber: 'desc' } },
    },
  });

  if (!doc) {
    // v2.15.0: ApiError keeps the intended 404/403 status + Persian message
    // (the previous plain-object throw was swallowed by route catches).
    throw new ApiError(404, 'سند فروش یافت نشد.');
  }

  if (checkOwnership && userId && doc.createdById !== userId) {
    // v2.58.1 (audit F4-د) — ownership is ownership: a territory NEVER
    // grants access to a colleague's document (the v2.41 "territory
    // expert may reach territory centers' docs" expansion is reverted —
    // selecting a province must not auto-grant colleagues' documents).
    // 404, no existence leak. Explicit view_other_sales_documents
    // (admin/finance) is the only path to other people's documents.
    throw new ApiError(
      404,
      'سند فروش یافت نشد.',
    );
  }
  // v2.58.1 — geography parity with the list: for a territory-scoped
  // viewer the document's center must sit inside the territory (own
  // center-less docs pass; fail-closed 404 otherwise).
  if (territory) {
    const docCenter = doc.center ? { id: doc.center.id, province: doc.center.province } : null;
    if (docCenter && !centerInTerritory(docCenter, territory)) {
      throw new ApiError(404, 'سند فروش یافت نشد.');
    }
  }

  return doc;
}

async function createLog(salesDocumentId: string, userId: string, action: string, details: Record<string, unknown>) {
  await db.salesDocumentLog.create({
    data: {
      salesDocumentId,
      userId,
      action,
      details: JSON.stringify(details),
    },
  });
}

// ── v2.20.0 — optimistic concurrency guard ─────────────────
// Every mutating handler previously validated status OUTSIDE its
// transaction (check-then-act): two concurrent approve clicks both passed
// the `pending_approval` check and the proforma flow derived TWO invoices;
// two concurrent payments both passed the overpayment check and overpaid
// the document. This helper re-reads the LIVE row INSIDE the transaction
// (SQLite serializes writers), so exactly one concurrent writer wins and
// every latecomer receives a 409 instead of corrupting the document.
async function guardInTx(
  tx: Prisma.TransactionClient,
  id: string,
  buId: string,
  opts: {
    /** Allowed live statuses for the transition (mismatch → 409). */
    expectedStatus?: string[];
    /** Document must still be editable (draft/rejected) — mismatch → 400. */
    editableOnly?: boolean;
    /** v2.25.0 — client's copy of the row's `version` (exact CAS).
     *  Mismatch → 409. Supersedes the 1000ms updatedAt tolerance. */
    expectedVersion?: number | string | null;
    /** Deprecated v2.20–v2.24 token (1000ms tolerance) — accepted for
     *  one release so older clients keep their lost-update protection. */
    /** v2.25.0 — edit paths require a concurrency token (428 otherwise). */
    requireVersionToken?: boolean;
    /** v2.25.0 — company predicate on the live row (mismatch → 404,
     *  no existence leak). `null` (admin) / undefined skip the check. */
    allowedCompanyIds?: string[] | null;
  } = {},
) {
  const live = await tx.salesDocument.findFirst({
    where: { id, businessUnitId: buId },
    select: {
      id: true, status: true, updatedAt: true, version: true, companyId: true,
      finalAmount: true, centerId: true, documentType: true, documentNumber: true,
      businessUnitId: true, createdById: true, taxAmount: true,
      totalAmount: true, discountAmount: true, description: true,
    },
  });
  if (!live) throw new ApiError(404, 'سند فروش یافت نشد.');

  // v2.25.0 — tenant isolation on the LIVE row: a company-owned document
  // outside the caller's companies answers 404 without leaking existence.
  if (opts.allowedCompanyIds != null) {
    assertCompanyAccess(live.companyId, opts.allowedCompanyIds, 'سند فروش یافت نشد.');
  }

  if (opts.editableOnly && !EDITABLE_STATUSES.includes(live.status)) {
    throw new ApiError(
      400,
      `سند در وضعیت «${STATUS_LABELS[live.status] || live.status}» قابل ویرایش نیست. فقط اسناد پیش‌نویس یا رد شده قابل ویرایش هستند.`,
    );
  }

  if (opts.expectedStatus && !opts.expectedStatus.includes(live.status)) {
    throw new ApiError(
      409,
      `سند هم‌زمان توسط کاربر دیگری تغییر کرده است (وضعیت فعلی: «${STATUS_LABELS[live.status] || live.status}»). لطفاً سند را بارگذاری مجدد کنید و دوباره تلاش کنید.`,
    );
  }

  // v2.25.0 — numeric CAS: exact integer compare against `version`, which
  // every write increments. Replaces the 1000ms updatedAt tolerance (two
  // saves inside one second could both pass it — the second silently
  // dropping the first).
  assertConcurrencyToken({
    expectedVersion: opts.expectedVersion ?? null,
    liveVersion: live.version,
    entityLabel: 'سند فروش',
    required: opts.requireVersionToken === true,
  });

  return live;
}

/** Normalize a mobile number: Persian→Latin digits, keep digits only. */
function normalizeMobile(input: string): string {
  return input
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[^0-9]/g, '')
    .trim();
}

// ── v2.31.9 — Lian proforma format payload helpers ─────────
/** Allowed header payment-terms values (شرایط پرداخت). Free text is
 *  trimmed and accepted so companies can coin their own terms, but the
 *  canonical four cover the reference format. */
const PAYMENT_TERMS_MAX = 40;

function sanitizePaymentTerms(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') return null;
  const t = input.trim();
  if (!t) return null;
  return t.slice(0, PAYMENT_TERMS_MAX);
}

/** Trim + cap the sales-expert contact fields (کارشناس فروش / موبایل). */
function sanitizeExpertText(input: unknown, max = 60): string | null {
  if (typeof input !== 'string') return null;
  const t = input.trim();
  return t ? t.slice(0, max) : null;
}

const BUYER_SNAPSHOT_KEYS = [
  'name', 'nationalId', 'economicCode', 'address', 'city',
  'province', 'phone', 'postalCode', 'contactName',
] as const;

/** Normalize the buyer-identity snapshot into a compact JSON string.
 *  Accepts an object (the form's natural payload) or an already-encoded
 *  JSON string; every value is coerced to a trimmed string, unknown keys
 *  are dropped, and an all-empty snapshot collapses to '' (no snapshot —
 *  print falls back to live center master data). */
function normalizeBuyerSnapshot(input: unknown): string {
  let obj: Record<string, unknown> | null = null;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    obj = input as Record<string, unknown>;
  } else if (typeof input === 'string' && input.trim()) {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      return ''; // malformed JSON → treated as absent, never stored raw
    }
  }
  if (!obj) return '';

  const out: Record<string, string> = {};
  let any = false;
  for (const key of BUYER_SNAPSHOT_KEYS) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    const s = String(v).trim().slice(0, 160);
    if (s) {
      out[key] = s;
      any = true;
    }
  }
  return any ? JSON.stringify(out) : '';
}

// (v2.13.0) resolveCompanyId removed — company assignment now goes through
// resolveScopedCompanyId() from lib/company-scope.ts, which NEVER falls back
// to an arbitrary "first active company" outside the user's assignment.

// ── Main POST handler ────────────────────────────────────

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
    if (action === 'quick-sale') return await handleQuickSale(body, user);
    if (action === 'update') return await handleUpdate(body, user);
    if (action === 'submit-approval') return await handleSubmitApproval(body, user);
    if (action === 'approve') return await handleApprove(body, user);
    if (action === 'reject') return await handleReject(body, user);
    if (action === 'cancel') return await handleCancel(body, user);
    if (action === 'add-payment') return await handleAddPayment(body, user);
    if (action === 'move-stage') return await handleMoveStage(body, user);
    if (action === 'stats') return await handleStats(user);

    return NextResponse.json({ error: 'عملیات نامعتبر است.' }, { status: 400 });
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'status' in e && 'message' in e) {
      const err = e as { status: number; message: string };
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('sales-documents', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════════
//  1. LIST — Paginated, filterable list with items count
// ════════════════════════════════════════════════════════════

async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  // view_centers permission is used as a general CRM access check
  if (!perms.view_centers && !perms.view_other_sales_documents) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده اسناد فروش را ندارید.' }, { status: 403 });
  }

  const {
    type,
    status,
    centerId,
    search = '',
    dateFrom,
    dateTo,
    page = 1,
    pageSize = 20,
    // v2.34.10 — «اسناد من»: even admins/finance (who normally see the
    // whole business unit) can pin the list to their OWN documents.
    mineOnly = false,
  } = body as {
    type?: string;
    status?: string;
    centerId?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    pageSize?: number;
    mineOnly?: boolean;
  };

  const p = Math.max(1, Math.min(Number(page) || 1, 500));
  const ps = Math.max(1, Math.min(Number(pageSize) || 20, 100));
  const skip = (p - 1) * ps;

  // Build where clause
  const where: Record<string, unknown> = { businessUnitId: user.businessUnitId };

  // v2.25.0 — company tenant isolation: company-owned documents outside
  // the caller's companies are invisible. Company-neutral rows (created
  // without a center) remain visible — the v2.12 optional-center
  // semantics. Applied via AND so the search OR below stays intact.
  const listAllowed = await getAllowedCompanyIds(user);
  const companyScope = optionalCompanyCenterWhere(listAllowed);
  if (companyScope) where.AND = [companyScope];

  // Only show own documents unless user has permission to view others.
  // v2.34.10 — mineOnly forces the personal scope for privileged roles
  // too (standard roles are always personal anyway).
  // v2.58.1 (audit F4-د) — ownership is no longer granted by territory:
  // the old docTerritoryOr let "center ∈ my territory" widen visibility
  // to colleagues' documents. An expert sees THEIR OWN documents only,
  // AND-restricted to the territory's centers (own center-less docs stay
  // visible). «همه کشور» removes only the geography limit — ownership
  // and company scope always apply.
  const listTerritory = resolveTerritoryScope(user);
  if (!perms.view_other_sales_documents || mineOnly === true) {
    const ownershipWhere = docOwnershipTerritoryWhere(listTerritory, user.id);
    if (ownershipWhere && mineOnly !== true) {
      (where.AND as unknown[]).push(ownershipWhere);
    } else {
      where.createdById = user.id;
    }
  }

  // Type filter
  if (type && VALID_TYPES.includes(type)) {
    where.documentType = type;
  }

  // Status filter
  if (status && VALID_STATUSES.includes(status)) {
    where.status = status;
  }

  // Center filter
  if (centerId && typeof centerId === 'string') {
    where.centerId = centerId;
  }

  // Date range filter
  if (dateFrom || dateTo) {
    const dateFilter: Record<string, unknown> = {};
    if (dateFrom) dateFilter.gte = new Date(dateFrom as string);
    if (dateTo) dateFilter.lte = new Date(dateTo as string);
    where.createdAt = dateFilter;
  }

  // Search filter — search by document number or description or center name
  if (search && typeof search === 'string' && search.trim()) {
    where.OR = [
      { documentNumber: { contains: search.trim() } },
      { description: { contains: search.trim() } },
      { center: { name: { contains: search.trim() } } },
      { creator: { displayName: { contains: search.trim() } } },
    ];
  }

  const [documents, total] = await Promise.all([
    db.salesDocument.findMany({
      where,
      select: {
        id: true,
        documentNumber: true,
        documentType: true,
        status: true,
        version: true,
        companyId: true,
        totalAmount: true,
        discountAmount: true,
        taxAmount: true,
        finalAmount: true,
        issuedAt: true,
        createdAt: true,
        updatedAt: true,
        centerId: true,
        createdById: true,
        // v2.45.0 — manual drag & drop stage pin (کاریز)
        pipelineStage: true,
        center: { select: { id: true, name: true, customerType: true } },
        creator: { select: { id: true, displayName: true } },
        _count: { select: { items: true, approvals: true, financeRecords: true, logs: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: ps,
    }),
    db.salesDocument.count({ where }),
  ]);

  const totalPages = Math.ceil(total / ps);

  return NextResponse.json({
    success: true,
    data: documents,
    // v2.34.10 — lets the UI show the «اسناد من / همهٔ اسناد» switch only
    // for roles that could ever see colleagues' documents.
    canViewAll: perms.view_other_sales_documents === true,
    pagination: {
      page: p,
      pageSize: ps,
      total,
      totalPages,
      hasNext: p < totalPages,
      hasPrev: p > 1,
    },
  });
}

// ════════════════════════════════════════════════════════════
//  2. GET — Single document with all relations
// ════════════════════════════════════════════════════════════

async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers && !perms.view_other_sales_documents) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده اسناد فروش را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id?: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه سند الزامی است.' }, { status: 400 });
  }

  // Check ownership unless user can view others
  const checkOwnership = !perms.view_other_sales_documents;
  const doc = await findDocOrThrow(id, user.businessUnitId, checkOwnership, user.id, resolveTerritoryScope(user));

  // v2.25.0 — company tenant gate on reads (404, no existence leak).
  assertCompanyAccess(doc.companyId, await getAllowedCompanyIds(user), 'سند فروش یافت نشد.');

  // Enrich with type/status labels
  const enriched = {
    ...doc,
    documentTypeLabel: DOCUMENT_TYPE_LABELS[doc.documentType] || doc.documentType,
    statusLabel: STATUS_LABELS[doc.status] || doc.status,
  };

  return NextResponse.json({ success: true, data: enriched });
}

// ════════════════════════════════════════════════════════════
//  3. CREATE — Draft document with items
// ════════════════════════════════════════════════════════════

async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.finance_write && !perms.sales_report_write) {
    return NextResponse.json({ error: 'شما دسترسی ایجاد سند فروش را ندارید.' }, { status: 403 });
  }

  const {
    documentType = 'proforma',
    centerId,
    description = '',
    items = [],
    applyVat = true,
    // v2.31.9 — Lian proforma format: header payment terms, sales-expert
    // contact block and the buyer-identity snapshot captured by the
    // redesigned data-entry form.
    paymentTerms,
    salesExpertName,
    salesExpertMobile,
    buyerSnapshot,
    // v2.42.0 — انتخابگر نشانی فرستنده ('main_office' / 'factory' / null):
    // which registered sender address the print shows for THIS document.
    senderAddressType,
  } = body as {
    documentType?: string;
    centerId?: string;
    description?: string;
    applyVat?: boolean;
    paymentTerms?: string;
    salesExpertName?: string;
    salesExpertMobile?: string;
    buyerSnapshot?: Record<string, unknown> | string;
    senderAddressType?: string | null;
    items?: Array<{
      productId?: string;
      productName?: string;
      quantity?: number;
      unitPrice?: number;
      discount?: number;
      description?: string;
      unit?: string;
    }>;
  };

  // Validate document type
  if (!VALID_TYPES.includes(documentType)) {
    return NextResponse.json({
      error: `نوع سند نامعتبر است. انواع مجاز: ${VALID_TYPES.join(', ')}`,
    }, { status: 400 });
  }

  // v2.58.4 (user issue 5) — applyVat is a REAL boolean or absent
  // ('false'/0/null all meant VAT-ON through the old `!== false` check).
  try {
    assertApplyVatBoolean(applyVat);
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // v2.58.3 (round 88, finding 8) — SHARED validator: per-row checks AND
  // the document-level sums (safe-integer + logical cap) run BEFORE any
  // write. NaN / Infinity / negative / non-integer inputs and per-row-valid
  // sums that overflow the safe range are all rejected here.
  let validatedItems;
  try {
    validatedItems = validateSalesItems(items);
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // v2.25.0 — tenant gate + company stamping: a document may only be
  // attached to a center inside the caller's companies, and the new row
  // inherits that center's companyId (direct column — the isolation model
  // no longer depends on relation traversal).
  // v2.38.0 — the same read now also fetches the buyer-identity fields so
  // handleCreate can LEARN from the issued snapshot (see the write-back
  // after the transaction): شناسه ملی / کد اقتصادی typed once on a
  // proforma are remembered on the center for the next issuance.
  let companyOwnerId: string | null = null;
  let centerIdentity: { nationalId: string | null; economicCode: string | null } | null = null;
  if (centerId && typeof centerId === 'string') {
    const center = await db.center.findUnique({
      where: { id: centerId },
      select: { companyId: true, nationalId: true, economicCode: true, province: true },
    });
    if (!center) {
      return NextResponse.json({ error: 'مرکز یافت نشد.' }, { status: 404 });
    }
    const createAllowed = await getAllowedCompanyIds(user);
    if (createAllowed !== null && !createAllowed.includes(center.companyId)) {
      return NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 });
    }
    // v2.36.0 — territory gate: a scoped expert cannot attach a document
    // to a center outside their sales territory (fail-closed write).
    if (!centerInTerritory({ id: centerId, province: center.province }, resolveTerritoryScope(user))) {
      return NextResponse.json(
        { error: 'مرکز موردنظر در محدودهٔ فروش شما نیست.' },
        { status: 403 },
      );
    }
    companyOwnerId = center.companyId;
    centerIdentity = { nationalId: center.nationalId, economicCode: center.economicCode };
    // v2.56.0 (r81) — the r75 holding issuer gate is REMOVED: هلدینگ
    // بهبود گستر issues its own sales documents now (user round 81 —
    // the holding proforma prints with its royal-indigo template and
    // the colorful BGL lockup). Documents stamped with the holding
    // company are accepted like any other issuer, admins included.
  }

  // Calculate totals — VAT applied only when the document is marked as
  // taxable. v2.58.3 (finding 8): the SHARED calculator checks every
  // intermediate sum for exact safe-integer arithmetic and the logical
  // document cap (totalAmount/discountAmount/subtotal/taxAmount/finalAmount).
  const vatRate = await getVatRate();
  let totals: SalesTotals;
  try {
    totals = computeSalesTotals(validatedItems, applyVat !== false, vatRate);
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // Generate document number
  const documentNumber = await generateDocumentNumber(documentType);

  // v2.42.0 — sender address selector: strict validation (the client may
  // only store the two known values or null = default two-address print).
  if (senderAddressType !== undefined && senderAddressType !== null && !isSenderAddressType(senderAddressType)) {
    return NextResponse.json({
      error: "نوع نشانی فرستنده نامعتبر است (مقادیر مجاز: main_office, factory).",
    }, { status: 400 });
  }

  // v2.31.9 — sanitized Lian-format fields (pure helpers above).
  const cleanPaymentTerms = sanitizePaymentTerms(paymentTerms);
  const cleanExpertName = sanitizeExpertText(salesExpertName);
  const cleanExpertMobile = salesExpertMobile ? normalizeMobile(salesExpertMobile) : null;
  const cleanBuyerSnapshot = normalizeBuyerSnapshot(buyerSnapshot);

  // Create document with items in a transaction
  const document = await runInTransaction(async (tx) => {
    const doc = await tx.salesDocument.create({
      data: {
        businessUnitId: user.businessUnitId,
        centerId: centerId || null,
        companyId: companyOwnerId,
        documentNumber,
        documentType,
        status: 'draft',
        // (subtotal is a VALIDATION artifact — the document table stores
        // totalAmount/discountAmount/taxAmount/finalAmount only)
        totalAmount: totals.totalAmount,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        finalAmount: totals.finalAmount,
        description: (description as string).trim(),
        paymentTerms: cleanPaymentTerms,
        salesExpertName: cleanExpertName || user.displayName,
        salesExpertMobile: (cleanExpertMobile && cleanExpertMobile.length >= 8) ? cleanExpertMobile : null,
        buyerSnapshot: cleanBuyerSnapshot,
        // v2.42.0 — the per-document sender address print choice.
        senderAddressType: senderAddressType ?? null,
        createdById: user.id,
        updatedById: user.id,
        items: {
          // v2.58.3 — write the VALIDATED normalized numbers (index-aligned
          // with the raw rows), never re-coerced raw input.
          create: items.map((item, i) => ({
            productId: item.productId || null,
            productName: (item.productName || '').trim(),
            quantity: validatedItems[i].quantity,
            unitPrice: validatedItems[i].unitPrice,
            totalPrice: validatedItems[i].quantity * validatedItems[i].unitPrice - validatedItems[i].discount,
            discount: validatedItems[i].discount,
            description: (item.description || '').trim(),
            // v2.31.9 — واحد column from the form (falls back to product
            // unit, then «عدد» at print time when empty).
            unit: (typeof item.unit === 'string' && item.unit.trim()) ? item.unit.trim().slice(0, 20) : null,
          })),
        },
      },
      include: { items: true, versions: true },
    });

    // Create version 1
    await tx.salesDocumentVersion.create({
      data: {
        salesDocumentId: doc.id,
        versionNumber: 1,
        data: JSON.stringify({
          document: {
            documentNumber: doc.documentNumber,
            documentType: doc.documentType,
            status: doc.status,
            centerId: doc.centerId,
            description: doc.description,
            totalAmount: doc.totalAmount,
            discountAmount: doc.discountAmount,
            taxAmount: doc.taxAmount,
            finalAmount: doc.finalAmount,
            // v2.31.9 — Lian-format header fields join the audit snapshot.
            paymentTerms: doc.paymentTerms,
            salesExpertName: doc.salesExpertName,
            salesExpertMobile: doc.salesExpertMobile,
          },
          items: items.map((it) => ({
            productId: it.productId,
            productName: it.productName,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            discount: it.discount,
            description: it.description,
            unit: it.unit || null,
          })),
        }),
        createdById: user.id,
      },
    });

    return doc;
  });

  // Create creation log
  await createLog(document.id, user.id, 'create', {
    documentNumber,
    documentType,
    itemCount: items.length,
    finalAmount: totals.finalAmount,
  });

  // v2.38.0 (round 64) — buyer-identity LEARNING: «یک بار وارد کن — دفعات
  // بعد ذخیره است». When a document is issued for a center, the شناسه ملی /
  // کد اقتصادی from the buyer snapshot are remembered on the center's master
  // data (last-issued-wins; empty form values never erase). Pure decision in
  // buyerIdentityLearning. BEST-EFFORT by design: the document is already
  // committed, so a failure here is logged and never blocks the response.
  if (centerId && typeof centerId === 'string' && centerIdentity) {
    try {
      const learned = buyerIdentityLearning(centerIdentity, parseBuyerSnapshot(cleanBuyerSnapshot) ?? {});
      if (learned.nationalId !== undefined || learned.economicCode !== undefined) {
        await db.center.update({
          where: { id: centerId },
          data: {
            ...(learned.nationalId !== undefined ? { nationalId: learned.nationalId } : {}),
            ...(learned.economicCode !== undefined ? { economicCode: learned.economicCode } : {}),
            updatedBy: user.id,
            version: { increment: 1 },
          },
        });
      }
    } catch (err) {
      logApiError('sales-documents', `buyer-identity learning failed for center ${centerId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({
    success: true,
    message: `${DOCUMENT_TYPE_LABELS[documentType]} با موفقیت ایجاد شد.`,
    data: document,
  });
}

// ════════════════════════════════════════════════════════════════
//  QUICK SALE — فروش سریع (B2C · آریا مدیکال)
//  یک مرحله: مشتری (با موبایل) + اقلام → فاکتور تأییدشده + پرداخت + امتیاز باشگاه
//  اگر مشتری با این موبایل وجود نداشته باشد، شخص حقیقی جدید ثبت می‌شود.
//  امتیاز باشگاه: هر ۱۰۰٬۰۰۰ تومان = ۱ امتیاز (قابل تنظیم از settings)
// ════════════════════════════════════════════════════════════════
async function handleQuickSale(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.finance_write && !perms.sales_report_write) {
    return NextResponse.json({ error: 'شما دسترسی فروش سریع را ندارید.' }, { status: 403 });
  }

  const {
    centerId,
    customerName,
    customerMobile,
    companySlug,
    items = [],
    applyVat = true,
    paymentMethod,
    awardPoints = true,
    description = '',
  } = body as {
    centerId?: string;
    customerName?: string;
    customerMobile?: string;
    companySlug?: string;
    items?: Array<{
      productId?: string;
      productName?: string;
      quantity?: number;
      unitPrice?: number;
      discount?: number;
    }>;
    applyVat?: boolean;
    paymentMethod?: string;
    awardPoints?: boolean;
    description?: string;
  };

  // v2.58.4 (user issue 5) — applyVat is a REAL boolean or absent
  // ('false'/0/null all meant VAT-ON through the old `!== false` check).
  try {
    assertApplyVatBoolean(applyVat);
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // v2.58.3 (round 88, finding 8) — the SHARED validator (quick-sale
  // previously ran the WEAKEST checks of the three routes: no integer
  // checks at all). Same rules as create/update now.
  let quickSaleItems;
  try {
    quickSaleItems = validateSalesItems(items);
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // ── Resolve customer ──
  let customerId = centerId || null;
  let customerCreated = false;
  let customerNameResolved = customerName?.trim() || '';
  // v2.13.0: company scope for the whole quick-sale flow — a scoped user may
  // only sell to customers of their own companies.
  const allowedCompanies = await getAllowedCompanyIds(user);

  if (customerId) {
    const existing = await db.center.findFirst({
      where: { id: customerId, businessUnitId: user.businessUnitId },
    });
    if (!existing) {
      return NextResponse.json({ error: 'مشتری انتخاب‌شده یافت نشد.' }, { status: 404 });
    }
    if (allowedCompanies !== null && !allowedCompanies.includes(existing.companyId)) {
      return NextResponse.json({ error: 'مشتری انتخاب‌شده یافت نشد.' }, { status: 404 });
    }
    // v2.58.7 (production-hardening G1): quick-sale was the ONE money path
    // with company scope but NO territory scope — a provinces/centers-mode
    // expert could issue an already-APPROVED invoice + payment + loyalty
    // points + auto-dispatch for any in-company, out-of-territory center
    // (handleCreate / add-payment both enforce centerInTerritory; this
    // handler simply forgot). Same denial convention as every sales path:
    // 404 no-leak, zero financial writes.
    try {
      assertTerritoryAccess(user, existing);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        return NextResponse.json({ error: 'مشتری انتخاب‌شده یافت نشد.' }, { status: e.status });
      }
      throw e;
    }
    customerNameResolved = existing.name;
  } else {
    const mobile = customerMobile ? normalizeMobile(customerMobile) : '';
    if (!customerNameResolved) {
      return NextResponse.json({ error: 'نام مشتری الزامی است.' }, { status: 400 });
    }
    if (mobile.length < 10) {
      return NextResponse.json({ error: 'شماره موبایل معتبر وارد کنید (حداقل ۱۰ رقم).' }, { status: 400 });
    }

    // Find an existing end-user by mobile (within the user's company scope)
    let found = await db.center.findFirst({
      where: {
        businessUnitId: user.businessUnitId,
        mobile,
        ...(allowedCompanies !== null ? { companyId: { in: allowedCompanies } } : {}),
      },
    });
    if (!found) {
      found = await db.center.findFirst({
        where: {
          businessUnitId: user.businessUnitId,
          phone: mobile,
          ...(allowedCompanies !== null ? { companyId: { in: allowedCompanies } } : {}),
        },
      });
    }

    if (found) {
      // v2.58.7 (G1, mobile path): the customer found by mobile gets the
      // SAME territory gate as the explicit centerId path above — an
      // out-of-territory existing customer must not be sellable just
      // because the lookup ran by phone number instead of id.
      try {
        assertTerritoryAccess(user, found);
      } catch (e: unknown) {
        if (e instanceof ApiError) {
          return NextResponse.json({ error: 'مشتری با این شماره در حوزهٔ فروش شما یافت نشد.' }, { status: e.status });
        }
        throw e;
      }
      customerId = found.id;
      customerNameResolved = found.name;
    } else {
      // Create a new real-person (end_user) customer.
      // v2.13.0 — the company is resolved INSIDE the user's assignment:
      // explicit slug (validated) or the user's first allowed company.
      // Never an arbitrary "first active company" of the whole database.
      const resolvedCompany = await resolveScopedCompanyId(user, companySlug);
      if (!resolvedCompany.ok) {
        return NextResponse.json({ error: resolvedCompany.error }, { status: resolvedCompany.status });
      }
      if (!resolvedCompany.companyId) {
        return NextResponse.json(
          { error: 'هیچ شرکتی به شما اختصاص داده نشده است؛ ثبت مشتری جدید ممکن نیست.' },
          { status: 403 },
        );
      }
      // v2.56.0 (r81) — the r75 holding gate on the new-customer path is
      // removed with the issuer gates: quick-sale customers may be filed
      // under the holding company like any other issuer.
      const newCenter = await db.center.create({
        data: {
          name: customerNameResolved,
          mobile,
          customerType: 'end_user',
          businessUnitId: user.businessUnitId,
          companyId: resolvedCompany.companyId,
          createdBy: user.id,
          updatedBy: user.id,
          // v2.34.11 (round 58) — shared normalization so quick-sale
          // customers get the same searchKey shape as every other center.
          searchKey: normalizePersian(`${customerNameResolved} ${mobile ?? ''}`),
        },
      });
      customerId = newCenter.id;
      customerCreated = true;
    }
  }

  // v2.25.0 — the quick-sale invoice inherits the customer center's
  // company (found, matched-by-mobile, or freshly created above).
  const customerCompanyId = customerId
    ? (await db.center.findUnique({
        where: { id: customerId },
        select: { companyId: true },
      }))?.companyId ?? null
    : null;

  // ── Totals (v2.58.3, finding 8: the SHARED calculator — safe-integer
  // sums + the logical document cap, identical to create/update) ──
  const vatRate = await getVatRate();
  const totals = computeSalesTotals(quickSaleItems, applyVat !== false, vatRate);

  const documentNumber = await generateDocumentNumber('invoice');

  // ── Create the approved invoice + payment + loyalty points atomically ──
  const document = await runInTransaction(async (tx) => {
    const doc = await tx.salesDocument.create({
      data: {
        businessUnitId: user.businessUnitId,
        centerId: customerId,
        companyId: customerCompanyId,
        documentNumber,
        documentType: 'invoice',
        status: 'approved',
        issuedAt: new Date(),
        approvedById: user.id,
        // (subtotal is a VALIDATION artifact — see create)
        totalAmount: totals.totalAmount,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        finalAmount: totals.finalAmount,
        description: `${description || 'فروش سریع'}${customerCreated ? ' — مشتری جدید' : ''}`.trim(),
        createdById: user.id,
        updatedById: user.id,
        items: {
          // v2.58.3 — write the VALIDATED normalized numbers (index-aligned
          // with the raw rows), never re-coerced raw input.
          create: items.map((item, i) => ({
            productId: item.productId || null,
            productName: (item.productName || '').trim(),
            quantity: quickSaleItems[i].quantity,
            unitPrice: quickSaleItems[i].unitPrice,
            totalPrice: quickSaleItems[i].quantity * quickSaleItems[i].unitPrice - quickSaleItems[i].discount,
            discount: quickSaleItems[i].discount,
          })),
        },
      },
      include: { items: true },
    });

    // Approval record (auto-approved as part of the fast-sale flow)
    await tx.salesDocumentApproval.create({
      data: {
        salesDocumentId: doc.id,
        userId: user.id,
        action: 'approved',
        comment: 'تأیید خودکار در فرآیند فروش سریع',
      },
    });

    // Version snapshot
    await tx.salesDocumentVersion.create({
      data: {
        salesDocumentId: doc.id,
        versionNumber: 1,
        data: JSON.stringify({
          document: {
            documentNumber: doc.documentNumber,
            documentType: 'invoice',
            status: 'approved',
            centerId: doc.centerId,
            description: doc.description,
            totalAmount: doc.totalAmount,
            discountAmount: doc.discountAmount,
            taxAmount: doc.taxAmount,
            finalAmount: doc.finalAmount,
          },
          items,
        }),
        createdById: user.id,
      },
    });

    // v2.13.0 — sales ↔ accounting sync: the quick-sale invoice now creates
    // the customer's financial account and the DEFINITIVELY linked accounting
    // invoice (IssuedInvoice.salesDocumentId), exactly like an approved
    // invoice from the document flow.
    const issued = await issueInvoiceForDocument(tx, doc, doc.items, user.id);

    // Payment record (full payment by default) — mirrored onto the linked
    // accounting invoice so billing and sales agree on paidAmount.
    if (paymentMethod && paymentMethod.trim()) {
      await tx.salesDocumentFinance.create({
        data: {
          salesDocumentId: doc.id,
          paymentMethod: paymentMethod.trim(),
          paymentDate: new Date(),
          amount: totals.finalAmount,
          description: 'پرداخت فروش سریع',
        },
      });
      await syncPaymentToLinkedInvoice(tx, doc, {
        amount: totals.finalAmount,
        paymentDate: new Date(),
        description: 'پرداخت فروش سریع',
      });
    }

    // v2.13.0 — authoritative account totals after all effects
    if (customerId) {
      await recalcCenterAccount(tx, customerId);
    }

    // Loyalty points: هر ۱۰۰٬۰۰۰ تومان = ۱ امتیاز
    let awardedPoints = 0;
    if (awardPoints !== false && customerId && totals.finalAmount >= 100000) {
      awardedPoints = Math.floor(totals.finalAmount / 100000);
      if (awardedPoints > 0) {
        await tx.loyaltyTransaction.create({
          data: {
            centerId: customerId,
            points: awardedPoints,
            reason: 'purchase',
            note: `فروش سریع ${documentNumber}`,
            documentNumber,
            createdById: user.id,
            createdByName: user.displayName,
          },
        });
        await tx.center.update({
          where: { id: customerId },
          data: { loyaltyPoints: { increment: awardedPoints } },
        });
      }
    }

    // v2.39.0 (round 65) — the dispatch document (سند ارسال مراسلات) is
    // AUTO-ISSUED inside the same transaction: the carton label becomes
    // printable the instant the quick-sale invoice exists.
    const autoDispatch = await autoIssueDispatch(tx, doc, user.id, doc.items);

    return { doc, awardedPoints, issuedInvoiceId: issued.invoice.id, autoDispatch };
  });

  await createLog(document.doc.id, user.id, 'quick_sale', {
    documentNumber,
    customer: customerNameResolved,
    customerCreated,
    finalAmount: totals.finalAmount,
    awardedPoints: document.awardedPoints,
    issuedInvoiceId: document.issuedInvoiceId,
    autoDispatchNumber: document.autoDispatch.shipmentNumber,
  });

  return NextResponse.json({
    success: true,
    message: `فاکتور فروش سریع ${documentNumber} صادر شد.`,
    data: {
      document: document.doc,
      customer: { id: customerId, name: customerNameResolved, created: customerCreated },
      awardedPoints: document.awardedPoints,
      issuedInvoiceId: document.issuedInvoiceId,
      // v2.39.0 — the auto-issued سند ارسال (the UI opens the carton-label
      // print dialog straight from this).
      shipment: document.autoDispatch,
    },
  }, { status: 201 });
}

// ════════════════════════════════════════════════════════════
//  4. UPDATE — Update document and items, create version
// ════════════════════════════════════════════════════════════

async function handleUpdate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.finance_write && !perms.sales_report_write) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش سند فروش را ندارید.' }, { status: 403 });
  }

  const {
    id,
    centerId,
    description,
    items,
    applyVat,
    // v2.31.9 — Lian proforma format fields are editable alongside the
    // classic ones (all optional: absent fields keep their stored value).
    paymentTerms,
    salesExpertName,
    salesExpertMobile,
    buyerSnapshot,
    // v2.42.0 — انتخابگر نشانی فرستنده (null clears → default print).
    senderAddressType,
    // v2.20.0 — optimistic concurrency, superseded in v2.25.0 by the exact
    // numeric CAS token: the client's copy of the row's `version`. A
    // mismatch → 409, never a silent lost update. (v2.27.1: the old
    // 1000ms-tolerance `expectedUpdatedAt` fallback is removed.)
    expectedVersion,
  } = body as {
    id?: string;
    centerId?: string | null;
    description?: string;
    applyVat?: boolean;
    paymentTerms?: string | null;
    salesExpertName?: string | null;
    salesExpertMobile?: string | null;
    buyerSnapshot?: Record<string, unknown> | string | null;
    senderAddressType?: string | null;
    expectedVersion?: number | string | null;
    items?: Array<{
      id?: string;
      productId?: string;
      productName?: string;
      quantity?: number;
      unitPrice?: number;
      discount?: number;
      description?: string;
      unit?: string | null;
      _delete?: boolean;
    }>;
  };

  if (!id) {
    return NextResponse.json({ error: 'شناسه سند الزامی است.' }, { status: 400 });
  }

  // Fast-fail read (permissions + clear early errors). The AUTHORITATIVE
  // status/version check re-runs INSIDE the transaction via guardInTx —
  // v2.20.0 closes the check-then-act window where a document was submitted
  // for approval between this read and the update below.
  // v2.58.7 (A4): update previously fetched the doc WITHOUT the territory
  // dimension (get/move-stage/add-payment all pass it) — a scoped expert
  // could still edit their own document whose center sits outside the
  // (possibly narrowed) territory. Geography parity for every own-doc
  // mutation now.
  const existing = await findDocOrThrow(id, user.businessUnitId, true, user.id, resolveTerritoryScope(user));

  if (!EDITABLE_STATUSES.includes(existing.status)) {
    return NextResponse.json({
      error: `سند در وضعیت «${STATUS_LABELS[existing.status]}» قابل ویرایش نیست. فقط اسناد پیش‌نویس یا رد شده قابل ویرایش هستند.`,
    }, { status: 400 });
  }

  // v2.25.0 — re-assigning the document to another company's center is
  // forbidden, and the company stamp follows the center.
  const allowedCompanies = await getAllowedCompanyIds(user);
  let newCompanyId: string | null | undefined;
  if (centerId !== undefined) {
    if (centerId) {
      const center = await db.center.findUnique({
        where: { id: centerId },
        select: { companyId: true, province: true, id: true },
      });
      if (!center) {
        return NextResponse.json({ error: 'مرکز یافت نشد.' }, { status: 404 });
      }
      if (allowedCompanies !== null && !allowedCompanies.includes(center.companyId)) {
        return NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 });
      }
      // v2.58.7 (A4, re-assignment path): moving a document to a NEW
      // center now requires that center to be inside the user's territory
      // too (handleCreate already enforces centerInTerritory on its center
      // pick; the update path only checked the company).
      if (!centerInTerritory(center, resolveTerritoryScope(user))) {
        return NextResponse.json({ error: 'مرکز انتخاب‌شده در حوزهٔ فروش شما نیست.' }, { status: 404 });
      }
      newCompanyId = center.companyId;
    } else {
      newCompanyId = null;
    }
  }

  // Build update data
  const updateData: Record<string, unknown> = {
    updatedById: user.id,
    // v2.25.0 — every write bumps the CAS version
    version: { increment: 1 },
  };

  if (centerId !== undefined) {
    updateData.centerId = centerId || null;
  }
  if (description !== undefined) {
    updateData.description = (description as string).trim();
  }
  // v2.31.9 — Lian-format header fields (null clears, absent keeps).
  if (paymentTerms !== undefined) {
    updateData.paymentTerms = sanitizePaymentTerms(paymentTerms);
  }
  if (salesExpertName !== undefined) {
    updateData.salesExpertName = sanitizeExpertText(salesExpertName);
  }
  if (salesExpertMobile !== undefined) {
    const m = salesExpertMobile ? normalizeMobile(salesExpertMobile) : null;
    updateData.salesExpertMobile = (m && m.length >= 8) ? m : null;
  }
  if (buyerSnapshot !== undefined) {
    updateData.buyerSnapshot = normalizeBuyerSnapshot(buyerSnapshot);
  }
  // v2.42.0 — sender address selector (null clears → default print).
  if (senderAddressType !== undefined) {
    if (senderAddressType !== null && !isSenderAddressType(senderAddressType)) {
      return NextResponse.json({
        error: "نوع نشانی فرستنده نامعتبر است (مقادیر مجاز: main_office, factory).",
      }, { status: 400 });
    }
    updateData.senderAddressType = senderAddressType;
  }

  // Process items if provided
  // v2.58.4 (user issue 5) — applyVat is a REAL boolean or absent on the
  // update path too ('false'/0/null all meant VAT-ON before).
  try {
    assertApplyVatBoolean(applyVat);
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
  const itemsData = items;
  if (Array.isArray(itemsData)) {
    // Validate items
    if (itemsData.length === 0) {
      return NextResponse.json({ error: 'حداقل یک آیتم باید وارد شود.' }, { status: 400 });
    }

    // v2.58.3 (round 88, finding 8) — the SHARED validator (the same one
    // create/quick-sale use): NaN / Infinity / negative / non-integer
    // rows are rejected BEFORE any write, and the sums get the
    // safe-integer + logical-cap treatment (below, in-tx).
    try {
      validateSalesItems(itemsData.filter((it) => !it._delete));
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }

    // v2.15.0 (audit #6, sales edit VAT): the update path recalculated totals
    // with calculateTotals' DEFAULT applyVat=true, silently re-taxing a
    // tax-free document on every edit (100 → 109). The caller's applyVat is
    // now honored; when absent, the document's current taxable state is
    // preserved (a taxed document stays taxed, a tax-free one stays free).
    //
    // NOTE (v2.20.0): the totals are (re)computed INSIDE the transaction
    // from the LIVE row — see below — so a concurrent edit can no longer
    // slip in between the read of `existing` and the write.
  } else if (applyVat !== undefined) {
    // v2.15.0: a bare applyVat change (no items sent) also recalculates the
    // totals from the stored items — previously it was ignored entirely.
    // (v2.20.0: computed in-tx from live items — see below.)
  }

  // Perform update in a transaction
  const document = await runInTransaction(async (tx) => {
    // v2.20.0 — AUTHORITATIVE optimistic-concurrency guard: re-reads the
    // live row inside the transaction. Rejects (a) documents whose status
    // changed since the client loaded them (e.g. already submitted) and
    // (b) documents edited concurrently (stale expectedVersion).
    const live = await guardInTx(tx, id, user.businessUnitId, {
      editableOnly: true,
      expectedVersion: expectedVersion ?? null,
      requireVersionToken: true,
      allowedCompanyIds: allowedCompanies,
    });

    // v2.25.0 — company stamp follows the (validated) center assignment
    if (newCompanyId !== undefined) {
      updateData.companyId = newCompanyId;
    }

    // Live items for totals fallback (bare applyVat change, no items sent)
    const liveItems = await tx.salesDocumentItem.findMany({
      where: { salesDocumentId: id },
    });

    // ── Totals (v2.15.0 VAT semantics preserved, now computed in-tx) ──
    if (Array.isArray(itemsData)) {
      const vatRate = await getVatRate(tx);
      const effectiveApplyVat = applyVat !== undefined
        ? applyVat !== false
        : (live.taxAmount || 0) > 0;

      const activeItems = itemsData.filter((it) => !it._delete);
      // v2.58.3 (finding 8) — SHARED calculator: every intermediate sum is
      // checked for exact safe-integer arithmetic + the document cap.
      const totals = computeSalesTotals(
        activeItems.map((it) => ({
          quantity: it.quantity || 0,
          unitPrice: it.unitPrice || 0,
          discount: it.discount || 0,
        })),
        effectiveApplyVat,
        vatRate,
      );

      updateData.totalAmount = totals.totalAmount;
      updateData.discountAmount = totals.discountAmount;
      updateData.taxAmount = totals.taxAmount;
      updateData.finalAmount = totals.finalAmount;
    } else if (applyVat !== undefined) {
      const vatRate = await getVatRate(tx);
      // v2.58.3 (finding 8) — shared calculator on the live rows
      const totals = computeSalesTotals(
        liveItems.map((it) => ({
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          discount: it.discount,
        })),
        applyVat !== false,
        vatRate,
      );

      updateData.totalAmount = totals.totalAmount;
      updateData.discountAmount = totals.discountAmount;
      updateData.taxAmount = totals.taxAmount;
      updateData.finalAmount = totals.finalAmount;
    }

    // Update document
    await tx.salesDocument.update({
      where: { id },
      data: updateData,
      include: { items: true },
    });

    // Update items if provided
    if (Array.isArray(itemsData)) {
      // Delete marked items
      const toDeleteIds = itemsData
        .filter((it) => it._delete && it.id)
        .map((it) => it.id as string);
      if (toDeleteIds.length > 0) {
        await tx.salesDocumentItem.deleteMany({
          where: {
            id: { in: toDeleteIds },
            salesDocumentId: id,
          },
        });
      }

      // Upsert items
      for (const item of itemsData) {
        if (item._delete) continue;

        // v2.31.9 — واحد column: undefined keeps the stored value on update
        // (Prisma treats it as "not provided"); null clears; a trimmed
        // string sets it. On create, undefined lands as null.
        const cleanUnit = item.unit === undefined
          ? undefined
          : ((typeof item.unit === 'string' && item.unit.trim()) ? item.unit.trim().slice(0, 20) : null);
        const itemData = {
          productId: item.productId || null,
          productName: (item.productName || '').trim(),
          quantity: Number(item.quantity) || 0,
          unitPrice: Number(item.unitPrice) || 0,
          totalPrice:
            (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0) -
            (Number(item.discount) || 0),
          discount: Number(item.discount) || 0,
          description: (item.description || '').trim(),
          unit: cleanUnit,
        };

        if (item.id) {
          // Update existing item
          await tx.salesDocumentItem.update({
            where: { id: item.id, salesDocumentId: id },
            data: itemData,
          });
        } else {
          // Create new item
          await tx.salesDocumentItem.create({
            data: { ...itemData, salesDocumentId: id },
          });
        }
      }
    }

    // Reload with all items
    const reloaded = await tx.salesDocument.findUnique({
      where: { id },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });

    // Create version
    const lastVersion = await tx.salesDocumentVersion.findFirst({
      where: { salesDocumentId: id },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });
    const nextVersion = (lastVersion?.versionNumber || 0) + 1;

    await tx.salesDocumentVersion.create({
      data: {
        salesDocumentId: id,
        versionNumber: nextVersion,
        data: JSON.stringify({
          document: {
            centerId: reloaded?.centerId,
            description: reloaded?.description,
            totalAmount: reloaded?.totalAmount,
            discountAmount: reloaded?.discountAmount,
            taxAmount: reloaded?.taxAmount,
            finalAmount: reloaded?.finalAmount,
          },
          items: reloaded?.items.map((it) => ({
            id: it.id,
            productId: it.productId,
            productName: it.productName,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            discount: it.discount,
            description: it.description,
            unit: it.unit,
          })),
        }),
        createdById: user.id,
      },
    });

    return reloaded;
  });

  // Log changes
  await createLog(document!.id, user.id, 'update', {
    centerId: updateData.centerId,
    description: updateData.description,
    finalAmount: updateData.finalAmount,
    itemCount: document?.items?.length || 0,
  });

  return NextResponse.json({
    success: true,
    message: 'سند فروش با موفقیت به‌روزرسانی شد.',
    data: document,
  });
}

// ════════════════════════════════════════════════════════════
//  5. SUBMIT-APPROVAL — Submit draft for approval
// ════════════════════════════════════════════════════════════

async function handleSubmitApproval(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.finance_write && !perms.sales_report_write) {
    return NextResponse.json({ error: 'شما دسترسی ارسال سند برای تأیید را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id?: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه سند الزامی است.' }, { status: 400 });
  }

  const existing = await findDocOrThrow(id, user.businessUnitId, true, user.id);

  if (!SUBMITTABLE_STATUSES.includes(existing.status)) {
    return NextResponse.json({
      error: `سند در وضعیت «${STATUS_LABELS[existing.status]}» قابل ارسال برای تأیید نیست. فقط اسناد پیش‌نویس یا رد شده قابل ارسال هستند.`,
    }, { status: 400 });
  }

  // Check that document has items
  if (!existing.items || existing.items.length === 0) {
    return NextResponse.json({ error: 'سند بدون آیتم نمی‌تواند برای تأیید ارسال شود.' }, { status: 400 });
  }

  const submitAllowed = await getAllowedCompanyIds(user);
  // v2.58.7 (A4) — territory parity on submit-approval (same rule as the
  // update/cancel fast-fail reads): a scoped expert submits only their own
  // docs whose center is inside the territory.
  await findDocOrThrow(id, user.businessUnitId, true, user.id, resolveTerritoryScope(user));

  const document = await runInTransaction(async (tx) => {
    // v2.20.0 — in-tx status guard: exactly one of N concurrent submits
    // succeeds; the rest receive 409 instead of double submit_approval logs.
    await guardInTx(tx, id, user.businessUnitId, {
      expectedStatus: SUBMITTABLE_STATUSES,
      allowedCompanyIds: submitAllowed,
    });

    // Items re-checked on the LIVE row (a concurrent update may have
    // deleted the last item between the outer read and this transaction).
    const liveItemCount = await tx.salesDocumentItem.count({
      where: { salesDocumentId: id },
    });
    if (liveItemCount === 0) {
      throw new ApiError(400, 'سند بدون آیتم نمی‌تواند برای تأیید ارسال شود.');
    }

    return tx.salesDocument.update({
      where: { id },
      data: {
        status: 'pending_approval',
        updatedById: user.id,
        // v2.45.0 — a real workflow event supersedes any manual drag &
        // drop placement: the pin is cleared so the card follows the
        // live status again (it would otherwise linger in a stale column).
        pipelineStage: null,
        // v2.25.0 — every write bumps the CAS version
        version: { increment: 1 },
      },
    });
  });

  await createLog(id, user.id, 'submit_approval', {
    previousStatus: existing.status,
    newStatus: 'pending_approval',
  });

  return NextResponse.json({
    success: true,
    message: 'سند با موفقیت برای تأیید ارسال شد.',
    data: document,
  });
}

// ════════════════════════════════════════════════════════════
//  6. APPROVE — Approve a pending document
// ════════════════════════════════════════════════════════════

async function handleApprove(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  // v2.27.2 — approval is a SUPERVISORY act (the stage is literally «در
  // انتظار تأیید مدیر»). finance_write alone is true for every standard
  // salesperson, so any salesperson could approve a colleague's document
  // through the API even though the UI never showed it to them (the list
  // is creator-scoped for standard roles). Approving now additionally
  // requires view_other_sales_documents (admin / finance).
  if (!perms.finance_write || !perms.view_other_sales_documents) {
    return NextResponse.json({ error: 'شما دسترسی تأیید سند فروش را ندارید.' }, { status: 403 });
  }

  const {
    id,
    comment = '',
  } = body as {
    id?: string;
    comment?: string;
  };

  if (!id) {
    return NextResponse.json({ error: 'شناسه سند الزامی است.' }, { status: 400 });
  }

  const existing = await findDocOrThrow(id, user.businessUnitId);

  if (existing.status !== 'pending_approval') {
    return NextResponse.json({
      error: `سند در وضعیت «${STATUS_LABELS[existing.status]}» نیست. فقط اسناد در انتظار تأیید قابل تأیید هستند.`,
    }, { status: 400 });
  }

  // Prevent self-approval
  if (existing.createdById === user.id) {
    return NextResponse.json({
      error: 'شما نمی‌توانید سند خود را تأیید کنید.',
    }, { status: 400 });
  }

  const approveAllowed = await getAllowedCompanyIds(user);

  const document = await runInTransaction(async (tx) => {
    // v2.20.0 — in-tx status guard: two finance users clicking approve at
    // the same moment previously BOTH passed the outer check, and the
    // proforma flow derived TWO invoices (duplicate accounting). Now the
    // second transaction aborts with 409 before any write happens.
    await guardInTx(tx, id, user.businessUnitId, {
      expectedStatus: ['pending_approval'],
      allowedCompanyIds: approveAllowed,
    });

    // Update document status
    const doc = await tx.salesDocument.update({
      where: { id },
      data: {
        status: 'approved',
        approvedById: user.id,
        issuedAt: new Date(),
        updatedById: user.id,
        // v2.45.0 — real workflow event → clear the manual stage pin
        // (drag & drop placement must not outlive the approval).
        pipelineStage: null,
        // v2.25.0 — every write bumps the CAS version
        version: { increment: 1 },
      },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        center: { select: { id: true, name: true, customerType: true } },
      },
    });

    // Record approval
    await tx.salesDocumentApproval.create({
      data: {
        salesDocumentId: id,
        userId: user.id,
        action: 'approved',
        comment: (comment as string).trim(),
      },
    });

    // ── v2.13.0 — sales ↔ accounting sync on approval (all types) ──
    // proforma → derive an approved invoice document + linked accounting
    //            invoice (legacy behaviour, now with the definitive link)
    // invoice   → linked accounting invoice (was: nothing — the desync bug)
    // return    → account adjustment only, via recalc (returns reduce debt)
    // v2.39.0 — every ISSUED invoice additionally gets its dispatch
    // document (سند ارسال مراسلات) AUTO-ISSUED in this same transaction
    // (round 65: «بعد از صدور فاکتور به صورت اتوماتیک... برای درج روی
    // کارتون‌ها») so the carton label is printable immediately.
    let derivedDispatch: { invoiceId: string; invoiceNumber: string | null; shipmentId: string; shipmentNumber: string | null } | null = null;
    if (doc.documentType === 'proforma' && doc.centerId) {
      const invoiceNumber = await generateDocumentNumber('invoice', tx);

      // v2.25.0 — derive the actual invoice sales document with the
      // DEFINITIVE sourceDocumentId link (the cancel flow resolves the
      // cascade through this column — the legacy `description contains
      // documentNumber` text search could sweep an unrelated document
      // whose description merely mentioned the number). The description
      // keeps the human-readable lineage text for display only.
      // v2.39.0 — the derivation now ALSO inherits the proforma's
      // buyerSnapshot (legal snapshot semantics) + paymentTerms +
      // sales-expert contact, so the derived invoice — and the carton
      // label printed from it — shows the buyer identity AS ENTERED at
      // proforma time, not a fallback to live center master data.
      const invoiceDoc = await tx.salesDocument.create({
        data: {
          businessUnitId: doc.businessUnitId,
          centerId: doc.centerId,
          companyId: doc.companyId,
          sourceDocumentId: doc.id,
          documentNumber: invoiceNumber,
          documentType: 'invoice',
          status: 'approved',
          totalAmount: doc.totalAmount,
          discountAmount: doc.discountAmount,
          taxAmount: doc.taxAmount,
          finalAmount: doc.finalAmount,
          description: `صادر شده از ${DOCUMENT_TYPE_LABELS[doc.documentType]} شماره ${doc.documentNumber}`,
          buyerSnapshot: doc.buyerSnapshot,
          paymentTerms: doc.paymentTerms,
          salesExpertName: doc.salesExpertName,
          salesExpertMobile: doc.salesExpertMobile,
          // v2.42.0 — the derived invoice inherits the proforma's sender
          // address print choice (snapshot semantics, same as buyerSnapshot).
          senderAddressType: doc.senderAddressType,
          issuedAt: new Date(),
          approvedById: user.id,
          // v2.58.4 (external audit F05) — the commercial owner of the
          // DERIVED invoice is the SOURCE document's creator (the seller),
          // NOT the technical actor who clicked approve. With the
          // ownership-based visibility policy (createdById drives the
          // standard-role scope), stamping the approver here made the
          // seller lose access to the final invoice of their own sale.
          // The real approver stays honestly recorded above (approvedById)
          // and in the approval row + SalesDocumentLog — the audit trail
          // is never forged.
          createdById: doc.createdById,
          updatedById: user.id,
          items: {
            create: doc.items.map((item) => ({
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              totalPrice: item.totalPrice,
              discount: item.discount,
              description: item.description,
            })),
          },
        },
      });

      // Create version for the new invoice
      await tx.salesDocumentVersion.create({
        data: {
          salesDocumentId: invoiceDoc.id,
          versionNumber: 1,
          data: JSON.stringify({
            sourceDocumentId: doc.id,
            sourceDocumentNumber: doc.documentNumber,
          }),
          createdById: user.id,
        },
      });

      // v2.13.0 — accounting invoice DEFINITIVELY linked to the derived
      // invoice document (shared helper; also creates the center account)
      await issueInvoiceForDocument(
        tx,
        { ...invoiceDoc },
        doc.items.map((item) => ({
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
        })),
        user.id,
      );

      // v2.39.0 — the DERIVED invoice is the issued فاکتور: its سند ارسال
      // is auto-issued right here (atomic with the approval).
      const shipment = await autoIssueDispatch(
        tx,
        { id: invoiceDoc.id, documentNumber: invoiceDoc.documentNumber },
        user.id,
        doc.items,
      );
      derivedDispatch = {
        invoiceId: invoiceDoc.id,
        invoiceNumber: invoiceDoc.documentNumber,
        shipmentId: shipment.id,
        shipmentNumber: shipment.shipmentNumber,
      };
    } else if (doc.documentType === 'invoice' && doc.centerId) {
      // Directly-approved invoice: same accounting effect as a proforma-
      // derived one (linked invoice + account), previously missing entirely.
      await issueInvoiceForDocument(
        tx,
        doc,
        doc.items.map((item) => ({
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
        })),
        user.id,
      );
      // v2.39.0 — direct invoice approval issues the invoice itself →
      // auto سند ارسال for THIS document.
      const shipment = await autoIssueDispatch(
        tx,
        { id: doc.id, documentNumber: doc.documentNumber },
        user.id,
        doc.items,
      );
      derivedDispatch = {
        invoiceId: doc.id,
        invoiceNumber: doc.documentNumber,
        shipmentId: shipment.id,
        shipmentNumber: shipment.shipmentNumber,
      };
    }

    // Authoritative account totals after the approval effects (invoice up,
    // return down — both derived from document status, no incremental math)
    if (doc.centerId) {
      await recalcCenterAccount(tx, doc.centerId);
    }

    return { doc, derivedDispatch };
  });

  // Log approval
  await createLog(id, user.id, 'approve', {
    comment: (comment as string).trim(),
    issuedAt: document.doc.issuedAt,
    autoDispatch: document.derivedDispatch,
  });

  return NextResponse.json({
    success: true,
    message: 'سند فروش با موفقیت تأیید شد.',
    data: document.doc,
    // v2.39.0 — when approval ISSUED an invoice (proforma derivation or a
    // directly-approved invoice), the auto-issued سند ارسال rides along so
    // the UI can open the carton-label print dialog immediately.
    derived: document.derivedDispatch,
  });
}

// ════════════════════════════════════════════════════════════
//  7. REJECT — Reject a pending document
// ════════════════════════════════════════════════════════════

async function handleReject(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  // v2.27.2 — same supervisory gate as approve (see handleApprove).
  if (!perms.finance_write || !perms.view_other_sales_documents) {
    return NextResponse.json({ error: 'شما دسترسی رد سند فروش را ندارید.' }, { status: 403 });
  }

  const {
    id,
    comment = '',
  } = body as {
    id?: string;
    comment?: string;
  };

  if (!id) {
    return NextResponse.json({ error: 'شناسه سند الزامی است.' }, { status: 400 });
  }

  if (!comment || !(comment as string).trim()) {
    return NextResponse.json({ error: 'دلیل رد سند الزامی است.' }, { status: 400 });
  }

  const existing = await findDocOrThrow(id, user.businessUnitId);

  if (existing.status !== 'pending_approval') {
    return NextResponse.json({
      error: `سند در وضعیت «${STATUS_LABELS[existing.status]}» نیست. فقط اسناد در انتظار تأیید قابل رد هستند.`,
    }, { status: 400 });
  }

  // Prevent self-rejection
  if (existing.createdById === user.id) {
    return NextResponse.json({
      error: 'شما نمی‌توانید سند خود را رد کنید.',
    }, { status: 400 });
  }

  const rejectAllowed = await getAllowedCompanyIds(user);

  const document = await runInTransaction(async (tx) => {
    // v2.20.0 — in-tx status guard (same race as approve: two concurrent
    // rejections previously both succeeded and wrote two rejection records).
    await guardInTx(tx, id, user.businessUnitId, {
      expectedStatus: ['pending_approval'],
      allowedCompanyIds: rejectAllowed,
    });

    // Update document status
    const doc = await tx.salesDocument.update({
      where: { id },
      data: {
        status: 'rejected',
        updatedById: user.id,
        // v2.45.0 — real workflow event → clear the manual stage pin
        pipelineStage: null,
        // v2.25.0 — every write bumps the CAS version
        version: { increment: 1 },
      },
    });

    // Record rejection
    await tx.salesDocumentApproval.create({
      data: {
        salesDocumentId: id,
        userId: user.id,
        action: 'rejected',
        comment: (comment as string).trim(),
      },
    });

    return doc;
  });

  // Log rejection
  await createLog(id, user.id, 'reject', {
    comment: (comment as string).trim(),
  });

  return NextResponse.json({
    success: true,
    message: 'سند فروش رد شد.',
    data: document,
  });
}

// ════════════════════════════════════════════════════════════
//  8. CANCEL — Cancel a document
// ════════════════════════════════════════════════════════════

async function handleCancel(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  // Creator can cancel their own drafts; finance can cancel any
  const canCancelOwn = perms.finance_write || perms.sales_report_write;
  if (!canCancelOwn && !perms.view_other_sales_documents) {
    return NextResponse.json({ error: 'شما دسترسی لغو سند فروش را ندارید.' }, { status: 403 });
  }

  const { id, reason = '' } = body as { id?: string; reason?: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه سند الزامی است.' }, { status: 400 });
  }

  const checkOwnership = !perms.view_other_sales_documents;
  // v2.58.7 (A4) — territory parity on cancel (fast-fail read, same as
  // update/submit-approval).
  const existing = await findDocOrThrow(id, user.businessUnitId, checkOwnership, user.id, resolveTerritoryScope(user));

  const cancelAllowed = await getAllowedCompanyIds(user);

  if (existing.status === 'cancelled') {
    return NextResponse.json({ error: 'سند قبلاً لغو شده است.' }, { status: 400 });
  }

  if (existing.status === 'approved') {
    // Only admin/finance can cancel approved documents
    if (!perms.finance_write) {
      return NextResponse.json({
        error: 'شما دسترسی لغو سند تأیید شده را ندارید.',
      }, { status: 403 });
    }
  }

  // v2.13.0 — cancelling an approved document now REVERTS its financial
  // effects: the linked accounting invoice is voided, mirrored payments and
  // loyalty points are reversed, and the center account is recomputed.
  // Cancelling an approved proforma cascades to the invoice document that
  // was derived from it (that is where the effects live).
  const document = await runInTransaction(async (tx) => {
    // v2.20.0 — in-tx status guard: double-clicked cancel, and the
    // approve-vs-cancel race (approving a document the canceller already
    // cancelled), both used the STALE outer `existing` row. The cascade
    // below now runs off the LIVE row re-read inside this transaction.
    const live = await guardInTx(tx, id, user.businessUnitId, {
      allowedCompanyIds: cancelAllowed,
    });
    if (live.status === 'cancelled') {
      throw new ApiError(400, 'سند قبلاً لغو شده است.');
    }

    const docsToCancel: Array<{ id: string; centerId: string | null; documentNumber: string | null; documentType: string; status: string }> = [live];

    if (live.documentType === 'proforma' && live.status === 'approved' && live.documentNumber) {
      // v2.25.0 — the derived invoice is located through the EXACT
      // sourceDocumentId link (set at approval time). The old
      // `description contains documentNumber` text search could sweep an
      // UNRELATED document whose description merely mentioned the number.
      // Legacy rows (created before v2.25.0) carry no link yet — they are
      // matched by EXACT string equality with the historical template the
      // approve flow used to write, never by a loose contains.
      const byId = new Map<string, { id: string; centerId: string | null; documentNumber: string | null; documentType: string; status: string }>();
      const linked = await tx.salesDocument.findMany({
        where: {
          sourceDocumentId: live.id,
          status: { not: 'cancelled' },
        },
      });
      for (const row of linked) byId.set(row.id, row);

      const legacyNeedle = `صادر شده از ${DOCUMENT_TYPE_LABELS[live.documentType]} شماره ${live.documentNumber}`;
      const legacy = await tx.salesDocument.findMany({
        where: {
          businessUnitId: live.businessUnitId,
          documentType: 'invoice',
          status: { not: 'cancelled' },
          sourceDocumentId: null,
          description: legacyNeedle, // EXACT equality — see comment above
        },
      });
      for (const row of legacy) byId.set(row.id, row);

      docsToCancel.push(...byId.values());
    }

    const revertSummary: Array<Record<string, unknown>> = [];
    const removedDispatches: Array<string | null> = [];
    for (const doc of docsToCancel) {
      if (doc.status === 'approved') {
        const reverted = await revertDocumentEffects(tx, doc, user.id, user.displayName);
        revertSummary.push({
          documentId: doc.id,
          documentNumber: doc.documentNumber,
          ...reverted,
        });
      }
      await tx.salesDocument.update({
        where: { id: doc.id },
        data: {
          status: 'cancelled',
          updatedById: user.id,
          // v2.45.0 — real workflow event → clear the manual stage pin
          // (cancelled is terminal; a stale pin would be meaningless).
          pipelineStage: null,
          // v2.25.0 — every write bumps the CAS version
          version: { increment: 1 },
        },
      });
      // v2.39.0 — a cancelled invoice must not leave an orphan سند ارسال:
      // dispatch rows that never left the warehouse («در حال آماده‌سازی»)
      // are removed inside the same transaction; ones that already moved
      // stay as history.
      removedDispatches.push(
        ...(await removePreparingShipments(tx, doc.id, user.id)),
      );
    }

    if (live.centerId) {
      await recalcCenterAccount(tx, live.centerId);
    }

    return { cancelled: docsToCancel.length, revertSummary, removedDispatches };
  });

  const updatedDoc = await db.salesDocument.findUnique({ where: { id } });

  await createLog(id, user.id, 'cancel', {
    reason: (reason as string).trim(),
    previousStatus: existing.status,
    cancelledDocuments: document.cancelled,
    revertedEffects: document.revertSummary,
    removedDispatches: document.removedDispatches,
  });

  return NextResponse.json({
    success: true,
    message: 'سند فروش با موفقیت لغو شد و آثار مالی آن برگشت خورد.',
    data: updatedDoc,
    revertedEffects: document.revertSummary,
  });
}

// ════════════════════════════════════════════════════════════
//  9. ADD-PAYMENT — Add payment record to finance
//  v2.58.4 (external audit F03/F04): a thin adapter over the SHARED
//  mutation service src/lib/cartable-payments.ts#addSalesDocumentPayment.
//  The old inline implementation accepted fractional/boolean/string
//  amounts (0.5 Rial reached the receipt path — Number() cast instead
//  of a type check), skipped the territory scope, and wrote its audit
//  log AFTER the payment committed (a log failure returned an error
//  while the money was booked; a retry created a second receipt).
// ════════════════════════════════════════════════════════════

async function handleAddPayment(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.finance_write) {
    return NextResponse.json({ error: 'شما دسترسی ثبت پرداخت را ندارید.' }, { status: 403 });
  }

  // v2.27.2 — ownership-scoped like cancel: a standard salesperson records
  // payments on THEIR OWN documents; admin / finance (view_other_sales_
  // documents) can record on any.
  const payOwnership = !perms.view_other_sales_documents;

  try {
    // SHARED strict validation (F03): zod z.number() — strings, booleans,
    // null, fractional, non-finite and over-cap amounts never reach the
    // money path; paymentDate must parse to a real date.
    const input = parseAddPaymentBody({
      ...body,
      salesDocumentId: (body as { id?: string }).id,
    });

    // SHARED mutation (F04): the document row (ownership + territory +
    // company stamp + approved status + finalAmount), the paid sum, the
    // receipt, the invoice mirror, the account recalc AND the audit log
    // all commit in ONE transaction; a client idempotency key replays
    // the stored result instead of re-charging.
    const result = await addSalesDocumentPayment(user, input, {
      statusPolicy: 'approved-only',
      businessUnitId: user.businessUnitId,
      requireOwnership: payOwnership,
      territory: resolveTerritoryScope(user),
      logAction: 'add_payment',
      idempotencyKey:
        typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
          ? body.idempotencyKey.trim().slice(0, 128)
          : null,
      source: 'sales-documents',
    });

    return NextResponse.json({
      success: true,
      message: result.replayed ? 'این پرداخت قبلاً ثبت شده بود؛ نتیجهٔ همان عملیات بازگردانده شد.' : 'پرداخت با موفقیت ثبت شد.',
      data: result.record,
      replayed: result.replayed,
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e; // the route-level catch normalizes internal errors
  }
}

// ════════════════════════════════════════════════════════════
//  10. MOVE-STAGE — v2.45.0 (r70): manual pipeline stage pin
// ════════════════════════════════════════════════════════════
// User request: «کاریز فروش — جابه‌جایی مراحل با درگ کردن و جابه‌جایی
// با موس بین ستون‌ها باشد». A card dropped on a column pins the
// document to that stage (SalesDocument.pipelineStage). null stage
// (or stage:'auto') REMOVES the pin → the board falls back to the
// derived live status (the pre-v2.45.0 behavior, unchanged).
//
// Guard rails:
//  • the terminal «لغو شده» stage is NOT pinnable — a mouse drop must
//    never fake-cancel a live document (cancel reverts finances);
//  • cancelled documents refuse moves outright (dead pipeline items);
//  • ownership: the creator / view_other_sales_documents roles only
//    (v2.58.1: territory no longer widens doc access) — cancel matrix;
//  • in-tx live-row company guard (guardInTx) — no cross-tenant pin;
//  • a full SalesDocumentLog trail (move_stage / move_stage_reset).
async function handleMoveStage(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  // The same write gate as submit-approval: every standard salesperson
  // (finance_write) may move their OWN cards; supervisors move any.
  if (!perms.finance_write && !perms.sales_report_write) {
    return NextResponse.json({ error: 'شما دسترسی جابه‌جایی سند در کاریز را ندارید.' }, { status: 403 });
  }

  const { id, stage } = body as { id?: string; stage?: string | null };

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'شناسه سند الزامی است.' }, { status: 400 });
  }

  // stage contract: a pinnable key | null | 'auto' (all → unpin).
  // Anything else — junk keys, the terminal column, wrong types — 400.
  const isUnpin = stage === null || stage === undefined || stage === 'auto' || stage === '';
  if (!isUnpin && !isPinnableStage(stage)) {
    return NextResponse.json(
      {
        error:
          stage === 'cancelled'
            ? 'ستون «لغو شده» با کشیدن کارت قابل انتخاب نیست — برای لغو سند از عملیات لغو در پروندهٔ سند استفاده کنید.'
            : 'مرحلهٔ کاریز نامعتبر است.',
      },
      { status: 400 },
    );
  }

  // Ownership matrix mirrors cancel: creator-only for standard roles
  // (v2.58.1: territory no longer widens doc access); admin/finance for
  // every doc. Territory AND-restricts the geography via the 404 parity
  // check inside findDocOrThrow.
  const checkOwnership = !perms.view_other_sales_documents;
  const existing = await findDocOrThrow(id, user.businessUnitId, checkOwnership, user.id, resolveTerritoryScope(user));

  if (existing.status === 'cancelled') {
    return NextResponse.json(
      { error: 'سند لغوشده از چرخهٔ فروش خارج است و در کاریز جابه‌جا نمی‌شود.' },
      { status: 400 },
    );
  }

  const targetStage: PipelineStageKey | null = isUnpin ? null : (stage as PipelineStageKey);
  const moveAllowed = await getAllowedCompanyIds(user);

  const document = await runInTransaction(async (tx) => {
    // Live-row guard: company scope (404 on cross-tenant) — no status
    // constraint, any live status may be pinned/unpinned.
    await guardInTx(tx, id, user.businessUnitId, { allowedCompanyIds: moveAllowed });

    return tx.salesDocument.update({
      where: { id },
      data: {
        pipelineStage: targetStage,
        updatedById: user.id,
        // v2.25.0 — every write bumps the CAS version
        version: { increment: 1 },
      },
      select: {
        id: true,
        documentNumber: true,
        status: true,
        pipelineStage: true,
        version: true,
      },
    });
  });

  await createLog(id, user.id, targetStage ? 'move_stage' : 'move_stage_reset', {
    previousPipelineStage: existing.pipelineStage ?? null,
    newStage: targetStage,
    newStageLabel: targetStage ? PIPELINE_STAGE_LABELS[targetStage] : null,
    by: 'drag-drop',
  });

  return NextResponse.json({
    success: true,
    message: targetStage
      ? `سند به مرحلهٔ «${PIPELINE_STAGE_LABELS[targetStage]}» منتقل شد.`
      : 'مرحلهٔ دستی سند برداشته شد — جای آن دوباره از وضعیت واقعی تعیین می‌شود.',
    data: document,
  });
}

// ════════════════════════════════════════════════════════════
//  11. STATS — Dashboard statistics
// ════════════════════════════════════════════════════════════

async function handleStats(user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers && !perms.view_other_sales_documents) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده آمار فروش را ندارید.' }, { status: 403 });
  }

  const buId = user.businessUnitId;

  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  // Base where for documents the user can see
  const baseWhere: Record<string, unknown> = { businessUnitId: buId };
  if (!perms.view_other_sales_documents) {
    baseWhere.createdById = user.id;
  }
  // v2.58.0 (audit 85-a #2): stats was the only handler in this file without
  // the company-isolation AND-scope every sibling handler applies — isolated
  // companies (یاس‌طب) leaked into the KPIs. Same optional-center semantics
  // as handleList: company-neutral rows stay visible.
  const statsAllowed = await getAllowedCompanyIds(user);
  const statsCompanyScope = optionalCompanyCenterWhere(statsAllowed);
  if (statsCompanyScope) baseWhere.AND = [statsCompanyScope];

  const [
    totalDocuments,
    pendingApproval,
    totalSalesAmount,
    currentMonthDocs,
    currentMonthSales,
    previousMonthDocs,
    previousMonthSales,
    approvedCount,
    rejectedCount,
    cancelledCount,
  ] = await Promise.all([
    // Total documents
    db.salesDocument.count({ where: baseWhere }),

    // Pending approval count
    db.salesDocument.count({
      where: { ...baseWhere, status: 'pending_approval' },
    }),

    // Total sales amount (approved documents)
    db.salesDocument.aggregate({
      where: { ...baseWhere, status: 'approved' },
      _sum: { finalAmount: true },
    }),

    // Current month documents
    db.salesDocument.count({
      where: { ...baseWhere, createdAt: { gte: currentMonthStart } },
    }),

    // Current month sales amount
    db.salesDocument.aggregate({
      where: { ...baseWhere, status: 'approved', createdAt: { gte: currentMonthStart } },
      _sum: { finalAmount: true },
    }),

    // Previous month documents
    db.salesDocument.count({
      where: {
        ...baseWhere,
        createdAt: { gte: previousMonthStart, lte: previousMonthEnd },
      },
    }),

    // Previous month sales amount
    db.salesDocument.aggregate({
      where: {
        ...baseWhere,
        status: 'approved',
        createdAt: { gte: previousMonthStart, lte: previousMonthEnd },
      },
      _sum: { finalAmount: true },
    }),

    // Approved count
    db.salesDocument.count({
      where: { ...baseWhere, status: 'approved' },
    }),

    // Rejected count
    db.salesDocument.count({
      where: { ...baseWhere, status: 'rejected' },
    }),

    // Cancelled count
    db.salesDocument.count({
      where: { ...baseWhere, status: 'cancelled' },
    }),
  ]);

  // Calculate month-over-month changes
  const docsChange = previousMonthDocs > 0
    ? Math.round(((currentMonthDocs - previousMonthDocs) / previousMonthDocs) * 100)
    : currentMonthDocs > 0 ? 100 : 0;

  const salesChange = (previousMonthSales._sum.finalAmount || 0) > 0
    ? Math.round(
        (((currentMonthSales._sum.finalAmount || 0) - (previousMonthSales._sum.finalAmount || 0)) /
          (previousMonthSales._sum.finalAmount || 0)) *
          100,
      )
    : (currentMonthSales._sum.finalAmount || 0) > 0
      ? 100
      : 0;

  return NextResponse.json({
    success: true,
    data: {
      totalDocuments,
      pendingApproval,
      totalSalesAmount: totalSalesAmount._sum.finalAmount || 0,
      approvedCount,
      rejectedCount,
      cancelledCount,
      currentMonth: {
        documents: currentMonthDocs,
        salesAmount: currentMonthSales._sum.finalAmount || 0,
      },
      previousMonth: {
        documents: previousMonthDocs,
        salesAmount: previousMonthSales._sum.finalAmount || 0,
      },
      monthlyComparison: {
        documents: {
          current: currentMonthDocs,
          previous: previousMonthDocs,
          changePercent: docsChange,
        },
        salesAmount: {
          current: currentMonthSales._sum.finalAmount || 0,
          previous: previousMonthSales._sum.finalAmount || 0,
          changePercent: salesChange,
        },
      },
    },
  });
}
