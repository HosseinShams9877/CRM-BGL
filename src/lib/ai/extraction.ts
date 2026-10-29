// ════════════════════════════════════════════════════════════
// EXTRACTION VALIDATION (v2.27.0)
//
// The LLM answer is untrusted: it is parsed, coerced and clamped
// through zod before anything touches the database. Unknown enum
// values fall back to safe defaults ('other' / '' ) instead of
// failing the whole analysis — partial grounded data beats no data.
// ════════════════════════════════════════════════════════════

import { z } from 'zod';
import { AI_INTENTS, AI_TEMPERATURES_SET, AI_OBJECTION_TYPES_SET, AI_ACTION_TYPES_SET, AI_BUYING_ROLES_SET } from './enums';

const str = z.string();
const cleanStr = str.transform((s) => s.trim().slice(0, 4000));
const shortStr = str.transform((s) => s.trim().slice(0, 400));
const strArray = z.array(cleanStr).max(30).default([]);

const scoreReason = z.object({
  factor: shortStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  impact: z.union([z.number(), z.string()]).transform((n) => (Number(n) >= 0 ? 1 : -1)),
  detail: cleanStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
});

const objectionShape = z.object({
  type: str,
  description: cleanStr,
  severity: str,
  resolved: z.boolean().nullish().transform((v) => v === true),
  recommendedResponse: cleanStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
});
// LLMs sometimes emit objections as plain strings («قیمت بالا») instead of
// objects — coerce both shapes so a valid analysis never fails wholesale.
const objection = z.union([objectionShape, cleanStr]).transform((v) =>
  typeof v === 'string'
    ? { type: 'other', description: v, severity: 'medium', resolved: false, recommendedResponse: '' }
    : v,
);

const actionDraft = z.object({
  type: str,
  title: cleanStr,
  detail: cleanStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  priority: str,
  dueAt: str.nullish().transform((v) => (v === null || v === undefined ? null : v)),
  reason: cleanStr,
  confidence: z.union([z.number(), z.string()]).transform((v) => Math.max(0, Math.min(1, Number(v)))).catch(0.5),
});

const decisionMakerShape = z.object({
  name: shortStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  role: shortStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  type: str,
});
const decisionMaker = z.union([decisionMakerShape, cleanStr]).transform((v) =>
  typeof v === 'string' ? { name: v, role: '', type: 'influencer' } : v,
);

const productShape = z.object({
  name: shortStr,
  quantity: z.union([z.number(), z.string()]).nullish().transform((v) => (v === null || v === undefined ? '' : String(v).slice(0, 50))),
  note: cleanStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
});
const product = z.union([productShape, cleanStr]).transform((v) =>
  typeof v === 'string' ? { name: v, quantity: '', note: '' } : v,
);

export const analysisExtractionSchema = z.object({
  summary: cleanStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  topic: shortStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  callReason: cleanStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  customerNeed: cleanStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  customerProblems: strArray,
  products: z.array(product).max(20).default([]),
  budget: shortStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  purchaseTimeframe: shortStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  intent: str.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  temperature: str.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  conversionScore: z.union([z.number(), z.string()]).transform((v) => Math.max(0, Math.min(100, Math.round(Number(v))))).catch(0),
  scoreReasons: z.array(scoreReason).max(20).default([]),
  objections: z.array(objection).max(20).default([]),
  commitments: z.object({
    rep: strArray,
    customer: strArray,
  }).partial().default({}).transform((c) => ({ rep: c.rep || [], customer: c.customer || [] })),
  openQuestions: strArray,
  risks: strArray,
  opportunities: strArray,
  paymentTerms: shortStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  competitors: strArray,
  decisionMakers: z.array(decisionMaker).max(20).default([]),
  suggestedFollowupDate: str.nullish().transform((v) => (v === null || v === undefined ? null : v)),
  suggestedFollowupReason: cleanStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  stageSuggestion: shortStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  nextActions: z.array(actionDraft).max(10).default([]),
  segments: z.array(z.object({
    speaker: z.string().nullish().transform((v) => (v === null || v === undefined ? 'other' : v)),
    text: cleanStr,
  })).max(400).default([]),
  confidence: z.union([z.number(), z.string()]).transform((v) => Math.max(0, Math.min(1, Number(v)))).catch(0.5),
});
export type AnalysisExtractionRaw = z.infer<typeof analysisExtractionSchema>;

export const coachExtractionSchema = z.object({
  qualityScore: z.union([z.number(), z.string()]).transform((v) => Math.max(0, Math.min(100, Math.round(Number(v))))).catch(0),
  scores: z.record(z.string(), z.union([z.number(), z.string()]).transform((v) => Math.max(0, Math.min(100, Math.round(Number(v))))).catch(0)).default({}),
  strengths: strArray,
  improvements: strArray,
  mistakes: strArray,
  recommendations: strArray,
  confidence: z.number().min(0).max(1).catch(0.5).default(0.5),
});
export type CoachExtractionRaw = z.infer<typeof coachExtractionSchema>;

export const memoryExtractionSchema = z.object({
  summary: cleanStr.nullish().transform((v) => (v === null || v === undefined ? '' : v)),
  preferences: z.record(z.string(), z.unknown()).default({}),
  insights: z.record(z.string(), z.unknown()).default({}),
});

export const briefLinesSchema = z.object({
  brief: z.array(cleanStr).max(12).default([]),
});

// ── Normalization helpers ───────────────────────────────────
export function normalizeIntent(v: string): string {
  return AI_INTENTS.includes(v as never) ? v : 'other';
}

export function normalizeTemperature(v: string): string {
  const t = v.toLowerCase().trim();
  if (AI_TEMPERATURES_SET.has(t)) return t;
  if (t.includes('very')) return 'very_hot';
  if (t.includes('hot')) return 'hot';
  if (t.includes('warm')) return 'warm';
  if (t.includes('cold')) return 'cold';
  return '';
}

export function normalizeObjectionType(v: string): string {
  const t = v.toLowerCase().trim();
  return AI_OBJECTION_TYPES_SET.has(t) ? t : 'other';
}

export function normalizeSeverity(v: string): 'low' | 'medium' | 'high' {
  const t = String(v).toLowerCase().trim();
  if (t === 'high' || t === 'بالا') return 'high';
  if (t === 'low' || t === 'پایین') return 'low';
  return 'medium';
}

export function normalizePriority(v: string): 'high' | 'medium' | 'low' {
  const t = String(v).toLowerCase().trim();
  if (t === 'high' || t === 'بالا' || t === 'فوری') return 'high';
  if (t === 'low' || t === 'پایین') return 'low';
  return 'medium';
}

export function normalizeActionType(v: string): string {
  const t = v.toLowerCase().trim();
  return AI_ACTION_TYPES_SET.has(t) ? t : '';
}

export function normalizeBuyingRole(v: string): string {
  const t = v.toLowerCase().trim();
  return AI_BUYING_ROLES_SET.has(t) ? t : 'influencer';
}

/** Accept YYYY-MM-DD (optionally with time) → ISO string or null. */
export function normalizeIsoDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const dt = new Date(`${m[1]}-${m[2]}-${m[3]}T09:00:00.000Z`);
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString();
}
