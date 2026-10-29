// ════════════════════════════════════════════════════════════
// LLM PROVIDER ABSTRACTION (v2.27.0)
//
// Vendor lock-in is forbidden: the analysis/coaching/brief engines talk
// to this interface only. Two implementations ship today:
//   • zai          — z-ai-web-dev-sdk (default, zero-config, works here)
//   • openai_compat — any OpenAI-compatible endpoint configured through
//                     the existing ai_bridge.* settings (admin panel)
// Adding a provider = implementing LLMProvider + registering it below.
// ════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ApiError } from '@/lib/api-error';
import { logApiError } from '@/lib/logger';
import { safeOutboundFetch } from '@/lib/safe-outbound';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletion {
  content: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMProvider {
  readonly id: string;
  /** Complete a chat turn. Throws on failure — callers own retry policy. */
  complete(messages: LlmMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<LlmCompletion>;
}

// ── Provider: z-ai-web-dev-sdk ─────────────────────────────
class ZaiLLMProvider implements LLMProvider {
  readonly id = 'zai';

  async complete(messages: LlmMessage[], _opts?: { maxTokens?: number; temperature?: number }): Promise<LlmCompletion> {
    // Dynamic import keeps the SDK out of any client-compiled graph and
    // avoids paying the init cost when AI features are unused.
    const { default: ZAI } = await import('z-ai-web-dev-sdk');
    const zai = await ZAI.create();

    // The SDK takes the system instruction as an 'assistant'-role leading
    // message (see skills/llm). Map system → leading assistant message.
    const mapped = messages.map((m) =>
      m.role === 'system' ? { role: 'assistant' as const, content: m.content } : m,
    );

    const completion = await zai.chat.completions.create({
      messages: mapped,
      thinking: { type: 'disabled' },
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
      throw new ApiError(502, 'پاسخ خالی از سرویس هوش مصنوعی دریافت شد');
    }
    const usage = (completion as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    return {
      content,
      provider: 'zai',
      model: (completion as { model?: string }).model || 'zai-default',
      inputTokens: usage?.prompt_tokens ?? Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 4),
      outputTokens: usage?.completion_tokens ?? Math.ceil(content.length / 4),
    };
  }
}

// ── Provider: OpenAI-compatible endpoint (ai_bridge settings) ──
interface AiBridgeConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
}

async function getAiBridgeConfig(): Promise<AiBridgeConfig> {
  const metas = await db.meta.findMany({
    where: { key: { in: ['ai_bridge.api_url', 'ai_bridge.api_key', 'ai_bridge.model'] } },
  });
  const map: Record<string, string> = {};
  for (const m of metas) map[m.key] = m.value;
  return { apiUrl: map['ai_bridge.api_url'] || '', apiKey: map['ai_bridge.api_key'] || '', model: map['ai_bridge.model'] || 'gpt-4o-mini' };
}

class OpenAiCompatProvider implements LLMProvider {
  readonly id = 'openai_compat';

  async complete(messages: LlmMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<LlmCompletion> {
    const cfg = await getAiBridgeConfig();
    if (!cfg.apiUrl) {
      throw new ApiError(400, 'تنظیمات سرویس OpenAI-سازگار (ai_bridge) کامل نیست');
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

    // v2.58.3 — the guarded outbound door: SSRF validation + pinned DNS +
    // ONE whole-operation deadline (headers AND body) + response size cap.
    // A raw fetch() here could be pointed at localhost/metadata or hang
    // forever on a stalled body.
    const res = await safeOutboundFetch(
      cfg.apiUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          messages,
          max_tokens: opts?.maxTokens ?? 3000,
          temperature: opts?.temperature ?? 0.3,
        }),
      },
      { timeoutMs: 60_000, maxResponseBytes: 5 * 1024 * 1024 },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logApiError('ai-sales-llm', 'openai_compat error:', res.status, errText.slice(0, 300));
      throw new Error(`خطا در سرویس هوش مصنوعی خارجی (${res.status})`);
    }
    const data = await res.json() as {
      choices?: { message?: { content?: string } }[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
      throw new ApiError(502, 'پاسخ خالی از سرویس هوش مصنوعی خارجی');
    }
    return {
      content,
      provider: 'openai_compat',
      model: data.model || cfg.model,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  }
}

// ── Registry ────────────────────────────────────────────────
const ZAI_LLM = new ZaiLLMProvider();
const OPENAI_COMPAT_LLM = new OpenAiCompatProvider();

export function getLLMProvider(id: string): LLMProvider {
  if (id === 'openai_compat') return OPENAI_COMPAT_LLM;
  return ZAI_LLM;
}

/** Extract the first JSON object from an LLM text answer. */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Strip markdown fences the model may add despite instructions.
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // Direct parse
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }
  // First {...} block scan (balanced braces)
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch { return null; }
      }
    }
  }
  return null;
}
