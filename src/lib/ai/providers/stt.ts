// ════════════════════════════════════════════════════════════
// SPEECH-TO-TEXT PROVIDER ABSTRACTION (v2.27.0)
//
// Vendor lock-in is forbidden: every transcription call site talks to this
// interface only. Implementations:
//   • zai           — z-ai-web-dev-sdk ASR (default, zero-config). Handles
//                     Chinese & English well. NOTE (measured, v2.34.7):
//                     Persian speech comes back as phonetic English garbage,
//                     so it is NOT suitable for the Persian sales team.
//   • openai_compat — any Whisper-compatible /audio/transcriptions endpoint
//                     configured through ai_bridge.stt_url / stt_model /
//                     api_key (admin panel). This is the recommended
//                     provider for Persian voice notes (v2.34.7).
//   • none          — STT disabled (manual transcripts only)
// Adding a provider = implementing STTProvider + registering it below.
// ════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ApiError } from '@/lib/api-error';
import { logApiError } from '@/lib/logger';
import { safeOutboundFetch, serializeFormData } from '@/lib/safe-outbound';

export interface SttResult {
  text: string;
  provider: string;
  /** 0-1 — overall recognition confidence if the provider reports one. */
  confidence: number;
}

export interface STTProvider {
  readonly id: string;
  /** Transcribe raw audio bytes. Throws on failure. */
  transcribe(audio: Buffer, mimeType: string, language: string): Promise<SttResult>;
}

// ── Provider: z-ai-web-dev-sdk ASR ─────────────────────────
class ZaiSttProvider implements STTProvider {
  readonly id = 'zai';

  async transcribe(audio: Buffer, _mimeType: string, _language: string): Promise<SttResult> {
    const { default: ZAI } = await import('z-ai-web-dev-sdk');
    const zai = await ZAI.create();
    const response = await zai.audio.asr.create({
      file_base64: audio.toString('base64'),
    });
    const text = (response as { text?: string }).text || '';
    if (!text.trim()) {
      throw new ApiError(502, 'تبدیل صدا به متن نتیجه‌ای نداشت (فایل صوتی خالی یا بی‌کلام است)');
    }
    return { text: text.trim(), provider: 'zai', confidence: 0.85 };
  }
}

// ── Provider: OpenAI-compatible /audio/transcriptions ──────
// Uses the admin-configured ai_bridge.* settings. The URL is the FULL
// endpoint (e.g. https://provider.example.com/v1/audio/transcriptions),
// matching how ai_bridge.api_url already stores the full chat URL — no
// guessing, no path derivation, works with any compatible gateway.
interface SttEndpointConfig {
  url: string;
  apiKey: string;
  model: string;
}

async function getSttEndpointConfig(): Promise<SttEndpointConfig> {
  const metas = await db.meta.findMany({
    where: { key: { in: ['ai_bridge.stt_url', 'ai_bridge.api_key', 'ai_bridge.stt_model'] } },
  });
  const map: Record<string, string> = {};
  for (const m of metas) map[m.key] = m.value;
  return {
    url: map['ai_bridge.stt_url'] || '',
    apiKey: map['ai_bridge.api_key'] || '',
    model: map['ai_bridge.stt_model'] || 'whisper-1',
  };
}

class OpenAiCompatSttProvider implements STTProvider {
  readonly id = 'openai_compat';

  async transcribe(audio: Buffer, mimeType: string, language: string): Promise<SttResult> {
    const cfg = await getSttEndpointConfig();
    if (!cfg.url) {
      throw new ApiError(400, 'آدرس سرویس تبدیل صدا به متن (ai_bridge.stt_url) تنظیم نشده است — از پنل مدیریت کامل کنید');
    }
    // Endpoint shape is validated like every other admin-entered URL.
    let parsed: URL;
    try {
      parsed = new URL(cfg.url);
    } catch {
      throw new ApiError(400, 'آدرس سرویس تبدیل صدا به متن معتبر نیست (http/https کامل وارد کنید)');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError(400, 'آدرس سرویس تبدیل صدا به متن باید با http یا https شروع شود');
    }

    // Standard OpenAI multipart contract: file + model (+ language).
    const form = new FormData();
    const ext = (mimeType || '').includes('wav') ? 'wav'
      : (mimeType || '').includes('mpeg') || (mimeType || '').includes('mp3') ? 'mp3'
        : (mimeType || '').includes('mp4') || (mimeType || '').includes('m4a') ? 'm4a'
          : 'webm';
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType || 'audio/webm' }), `voice.${ext}`);
    form.append('model', cfg.model);
    if (language) form.append('language', language);

    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

    // v2.58.3 — guarded outbound door (SSRF + pinned DNS + whole-operation
    // deadline + size cap). The multipart body is pre-serialized so the
    // transport stays a plain bytes pipe; STT gets a longer budget because
    // long recordings legitimately take minutes on self-hosted Whisper.
    const { data: formBytes, contentType } = await serializeFormData(form);
    headers['Content-Type'] = contentType;

    const res = await safeOutboundFetch(
      cfg.url,
      { method: 'POST', headers, body: formBytes },
      { timeoutMs: 120_000, maxResponseBytes: 2 * 1024 * 1024 },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logApiError('stt-openai_compat', 'transcription error:', res.status, errText.slice(0, 300));
      throw new Error(`خطا در سرویس تبدیل صدا به متن خارجی (${res.status})`);
    }
    const payload = await res.json().catch(() => null) as { text?: string } | null;
    const text = payload?.text || '';
    if (!text.trim()) {
      throw new ApiError(502, 'سرویس تبدیل صدا به متن خارجی متن خالی برگرداند');
    }
    return { text: text.trim(), provider: 'openai_compat', confidence: 0.9 };
  }
}

// ── Provider: none (STT disabled — manual transcript mode) ──
class NoneSttProvider implements STTProvider {
  readonly id = 'none';
  async transcribe(): Promise<SttResult> {
    throw new ApiError(400, 'سرویس تبدیل صدا به متن غیرفعال است — متن مکالمه را دستی وارد کنید');
  }
}

// ── Registry ────────────────────────────────────────────────
const ZAI_STT = new ZaiSttProvider();
const OPENAI_COMPAT_STT = new OpenAiCompatSttProvider();
const NONE_STT = new NoneSttProvider();

export function getSTTProvider(id: string): STTProvider {
  if (id === 'none') return NONE_STT;
  if (id === 'openai_compat') return OPENAI_COMPAT_STT;
  return ZAI_STT;
}
