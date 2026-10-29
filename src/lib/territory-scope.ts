import { db } from '@/lib/db';
import type { AuthUser } from '@/lib/auth';
import { ApiError } from '@/lib/api-error';
import { getCanonicalRole } from '@/lib/roles';

// ════════════════════════════════════════════════════════════
// SALES TERRITORY & DATA PERMISSION MANAGEMENT (v2.36.0)
//
// «ثبت یک‌بار، اعمال خودکار در تمام کوئری‌ها» — a sales expert's
// territory is assigned ONCE by an admin (کاربران ← کارشناسان فروش ←
// محدوده فروش) and every subsequent DB query for that user is
// automatically scoped: not only in menus/UI, but at the Backend &
// Database layer, so a hand-crafted API call cannot read another
// province's centers, documents, invoices, activities or reports.
//
// Modes (User.territoryMode):
//   country   → unrestricted (legacy default for everyone; assignment of
//               any restricted mode is admin-only). NULL/'' is treated as
//               'country' (auth.ts normalizes) — the legacy default the
//               whole user base carries.
//   provinces → visible centers ⇔ Center.province ∈ territoryProvinces
//   centers   → visible centers ⇔ Center.id ∈ territoryCenterIds
//
// ═══ v2.47.0 — FAIL-CLOSED (security audit fix) ═══
// The previous resolver failed OPEN: a restricted mode with an EMPTY
// list (or broken JSON, or an unknown mode value) resolved to `null`
// = unrestricted, silently granting country-wide access. The new rule:
//   • restricted mode + empty/broken list → mode 'none' → ZERO access
//   • unknown non-empty mode value        → mode 'none' → ZERO access
// Only an explicit 'country' (or the legacy NULL default) keeps full
// access. The admin UI already rejects empty restricted assignments
// (users route: «حداقل یک استان/مرکز انتخاب کنید»), so legitimate data
// can never land in the deny-all state — only corruption or manual DB
// edits can, and denial is exactly what fail-closed requires there.
//
// Scope applies ONLY to standard-role (operational expert) users:
// admin / finance / production keep their existing company-wide reach
// (finance must see every company's financials; admin is unrestricted).
//
// All helpers are pure where-fragment builders EXCEPT resolveTerritoryScope
// / assertCenterInTerritory (single DB read) — pure parts are unit-tested
// in tests/territory-scope.test.ts without a database.
// ════════════════════════════════════════════════════════════

/** Canonical 31 Iranian provinces (Persian names, exact Center.province spelling). */
export const IRAN_PROVINCES: readonly string[] = [
  'آذربایجان شرقی', 'آذربایجان غربی', 'اردبیل', 'اصفهان', 'البرز', 'ایلام',
  'بوشهر', 'تهران', 'چهارمحال و بختیاری', 'خراسان جنوبی', 'خراسان رضوی',
  'خراسان شمالی', 'خوزستان', 'زنجان', 'سمنان', 'سیستان و بلوچستان', 'فارس',
  'قزوین', 'قم', 'کردستان', 'کرمان', 'کرمانشاه', 'کهگیلویه و بویراحمد',
  'گلستان', 'گیلان', 'لرستان', 'مازندران', 'مرکزی', 'هرمزگان', 'همدان', 'یزد',
];

export const TERRITORY_MODES = ['country', 'provinces', 'centers'] as const;
export type TerritoryMode = (typeof TERRITORY_MODES)[number];

export interface TerritoryScope {
  /** 'none' = deny-all (v2.47.0 fail-closed state — matches ZERO rows). */
  mode: 'provinces' | 'centers' | 'none';
  provinces: string[];
  centerIds: string[];
}

/** Shared deny-all instance (pure — safe to reuse, never mutated). */
const DENY_ALL: TerritoryScope = { mode: 'none', provinces: [], centerIds: [] };

/** Raw column shape as stored on the User row. */
export interface TerritoryRow {
  role: string;
  territoryMode: string;
  territoryProvinces: string | null | undefined;
  territoryCenterIds: string | null | undefined;
}

/** Parse a JSON string-array column (mirrors parseCompanyIds semantics). */
export function parseTerritoryArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * PURE — resolve the effective scope from raw columns.
 * `null` = unrestricted (admin / finance / production / explicit country
 * mode / the legacy NULL default). v2.47.0 fail-closed: a RESTRICTED mode
 * with an empty or unparsable list, or an UNKNOWN non-empty mode value,
 * resolves to the deny-all scope ('none') — an empty `IN ()` list must
 * mean zero access, never full access.
 */
export function resolveTerritoryFromRow(row: TerritoryRow): TerritoryScope | null {
  // v2.58.4 (issue 4) — canonicalize the DB row's role before deciding.
  const role = getCanonicalRole(row.role);
  if (role === 'admin') return null;
  if (role !== 'standard') return null; // finance/production unaffected
  const mode = row.territoryMode || 'country'; // NULL/'' → legacy default
  if (mode === 'country') return null;
  if (mode === 'provinces') {
    const provinces = parseTerritoryArray(row.territoryProvinces);
    if (provinces.length === 0) return DENY_ALL; // fail-closed
    return { mode: 'provinces', provinces, centerIds: [] };
  }
  if (mode === 'centers') {
    const centerIds = parseTerritoryArray(row.territoryCenterIds);
    if (centerIds.length === 0) return DENY_ALL; // fail-closed
    return { mode: 'centers', provinces: [], centerIds };
  }
  return DENY_ALL; // unknown non-empty mode → fail-closed
}

/**
 * PURE — human-readable description of WHY a row resolves to deny-all
 * (v2.47.0). Null when the row is fine. Used for the one-time-per-user
 * audit event so an admin can repair a broken assignment.
 */
export function territoryConfigProblem(row: TerritoryRow): string | null {
  // v2.58.4 (issue 4) — legacy role names must behave like their
  // canonical twins here too (an 'administrator' row is not scoping-eligible).
  if (getCanonicalRole(row.role) !== 'standard') return null;
  const mode = row.territoryMode || 'country';
  if (mode === 'country') return null;
  if (mode === 'provinces') {
    return parseTerritoryArray(row.territoryProvinces).length === 0
      ? `territoryMode=provinces با فهرست خالی/خراب (territoryProvinces=${JSON.stringify(row.territoryProvinces)})`
      : null;
  }
  if (mode === 'centers') {
    return parseTerritoryArray(row.territoryCenterIds).length === 0
      ? `territoryMode=centers با فهرست خالی/خراب (territoryCenterIds=${JSON.stringify(row.territoryCenterIds)})`
      : null;
  }
  return `territoryMode ناشناخته: ${JSON.stringify(mode)}`;
}

/** Async resolver for an AuthUser (territory fields ride the session). */
export function resolveTerritoryScope(user: AuthUser): TerritoryScope | null {
  return resolveTerritoryFromRow({
    role: user.role,
    territoryMode: user.territoryMode,
    territoryProvinces: user.territoryProvinces,
    territoryCenterIds: user.territoryCenterIds,
  });
}

// ── where-fragment builders (all PURE) ─────────────────────

/**
 * Center-model fragment. Spreads cleanly next to centerCompanyWhere:
 *   where: { businessUnitId, ...centerCompanyWhere(allowed),
 *            ...centerTerritoryWhere(territory) }
 * centers mode matches on `id` — works both on the root model and inside
 * relation filters ({ center: { ... } }).
 *
 * ⚠ v2.36.0 fix: the centers-mode fragment is wrapped in `AND` — a bare
 * `{ id: { in } }` would CLOBBER a top-level `id` key when spread into a
 * single-row query (`{ id, businessUnitId, ...fragment }`), making e.g.
 * centers-get in centers mode return the FIRST listed center regardless
 * of the requested id (live-caught by r57-e2e test 31). The AND wrapper
 * composes instead of overriding.
 */
export function centerTerritoryWhere(
  t: TerritoryScope | null,
): { province: { in: string[] } } | { AND: [{ id: { in: string[] } }] } | undefined {
  if (!t) return undefined;
  if (t.mode === 'none') return { AND: [{ id: { in: [] } }] }; // matches nothing
  if (t.mode === 'provinces') return { province: { in: t.provinces } };
  return { AND: [{ id: { in: t.centerIds } }] };
}

/**
 * Fragment for rows whose center is a RELATION (SalesDocument,
 * PeriodicFollowup, IssuedInvoice.centerAccount.center …). In centers
 * mode the relation carries a raw `centerId` column on the row itself.
 */
export function centerRelTerritoryWhere(
  t: TerritoryScope | null,
): { center: { province: { in: string[] } } } | { centerId: { in: string[] } } | undefined {
  if (!t) return undefined;
  if (t.mode === 'none') return { centerId: { in: [] } }; // matches nothing
  if (t.mode === 'provinces') return { center: { province: { in: t.provinces } } };
  return { centerId: { in: t.centerIds } };
}

/**
 * v2.58.1 (round 86, audit F4-د) — sales-document visibility for a scoped
 * expert is OWNERSHIP-BASED, territory-restricted:
 *   visible ⇔ created by me  AND  document's center ∈ my territory
 * (company scope is applied separately as another AND — see route wiring).
 *
 * WHY the change: the v2.36.0 `docTerritoryOr` fragment expressed
 * "created by me OR center ∈ territory", so selecting a province
 * auto-granted viewing COLLEAGUES' documents in that province. The
 * business rule is the opposite: an expert sees only their own
 * documents unless they hold the explicit view_other_sales_documents
 * permission; the territory only narrows WHICH centers (geography) are
 * in scope. «همه کشور» (mode country → null) removes only the
 * geographic restriction — ownership and company scope always apply.
 *
 * Deny-all ('none', a broken assignment) keeps the v2.47 fail-closed
 * contract: own documents remain visible, nothing more.
 */
export function docOwnershipTerritoryWhere(
  t: TerritoryScope | null,
  userId: string,
): Record<string, unknown> | undefined {
  if (!t || t.mode === 'none') return { createdById: userId };
  if (t.mode === 'provinces') {
    return {
      AND: [
        { createdById: userId },
        { OR: [{ center: { province: { in: t.provinces } } }, { centerId: null }] },
      ],
    };
  }
  return {
    AND: [
      { createdById: userId },
      { OR: [{ centerId: { in: t.centerIds } }, { centerId: null }] },
    ],
  };
}

/**
 * v2.36.0 — activity visibility for a territory expert:
 *   visible ⇔ center ∈ territory  OR  (no center AND I am the
 *   creator/assignee). Center-less colleague rows (visible under the
 *   legacy colleague rule) are intentionally excluded for scoped users —
 *   «فقط فعالیت‌های ثبت‌شدهٔ خودش یا مراکز تحت مدیریت او».
 * v2.47.0 — deny-all scope: only own center-less rows remain.
 */
export function activityTerritoryWhere(
  t: TerritoryScope | null,
  userId: string,
): { OR: Array<Record<string, unknown>> } | undefined {
  if (!t) return undefined;
  const inTerritory: Record<string, unknown> =
    t.mode === 'provinces'
      ? { center: { province: { in: t.provinces } } }
      : { centerId: { in: t.mode === 'none' ? [] : t.centerIds } };
  return {
    OR: [
      inTerritory,
      { AND: [{ centerId: null }, { OR: [{ createdById: userId }, { assignedTo: userId }] }] },
    ],
  };
}

/** Issued-invoice fragment (billing): scopes through centerAccount.center.
 *  v2.47.0 — deny-all scope: centerId IN () matches nothing. */
export function invoiceTerritoryWhere(
  t: TerritoryScope | null,
): { centerAccount: { center: { province: { in: string[] } } } } | { centerAccount: { centerId: { in: string[] } } } | undefined {
  if (!t) return undefined;
  if (t.mode === 'none') return { centerAccount: { centerId: { in: [] } } };
  if (t.mode === 'provinces') {
    return { centerAccount: { center: { province: { in: t.provinces } } } };
  }
  return { centerAccount: { centerId: { in: t.centerIds } } };
}

// ── assertions (fail-closed, no existence leak) ─────────────

/** Is this center inside the territory? Unrestricted scope: always.
 *  Deny-all scope: never (v2.47.0). */
export function centerInTerritory(
  center: { id: string; province: string | null },
  t: TerritoryScope | null,
): boolean {
  if (!t) return true;
  if (t.mode === 'none') return false;
  if (t.mode === 'provinces') {
    return center.province != null && t.provinces.includes(center.province);
  }
  return t.centerIds.includes(center.id);
}

/**
 * Post-fetch gate for single-center reads/mutations — 404 (not 403) so a
 * center outside the territory does not leak its existence.
 */
export function assertCenterInTerritory(
  center: { id: string; province: string | null },
  t: TerritoryScope | null,
  message = 'مرکز یافت نشد.',
): void {
  if (!centerInTerritory(center, t)) throw new ApiError(404, message);
}

/** Center ids visible to the user = (company scope) ∩ (territory).
 *  Deny-all scope → [] (v2.47.0). */
export async function territoryVisibleCenterIds(
  user: AuthUser,
  companyCenterIds: string[] | null,
): Promise<string[] | null> {
  const t = resolveTerritoryScope(user);
  if (!t) return companyCenterIds;
  if (t.mode === 'none') return [];
  if (t.mode === 'centers') {
    if (companyCenterIds === null) return t.centerIds;
    const set = new Set(companyCenterIds);
    return t.centerIds.filter((id) => set.has(id));
  }
  const rows = await db.center.findMany({
    where: {
      province: { in: t.provinces },
      ...(companyCenterIds !== null ? { id: { in: companyCenterIds } } : {}),
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Human summary for chips/logs: «تهران +۲ استان» / «۵ مرکز» / «کل کشور».
 *  v2.47.0 — a broken/empty restricted assignment honestly reports
 *  «بدون دسترسی» instead of the old misleading «کل کشور». */
export function territorySummary(
  row: Pick<TerritoryRow, 'territoryMode' | 'territoryProvinces' | 'territoryCenterIds'>,
): string {
  if (row.territoryMode === 'provinces') {
    const n = parseTerritoryArray(row.territoryProvinces).length;
    return n > 0 ? `${n} استان` : 'بدون دسترسی (تخصیص ناقص)';
  }
  if (row.territoryMode === 'centers') {
    const n = parseTerritoryArray(row.territoryCenterIds).length;
    return n > 0 ? `${n} مرکز خاص` : 'بدون دسترسی (تخصیص ناقص)';
  }
  if (!row.territoryMode || row.territoryMode === 'country') return 'کل کشور';
  return 'بدون دسترسی (mode ناشناخته)';
}
