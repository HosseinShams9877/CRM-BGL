import { db } from '@/lib/db';

// ════════════════════════════════════════════════════════════
// AI USAGE & COST CONTROL (v2.27.0)
// هر فراخوانی AI ثبت می‌شود: tokens، دقیقه صوت، provider، مدل،
// هزینه تخمینی، کاربر و شرکت — با سقف ماهانه قابل تنظیم ادمین.
// ════════════════════════════════════════════════════════════

export interface UsageRecordInput {
  companyId: string;
  userId?: string | null;
  feature: 'call_analysis' | 'coaching' | 'brief' | 'memory' | 'playbook' | 'supervisor' | 'stt';
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
  status?: 'success' | 'failed';
}

/**
 * Rough cost estimate in Rials. The z-ai provider is included with the
 * platform (cost 0). External providers are estimated at a configurable
 * blended rate; the estimate is for budget visibility, not invoicing.
 */
function estimateCostRial(provider: string, inputTokens: number, outputTokens: number, audioSeconds: number): number {
  if (provider === 'zai') return 0;
  // Blended estimate: ~0.5 Rial per 1K tokens is a placeholder scale that
  // admins can reason about; real billing comes from the provider console.
  const tokenCost = ((inputTokens + outputTokens) / 1000) * 0.5;
  const audioCost = (audioSeconds / 60) * 10;
  return Math.round((tokenCost + audioCost) * 100) / 100;
}

export async function recordAiUsage(input: UsageRecordInput): Promise<void> {
  const inputTokens = Math.max(0, Math.round(input.inputTokens || 0));
  const outputTokens = Math.max(0, Math.round(input.outputTokens || 0));
  const audioSeconds = Math.max(0, Math.round(input.audioSeconds || 0));
  await db.aiUsageLog.create({
    data: {
      companyId: input.companyId,
      userId: input.userId || null,
      feature: input.feature,
      provider: input.provider,
      model: input.model || '',
      inputTokens,
      outputTokens,
      audioSeconds,
      estimatedCostRial: estimateCostRial(input.provider, inputTokens, outputTokens, audioSeconds),
      status: input.status || 'success',
    },
  }).catch(() => undefined); // usage logging must never break the main flow
}

export interface MonthlyUsageSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalAudioSeconds: number;
  totalCostRial: number;
  byFeature: { feature: string; calls: number; tokens: number; costRial: number }[];
}

/** Month-to-date usage for a company (all users). */
export async function getMonthlyUsage(companyId: string): Promise<MonthlyUsageSummary> {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const rows = await db.aiUsageLog.findMany({
    where: { companyId, createdAt: { gte: start }, status: 'success' },
    select: { feature: true, inputTokens: true, outputTokens: true, audioSeconds: true, estimatedCostRial: true },
  });
  const byFeatureMap = new Map<string, { calls: number; tokens: number; costRial: number }>();
  let totalInputTokens = 0, totalOutputTokens = 0, totalAudioSeconds = 0, totalCostRial = 0;
  for (const r of rows) {
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalAudioSeconds += r.audioSeconds;
    totalCostRial += r.estimatedCostRial;
    const f = byFeatureMap.get(r.feature) || { calls: 0, tokens: 0, costRial: 0 };
    f.calls += 1;
    f.tokens += r.inputTokens + r.outputTokens;
    f.costRial += r.estimatedCostRial;
    byFeatureMap.set(r.feature, f);
  }
  return {
    totalCalls: rows.length,
    totalInputTokens,
    totalOutputTokens,
    totalAudioSeconds,
    totalCostRial: Math.round(totalCostRial * 100) / 100,
    byFeature: [...byFeatureMap.entries()].map(([feature, v]) => ({ feature, ...v })),
  };
}

/** Has the company exceeded its monthly AI cost limit? (0 = unlimited) */
export async function isOverMonthlyLimit(companyId: string, limitRial: number): Promise<boolean> {
  if (!limitRial || limitRial <= 0) return false;
  const usage = await getMonthlyUsage(companyId);
  return usage.totalCostRial >= limitRial;
}
