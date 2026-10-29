import { db } from '@/lib/db';

// ════════════════════════════════════════════════════════════
// DASHBOARD / MANAGER INTELLIGENCE AGGREGATIONS (v2.27.0)
//
// Pure database aggregations — no LLM, no fabricated numbers.
// All queries are companyId-scoped by the caller.
// ════════════════════════════════════════════════════════════

const DAY = 24 * 3600 * 1000;

export interface AiDashboardStats {
  totals: {
    recordings: number;
    analyzed: number;
    failed: number;
    avgQualityScore: number | null;
    avgConversionScore: number | null;
    hotOpportunities: number;
    veryHotOpportunities: number;
    followupsDue: number;
    missedFollowups: number;
    atRiskActions: number;
    executedActions: number;
    dismissedActions: number;
    totalActions: number;
    conversionRate: number | null; // executed→completed sales proxy: completed actions / executed
  };
  qualityTrend: { date: string; avgScore: number; calls: number }[];
  conversionTrend: { date: string; avgScore: number; calls: number }[];
  objectionDistribution: { type: string; count: number }[];
  temperatureDistribution: { temperature: string; count: number }[];
  repRanking: { userId: string; displayName: string; calls: number; avgQuality: number | null; avgConversion: number | null; executedActions: number; overdueActions: number }[];
}

export async function getDashboardStats(companyId: string, days = 30): Promise<AiDashboardStats> {
  const since = new Date(Date.now() - days * DAY);

  // v2.58.7 (stage 8): the 8th Promise.all slot — aiCoachInsight.findMany
  // over the whole window — was fetched and then DISCARDED by the
  // destructure (`, ,` hole). Dead weight: one unbounded query per
  // dashboard view whose result nobody read. Removed. (Analyzed via the
  // production-hardening performance audit; the trend loop below reads
  // recordingsRecent only.)
  const [recordings, analyzed, failed, qualityAgg, conversionAgg, tempGroups, actionGroups, recordingsRecent] = await Promise.all([
    db.aiCallRecording.count({ where: { companyId } }),
    db.aiCallRecording.count({ where: { companyId, status: 'completed' } }),
    db.aiCallRecording.count({ where: { companyId, status: 'failed' } }),
    db.aiCoachInsight.aggregate({ where: { recording: { companyId } }, _avg: { qualityScore: true } }),
    db.aiCallAnalysis.aggregate({ where: { recording: { companyId } }, _avg: { conversionScore: true } }),
    db.aiCallAnalysis.groupBy({ by: ['temperature'], where: { recording: { companyId } }, _count: { _all: true } }),
    db.aiNextAction.groupBy({ by: ['status'], where: { companyId }, _count: { _all: true } }),
    db.aiCallRecording.findMany({
      where: { companyId, status: 'completed', createdAt: { gte: since } },
      select: { createdAt: true, analyses: { orderBy: { createdAt: 'desc' }, take: 1, select: { conversionScore: true, objections: true } }, coachInsights: { select: { qualityScore: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const hotOpportunities = tempGroups.find((g) => g.temperature === 'hot')?._count._all || 0;
  const veryHotOpportunities = tempGroups.find((g) => g.temperature === 'very_hot')?._count._all || 0;

  const now = new Date();
  const [followupsDue, missedFollowups, atRiskActions] = await Promise.all([
    db.aiNextAction.count({ where: { companyId, status: { in: ['suggested', 'approved'] }, dueAt: { lte: now } } }),
    db.aiNextAction.count({ where: { companyId, status: { in: ['suggested', 'approved'] }, dueAt: { lt: new Date(now.getTime() - 3 * DAY) } } }),
    db.aiNextAction.count({ where: { companyId, status: 'suggested', priority: 'high' } }),
  ]);

  const statusCount = (s: string) => actionGroups.find((g) => g.status === s)?._count._all || 0;
  const executedActions = statusCount('executed') + statusCount('completed');
  const completedActions = statusCount('completed');
  const totalActions = actionGroups.reduce((a, g) => a + g._count._all, 0);

  // Trends by day (Jalali rendering happens in the UI).
  const qualityByDay = new Map<string, { sum: number; n: number }>();
  const conversionByDay = new Map<string, { sum: number; n: number }>();
  const objectionCount = new Map<string, number>();
  for (const r of recordingsRecent) {
    const key = r.createdAt.toISOString().slice(0, 10);
    const analysis = r.analyses[0];
    if (analysis) {
      const e = conversionByDay.get(key) || { sum: 0, n: 0 };
      e.sum += analysis.conversionScore; e.n += 1;
      conversionByDay.set(key, e);
      try {
        const list = JSON.parse(analysis.objections || '[]') as { type: string }[];
        for (const o of list) objectionCount.set(o.type, (objectionCount.get(o.type) || 0) + 1);
      } catch { /* skip */ }
    }
    const coach = r.coachInsights[0];
    if (coach) {
      const e = qualityByDay.get(key) || { sum: 0, n: 0 };
      e.sum += coach.qualityScore; e.n += 1;
      qualityByDay.set(key, e);
    }
  }
  const toTrend = (m: Map<string, { sum: number; n: number }>) =>
    [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, avgScore: Math.round(v.sum / v.n), calls: v.n }));

  // Representative ranking.
  const recUsers = await db.aiCallRecording.groupBy({
    by: ['userId'],
    where: { companyId, userId: { not: null } },
    _count: { _all: true },
  });
  const userIds = recUsers.map((u) => u.userId).filter((x): x is string => !!x);
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })
    : [];
  const actionByUser = await db.aiNextAction.groupBy({ by: ['assignedTo', 'status'], where: { companyId }, _count: { _all: true } });
  const coachByUser = await db.aiCoachInsight.groupBy({ by: ['userId'], where: { recording: { companyId } }, _avg: { qualityScore: true } });
  const conversionByUser = new Map<string, { sum: number; n: number }>();
  for (const r of await db.aiCallRecording.findMany({
    where: { companyId, status: 'completed', userId: { not: null } },
    select: { userId: true, analyses: { orderBy: { createdAt: 'desc' }, take: 1, select: { conversionScore: true } } },
  })) {
    if (!r.userId) continue;
    const a = r.analyses[0];
    if (!a) continue;
    const e = conversionByUser.get(r.userId) || { sum: 0, n: 0 };
    e.sum += a.conversionScore; e.n += 1;
    conversionByUser.set(r.userId, e);
  }
  const repRanking = users.map((u) => {
    const calls = recUsers.find((x) => x.userId === u.id)?._count._all || 0;
    const avgQuality = coachByUser.find((x) => x.userId === u.id)?._avg.qualityScore ?? null;
    const conv = conversionByUser.get(u.id);
    const executed = actionByUser.filter((x) => x.assignedTo === u.id && (x.status === 'executed' || x.status === 'completed')).reduce((a, x) => a + x._count._all, 0);
    const overdue = actionByUser.filter((x) => x.assignedTo === u.id && x.status === 'suggested').reduce((a, x) => a + x._count._all, 0);
    return {
      userId: u.id, displayName: u.displayName, calls,
      avgQuality: avgQuality !== null ? Math.round(avgQuality) : null,
      avgConversion: conv ? Math.round(conv.sum / conv.n) : null,
      executedActions: executed, overdueActions: overdue,
    };
  }).sort((a, b) => b.calls - a.calls);

  return {
    totals: {
      recordings, analyzed, failed,
      avgQualityScore: qualityAgg._avg.qualityScore !== null ? Math.round(qualityAgg._avg.qualityScore) : null,
      avgConversionScore: conversionAgg._avg.conversionScore !== null ? Math.round(conversionAgg._avg.conversionScore) : null,
      hotOpportunities, veryHotOpportunities,
      followupsDue, missedFollowups, atRiskActions,
      executedActions, dismissedActions: statusCount('dismissed'), totalActions,
      conversionRate: executedActions > 0 ? Math.round((completedActions / executedActions) * 100) : null,
    },
    qualityTrend: toTrend(qualityByDay),
    conversionTrend: toTrend(conversionByDay),
    objectionDistribution: [...objectionCount.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    temperatureDistribution: tempGroups.map((g) => ({ temperature: g.temperature || 'unknown', count: g._count._all })),
    repRanking,
  };
}
