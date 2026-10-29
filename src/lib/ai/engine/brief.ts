import { db } from '@/lib/db';
import { logApiError } from '@/lib/logger';
import type { AiPreCallBrief } from '../types';
import { AI_OBJECTION_TYPE_LABEL, AI_ACTION_TYPE_LABEL, type AiObjectionType } from '../types';

// ════════════════════════════════════════════════════════════
// PRE-CALL AI BRIEF (v2.27.0)
//
// Grounded aggregation — every line in the brief is derived from
// REAL CRM rows (previous call analyses, customer memory, pending
// actions, recent documents). The recommendation string is built
// deterministically from those facts, so the brief cannot
// hallucinate. When there is not enough data the brief says so
// explicitly («اطلاعات کافی موجود نیست») instead of inventing.
// ════════════════════════════════════════════════════════════

const DAY = 24 * 3600 * 1000;

export async function buildPreCallBrief(centerId: string, contactId?: string | null): Promise<AiPreCallBrief | null> {
  const center = await db.center.findUnique({
    where: { id: centerId },
    select: { id: true, name: true, paymentBehavior: true },
  });
  if (!center) return null;

  const [recordings, memory, pendingActions, recentDocs] = await Promise.all([
    db.aiCallRecording.findMany({
      where: { centerId, status: 'completed' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, createdAt: true, analyses: { orderBy: { createdAt: 'desc' }, take: 1, select: { summary: true, conversionScore: true, temperature: true, objections: true, openQuestions: true, commitments: true, customerNeed: true, products: true, suggestedFollowupDate: true, suggestedFollowupReason: true } } },
    }),
    db.aiCustomerMemory.findFirst({
      where: { centerId, contactId: contactId || null },
      select: { summary: true, preferences: true, insights: true },
    }),
    db.aiNextAction.findMany({
      where: { centerId, status: { in: ['suggested', 'approved', 'executed'] } },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
      take: 5,
      select: { id: true, type: true, title: true, dueAt: true },
    }),
    db.salesDocument.findMany({
      where: { centerId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, documentNumber: true, documentType: true, status: true, createdAt: true },
    }),
  ]);

  const lastRecording = recordings[0];
  const lastAnalysis = lastRecording?.analyses[0] || null;
  const now = new Date();
  const daysSinceLastCall = lastRecording ? Math.floor((now.getTime() - lastRecording.createdAt.getTime()) / DAY) : undefined;

  // Open objections — walk back through recent calls, keep unresolved.
  const openObjections: AiPreCallBrief['openObjections'] = [];
  for (const rec of recordings) {
    const a = rec.analyses[0];
    if (!a) continue;
    try {
      const list = JSON.parse(a.objections || '[]') as { type: string; description: string; severity: string; resolved?: boolean }[];
      for (const o of list) {
        if (o.resolved) continue;
        if (openObjections.some((x) => x.description === o.description)) continue;
        openObjections.push({
          type: o.type,
          typeLabel: AI_OBJECTION_TYPE_LABEL[o.type as AiObjectionType] || o.type,
          description: o.description,
          severity: o.severity,
        });
      }
    } catch { /* corrupt JSON — skip */ }
    if (openObjections.length >= 5) break;
  }

  // Memory
  let memorySummary: string | undefined;
  let memoryPreferences: Record<string, unknown> | undefined;
  if (memory) {
    memorySummary = memory.summary || undefined;
    try { memoryPreferences = JSON.parse(memory.preferences || '{}'); } catch { memoryPreferences = undefined; }
  }

  // Topics: from open objections + open questions + commitments + needs.
  const topicsToDiscuss: string[] = [];
  for (const o of openObjections) topicsToDiscuss.push(`ردیف اعتراض «${o.typeLabel}»: ${o.description}`);
  if (lastAnalysis) {
    try {
      const questions = JSON.parse(lastAnalysis.openQuestions || '[]') as string[];
      for (const q of questions.slice(0, 3)) topicsToDiscuss.push(`پاسخ به سوال باز: ${q}`);
      const commitments = JSON.parse(lastAnalysis.commitments || '{}') as { rep?: string[]; customer?: string[] };
      for (const c of (commitments.rep || []).slice(0, 3)) topicsToDiscuss.push(`پیگیری تعهد کارشناس: ${c}`);
      for (const c of (commitments.customer || []).slice(0, 3)) topicsToDiscuss.push(`استعلام تعهد مشتری: ${c}`);
    } catch { /* skip */ }
  }
  if (memorySummary) topicsToDiscuss.push(`حافظه مشتری: ${memorySummary}`);

  // Suggested questions — grounded on what is actually missing.
  const suggestedQuestions: string[] = [];
  if (lastAnalysis) {
    try {
      const products = JSON.parse(lastAnalysis.products || '[]') as { name?: string }[];
      if (products.length > 0) suggestedQuestions.push(`آیا دربارهٔ «${products[0].name}» به نتیجه‌ای رسیدید؟`);
      const commitments = JSON.parse(lastAnalysis.commitments || '{}') as { customer?: string[] };
      if ((commitments.customer || []).length > 0) suggestedQuestions.push(`تعهدتان «${(commitments.customer || [])[0]}» — پیشرفتی داشتید؟`);
    } catch { /* skip */ }
  }
  if (openObjections.length > 0) suggestedQuestions.push('برای رفع نگرانی مطرح‌شده چه اطلاعاتی از طرف ما لازم دارید؟');
  for (const doc of recentDocs.slice(0, 2)) {
    if (doc.documentType === 'proforma' && doc.status !== 'approved' && doc.status !== 'converted') {
      suggestedQuestions.push(`پیش‌فاکتور ${doc.documentNumber || ''} بررسی شد؟ نظر واحد خرید چیست؟`);
    }
  }

  // Deterministic recommendation from the facts above.
  const aiRecommendation = buildRecommendation({
    hasLastCall: !!lastRecording,
    daysSinceLastCall,
    openObjectionCount: openObjections.length,
    conversionScore: lastAnalysis?.conversionScore,
    temperature: lastAnalysis?.temperature || undefined,
    pendingActions: pendingActions.length,
    lastFollowupDate: lastAnalysis?.suggestedFollowupDate ? lastAnalysis.suggestedFollowupDate.toISOString() : null,
  });

  const enoughData = recordings.length > 0 || !!memory || recentDocs.length > 0;

  return {
    centerId: center.id,
    centerName: center.name,
    lastCallAt: lastRecording?.createdAt.toISOString(),
    lastCallSummary: lastAnalysis?.summary || undefined,
    daysSinceLastCall,
    totalCalls: recordings.length,
    openObjections,
    lastConversionScore: lastAnalysis?.conversionScore ?? undefined,
    lastTemperature: lastAnalysis?.temperature || undefined,
    suggestedFollowupDate: lastAnalysis?.suggestedFollowupDate ? lastAnalysis.suggestedFollowupDate.toISOString() : null,
    suggestedFollowupReason: lastAnalysis?.suggestedFollowupReason || undefined,
    pendingActions: pendingActions.map((a) => ({
      id: a.id, type: a.type,
      typeLabel: AI_ACTION_TYPE_LABEL[a.type as keyof typeof AI_ACTION_TYPE_LABEL] || a.type,
      title: a.title, dueAt: a.dueAt ? a.dueAt.toISOString() : null,
    })),
    memorySummary,
    memoryPreferences,
    topicsToDiscuss: topicsToDiscuss.slice(0, 8),
    suggestedQuestions: suggestedQuestions.slice(0, 5),
    recentDocuments: recentDocs.map((d) => ({
      id: d.id, docNumber: d.documentNumber || '-', docType: d.documentType, status: d.status, createdAt: d.createdAt.toISOString(),
    })),
    aiRecommendation,
    enoughData,
  };
}

function buildRecommendation(f: {
  hasLastCall: boolean; daysSinceLastCall?: number; openObjectionCount: number;
  conversionScore?: number | null; temperature?: string; pendingActions: number;
  lastFollowupDate?: string | null;
}): string {
  if (!f.hasLastCall) {
    return 'اطلاعات کافی موجود نیست. برای این مشتری هنوز تماس تحلیل‌شده‌ای ثبت نشده است؛ پس از اولین تماس، پیشنهاد AI اینجا نمایش داده می‌شود.';
  }
  const parts: string[] = [];
  parts.push(f.daysSinceLastCall !== undefined
    ? `آخرین تماس ${f.daysSinceLastCall === 0 ? 'امروز' : `${f.daysSinceLastCall} روز پیش`} انجام شده است.`
    : 'آخرین تماس ثبت نشده است.');
  if (f.openObjectionCount > 0) parts.push(`در تماس ابتدا ${f.openObjectionCount} اعتراض باز را پیگیری کنید.`);
  if (typeof f.conversionScore === 'number') {
    parts.push(f.conversionScore >= 60
      ? `امتیاز تبدیل ${f.conversionScore}٪ است — مشتری نزدیک به خرید است؛ روی جمع‌بندی و پیش‌فاکتور تمرکز کنید.`
      : `امتیاز تبدیل ${f.conversionScore}٪ است؛ روی کشف نیاز و رفع موانع تمرکز کنید.`);
  }
  if (f.temperature === 'hot' || f.temperature === 'very_hot') parts.push('دمای ارتباط بالاست — تماس را کوتاه نگه ندارید و اقدام بعدی مشخص کنید.');
  if (f.temperature === 'cold') parts.push('دمای ارتباط سرد است — با پرسش‌های باز نیاز جدید جست‌وجو کنید.');
  if (f.pendingActions > 0) parts.push(`${f.pendingActions} اقدام پیشنهادی باز برای این مشتری وجود دارد.`);
  return parts.join(' ');
}

/** Deterministic daily supervisor brief lines from real counters (no LLM numbers). */
export async function buildSupervisorFacts(companyId: string): Promise<{
  facts: Record<string, number>;
}> {
  const now = new Date();
  const yesterdayStart = new Date(now.getTime() - DAY);
  yesterdayStart.setHours(0, 0, 0, 0);
  try {
    const [callsYesterday, analyzedYesterday, hotOpportunities, urgentFollowups, atRisk, missedFollowups, repStats] = await Promise.all([
      db.aiCallRecording.count({ where: { companyId, createdAt: { gte: yesterdayStart } } }),
      db.aiCallRecording.count({ where: { companyId, status: 'completed', createdAt: { gte: yesterdayStart } } }),
      db.aiCallAnalysis.count({ where: { recording: { companyId }, temperature: { in: ['hot', 'very_hot'] } } }),
      db.aiNextAction.count({ where: { companyId, status: { in: ['suggested', 'approved'] }, dueAt: { lte: now } } }),
      db.aiNextAction.count({ where: { companyId, status: 'suggested', type: 'manager' } }),
      db.aiNextAction.count({ where: { companyId, status: { in: ['suggested', 'approved'] }, dueAt: { lt: new Date(now.getTime() - 3 * DAY) } } }),
      db.aiCoachInsight.groupBy({
        by: ['userId'],
        where: { recording: { companyId } },
        _avg: { qualityScore: true },
        _count: { _all: true },
      }),
    ]);
    return {
      facts: {
        callsYesterday,
        analyzedYesterday,
        hotOpportunities,
        urgentFollowups,
        atRisk,
        missedFollowups,
        repsWithCoaching: repStats.length,
      },
    };
  } catch (e) {
    logApiError('ai-sales-brief', 'supervisor facts failed:', e instanceof Error ? e.message : String(e));
    return { facts: {} };
  }
}
