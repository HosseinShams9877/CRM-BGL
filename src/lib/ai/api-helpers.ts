import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { AuthUser } from '@/lib/auth';
import { getRolePermissions } from '@/lib/auth';
import { getAllowedCompanyIds, assertCanAccessCompanySlug } from '@/lib/company-scope';
import { getCanonicalRole } from '@/lib/roles';
import type { RolePermissions } from '@/lib/auth';

// ════════════════════════════════════════════════════════════
// AI SALES API HELPERS (v2.27.0)
// Shared guards: permission flag + company isolation + audit.
// Every AI route funnels through these so no handler can forget
// a check. The `holding` aggregate view is admin-only (matches
// canAccessCompany semantics).
// ════════════════════════════════════════════════════════════

export type AiPermission =
  | 'ai_calls_read' | 'ai_transcript_read' | 'ai_coaching_read'
  | 'ai_manager_dashboard' | 'ai_playbook_manage' | 'ai_settings_manage' | 'ai_usage_view';

export function aiDenied(msg: string): NextResponse {
  return NextResponse.json({ error: msg }, { status: 403 });
}

export function hasAiPermission(user: AuthUser, perm: AiPermission): boolean {
  const perms: RolePermissions = getRolePermissions(user.role);
  return Boolean(perms[perm]);
}

/**
 * Resolve which company the request targets.
 * - Admin may pass companySlug (defaults to their first allowed company,
 *   or ALL companies when slug='all'/absent → returns null = no filter).
 * - Non-admin: companySlug must be within their allowed slugs; without a
 *   slug the filter is "all my companies".
 * Returns { companyIds: string[] | null } (null ⇒ admin cross-company).
 */
export async function resolveAiCompanyScope(
  user: AuthUser,
  companySlug: string | undefined,
): Promise<{ companyIds: string[] | null } | { error: NextResponse }> {
  if (companySlug && companySlug !== 'all') {
    // v2.35.0 — shared company gate: isolated companies (یاس طب) resolve
    // for their assigned users only; admins are walled out.
    try {
      const comp = await assertCanAccessCompanySlug(user, companySlug);
      return { companyIds: [comp.id] };
    } catch {
      return { error: aiDenied('شما به این شرکت دسترسی ندارید.') };
    }
  }
  if (companySlug === 'all') {
    // v2.58.4 (issue 4): canonical role check — legacy 'administrator'
    // keeps the cross-company view.
    if (getCanonicalRole(user.role) !== 'admin') return { error: aiDenied('نمای چندشرکتی فقط برای مدیر سیستم فعال است.') };
    // v2.35.0 — the admin cross-company view covers GROUP companies only.
    const all = await db.company.findMany({ select: { id: true }, where: { isActive: true, isIsolated: false } });
    return { companyIds: all.map((c) => c.id) };
  }
  const allowed = await getAllowedCompanyIds(user);
  if (allowed === null) {
    // admin without an explicit slug → every active GROUP company
    // (v2.35.0: isolated companies excluded — getAllowedCompanyIds already
    // returns the non-isolated list for admins, so this branch is a no-op
    // safety net kept for the null signature).
    const all = await db.company.findMany({ select: { id: true }, where: { isActive: true, isIsolated: false } });
    return { companyIds: all.map((c) => c.id) };
  }
  return { companyIds: allowed }; // [] for a non-admin without companies
}

/** v2.58.11 (audit P1-1) — REMOVED: canAccessRecording() checked the
 * company list ONLY; the auditor's out-of-territory probe walked right
 * through it. Every former caller now funnels through the CENTRAL
 * policy module (src/lib/ai/access-policy.ts — canAccessAiRecording),
 * which enforces company + business unit + territory + ownership
 * (centerless rows) simultaneously. */

/** Audit every sensitive AI read/write in one place. */
export async function aiAudit(
  eventType: string,
  subject: string,
  details: string,
  userId?: string,
): Promise<void> {
  await db.auditEvent.create({
    data: { eventType, category: 'ai_sales', subject: subject.slice(0, 200), details: details.slice(0, 500), userId },
  }).catch(() => undefined);
}
