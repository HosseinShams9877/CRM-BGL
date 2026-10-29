// ════════════════════════════════════════════════════════
// Generic API rate limiter (P2-7)
//
// Sliding-window counters keyed by client IP + bucket name.
// In-memory store — correct for the current single-instance
// SQLite deployment. For a future multi-instance deployment,
// swap the Map for a Redis-backed store; the interface stays.
// ════════════════════════════════════════════════════════

interface RateLimitResult {
  ok: boolean;
  /** Seconds until the oldest hit leaves the window (0 when ok). */
  retryAfterSec: number;
  remaining: number;
}

/** bucket key → timestamps (ms) of accepted hits inside the window */
const store = new Map<string, number[]>();

const MAX_TRACKED_KEYS = 10_000;

function evictStale(now: number, windowMs: number): void {
  for (const [key, hits] of store) {
    const fresh = hits.filter((t) => now - t < windowMs);
    if (fresh.length === 0) store.delete(key);
    else store.set(key, fresh);
  }
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const hits = (store.get(key) ?? []).filter((t) => now - t < windowMs);

  if (store.size > MAX_TRACKED_KEYS) evictStale(now, windowMs);

  if (hits.length >= limit) {
    store.set(key, hits); // keep window state without adding a hit
    const retryAfterSec = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
    return { ok: false, retryAfterSec, remaining: 0 };
  }

  hits.push(now);
  store.set(key, hits);
  return { ok: true, retryAfterSec: 0, remaining: limit - hits.length };
}

/** Test helper: forget all tracked state. */
export function resetRateLimits(): void {
  store.clear();
}

// ── Policy tiers ────────────────────────────────────────
// auth endpoints (login / change-password): strict anti-brute-force
// everything else: generous scraping/DoS ceiling
export const RATE_TIERS = {
  auth: { limit: 20, windowMs: 60_000 },
  general: { limit: 120, windowMs: 60_000 },
  webhook: { limit: 300, windowMs: 60_000 },
} as const;

export function clientIpOf(req: Headers): string {
  // v2.47.0 — X-Forwarded-For is attacker-SPOOFABLE on any deployment where
  // the app is NOT behind a proxy that overwrites the header: a client that
  // sends a random XFF per request used to get a fresh rate-limit bucket
  // each time, defeating brute-force throttling entirely. Fail-closed rule:
  //   • TRUSTED_PROXY unset/false → XFF is IGNORED (direct connections get
  //     the shared 'unknown' bucket; set TRUSTED_PROXY=true behind your own
  //     nginx/tunnel so forwarded clients are counted individually).
  //   • TRUSTED_PROXY=true → trust the RIGHTMOST XFF entry (the hop OUR proxy
  //     appended — the leftmost entries stay attacker-controlled) and
  //     x-real-ip (nginx's own view of the direct peer).
  const trusted = process.env.TRUSTED_PROXY === 'true';
  if (!trusted) return 'unknown';
  const fwd = req.get('x-forwarded-for');
  if (fwd) {
    const hops = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  const real = req.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}
