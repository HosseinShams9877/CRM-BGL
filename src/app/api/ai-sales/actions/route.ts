import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, parseCompanyIds, type AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { executeNextAction, approveNextAction, dismissNextAction } from '@/lib/ai/engine/nba';
import { hasAiPermission, aiDenied, resolveAiCompanyScope } from '@/lib/ai/api-helpers';
// v2.58.11 (audit P1-1): the CENTRAL access policy — list fragment + the
// single-action gate replace the company-only checks.
import { canAccessAiNextAction, aiNextActionWhere } from '@/lib/ai/access-policy';
import { getApprovalModeForCompany } from '@/lib/ai/settings';

// ════════════════════════════════════════════════════════════
// AI SALES — NEXT BEST ACTIONS API (v2.27.0)
// POST actions: list | approve | execute | dismiss | complete |
//               assign | policy
// Approval flow: suggested → (approve) → approved → (execute)
//                → executed (real Activity created) → completed
// ════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    if (!hasAiPermission(user, 'ai_calls_read')) {
      return aiDenied('شما دسترسی به ماژول هوش مصنوعی فروش را ندارید.');
    }

    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    if (action === 'list') return await handleList(body, user);
    if (action === 'policy') return await handlePolicy(body, user);
    if (action === 'approve') return await handleApprove(body, user);
    if (action === 'execute') return await handleExecute(body, user);
    if (action === 'dismiss') return await handleDismiss(body, user);
    if (action === 'complete') return await handleComplete(body, user);
    if (action === 'assign') return await handleAssign(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('ai-sales-actions', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const { companySlug, status, centerId, mine, page = 1, pageSize = 30 } = body as {
    companySlug?: string; status?: string; centerId?: string; mine?: boolean; page?: number; pageSize?: number;
  };
  const scope = await resolveAiCompanyScope(user, companySlug);
  if ('error' in scope) return scope.error;

  const where: Record<string, unknown> = {};
  if (scope.companyIds) where.companyId = { in: scope.companyIds };
  if (status) where.status = status;
  if (centerId) where.centerId = centerId;
  if (mine) where.assignedTo = user.id;
  // v2.58.11 (P1-1): territory/BU/ownership — an out-of-territory action or
  // a centerless colleague action no longer lists for a restricted expert
  // (unrestricted users keep their view).
  where.AND = [...((where.AND as Array<Record<string, unknown>>) ?? []), aiNextActionWhere(user)];

  const take = Math.min(100, Math.max(1, Number(pageSize)));
  const skip = (Math.max(1, Number(page)) - 1) * take;

  const [items, total] = await Promise.all([
    db.aiNextAction.findMany({
      where,
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
      skip,
      take,
      select: {
        id: true, type: true, title: true, detail: true, priority: true, dueAt: true,
        reason: true, confidence: true, status: true, createdAt: true, executedAt: true,
        dismissedReason: true, executedActivityId: true, assignedTo: true,
        center: { select: { id: true, name: true } },
        contact: { select: { id: true, title: true, person: true } },
        assignee: { select: { id: true, displayName: true } },
      },
    }),
    db.aiNextAction.count({ where }),
  ]);

  return NextResponse.json({ items, total, page: Number(page), pageSize: take });
}

async function handlePolicy(body: Record<string, unknown>, user: AuthUser) {
  const { companySlug } = body as { companySlug?: string };
  const scope = await resolveAiCompanyScope(user, companySlug);
  if ('error' in scope) return scope.error;
  const companyId = scope.companyIds && scope.companyIds.length ? scope.companyIds[0] : '';
  const mode = companyId ? await getApprovalModeForCompany(companyId) : 'confirm';
  return NextResponse.json({ approvalMode: mode });
}

/**
 * v2.47.0 — assignee validation: the assignee must EXIST, be ACTIVE, and
 * actually have access to the action's company (an isolated company's
 * action can never go to a group admin or a foreign user; a group
 * company's action accepts admins and assigned users). Returns a Persian
 * error message or null when the target is valid.
 */
async function assigneeError(assignTo: string, actionCompanyId: string): Promise<string | null> {
  const target = await db.user.findUnique({
    where: { id: assignTo },
    select: { isActive: true, role: true, companyIds: true },
  });
  if (!target) return 'کاربر مقصد یافت نشد.';
  if (!target.isActive) return 'کاربر مقصد غیرفعال است و نمی‌تواند مسئول اقدام باشد.';
  const comp = await db.company.findUnique({ where: { id: actionCompanyId }, select: { slug: true, isIsolated: true } });
  if (!comp) return 'شرکت این اقدام یافت نشد.';
  const ids = parseCompanyIds(target.companyIds);
  if (comp.isIsolated) {
    // isolated company: admin is explicitly NOT a valid assignee
    if (getCanonicalRole(target.role) === 'admin' || !ids.includes(comp.slug)) {
      return 'کاربر مقصد به شرکت این اقدام (شرکت مستقل) دسترسی ندارد.';
    }
  } else if (getCanonicalRole(target.role) !== 'admin' && !ids.includes(comp.slug)) {
    return 'کاربر مقصد به شرکت این اقدام دسترسی ندارد.';
  }
  return null;
}

/** v2.58.11 (P1-1) — THE single-action gate: company + business unit +
 * territory + ownership (for centerless actions) in one check. A miss
 * reads as 404 «اقدام یافت نشد.» — fail-closed, no existence leak. */
async function loadAccessibleAction(
  id: string,
  user: AuthUser,
): Promise<NextResponse | null> {
  const action = await db.aiNextAction.findUnique({
    where: { id },
    select: { id: true, companyId: true, centerId: true, assignedTo: true, createdById: true },
  });
  if (!action) return NextResponse.json({ error: 'اقدام یافت نشد.' }, { status: 404 });
  if (!(await canAccessAiNextAction(user, action))) {
    return NextResponse.json({ error: 'اقدام یافت نشد.' }, { status: 404 });
  }
  return null; // accessible — the caller re-reads the row it needs
}

async function handleApprove(body: Record<string, unknown>, user: AuthUser) {
  const { id } = body as { id?: string };
  if (!id) return NextResponse.json({ error: 'شناسه اقدام الزامی است.' }, { status: 400 });
  const denied = await loadAccessibleAction(id, user);
  if (denied) return denied;
  const action = await db.aiNextAction.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!action) return NextResponse.json({ error: 'اقدام یافت نشد.' }, { status: 404 });
  const ok = await approveNextAction(id, user.id);
  if (!ok) return NextResponse.json({ error: 'این اقدام قابل تأیید نیست.' }, { status: 409 });
  return NextResponse.json({ message: 'اقدام تأیید شد.' });
}

async function handleExecute(body: Record<string, unknown>, user: AuthUser) {
  const { id, assignTo } = body as { id?: string; assignTo?: string };
  if (!id) return NextResponse.json({ error: 'شناسه اقدام الزامی است.' }, { status: 400 });
  const denied = await loadAccessibleAction(id, user);
  if (denied) return denied;
  const action = await db.aiNextAction.findUnique({ where: { id }, select: { id: true, companyId: true, status: true } });
  if (!action) return NextResponse.json({ error: 'اقدام یافت نشد.' }, { status: 404 });
  if (assignTo) {
    // v2.47.0 — validate the assignee BEFORE writing it (was: any string,
    // even a foreign-company or deactivated user id, was accepted).
    const err = await assigneeError(assignTo, action.companyId);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
    await db.aiNextAction.update({ where: { id }, data: { assignedTo: assignTo } });
  }
  const activityId = await executeNextAction(id, user.id, false);
  if (!activityId) return NextResponse.json({ error: 'اجرای این اقدام ممکن نیست (وضعیت نامناسب).' }, { status: 409 });
  return NextResponse.json({ message: 'اقدام اجرا شد و فعالیت مرتبط ایجاد شد.', activityId });
}

async function handleDismiss(body: Record<string, unknown>, user: AuthUser) {
  const { id, reason } = body as { id?: string; reason?: string };
  if (!id) return NextResponse.json({ error: 'شناسه اقدام الزامی است.' }, { status: 400 });
  const denied = await loadAccessibleAction(id, user);
  if (denied) return denied;
  const ok = await dismissNextAction(id, user.id, reason || 'بدون دلیل ثبت‌شده');
  if (!ok) return NextResponse.json({ error: 'این اقدام قابل رد کردن نیست.' }, { status: 409 });
  return NextResponse.json({ message: 'اقدام رد شد.' });
}

async function handleComplete(body: Record<string, unknown>, user: AuthUser) {
  const { id } = body as { id?: string };
  if (!id) return NextResponse.json({ error: 'شناسه اقدام الزامی است.' }, { status: 400 });
  const denied = await loadAccessibleAction(id, user);
  if (denied) return denied;
  const action = await db.aiNextAction.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!action) return NextResponse.json({ error: 'اقدام یافت نشد.' }, { status: 404 });
  if (action.status !== 'executed') {
    return NextResponse.json({ error: 'فقط اقدامات اجراشده قابل تکمیل هستند.' }, { status: 409 });
  }
  await db.aiNextAction.update({ where: { id }, data: { status: 'completed', completedAt: new Date() } });
  return NextResponse.json({ message: 'اقدام تکمیل شد.' });
}

async function handleAssign(body: Record<string, unknown>, user: AuthUser) {
  const { id, assignTo } = body as { id?: string; assignTo?: string };
  if (!id || !assignTo) return NextResponse.json({ error: 'شناسه اقدام و کاربر مقصد الزامی است.' }, { status: 400 });
  const denied = await loadAccessibleAction(id, user);
  if (denied) return denied;
  const action = await db.aiNextAction.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!action) return NextResponse.json({ error: 'اقدام یافت نشد.' }, { status: 404 });
  const target = await db.user.findUnique({ where: { id: assignTo }, select: { id: true } });
  if (!target) return NextResponse.json({ error: 'کاربر مقصد یافت نشد.' }, { status: 404 });
  // v2.47.0 — same assignee validation as execute (active + company access).
  const err = await assigneeError(assignTo, action.companyId);
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  await db.aiNextAction.update({ where: { id }, data: { assignedTo: assignTo } });
  return NextResponse.json({ message: 'اقدام به کاربر انتخاب‌شده واگذار شد.' });
}
