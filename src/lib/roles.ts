// ═══════════════════════════════════════════════════════════════
// ROLES — the ONE canonical role mapper (v2.58.4, user issue 4).
//
// WHY THIS MODULE EXISTS: roles arrive from at least four different
// places — the User table (legacy rows imported from the old PHP
// system carry 'administrator', 'financial', 'production_unit'),
// session construction, the users-management API and test fixtures.
// Before v2.58.4 every consumer either re-implemented its own
// mapping or compared `user.role === 'admin'` against the RAW
// string, silently changing a legacy administrator into a standard
// user at ~40 decision points (company scope, user management,
// isolated-company walls, AI settings, …).
//
// THE CONTRACT:
//   • getCanonicalRole() is the ONLY way a role string becomes a
//     role decision. It maps every legacy alias to its canonical
//     counterpart and fails SAFE (unknown/empty → 'standard');
//   • validateSession() canonicalizes AuthUser.role at the SOURCE
//     (src/lib/auth.ts) so downstream comparisons see canonical
//     values even when the DB row still carries a legacy name;
//   • direct `user.role === '<canonical>'` comparisons are
//     progressively replaced by getCanonicalRole(user.role) — the
//     mapper is idempotent for already-canonical values.
// ═══════════════════════════════════════════════════════════════

/** The four canonical roles of the system. */
export type CanonicalRole = 'admin' | 'finance' | 'production' | 'standard';

export const CANONICAL_ROLES: readonly CanonicalRole[] = [
  'admin',
  'finance',
  'production',
  'standard',
] as const;

/**
 * Legacy aliases (old PHP imports / pre-2.x rows) → canonical role.
 * Keys are matched AFTER trim + lowercase, so 'Administrator' (a
 * case variant from a hand-edited row) canonicalizes too.
 */
const LEGACY_ROLE_ALIASES: Readonly<Record<string, CanonicalRole>> = {
  administrator: 'admin',
  financial: 'finance',
  finance_manager: 'finance',
  production_unit: 'production',
};

/** True when the value is already a canonical role name. */
export function isCanonicalRole(role: string): boolean {
  return (CANONICAL_ROLES as readonly string[]).includes(role);
}

/**
 * Map any stored role string to its canonical role. Unknown, empty
 * or corrupted values resolve to 'standard' — the LEAST privileged
 * canonical role (fail-closed: a typo can never mint an admin).
 */
export function getCanonicalRole(role: string | null | undefined): CanonicalRole {
  const key = (role ?? '').trim().toLowerCase();
  if (isCanonicalRole(key)) return key as CanonicalRole;
  return LEGACY_ROLE_ALIASES[key] ?? 'standard';
}
