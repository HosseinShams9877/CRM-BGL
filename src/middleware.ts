import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, RATE_TIERS, clientIpOf } from '@/lib/rate-limit';
import { isAllowedOrigin } from '@/lib/origin-match';

/**
 * Edge middleware guarding /api/* with two defense layers:
 *
 * 1. Rate limiting (P2-7) — sliding window per client IP, applied to ALL
 *    methods (GET included, for scraping defense). Auth endpoints get a
 *    strict tier; the signed webhook gets a generous server-to-server tier.
 *
 * 2. Same-origin enforcement (P1-4, CSRF defense) — for every non-GET/
 *    HEAD/OPTIONS request, the Origin (or Referer) must match the request's
 *    own Host. Requests without any origin information are rejected
 *    (fail-closed): browsers always attach Origin to cross-origin POSTs,
 *    so a missing Origin on a mutating request indicates a non-browser
 *    client, which must authenticate differently anyway.
 *
 *    v2.31.1 — the match now ALSO honors X-Forwarded-Host, RFC 7239
 *    Forwarded, and the TRUSTED_ORIGINS env allowlist (see
 *    src/lib/origin-match.ts for the security reasoning). Before this,
 *    every login behind a Host-rewriting proxy (platform preview links,
 *    tunnels, default proxy_pass) was rejected with
 *    «درخواست از مبدا غیرمجاز رد شد.» — the app was unreachable through
 *    the very deployments its own DEPLOYMENT.md describes.
 *
 * Exemptions from CSRF (not from rate limiting):
 *  - hesabfa webhook callbacks (server-to-server, signature-verified in-route)
 *  - telephony webhook (v2.28.0 — server-to-server, HMAC-SHA256-verified
 *    in-route; the signature over the raw body IS the auth)
 */

const EXEMPT_PATHS = ['/api/hesabfa/webhook', '/api/ai-sales/telephony/webhook'];
const AUTH_PATHS = ['/api/auth'];

export function middleware(req: NextRequest) {
  const { method } = req;
  const path = req.nextUrl.pathname;
  const ip = clientIpOf(req.headers);

  // ── Layer 1: rate limit (all methods, all /api paths) ──
  const tier = AUTH_PATHS.some((p) => path.startsWith(p))
    ? RATE_TIERS.auth
    : EXEMPT_PATHS.some((p) => path.startsWith(p))
      ? RATE_TIERS.webhook
      : RATE_TIERS.general;

  const rl = rateLimit(`${ip}:${path.startsWith('/api/auth') ? 'auth' : 'api'}`, tier.limit, tier.windowMs);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'تعداد درخواست‌ها بیش از حد مجاز است. لطفاً کمی بعد دوباره تلاش کنید.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return NextResponse.next();
  }

  if (EXEMPT_PATHS.some((p) => path.startsWith(p))) {
    return NextResponse.next();
  }

  // ── Layer 2: same-origin enforcement for mutating requests ──
  // v2.31.1: host matching extracted to src/lib/origin-match.ts (pure,
  // unit-tested) and extended with proxy awareness. Origin/Referer must
  // match Host, X-Forwarded-Host, RFC 7239 Forwarded, or TRUSTED_ORIGINS.
  const allowed = isAllowedOrigin({
    originHeader: req.headers.get('origin') ?? req.headers.get('referer'),
    host: req.headers.get('host'),
    forwardedHost: req.headers.get('x-forwarded-host'),
    forwarded: req.headers.get('forwarded'),
    trustedOrigins: process.env.TRUSTED_ORIGINS,
  });
  if (allowed) return NextResponse.next();

  return NextResponse.json(
    { error: 'درخواست از مبدا غیرمجاز رد شد.' },
    { status: 403 },
  );
}

export const config = {
  matcher: '/api/:path*',
};
