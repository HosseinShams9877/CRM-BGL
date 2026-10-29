import { db } from '@/lib/db';
import type { AuthUser } from '@/lib/auth';
import { ApiError } from '@/lib/api-error';
import { getCanonicalRole } from '@/lib/roles';

/** v2.58.4 (user issue 4) — role decisions NEVER read user.role raw:
 *  a legacy DB row ('administrator') must behave exactly like 'admin'. */
function isAdminUser(user: AuthUser): boolean {
  return getCanonicalRole(user.role) === 'admin';
}

/**
 * Tenant-isolation helpers (v2.11.1 — second-round security audit;
 * extended in v2.12.0 for the operational routes).
 *
 * Users carry their allowed companies as SLUGS (User.companyIds, JSON array),
 * while rows reference companies by ID (Center.companyId, …). These helpers
 * translate once per request and produce Prisma where-fragments / assertions
 * shared by every route that reads or writes company-owned data
 * (centers, sales documents, issued invoices, visits, activities,
 * loyalty, after-sales tickets, inventory serials, reports).
 *
 * Semantics (aligned with canAccessCompany in lib/auth.ts):
 * - admins: all ACTIVE NON-ISOLATED companies (v2.35.0 — see below)
 * - everyone else: only rows whose company id is in the resolved list
 *   (v2.58.11, audit P1-2: the resolved list contains only ACTIVE
 *   companies — deactivation suspends a non-admin's data access)
 * - 'holding' / 'all' slugs never grant scoped access (group aggregates
 *   are admin-only), and an empty assignment matches nothing.
 *
 * v2.35.0 — ISOLATED COMPANIES (شرکت مستقل، e.g. یاس طب): a company flagged
 * isIsolated is a fully independent tenant. Its data never appears in ANY
 * group view: the admin scope below resolves to non-isolated companies
 * only, so every where-fragment, report and aggregate silently excludes
 * isolated rows. Isolated companies are visible ONLY to the (non-admin)
 * users explicitly assigned to them, and admins can never target them by
 * explicit slug (assertCanAccessCompanySlug / resolveScopedCompanyId).
 */

/** Slugs that never grant scoped access. */
export const NON_COMPANY_SLUGS = new Set(['holding', 'all']);

/**
 * v2.50.0 (round 75) — the HOLDING company (هلدینگ بهبود گستر) never
 * ISSUED sales documents; the issuer gates (isHoldingCompanyId /
 * HOLDING_ISSUANCE_DENIED ×3 in the sales-documents route) enforced it.
 * v2.56.0 (round 81) — REVERSED at the user's request: the holding now
 * issues its own proformas/invoices with its royal-indigo print
 * template, so both helpers were REMOVED with the gates (they had no
 * other callers). NON_COMPANY_SLUGS above is unrelated and stays: it
 * only governs the standard-user assignment fallback, and the holding
 * remains an admin-only company in user assignment.
 */

/** v2.35.0 — IDs of all active NON-isolated companies (the group scope). */
export async function nonIsolatedCompanyIds(): Promise<string[]> {
  const rows = await db.company.findMany({
    where: { isActive: true, isIsolated: false },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** v2.35.0 — slug set of the isolated companies (usually just یاس طب). */
export async function isolatedCompanySlugs(): Promise<Set<string>> {
  const rows = await db.company.findMany({ where: { isIsolated: true }, select: { slug: true } });
  return new Set(rows.map((r) => r.slug));
}

/**
 * Company IDs the user may operate on.
 * v2.35.0: admins now resolve to the list of active NON-ISOLATED companies
 * instead of `null`. Every fragment below treats a list exactly like a
 * scoped user's list, so isolated data drops out of ALL group views with
 * zero per-route changes. Neutral rows (companyId NULL) stay visible to
 * admins exactly as before. The `null` return no longer occurs but the
 * signature is kept so call sites' `=== null` admin branches stay valid
 * (they simply never fire).
 * v2.58.11 (independent audit P1-2): a DEACTIVATED company now drops out
 * of a non-admin's allowed set — deactivation suspends the assignment's
 * data access (reads AND writes) by default. The admin branch already
 * resolved to ACTIVE companies only; the non-admin branch was the hole.
 */
export async function getAllowedCompanyIds(user: AuthUser): Promise<string[] | null> {
  if (isAdminUser(user)) return nonIsolatedCompanyIds();
  const slugs = user.companyIds.filter((s) => !NON_COMPANY_SLUGS.has(s));
  if (slugs.length === 0) return [];
  const rows = await db.company.findMany({
    where: { slug: { in: slugs }, isActive: true },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * v2.35.0 — the isolated half of a user's assignment (non-admins only).
 * A user whose assignment is EXCLUSIVELY isolated companies gets strictly
 * private views in routes that support it (products catalog, warehouse
 * neutral-pool rows).
 * v2.58.11 (P1-2): the isActive gate applies here too — a deactivated
 * isolated company is just as suspended as a deactivated group company.
 */
export async function userIsolatedCompanyIds(user: AuthUser): Promise<string[]> {
  if (isAdminUser(user)) return [];
  const slugs = user.companyIds.filter((s) => !NON_COMPANY_SLUGS.has(s));
  if (slugs.length === 0) return [];
  const rows = await db.company.findMany({
    where: { slug: { in: slugs }, isIsolated: true, isActive: true },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** True when every real slug of the assignment is an isolated company. */
function isExclusivelyIsolatedAssignment(rawCompanyIds: string, isolatedSlugs: Set<string>): boolean {
  let slugs: string[] = [];
  try {
    const parsed = JSON.parse(rawCompanyIds || '[]');
    if (Array.isArray(parsed)) slugs = parsed.filter((x): x is string => typeof x === 'string');
  } catch { slugs = []; }
  const real = slugs.filter((s) => !NON_COMPANY_SLUGS.has(s));
  return real.length > 0 && real.every((s) => isolatedSlugs.has(s));
}

export interface CompanyRef {
  id: string;
  slug: string;
  isIsolated: boolean;
}

/**
 * v2.35.0 — shared gate for EXPLICIT per-company access (query params and
 * write targets). Throws ApiError:
 *   404 — unknown slug (no existence leak)
 *   403 — non-admin without the assignment
 *   403 — non-admin whose assignment is a DEACTIVATED company
 *         (v2.58.11, audit P1-2 — deactivation suspends data access;
 *         admins keep the EXPLICIT documented exception below so they can
 *         manage / reactivate a deactivated company)
 *   403 — admin targeting an ISOLATED company (group admins never see
 *         isolated data, not even by explicit request; impersonation is
 *         the audited escape hatch for emergencies)
 */
export async function assertCanAccessCompanySlug(user: AuthUser, slug: string): Promise<CompanyRef> {
  const comp = await db.company.findUnique({
    where: { slug },
    select: { id: true, slug: true, isIsolated: true, isActive: true },
  });
  if (!comp) throw new ApiError(404, 'شرکت یافت نشد.');
  if (comp.isIsolated && isAdminUser(user)) {
    throw new ApiError(403, COMPANY_ACCESS_DENIED);
  }
  if (!isAdminUser(user)) {
    if (!user.companyIds.includes(slug)) {
      throw new ApiError(403, COMPANY_ACCESS_DENIED);
    }
    // v2.58.11 (P1-2): the non-admin branch fails closed on a deactivated
    // company — the auditor's live probe read AI memory through exactly
    // this hole (assignment kept, company inactive, access kept).
    if (!comp.isActive) {
      throw new ApiError(403, COMPANY_ACCESS_DENIED);
    }
  }
  return comp;
}

/**
 * v2.35.0 — user ids visible in staff directories / recipient pickers.
 * Group-side viewers (admins and anyone with a non-isolated company) see
 * every user EXCEPT exclusively-isolated users; isolated users see only
 * colleagues sharing one of their isolated companies. Keeps the in-group
 * directory behavior byte-identical while walling یاس طب staff off.
 */
export async function visibleColleagueUserIds(user: AuthUser): Promise<string[]> {
  const isolatedSlugs = await isolatedCompanySlugs();
  const groupSide =
    isAdminUser(user) ||
    user.companyIds.some((s) => !NON_COMPANY_SLUGS.has(s) && !isolatedSlugs.has(s));
  if (groupSide) {
    const users = await db.user.findMany({ select: { id: true, companyIds: true } });
    return users
      .filter((u) => !isExclusivelyIsolatedAssignment(u.companyIds || '[]', isolatedSlugs))
      .map((u) => u.id);
  }
  const slugs = user.companyIds.filter((s) => isolatedSlugs.has(s));
  if (slugs.length === 0) return [user.id];
  const rows = await db.user.findMany({
    where: { OR: slugs.map((s) => ({ companyIds: { contains: `"${s}"` } })) },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * v2.35.0 — inventory-style scope: exclusively-isolated users (یاس طب)
 * get a STRICT companyId filter — their own warehouse rows only, with the
 * shared neutral pool (companyId NULL) hidden, because neutral stock is
 * group property. Everyone else (admins, group users, mixed assignments)
 * keeps the optional company+center semantics. Returns null when the
 * strict branch does not apply.
 */
export async function strictIsolatedCompanyWhere(
  user: AuthUser,
): Promise<{ companyId: { in: string[] } } | null> {
  if (isAdminUser(user)) return null;
  const isolatedIds = await userIsolatedCompanyIds(user);
  if (isolatedIds.length === 0) return null;
  const allowed = (await getAllowedCompanyIds(user)) ?? [];
  if (allowed.length === 0 || !allowed.every((id) => isolatedIds.includes(id))) return null;
  return { companyId: { in: isolatedIds } };
}

/**
 * Center-query fragment: `undefined` for admins (no restriction), otherwise
 * an `IN` filter that also matches nothing when the user has no companies.
 */
export function centerCompanyWhere(
  allowedIds: string[] | null,
): { companyId: { in: string[] } } | undefined {
  if (allowedIds === null) return undefined;
  return { companyId: { in: allowedIds } };
}

/** Does this center belong to one of the user's companies? Admins: always. */
export async function centerInCompanyScope(
  centerId: string,
  allowedIds: string[] | null,
): Promise<boolean> {
  if (allowedIds === null) return true;
  const center = await db.center.findUnique({
    where: { id: centerId },
    select: { companyId: true },
  });
  return center !== null && allowedIds.includes(center.companyId);
}

/**
 * v2.12.0 — where-fragment for rows whose company ownership comes from an
 * OPTIONAL center relation (activities, service tickets, inventory serials).
 *
 * Rows without a center carry no company data (personal tasks, warehouse
 * stock not yet sold) and stay visible; rows WITH a center are restricted
 * to the user's companies. Admins: `undefined` (unrestricted).
 *
 * ⚠ SUPERSEDED for user-owned rows (activities, service tickets) by
 * ownerScopedCenterWhere() below (v2.31.2) — see its header for the
 * round-30 cross-company leak this fragment caused. Kept for rows with
 * no user affiliation (inventory serials).
 */
export function optionalCenterCompanyWhere(
  allowedIds: string[] | null,
): { OR: [{ centerId: null }, { center: { companyId: { in: string[] } } }] } | undefined {
  if (allowedIds === null) return undefined;
  return { OR: [{ centerId: null }, { center: { companyId: { in: allowedIds } } }] };
}

/** Raw user-id columns that identify a row's owner (creator / assignee). */
export interface OwnerIdFields {
  creator: string;
  assignee: string;
}

/** Default owner columns — shared by Activity and ServiceTicket. */
export const DEFAULT_OWNER_ID_FIELDS: OwnerIdFields = {
  creator: 'createdById',
  assignee: 'assignedTo',
};

/**
 * v2.31.2 — PURE builder for the owner-aware tenant fragment. Unit-tested
 * without a DB; see ownerScopedCenterWhere() for the async resolver.
 *
 * Semantics for a scoped user:
 *   visible ⇔ (row's center belongs to one of the user's companies)
 *          OR (row has NO center AND its creator or assignee is one of the
 *              user's colleague ids — colleagues = users sharing at least
 *              one company, including the acting user themself)
 * Orphan rows (no center, creator AND assignee null/unknown) match nothing:
 * fail-closed, admin-only.
 */
export function buildOwnerScopedCenterWhere(
  companyIds: string[],
  colleagueUserIds: string[],
  ownerIdFields: OwnerIdFields = DEFAULT_OWNER_ID_FIELDS,
): Record<string, unknown> {
  const ownerMatch = colleagueUserIds.length > 0
    ? {
        OR: [
          { [ownerIdFields.creator]: { in: colleagueUserIds } },
          { [ownerIdFields.assignee]: { in: colleagueUserIds } },
        ],
      }
    : { [ownerIdFields.creator]: { in: [] as string[] } }; // no colleagues → no orphan leak
  return {
    OR: [
      { center: { companyId: { in: companyIds } } },
      { AND: [{ centerId: null }, ownerMatch] },
    ],
  };
}

/**
 * v2.31.2 — owner-aware tenant scope for user-owned rows whose company
 * ownership is an OPTIONAL center relation (activities, service tickets).
 *
 * THE ROUND-30 LEAK THIS FIXES: the calendar UI creates activities with an
 * OPTIONAL center dropdown — leaving it empty (the default!) produces a
 * center-less row. optionalCenterCompanyWhere() treated every center-less
 * row as company-neutral, so a BGL user could LIST, READ and EDIT an Aria
 * user's personal task (businessUnitId alone isolates nothing — every user
 * of the unit shares it). Same class of leak in service tickets and the
 * activity report.
 *
 * New semantics for scoped (non-admin) users — a row is visible/editable
 * only if:
 *   1. its center belongs to one of the user's companies, OR
 *   2. it has NO center AND its creator or assignee shares at least one
 *      company with the acting user (colleagues incl. the user themself).
 * Orphan rows (no center, no owner — legacy imports) are fail-closed:
 * admin-only. Admins: `undefined` (unrestricted), as everywhere else.
 *
 * Colleagues are resolved with a SQLite string `contains` over the QUOTED
 * slug token stored in User.companyIds (JSON array text): searching for
 * `"aria"` cannot false-match `"aria_medical"` because the closing quote
 * must follow the slug immediately.
 */
export async function ownerScopedCenterWhere(
  user: AuthUser,
  ownerIdFields: OwnerIdFields = DEFAULT_OWNER_ID_FIELDS,
): Promise<Record<string, unknown> | undefined> {
  if (isAdminUser(user)) {
    // v2.35.0 — admins see the GROUP's activities/tickets: centers of
    // non-isolated companies OR centerless rows owned by non-isolated
    // staff. Isolated-company rows (and isolated staff's personal tasks)
    // are walled off from every group view.
    const isolatedSlugs = await isolatedCompanySlugs();
    const users = await db.user.findMany({ select: { id: true, companyIds: true } });
    const colleagues = users
      .filter((u) => !isExclusivelyIsolatedAssignment(u.companyIds || '[]', isolatedSlugs))
      .map((u) => u.id);
    return buildOwnerScopedCenterWhere(await nonIsolatedCompanyIds(), colleagues, ownerIdFields);
  }
  const slugs = user.companyIds.filter((s) => !NON_COMPANY_SLUGS.has(s));
  if (slugs.length === 0) return buildOwnerScopedCenterWhere([], [], ownerIdFields);
  const rows = await db.company.findMany({
    // v2.58.11 (P1-2): deactivated companies drop out of the colleague
    // resolution too — a suspended company's staff lose the shared-company
    // visibility of centerless rows, exactly like their scoped reads.
    where: { slug: { in: slugs }, isActive: true },
    select: { id: true, slug: true },
  });
  if (rows.length === 0) return buildOwnerScopedCenterWhere([], [], ownerIdFields);
  const colleagues = await db.user.findMany({
    where: { OR: rows.map((r) => ({ companyIds: { contains: `"${r.slug}"` } })) },
    select: { id: true },
  });
  return buildOwnerScopedCenterWhere(
    rows.map((r) => r.id),
    colleagues.map((u) => u.id),
    ownerIdFields,
  );
}

/**
 * v2.12.0 — like optionalCenterCompanyWhere, but for models whose Prisma
 * schema carries a raw `centerId` WITHOUT a relation (InventorySerial):
 * filters by an explicit center-id set instead of a relation filter.
 */
export function optionalCenterIdInWhere(
  centerIds: string[] | null,
): { OR: [{ centerId: null }, { centerId: { in: string[] } }] } | undefined {
  if (centerIds === null) return undefined;
  return { OR: [{ centerId: null }, { centerId: { in: centerIds } }] };
}

/**
 * v2.12.0 — IDs of centers belonging to the user's companies.
 * `null` = admin (unrestricted). Used by stores that reference centers by
 * raw id (e.g. the visits JSON blob in the meta table).
 */
export async function allowedCenterIds(
  allowedIds: string[] | null,
): Promise<string[] | null> {
  if (allowedIds === null) return null;
  const rows = await db.center.findMany({
    where: { companyId: { in: allowedIds } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * v2.25.0 — where-fragment for rows that carry a DIRECT nullable `companyId`
 * column (SalesDocument, InventorySerial, ProductionPurchaseRequest).
 *
 * Mirrors the optional-center semantics of v2.12: rows WITHOUT a company
 * (warehouse stock not yet attached to a center, internal shared
 * production requests, documents created without a center) stay visible
 * to every scoped user; rows WITH a company are restricted to that
 * company's users. Admins: `undefined` (unrestricted).
 */
export function optionalCompanyWhere(
  allowedIds: string[] | null,
): { OR: [{ companyId: null }, { companyId: { in: string[] } }] } | undefined {
  if (allowedIds === null) return undefined;
  return { OR: [{ companyId: null }, { companyId: { in: allowedIds } }] };
}

/**
 * v2.25.0 — stricter variant for models that ALSO carry a `centerId`
 * (SalesDocument, InventorySerial): a row with a center but no company
 * stamp (direct DB writes, pre-backfill rows) is NOT company-neutral —
 * it stays HIDDEN from scoped users (fail-closed) until it is stamped.
 * Truly neutral = neither company nor center.
 */
export function optionalCompanyCenterWhere(
  allowedIds: string[] | null,
): { OR: [{ companyId: { in: string[] } }, { AND: [{ companyId: null }, { centerId: null }] }] } | undefined {
  if (allowedIds === null) return undefined;
  return {
    OR: [
      { companyId: { in: allowedIds } },
      { AND: [{ companyId: null }, { centerId: null }] },
    ],
  };
}

/**
 * v2.58.0 (audit 85-a #4) — promote of the voice route's local helper:
 * validate that an activity/task assignee is a visible colleague (same
 * business unit + shared company slug; admins may assign anyone in their
 * unit). Before this, /api/activities accepted ANY user id for
 * `assignedTo`: an unknown id surfaced as a raw Prisma P2025 500, and a
 * group user could assign a task to an isolated (یاس‌طب) user — who then
 * SAW the row through the assignee-in-colleague-set scope.
 */
export async function assigneeInScope(assigneeId: string, user: AuthUser): Promise<boolean> {
  const assignee = await db.user.findUnique({
    where: { id: assigneeId },
    select: { businessUnitId: true, companyIds: true, isActive: true },
  });
  if (!assignee || !assignee.isActive || assignee.businessUnitId !== user.businessUnitId) return false;
  if (isAdminUser(user)) return true;
  const mine = user.companyIds.filter((s) => !NON_COMPANY_SLUGS.has(s));
  if (mine.length === 0) return false;
  const raw = assignee.companyIds || '';
  return mine.some((s) => raw.includes(`"${s}"`));
}

/**
 * v2.25.0 — post-fetch assertion for live rows re-read inside a
 * transaction: a company-owned row outside the user's companies answers
 * 404 (no existence leak — same rule remove-contact follows since v2.24).
 * Company-neutral rows (companyId null) always pass.
 */
export function assertCompanyAccess(
  rowCompanyId: string | null,
  allowedIds: string[] | null,
  message = 'یافت نشد.',
  status = 404,
): void {
  if (allowedIds === null) return;
  if (rowCompanyId === null) return;
  if (!allowedIds.includes(rowCompanyId)) {
    // v2.58.4 (user issue 1): the denial STATUS is caller-controlled —
    // sales-path guards keep the 404 no-existence-leak convention; the
    // accounting cartable restores the explicit 403 COMPANY_ACCESS_DENIED
    // (its pre-v2.58.4 behavior and the user's mandatory matrix).
    throw new ApiError(status, message);
  }
}

/** Shared 403 body for company-gated handlers. */
export const COMPANY_ACCESS_DENIED = 'شما به داده‌های این شرکت دسترسی ندارید.';

/**
 * v2.13.0 — resolve which company a NEW company-owned row (center / quick-sale
 * customer) must be assigned to. Fixes the "first active company" bug where
 * customers were silently filed under an arbitrary company.
 *
 * Order of precedence:
 *  1. explicit slug — must exist AND be inside the user's assignment,
 *     otherwise `{ ok: false }` (caller returns 403/404);
 *  2. no slug, scoped user — the user's FIRST allowed company, in the order
 *     the slugs appear in User.companyIds (deterministic, matches intent);
 *  3. no slug, admin — legacy default: first active company.
 *
 * `{ ok: true, companyId: undefined }` means the user has no usable company
 * (empty assignment) — callers must refuse the write.
 */
export async function resolveScopedCompanyId(
  user: AuthUser,
  slug?: string,
): Promise<
  | { ok: true; companyId: string | undefined }
  | { ok: false; error: string; status: number }
> {
  const requested = typeof slug === 'string' ? slug.trim() : '';

  if (requested) {
    const comp = await db.company.findUnique({
      where: { slug: requested },
      select: { id: true, isIsolated: true, isActive: true },
    });
    if (!comp) {
      return { ok: false, error: 'شرکت درخواستی یافت نشد.', status: 404 };
    }
    // v2.35.0 — isolated companies are writable ONLY by their assigned
    // (non-admin) users; group admins can never file rows into them.
    if (comp.isIsolated && isAdminUser(user)) {
      return { ok: false, error: COMPANY_ACCESS_DENIED, status: 403 };
    }
    if (!isAdminUser(user)) {
      if (!user.companyIds.includes(requested)) {
        return { ok: false, error: COMPANY_ACCESS_DENIED, status: 403 };
      }
      // v2.58.11 (P1-2): a deactivated company is never a WRITE target for
      // its assigned users — the write fails closed instead of silently
      // filing rows into a suspended tenant.
      if (!comp.isActive) {
        return { ok: false, error: COMPANY_ACCESS_DENIED, status: 403 };
      }
    }
    return { ok: true, companyId: comp.id };
  }

  if (!isAdminUser(user)) {
    const slugs = user.companyIds.filter((s) => !NON_COMPANY_SLUGS.has(s));
    if (slugs.length === 0) return { ok: true, companyId: undefined };
    const rows = await db.company.findMany({
      where: { slug: { in: slugs }, isActive: true },
      select: { id: true, slug: true },
    });
    const bySlug = new Map<string, string>(rows.map((r) => [r.slug, r.id] as [string, string]));
    for (const s of slugs) {
      const id = bySlug.get(s);
      if (id) return { ok: true, companyId: id };
    }
    return { ok: true, companyId: undefined };
  }

  const first = await db.company.findFirst({
    where: { isActive: true, isIsolated: false },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return { ok: true, companyId: first?.id };
};
