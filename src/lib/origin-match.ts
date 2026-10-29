// ═══════════════════════════════════════════════════════════
// ORIGIN MATCH — v2.31.1
//
// Pure helper behind the middleware's CSRF layer (same-origin
// enforcement, P1-4). The original check compared the request's
// Origin/Referer host against the Host header ONLY — correct for
// direct access and for nginx deployments that preserve Host
// (`proxy_set_header Host $host`, our own template does), but it
// rejected every legitimate login behind proxies that rewrite Host
// to the upstream address (platform preview links, tunnels,
// cloudflared, default `proxy_pass` behavior): the browser sends
// Origin: https://app.example.com while the app sees Host:
// localhost:3000 → «درخواست از مبدا غیرمجاز رد شد.»
//
// The request is now considered same-origin when the Origin host
// matches ANY of:
//   1. Host header                     — direct / Host-preserving proxy
//   2. X-Forwarded-Host entries        — proxy chains that carry the
//                                        original host (any comma entry:
//                                        each hop observed that host)
//   3. RFC 7239 Forwarded host= params — the standard equivalent
//   4. TRUSTED_ORIGINS env entries     — explicit operator allowlist
//                                        (exact host, full origin URL,
//                                        or wildcard like *.space-z.ai)
//
// SECURITY REASONING (why this stays a solid CSRF layer):
//   • Browsers cannot forge the Origin header on cross-site POSTs,
//     and cannot set X-Forwarded-Host / Forwarded at all (forbidden
//     header names). So a browser-based CSRF attacker cannot make
//     their evil origin match these extra sources.
//   • The session cookie is host-only (no Domain attr) + SameSite=Lax:
//     modern browsers already refuse to attach it to cross-site
//     mutating requests. This middleware is defense-in-depth.
//   • Non-browser clients CAN spoof every header here — they are
//     stopped by cookie authentication, not by this layer.
//   • Edge-proxy hygiene (same policy as X-Forwarded-For, v2.29.0):
//     your proxy should OVERWRITE these headers, not append, so a
//     direct-to-origin attacker cannot inject a matching host.
//   • Wildcards in TRUSTED_ORIGINS (e.g. *.space-z.ai for platform
//     preview links) trust sibling subdomains — safe under host-only
//     cookies + Lax, but use exact hosts when you run a real domain.
// ═══════════════════════════════════════════════════════════

export interface OriginCheckInput {
  /** Origin header, or Referer as fallback. Null → fail-closed. */
  originHeader: string | null | undefined;
  /** Host header of the request as received. */
  host: string | null | undefined;
  /** X-Forwarded-Host header (may be a comma-separated chain). */
  forwardedHost?: string | null;
  /** RFC 7239 Forwarded header (for=..;host=..;proto=.., comma chains). */
  forwarded?: string | null;
  /** TRUSTED_ORIGINS env value — comma-separated entries, optional. */
  trustedOrigins?: string | null;
}

/** Hostname equality is case-insensitive (RFC 3986 §6.2.2.1). */
function normalizeHost(h: string): string {
  return h.trim().toLowerCase();
}

/** Parse a trusted-origins entry into an exact host or a wildcard. */
function trustedEntryToMatcher(entry: string): ((host: string) => boolean) | null {
  const raw = entry.trim().toLowerCase();
  if (!raw) return null;

  // Full origin URL form: https://crm.example.com[:8443]
  if (raw.includes('://')) {
    try {
      const host = new URL(raw).host.toLowerCase();
      if (!host) return null;
      return (h) => h === host;
    } catch {
      return null;
    }
  }

  // Wildcard form: *.space-z.ai — matches any depth of subdomain,
  // NOT the apex itself (nginx wildcard semantics).
  if (raw.startsWith('*.')) {
    const suffix = raw.slice(1); // ".space-z.ai"
    return (h) => h.endsWith(suffix);
  }

  // Bare host form (may include port): crm.example.com[:3000]
  return (h) => h === raw;
}

/** Extract host= values from an RFC 7239 Forwarded chain. */
function forwardedHosts(forwarded: string): string[] {
  const out: string[] = [];
  // Chain entries are comma-separated; params within an entry are
  // semicolon-separated. host values may be quoted ("host").
  for (const element of forwarded.split(',')) {
    for (const param of element.split(';')) {
      const eq = param.indexOf('=');
      if (eq === -1) continue;
      const key = param.slice(0, eq).trim().toLowerCase();
      const val = param.slice(eq + 1).trim().replace(/^"|"$/g, '');
      if (key === 'host' && val) out.push(normalizeHost(val));
    }
  }
  return out;
}

/**
 * Should this mutating request be considered same-origin?
 * Fail-closed: anything unparseable or missing → false.
 */
export function isAllowedOrigin(input: OriginCheckInput): boolean {
  const { originHeader, host, forwardedHost, forwarded, trustedOrigins } = input;
  if (!originHeader) return false; // browsers always send Origin on cross-origin POSTs

  let originHost: string;
  try {
    originHost = new URL(originHeader).host.toLowerCase();
  } catch {
    return false; // malformed origin/referer → reject
  }
  if (!originHost) return false;

  // 1) Direct host
  if (host && normalizeHost(host) === originHost) return true;

  // 2) X-Forwarded-Host chain — every entry was observed by a hop
  if (forwardedHost) {
    for (const entry of forwardedHost.split(',')) {
      const h = normalizeHost(entry);
      if (h && h === originHost) return true;
    }
  }

  // 3) RFC 7239 Forwarded header
  if (forwarded) {
    for (const h of forwardedHosts(forwarded)) {
      if (h === originHost) return true;
    }
  }

  // 4) Explicit operator trust (TRUSTED_ORIGINS)
  if (trustedOrigins) {
    for (const entry of trustedOrigins.split(',')) {
      const matcher = trustedEntryToMatcher(entry);
      if (matcher && matcher(originHost)) return true;
    }
  }

  return false;
}
