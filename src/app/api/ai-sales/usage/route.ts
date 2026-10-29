import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { hasAiPermission, aiDenied, resolveAiCompanyScope } from '@/lib/ai/api-helpers';
import { getMonthlyUsage } from '@/lib/ai/usage';

// ════════════════════════════════════════════════════════════
// AI SALES — USAGE DASHBOARD API (v2.27.0) — ADMIN ONLY
// POST { companySlug? } → month-to-date usage + per-user + daily.
// ════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    if (!hasAiPermission(user, 'ai_usage_view')) {
      return aiDenied('گزارش مصرف هوش مصنوعی فقط برای مدیر سیستم فعال است.');
    }

    const body = await req.json().catch(() => ({}));
    const { companySlug } = body as { companySlug?: string };
    const scope = await resolveAiCompanyScope(user, companySlug);
    if ('error' in scope) return scope.error;
    if (!scope.companyIds || scope.companyIds.length === 0) {
      return NextResponse.json({ error: 'شرکتی برای نمایش مشخص نیست.' }, { status: 400 });
    }

    const summaries = await Promise.all(scope.companyIds.map((cid) => getMonthlyUsage(cid)));
    const merged = summaries.reduce((acc, s) => {
      acc.totalCalls += s.totalCalls;
      acc.totalInputTokens += s.totalInputTokens;
      acc.totalOutputTokens += s.totalOutputTokens;
      acc.totalAudioSeconds += s.totalAudioSeconds;
      acc.totalCostRial += s.totalCostRial;
      return acc;
    }, { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalAudioSeconds: 0, totalCostRial: 0 });

    // Daily usage (last 30 days) + per-user (top 20).
    const since = new Date();
    since.setDate(1);
    const logs = await db.aiUsageLog.findMany({
      where: { companyId: { in: scope.companyIds }, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      select: { feature: true, provider: true, model: true, inputTokens: true, outputTokens: true, audioSeconds: true, estimatedCostRial: true, createdAt: true, userId: true },
      take: 5000,
    });
    const byDay = new Map<string, { calls: number; tokens: number; costRial: number }>();
    const byUser = new Map<string, { calls: number; tokens: number; costRial: number }>();
    for (const l of logs) {
      const dayKey = l.createdAt.toISOString().slice(0, 10);
      const d = byDay.get(dayKey) || { calls: 0, tokens: 0, costRial: 0 };
      d.calls += 1; d.tokens += l.inputTokens + l.outputTokens; d.costRial += l.estimatedCostRial;
      byDay.set(dayKey, d);
      const uk = l.userId || '-';
      const u = byUser.get(uk) || { calls: 0, tokens: 0, costRial: 0 };
      u.calls += 1; u.tokens += l.inputTokens + l.outputTokens; u.costRial += l.estimatedCostRial;
      byUser.set(uk, u);
    }
    const userIds = [...byUser.keys()].filter((k) => k !== '-');
    const users = userIds.length
      ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })
      : [];

    return NextResponse.json({
      monthly: { ...merged, totalCostRial: Math.round(merged.totalCostRial * 100) / 100 },
      byFeature: summaries.flatMap((s) => s.byFeature),
      daily: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
      byUser: [...byUser.entries()].map(([uid, v]) => ({
        displayName: users.find((u) => u.id === uid)?.displayName || 'سیستم',
        ...v, costRial: Math.round(v.costRial * 100) / 100,
      })).sort((a, b) => b.calls - a.calls).slice(0, 20),
    });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('ai-sales-usage', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}
