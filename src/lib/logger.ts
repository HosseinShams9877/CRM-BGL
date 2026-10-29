// ════════════════════════════════════════════════════════
// Centralized structured logger (P2-6)
// Replaces scattered console.error calls across API routes.
// Single choke-point: levels, scope tags, PII redaction,
// and a future swap to an external log sink need only touch this file.
//
// v2.58.0 (audit 85-d #6) — OPTIONAL FILE SINK: set BGL_LOG_DIR and every
// line is also appended to `<dir>/bgl-YYYY-MM-DD.log` (size-rotated at
// 5 MB, 14 files kept). The sink is append-only, failure-tolerant (a
// read-only/missing directory NEVER crashes the app — one console warn,
// then console-only), and this file stays server-only (verified: zero
// client-component importers of @/lib/logger and its dependants).
// Rationale: on the local Windows package, closing the console window
// used to destroy the evidence needed for support tickets.
// ════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MIN_LEVEL: LogLevel =
  (['debug', 'info', 'warn', 'error'] as LogLevel[]).includes(
    (process.env.BGL_LOG_LEVEL as LogLevel) || ('' as LogLevel),
  )
    ? (process.env.BGL_LOG_LEVEL as LogLevel)
    : process.env.NODE_ENV === 'production'
      ? 'info'
      : 'debug';

/** Sensitive keys whose values must never reach the log stream. */
const REDACT_KEY_RE =
  /(password|passwd|secret|token|authorization|cookie|sessionid|session_id|apikey|api_key)/i;

/** Inline "key=value" or JSON-fragment leaks inside free-text messages. */
const REDACT_INLINE_RE =
  /("(?:password|secret|token|authorization|cookie|apiKey|session_id)"\s*[:=]\s*)"[^"]*"/gi;

function redactText(text: string): string {
  return text.replace(REDACT_INLINE_RE, '$1"[REDACTED]"');
}

function redactMeta(meta: unknown[]): unknown[] {
  return meta.map((m) => {
    if (typeof m === 'string') return redactText(m);
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
        out[k] = REDACT_KEY_RE.test(k) ? '[REDACTED]' : v;
      }
      return out;
    }
    return m;
  });
}

// ── v2.58.0 file sink (append-only, rotated, failure-tolerant) ──
const LOG_DIR = process.env.BGL_LOG_DIR ? path.resolve(process.env.BGL_LOG_DIR) : null;
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate a day-file past 5 MB
const LOG_MAX_FILES = 14; // keep at most 14 day-files per directory sweep
let fileSinkFailed = false;

function logFilePath(dayIso: string): string {
  return path.join(LOG_DIR as string, `bgl-${dayIso}.log`);
}

function appendToFileSink(line: string, extra: unknown[]): void {
  if (!LOG_DIR || fileSinkFailed) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const dayIso = new Date().toISOString().slice(0, 10);
    const file = logFilePath(dayIso);
    try {
      const st = fs.statSync(file);
      if (st.size > LOG_MAX_BYTES) {
        // same-day overflow → suffix rotation (bgl-…-2.log, -3.log …)
        let n = 2;
        while (fs.existsSync(logFilePath(`${dayIso}-${n}`))) n += 1;
        fs.renameSync(file, logFilePath(`${dayIso}-${n}`));
        sweepOldFiles();
      }
    } catch { /* stat on a not-yet-created file — fine */ }
    const extraStr = extra.length > 0 ? ` ${extra.map((e) => (typeof e === 'string' ? e : safeJson(e))).join(' ')}` : '';
    fs.appendFileSync(file, `${line}${extraStr}\n`);
  } catch {
    // Never let logging take the app down: warn once, then console-only.
    fileSinkFailed = true;
    console.warn(`[logger] file sink disabled (BGL_LOG_DIR not writable): ${LOG_DIR}`);
  }
}

function sweepOldFiles(): void {
  try {
    const files = fs.readdirSync(LOG_DIR as string)
      .filter((f) => /^bgl-\d{4}-\d{2}-\d{2}(-\d+)?\.log$/.test(f))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - LOG_MAX_FILES))) {
      fs.rmSync(path.join(LOG_DIR as string, f), { force: true });
    }
  } catch { /* sweep is best-effort */ }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function emit(level: LogLevel, scope: string, msg: unknown, meta: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const message =
    typeof msg === 'string' ? redactText(msg) : msg instanceof Error ? `${msg.name}: ${redactText(msg.message)}` : String(msg);
  const line = `${new Date().toISOString()} [${scope}] ${level.toUpperCase()} ${message}`;
  const extra = redactMeta(meta);
  if (level === 'error') console.error(line, ...extra);
  else if (level === 'warn') console.warn(line, ...extra);
  else console.log(line, ...extra);
  appendToFileSink(line, redactMeta(extra));
}

/** Scoped logger for a route or module, e.g. `forScope('billing API')`. */
export function forScope(scope: string) {
  return {
    debug: (msg: unknown, ...meta: unknown[]) => emit('debug', scope, msg, meta),
    info: (msg: unknown, ...meta: unknown[]) => emit('info', scope, msg, meta),
    warn: (msg: unknown, ...meta: unknown[]) => emit('warn', scope, msg, meta),
    error: (msg: unknown, ...meta: unknown[]) => emit('error', scope, msg, meta),
  };
}

/** Drop-in replacements for the legacy per-route `console.error('[x API]', msg)` pattern. */
export const logApiError = (scope: string, msg: unknown, ...meta: unknown[]) =>
  emit('error', `${scope} API`, msg, meta);
export const logApiWarn = (scope: string, msg: unknown, ...meta: unknown[]) =>
  emit('warn', `${scope} API`, msg, meta);
export const logApiInfo = (scope: string, msg: unknown, ...meta: unknown[]) =>
  emit('info', `${scope} API`, msg, meta);
