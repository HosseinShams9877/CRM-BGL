import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, type AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { hasAiPermission, aiDenied, resolveAiCompanyScope } from '@/lib/ai/api-helpers';

// ════════════════════════════════════════════════════════════
// AI SALES — SALES COACH API (v2.27.0)
// POST actions: my | team | trend
// 'my'    → insights of the calling rep (self-coaching)
// 'team'  → cross-user aggregates (manager permission)
// 'trend' → quality trend of one rep or self
// ════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    if (!hasAiPermission(user, 'ai_coaching_read')) {
      return aiDenied('شما دسترسی به مربی هوشمند فروش را ندارید.');
    }

    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    if (action === 'my') return await handleMy(user);
    if (action === 'team') return await handleTeam(body, user);
    if (action === 'trend') return await handleTrend(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('ai-sales-coaching', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

async function handleMy(user: AuthUser) {
  const insights = await db.aiCoachInsight.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true, qualityScore: true, scores: true, strengths: true, improvements: true,
      mistakes: true, recommendations: true, createdAt: true,
      recording: { select: { id: true, title: true, createdAt: true, center: { select: { id: true, name: true } } } },
    },
  });
  const all = await db.aiCoachInsight.findMany({
    where: { userId: user.id },
    select: { qualityScore: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const avg = all.length ? Math.round(all.reduce((a, x) => a + x.qualityScore, 0) / all.length) : null;
  return NextResponse.json({
    insights,
    summary: { totalCoached: all.length, avgQuality: avg, trend: all.map((x) => ({ date: x.createdAt.toISOString().slice(0, 10), score: x.qualityScore })) },
  });
}

async function handleTeam(body: Record<string, unknown>, user: AuthUser) {
  if (!hasAiPermission(user, 'ai_manager_dashboard')) {
    return aiDenied('مشاهده عملکرد تیم فقط برای مدیر سیستم فعال است.');
  }
  const { companySlug } = body as { companySlug?: string };
  const scope = await resolveAiCompanyScope(user, companySlug);
  if ('error' in scope) return scope.error;
  const where: Record<string, unknown> = {};
  if (scope.companyIds) where.recording = { companyId: { in: scope.companyIds } };

  const grouped = await db.aiCoachInsight.groupBy({
    by: ['userId'],
    where,
    _avg: { qualityScore: true },
    _count: { _all: true },
    _min: { qualityScore: true },
    _max: { qualityScore: true },
  });
  const userIds = grouped.map((g) => g.userId);
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })
    : [];
  const team = grouped.map((g) => {
    const u = users.find((x) => x.id === g.userId);
    return {
      userId: g.userId,
      displayName: u?.displayName || '—',
      coachedCalls: g._count._all,
      avgQuality: g._avg.qualityScore !== null ? Math.round(g._avg.qualityScore) : null,
      bestQuality: g._max.qualityScore,
      worstQuality: g._min.qualityScore,
    };
  }).sort((a, b) => (b.avgQuality || 0) - (a.avgQuality || 0));
  return NextResponse.json({ team });
}

async function handleTrend(body: Record<string, unknown>, user: AuthUser) {
  const { userId, days } = body as { userId?: string; days?: number };
  // v2.58.3 (round 88, finding 6) — days must be a VALID, finite number.
  // NaN/Infinity used to reach `new Date(Date.now() - NaN)` → Invalid Date
  // in the Prisma query. Validate + clamp BEFORE touching the database.
  const parsedDays = Number(days);
  const daysWindow = Number.isFinite(parsedDays) ? Math.min(90, Math.max(7, Math.round(parsedDays))) : 30;
  const since = new Date(Date.now() - daysWindow * 24 * 3600 * 1000);

  const isManager = hasAiPermission(user, 'ai_manager_dashboard');
  const target = userId && isManager ? userId : user.id;

  // v2.58.3 (round 88, finding 6) — COMPANY SCOPE on cross-user reads.
  // A manager may read another rep's trend ONLY through the companies the
  // MANAGER may access — exactly the team handler's resolveAiCompanyScope
  // semantics, but applied to trend (it previously read ANY userId with
  // zero scoping, including isolated-company (یاس طب) reps and other
  // companies' data). Multi-company users are covered because the scope
  // resolves to the full allowed-company LIST, not a single main company.
  let companyFilter: Record<string, unknown> | undefined;
  if (isManager && target !== user.id) {
    const scope = await resolveAiCompanyScope(user, undefined);
    if ('error' in scope) return scope.error;
    if (scope.companyIds === null) {
      // defensive branch (resolveAiCompanyScope never returns null in
      // practice): fall back to group-only, isolated companies walled
      companyFilter = { recording: { company: { isIsolated: false } } };
    } else if (scope.companyIds.length === 0) {
      return NextResponse.json({ trend: [] });
    } else {
      companyFilter = { recording: { companyId: { in: scope.companyIds } } };
    }
  }

  const rows = await db.aiCoachInsight.findMany({
    where: {
      userId: target,
      createdAt: { gte: since },
      ...(companyFilter ?? {}),
    },
    orderBy: { createdAt: 'asc' },
    select: { qualityScore: true, createdAt: true, scores: true },
  });
  return NextResponse.json({
    trend: rows.map((r) => ({ date: r.createdAt.toISOString().slice(0, 10), score: r.qualityScore })),
  });
}
