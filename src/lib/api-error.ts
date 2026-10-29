// ─────────────────────────────────────────────────────────────
//  Controlled API errors (v2.15.0 — sixth-round audit, item 8;
//  v2.58.3 — round 88, finding 10: internal-detail leak closed;
//  v2.58.4 — user issue 6: TYPE-based message policy).
//
//  Route handlers throw; the route-level catch must turn ANY thrown
//  value into a controlled JSON response. Previously handlers were
//  dispatched without `await`, so their rejections bypassed the
//  surrounding try/catch entirely (Next.js surfaced a bare 500
//  instead of the expected Persian message such as «سند فروش
//  یافت نشد»). Handlers now dispatch with `return await`, and catches
//  normalize the thrown value through the helpers below.
//
//  v2.58.4 — MESSAGE POLICY (the language heuristic REMOVED):
//  The v2.583 policy showed any Error whose message merely LOOKED
//  Persian to the client. That was a language heuristic, not a trust
//  boundary: an internal error whose text happens to contain Persian
//  characters (a Persian-named table, a Persian file path, a provider
//  echoing user input) leaked straight through. Visibility is now
//  decided by TYPE alone:
//    • ApiError (and ONLY ApiError — including its subclasses; the
//      domain modules llm/stt and safe-outbound now throw ApiError)
//      → its message: type-controlled, code-authored, client-safe;
//    • EVERYTHING else (plain Errors, Prisma internals, Node
//      ENOTFOUND, file paths, stack fragments, legacy {status,
//      message} shapes) → the GENERIC fallback. The internal detail
//      is logged server-side with a REQUEST ID so support can
//      correlate a client report with the log line — the client
//      never sees the internals.
// ─────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { logApiError } from '@/lib/logger';

/** Controlled API error carrying an explicit HTTP status code.
 *  v2.58.4: the ONLY type whose message may reach a client. Domain
 *  modules that want a user-facing message throw this (or subclass
 *  it — see safe-outbound.ts). */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Human-readable message for any thrown value, applying the v2.58.4
 * TYPE-based message policy: only ApiError messages are client-safe;
 * every other failure is masked to `fallback` and logged (server-side
 * only) with a short REQUEST ID.
 */
export function apiErrorMessage(e: unknown, fallback = 'خطای داخلی سرور', routeTag = 'api'): string {
  // 1. The ONLY client-visible channel: the ApiError TYPE.
  if (e instanceof ApiError && e.message) return e.message;

  // 2. Everything else is INTERNAL — mask, log with a request id.
  //    (v2.58.3's Persian-script heuristic is gone: language is not a
  //    trust signal. Legacy `{ status, message }` objects are masked
  //    too — no code path throws them anymore, and a shape is not a
  //    type guarantee.)
  const reqId = `req-${crypto.randomBytes(6).toString('hex')}`;
  const detail = e instanceof Error
    ? `${e.name}: ${e.message}`
    : typeof e === 'string' ? e.slice(0, 300) : JSON.stringify(e)?.slice(0, 300) ?? 'unserializable';
  logApiError(routeTag, `INTERNAL ERROR masked [${reqId}]:`, detail.slice(0, 500));
  return fallback;
}

/** HTTP status for a thrown value. ApiError (and legacy `{status, message}`
 *  objects) keep their intended 4xx/5xx code; every other failure is an
 *  internal error. */
export function apiErrorStatus(e: unknown): number {
  if (e instanceof ApiError) return e.status;
  if (typeof e === 'object' && e !== null) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600) {
      return status;
    }
  }
  return 500;
}
