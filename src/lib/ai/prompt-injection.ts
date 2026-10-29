// ════════════════════════════════════════════════════════════
// PROMPT INJECTION DETECTION (v2.58.7 — production-hardening,
// stage 3: "Injection Patternها Log شوند").
//
// THE CONTRACT:
//   • detectPromptInjectionPatterns(text) — pure predicate: returns the
//     ids of the patterns that fired (EN + FA phrasings, role-spoof
//     markup, jailbreak keywords, secret-exfil asks).
//   • logPromptInjectionSuspicion() — writes ONE audit event
//     (category 'security') WITHOUT storing the raw user text: only the
//     pattern ids, the text LENGTH and a SHA-256 prefix. Correlatable,
//     not exfiltrating — the same no-leak discipline the rest of the
//     audit log follows.
//
// POLICY: detection is LOG-ONLY by design. Blocking on heuristics would
// both false-positive legitimate Persian business chat and give the
// attacker an oracle to iterate against. The SYSTEM prompts already
// fence transcripts and forbid CRM writes from inside analysis
// (src/lib/ai/prompts.ts INJECTION_GUARD) — this module adds the
// observability layer so an admin can see probing attempts.
// ════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import { db } from '@/lib/db';

export interface InjectionPattern {
  id: string;
  label: string;
  regex: RegExp;
}

const PATTERNS: InjectionPattern[] = [
  {
    id: 'ignore_previous',
    label: 'تلاش برای نادیده‌گرفتن دستورات سیستمی',
    regex: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instruction|prompt|rule|direction|message)/i,
  },
  {
    id: 'ignore_previous_fa',
    label: 'تلاش برای نادیده‌گرفتن دستورات سیستمی (فارسی)',
    regex: /(نادیده\s?(گرفتن|بگیر)|دستورات?\s?(قبلی|بالایی|اولیه)\s?(را\s?(نادیده|فراموش)|فراموش\s?کن)|فراموش\s?کن\s?.{0,20}(گفته|دستور))/i,
  },
  {
    id: 'system_prompt_reveal',
    label: 'تلاش برای افشای پرامپت سیستمی',
    regex: /\b(reveal|show|print|repeat|display|output|leak|expose|دنیا بیار|نمایش بده|چاپ کن)\b[^.\n]{0,30}\b(system\s?prompt|your\s+(initial\s+)?(instructions|prompt|configuration)|initial\s+prompt)/i,
  },
  {
    id: 'role_override',
    label: 'تلاش برای تغییر نقش مدل',
    regex: /\b(you\s+are\s+now|act\s+as\s+(if|a|an|an?))\b/i,
  },
  {
    id: 'role_override_markup',
    label: 'تزریق مارک‌آپ نقش سیستمی',
    regex: /(<\|im_start\|>|\[INST\]|<\/?system>|###\s*system\b|^SYSTEM:)/im,
  },
  {
    id: 'jailbreak',
    label: 'کلیدواژهٔ jailbreak',
    regex: /\b(jailbreak|DAN\s+mode|developer\s+mode|do\s+anything\s+now)\b/i,
  },
  {
    id: 'secret_exfil',
    label: 'تلاش برای استخراج کلید/راز',
    regex: /\b(api[ _-]?key|secret\s+key|credential|رمز\s+کلاینت|کلید\s?(راز|سری))\b[^.\n]{0,30}\b(printf|print|show|reveal|display|output|بده|نمایش)\b/i,
  },
  {
    id: 'guard_disable',
    label: 'تلاش برای غیرفعال‌کردن محدودیت‌ها',
    regex: /\b(you\s+(have\s+)?no\s+(restrictions|limitations|filters)|unfiltered\s+mode|no\s+content\s+policy)\b/i,
  },
];

/** Pure predicate — which injection patterns fire on this text. */
export function detectPromptInjectionPatterns(text: string): InjectionPattern[] {
  if (!text || typeof text !== 'string' || text.length < 8) return [];
  return PATTERNS.filter((p) => p.regex.test(text));
}

export interface InjectionAuditInput {
  /** Route scope tag, e.g. 'ai-bridge:chat'. */
  scope: string;
  userId: string;
  username: string;
  text: string;
}

/**
 * Record a suspicion event (best-effort, never throws into the request
 * path). Stores: scope, pattern ids, text length, sha-256 prefix —
 * NEVER the raw text (it may itself contain the payload an attacker
 * wants confirmed, and the audit log is broadly readable by admins).
 */
export async function logPromptInjectionSuspicion(input: InjectionAuditInput): Promise<void> {
  const matched = detectPromptInjectionPatterns(input.text);
  if (matched.length === 0) return;
  const hashPrefix = crypto.createHash('sha256').update(input.text, 'utf8').digest('hex').slice(0, 16);
  const details = JSON.stringify({
    scope: input.scope,
    patterns: matched.map((p) => p.id),
    textLength: input.text.length,
    textSha256Prefix: hashPrefix,
  });
  await db.auditEvent.create({
    data: {
      eventType: 'AI_PROMPT_INJECTION_SUSPECTED',
      category: 'security',
      subject: input.username.slice(0, 200),
      userId: input.userId,
      details: details.slice(0, 500),
    },
  }).catch(() => undefined);
}
