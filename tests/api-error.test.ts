import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock the logger so the masking path can be asserted without touching disk
vi.mock('@/lib/logger', () => ({
  logApiError: vi.fn(),
}));
import { logApiError } from '@/lib/logger';
import { ApiError, apiErrorMessage, apiErrorStatus } from '@/lib/api-error';

// ═══════════════════════════════════════════════════════════════
// api-error.test.ts — v2.58.3 (round 88, finding 10, part 1) →
// v2.58.4 (user issue 6: TYPE-based message policy — the Persian-
// script heuristic was unsafe: an internal error whose text merely
// CONTAINED Persian characters (a Persian-named table, a Persian
// file path) passed straight through to the client).
//
// MESSAGE POLICY: only the ApiError TYPE (and its subclasses —
// llm/stt/safe-outbound now throw ApiError) reaches the client;
// everything else is masked and logged with a REQUEST ID.
// ═══════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.mocked(logApiError).mockClear();
});

describe('controlled errors keep their message (TYPE-decided)', () => {
  it('ApiError → Persian message + status preserved', () => {
    const e = new ApiError(404, 'سند فروش یافت نشد.');
    expect(apiErrorMessage(e)).toBe('سند فروش یافت نشد.');
    expect(apiErrorStatus(e)).toBe(404);
  });

  it('an ApiError SUBCLASS (safe-outbound style) keeps its message via the type check', () => {
    class SafeOutboundTimeoutError extends ApiError {}
    const e = new SafeOutboundTimeoutError(502, 'مهلت ارتباط با سرویس خارجی به پایان رسید (۳۰ ثانیه) — درخواست لغو شد.');
    expect(apiErrorMessage(e)).toContain('مهلت ارتباط');
    expect(apiErrorStatus(e)).toBe(502);
  });
});

describe('INTERNAL errors are masked and logged with a request id', () => {
  it('a Prisma-style internal error never leaks to the client', () => {
    const e = new Error(
      'Invalid `prisma.salesDocument.findUnique()` invocation: Error code 14: Unable to open the database file at /home/ops/secret-path/dev.db',
    );
    const msg = apiErrorMessage(e, 'خطای داخلی سرور', 'inventory');
    expect(msg).toBe('خطای داخلی سرور');           // generic, Persian
    expect(msg).not.toContain('/home');              // no path leak
    expect(msg).not.toContain('prisma');             // no internals
    // the detail + REQUEST ID went to the log instead
    expect(logApiError).toHaveBeenCalledTimes(1);
    const [routeTag, label, detail] = vi.mocked(logApiError).mock.calls[0];
    expect(routeTag).toBe('inventory');
    expect(String(label)).toMatch(/INTERNAL ERROR masked \[req-[0-9a-f]+\]/);
    expect(String(detail)).toContain('Unable to open');
  });

  it('a Node network error (ENOTFOUND/stack text) is masked', () => {
    const e = new Error('getaddrinfo ENOTFOUND api.internal.svc.cluster.local');
    const msg = apiErrorMessage(e);
    expect(msg).toBe('خطای داخلی سرور');
    expect(msg).not.toContain('ENOTFOUND');
    expect(logApiError).toHaveBeenCalled();
  });

  it('non-Error throws (strings, undefined) fall back safely', () => {
    expect(apiErrorMessage('some raw internal string')).toBe('خطای داخلی سرور');
    expect(apiErrorMessage(undefined)).toBe('خطای داخلی سرور');
    expect(apiErrorMessage(null)).toBe('خطای داخلی سرور');
  });

  it('legacy { status, message } with an ENGLISH message is masked too', () => {
    const e = { status: 500, message: 'connect ECONNREFUSED 10.0.0.1:5432' };
    expect(apiErrorMessage(e)).toBe('خطای داخلی سرور');
    expect(apiErrorStatus(e)).toBe(500); // status still honored
  });

  it('v2.58.4 (issue 6): a plain Error with a PERSIAN message is masked — language is NOT a trust signal', () => {
    // the exact hole the user's audit described: an internal error whose
    // text happens to contain Persian script passed the v2.58.3
    // heuristic and reached the client.
    const e = new Error('SQLiteError: no such table: فروش‌ها (فایل /home/ops/app/dev.db)');
    const msg = apiErrorMessage(e, 'خطای داخلی سرور', 'visits');
    expect(msg).toBe('خطای داخلی سرور');
    expect(msg).not.toContain('/home');
    expect(msg).not.toContain('فایل');
    expect(logApiError).toHaveBeenCalled();
  });

  it('v2.58.4 (issue 6): legacy { status, message } with a PERSIAN message is masked — only the ApiError TYPE is client-safe', () => {
    const e = { status: 409, message: 'این شماره سریال قبلاً ثبت شده است.' };
    expect(apiErrorMessage(e)).toBe('خطای داخلی سرور');
    expect(apiErrorStatus(e)).toBe(409); // status still honored
  });

  it('v2.58.4 (issue 6): a provider-style plain Error (llm/stt pre-fix style) is masked', () => {
    const e = new Error('تنظیمات سرویس OpenAI-سازگار (ai_bridge) کامل نیست');
    expect(apiErrorMessage(e)).toBe('خطای داخلی سرور');
    expect(logApiError).toHaveBeenCalled();
  });

  it('apiErrorStatus: unknown shapes → 500; controlled range preserved', () => {
    expect(apiErrorStatus(new Error('x'))).toBe(500);
    expect(apiErrorStatus({ status: 428, message: 'y' })).toBe(428);
    expect(apiErrorStatus({ status: 200, message: 'y' })).toBe(500); // out of range
  });
});
