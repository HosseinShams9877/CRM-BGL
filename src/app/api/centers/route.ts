import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { getAllowedCompanyIds, centerCompanyWhere, resolveScopedCompanyId } from '@/lib/company-scope';
import { centerTerritoryWhere, centerInTerritory, resolveTerritoryScope } from '@/lib/territory-scope';
import { assertConcurrencyToken } from '@/lib/concurrency';
import { apiErrorMessage, apiErrorStatus, ApiError } from '@/lib/api-error';
import { parseJsonColumn } from '@/lib/json-utils';
// v2.34.11 (round 58) — shared Persian search normalization. The local
// normalizePersian/buildSearchKey moved to a lib so the list filter, the
// combobox search and the stored searchKey column all agree on ZWNJ
// semantics (word separator → space), and so the helpers are unit-tested.
import { normalizePersian, buildSearchKey, centerSearchOr } from '@/lib/center-search';
// v2.35.1 (round 61) — keyboard-layout auto-fix: a Latin-only query
// (typed while the OS layout was English) also searches its
// Persian-layout twins («shk» → «سان», «Hrhd» → «آقای»).
import { searchVariants } from '@/lib/keyboard-layout';

// ── Allowed customer-type / segment / payment-behavior values ──
const CUSTOMER_TYPES = ['organization', 'end_user'];
const SEGMENTS = ['government', 'private', 'partner'];
const PAYMENT_BEHAVIORS = ['good_payer', 'bad_payer', 'unknown'];

function safeEnum(value: unknown, allowed: string[], fallback: string): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function safeNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ── v2.14.0 — JSON-column normalization ──
// The old update handler blind-stringified whatever arrived. Clients that
// already JSON.stringify() their payload got a DOUBLE-encoded column
// (`"{\"category\":…}"`), which the single-parse read path could not
// unfold — category/website/notes silently fell back to defaults.
// JSON columns now accept an object/array (encoded exactly once) or an
// already-encoded JSON string (validated, stored as-is). Anything else is
// rejected with 400 instead of corrupting the column.
function toJsonColumn(
  fieldName: string,
  value: unknown,
  emptyValue = '',
): { ok: true; json: string } | { ok: false; error: string } {
  if (value === null || value === undefined || value === '') {
    return { ok: true, json: emptyValue }; // explicit clear
  }
  if (typeof value === 'object') {
    return { ok: true, json: JSON.stringify(value) };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { ok: true, json: emptyValue };
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return { ok: true, json: trimmed }; // already single-encoded JSON
      }
    } catch { /* fallthrough → reject */ }
    return {
      ok: false,
      error: `مقدار «${fieldName}» باید آبجکت/آرایه یا رشتهٔ JSON معتبر باشد.`,
    };
  }
  return { ok: false, error: `مقدار «${fieldName}» نامعتبر است.` };
}

/** Parse a stored JSON column with legacy double-encoding resilience. */


// ── Main POST handler ──
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده‌ است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'list') return await handleList(body, user);
    if (action === 'search') return await handleSearch(body, user);
    if (action === 'contacts-search') return await handleContactsSearch(body, user);
    if (action === 'get') return await handleGet(body, user);
    if (action === 'create') return await handleCreate(body, user);
    if (action === 'update') return await handleUpdate(body, user);
    if (action === 'favorite') return await handleFavorite(body, user);
    if (action === 'archive') return await handleArchive(body, user);
    if (action === 'unarchive') return await handleUnarchive(body, user);
    if (action === 'delete') return await handleDelete(body, user);
    if (action === 'add-contact') return await handleAddContact(body, user);
    if (action === 'remove-contact') return await handleRemoveContact(body, user);
    if (action === 'update-contact') return await handleUpdateContact(body, user);
    if (action === 'profile-notes') return await handleProfileNotes(body, user);
    if (action === 'add-profile-note') return await handleAddProfileNote(body, user);
    if (action === 'remove-profile-note') return await handleRemoveProfileNote(body, user);
    if (action === 'stats') return await handleStats(user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('centers', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  1. LIST — Paginated, searchable, filterable
// ════════════════════════════════════════════════════════
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده مراکز را ندارید.' }, { status: 403 });
  }

  const {
    search = '',
    page = 1,
    pageSize = 20,
    status,
    province,
    tags,
    customerType,
    segment,
    paymentBehavior,
  } = body as {
    search?: string;
    page?: number;
    pageSize?: number;
    status?: string;
    province?: string;
    tags?: string[];
    customerType?: string;
    segment?: string;
    paymentBehavior?: string;
  };

  const p = Math.max(1, Math.min(Number(page) || 1, 500));
  const ps = Math.max(1, Math.min(Number(pageSize) || 20, 100));
  const skip = (p - 1) * ps;

  // Build where clause
  // v2.11.1: tenant isolation — non-admins only see centers of their
  // assigned companies (businessUnitId alone is not a real tenant boundary:
  // every user shares the default "production" unit).
  const allowed = await getAllowedCompanyIds(user);
  const where: Record<string, unknown> = {
    businessUnitId: user.businessUnitId,
    ...centerCompanyWhere(allowed),
    // v2.36.0 — sales territory: scoped experts only see their provinces'
    // centers (search, list, dashboard — the filter is DB-level, so a
    // hand-crafted API call cannot read another province either).
    ...centerTerritoryWhere(resolveTerritoryScope(user)),
  };

  // Status filter
  if (status === 'active') {
    where.isArchived = false;
  } else if (status === 'archived') {
    where.isArchived = true;
  }

  // Province filter
  if (province && typeof province === 'string' && province.trim()) {
    where.province = province.trim();
  }

  // Tags filter — tags stored as JSON array string in SQLite
  if (Array.isArray(tags) && tags.length > 0) {
    where.tags = { contains: tags[0] };
  }

  // Business-model filters: مشتری نهایی / سازمانی، سگمنت B2B، خوش‌حسابی
  if (customerType && CUSTOMER_TYPES.includes(customerType)) {
    where.customerType = customerType;
  }
  if (segment && SEGMENTS.includes(segment)) {
    where.segment = segment;
  }
  if (paymentBehavior && PAYMENT_BEHAVIORS.includes(paymentBehavior)) {
    where.paymentBehavior = paymentBehavior;
  }

  // Search filter
  // v2.34.6 (round 55): searchKey is computed at API-create time, so rows
  // inserted by direct SQL import (migrations) can carry NULL searchKey and
  // used to vanish from search entirely. The name/city OR-fallback makes
  // the query resilient regardless of how the row was born.
  // v2.34.11 (round 58): the OR-set comes from the shared centerSearchOr —
  // ZWNJ normalizes to a space on both sides, and province joins the match.
  if (search && typeof search === 'string' && search.trim()) {
    where.OR = centerSearchOr(search);
  }

  const [centers, total] = await Promise.all([
    db.center.findMany({
      where,
      select: {
        id: true,
        name: true,
        province: true,
        city: true,
        phone: true,
        mobile: true,
        customerType: true,
        segment: true,
        loyaltyPoints: true,
        creditScore: true,
        paymentBehavior: true,
        commissionPercent: true,
        status: true,
        isArchived: true,
        tags: true,
        customFields: true, // v2.14.0 — category/website/notes live here; the list view needs them
        createdAt: true,
        updatedAt: true,
        // v2.31.9 — Lian proforma format: buyer identity block (مشخصات
        // خریدار) pre-fills the data-entry form; address joins the snapshot
        // source. company.slug lets the form switch the seller card to the
        // center's owning company.
        address: true,
        nationalId: true,
        economicCode: true,
        postalCode: true,
        contactName: true,
        company: { select: { slug: true, name: true } },
        // v2.26.2 — numeric CAS token: without it the edit dialog's primary
        // token was null and every edit fell back to the DEPRECATED
        // 1000ms-tolerance path (two saves within one second could both
        // pass — the exact flaw v2.25.0's exact-compare CAS removed).
        version: true,
        extraContacts: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, centerId: true, title: true, person: true, phone: true, notes: true, isAgent: true, personality: true, createdByName: true, createdAt: true },
        },
        _count: { select: { accounts: true, activities: true, extraContacts: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip,
      take: ps,
    }),
    db.center.count({ where }),
  ]);

  const totalPages = Math.ceil(total / ps);

  return NextResponse.json({
    success: true,
    data: centers,
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

// ════════════════════════════════════════════════════════
//  2. GET — Single center with relations
// ════════════════════════════════════════════════════════
// v2.34.0 — lightweight center search for the QuickActivity combobox.
// Same permission + tenant scope as handleList, minimal payload.
async function handleSearch(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده مراکز را ندارید.' }, { status: 403 });
  }
  const { q = '', pageSize = 20 } = body as { q?: string; pageSize?: number };
  const ps = Math.max(1, Math.min(Number(pageSize) || 20, 50));
  const allowed = await getAllowedCompanyIds(user);
  const raw = String(q).trim();
  const where: Record<string, unknown> = {
    businessUnitId: user.businessUnitId,
    ...centerCompanyWhere(allowed),
    // v2.36.0 — territory scope (same rule as handleList)
    ...centerTerritoryWhere(resolveTerritoryScope(user)),
    isArchived: false,
  };
  if (raw) {
    // v2.34.11 (round 58) — the combobox used to match name/city with a
    // partial character map only: ZWNJ-spelled names («مرکز ام‌البنین»)
    // were unreachable, and phones/provinces never matched. It now shares
    // the list handler's centerSearchOr (searchKey + name + city +
    // province, ZWNJ → space on both sides).
    where.OR = centerSearchOr(raw);
  }
  const centers = await db.center.findMany({
    where,
    // v2.38.0 (round 64) — the quick-proforma buyer card now uses this
    // combobox: picking a center pre-fills «مشخصات خریدار» straight from
    // the search row (identity block + owning company for the seller
    // card), so the select grew from the bare name/city tuple. Additive —
    // the quick-activity combobox simply ignores the extra fields.
    select: {
      id: true, name: true, city: true, province: true,
      nationalId: true, economicCode: true, postalCode: true,
      contactName: true, address: true, phone: true, mobile: true,
      company: { select: { slug: true, name: true } },
    },
    orderBy: [{ name: 'asc' }],
    take: ps,
  });
  return NextResponse.json({ centers });
}

// v2.34.0 — global contact-person search (spec §9: clicking a person shows
// that person in the contacts tab). Person scope = center scope of the user.
async function handleContactsSearch(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده مراکز را ندارید.' }, { status: 403 });
  }
  const { q = '', pageSize = 20 } = body as { q?: string; pageSize?: number };
  const raw = String(q).trim();
  if (raw.length < 2) return NextResponse.json({ contacts: [] });
  const ps = Math.max(1, Math.min(Number(pageSize) || 20, 50));
  // v2.34.11 (round 58) — full shared normalization (ZWNJ → space, ة → ه,
  // Arabic ی/ك) instead of the partial ي/ك map: person names spelled with
  // نیم‌فاصله («سید‌محمد») now match their space-typed form and vice versa.
  // v2.35.1 (round 61) — the Latin-layout twins join the same OR set, so a
  // contact person typed on the English keyboard («pldk» for «حمید»,
  // «Hrhd» for «آقای») is found too.
  const norm = normalizePersian(raw);
  // raw keeps matching un-normalized stored text exactly as before
  // (round-58 semantics); the Persian-layout twins only ever ADD rows.
  const twins = searchVariants(raw).slice(1).map((v) => normalizePersian(v));
  const personVariants = [norm, raw, ...twins];
  const allowed = await getAllowedCompanyIds(user);
  const centers = await db.center.findMany({
    where: {
      businessUnitId: user.businessUnitId,
      ...centerCompanyWhere(allowed),
      // v2.36.0 — contact search inherits the territory scope
      ...centerTerritoryWhere(resolveTerritoryScope(user)),
    },
    select: {
      id: true, name: true,
      extraContacts: {
        where: {
          OR: [
            ...personVariants.map((v) => ({ person: { contains: v } })),
            ...personVariants.map((v) => ({ title: { contains: v } })),
            { phone: { contains: raw } },
          ],
        },
        select: { id: true, centerId: true, title: true, person: true, phone: true },
        take: ps,
      },
    },
  });
  const contacts = centers
    .flatMap((c) => c.extraContacts.map((p) => ({ ...p, centerName: c.name })))
    .slice(0, ps);
  return NextResponse.json({ contacts });
}

async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده مراکز را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه مرکز الزامی است.' }, { status: 400 });
  }

  // v2.11.1: tenant isolation on single-center reads
  // v2.36.0: + territory — a center outside the expert's provinces is
  // simply NOT found (404, no existence leak).
  const center = await db.center.findFirst({
    where: {
      id,
      businessUnitId: user.businessUnitId,
      ...centerCompanyWhere(await getAllowedCompanyIds(user)),
      ...centerTerritoryWhere(resolveTerritoryScope(user)),
    },
    include: {
      accounts: { orderBy: { updatedAt: 'desc' } },
      extraContacts: { orderBy: { createdAt: 'desc' } },
      activities: {
        orderBy: { activityDate: 'desc' },
        take: 10,
        include: {
          assignedUser: { select: { id: true, displayName: true } },
          creator: { select: { id: true, displayName: true } },
        },
      },
      loyaltyTransactions: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });

  if (!center) {
    return NextResponse.json({ error: 'مرکز یافت نشد.' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: center });
}

// ════════════════════════════════════════════════════════
//  3. CREATE — New center
// ════════════════════════════════════════════════════════
async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.create_centers) {
    return NextResponse.json({ error: 'شما دسترسی ایجاد مرکز را ندارید.' }, { status: 403 });
  }

  const { name, province, city, address, phone, mobile, tags, customFields, customerType, segment, paymentBehavior, creditScore, commissionPercent, companySlug,
    // v2.31.9 — buyer identity block (Lian proforma format)
    nationalId, economicCode, postalCode, contactName } = body as {
    name?: string;
    province?: string;
    city?: string;
    address?: string;
    phone?: string;
    mobile?: string;
    tags?: string[];
    customFields?: Record<string, unknown>;
    customerType?: string;
    segment?: string;
    paymentBehavior?: string;
    creditScore?: number;
    commissionPercent?: number;
    companySlug?: string;
    nationalId?: string;
    economicCode?: string;
    postalCode?: string;
    contactName?: string;
  };

  if (!name || !name.trim()) {
    return NextResponse.json({ error: 'نام مرکز الزامی است.' }, { status: 400 });
  }

  // v2.14.0 — JSON columns are normalized ONCE here (object or pre-encoded
  // JSON string both accepted); the old path could not take customFields at
  // create time at all, which forced the form into a fragile second update
  // call whose failure was silently swallowed.
  const tagsCol = toJsonColumn('tags', Array.isArray(tags) ? tags : (tags ?? []), '[]');
  if (!tagsCol.ok) {
    return NextResponse.json({ error: tagsCol.error }, { status: 400 });
  }
  const customCol = customFields === undefined
    ? { ok: true as const, json: '{}' }
    : toJsonColumn('customFields', customFields, '{}');
  if (!customCol.ok) {
    return NextResponse.json({ error: customCol.error }, { status: 400 });
  }

  const centerData: {
    name: string;
    province: string | null;
    city: string | null;
    address: string | null;
    phone: string | null;
    mobile: string | null;
    customerType: string;
    segment: string;
    paymentBehavior: string;
    creditScore: number;
    commissionPercent: number;
    tags: string;
    customFields: string;
    businessUnitId: string;
    companyId: string | undefined;
    createdBy: string;
    updatedBy: string;
    // v2.31.9 — buyer identity block (Lian proforma format)
    nationalId: string | null;
    economicCode: string | null;
    postalCode: string | null;
    contactName: string | null;
  } = {
    name: name.trim(),
    province: province?.trim() || null,
    city: city?.trim() || null,
    address: address?.trim() || null,
    phone: phone?.trim() || null,
    mobile: mobile?.trim() || null,
    customerType: safeEnum(customerType, CUSTOMER_TYPES, 'organization'),
    segment: typeof segment === 'string' && SEGMENTS.includes(segment) ? segment : '',
    paymentBehavior: safeEnum(paymentBehavior, PAYMENT_BEHAVIORS, 'unknown'),
    creditScore: Math.max(0, Math.min(100, Math.round(safeNumber(creditScore, 0)))),
    commissionPercent: Math.max(0, Math.min(100, safeNumber(commissionPercent, 0))),
    tags: tagsCol.json,
    customFields: customCol.json,
    businessUnitId: user.businessUnitId,
    companyId: undefined, // resolved below (v2.11.1 tenant isolation)
    createdBy: user.id,
    updatedBy: user.id,
    nationalId: nationalId?.trim() || null,
    economicCode: economicCode?.trim() || null,
    postalCode: postalCode?.trim() || null,
    contactName: contactName?.trim() || null,
  };

  // Resolve a REAL company id — the schema default ("bazargani") does not match
  // seeded cuid ids and would violate the foreign key.
  // v2.13.0: assignment goes through resolveScopedCompanyId — explicit slug
  // (validated against the user's assignment) or the user's FIRST allowed
  // company in assignment order. The legacy fallbacks ("first allowed id in
  // arbitrary query order" / "first active company" even for scoped users)
  // filed new customers under unpredictable companies.
  const resolvedCompany = await resolveScopedCompanyId(user, typeof companySlug === 'string' ? companySlug : undefined);
  if (!resolvedCompany.ok) {
    return NextResponse.json({ error: resolvedCompany.error }, { status: resolvedCompany.status });
  }
  if (resolvedCompany.companyId) {
    centerData.companyId = resolvedCompany.companyId;
  } else if (await getAllowedCompanyIds(user) !== null) {
    // scoped user with an empty assignment — cannot attribute the row
    return NextResponse.json(
      { error: 'هیچ شرکتی به شما اختصاص داده نشده است؛ ایجاد مرکز ممکن نیست.' },
      { status: 403 },
    );
  }
  // admin with no active company in the system — leave companyId undefined
  // (legacy behaviour preserved for the empty-database edge case)

  // v2.36.0 — territory gate: a scoped expert can only CREATE centers
  // inside their own territory (a center born outside would be invisible
  // to its own creator and orphan the data-entry flow).
  const createTerritory = resolveTerritoryScope(user);
  if (createTerritory) {
    if (createTerritory.mode === 'centers') {
      return NextResponse.json(
        { error: 'در حالت «انتخاب مراکز خاص» امکان ایجاد مرکز جدید وجود ندارد؛ محدوده را به استان‌هایی تغییر دهید که شامل مرکز جدید می‌شود.' },
        { status: 403 },
      );
    }
    if (!centerData.province || !createTerritory.provinces.includes(centerData.province)) {
      return NextResponse.json(
        { error: `استان «${centerData.province || 'نامشخص'}» در محدودهٔ فروش شما نیست.` },
        { status: 403 },
      );
    }
  }

  // Pre-compute searchKey
  const searchKey = buildSearchKey(centerData);

  const center = await db.center.create({
    data: { ...centerData, searchKey },
  });

  return NextResponse.json({
    success: true,
    message: 'مرکز با موفقیت ایجاد شد.',
    data: center,
  });
}

// ════════════════════════════════════════════════════════
//  4. UPDATE — Edit center fields
// ════════════════════════════════════════════════════════
async function handleUpdate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.edit_centers) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش مراکز را ندارید.' }, { status: 403 });
  }

  const { id, expectedVersion, ...fields } = body as {
    id: string;
    expectedVersion?: number | string | null;
    [key: string]: unknown;
  };
  if (!id) {
    return NextResponse.json({ error: 'شناسه مرکز الزامی است.' }, { status: 400 });
  }

  // Verify center belongs to user's business unit (+ v2.11.1 company scope)
  const allowedIds = await getAllowedCompanyIds(user);
  // v2.36.0 — mutations carry the territory predicate too: an
  // out-of-territory center is not found → 404 (fail-closed).
  const scopeWhere = { id, businessUnitId: user.businessUnitId, ...centerCompanyWhere(allowedIds), ...centerTerritoryWhere(resolveTerritoryScope(user)) };
  const existing = await db.center.findFirst({
    where: scopeWhere,
  });
  if (!existing) {
    return NextResponse.json({ error: 'مرکز یافت نشد.' }, { status: 404 });
  }

  // Build update payload — only allow known fields
  const allowedFields = ['name', 'province', 'city', 'address', 'phone', 'mobile', 'tags', 'customFields',
    'customerType', 'segment', 'paymentBehavior', 'creditScore', 'commissionPercent',
    // v2.31.9 — buyer identity block (Lian proforma format)
    'nationalId', 'economicCode', 'postalCode', 'contactName'];
  const updateData: Record<string, unknown> = {
    updatedBy: user.id,
    // v2.25.0 — every write bumps the numeric CAS version
    version: { increment: 1 },
  };

  for (const field of allowedFields) {
    if (fields[field] !== undefined) {
      if (field === 'tags' || field === 'customFields') {
        // v2.14.0 — encode exactly once; never blind-stringify a string
        // payload (the category/website/notes double-JSON bug)
        const normalized = toJsonColumn(field, fields[field], field === 'tags' ? '[]' : '{}');
        if (!normalized.ok) {
          return NextResponse.json({ error: normalized.error }, { status: 400 });
        }
        updateData[field] = normalized.json;
      } else if (field === 'customerType') {
        updateData[field] = safeEnum(fields[field], CUSTOMER_TYPES, 'organization');
      } else if (field === 'segment') {
        const s = fields[field];
        updateData[field] = typeof s === 'string' && SEGMENTS.includes(s) ? s : '';
      } else if (field === 'paymentBehavior') {
        updateData[field] = safeEnum(fields[field], PAYMENT_BEHAVIORS, 'unknown');
      } else if (field === 'creditScore') {
        updateData[field] = Math.max(0, Math.min(100, Math.round(safeNumber(fields[field], 0))));
      } else if (field === 'commissionPercent') {
        updateData[field] = Math.max(0, Math.min(100, safeNumber(fields[field], 0)));
      } else if (typeof fields[field] === 'string') {
        updateData[field] = (fields[field] as string).trim() || null;
      }
    }
  }

  // Rebuild searchKey if relevant text fields changed
  if (
    updateData.name !== undefined ||
    updateData.province !== undefined ||
    updateData.city !== undefined ||
    updateData.phone !== undefined ||
    updateData.mobile !== undefined ||
    updateData.address !== undefined
  ) {
    const merged = {
      name: (updateData.name as string | null | undefined) ?? existing.name,
      province: (updateData.province as string | null | undefined) ?? existing.province,
      city: (updateData.city as string | null | undefined) ?? existing.city,
      phone: (updateData.phone as string | null | undefined) ?? existing.phone,
      mobile: (updateData.mobile as string | null | undefined) ?? existing.mobile,
      address: (updateData.address as string | null | undefined) ?? existing.address,
    };
    updateData.searchKey = buildSearchKey(merged);
  }

  // v2.23.0 — the write lands inside a transaction with a live re-read:
  // (a) a concurrent edit between the pre-check above and this write is
  // detected via the concurrency token → 409 (never a silent lost update);
  // (b) a concurrent delete/unarchive-archive turns into a clean 404.
  // v2.25.0 — the token is now the EXACT numeric CAS `version` (the old
  // 1000ms updatedAt tolerance let two saves inside one second both pass);
  // a missing token answers 428 (edit paths require it).
  let center;
  try {
    center = await db.$transaction(async (tx) => {
      const live = await tx.center.findFirst({
        where: scopeWhere,
        select: { id: true, updatedAt: true, version: true, customFields: true },
      });
      if (!live) throw new ApiError(404, 'مرکز یافت نشد.');

      assertConcurrencyToken({
        expectedVersion: expectedVersion ?? null,
        liveVersion: live.version,
        entityLabel: 'مرکز',
        required: true,
      });

      return await tx.center.update({
        where: { id },
        data: updateData,
      });
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  return NextResponse.json({
    success: true,
    message: 'مرکز با موفقیت به‌روزرسانی شد.',
    data: center,
  });
}

// ════════════════════════════════════════════════════════
//  4b. FAVORITE (v2.23.0)
// ════════════════════════════════════════════════════════
// The heart button on center cards used to be client-only state — the
// star filled, the «مورد علاقه» KPI counted it, and a reload wiped
// everything (no column, no API). The flag now lives inside the existing
// customFields JSON and is toggled atomically: read-modify-write inside
// ONE transaction so two concurrent toggles can never lose each other's
// change (last-write-wins on the whole JSON blob would).
async function handleFavorite(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.edit_centers) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش مراکز را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه مرکز الزامی است.' }, { status: 400 });
  }

  const allowedIds = await getAllowedCompanyIds(user);
  // v2.36.0 — mutations carry the territory predicate too: an
  // out-of-territory center is not found → 404 (fail-closed).
  const scopeWhere = { id, businessUnitId: user.businessUnitId, ...centerCompanyWhere(allowedIds), ...centerTerritoryWhere(resolveTerritoryScope(user)) };

  let center;
  try {
    center = await db.$transaction(async (tx) => {
      const live = await tx.center.findFirst({
        where: scopeWhere,
        select: { id: true, customFields: true },
      });
      if (!live) throw new ApiError(404, 'مرکز یافت نشد.');

      // customFields is a JSON string column («{...}»); parse defensively —
      // legacy rows may hold '' or malformed content.
      let extra: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(live.customFields || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          extra = parsed as Record<string, unknown>;
        }
      } catch { /* keep {} */ }

      const next = !extra.isFavorite;
      const merged = JSON.stringify({ ...extra, isFavorite: next });
      return await tx.center.update({
        where: { id },
        data: { customFields: merged, updatedBy: user.id, version: { increment: 1 } },
      });
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  return NextResponse.json({
    success: true,
    isFavorite: isFavoriteOf(center.customFields),
    message: 'وضعیت نشان‌کردن مرکز به‌روزرسانی شد.',
  });
}

/** Read the isFavorite flag out of a customFields JSON string. */
function isFavoriteOf(customFields: string | null | undefined): boolean {
  try {
    const parsed = JSON.parse(customFields || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Boolean((parsed as Record<string, unknown>).isFavorite);
    }
  } catch { /* ignore */ }
  return false;
}

// ════════════════════════════════════════════════════════
//  5. ARCHIVE
// ════════════════════════════════════════════════════════
async function handleArchive(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.archive_centers && !perms.edit_centers) {
    return NextResponse.json({ error: 'شما دسترسی بایگانی مراکز را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه مرکز الزامی است.' }, { status: 400 });
  }

  // v2.11.1: tenant isolation — lookup includes the user's company scope
  const allowedIds = await getAllowedCompanyIds(user);
  const existing = await db.center.findFirst({
    where: { id, businessUnitId: user.businessUnitId, ...centerCompanyWhere(allowedIds), ...centerTerritoryWhere(resolveTerritoryScope(user)) },
  });
  if (!existing) {
    return NextResponse.json({ error: 'مرکز یافت نشد.' }, { status: 404 });
  }

  const center = await db.center.update({
    where: { id },
    data: {
      isArchived: true,
      status: 'archived',
      updatedBy: user.id,
      version: { increment: 1 },
    },
  });

  return NextResponse.json({
    success: true,
    message: 'مرکز با موفقیت بایگانی شد.',
    data: center,
  });
}

// ════════════════════════════════════════════════════════
//  6. UNARCHIVE
// ════════════════════════════════════════════════════════
async function handleUnarchive(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.archive_centers && !perms.edit_centers) {
    return NextResponse.json({ error: 'شما دسترسی بازیابی مراکز را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه مرکز الزامی است.' }, { status: 400 });
  }

  // v2.11.1: tenant isolation — lookup includes the user's company scope
  const allowedIds = await getAllowedCompanyIds(user);
  const existing = await db.center.findFirst({
    where: { id, businessUnitId: user.businessUnitId, ...centerCompanyWhere(allowedIds), ...centerTerritoryWhere(resolveTerritoryScope(user)) },
  });
  if (!existing) {
    return NextResponse.json({ error: 'مرکز یافت نشد.' }, { status: 404 });
  }

  const center = await db.center.update({
    where: { id },
    data: {
      isArchived: false,
      status: 'active',
      updatedBy: user.id,
    },
  });

  return NextResponse.json({
    success: true,
    message: 'مرکز با موفقیت از بایگانی خارج شد.',
    data: center,
  });
}

// ════════════════════════════════════════════════════════
//  7. DELETE — Soft delete (archive)
// ════════════════════════════════════════════════════════
async function handleDelete(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.archive_centers && !perms.edit_centers) {
    return NextResponse.json({ error: 'شما دسترسی حذف مراکز را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه مرکز الزامی است.' }, { status: 400 });
  }

  // v2.11.1: tenant isolation — lookup includes the user's company scope
  const allowedIds = await getAllowedCompanyIds(user);
  const existing = await db.center.findFirst({
    where: { id, businessUnitId: user.businessUnitId, ...centerCompanyWhere(allowedIds), ...centerTerritoryWhere(resolveTerritoryScope(user)) },
  });
  if (!existing) {
    return NextResponse.json({ error: 'مرکز یافت نشد.' }, { status: 404 });
  }

  const center = await db.center.update({
    where: { id },
    data: {
      isArchived: true,
      status: 'archived',
      updatedBy: user.id,
      version: { increment: 1 },
    },
  });

  return NextResponse.json({
    success: true,
    message: 'مرکز با موفقیت حذف شد (بایگانی).',
    data: center,
  });
}

// ════════════════════════════════════════════════════════
//  8. ADD-CONTACT — Add extra contact to center
// ════════════════════════════════════════════════════════
async function handleAddContact(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.edit_centers) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش مراکز را ندارید.' }, { status: 403 });
  }

  const { centerId, title, person, phone, notes, isAgent, personality } = body as {
    centerId?: string;
    title?: string;
    person?: string;
    phone?: string;
    notes?: string;
    isAgent?: boolean;
    personality?: Record<string, unknown>;
  };

  if (!centerId || !title?.trim() || !phone?.trim()) {
    return NextResponse.json(
      { error: 'شناسه مرکز، عنوان سمت و شماره تماس الزامی است.' },
      { status: 400 },
    );
  }

  // Verify center belongs to user's business unit (+ v2.11.1 company scope
  // + v2.36.0 territory scope)
  const center = await db.center.findFirst({
    where: {
      id: centerId,
      businessUnitId: user.businessUnitId,
      ...centerCompanyWhere(await getAllowedCompanyIds(user)),
      ...centerTerritoryWhere(resolveTerritoryScope(user)),
    },
  });
  if (!center) {
    return NextResponse.json({ error: 'مرکز یافت نشد.' }, { status: 404 });
  }

  const contact = await db.centerContact.create({
    data: {
      centerId,
      title: title.trim(),
      person: person?.trim() || null,
      phone: phone.trim(),
      notes: notes?.trim() || null,
      isAgent: Boolean(isAgent),
      personality: JSON.stringify(personality && typeof personality === 'object' ? personality : {}),
      createdBy: user.id,
      createdByName: user.displayName,
    },
  });

  return NextResponse.json({
    success: true,
    message: 'اطلاعات تماس با موفقیت اضافه شد.',
    data: contact,
  });
}

// ════════════════════════════════════════════════════════
//  8-b. UPDATE-CONTACT — edit contact + رگ خواب (personality)
//  v2.24.0 — the write moved INSIDE a transaction with a live re-read:
//  a concurrent edit between the pre-check and the write is caught via
//  the expectedVersion CAS token → 409 Persian (never a silent
//  last-write-wins), and the tenant predicates (business unit + company)
//  are re-verified on the LIVE row so a contact moved/deleted mid-flight
//  turns into a clean 404 instead of a stale write.
// ════════════════════════════════════════════════════════
async function handleUpdateContact(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.edit_centers) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش مراکز را ندارید.' }, { status: 403 });
  }

  const { contactId, expectedVersion, title, person, phone, notes, isAgent, personality } = body as {
    contactId?: string;
    expectedVersion?: number | string | null;
    title?: string;
    person?: string;
    phone?: string;
    notes?: string;
    isAgent?: boolean;
    personality?: Record<string, unknown>;
  };
  if (!contactId) {
    return NextResponse.json({ error: 'شناسه تماس الزامی است.' }, { status: 400 });
  }

  const contact = await db.centerContact.findFirst({
    where: { id: contactId },
    include: { center: { select: { id: true, businessUnitId: true, companyId: true, province: true } } },
  });
  if (!contact || contact.center.businessUnitId !== user.businessUnitId) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }
  // v2.11.1: company tenant gate — out-of-scope contacts are reported as
  // not found (no existence leak)
  const allowedIds = await getAllowedCompanyIds(user);
  if (allowedIds !== null && !allowedIds.includes(contact.center.companyId)) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }
  // v2.36.0: territory gate — contacts of an out-of-territory center read
  // as not found (same fail-closed rule as the company gate)
  if (!centerInTerritory(contact.center, resolveTerritoryScope(user))) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }

  const updateData: Record<string, unknown> = { version: { increment: 1 } };
  if (title !== undefined && String(title).trim()) updateData.title = String(title).trim();
  if (person !== undefined) updateData.person = String(person).trim() || null;
  if (phone !== undefined && String(phone).trim()) updateData.phone = String(phone).trim();
  if (notes !== undefined) updateData.notes = String(notes).trim() || null;
  if (isAgent !== undefined) updateData.isAgent = Boolean(isAgent);
  if (personality !== undefined && personality && typeof personality === 'object') {
    updateData.personality = JSON.stringify(personality);
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ success: true, message: 'اطلاعات تماس به‌روزرسانی شد.', data: contact });
  }

  // v2.24.0 — tenant predicates re-applied on the LIVE row inside the tx
  const liveScopeWhere = {
    id: contactId,
    center: {
      businessUnitId: user.businessUnitId,
      ...(allowedIds !== null ? { companyId: { in: allowedIds } } : {}),
    },
  };

  let updated;
  try {
    updated = await db.$transaction(async (tx) => {
      const live = await tx.centerContact.findFirst({
        where: liveScopeWhere,
        select: { id: true, updatedAt: true, version: true },
      });
      if (!live) throw new ApiError(404, 'تماس یافت نشد.');

      // v2.25.0 — exact numeric CAS (supersedes the 1000ms updatedAt
      // tolerance); a missing token answers 428 on edit paths.
      assertConcurrencyToken({
        expectedVersion: expectedVersion ?? null,
        liveVersion: live.version,
        entityLabel: 'اطلاعات تماس',
        required: true,
      });

      return await tx.centerContact.update({ where: { id: contactId }, data: updateData });
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  return NextResponse.json({ success: true, message: 'اطلاعات تماس به‌روزرسانی شد.', data: updated });
}

// ════════════════════════════════════════════════════════
//  8-c. PROFILE-NOTES — رگ خواب: list personality notes of a contact
// ════════════════════════════════════════════════════════
async function handleProfileNotes(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده مراکز را ندارید.' }, { status: 403 });
  }

  const { contactId } = body as { contactId?: string };
  if (!contactId) {
    return NextResponse.json({ error: 'شناسه تماس الزامی است.' }, { status: 400 });
  }

  const contact = await db.centerContact.findFirst({
    where: { id: contactId },
    include: { center: { select: { id: true, businessUnitId: true, companyId: true, province: true } } },
  });
  if (!contact || contact.center.businessUnitId !== user.businessUnitId) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }
  // v2.11.1: company tenant gate — out-of-scope contacts are reported as
  // not found (no existence leak)
  const allowedIds = await getAllowedCompanyIds(user);
  if (allowedIds !== null && !allowedIds.includes(contact.center.companyId)) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }
  // v2.36.0: territory gate — contacts of an out-of-territory center read
  // as not found (same fail-closed rule as the company gate)
  if (!centerInTerritory(contact.center, resolveTerritoryScope(user))) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }

  const notes = await db.contactProfileNote.findMany({
    where: { contactId },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ success: true, data: notes });
}

// ════════════════════════════════════════════════════════
//  8-d. ADD-PROFILE-NOTE — رگ خواب: add observation entry
// ════════════════════════════════════════════════════════
const PROFILE_NOTE_CATEGORIES = ['trait', 'interest', 'sensitivity', 'communication', 'general'];

async function handleAddProfileNote(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.edit_centers) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش مراکز را ندارید.' }, { status: 403 });
  }

  const { contactId, category, content } = body as { contactId?: string; category?: string; content?: string };
  if (!contactId || !content?.trim()) {
    return NextResponse.json({ error: 'شناسه تماس و متن مشاهده الزامی است.' }, { status: 400 });
  }

  const contact = await db.centerContact.findFirst({
    where: { id: contactId },
    include: { center: { select: { id: true, businessUnitId: true, companyId: true, province: true } } },
  });
  if (!contact || contact.center.businessUnitId !== user.businessUnitId) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }
  // v2.11.1: company tenant gate — out-of-scope contacts are reported as
  // not found (no existence leak)
  const allowedIds = await getAllowedCompanyIds(user);
  if (allowedIds !== null && !allowedIds.includes(contact.center.companyId)) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }
  // v2.36.0: territory gate — contacts of an out-of-territory center read
  // as not found (same fail-closed rule as the company gate)
  if (!centerInTerritory(contact.center, resolveTerritoryScope(user))) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }

  const note = await db.contactProfileNote.create({
    data: {
      contactId,
      category: typeof category === 'string' && PROFILE_NOTE_CATEGORIES.includes(category) ? category : 'general',
      content: content.trim(),
      createdBy: user.id,
      createdByName: user.displayName,
    },
  });

  return NextResponse.json({ success: true, message: 'مشاهدهٔ جدید ثبت شد.', data: note });
}

// ════════════════════════════════════════════════════════
//  8-e. REMOVE-PROFILE-NOTE — رگ خواب: delete an entry
// ════════════════════════════════════════════════════════
async function handleRemoveProfileNote(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.edit_centers) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش مراکز را ندارید.' }, { status: 403 });
  }

  const { noteId } = body as { noteId?: string };
  if (!noteId) {
    return NextResponse.json({ error: 'شناسه یادداشت الزامی است.' }, { status: 400 });
  }

  const note = await db.contactProfileNote.findFirst({
    where: { id: noteId },
    include: { contact: { include: { center: { select: { id: true, businessUnitId: true, companyId: true, province: true } } } } },
  });
  if (!note || note.contact.center.businessUnitId !== user.businessUnitId) {
    return NextResponse.json({ error: 'یادداشت یافت نشد.' }, { status: 404 });
  }
  // v2.11.1: company tenant gate — 404 to avoid leaking existence
  const allowedIds = await getAllowedCompanyIds(user);
  if (allowedIds !== null && !allowedIds.includes(note.contact.center.companyId)) {
    return NextResponse.json({ error: 'یادداشت یافت نشد.' }, { status: 404 });
  }
  // v2.36.0: territory gate
  if (!centerInTerritory(note.contact.center, resolveTerritoryScope(user))) {
    return NextResponse.json({ error: 'یادداشت یافت نشد.' }, { status: 404 });
  }

  await db.contactProfileNote.delete({ where: { id: noteId } });
  return NextResponse.json({ success: true, message: 'یادداشت حذف شد.' });
}

// ════════════════════════════════════════════════════════
//  9. REMOVE-CONTACT — Remove extra contact
// ════════════════════════════════════════════════════════
async function handleRemoveContact(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.edit_centers) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش مراکز را ندارید.' }, { status: 403 });
  }

  const { contactId } = body as { contactId?: string };
  if (!contactId) {
    return NextResponse.json({ error: 'شناسه تماس الزامی است.' }, { status: 400 });
  }

  // Verify the contact belongs to a center in the user's business unit
  // v2.24.0: companyId selected too — the v2.11.1 company tenant gate was
  // missing here (every sibling action had it), so a user of company A
  // could hard-delete a contact of company B inside the same business
  // unit. Out-of-scope is reported as 404 (no existence leak).
  const contact = await db.centerContact.findFirst({
    where: { id: contactId },
    include: { center: { select: { id: true, businessUnitId: true, companyId: true, province: true } } },
  });

  if (!contact || contact.center.businessUnitId !== user.businessUnitId) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }
  const allowedIds = await getAllowedCompanyIds(user);
  if (allowedIds !== null && !allowedIds.includes(contact.center.companyId)) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }
  // v2.36.0: territory gate — same fail-closed rule as above
  if (!centerInTerritory(contact.center, resolveTerritoryScope(user))) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }

  await db.centerContact.delete({ where: { id: contactId } });

  return NextResponse.json({
    success: true,
    message: 'اطلاعات تماس با موفقیت حذف شد.',
  });
}

// ════════════════════════════════════════════════════════
//  10. STATS — Dashboard statistics
// ════════════════════════════════════════════════════════
async function handleStats(user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده آمار مراکز را ندارید.' }, { status: 403 });
  }

  const buId = user.businessUnitId;

  // v2.11.1: tenant isolation — every stat is scoped to the user's companies
  // v2.36.0: …and to the sales territory (dashboard numbers follow the
  // expert's provinces, not the whole company).
  const allowed = await getAllowedCompanyIds(user);
  const scopeFilter = { ...centerCompanyWhere(allowed), ...centerTerritoryWhere(resolveTerritoryScope(user)) };
  const companyFilter = scopeFilter;

  // Start of current month (Gregorian)
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalCenters,
    activeCenters,
    newThisMonth,
    overdueAccounts,
    individuals,
    organizations,
  ] = await Promise.all([
    // Total centers (including archived)
    db.center.count({ where: { businessUnitId: buId, ...companyFilter } }),

    // Active (non-archived) centers
    db.center.count({ where: { businessUnitId: buId, isArchived: false, ...companyFilter } }),

    // New centers created this month
    db.center.count({
      where: {
        businessUnitId: buId,
        createdAt: { gte: startOfMonth },
        ...companyFilter,
      },
    }),

    // Overdue accounts — invoices that are issued but not fully paid
    // and their due date has passed
    db.issuedInvoice.count({
      where: {
        status: 'issued',
        dueDate: { lt: now },
        centerAccount: { center: { businessUnitId: buId, ...companyFilter } },
      },
    }),

    // مشتریان نهایی (اشخاص حقیقی)
    db.center.count({ where: { businessUnitId: buId, customerType: 'end_user', isArchived: false, ...companyFilter } }),

    // مشتریان سازمانی
    db.center.count({ where: { businessUnitId: buId, customerType: 'organization', isArchived: false, ...companyFilter } }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      totalCenters,
      activeCenters,
      newThisMonth,
      overdueAccounts,
      individuals,
      organizations,
    },
  });
}
