// ════════════════════════════════════════════════════════════
// ACCESS POLICY — the central authorization policy layer
// (v2.58.7, production-hardening round, stage 1).
//
// WHY THIS MODULE EXISTS: before this round the five checks every
// mutation needs (Authentication, Role permission, Company scope,
// Territory scope, Resource ownership) were enforced by helpers
// SCATTERED across company-scope.ts / territory-scope.ts and
// hand-rolled `if` blocks inside route handlers. The core checks were
// real, but the fragmentation is exactly what let the audit find five
// mutation paths that "felt" guarded yet skipped one dimension
// (quick-sale: company ✓ territory ✗; partner-pricing: permission
// chosen so loosely that every salesperson passed; voice route:
// company ✓ territory ✗; production update-status: read scoped,
// write unscoped; …).
//
// THE CONTRACT (this module is the ONE import surface routes use):
//   • assertPermission()        — role-permission gate (403)
//   • assertCompanyAccess()     — tenant boundary on a live row (403/404)
//   • assertTerritoryAccess()   — sales-territory boundary (404 no-leak)
//   • assertCenterAccess()      — fetch + company + territory, one call
//   • assertResourceOwnership() — per-user resource ownership (403)
//
// All asserts THROW ApiError — the existing route-level catch maps it
// to a controlled Persian response via apiErrorStatus/apiErrorMessage,
// so adopting the layer never changes the error envelope.
//
// Layering: the primitives (getAllowedCompanyIds, the row-level
// assertCompanyAccess, centerInTerritory, resolveTerritoryScope) stay
// in their domain modules; THIS module composes them into the five
// canonical checks so a route cannot forget one dimension again.
// ════════════════════════════════════════════════════════════

import type { AuthUser, RolePermissions } from '@/lib/auth';
import { getRolePermissions } from '@/lib/auth';
import { ApiError } from '@/lib/api-error';
import {
  getAllowedCompanyIds,
  assertCompanyAccess as assertRowCompanyAccess,
  COMPANY_ACCESS_DENIED,
} from '@/lib/company-scope';
import {
  resolveTerritoryScope,
  centerInTerritory,
  type TerritoryScope,
} from '@/lib/territory-scope';
import { db } from '@/lib/db';

/** Permission keys the policy layer may gate on (mirrors RolePermissions). */
export type PermissionKey = keyof RolePermissions;

export const PERMISSION_DENIED = 'شما دسترسی لازم برای این عملیات را ندارید.';
export const TERRITORY_DENIED = 'دادهٔ درخواست‌شده در حوزهٔ فروش شما قرار ندارد.';
export const RESOURCE_OWNERSHIP_DENIED = 'این منبع متعلق به شما نیست.';
export const CURRENT_PASSWORD_REQUIRED = 'برای تغییر رمز عبور خود، رمز فعلی الزامی است.';
export const CURRENT_PASSWORD_WRONG = 'رمز فعلی نادرست است.';

// ─────────────────────────────────────────────────────────────
// 1) ROLE / PERMISSION
// ─────────────────────────────────────────────────────────────

/**
 * Throw 403 unless the user's role holds the permission.
 * The canonical role-permission gate — a route must NOT branch on the
 * role string itself (legacy 'administrator' rows etc. normalize
 * inside getRolePermissions).
 */
export function assertPermission(
  user: AuthUser,
  permission: PermissionKey,
  message = PERMISSION_DENIED,
): void {
  const perms = getRolePermissions(user.role);
  if (!perms[permission]) {
    throw new ApiError(403, message);
  }
}

// ─────────────────────────────────────────────────────────────
// 2) COMPANY SCOPE
// ─────────────────────────────────────────────────────────────

/**
 * Throw unless the row's company is inside the user's company scope.
 * Admins: every non-isolated active company. Others: their assigned
 * slugs. Company-neutral rows (companyId null) always pass — they are
 * guarded by the ownership/territory dimensions instead.
 *
 * Async because the allowed set resolves through the DB. Denial
 * convention is caller-controlled:
 *   • default 403 + COMPANY_ACCESS_DENIED (cartable/files convention)
 *   • sales paths pass 404 + '… یافت نشد.' (no existence leak)
 */
export async function assertCompanyAccess(
  user: AuthUser,
  rowCompanyId: string | null,
  opts: { status?: number; message?: string } = {},
): Promise<void> {
  const allowed = await getAllowedCompanyIds(user);
  assertRowCompanyAccess(rowCompanyId, allowed, opts.message ?? COMPANY_ACCESS_DENIED, opts.status ?? 403);
}

/** The allowed-company id set for this user (null = unrestricted admin). */
export async function companyScopeOf(user: AuthUser): Promise<string[] | null> {
  return getAllowedCompanyIds(user);
}

// ─────────────────────────────────────────────────────────────
// 3) TERRITORY SCOPE
// ─────────────────────────────────────────────────────────────

/**
 * Throw unless the center is inside the user's sales territory.
 * Country-mode / admin / broken-scope-fail-closed semantics all come
 * from resolveTerritoryScope + centerInTerritory — identical to every
 * existing call site. Default denial: 404 no-leak (a scoped expert
 * must not learn that an out-of-territory center exists).
 */
export function assertTerritoryAccess(
  user: AuthUser,
  center: { id: string; province: string | null },
  opts: { status?: number; message?: string } = {},
): void {
  const scope: TerritoryScope | null = resolveTerritoryScope(user);
  if (!centerInTerritory(center, scope)) {
    throw new ApiError(opts.status ?? 404, opts.message ?? 'مرکز/مشتری درخواست‌شده در حوزهٔ فروش شما نیست.');
  }
}

/** Territory predicate (no throw) — for building Prisma `where` clauses. */
export function territoryAllows(user: AuthUser, center: { id: string; province: string | null }): boolean {
  return centerInTerritory(center, resolveTerritoryScope(user));
}

// ─────────────────────────────────────────────────────────────
// 4) CENTER ACCESS (company + territory in ONE guarded fetch)
// ─────────────────────────────────────────────────────────────

export interface GuardedCenter {
  id: string;
  province: string | null;
  companyId: string | null;
}

/**
 * Fetch a center row and assert BOTH the company and the territory
 * dimension in one call — the single entry point mutations that take
 * a `centerId` from the client should use. Missing center → 404 (no
 * existence leak). Denial conventions overridable per route family.
 */
export async function assertCenterAccess(
  user: AuthUser,
  centerId: string,
  opts: {
    companyStatus?: number;
    companyMessage?: string;
    territoryStatus?: number;
    territoryMessage?: string;
  } = {},
): Promise<GuardedCenter> {
  const center = await db.center.findUnique({
    where: { id: centerId },
    select: { id: true, province: true, companyId: true },
  });
  if (!center) {
    throw new ApiError(404, 'مرکز/مشتری درخواست‌شده یافت نشد.');
  }
  await assertCompanyAccess(user, center.companyId, {
    status: opts.companyStatus ?? 403,
    message: opts.companyMessage ?? COMPANY_ACCESS_DENIED,
  });
  assertTerritoryAccess(user, center, {
    status: opts.territoryStatus ?? 404,
    message: opts.territoryMessage,
  });
  return center;
}

// ─────────────────────────────────────────────────────────────
// 5) RESOURCE OWNERSHIP
// ─────────────────────────────────────────────────────────────

/**
 * Throw 403 unless the resource belongs to the user (or the user
 * overrides the ownership rule — e.g. admin).
 *
 * `ownerId` is the row's creator/owner column (createdById, userId…).
 * A NULL owner is NOT the caller's (fail-closed — same rule the
 * cartable payment matrix applies to legacy NULL-creator rows).
 * `override` lets a route express "this role may touch anyone's row"
 * without weakening the default for everyone else.
 */
export function assertResourceOwnership(
  user: AuthUser,
  ownerId: string | null,
  opts: {
    override?: boolean;
    message?: string;
    status?: number;
  } = {},
): void {
  if (opts.override === true) return;
  if (ownerId !== null && ownerId === user.id) return;
  throw new ApiError(opts.status ?? 403, opts.message ?? RESOURCE_OWNERSHIP_DENIED);
}

// ─────────────────────────────────────────────────────────────
// Exports of the underlying primitives so routes can import the
// WHOLE authorization stack from this one module.
// ─────────────────────────────────────────────────────────────
export {
  getAllowedCompanyIds,
  COMPANY_ACCESS_DENIED,
  assigneeInScope,
} from '@/lib/company-scope';
export {
  resolveTerritoryScope,
  centerInTerritory,
  centerTerritoryWhere,
} from '@/lib/territory-scope';
export { ApiError } from '@/lib/api-error';
