import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, type AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { logApiError } from '@/lib/logger';
import { testOpenAiCompatEndpoint } from '@/lib/ai/connection-test';
import { safeOutboundFetch, SsrfGuardError, SafeOutboundTimeoutError, SafeOutboundSizeError } from '@/lib/safe-outbound';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
// v2.58.7 (stage 3) — injection-pattern detection + security audit log.
import { logPromptInjectionSuspicion } from '@/lib/ai/prompt-injection';

// ════════════════════════════════════════════════════════
//  AI Bridge API — سامانه مدیریت جامع فروش (هلدینگ بهبود گستر)
//  Actions: settings, chat, history, clear-history,
//           prompts, save-prompt, delete-prompt
//
//  v2.58.4 (user issue 2): the GLOBAL prompt templates (prompts /
//   save-prompt / delete-prompt) are a shared asset every user chats
//   through — their list/create/update/delete is now gated on the
//   DEDICATED `ai_prompt_manage` permission (admin-only by default),
//   with hard length caps so a client cannot park megabytes in the
//   Meta row. Role checks route through getCanonicalRole (issue 4).
//
//  v2.15.0 (sixth-round audit):
//   - settings (get/set) is ADMIN-ONLY: the api_url defines where the
//     server sends the stored API key, so letting a regular user change
//     it was a credential-exfiltration vector (critical). The URL is also
//     validated to be a well-formed http(s) endpoint.
//  v2.28.1 (Round 23 — Iran provider readiness):
//   - new action `test`: one-click connectivity probe for the configured
//     OpenAI-compatible endpoint (10s timeout). Sanctioned services
//     (Claude/OpenAI/Gemini) hang or get refused from Iranian servers,
//     so admins must be able to verify reachability BEFORE a real chat
//     or call analysis fails. Non-secret fields (api_url/model) may be
//     overridden per-request so the admin can test BEFORE saving; the
//     API key always comes from the DB and never from the client.
//   - conversation history is scoped per user: the shared
//     `ai_bridge.conversation_default` key leaked every user's chat to
//     everyone. Keys are now `ai_bridge.conversation_<userId>_<sessionId>`.
// ════════════════════════════════════════════════════════

const AI_SETTING_KEYS = [
  'ai_bridge.api_url',
  'ai_bridge.api_key',
  'ai_bridge.model',
  'ai_bridge.system_prompt',
  'ai_bridge.max_tokens',
  'ai_bridge.temperature',
  // v2.34.7 — Whisper-compatible speech-to-text endpoint (voice notes).
  // stt_url is the FULL /audio/transcriptions URL; auth reuses api_key.
  'ai_bridge.stt_url',
  'ai_bridge.stt_model',
] as const;

type AiSettings = {
  api_url: string;
  api_key: string;
  model: string;
  system_prompt: string;
  max_tokens: string;
  temperature: string;
  stt_url: string;
  stt_model: string;
};

// v2.58.4 (issue 2) — prompt template shape limits + the shared denial.
const PROMPT_TITLE_MAX_CHARS = 200;
const PROMPT_CONTENT_MAX_CHARS = 20_000;
// v2.58.7 (stage 3) — the admin-set system prompt rides the SAME cap as
// prompt templates (it was unbounded: a client could park megabytes in
// the Meta row and blow up every chat request); chat messages get their
// own tighter cap; api_key lengths are bounded to a sane ceiling.
const SYSTEM_PROMPT_MAX_CHARS = 20_000;
const CHAT_MESSAGE_MAX_CHARS = 8_000;
const API_KEY_MAX_CHARS = 512;

function chatDenied(): NextResponse {
  return NextResponse.json(
    { error: 'گفتگو با دستیار هوشمند نیازمند مجوز دسترسی هوش مصنوعی است.' },
    { status: 403 },
  );
}

function promptDenied(): NextResponse {
  return NextResponse.json(
    { error: 'مدیریت الگوهای سراسری پرامپت فقط برای مدیر سیستم یا دارندگان مجوز «مدیریت پرامپت» مجاز است.' },
    { status: 403 },
  );
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ── Auth Helper ─────────────────────────────────────────
// Uses the central session validator so the 12h sliding expiry applies.
async function authenticate(): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) {
    return { error: NextResponse.json({ error: 'احراز هویت نشده' }, { status: 401 }) };
  }
  return { user };
}

// ── Settings Helpers ────────────────────────────────────

/** v2.15.0: conversation keys are scoped to the requesting user so no two
 *  users can read or write each other's history (previously the default
 *  session key was shared tenant-wide). The session id is also sanitized —
 *  it becomes part of a Meta key, so only a conservative charset is kept. */
function scopedConversationKey(userId: string, rawSessionId: string | undefined): { key: string; sessionId: string } {
  const sid = rawSessionId && /^[A-Za-z0-9_-]{1,64}$/.test(rawSessionId) ? rawSessionId : 'default';
  return { key: `ai_bridge.conversation_${userId}_${sid}`, sessionId: sid };
}

function settingKeyToField(key: string): string | null {
  const prefix = 'ai_bridge.';
  if (!key.startsWith(prefix)) return null;
  return key.slice(prefix.length); // e.g. api_url, api_key, model, ...
}

function fieldToSettingKey(field: string): string {
  return `ai_bridge.${field}`;
}

async function getAiSettings(): Promise<AiSettings> {
  const metas = await db.meta.findMany({
    where: { key: { in: [...AI_SETTING_KEYS] } },
  });

  const settings: Record<string, string> = {
    api_url: '',
    api_key: '',
    model: '',
    system_prompt: '',
    max_tokens: '2048',
    temperature: '0.7',
    stt_url: '',
    stt_model: 'whisper-1',
  };

  for (const m of metas) {
    const field = settingKeyToField(m.key);
    if (field) settings[field] = m.value;
  }

  return settings as AiSettings;
}

// ── Main Handler ────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticate();
    if ('error' in auth) return auth.error;

    const body = await req.json();
    const { action } = body;

    switch (action) {
      case 'settings':
        return await handleSettings(body, auth.user);
      case 'test':
        return await handleTestConnection(body, auth.user);
      case 'chat':
        return await handleChat(body, auth.user);
      case 'history':
        return await handleHistory(body, auth.user);
      case 'clear-history':
        return await handleClearHistory(body, auth.user);
      case 'prompts':
        return await handlePrompts(auth.user);
      case 'save-prompt':
        return await handleSavePrompt(body, auth.user);
      case 'delete-prompt':
        return await handleDeletePrompt(body, auth.user);
      default:
        return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
    }
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('ai-bridge', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  SETTINGS — GET / SET
// ════════════════════════════════════════════════════════
async function handleSettings(body: Record<string, unknown>, user: AuthUser) {
  // v2.15.0 (audit #6, critical): the service URL decides where the stored
  // API key is sent — only the system administrator may view or change the
  // connection settings. v2.58.4 (issue 4): canonical role check.
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json(
      { error: 'فقط مدیر سیستم می‌تواند تنظیمات اتصال هوش مصنوعی را مشاهده یا تغییر دهد.' },
      { status: 403 },
    );
  }

  const { mode } = body as { mode?: string };

  // GET current settings
  if (mode === 'get' || !mode) {
    const settings = await getAiSettings();
    // Mask the API key for display
    const masked: Record<string, string> = { ...settings };
    if (masked.api_key) {
      const len = masked.api_key.length;
      masked.api_key = len <= 8
        ? '********'
        : masked.api_key.slice(0, 4) + '****' + masked.api_key.slice(-4);
    }
    return NextResponse.json({ settings: masked });
  }

  // SET settings
  if (mode === 'set') {
    const { api_url, api_key, model, system_prompt, max_tokens, temperature, stt_url, stt_model } = body as {
      api_url?: string;
      api_key?: string;
      model?: string;
      system_prompt?: string;
      max_tokens?: string | number;
      temperature?: string | number;
      stt_url?: string;
      stt_model?: string;
    };

    const updates: Array<{ key: string; value: string }> = [];

    if (api_url !== undefined) {
      // v2.15.0: reject malformed addresses up front — the server will send
      // the stored API key to this destination on every chat request.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(String(api_url));
      } catch {
        return NextResponse.json(
          { error: 'آدرس سرویس هوش مصنوعی نامعتبر است. یک URL کامل و صحیح وارد کنید.' },
          { status: 400 },
        );
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return NextResponse.json(
          { error: 'آدرس سرویس هوش مصنوعی باید با http یا https شروع شود.' },
          { status: 400 },
        );
      }
      updates.push({ key: fieldToSettingKey('api_url'), value: String(api_url) });
    }
    if (api_key !== undefined) {
      // v2.58.7 (stage 3): bounded like every other Meta-stored field.
      if (String(api_key).length > API_KEY_MAX_CHARS) {
        return NextResponse.json(
          { error: `کلید API حداکثر ${API_KEY_MAX_CHARS} نویسه می‌تواند باشد.` },
          { status: 400 },
        );
      }
      updates.push({ key: fieldToSettingKey('api_key'), value: String(api_key) });
    }
    if (model !== undefined) updates.push({ key: fieldToSettingKey('model'), value: String(model).slice(0, 200) });
    if (system_prompt !== undefined) {
      // v2.58.7 (stage 3): the system prompt rides the SAME cap as prompt
      // templates (previously unbounded) — and gets the injection-pattern
      // audit log like every other prompt surface.
      if (String(system_prompt).length > SYSTEM_PROMPT_MAX_CHARS) {
        return NextResponse.json(
          { error: `پرامپت سیستم حداکثر ${SYSTEM_PROMPT_MAX_CHARS.toLocaleString('fa-IR')} نویسه می‌تواند باشد.` },
          { status: 400 },
        );
      }
      await logPromptInjectionSuspicion({
        scope: 'ai-bridge:settings(system_prompt)',
        userId: user.id,
        username: user.username,
        text: String(system_prompt),
      });
      updates.push({ key: fieldToSettingKey('system_prompt'), value: String(system_prompt) });
    }
    if (max_tokens !== undefined) updates.push({ key: fieldToSettingKey('max_tokens'), value: String(max_tokens) });
    if (temperature !== undefined) updates.push({ key: fieldToSettingKey('temperature'), value: String(temperature) });
    // v2.34.7 — STT endpoint (same URL hygiene as api_url: the stored API
    // key is sent there on every transcription request).
    if (stt_url !== undefined) {
      const u = String(stt_url).trim();
      if (u) {
        let parsedSttUrl: URL;
        try {
          parsedSttUrl = new URL(u);
        } catch {
          return NextResponse.json(
            { error: 'آدرس سرویس تبدیل صدا به متن نامعتبر است. یک URL کامل و صحیح وارد کنید.' },
            { status: 400 },
          );
        }
        if (parsedSttUrl.protocol !== 'http:' && parsedSttUrl.protocol !== 'https:') {
          return NextResponse.json(
            { error: 'آدرس سرویس تبدیل صدا به متن باید با http یا https شروع شود.' },
            { status: 400 },
          );
        }
      }
      updates.push({ key: fieldToSettingKey('stt_url'), value: u });
    }
    if (stt_model !== undefined) updates.push({ key: fieldToSettingKey('stt_model'), value: String(stt_model).slice(0, 100) });

    for (const u of updates) {
      await db.meta.upsert({
        where: { key: u.key },
        update: { value: u.value },
        create: { key: u.key, value: u.value },
      });
    }

    return NextResponse.json({ message: 'تنظیمات هوش مصنوعی با موفقیت ذخیره شد.' });
  }

  return NextResponse.json({ error: 'حالت تنظیمات نامعتبر' }, { status: 400 });
}

// ════════════════════════════════════════════════════════
//  TEST CONNECTION — probe the configured endpoint (v2.28.1)
// ════════════════════════════════════════════════════════
async function handleTestConnection(body: Record<string, unknown>, user: AuthUser) {
  // Same trust boundary as settings: the probe sends the stored API key
  // to the target endpoint, so only the system administrator may run it.
  // v2.58.4 (issue 4): canonical role check.
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json(
      { error: 'فقط مدیر سیستم می‌تواند اتصال هوش مصنوعی را تست کند.' },
      { status: 403 },
    );
  }

  const { api_url, model } = body as { api_url?: string; model?: string };

  // Non-secret overrides (form values) win; otherwise the stored values.
  const settings = await getAiSettings();
  const url = typeof api_url === 'string' && api_url.trim() ? api_url.trim() : settings.api_url;
  const useModel = typeof model === 'string' && model.trim() ? model.trim() : (settings.model || 'gpt-4o-mini');

  if (!url) {
    return NextResponse.json(
      { ok: false, message: 'آدرس سرویس تنظیم نشده است — ابتدا آدرس را وارد و ذخیره کنید.' },
      { status: 200 },
    );
  }

  const result = await testOpenAiCompatEndpoint({
    url,
    apiKey: settings.api_key || undefined, // key: always from DB, never from client
    model: useModel,
  });

  // 200 even for ok:false — the probe itself succeeded; the outcome is data.
  return NextResponse.json(result, { status: 200 });
}

// ════════════════════════════════════════════════════════
//  CHAT — Send message to AI
// ════════════════════════════════════════════════════════
async function handleChat(body: Record<string, unknown>, user: AuthUser) {
  const { message, sessionId: convSessionId } = body as {
    message?: string;
    sessionId?: string;
  };

  // v2.58.7 (stage 3 — A8): chat spends the ORG-WIDE API key, but had NO
  // permission gate — finance/production roles (all ai_* = false) could
  // chat at the organization's expense; only the IP rate-limit applied.
  // The base AI read permission (ai_calls_read — held by admin and the
  // sales experts who actually use the assistant) is now required.
  const perms = getRolePermissions(user.role);
  if (!perms.ai_calls_read) {
    return chatDenied();
  }

  if (!message?.trim()) {
    return NextResponse.json({ error: 'پیام نمی‌تواند خالی باشد' }, { status: 400 });
  }
  // v2.58.7 (stage 3): a message length cap — the raw message previously
  // had NO bound: megabytes went straight into the provider request AND
  // persisted into the per-user history Meta row (20 messages of any
  // size).
  if (message.length > CHAT_MESSAGE_MAX_CHARS) {
    return NextResponse.json(
      { error: `پیام نباید از ${CHAT_MESSAGE_MAX_CHARS.toLocaleString('fa-IR')} کاراکتر بیشتر باشد.` },
      { status: 400 },
    );
  }
  // v2.58.7 (stage 3): injection-pattern LOGGING (not blocking — see
  // lib/ai/prompt-injection): the audit row stores pattern ids + a hash
  // prefix, never the raw message.
  await logPromptInjectionSuspicion({
    scope: 'ai-bridge:chat',
    userId: user.id,
    username: user.username,
    text: message,
  });

  // v2.15.0: per-user conversation key (was a shared `conversation_default`)
  const { key: convKey, sessionId: sid } = scopedConversationKey(user.id, convSessionId);

  // Read AI settings
  const settings = await getAiSettings();
  if (!settings.api_url) {
    return NextResponse.json({ error: 'تنظیمات هوش مصنوعی تکمیل نشده' }, { status: 400 });
  }

  // Load existing conversation history
  let history: ChatMessage[] = [];
  const existing = await db.meta.findUnique({ where: { key: convKey } });
  if (existing?.value) {
    try {
      history = JSON.parse(existing.value);
    } catch {
      history = [];
    }
  }

  // Build messages array for API
  const apiMessages: ChatMessage[] = [];

  // Add system prompt if configured
  if (settings.system_prompt?.trim()) {
    apiMessages.push({ role: 'system', content: settings.system_prompt });
  }

  // Add conversation history (last 20 messages for context window)
  const recentHistory = history.slice(-20);
  apiMessages.push(...recentHistory);

  // Add current user message
  apiMessages.push({ role: 'user', content: message });

  // Build request body (OpenAI-compatible format)
  const maxTokens = parseInt(settings.max_tokens, 10) || 2048;
  const temperature = parseFloat(settings.temperature) || 0.7;

  const requestBody: Record<string, unknown> = {
    model: settings.model || 'gpt-3.5-turbo',
    messages: apiMessages,
    max_tokens: maxTokens,
    temperature,
  };

  // If API key is set, include it as Bearer token
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (settings.api_key) {
    headers['Authorization'] = `Bearer ${settings.api_key}`;
  }

  // Call the AI API — v2.58.3: through the guarded outbound door
  // (SSRF validation + pinned DNS + ONE whole-operation deadline that
  // covers headers AND the full body + response size cap). The old raw
  // fetch() had no timeout at all and no destination validation.
  let aiResponse: string;
  try {
    const response = await safeOutboundFetch(
      settings.api_url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      },
      { timeoutMs: 60_000, maxResponseBytes: 5 * 1024 * 1024 },
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => 'خطای ناشناخته');
      logApiError('ai-bridge', 'API error:', response.status, errText.slice(0, 300));
      return NextResponse.json(
        { error: `خطا در ارتباط با هوش مصنوعی (${response.status})` },
        { status: 502 },
      );
    }

    const data = await response.json() as {
      choices?: { message?: { content?: string } }[];
      response?: string;
      output?: string;
    };
    // OpenAI-compatible: data.choices[0].message.content
    aiResponse = data?.choices?.[0]?.message?.content
      || data?.response
      || data?.output
      || 'پاسخی از هوش مصنوعی دریافت نشد.';
  } catch (err) {
    // SsrfGuardError/timeout/size errors carry client-safe Persian
    // messages; anything else collapses to a generic 502 (no internal
    // detail reaches the client).
    const msg = err instanceof Error ? err.message : '';
    const controlled = err instanceof SsrfGuardError
      || err instanceof SafeOutboundTimeoutError
      || err instanceof SafeOutboundSizeError;
    if (!controlled) {
      logApiError('ai-bridge', 'Fetch error:', err instanceof Error ? err.name : 'unknown');
    }
    return NextResponse.json(
      { error: controlled && msg ? msg : 'خطا در ارتباط با سرور هوش مصنوعی.' },
      { status: 502 },
    );
  }

  // Append user message and AI response to history
  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: aiResponse });

  // Keep only last 50 messages in stored history
  const trimmedHistory = history.slice(-50);

  // Save updated conversation
  await db.meta.upsert({
    where: { key: convKey },
    update: { value: JSON.stringify(trimmedHistory) },
    create: { key: convKey, value: JSON.stringify(trimmedHistory) },
  });

  return NextResponse.json({
    message: aiResponse,
    sessionId: sid,
  });
}

// ════════════════════════════════════════════════════════
//  HISTORY — Get conversation history
// ════════════════════════════════════════════════════════
async function handleHistory(body: Record<string, unknown>, user: { id: string }) {
  const { sessionId: convSessionId } = body as { sessionId?: string };
  const { key: convKey, sessionId: sid } = scopedConversationKey(user.id, convSessionId);

  const record = await db.meta.findUnique({ where: { key: convKey } });
  if (!record?.value) {
    return NextResponse.json({ history: [], sessionId: sid });
  }

  let history: ChatMessage[];
  try {
    history = JSON.parse(record.value);
  } catch {
    history = [];
  }

  return NextResponse.json({ history, sessionId: sid });
}

// ════════════════════════════════════════════════════════
//  CLEAR HISTORY — Delete conversation
// ════════════════════════════════════════════════════════
async function handleClearHistory(body: Record<string, unknown>, user: { id: string }) {
  const { sessionId: convSessionId } = body as { sessionId?: string };
  const { key: convKey, sessionId: sid } = scopedConversationKey(user.id, convSessionId);

  await db.meta.delete({ where: { key: convKey } }).catch(() => {
    // Key may not exist — ignore
  });

  return NextResponse.json({ message: 'تاریخچه گفتگو پاک شد.', sessionId: sid });
}

// ════════════════════════════════════════════════════════
//  PROMPTS — List saved prompt templates
// ════════════════════════════════════════════════════════
async function handlePrompts(user: AuthUser) {
  // v2.58.4 (issue 2): GLOBAL asset → requires the dedicated permission.
  const perms = getRolePermissions(user.role);
  if (!perms.ai_prompt_manage) {
    return promptDenied();
  }

  const metas = await db.meta.findMany({
    where: { key: { startsWith: 'ai_bridge.prompt_' } },
    orderBy: { key: 'asc' },
  });

  const prompts: Array<{ id: string; title: string; content: string; createdAt: string }> = [];

  for (const m of metas) {
    try {
      const parsed = JSON.parse(m.value) as { title?: unknown; content?: unknown };
      prompts.push({
        id: m.key,
        title: typeof parsed?.title === 'string' ? parsed.title.slice(0, PROMPT_TITLE_MAX_CHARS) : m.key,
        content: typeof parsed?.content === 'string' ? parsed.content.slice(0, PROMPT_CONTENT_MAX_CHARS) : '',
        createdAt: m.updatedAt.toISOString(),
      });
    } catch {
      prompts.push({
        id: m.key,
        title: m.key,
        // v2.58.4 (issue 6): raw row values are never echoed back — a
        // corrupted/legacy row surfaces as an empty body, not as raw text.
        content: '',
        createdAt: m.updatedAt.toISOString(),
      });
    }
  }

  return NextResponse.json({ prompts });
}

// ════════════════════════════════════════════════════════
//  SAVE PROMPT — Save a prompt template
// ════════════════════════════════════════════════════════
async function handleSavePrompt(body: Record<string, unknown>, user: AuthUser) {
  // v2.58.4 (issue 2): GLOBAL asset → requires the dedicated permission.
  const perms = getRolePermissions(user.role);
  if (!perms.ai_prompt_manage) {
    return promptDenied();
  }

  const { id, title, content } = body as {
    id?: string;
    title?: string;
    content?: string;
  };

  if (!title?.trim()) {
    return NextResponse.json({ error: 'عنوان الگو الزامی است' }, { status: 400 });
  }
  if (!content?.trim()) {
    return NextResponse.json({ error: 'محتوای الگو الزامی است' }, { status: 400 });
  }
  // v2.58.4 (issue 2) — hard caps, type + length, BEFORE any write:
  // a client must not park megabytes in the shared Meta row.
  if (typeof title !== 'string' || title.length > PROMPT_TITLE_MAX_CHARS) {
    return NextResponse.json(
      { error: `عنوان الگو حداکثر ${PROMPT_TITLE_MAX_CHARS} نویسه می‌تواند باشد.` },
      { status: 400 },
    );
  }
  if (typeof content !== 'string' || content.length > PROMPT_CONTENT_MAX_CHARS) {
    return NextResponse.json(
      { error: `محتوای الگو حداکثر ${PROMPT_CONTENT_MAX_CHARS} نویسه می‌تواند باشد.` },
      { status: 400 },
    );
  }
  // v2.58.7 (stage 3): prompt templates are the SYSTEM-side injection
  // surface (every user's chat rides them) — suspicious patterns are
  // LOGGED (audit, category security) even for holders of
  // ai_prompt_manage: a compromised admin account is exactly the vector
  // this observability is for. Log-only, never blocking.
  await logPromptInjectionSuspicion({
    scope: 'ai-bridge:save-prompt',
    userId: user.id,
    username: user.username,
    text: `${title}\n${content}`,
  });

  // Use provided ID or generate from title (slug-like)
  const promptId = id || `ai_bridge.prompt_${Date.now()}`;
  const key = promptId.startsWith('ai_bridge.prompt_') ? promptId : `ai_bridge.prompt_${promptId}`;

  const value = JSON.stringify({ title: title.trim(), content: content.trim() });

  await db.meta.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });

  return NextResponse.json({ message: 'الگو با موفقیت ذخیره شد.', id: key });
}

// ════════════════════════════════════════════════════════
//  DELETE PROMPT — Delete a prompt template
// ════════════════════════════════════════════════════════
async function handleDeletePrompt(body: Record<string, unknown>, user: AuthUser) {
  // v2.58.4 (issue 2): GLOBAL asset → requires the dedicated permission.
  const perms = getRolePermissions(user.role);
  if (!perms.ai_prompt_manage) {
    return promptDenied();
  }

  const { id } = body as { id?: string };

  if (!id) {
    return NextResponse.json({ error: 'شناسه الگو الزامی است' }, { status: 400 });
  }

  const key = id.startsWith('ai_bridge.prompt_') ? id : `ai_bridge.prompt_${id}`;

  try {
    await db.meta.delete({ where: { key } });
    return NextResponse.json({ message: 'الگو با موفقیت حذف شد.' });
  } catch {
    return NextResponse.json({ error: 'الگو یافت نشد' }, { status: 404 });
  }
}
