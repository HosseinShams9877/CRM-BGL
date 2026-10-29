import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rateLimit, resetRateLimits, RATE_TIERS, clientIpOf } from '@/lib/rate-limit';

describe('rate-limit (P2-7)', () => {
  beforeEach(() => resetRateLimits());

  it('allows requests under the limit and reports remaining', () => {
    const r1 = rateLimit('ip1', 3, 60_000);
    const r2 = rateLimit('ip1', 3, 60_000);
    const r3 = rateLimit('ip1', 3, 60_000);
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, true]);
    expect(r3.remaining).toBe(0);
  });

  it('blocks the request that exceeds the limit with retryAfter', () => {
    for (let i = 0; i < 3; i++) rateLimit('ip2', 3, 60_000);
    const blocked = rateLimit('ip2', 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('does not count blocked hits toward the window (no permanent lockout)', async () => {
    for (let i = 0; i < 5; i++) rateLimit('ip3', 2, 10); // all blocked after 2
    // window is 10ms — wait for expiry
    await new Promise((r) => setTimeout(r, 25));
    const after = rateLimit('ip3', 2, 10);
    expect(after.ok).toBe(true);
  });

  it('isolates keys — one IP hitting the ceiling does not affect another', () => {
    for (let i = 0; i < 5; i++) rateLimit('ipA', 3, 60_000);
    expect(rateLimit('ipB', 3, 60_000).ok).toBe(true);
    expect(rateLimit('ipA', 3, 60_000).ok).toBe(false);
  });

  it('expires old hits after the window passes', async () => {
    rateLimit('ipC', 1, 30);
    expect(rateLimit('ipC', 1, 30).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(rateLimit('ipC', 1, 30).ok).toBe(true);
  });

  it('tiers: auth is stricter than general', () => {
    expect(RATE_TIERS.auth.limit).toBeLessThan(RATE_TIERS.general.limit);
    expect(RATE_TIERS.webhook.limit).toBeGreaterThan(RATE_TIERS.general.limit);
  });
});

describe('clientIpOf (v2.47.0 — XFF spoofing fail-closed)', () => {
  const SAVED = process.env.TRUSTED_PROXY;
  afterEach(() => {
    if (SAVED === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = SAVED;
  });

  it('UNTRUSTED (default): a spoofed X-Forwarded-For is IGNORED (shared bucket)', () => {
    delete process.env.TRUSTED_PROXY;
    // the OLD test expected '1.2.3.4' here — that was the fail-OPEN hole:
    // any client could mint a fresh rate-limit bucket per request.
    expect(clientIpOf(new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('unknown');
    expect(clientIpOf(new Headers({ 'x-real-ip': '9.9.9.9' }))).toBe('unknown');
    expect(clientIpOf(new Headers())).toBe('unknown');
    process.env.TRUSTED_PROXY = 'false';
    expect(clientIpOf(new Headers({ 'x-forwarded-for': '1.2.3.4' }))).toBe('unknown');
  });

  it('TRUSTED_PROXY=true: the RIGHTMOST (proxy-appended) XFF entry wins', () => {
    process.env.TRUSTED_PROXY = 'true';
    // leftmost entries stay attacker-controlled; our proxy appends the last
    expect(clientIpOf(new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('5.6.7.8');
    expect(clientIpOf(new Headers({ 'x-forwarded-for': '1.2.3.4' }))).toBe('1.2.3.4');
    expect(clientIpOf(new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.9.9.9' }))).toBe('9.9.9.9');
  });

  it('TRUSTED_PROXY=true: x-real-ip (nginx view) is honored, junk falls back to unknown', () => {
    process.env.TRUSTED_PROXY = 'true';
    expect(clientIpOf(new Headers({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientIpOf(new Headers({ 'x-real-ip': '   ' }))).toBe('unknown');
    expect(clientIpOf(new Headers())).toBe('unknown');
  });
});
