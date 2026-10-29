// Unit tests — origin matching behind proxies (v2.31.1).
// Pins the CSRF same-origin layer to its four trust sources:
// Host, X-Forwarded-Host, RFC 7239 Forwarded, TRUSTED_ORIGINS.
// Real-world bug this guards: login behind a Host-rewriting proxy
// (platform preview link / tunnel / default proxy_pass) was rejected
// with «درخواست از مبدا غیرمجاز رد شد.»
import { describe, it, expect } from 'vitest';
import { isAllowedOrigin, OriginCheckInput } from '@/lib/origin-match';

const direct = (origin: string, host: string): OriginCheckInput => ({
  originHeader: origin,
  host,
});

describe('direct access (unchanged legacy behavior)', () => {
  it('allows Origin host === Host', () => {
    expect(isAllowedOrigin(direct('http://localhost:3000', 'localhost:3000'))).toBe(true);
  });

  it('is case-insensitive on host names', () => {
    expect(isAllowedOrigin(direct('http://CRM.Example.com', 'crm.example.com'))).toBe(true);
  });

  it('rejects a different host', () => {
    expect(isAllowedOrigin(direct('https://evil.example', 'localhost:3000'))).toBe(false);
  });

  it('rejects port mismatch (host:port is part of identity)', () => {
    expect(isAllowedOrigin(direct('http://localhost:3000', 'localhost'))).toBe(false);
    expect(isAllowedOrigin(direct('http://localhost', 'localhost:3000'))).toBe(false);
  });

  it('fails closed on missing origin AND missing host', () => {
    expect(isAllowedOrigin({ originHeader: null, host: 'localhost:3000' })).toBe(false);
    expect(isAllowedOrigin({ originHeader: 'http://localhost:3000', host: null })).toBe(false);
  });

  it('fails closed on malformed origin and empty host', () => {
    expect(isAllowedOrigin(direct('not-a-url', 'localhost:3000'))).toBe(false);
    expect(isAllowedOrigin(direct('http://localhost:3000', '  '))).toBe(false);
  });

  it('accepts Referer as the origin fallback', () => {
    expect(isAllowedOrigin(direct('https://crm.example.com/login', 'crm.example.com'))).toBe(true);
  });
});

describe('behind a Host-rewriting proxy (the bug scenario)', () => {
  const input = (extra: Partial<OriginCheckInput>): OriginCheckInput => ({
    originHeader: 'https://preview-chat-bgl.space-z.ai',
    host: 'localhost:3000',
    ...extra,
  });

  it('rejects when the proxy carries no original-host header', () => {
    expect(isAllowedOrigin(input({}))).toBe(false);
  });

  it('allows via X-Forwarded-Host', () => {
    expect(isAllowedOrigin(input({ forwardedHost: 'preview-chat-bgl.space-z.ai' }))).toBe(true);
  });

  it('allows via any comma entry of the X-Forwarded-Host chain', () => {
    expect(
      isAllowedOrigin(input({ forwardedHost: 'internal-hop.local, preview-chat-bgl.space-z.ai' })),
    ).toBe(true);
  });

  it('ignores empty X-Forwarded-Host entries', () => {
    expect(isAllowedOrigin(input({ forwardedHost: ' , ' }))).toBe(false);
  });

  it('allows via RFC 7239 Forwarded host= param', () => {
    expect(
      isAllowedOrigin(input({ forwarded: 'for=203.0.113.7;host=preview-chat-bgl.space-z.ai;proto=https' })),
    ).toBe(true);
  });

  it('allows via a quoted Forwarded host value', () => {
    expect(
      isAllowedOrigin(input({ forwarded: 'host="preview-chat-bgl.space-z.ai";proto=https' })),
    ).toBe(true);
  });

  it('allows via Forwarded chain entries', () => {
    expect(
      isAllowedOrigin(input({ forwarded: 'for=10.0.0.1;host=old.example, for=203.0.113.7;host=preview-chat-bgl.space-z.ai' })),
    ).toBe(true);
  });

  it('ignores Forwarded params other than host', () => {
    expect(isAllowedOrigin(input({ forwarded: 'for=203.0.113.7;proto=https' }))).toBe(false);
  });

  it('an X-Forwarded-Host that does not match the origin still rejects', () => {
    expect(isAllowedOrigin(input({ forwardedHost: 'other-app.example.com' }))).toBe(false);
  });
});

describe('TRUSTED_ORIGINS allowlist', () => {
  const base = (trustedOrigins: string): OriginCheckInput => ({
    originHeader: 'https://crm.example.com',
    host: '127.0.0.1:3000',
    trustedOrigins,
  });

  it('allows an exact bare host entry', () => {
    expect(isAllowedOrigin(base('crm.example.com'))).toBe(true);
  });

  it('allows a full origin URL entry (scheme stripped)', () => {
    expect(isAllowedOrigin(base('https://crm.example.com, http://old.example.com'))).toBe(true);
  });

  it('allows an entry with a port', () => {
    expect(isAllowedOrigin({ originHeader: 'http://crm.example.com:8080', host: '127.0.0.1:3000', trustedOrigins: 'crm.example.com:8080' })).toBe(true);
  });

  it('a wildcard *.space-z.ai matches any subdomain depth', () => {
    expect(isAllowedOrigin({ originHeader: 'https://preview-chat-bgl.space-z.ai', host: 'localhost:3000', trustedOrigins: '*.space-z.ai' })).toBe(true);
    expect(isAllowedOrigin({ originHeader: 'https://a.b.space-z.ai', host: 'localhost:3000', trustedOrigins: '*.space-z.ai' })).toBe(true);
  });

  it('a wildcard does NOT match the apex domain', () => {
    expect(isAllowedOrigin({ originHeader: 'https://space-z.ai', host: 'localhost:3000', trustedOrigins: '*.space-z.ai' })).toBe(false);
  });

  it('unrelated domains stay rejected', () => {
    expect(isAllowedOrigin(base('other.example.com'))).toBe(false);
    expect(isAllowedOrigin(base('*.example.org'))).toBe(false);
  });

  it('garbage entries are ignored without throwing', () => {
    expect(isAllowedOrigin(base('::://, , crm.example.com'))).toBe(true);
    expect(isAllowedOrigin(base('::://'))).toBe(false);
  });

  it('empty TRUSTED_ORIGINS grants nothing extra', () => {
    expect(isAllowedOrigin(base(''))).toBe(false);
  });
});
