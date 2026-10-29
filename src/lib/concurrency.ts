import { ApiError } from '@/lib/api-error';

/**
 * v2.25.0 — shared optimistic-concurrency token check (numeric CAS).
 *
 * The v2.20–v2.24 guards compared the client's `expectedUpdatedAt` copy
 * against the live row with a 1000ms tolerance. That tolerance was the
 * residual flaw: two saves inside one second could BOTH pass the check
 * (the second one silently dropping the first). This helper replaces it
 * with an exact integer compare against the row's `version` column,
 * which every write increments (`version: { increment: 1 }`).
 *
 * v2.27.1 — the deprecated `expectedUpdatedAt` fallback (kept for one
 * release window after v2.25.0) is now REMOVED. Every current client
 * sends `expectedVersion`, and every list/get handler returns `version`.
 *
 * Token precedence (per call):
 *  1. `expectedVersion` — EXACT match required; mismatch → 409.
 *  2. missing           — when `required` (edit paths): 428, telling
 *     the caller to reload the row and send the token. Status-transition
 *     handlers (approve / cancel / submit / payment) keep relying on
 *     their in-tx status guards and do NOT require a token.
 *
 * Every handler that uses this MUST also increment `version` on its
 * write, otherwise the token stops tracking concurrent edits.
 */
export function assertConcurrencyToken(opts: {
  expectedVersion?: number | string | null;
  liveVersion: number;
  /** Persian entity label used in the conflict messages (e.g. «سند فروش»). */
  entityLabel: string;
  /** Edit paths pass true → a missing token answers 428. */
  required?: boolean;
}): void {
  const {
    expectedVersion,
    liveVersion,
    entityLabel,
    required,
  } = opts;

  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== '') {
    const clientVersion = Number(expectedVersion);
    if (!Number.isInteger(clientVersion) || clientVersion < 1) {
      throw new ApiError(
        400,
        `نسخهٔ ارسالی برای ${entityLabel} نامعتبر است. رکورد را بارگذاری مجدد کنید و دوباره تلاش کنید.`,
      );
    }
    if (clientVersion !== liveVersion) {
      throw new ApiError(
        409,
        `${entityLabel} هم‌زمان توسط کاربر دیگری تغییر کرده است (نسخهٔ فعلی: ${liveVersion}). برای دیدن آخرین تغییرات، رکورد را بارگذاری مجدد کنید و اصلاحات خود را دوباره اعمال کنید.`,
      );
    }
    return;
  }

  if (required) {
    throw new ApiError(
      428,
      `برای جلوگیری از از دست رفتن تغییرات، ارسال نسخهٔ فعلی ${entityLabel} (expectedVersion) الزامی است. رکورد را بارگذاری مجدد کنید و دوباره تلاش کنید.`,
    );
  }
}
