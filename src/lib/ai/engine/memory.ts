import { db } from '@/lib/db';
import { getLLMProvider, extractJsonObject } from '../providers/llm';
import { buildMemorySystemPrompt, buildMemoryUserPrompt } from '../prompts';
import { memoryExtractionSchema } from '../extraction';
import { getAiSettings } from '../settings';
import { recordAiUsage } from '../usage';
import { forScope } from '@/lib/logger';
const logger = forScope('ai memory');
import type { AnalysisExtractionRaw } from '../extraction';
import { fencedTx, type LeaseContext } from './lease';
import { reconcileCustomerMemoryDuplicates } from '../memory-dedupe';

// v2.58.10: a CORRUPT cell (hand-edited DB, partial write from an ancient
// version) must never crash the whole memory stage — and must never be
// silently REPLACED either. Parse defensively: fall back to an empty
// object for the merge input, log the corruption loudly (the source
// string stays in the row until a human decides what to do with it).
// v2.58.11 (audit medium finding): exported — the MANUAL memory route
// used a raw JSON.parse on the same cells and 500'd on the exact
// corruption this parser was built to survive.
export function safeParseJsonCell(raw: string | null | undefined, context: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* fall through to the loud path */ }
  logger.warn('AI_MEMORY_CORRUPT_CELL', { context, length: raw.length });
  return {};
}

// ════════════════════════════════════════════════════════════
// STRUCTURED CUSTOMER MEMORY (v2.27.0)
//
// Per Center (+optional Contact) memory that helps future calls.
// NEVER stores the raw transcript — only durable, consolidated
// facts (preferences, open objections, competitors, payment
// behavior, decision makers, commitments, relationship notes).
// The merge is done by the LLM but validated by zod; the source
// of truth for the merge inputs is the *validated analysis*, so
// no ungrounded field can enter the memory.
// ════════════════════════════════════════════════════════════

export async function upsertMemoryFromAnalysis(
  companyId: string,
  centerId: string | null,
  contactId: string | null,
  analysisId: string,
  extraction: AnalysisExtractionRaw,
  userId: string | null,
  lease?: LeaseContext,
): Promise<void> {
  if (!centerId) return;
  const settings = await getAiSettings();
  const llm = getLLMProvider(settings.llmProvider);

  const existing = await db.aiCustomerMemory.findFirst({ where: { centerId, contactId } });

  // v2.58.4 (external audit F07) — defense in depth: the resume path once
  // fed this function a STUB extraction whose objections/commitments were
  // undefined (TypeError: Cannot read properties of undefined (reading
  // 'filter')). The pipeline now rebuilds a complete object, and these
  // guards make the contract explicit: a malformed extraction can never
  // crash the stage again.
  const objections = Array.isArray(extraction.objections) ? extraction.objections : [];
  const products = Array.isArray(extraction.products) ? extraction.products : [];
  const commitments = {
    rep: Array.isArray(extraction.commitments?.rep) ? extraction.commitments.rep : [],
    customer: Array.isArray(extraction.commitments?.customer) ? extraction.commitments.customer : [],
  };

  // What the analysis actually established (grounded input for the merge).
  const analysisFacts = {
    summary: extraction.summary,
    customerNeed: extraction.customerNeed,
    openObjections: objections.filter((o) => !o.resolved).map((o) => `${o.type}: ${o.description}`),
    resolvedObjections: objections.filter((o) => o.resolved).map((o) => `${o.type}: ${o.description}`),
    products: products.map((p) => p.name).filter(Boolean),
    competitors: Array.isArray(extraction.competitors) ? extraction.competitors : [],
    decisionMakers: Array.isArray(extraction.decisionMakers) ? extraction.decisionMakers : [],
    customerCommitments: commitments.customer,
    repCommitments: commitments.rep,
    paymentTerms: extraction.paymentTerms,
    purchaseTimeframe: extraction.purchaseTimeframe,
    budget: extraction.budget,
  };

  try {
    const completion = await llm.complete([
      { role: 'system', content: buildMemorySystemPrompt() },
      { role: 'user', content: buildMemoryUserPrompt(existing ? JSON.stringify({ summary: existing.summary, preferences: existing.preferences, insights: existing.insights }) : '', JSON.stringify(analysisFacts)) },
    ], { maxTokens: 1500, temperature: 0.1 });
    await recordAiUsage({
      companyId, userId, feature: 'memory', provider: completion.provider, model: completion.model,
      inputTokens: completion.inputTokens, outputTokens: completion.outputTokens,
    });

    const parsed = extractJsonObject(completion.content);
    if (parsed) {
      const check = memoryExtractionSchema.safeParse(parsed);
      if (check.success) {
        const data = check.data;
        // v2.58.5 (R4): the WRITE is fenced — the LLM merge ran outside;
        // only the CURRENT lease owner's memory commit lands. A lease-less
        // caller (none today — the pipeline always passes one) falls back
        // to the unfenced write for API compatibility.
        // v2.58.7 (D2): both branches reconcile duplicates for the
        // (centerId, contactId) key INSIDE the same transaction — the
        // findFirst→create race between two concurrent recordings can no
        // longer leave two memory rows (keep-latest, last-write-wins).
        const write = lease
          ? fencedTx(lease.recordingId, lease.token, async (tx) => (existing
            ? tx.aiCustomerMemory.update({
              where: { id: existing.id },
              data: {
                summary: data.summary || existing.summary,
                preferences: JSON.stringify(data.preferences || safeParseJsonCell(existing.preferences, 'preferences')),
                insights: JSON.stringify(data.insights || safeParseJsonCell(existing.insights, 'insights')),
                source: 'ai',
                updatedById: userId,
              },
            })
            : tx.aiCustomerMemory.create({
              data: {
                companyId, centerId, contactId,
                summary: data.summary,
                preferences: JSON.stringify(data.preferences),
                insights: JSON.stringify(data.insights),
                source: 'ai',
                updatedById: userId,
              },
            })).then(async () => {
            await reconcileCustomerMemoryDuplicates(tx, centerId, contactId);
          }))
          : (existing
            ? db.aiCustomerMemory.update({
              where: { id: existing.id },
              data: {
                summary: data.summary || existing.summary,
                preferences: JSON.stringify(data.preferences || safeParseJsonCell(existing.preferences, 'preferences')),
                insights: JSON.stringify(data.insights || safeParseJsonCell(existing.insights, 'insights')),
                source: 'ai',
                updatedById: userId,
              },
            })
            : db.aiCustomerMemory.create({
              data: {
                companyId, centerId, contactId,
                summary: data.summary,
                preferences: JSON.stringify(data.preferences),
                insights: JSON.stringify(data.insights),
                source: 'ai',
                updatedById: userId,
              },
            })).then(async () => {
            await reconcileCustomerMemoryDuplicates(db, centerId, contactId);
          });
        await write;
        return;
      }
    }
    // LLM merge failed → deterministic fallback merge of the grounded facts.
    await mergeMemoryFallback(companyId, centerId, contactId, analysisFacts, userId, existing?.id, lease);
  } catch {
    await mergeMemoryFallback(companyId, centerId, contactId, analysisFacts, userId, existing?.id, lease);
  }
  void analysisId;
}

interface GroundedFacts {
  summary: string;
  customerNeed?: string;
  openObjections: string[];
  resolvedObjections: string[];
  products: string[];
  competitors: string[];
  decisionMakers: { name?: string; role?: string; type: string }[];
  customerCommitments: string[];
  repCommitments: string[];
  paymentTerms?: string;
  purchaseTimeframe?: string;
  budget?: string;
}

/** No-LLM merge: union of durable sets, capped, deduped.
 *  v2.58.5 (R4): fenced when a lease context is provided. */
async function mergeMemoryFallback(
  companyId: string, centerId: string, contactId: string | null,
  facts: GroundedFacts, userId: string | null, existingId?: string,
  lease?: LeaseContext,
): Promise<void> {
  const existing = existingId
    ? await db.aiCustomerMemory.findUnique({ where: { id: existingId } })
    : null;
  // v2.58.10: corrupt insights cell → loud log + empty merge base (the
  // LLM path above already guards its own cells the same way).
  const prev = safeParseJsonCell(existing?.insights, 'insights:fallback');
  const mergeList = (a: unknown, b: string[], cap = 20): string[] => {
    const setA = Array.isArray(a) ? a.map(String) : [];
    return [...new Set([...b, ...setA])].slice(0, cap);
  };
  const insights: Record<string, unknown> = {
    ...prev,
    openObjections: mergeList(prev.openObjections, facts.openObjections),
    competitors: mergeList(prev.competitors, facts.competitors),
    decisionMakers: facts.decisionMakers.length > 0 ? facts.decisionMakers : prev.decisionMakers || [],
    pastCommitments: mergeList(prev.pastCommitments, facts.customerCommitments),
    purchaseHistory: facts.products.length > 0 ? mergeList(prev.productInterestsSeen, facts.products) : prev.productInterestsSeen || [],
  };
  if (facts.paymentTerms) insights['paymentBehavior'] = facts.paymentTerms;
  const doWrite = (tx: Pick<typeof db, 'aiCustomerMemory'>) => (existing
    ? tx.aiCustomerMemory.update({
      where: { id: existing.id },
      data: { insights: JSON.stringify(insights), updatedById: userId, source: 'ai' },
    })
    : tx.aiCustomerMemory.create({
      data: {
        companyId, centerId, contactId,
        summary: facts.summary.slice(0, 1000),
        preferences: '{}',
        insights: JSON.stringify(insights),
        source: 'ai',
        updatedById: userId,
      },
    }));
  if (lease) {
    // v2.58.7 (D2): reconcile duplicates inside the SAME fenced transaction.
    await fencedTx(lease.recordingId, lease.token, async (tx) => {
      await doWrite(tx);
      await reconcileCustomerMemoryDuplicates(tx, centerId, contactId);
    });
  } else {
    await doWrite(db);
    await reconcileCustomerMemoryDuplicates(db, centerId, contactId);
  }
}
