import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { getDashboardStats } from '@/lib/ai/engine/stats';
import { computeCompanyRisks } from '@/lib/ai/engine/risk';
import { buildSupervisorFacts } from '@/lib/ai/engine/brief';
import { hasAiPermission, aiDenied, resolveAiCompanyScope } from '@/lib/ai/api-helpers';

// ════════════════════════════════════════════════════════════
// AI SALES — MANAGER DASHBOARD API (v2.27.0)
// POST { companySlug?, days? } → KPIs + trends + rep ranking +
// at-risk customers + supervisor facts. Manager permission only.
// ════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    if (!hasAiPermission(user, 'ai_manager_dashboard')) {
      return aiDenied('داشبورد هوش مدیریتی فقط برای مدیر سیستم فعال است.');
    }

    const body = await req.json().catch(() => ({}));
    const { companySlug, days } = body as { companySlug?: string; days?: number };
    const scope = await resolveAiCompanyScope(user, companySlug);
    if ('error' in scope) return scope.error;

    const companyIds = scope.companyIds;
    if (!companyIds || companyIds.length === 0) {
      return NextResponse.json({ error: 'شرکتی برای نمایش مشخص نیست.' }, { status: 400 });
    }
    const windowDays = Math.min(90, Math.max(7, Number(days) || 30));

    const [stats, risks, supervisorFacts] = await Promise.all([
      Promise.all(companyIds.map((cid) => getDashboardStats(cid, windowDays))),
      Promise.all(companyIds.map((cid) => computeCompanyRisks(cid, 20))),
      Promise.all(companyIds.map((cid) => buildSupervisorFacts(cid))),
    ]);

    // Cross-company merge for the holding view.
    const merged = stats.reduce((acc, s) => {
      acc.totals.recordings += s.totals.recordings;
      acc.totals.analyzed += s.totals.analyzed;
      acc.totals.failed += s.totals.failed;
      acc.totals.hotOpportunities += s.totals.hotOpportunities;
      acc.totals.veryHotOpportunities += s.totals.veryHotOpportunities;
      acc.totals.followupsDue += s.totals.followupsDue;
      acc.totals.missedFollowups += s.totals.missedFollowups;
      acc.totals.atRiskActions += s.totals.atRiskActions;
      acc.totals.executedActions += s.totals.executedActions;
      acc.totals.dismissedActions += s.totals.dismissedActions;
      acc.totals.totalActions += s.totals.totalActions;
      return acc;
    }, {
      totals: {
        recordings: 0, analyzed: 0, failed: 0,
        avgQualityScore: null as number | null,
        avgConversionScore: null as number | null,
        hotOpportunities: 0, veryHotOpportunities: 0, followupsDue: 0, missedFollowups: 0,
        atRiskActions: 0, executedActions: 0, dismissedActions: 0, totalActions: 0,
        conversionRate: null as number | null,
      },
    });
    merged.totals.avgQualityScore = stats.every((s) => s.totals.avgQualityScore === null)
      ? null : Math.round(stats.reduce((a, s) => a + (s.totals.avgQualityScore || 0), 0) / stats.filter((s) => s.totals.avgQualityScore !== null).length);
    merged.totals.avgConversionScore = stats.every((s) => s.totals.avgConversionScore === null)
      ? null : Math.round(stats.reduce((a, s) => a + (s.totals.avgConversionScore || 0), 0) / stats.filter((s) => s.totals.avgConversionScore !== null).length);

    const repRanking = stats.flatMap((s) => s.repRanking);
    const objectionMap = new Map<string, number>();
    for (const s of stats) for (const o of s.objectionDistribution) objectionMap.set(o.type, (objectionMap.get(o.type) || 0) + o.count);
    const temperatureMap = new Map<string, number>();
    for (const s of stats) for (const t of s.temperatureDistribution) temperatureMap.set(t.temperature, (temperatureMap.get(t.temperature) || 0) + t.count);

    return NextResponse.json({
      days: windowDays,
      totals: merged.totals,
      qualityTrend: stats[0]?.qualityTrend || [],
      conversionTrend: stats[0]?.conversionTrend || [],
      objectionDistribution: [...objectionMap.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      temperatureDistribution: [...temperatureMap.entries()].map(([temperature, count]) => ({ temperature, count })),
      repRanking,
      atRisk: risks.flat().slice(0, 20),
      supervisorFacts: supervisorFacts.map((f) => f.facts),
    });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('ai-sales-dashboard', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}
