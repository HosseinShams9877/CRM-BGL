import crypto from 'crypto';

// ════════════════════════════════════════════════════════════
// TELEPHONY PROVIDER CORE (v2.28.0)
//
// Pure, DB-free building blocks for the call-center webhook:
//   normalizePhone      — Iranian phone normalization (fa/ar digits,
//                         +98/0098/98/0 prefixes → national digits)
//   verifyHmac          — timing-safe HMAC-SHA256 webhook signature
//   parseTelephonyEvent — strict webhook payload validation
//   parseExtMap         — PBX extension → CRM username map parsing
//
// The DB-dependent half (matching, storage, pipeline kick) lives in
// ../telephony-ingest.ts; route wiring lives in
// app/api/ai-sales/telephony/webhook/route.ts. Contract documented in
// AI_CALL_CENTER_INTEGRATION.md — the PBX never authenticates with a
// session: the HMAC signature over the raw request body IS the auth.
// ════════════════════════════════════════════════════════════

/** PBX audio must land in one of the formats the STT layer accepts. */
export const TELEPHONY_AUDIO_EXTENSIONS = new Set([
  'wav', 'mp3', 'm4a', 'ogg', 'oga', 'aac', 'flac', 'opus', 'webm', 'mp4', 'wma', 'amr',
]) as ReadonlySet<string>;

/** Sanity ceiling for a single webhook body BEFORE base64 decode. */
export function maxWebhookBodyBytes(maxAudioMb: number): number {
  // base64 inflates ~4/3; +64KB for JSON fields/metadata slack.
  return Math.round(maxAudioMb * 1024 * 1024 * 1.4) + 65_536;
}

// ── Phone normalization ─────────────────────────────────────

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** fa/ar digit → ASCII, everything else untouched. */
export function toAsciiDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) { out += String(p); continue; }
    const a = ARABIC_DIGITS.indexOf(ch);
    if (a >= 0) { out += String(a); continue; }
    out += ch;
  }
  return out;
}

/**
 * Normalize an Iranian phone number to its national significant digits:
 *   '۰۹۱۲ ۱۲۳ ۴۵۶۷' → '9121234567'
 *   '+98-21-8888 7777' → '2188887777'
 *   '00989121234567'   → '9121234567'
 *   '02188776655'      → '2188776655'
 * Returns null when the cleaned string is not a plausible number
 * (too short, or non-digit residue).
 */
export function normalizePhone(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = toAsciiDigits(raw).trim();
  // strip separators commonly pasted from PBX CDRs
  s = s.replace(/[\s\-().]/g, '');
  if (!s) return null;
  // country-code prefixes (order matters: longest first)
  if (s.startsWith('+98')) s = s.slice(3);
  else if (s.startsWith('0098')) s = s.slice(4);
  else if (s.startsWith('98') && s.length > 10) s = s.slice(2);
  // trunk zero
  if (s.startsWith('0')) s = s.slice(1);
  if (!/^\d{6,15}$/.test(s)) return null;
  return s;
}

// ── HMAC signature (webhook auth) ───────────────────────────

/**
 * Timing-safe HMAC-SHA256 verification over the raw request body.
 * Accepts `sha256=<hex>` (GitHub/standard style) or bare `<hex>`,
 * case-insensitive. Returns false on any malformation — never throws.
 */
export function verifyHmac(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  let provided = signatureHeader.trim();
  if (provided.startsWith('sha256=')) provided = provided.slice(7).trim();
  provided = provided.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Webhook payload contract ────────────────────────────────

export interface TelephonyEvent {
  provider: string;        // 'asterisk' | '3cx' | 'simotel' | …
  externalId: string;      // call id inside the PBX (idempotency key)
  direction: 'inbound' | 'outbound';
  agentExt: string;        // '' when unknown
  callerNumber: string;    // raw, as sent
  normalizedNumber: string;    // guaranteed non-null: parse rejects unmatched numbers
  startedAt: Date;
  durationSec: number;     // clamped 0..4h
  companySlug: string;     // '' = use default routing
  consent: 'granted' | 'denied' | 'not-required' | 'unknown';
  audioBase64: string;
  audioBytes: number;      // decoded length
  mimeType: string;        // best-effort, validated prefix
  fileName: string;        // safe stored-side name hint
  title: string;           // ≤200 chars, may be ''
}

export type TelephonyParseResult =
  | { ok: true; event: TelephonyEvent }
  | { ok: false; error: string };

const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const EXTERNAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const AUDIO_MIME_PREFIXES = ['audio/', 'video/webm', 'application/octet-stream'];
const ALLOWED_CONSENT = new Set(['granted', 'denied', 'not-required', 'unknown']);

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function parseStartedAt(v: unknown): Date {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    // epoch seconds vs milliseconds — heuristics below 10^12 = seconds
    return new Date(v < 1e12 ? v * 1000 : v);
  }
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime()) && Math.abs(Date.now() - d.getTime()) < 10 * 365.25 * 24 * 3600 * 1000) {
      return d;
    }
  }
  return new Date();
}

/** Infer extension from an explicit hint, mime type, or default to wav. */
function inferExtension(fileName: string, mimeType: string): string {
  const fromName = (fileName.split('.').pop() || '').toLowerCase();
  if (fromName && TELEPHONY_AUDIO_EXTENSIONS.has(fromName)) return fromName;
  if (mimeType === 'audio/mpeg') return 'mp3';
  if (mimeType === 'audio/mp4' || mimeType === 'audio/x-m4a') return 'm4a';
  if (mimeType === 'audio/ogg' || mimeType === 'application/ogg') return 'ogg';
  if (mimeType === 'video/webm') return 'webm';
  if (mimeType === 'audio/flac') return 'flac';
  if (mimeType === 'audio/aac') return 'aac';
  if (mimeType === 'audio/amr' || mimeType === 'audio/amr-wb') return 'amr';
  return 'wav'; // PBX CDR default (Asterisk/3CX record wav 8k mono)
}

/**
 * Strict validation of the webhook JSON body. Every reject reason is a
 * human-readable Persian string so the PBX admin can act on it.
 */
export function parseTelephonyEvent(
  payload: unknown,
  maxAudioMb: number,
): TelephonyParseResult {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, error: 'بدنهٔ درخواست باید یک شیء JSON باشد.' };
  }
  const p = payload as Record<string, unknown>;

  const provider = String(p.provider || '').trim().toLowerCase();
  if (!PROVIDER_RE.test(provider)) {
    return { ok: false, error: 'شناسهٔ provider نامعتبر است (۲ تا ۴۰ کاراکتر لاتین/عدد).' };
  }
  const externalId = String(p.externalId ?? p.callId ?? '').trim();
  if (!EXTERNAL_ID_RE.test(externalId)) {
    return { ok: false, error: 'externalId (شناسهٔ تماس در PBX) الزامی است (تا ۱۰۰ کاراکتر).' };
  }
  const callerNumberRaw = String(p.callerNumber ?? p.from ?? '').trim();
  if (!callerNumberRaw || callerNumberRaw.length > 30) {
    return { ok: false, error: 'callerNumber (شمارهٔ تماس‌گیرنده) الزامی است.' };
  }
  const normalizedNumber = normalizePhone(callerNumberRaw);
  if (!normalizedNumber) {
    return { ok: false, error: `شمارهٔ تماس‌گیرنده قابل پردازش نیست: «${callerNumberRaw.slice(0, 30)}»` };
  }

  const direction = p.direction === 'inbound' ? 'inbound' : 'outbound';
  const agentExt = toAsciiDigits(String(p.agentExt ?? p.extension ?? '')).replace(/[^\d*#]/g, '').slice(0, 20);

  const audioBase64Raw = typeof p.audioBase64 === 'string' ? p.audioBase64.replace(/\s+/g, '') : '';
  if (!audioBase64Raw) {
    return { ok: false, error: 'audioBase64 (فایل صوتی base64) الزامی است.' };
  }
  const audioBytes = Math.floor(audioBase64Raw.length * 3 / 4);
  const maxBytes = maxAudioMb * 1024 * 1024;
  if (audioBytes < 512) {
    return { ok: false, error: 'فایل صوتی خیلی کوچک یا خالی است.' };
  }
  if (audioBytes > maxBytes) {
    return { ok: false, error: `حجم فایل صوتی بیش از حد مجاز است (حداکثر ${maxAudioMb} مگابایت).` };
  }
  if (!BASE64_RE.test(audioBase64Raw) || audioBase64Raw.length % 4 !== 0) {
    return { ok: false, error: 'audioBase64 معتبر نیست (base64 استاندارد بدون سطر جدید).' };
  }

  const mimeTypeRaw = String(p.mimeType || '').trim().toLowerCase().slice(0, 100);
  if (mimeTypeRaw && !AUDIO_MIME_PREFIXES.some((prefix) => mimeTypeRaw.startsWith(prefix))) {
    return { ok: false, error: `نوع فایل (${mimeTypeRaw}) صوتی نیست.` };
  }
  const fileNameRaw = String(p.fileName || '').slice(0, 255);
  const ext = inferExtension(fileNameRaw, mimeTypeRaw);

  const consentRaw = String(p.consent || 'unknown');
  const consent = (ALLOWED_CONSENT.has(consentRaw) ? consentRaw : 'unknown') as TelephonyEvent['consent'];

  const event: TelephonyEvent = {
    provider,
    externalId,
    direction,
    agentExt,
    callerNumber: callerNumberRaw,
    normalizedNumber,
    startedAt: parseStartedAt(p.startedAt),
    durationSec: clampInt(p.durationSec, 0, 4 * 3600, 0),
    companySlug: String(p.companySlug || '').trim().slice(0, 60),
    consent,
    audioBase64: audioBase64Raw,
    audioBytes,
    mimeType: mimeTypeRaw || `audio/${ext === 'mp3' ? 'mpeg' : ext}`,
    fileName: `pbx-${provider}-${externalId}.${ext}`,
    title: String(p.title || '').trim().slice(0, 200),
  };
  return { ok: true, event };
}

// ── Extension → user mapping ────────────────────────────────

/**
 * Parse the admin-configured map of PBX extension → CRM username.
 * Accepts either a JSON object or plain lines `101=username`
 * (comments with # allowed). Returns the cleaned map — invalid lines
 * are dropped silently to keep the webhook path simple; the settings
 * API validates with a stricter parser and reports problems there.
 */
export function parseExtMap(raw: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'string') return out;
  const trimmed = raw.trim();
  if (!trimmed) return out;
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        const ext = toAsciiDigits(k).replace(/[^\d*#]/g, '');
        const user = String(v || '').trim();
        if (ext && user && user.length <= 60) out[ext] = user;
      }
    } catch { /* fall through — empty map */ }
    return out;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.split('#')[0].trim();
    if (!l) continue;
    const eq = l.indexOf('=');
    if (eq < 1) continue;
    const ext = toAsciiDigits(l.slice(0, eq)).replace(/[^\d*#]/g, '');
    const user = l.slice(eq + 1).trim();
    if (ext && user && user.length <= 60) out[ext] = user;
  }
  return out;
}

/** Strict variant used by the settings API — returns errors, not drops. */
export function validateExtMap(raw: string): { ok: true; map: Record<string, string> } | { ok: false; error: string } {
  const map = parseExtMap(raw);
  if (raw.trim() && Object.keys(map).length === 0) {
    return { ok: false, error: 'قالب نقشهٔ داخلی‌ها نامعتبر است. هر سطر باید به شکل «101=نام‌کاربری» یا JSON معتبر باشد.' };
  }
  return { ok: true, map };
}
