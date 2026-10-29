// ════════════════════════════════════════════════════════════
// OPENAI-COMPATIBLE CONNECTION TEST (v2.28.1)
//
// Round 23 («کلاد در ایران وصل نیست»): sanctioned providers
// (Claude / OpenAI / Gemini) are unreachable from Iranian servers,
// so the practical deployment path is a self-hosted or regional
// OpenAI-compatible endpoint (Ollama / vLLM / LM Studio / …).
// Admins need an honest, one-click way to verify reachability
// BEFORE a real chat or call-analysis fails in production.
//
// Pure core: fetch is injectable so every branch (timeout, 401,
// 404, network refusal) is unit-testable without a live server.
// The API key never appears in any returned error or log line.
// ════════════════════════════════════════════════════════════

import { logApiError } from '@/lib/logger';
import { safeOutboundFetch, SsrfGuardError, SafeOutboundTimeoutError } from '@/lib/safe-outbound';

export interface ConnectionTestInput {
  /** Full chat-completions URL, e.g. http://localhost:11434/v1/chat/completions */
  url: string;
  /** Optional — local servers (Ollama/vLLM) work without one. */
  apiKey?: string;
  /** Model name passed through to the endpoint. */
  model: string;
  /** Abort budget. Default 10s — sanctioned/hanging endpoints must not freeze the UI. */
  timeoutMs?: number;
  /**
   * Injectable for tests. Defaults to the SSRF-guarded safeOutboundFetch
   * (v2.58.3): the production probe now validates the destination
   * (loopback/private/metadata/link-local refused unless
   * AI_ALLOW_LOCAL_ENDPOINTS=true), pins DNS, enforces a full
   * headers+body deadline and a response size cap.
   */
  fetchImpl?: typeof fetch;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Milliseconds until the endpoint answered (round-trip). */
  latencyMs?: number;
  /** Model name echoed back by the server, when reported. */
  model?: string;
  /** Persian, actionable message for the admin. */
  message: string;
  /** HTTP status when the server answered with a non-2xx code. */
  httpStatus?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Static validation shared with the settings route. */
export function validateEndpointUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'آدرس سرویس نامعتبر است. یک URL کامل و صحیح وارد کنید (مثال: http://localhost:11434/v1/chat/completions)' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'آدرس سرویس باید با http یا https شروع شود.' };
  }
  return { ok: true, url: raw };
}

/** Human-readable diagnosis for a non-2xx answer. */
function describeHttpFailure(status: number): string {
  if (status === 401 || status === 403) {
    return 'سرویس پاسخ داد اما احراز هویت رد شد (۴۰۱/۴۰۳) — کلید API را بررسی کنید. سرویس‌های محلی مثل Ollama کلید نمی‌خواهند.';
  }
  if (status === 404) {
    return 'آدرس یافت نشد (۴۰۴) — مسیر کامل Chat Completions لازم است؛ مثال Ollama: http://localhost:11434/v1/chat/completions';
  }
  if (status === 429) {
    return 'سرویس با محدودیت نرخ پاسخ داد (۴۲۹) — چند لحظه بعد دوباره تست کنید.';
  }
  if (status >= 500) {
    return `خطای سمت سرویس (${status}) — سرویس در دسترس است ولی خودش خطا داد؛ لاگ سرویس مقصد را بررسی کنید.`;
  }
  return `سرویس با کد ${status} پاسخ داد — آدرس یا پیکربندی را بررسی کنید.`;
}

export async function testOpenAiCompatEndpoint(input: ConnectionTestInput): Promise<ConnectionTestResult> {
  const urlCheck = validateEndpointUrl(input.url);
  if (!urlCheck.ok) return { ok: false, message: urlCheck.error };

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // ── v2.58.3 — PRODUCTION path: the SSRF-guarded outbound door ──
  // (fetchImpl stays as the pure test seam for the mock-based battery;
  //  the guarded path is exercised through safeOutboundFetch's own
  //  injectable resolver+transport tests — no real network either way.)
  if (!input.fetchImpl) {
    return testViaSafeOutbound(input, urlCheck.url, timeoutMs);
  }

  // ── legacy mock path (unit-testable fetchImpl) ──
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (input.apiKey) headers['Authorization'] = `Bearer ${input.apiKey}`;

  try {
    const doFetch = input.fetchImpl ?? fetch;
    const res = await doFetch(urlCheck.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      const message = describeHttpFailure(res.status);
      logApiError('ai-connection-test', 'endpoint answered non-2xx:', res.status);
      return { ok: false, message, httpStatus: res.status, latencyMs };
    }

    // 2xx — try to surface the model the server actually used.
    let model: string | undefined;
    try {
      const data = await res.json() as { model?: string };
      if (data && typeof data.model === 'string' && data.model.trim()) model = data.model.trim();
    } catch {
      // Some servers answer 2xx with a non-JSON body — still a reachable endpoint.
    }
    return {
      ok: true,
      latencyMs,
      model: model ?? input.model,
      message: `اتصال برقرار است (${latencyMs} میلی‌ثانیه)`,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    if (aborted) {
      logApiError('ai-connection-test', 'endpoint timeout after', timeoutMs);
      return {
        ok: false,
        message: `پاسخی دریافت نشد (${Math.round(timeoutMs / 1000)} ثانیه) — سرویس از این سرور در دسترس نیست؛ اگر سرویس تحریم‌شده است (Claude/OpenAI/Gemini) از ایران قابل دسترسی نیست.`,
      };
    }
    logApiError('ai-connection-test', 'network failure:', err instanceof Error ? err.message : 'unknown');
    return {
      ok: false,
      message: 'اتصال شبکه برقرار نشد — دامنه، پورت، پروکسی یا فایروال را بررسی کنید. سرویس‌های تحریم‌شده (Claude/OpenAI/Gemini) از سرورهای ایران در دسترس نیستند.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * v2.58.3 — guarded probe via safeOutboundFetch: SSRF validation
 * (loopback / RFC1918 / metadata / link-local fail-closed unless the
 * explicit AI_ALLOW_LOCAL_ENDPOINTS local exception applies), pinned
 * DNS, one whole-operation deadline (headers + body) and a response
 * size cap. Same result contract as the mock path.
 */
async function testViaSafeOutbound(
  input: ConnectionTestInput,
  url: string,
  timeoutMs: number,
): Promise<ConnectionTestResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (input.apiKey) headers['Authorization'] = `Bearer ${input.apiKey}`;
  const startedAt = Date.now();

  try {
    const res = await safeOutboundFetch(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          temperature: 0,
        }),
      },
      { timeoutMs, maxResponseBytes: 64 * 1024 },
    );
    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      const message = describeHttpFailure(res.status);
      logApiError('ai-connection-test', 'endpoint answered non-2xx:', res.status);
      return { ok: false, message, httpStatus: res.status, latencyMs };
    }
    let model: string | undefined;
    try {
      const data = await res.json() as { model?: string };
      if (data && typeof data.model === 'string' && data.model.trim()) model = data.model.trim();
    } catch {
      // non-JSON 2xx body — still a reachable endpoint
    }
    return { ok: true, latencyMs, model: model ?? input.model, message: `اتصال برقرار است (${latencyMs} میلی‌ثانیه)` };
  } catch (e: unknown) {
    if (e instanceof SsrfGuardError) {
      // honest, actionable diagnosis for the admin (key never included)
      return { ok: false, message: e.message };
    }
    if (e instanceof SafeOutboundTimeoutError) {
      logApiError('ai-connection-test', 'endpoint timeout after', timeoutMs);
      return {
        ok: false,
        message: `پاسخی دریافت نشد (${Math.round(timeoutMs / 1000)} ثانیه) — سرویس از این سرور در دسترس نیست؛ اگر سرویس تحریم‌شده است (Claude/OpenAI/Gemini) از ایران قابل دسترسی نیست.`,
      };
    }
    logApiError('ai-connection-test', 'network failure:', e instanceof Error ? e.message : 'unknown');
    return {
      ok: false,
      message: 'اتصال شبکه برقرار نشد — دامنه، پورت، پروکسی یا فایروال را بررسی کنید. سرویس‌های تحریم‌شده (Claude/OpenAI/Gemini) از سرورهای ایران در دسترسی نیستند.',
    };
  }
}
