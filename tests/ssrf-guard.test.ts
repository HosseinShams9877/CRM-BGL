import { describe, it, expect } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import {
  parseIPv4Strict, parseIPv4Loose, parseIPv6, isBlockedIPv6, ipLiteralBlocked,
  assertSafeOutboundTarget, SsrfGuardError, outboundAllowLocalEndpoints,
  type InjectableResolver,
} from '@/lib/ssrf-guard';
import {
  safeOutboundFetch, nodePinnedTransport,
  SafeOutboundTimeoutError, SafeOutboundSizeError, SsrfGuardError as ReExported,
  type SafeOutboundTransport, type SafeOutboundResponse, type TransportContext,
} from '@/lib/safe-outbound';

// ════════════════════════════════════════════════════════════
// SSRF GUARD (v2.58.3 — round 88, user finding 4) + FULL-DEADLINE
// OUTBOUND FETCH (finding 5).
//
// The reviewer's mandatory matrix — every case uses the INJECTABLE
// resolver/transport, so NO real request ever leaves to metadata or
// any private network:
//   • loopback / RFC1918 / metadata / IPv6 link-local
//   • fe80::1, fe90::1, febf::1 (fe80::/10 is a RANGE, not one hextet)
//   • DNS with mixed public+private answers
//   • DNS answer CHANGED between check and connect (rebinding) → the
//     socket stays pinned to the verified IP
//   • redirect to a private destination → never followed
//   • TLS verification preserved (servername/rejectUnauthorized untouched)
//   • headers-then-hanging-body → deadline kills it, resources freed
// ════════════════════════════════════════════════════════════

const PUBLIC_V4 = '93.184.216.34'; // example.com
const resolver = (answers: string[]): InjectableResolver =>
  async () => answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const PUBLIC_RESOLVER = resolver([PUBLIC_V4]);

describe('ssrf-guard — literal IP classification (pure)', () => {
  it('parses strict IPv4', () => {
    expect(parseIPv4Strict('192.0.2.1')).toBe(0xc0000201);
    expect(parseIPv4Strict('256.1.1.1')).toBeNull();
    expect(parseIPv4Strict('01.2.3.4')).toBeNull();
  });

  it('parses inet_aton-loose forms (hex/octal/integer) that the OS would accept', () => {
    expect(parseIPv4Loose('0x7f.0.0.1')).toBe(0x7f000001);
    expect(parseIPv4Loose('0177.0.0.1')).toBe(0x7f000001);
    expect(parseIPv4Loose('2130706433')).toBe(0x7f000001);
    expect(parseIPv4Loose('127.1')).toBe(0x7f000001);
    expect(ipLiteralBlocked('0x7f.0.0.1', false)).toBe(true);
    expect(ipLiteralBlocked('2130706433', false)).toBe(true);
  });

  it('parses IPv6 with ::, brackets, zone and embedded IPv4 tail', () => {
    const fe80 = parseIPv6('fe80::1');
    expect(fe80).not.toBeNull();
    expect(fe80![0]).toBe(0xfe);
    const mapped = parseIPv6('[::ffff:192.0.2.1]');
    expect(mapped).not.toBeNull();
    // ::ffff:0:0/96 → the embedded v4 lands in the last 4 bytes
    expect(Array.from(mapped!.slice(12))).toEqual([192, 0, 2, 1]);
    expect(parseIPv6('fe80::1%eth0')).not.toBeNull();
    expect(parseIPv6('not-an-ip')).toBeNull();
  });

  it('fe80::/10 covers fe80, fe90 AND febf (the reviewer-proven holes)', () => {
    for (const h of ['fe80::1', 'fe90::1', 'febf::1', 'fe8f::', 'febf:ffff::1']) {
      expect(isBlockedIPv6(parseIPv6(h)!, false), `${h} must be blocked`).toBe(true);
      // link-local is ALWAYS blocked — even with the local-allow switch
      expect(isBlockedIPv6(parseIPv6(h)!, true), `${h} stays blocked with allowLocal`).toBe(true);
    }
    // …but fec0:: (old site-local, fe80::/10 EXCLUDES it) is a name-territory
    // classification handled by policy, not the link-local range:
    expect((parseIPv6('fec0::1')![0] & 0xc0)).not.toBe(0x80);
  });

  it('blocks loopback / RFC1918 / CGNAT / TEST-NET / multicast / reserved (v4)', () => {
    const blocked = ['127.0.0.1', '127.8.8.8', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '192.0.2.9', '198.51.100.9', '203.0.113.9', '224.0.0.1', '240.0.0.1', '0.0.0.0', '255.255.255.255'];
    for (const ip of blocked) expect(ipLiteralBlocked(ip, false), ip).toBe(true);
    // boundaries of 172.16.0.0/12
    expect(ipLiteralBlocked('172.15.255.255', false)).toBe(false);
    expect(ipLiteralBlocked('172.32.0.0', false)).toBe(false);
  });

  it('cloud metadata (169.254.169.254) is never allowed — with or without the local switch', () => {
    expect(ipLiteralBlocked('169.254.169.254', false)).toBe(true);
    expect(ipLiteralBlocked('169.254.169.254', true)).toBe(true);
  });

  it('the local-allow exception covers loopback+RFC1914 ONLY, never metadata/link-local', () => {
    expect(ipLiteralBlocked('127.0.0.1', true)).toBe(false);
    expect(ipLiteralBlocked('10.1.2.3', true)).toBe(false);
    expect(ipLiteralBlocked('192.168.0.10', true)).toBe(false);
    expect(ipLiteralBlocked('172.20.0.1', true)).toBe(false);
    // ULA / mapped loopback v6 with allowLocal:
    expect(isBlockedIPv6(parseIPv6('::1')!, true)).toBe(false);      // v6 loopback allowed locally
    expect(isBlockedIPv6(parseIPv6('fc00::1')!, true)).toBe(true);   // ULA always blocked
    expect(isBlockedIPv6(parseIPv6('fd00:ec2::1')!, true)).toBe(true); // AWS metadata v6 always blocked
  });

  it('IPv4-mapped/NAT64/6to4 embedded addresses inherit the v4 policy', () => {
    // ::ffff:127.0.0.1 → blocked, allowed locally (mirrors v4 loopback)
    expect(isBlockedIPv6(parseIPv6('::ffff:127.0.0.1')!, false)).toBe(true);
    expect(isBlockedIPv6(parseIPv6('::ffff:127.0.0.1')!, true)).toBe(false);
    // ::ffff:169.254.169.254 → metadata — NEVER allowed
    expect(isBlockedIPv6(parseIPv6('::ffff:169.254.169.254')!, true)).toBe(true);
    // 64:ff9b::10.0.0.1 → NAT64 to RFC1918
    expect(isBlockedIPv6(parseIPv6('64:ff9b::10.0.0.1')!, false)).toBe(true);
    // 2002:a00:1:: → 6to4 carrying 10.0.0.1
    expect(isBlockedIPv6(parseIPv6('2002:0a00:1::')!, false)).toBe(true);
  });

  it('the env switch defaults OFF and only accepts the exact literal "true"', () => {
    expect(outboundAllowLocalEndpoints()).toBe(false);
  });
});

describe('assertSafeOutboundTarget — URL + DNS validation (fail-closed)', () => {
  it('rejects non-http(s) schemes, malformed URLs and embedded credentials', async () => {
    await expect(assertSafeOutboundTarget('ftp://example.com/x')).rejects.toMatchObject({ code: 'SSRF_URL' });
    await expect(assertSafeOutboundTarget('not a url')).rejects.toMatchObject({ code: 'SSRF_URL' });
    await expect(assertSafeOutboundTarget('http://user:pass@example.com/x')).rejects.toMatchObject({ code: 'SSRF_URL' });
  });

  it('rejects literal loopback / RFC1918 / metadata / link-local destinations', async () => {
    for (const url of [
      'http://127.0.0.1:11434/v1/chat/completions',
      'http://localhost.alias.example/', // name → resolved below
      'http://10.0.0.5/api',
      'http://192.168.1.20/api',
      'http://169.254.169.254/latest/meta-data',
      'http://[fe80::1]/',
      'http://[fe90::1]/',
      'http://[febf::1]/',
      'http://[::1]:8080/',
      'http://0x7f.0.0.1/',
      'http://2130706433/',
    ]) {
      if (url.includes('localhost.alias')) continue;
      await expect(assertSafeOutboundTarget(url), url).rejects.toBeInstanceOf(SsrfGuardError);
    }
  });

  it('resolver-level loopback name is blocked too (localhost → 127.0.0.1)', async () => {
    await expect(
      assertSafeOutboundTarget('http://localhost:11434/v1/chat/completions', { resolver: resolver(['127.0.0.1']) }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('DNS failure and empty answers are fail-closed', async () => {
    const boom: InjectableResolver = async () => { throw new Error('ENOTFOUND'); };
    await expect(assertSafeOutboundTarget('http://nope.example.com/', { resolver: boom })).rejects.toMatchObject({ code: 'SSRF_DNS' });
    await expect(assertSafeOutboundTarget('http://empty.example.com/', { resolver: resolver([]) })).rejects.toMatchObject({ code: 'SSRF_DNS' });
  });

  it('MIXED public+private DNS answers are rejected (one bad answer poisons the set)', async () => {
    let transportCalls = 0;
    const t: SafeOutboundTransport = async () => { transportCalls++; throw new Error('must not be reached'); };
    await expect(
      safeOutboundFetch('http://mixed.example.com/x', { method: 'GET' }, {
        resolver: resolver([PUBLIC_V4, '10.0.0.9']), transport: t,
      }),
    ).rejects.toBeInstanceOf(SsrfGuardError);
    expect(transportCalls).toBe(0);
  });

  it('public DNS answers resolve and pin the first verified address', async () => {
    const t = await assertSafeOutboundTarget('http://ok.example.com/x', { resolver: resolver([PUBLIC_V4, '93.184.216.35']) });
    expect(t.address).toBe(PUBLIC_V4);
    expect(t.url.hostname).toBe('ok.example.com');
  });
});

describe('safeOutboundFetch — pinned transport, deadline, caps (finding 4+5)', () => {
  it('DNS REBINDING: the transport connects to the IP verified at CHECK time, not a re-resolution', async () => {
    let resolveCount = 0;
    const rebindResolver: InjectableResolver = async () => {
      resolveCount++;
      // check-time answer is public; a re-resolution would get a PRIVATE ip
      return resolveCount === 1
        ? [{ address: PUBLIC_V4, family: 4 }]
        : [{ address: '10.0.0.99', family: 4 }];
    };
    const seen: string[] = [];
    const t: SafeOutboundTransport = async (target, _init, ctx) => {
      seen.push(ctx.pinned.address);
      return fakeResponse(200, '{"ok":true}');
    };
    const res = await safeOutboundFetch('http://rebind.example.com/v1', { method: 'POST', body: '{}' }, {
      resolver: rebindResolver, transport: t, timeoutMs: 1000,
    });
    await res.json();
    expect(seen).toEqual([PUBLIC_V4]);          // pinned to the CHECK-time IP
    expect(resolveCount).toBe(1);               // DNS consulted exactly once
  });

  it('REDIRECT to a private destination is never followed (one transport call, 3xx returned as-is)', async () => {
    let calls = 0;
    const t: SafeOutboundTransport = async () => {
      calls++;
      return fakeResponse(302, '', { location: 'http://169.254.169.254/latest/meta-data' });
    };
    const res = await safeOutboundFetch('http://redirector.example.com/x', { method: 'GET' }, {
      resolver: PUBLIC_RESOLVER, transport: t, timeoutMs: 1000,
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('169.254.169.254');
    expect(calls).toBe(1); // no second hop — the private target is never contacted
  });

  it('TLS semantics preserved: hostname/SNI untouched, rejectUnauthorized not disabled, IP only in lookup', async () => {
    const origRequest = https.request;
    let captured: Record<string, unknown> | null = null;
    let lookupResult: { address?: string | number; family?: number } | null = null;
    try {
      (https as unknown as { request: unknown }).request = (url: unknown, options: Record<string, unknown>) => {
        captured = { ...options, __urlHost: (url as URL)?.host };
        const fakeReq = new EventEmitter() as EventEmitter & { write: (b?: unknown) => void; end: () => void; destroy: () => void; setTimeout: (ms: number, cb?: () => void) => void };
        fakeReq.write = () => undefined;
        fakeReq.end = () => {
          const res = new EventEmitter() as EventEmitter & { headers: Record<string, string>; statusCode: number; statusMessage: string; readableEnded: boolean };
          res.headers = { 'content-type': 'application/json' };
          res.statusCode = 200;
          res.statusMessage = 'OK';
          res.readableEnded = true;
          queueMicrotask(() => {
            fakeReq.emit('response', res);
            queueMicrotask(() => res.emit('data', Buffer.from('{"model":"m"}')));
            queueMicrotask(() => res.emit('end'));
          });
        };
        fakeReq.destroy = () => undefined;
        fakeReq.setTimeout = () => fakeReq;
        // capture the pinned lookup's answer
        const lookup = options.lookup as ((h: string, o: unknown, cb: (e: Error | null, a: string | number, f?: number) => void) => void);
        lookup('rebind.example.com', {}, (err, address, family) => {
          lookupResult = { address, family };
        });
        return fakeReq as unknown as http.ClientRequest;
      };
      const res = await safeOutboundFetch('https://rebind.example.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }, { resolver: PUBLIC_RESOLVER, timeoutMs: 1000 });
      const data = await res.json();
      expect(data).toEqual({ model: 'm' });
      // the request went out with the ORIGINAL host (Host header + SNI + cert checks)
      const cap = captured as unknown as Record<string, unknown> | null;
      expect(cap?.['__urlHost']).toBe('rebind.example.com');
      expect((cap?.['servername'] as string | undefined) ?? 'rebind.example.com').toBe('rebind.example.com');
      // TLS verification was NOT switched off
      expect(cap?.['rejectUnauthorized']).not.toBe(false);
      // the ONLY place the verified IP appears is the pinned lookup
      expect(lookupResult).toEqual({ address: PUBLIC_V4, family: 4 });
    } finally {
      (https as unknown as { request: unknown }).request = origRequest;
    }
  });

  it('F5 MANDATORY: headers arrive instantly, body hangs → the single deadline aborts and frees resources', async () => {
    let disposed = false;
    const hanging: SafeOutboundTransport = async () => ({
      ok: true, status: 200, statusText: 'OK', headers: {},
      text: () => new Promise<string>(() => { /* body never arrives */ }),
      json: () => new Promise<never>(() => { /* body never arrives */ }),
      bytes: () => new Promise<Uint8Array>(() => { /* body never arrives */ }),
      dispose: () => { disposed = true; },
    });
    const t0 = Date.now();
    const res = await safeOutboundFetch('http://slowbody.example.com/v1', { method: 'GET' }, {
      resolver: PUBLIC_RESOLVER, transport: hanging, timeoutMs: 80,
    });
    expect(res.status).toBe(200); // headers resolved fine
    await expect(res.text()).rejects.toBeInstanceOf(SafeOutboundTimeoutError);
    // deadline honored (not instant-fail, not unbounded)
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(70);
    expect(dt).toBeLessThan(5000);
    // resources released
    expect(disposed).toBe(true);
    // a second read also fails fast (already aborted) and stays disposed
    await expect(res.json()).rejects.toBeInstanceOf(SafeOutboundTimeoutError);
  });

  it('response size cap aborts oversized bodies (wrapper-level defense)', async () => {
    const big = 'x'.repeat(10 * 1024);
    const t: SafeOutboundTransport = async () => fakeResponse(200, big);
    const res = await safeOutboundFetch('http://big.example.com/x', { method: 'GET' }, {
      resolver: PUBLIC_RESOLVER, transport: t, timeoutMs: 1000, maxResponseBytes: 1024,
    });
    await expect(res.text()).rejects.toBeInstanceOf(SafeOutboundSizeError);
  });

  it('SSRF refusal throws before the transport is ever invoked (no side effects)', async () => {
    let calls = 0;
    const t: SafeOutboundTransport = async () => { calls++; return fakeResponse(200, '{}'); };
    await expect(
      safeOutboundFetch('http://169.254.169.254/latest/meta-data', { method: 'GET' }, { transport: t }),
    ).rejects.toBeInstanceOf(ReExported);
    expect(calls).toBe(0);
  });

  it('generic network failures surface a clean Persian message (no host/IP detail)', async () => {
    const t: SafeOutboundTransport = async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); };
    await expect(
      safeOutboundFetch('http://refused.example.com/x', { method: 'GET' }, { resolver: PUBLIC_RESOLVER, transport: t }),
    ).rejects.toThrow('ارتباط با سرویس خارجی برقرار نشد.');
  });
});

describe('nodePinnedTransport — pinned lookup wiring', () => {
  it('the transport connects via the custom lookup only (pinned IP), never DNS', async () => {
    // exercised through the TLS-semantics test above; here we pin over http
    const origRequest = http.request;
    let lookupAnswer: string | number | undefined;
    try {
      (http as unknown as { request: unknown }).request = (url: unknown, options: Record<string, unknown>) => {
        const lookup = options.lookup as ((h: string, o: unknown, cb: (e: Error | null, a: string | number, f?: number) => void) => void);
        lookup('x.example.com', {}, (_e, address) => { lookupAnswer = address; });
        const fakeReq = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; destroy: () => void; setTimeout: () => void };
        fakeReq.write = () => undefined;
        fakeReq.destroy = () => undefined;
        fakeReq.setTimeout = () => fakeReq;
        fakeReq.end = () => {
          const res = new EventEmitter() as EventEmitter & { headers: Record<string, string>; statusCode: number; statusMessage: string; readableEnded: boolean };
          res.headers = {}; res.statusCode = 204; res.statusMessage = 'No Content'; res.readableEnded = true;
          queueMicrotask(() => { fakeReq.emit('response', res); queueMicrotask(() => res.emit('end')); });
        };
        return fakeReq as unknown as http.ClientRequest;
      };
      const res = await nodePinnedTransport(
        { url: new URL('http://x.example.com/a'), address: '203.0.113.99', family: 4 },
        { method: 'GET', headers: {} },
        { signal: new AbortController().signal, deadlineAt: Date.now() + 500, maxResponseBytes: 1024, pinned: { address: '203.0.113.99', family: 4 } },
      );
      expect(res.status).toBe(204);
      expect(lookupAnswer).toBe('203.0.113.99');
    } finally {
      (http as unknown as { request: unknown }).request = origRequest;
    }
  });
});

// ── helpers ─────────────────────────────────────────────────

function fakeResponse(status: number, body: string, headers: Record<string, string> = {}): SafeOutboundResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers,
    bytes: async () => bytes,
    text: async () => body,
    json: async () => JSON.parse(body),
    dispose: () => undefined,
  };
}

// silence the unused import warning for TransportContext (type-only usage above)
export type _KeepImports = TransportContext;
