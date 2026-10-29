// ════════════════════════════════════════════════════════════
// SAFE OUTBOUND FETCH (v2.58.3 — round 88, user finding 5)
//
// One guarded door for EVERY outbound AI request (chat / LLM /
// STT / connection-test). Replaces the raw fetch() calls whose
// timer was cleared as soon as the response HEADERS arrived —
// a slow/hanging BODY then ran with no deadline at all.
//
// The contract:
//   • ONE absolute deadline covers DNS resolution, connect,
//     headers AND the complete body — the timer is armed once
//     and only released when the operation fully ends.
//   • DNS is resolved + validated up front (ssrf-guard) and the
//     socket is PINNED to the verified IP via a custom `lookup`
//     — rebinding between check and connect is impossible, while
//     the Host header, SNI and TLS certificate verification stay
//     bound to the ORIGINAL hostname (correct https semantics).
//   • Redirects are never followed (the node transport does not
//     auto-follow; a 3xx is returned as a plain status).
//   • Response size is capped per service (maxResponseBytes);
//     a bigger body aborts the transfer and frees the socket.
//   • Timer, stream and connection are ALWAYS released on error,
//     deadline or success (dispose() is idempotent).
//   • Client-facing errors are short, Persian and generic —
//     internal details (target, code) go to the log only.
//
// Transport + resolver are injectable so every branch is tested
// with mock transports — no real request to any network.
// ════════════════════════════════════════════════════════════

import http from 'node:http';
import https from 'node:https';
import { assertSafeOutboundTarget, SsrfGuardError, type SafeOutboundTarget, type InjectableResolver } from './ssrf-guard';
import { ApiError } from '@/lib/api-error';
import { logApiError } from './logger';

export { SsrfGuardError };

// ── public types ────────────────────────────────────────────

export interface SafeOutboundInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Pre-serialized body (string or bytes). FormData must be serialized by the caller. */
  body?: string | Uint8Array;
}

export interface SafeOutboundResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Body as UTF-8 text (deadline + size cap enforced). */
  text(): Promise<string>;
  /** Body parsed as JSON (deadline + size cap enforced). */
  json<T = unknown>(): Promise<T>;
  /** Raw body bytes (deadline + size cap enforced). */
  bytes(): Promise<Uint8Array>;
  /** Free socket/stream resources. Idempotent; exposed for tests. */
  dispose(): void;
}

export interface TransportContext {
  /** Aborts when the WHOLE operation deadline hits. */
  signal: AbortSignal;
  /** Absolute epoch-ms deadline. */
  deadlineAt: number;
  /** Hard cap on response bytes. */
  maxResponseBytes: number;
  /** The verified IP the socket MUST connect to. */
  pinned: { address: string; family: 4 | 6 };
}

export type SafeOutboundTransport = (
  target: SafeOutboundTarget,
  init: Required<Pick<SafeOutboundInit, 'method' | 'headers'>> & { body?: string | Uint8Array },
  ctx: TransportContext,
) => Promise<SafeOutboundResponse>;

export interface SafeOutboundOptions {
  /** Whole-operation deadline. Default 30s. */
  timeoutMs?: number;
  /** Response size cap. Default 2 MiB. */
  maxResponseBytes?: number;
  resolver?: InjectableResolver;
  /** Injectable transport (tests). Default: the pinned node transport. */
  transport?: SafeOutboundTransport;
  allowLocalEndpoints?: boolean;
}

export class SafeOutboundTimeoutError extends ApiError {
  constructor(timeoutMs: number) {
    super(502, `مهلت ارتباط با سرویس خارجی به پایان رسید (${Math.round(timeoutMs / 1000)} ثانیه) — درخواست لغو شد.`);
    this.name = 'SafeOutboundTimeoutError';
  }
}

export class SafeOutboundSizeError extends ApiError {
  constructor() {
    super(502, 'پاسخ سرویس خارجی از حد مجاز بزرگ‌تر است — دریافت متوقف شد.');
    this.name = 'SafeOutboundSizeError';
  }
}

export class SafeOutboundNetworkError extends ApiError {
  constructor() {
    super(502, 'ارتباط با سرویس خارجی برقرار نشد.');
    this.name = 'SafeOutboundNetworkError';
  }
}

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// ── the guarded fetch ───────────────────────────────────────

/**
 * Guarded outbound request. Throws SsrfGuardError / SafeOutboundTimeoutError /
 * SafeOutboundSizeError / SafeOutboundNetworkError — all carrying Persian,
 * client-safe messages. Internal details (target host, code) go to the log
 * (route tag `safe-outbound`), never into the thrown message.
 */
export async function safeOutboundFetch(
  rawUrl: string,
  init: SafeOutboundInit = {},
  opts: SafeOutboundOptions = {},
): Promise<SafeOutboundResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const deadlineAt = Date.now() + timeoutMs;

  // ONE controller + ONE timer for the whole operation (DNS → connect →
  // headers → full body). THE TIMER IS NOT RELEASED WHEN THE HEADERS
  // RESOLVE — that was the exact production bug (headers arrive, timer
  // clears, a hanging body then runs unbounded). It is released only
  // when a body read fully completes, when the response is disposed,
  // or when the deadline itself fires.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let timerCleared = false;
  const clearTimer = () => {
    if (!timerCleared) {
      timerCleared = true;
      clearTimeout(timer);
    }
  };
  const deadlineHit = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new SafeOutboundTimeoutError(timeoutMs)), { once: true });
  });
  // swallow late rejections of a race we no longer await
  deadlineHit.catch(() => undefined);

  const transport: SafeOutboundTransport = opts.transport ?? nodePinnedTransport;
  const method = init.method ?? 'GET';
  const headers = init.headers ?? {};

  let res: SafeOutboundResponse | null = null;
  // v2.58.5 (R5): ONE idempotent finish() — clearTimer + transport
  // dispose — runs on EVERY exit path: successful read, body error,
  // deadline, over-cap, the wrapper's own dispose(), and this catch.
  // The old code cleared the timer ONLY on the error paths (a successful
  // read left the timer armed → a LATE deadline fired after success)
  // and the wrapper's dispose called the raw res.dispose() directly,
  // bypassing the timer cleanup.
  const finish = () => {
    clearTimer();
    res?.dispose(); // the node transport's dispose is itself idempotent
  };
  try {
    // Stage 1 — validate + resolve + pin (inside the deadline).
    const target = await raceDeadline(assertSafeOutboundTarget(rawUrl, {
      resolver: opts.resolver,
      allowLocalEndpoints: opts.allowLocalEndpoints,
    }), deadlineHit);

    // Stage 2 — transport: connect pinned, headers + body, size-capped.
    res = await raceDeadline(
      transport(target, { method, headers, body: init.body }, {
        signal: controller.signal,
        deadlineAt,
        maxResponseBytes,
        pinned: { address: target.address, family: target.family },
      }),
      deadlineHit,
    );

    // Stage 3 — wrap the body readers so the SAME deadline covers them
    // (a transport may resolve headers immediately and stall the body —
    // the race below kills it at the deadline and disposes the stream),
    // and enforce the response size cap a second time (defense in depth:
    // the node transport caps while streaming; this caps whatever a
    // transport returns).
    const guarded = wrapBodyWithDeadline(res, deadlineHit, finish, maxResponseBytes);
    return guarded;
  } catch (e: unknown) {
    clearTimer();
    // (R5) the fetch-level failure path releases the transport too
    finish();
    // log internal detail (host/code only — never headers/keys), return a
    // clean, generic, Persian error to the caller
    const host = safeHostOf(rawUrl);
    if (e instanceof SsrfGuardError) {
      logApiError('safe-outbound', 'SSRF refused:', host, e.code);
    } else if (e instanceof SafeOutboundTimeoutError) {
      logApiError('safe-outbound', 'deadline hit:', host, `${timeoutMs}ms`);
    } else if (e instanceof SafeOutboundSizeError) {
      logApiError('safe-outbound', 'response over cap:', host, `${maxResponseBytes}B`);
    } else {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logApiError('safe-outbound', 'transport failure:', host, detail.slice(0, 200));
    }
    try {
      res?.dispose();
    } catch { /* idempotent best-effort */ }
    if (e instanceof SsrfGuardError || e instanceof SafeOutboundTimeoutError || e instanceof SafeOutboundSizeError) {
      throw e; // already client-safe
    }
    throw new SafeOutboundNetworkError();
  }
  // NOTE (v2.58.5 / R5): no timer can outlive the operation anymore —
  // every exit path (success, error, deadline, dispose) runs the shared
  // idempotent finish() above. The old "the timer fires at the deadline
  // and disposes the stream" fail-closed note only applied to callers
  // who NEVER read and NEVER disposed; such a caller now leaks nothing
  // either: the deadline fires, the abort listener disposes the
  // transport, and the timer has fired exactly once.
}

function raceDeadline<T>(p: Promise<T>, deadline: Promise<never>): Promise<T> {
  return Promise.race([p, deadline]);
}

function safeHostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '(invalid-url)';
  }
}

function wrapBodyWithDeadline(
  res: SafeOutboundResponse,
  deadline: Promise<never>,
  finish: () => void,
  maxResponseBytes: number,
): SafeOutboundResponse {
  // v2.58.5 (R5): finish() is the ONE shared, idempotent cleanup path
  // (clearTimer + dispose). It runs on success (the buffered body is
  // retained by the node transport, so reads AFTER dispose still return
  // the received bytes — documented behavior), on every error, and on
  // the wrapper's explicit dispose().
  const guardedRead = async <T>(read: () => Promise<T>, byteLengthOf: (v: T) => number): Promise<T> => {
    try {
      const v = await Promise.race([read(), deadline]);
      if (byteLengthOf(v) > maxResponseBytes) {
        finish();
        throw new SafeOutboundSizeError();
      }
      finish(); // ← (R5) a SUCCESSFUL read releases timer + transport
      return v;
    } catch (e) {
      finish();
      throw e;
    }
  };
  const enc = new TextEncoder();
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    text: () => guardedRead(() => res.text(), (s) => enc.encode(s).length),
    json: <T>() => guardedRead(() => res.json<T>(), (v) => enc.encode(JSON.stringify(v)).length),
    bytes: () => guardedRead(() => res.bytes(), (b) => b.length),
    // (R5) the wrapper's dispose runs the FULL cleanup (timer + transport),
    // not just the raw transport dispose. Idempotent by construction.
    dispose: () => finish(),
  };
}

// ── default transport: node http/https with a pinned lookup ─

type NodeLookupCallback = (err: Error | null, address: string | number, family?: number) => void;

/**
 * The production transport. Connects through a custom `lookup` that
 * answers with the VERIFIED IP (never re-resolves DNS), so the actual
 * TCP/TLS connection cannot drift to a rebound address. Because the
 * request's host stays the original hostname:
 *   • the Host header is the real service host,
 *   • SNI uses the hostname,
 *   • the TLS certificate is verified against the hostname
 *     (rejectUnauthorized stays on — the default),
 *   • redirects are never followed.
 * The whole body is buffered with the size cap; the shared deadline
 * signal destroys the request on timeout.
 */
export function nodePinnedTransport(
  target: SafeOutboundTarget,
  init: Required<Pick<SafeOutboundInit, 'method' | 'headers'>> & { body?: string | Uint8Array },
  ctx: TransportContext,
): Promise<SafeOutboundResponse> {
  return new Promise<SafeOutboundResponse>((resolve, reject) => {
    const mod = target.url.protocol === 'https:' ? https : http;

    const pinnedLookup = (
      _hostname: string,
      _options: unknown,
      callback: NodeLookupCallback,
    ) => {
      // PIN — the answer is the pre-verified address; DNS is never consulted again.
      callback(null, target.address, target.family);
    };

    const req = mod.request(target.url, {
      method: init.method,
      headers: init.headers,
      lookup: pinnedLookup as unknown as NonNullable<http.RequestOptions['lookup']>,
    });

    let settled = false;
    const chunks: Buffer[] = [];
    let received = 0;
    let overCap = false;
    let destroyed = false;

    const cleanup = () => {
      if (destroyed) return;
      destroyed = true;
      ctx.signal.removeEventListener('abort', onAbort);
      req.destroy();
    };
    const onAbort = () => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new SafeOutboundTimeoutError(Math.max(1, ctx.deadlineAt - Date.now())));
      }
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    req.setTimeout(1_000_000, () => { /* socket-level idles are the deadline's job */ });

    req.on('response', (r) => {
      // 3xx is returned as a plain status — never followed.
      r.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > ctx.maxResponseBytes) {
          overCap = true;
          cleanup();
          return;
        }
        chunks.push(chunk);
      });
      r.on('end', () => {
        if (settled) return;
        settled = true;
        if (overCap) {
          reject(new SafeOutboundSizeError());
          return;
        }
        resolve(makeResponse(r, Buffer.concat(chunks), cleanup));
      });
      r.on('error', (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      });
      r.on('close', () => {
        // stream closed without 'end' (premature abort/destroy)
        if (!settled && !r.readableEnded) {
          settled = true;
          if (overCap) reject(new SafeOutboundSizeError());
          else reject(new SafeOutboundNetworkError());
        }
      });
    });

    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      // TLS failures and connect refusals land here — sanitized upstream.
      reject(e);
    });

    if (init.body !== undefined && init.body !== null) {
      req.write(init.body);
    }
    req.end();
  });
}

function makeResponse(
  r: http.IncomingMessage,
  body: Buffer,
  cleanup: () => void,
): SafeOutboundResponse {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) {
    headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  }
  const status = r.statusCode ?? 0;
  const statusText = r.statusMessage ?? '';
  const bytes = new Uint8Array(body);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cleanup();
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers,
    bytes: async () => bytes,
    text: async () => new TextDecoder().decode(bytes),
    json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
    dispose,
  };
}

// ── helper: serialize a FormData body for the transport ─────

/**
 * Serialize FormData (multipart) into { data, contentType } using the
 * platform's own Response/FormData machinery — the caller then passes
 * `data` as the body and `contentType` in the headers. Keeps the safe
 * transport body type simple (string | bytes).
 */
export async function serializeFormData(form: FormData): Promise<{ data: Uint8Array; contentType: string }> {
  const r = new Response(form);
  const data = new Uint8Array(await r.arrayBuffer());
  const contentType = r.headers.get('content-type') || 'multipart/form-data';
  return { data, contentType };
}
