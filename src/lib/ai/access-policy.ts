import { db } from '@/lib/db';
import type { AuthUser } from '@/lib/auth';
import { ApiError } from '@/lib/api-error';
import { getAllowedCompanyIds, centerCompanyWhere } from '@/lib/company-scope';
import { resolveTerritoryScope, centerTerritoryWhere, centerInTerritory } from '@/lib/territory-scope';

// ══════════════════════════════════════════════════════════════
// THE CENTRAL AI SALES ACCESS POLICY (v2.58.11 — independent
// audit 2.58.10, P1-1)
//
// THE FINDING: every AI Sales route funneled through company-only
// helpers (centerInCompanyScope / canAccessRecording /
// resolveAiCompanyScope) — a standard user of the RIGHT company but
// OUTSIDE the center's province read AI customer memory with 200.
// Company alone was never the policy.
//
// THE POLICY — one module, every AI Sales route. For a row whose
// data identity is a CENTER, ALL of these hold simultaneously
// (mirroring the centers route's own scopeWhere, the codebase's
// canonical predicate):
//   1. COMPANY   — the center's company is in the user's allowed set
//                  (v2.58.11 P1-2: ACTIVE companies only, isolation
//                  walled, admins = active group companies);
//   2. BUSINESS UNIT — center.businessUnitId === user.businessUnitId;
//   3. TERRITORY — the center's province / id is inside the user's
//                  territory (country-mode, admin, finance, production
//                  → unrestricted; broken assignment → deny-all);
//   4. OWNERSHIP — rows WITHOUT a center (centerId null) are visible
//                  to a territory-restricted expert only when the row
//                  is theirs (the model's own owner columns); other
//                  unrestricted users keep the legacy visibility;
//   5. ACTIVE    — company active (rule 1); row-level states stay
//                  governed by their owning routes.
//
// STATUS CONVENTION: single-row gates answer 404 «مرکز یافت نشد.» —
// fail-closed with no existence leak, exactly like the centers route;
// the AI routes' catch-all maps ApiError to its status.
//
// SCOPE OF APPLICATION (audited wiring):
//   • memory (get/update)              — assertAiCenterAccess
//   • brief                            — assertAiCenterAccess
//   • calls create-manual + upload     — assertAiCenterAccess
//   • calls get/transcript/analyze/
//     retry/delete + audio streaming   — canAccessAiRecording
//   • calls list                       — aiRecordingWhere fragment
//   • actions list                     — aiNextActionWhere fragment
//   • actions approve/execute/
//     dismiss/complete/assign          — canAccessAiNextAction
// Manager-only aggregates (coaching team/trend, dashboard, usage,
// playbook) resolve through resolveAiCompanyScope: their actor class
// (ai_manager_dashboard / ai_usage_view / ai_settings_manage) is
// admin, who carries no territory and no restricted ownership — the
// company dimension (active + isolation) is the complete policy set
// there; coaching 'my' is strictly self-owned by construction.
// ══════════════════════════════════════════════════════════════

/** Owner columns per AI model (their schemas differ — never share). */
export type AiOwnerColumn = 'userId' | 'createdById' | 'assignedTo';
const RECORDING_OWNER_COLUMNS: readonly AiOwnerColumn[] = ['userId', 'createdById'];
const NEXT_ACTION_OWNER_COLUMNS: readonly AiOwnerColumn[] = ['assignedTo', 'createdById'];

/** The full center predicate — the centers route's own scopeWhere,
 *  reused for AI center-anchored reads. PURE (no DB access). */
export function aiCenterPolicyWhere(
  user: AuthUser,
  allowedIds: string[] | null,
): Record<string, unknown> {
  return {
    businessUnitId: user.businessUnitId,
    ...centerCompanyWhere(allowedIds),
    ...centerTerritoryWhere(resolveTerritoryScope(user)),
  };
}

/**
 * THE single-center gate for every AI Sales read/write that anchors
 * on a centerId (memory, brief, create-manual, upload). ONE query
 * answers id + business unit + company (+active, via the allowed set)
 * + territory; a miss is 404 (no existence leak). Returns the center
 * row (companyId included) so callers never re-read it.
 */
export async function assertAiCenterAccess(
  user: AuthUser,
  centerId: string,
): Promise<{ id: string; companyId: string; province: string | null; businessUnitId: string }> {
  const allowedIds = await getAllowedCompanyIds(user);
  const center = await db.center.findFirst({
    where: { id: centerId, ...aiCenterPolicyWhere(user, allowedIds) },
    select: { id: true, companyId: true, province: true, businessUnitId: true },
  });
  if (!center) throw new ApiError(404, 'مرکز یافت نشد.');
  return center;
}

/**
 * LIST fragment for AI rows anchored on an OPTIONAL center relation
 * (AiCallRecording, AiNextAction): a row is visible to a
 * territory-RESTRICTED expert iff its center satisfies the center
 * policy (BU + territory — the caller adds company on the row's own
 * companyId), OR the row has NO center and is the expert's own.
 * Unrestricted users (admin/finance/production/country-mode) keep
 * the center-BU predicate with centerless rows visible (their
 * historical semantics — no territory to violate).
 * PURE. Compose under `AND` — the caller's `OR` keys stay untouched.
 */
export function aiCenterOwnedRowWhere(
  user: AuthUser,
  ownerColumns: readonly AiOwnerColumn[],
): Record<string, unknown> {
  const t = resolveTerritoryScope(user);
  const centerPredicate: Record<string, unknown> = { businessUnitId: user.businessUnitId };
  if (!t) {
    return { OR: [{ center: centerPredicate }, { centerId: null }] };
  }
  const territoryCenter =
    t.mode === 'provinces'
      ? { ...centerPredicate, province: { in: t.provinces } }
      : t.mode === 'centers'
        ? { ...centerPredicate, id: { in: t.centerIds } }
        : { ...centerPredicate, id: { in: [] as string[] } }; // deny-all
  const ownerMatch = { OR: ownerColumns.map((c) => ({ [c]: user.id })) };
  return {
    OR: [
      { center: territoryCenter },
      { AND: [{ centerId: null }, ownerMatch] },
    ],
  };
}

/** Model-pinned aliases (their owner columns differ — see above). */
export function aiRecordingWhere(user: AuthUser): Record<string, unknown> {
  return aiCenterOwnedRowWhere(user, RECORDING_OWNER_COLUMNS);
}

export function aiNextActionWhere(user: AuthUser): Record<string, unknown> {
  return aiCenterOwnedRowWhere(user, NEXT_ACTION_OWNER_COLUMNS);
}

// ── single-row (post-fetch) gates ───────────────────────────

async function centerSatisfiesPolicy(
  user: AuthUser,
  centerId: string,
  allowedIds: string[] | null,
): Promise<boolean> {
  const center = await db.center.findUnique({
    where: { id: centerId },
    select: { id: true, province: true, businessUnitId: true, companyId: true },
  });
  if (!center) return false;
  // fail-closed on an inconsistent tenant stamp: a row claiming company A
  // while its center belongs to company B trusts NEITHER side
  if (allowedIds !== null && !allowedIds.includes(center.companyId)) return false;
  if (center.businessUnitId !== user.businessUnitId) return false;
  if (!centerInTerritory(center, resolveTerritoryScope(user))) return false;
  return true;
}

function ownsRow(
  user: AuthUser,
  row: { assignedTo?: string | null; createdById?: string | null; userId?: string | null },
  ownerColumns: readonly AiOwnerColumn[],
): boolean {
  return ownerColumns.some((c) => row[c] === user.id);
}

/**
 * Upgraded single-recording gate (was: company list only — the
 * auditor's probe). Company (active + isolation via the allowed set)
 * AND, when the row carries a center, business unit + territory; a
 * CENTERLESS recording is the restricted expert's own or invisible
 * (unrestricted users see it, as before). Returns false on any miss
 * — routes answer 404 per the no-existence-leak convention.
 */
export async function canAccessAiRecording(
  user: AuthUser,
  recording: { companyId: string; centerId?: string | null; userId?: string | null; createdById?: string | null },
): Promise<boolean> {
  const allowed = await getAllowedCompanyIds(user);
  if (allowed === null || !allowed.includes(recording.companyId)) return false;
  if (recording.centerId) return centerSatisfiesPolicy(user, recording.centerId, allowed);
  if (resolveTerritoryScope(user)) return ownsRow(user, recording, RECORDING_OWNER_COLUMNS);
  return true; // centerless + unrestricted → legacy visibility
}

/** Single next-action gate — same dimensions, ownership via
 *  assignedTo / createdById (AiNextAction has no userId column). */
export async function canAccessAiNextAction(
  user: AuthUser,
  action: { companyId: string; centerId?: string | null; assignedTo?: string | null; createdById?: string | null },
): Promise<boolean> {
  const allowed = await getAllowedCompanyIds(user);
  if (allowed === null || !allowed.includes(action.companyId)) return false;
  if (action.centerId) return centerSatisfiesPolicy(user, action.centerId, allowed);
  if (resolveTerritoryScope(user)) return ownsRow(user, action, NEXT_ACTION_OWNER_COLUMNS);
  return true;
}
