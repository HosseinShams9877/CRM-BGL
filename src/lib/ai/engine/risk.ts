import { db } from '@/lib/db';

// ════════════════════════════════════════════════════════════
// OPPORTUNITY / CUSTOMER RISK ENGINE (v2.27.0)
//
// 100% rule-based on REAL CRM data — deliberately NO LLM here, so
// the risk score is fully explainable and cannot hallucinate.
// Signals (each with weight and human-readable reason):
//   R1 open unresolved objections from the latest analysis  (+25 max)
//   R2 conversion score of the latest call is low (<40)     (+20)
//   R3 temperature cold                                    (+15)
//   R4 no call/contact for > 21 days despite open actions  (+20)
//   R5 suggested/executed follow-up overdue > 3 days       (+20)
//   R6 proforma with no follow-up call for > 5 days        (+15)
//   R7 no activity at all in the last 30 days              (+15)
//   R8 negative payment behavior (bad_payer)               (+10)
// Output: 0-100 risk score + per-signal reasons + recommended action.
// ════════════════════════════════════════════════════════════

export interface RiskSignal {
  code: string;
  points: number;
  reason: string;
}

export interface CustomerRisk {
  centerId: string;
  centerName: string;
  riskScore: number; // 0-100
  signals: RiskSignal[];
  recommendedAction: string;
  lastCallAt: Date | null;
  daysSinceLastCall: number | null;
  conversionScore: number | null;
  temperature: string | null;
}

const DAY = 24 * 3600 * 1000;

/** Compute the risk profile for one center (needs the preloaded bundle). */
export function computeCenterRisk(input: {
  centerId: string;
  centerName: string;
  paymentBehavior?: string | null;
  lastCallAt: Date | null;
  lastConversionScore: number | null;
  lastTemperature: string | null;
  openObjectionCount: number;
  overdueActions: number;
  pendingActions: number;
  lastActivityAt: Date | null;
  lastProformaAt?: Date | null;
  now?: Date;
}): CustomerRisk {
  const now = input.now || new Date();
  const signals: RiskSignal[] = [];
  const daysSinceLastCall = input.lastCallAt
    ? Math.floor((now.getTime() - input.lastCallAt.getTime()) / DAY)
    : null;

  if (input.openObjectionCount > 0) {
    signals.push({
      code: 'R1',
      points: Math.min(25, 10 + input.openObjectionCount * 5),
      reason: `${input.openObjectionCount} اعتراض حل‌نشده از آخرین مکالمه`,
    });
  }
  if (input.lastConversionScore !== null && input.lastConversionScore < 40) {
    signals.push({ code: 'R2', points: 20, reason: `امتیاز تبدیل آخرین تماس پایین است (${input.lastConversionScore} از ۱۰۰)` });
  }
  if (input.lastTemperature === 'cold') {
    signals.push({ code: 'R3', points: 15, reason: 'دمای ارتباط مشتری: سرد' });
  }
  if (input.pendingActions > 0 && (daysSinceLastCall === null || daysSinceLastCall > 21)) {
    signals.push({ code: 'R4', points: 20, reason: daysSinceLastCall === null ? 'هیچ تماسی ثبت نشده در حالی که اقدامات باز وجود دارد' : `${daysSinceLastCall} روز بدون تماس با وجود اقدامات باز` });
  }
  if (input.overdueActions > 0) {
    signals.push({ code: 'R5', points: 20, reason: `${input.overdueActions} اقدام پیگیری از موعد گذشته است` });
  }
  if (input.lastProformaAt) {
    const daysSinceProforma = Math.floor((now.getTime() - input.lastProformaAt.getTime()) / DAY);
    if (daysSinceProforma > 5 && (daysSinceLastCall === null || (input.lastCallAt !== null && input.lastCallAt < input.lastProformaAt))) {
      signals.push({ code: 'R6', points: 15, reason: `پیش‌فاکتور ${daysSinceProforma} روز پیش صادر شده و بعد از آن تماسی ثبت نشده` });
    }
  }
  if (!input.lastActivityAt || now.getTime() - input.lastActivityAt.getTime() > 30 * DAY) {
    signals.push({ code: 'R7', points: 15, reason: 'هیچ فعالیتی در ۳۰ روز گذشته ثبت نشده است' });
  }
  if (input.paymentBehavior === 'bad_payer') {
    signals.push({ code: 'R8', points: 10, reason: 'سابقه پرداخت نامناسب (بدحساب)' });
  }

  const riskScore = Math.min(100, signals.reduce((a, s) => a + s.points, 0));
  const recommendedAction = riskScore >= 60
    ? 'تماس فوری با مشتری و بازنگری پیش‌فاکتور/شرایط — احتمال از دست رفتن فرصت بالاست'
    : riskScore >= 35
      ? 'تماس پیگیری در اولین فرصت و رفع اعتراض‌های باز'
      : 'وضعیت عادی است؛ طبق برنامه پیگیری دوره‌ای ادامه دهید';

  return {
    centerId: input.centerId,
    centerName: input.centerName,
    riskScore,
    signals,
    recommendedAction,
    lastCallAt: input.lastCallAt,
    daysSinceLastCall,
    conversionScore: input.lastConversionScore,
    temperature: input.lastTemperature,
  };
}

/** Bundle query + risk for every center of a company (manager dashboard). */
export async function computeCompanyRisks(companyId: string, limit = 50): Promise<CustomerRisk[]> {
  const centers = await db.center.findMany({
    where: { companyId, isArchived: false },
    select: { id: true, name: true, paymentBehavior: true },
    take: 300,
  });
  if (centers.length === 0) return [];

  const centerIds = centers.map((c) => c.id);
  const [recordings, actions, lastActivities, proformas] = await Promise.all([
    db.aiCallRecording.findMany({
      where: { centerId: { in: centerIds }, status: 'completed' },
      select: { centerId: true, createdAt: true, analyses: { orderBy: { createdAt: 'desc' }, take: 1, select: { conversionScore: true, temperature: true, objections: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    db.aiNextAction.findMany({
      where: { centerId: { in: centerIds }, status: { in: ['suggested', 'approved', 'executed'] } },
      select: { centerId: true, dueAt: true, status: true },
    }),
    db.activity.findMany({
      where: { centerId: { in: centerIds } },
      select: { centerId: true, activityDate: true },
      orderBy: { activityDate: 'desc' },
    }),
    db.salesDocument.findMany({
      where: { centerId: { in: centerIds }, documentType: 'proforma' },
      select: { centerId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const lastCallMap = new Map<string, { at: Date; score: number | null; temperature: string | null; openObjections: number }>();
  for (const r of recordings) {
    if (!r.centerId || lastCallMap.has(r.centerId)) continue;
    const analysis = r.analyses[0];
    let openObjections = 0;
    if (analysis) {
      try {
        const list = JSON.parse(analysis.objections || '[]') as { resolved?: boolean }[];
        openObjections = list.filter((o) => !o.resolved).length;
      } catch { openObjections = 0; }
    }
    lastCallMap.set(r.centerId, { at: r.createdAt, score: analysis?.conversionScore ?? null, temperature: analysis?.temperature || null, openObjections });
  }

  const pendingMap = new Map<string, { pending: number; overdue: number }>();
  const now = new Date();
  for (const a of actions) {
    if (!a.centerId) continue;
    const e = pendingMap.get(a.centerId) || { pending: 0, overdue: 0 };
    e.pending += 1;
    if (a.dueAt && a.dueAt.getTime() < now.getTime() - 3 * DAY && a.status !== 'executed') e.overdue += 1;
    pendingMap.set(a.centerId, e);
  }

  const lastActivityMap = new Map<string, Date>();
  for (const act of lastActivities) {
    if (act.centerId && !lastActivityMap.has(act.centerId)) lastActivityMap.set(act.centerId, act.activityDate);
  }
  const lastProformaMap = new Map<string, Date>();
  for (const p of proformas) {
    if (p.centerId && !lastProformaMap.has(p.centerId)) lastProformaMap.set(p.centerId, p.createdAt);
  }

  const risks = centers.map((c) => {
    const last = lastCallMap.get(c.id);
    const pending = pendingMap.get(c.id) || { pending: 0, overdue: 0 };
    return computeCenterRisk({
      centerId: c.id,
      centerName: c.name,
      paymentBehavior: c.paymentBehavior,
      lastCallAt: last?.at || null,
      lastConversionScore: last?.score ?? null,
      lastTemperature: last?.temperature || null,
      openObjectionCount: last?.openObjections || 0,
      overdueActions: pending.overdue,
      pendingActions: pending.pending,
      lastActivityAt: lastActivityMap.get(c.id) || null,
      lastProformaAt: lastProformaMap.get(c.id) || null,
      now,
    });
  });

  return risks.sort((a, b) => b.riskScore - a.riskScore).slice(0, limit);
}
