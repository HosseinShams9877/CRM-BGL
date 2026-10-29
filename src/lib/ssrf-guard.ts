// ════════════════════════════════════════════════════════════
// SSRF GUARD (v2.58.3 — round 88, user finding 4)
//
// WHY THIS EXISTS: every outbound AI call (chat / LLM / STT /
// connection-test) previously used a RAW fetch() against an
// admin-configured URL with NO destination validation. A
// server-side request could be pointed at localhost, RFC1918
// ranges, cloud metadata (169.254.169.254) or IPv6 link-local —
// including the classic DNS-rebinding trick (public DNS answer at
// check time, private answer at connect time).
//
// Contract (fail-closed everywhere):
//   • Only http/https URLs, no embedded credentials.
//   • Literal IPs (strict + inet_aton-loose forms) are validated
//     directly; hostnames are resolved and EVERY answer must pass.
//   • A mixed public+private DNS answer is REJECTED (one bad
//     address poisons the whole set).
//   • DNS failure is REJECTED, never retried-open.
//   • The verified IP is PINNED and returned to the caller — the
//     safe-outbound transport connects to that IP while keeping
//     Host header / SNI / TLS verification on the hostname, so
//     rebinding between check and connect is impossible.
//   • Redirects are NEVER followed by the safe transport.
//   • Deliberate local endpoints (local Ollama etc.) are allowed
//     ONLY via the explicit AI_ALLOW_LOCAL_ENDPOINTS=true env
//     setting (default OFF) and only for loopback + RFC1918 —
//     link-local and cloud metadata NEVER pass, with or without
//     the flag.
//
// Pure parsers/range checks are exported for unit tests; no test
// ever needs the network (resolver + transport are injectable).
// ════════════════════════════════════════════════════════════

import { lookup as dnsLookup } from 'node:dns/promises';
import { ApiError } from '@/lib/api-error';

/** Controlled SSRF rejection (Persian, client-safe).
 *  v2.58.4 (user issue 6): extends ApiError so its message is
 *  client-visible through the TYPE-based policy — the class identity,
 *  `name` and `code` are unchanged for instanceof/matchObject tests. */
export class SsrfGuardError extends ApiError {
  readonly code: 'SSRF_URL' | 'SSRF_BLOCKED' | 'SSRF_DNS';
  constructor(code: 'SSRF_URL' | 'SSRF_BLOCKED' | 'SSRF_DNS', message: string) {
    super(502, message);
    this.name = 'SsrfGuardError';
    this.code = code;
  }
}

// ── IPv4 parsing ────────────────────────────────────────────

/** Strict dotted-decimal IPv4 (4 parts, 0-255, no leading zeros) → 32-bit int. */
export function parseIPv4Strict(s: string): number | null {
  const parts = s.trim().split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p.startsWith('0')) return null; // no leading zeros
    const v = Number(p);
    if (v > 255) return null;
    out = (out << 8) | v;
  }
  return out >>> 0;
}

/**
 * inet_aton-loose IPv4 (v2.58.3): the OS resolver accepts weird
 * spellings — '0x7f.0.0.1', '0177.0.0.1', '2130706433' — all of
 * which mean 127.0.0.1. WHATWG URLs keep them as the hostname and
 * node happily connects, so the guard must recognize them BEFORE
 * they reach a socket. 1–4 parts; per part: 0x→hex, leading 0→
 * octal, else decimal; the last part may fill remaining bytes.
 */
export function parseIPv4Loose(s: string): number | null {
  const raw = s.trim().toLowerCase();
  if (!raw) return null;
  if (!/^(\d+|0x[0-9a-f]+)(\.(\d+|0x[0-9a-f]+))*$/.test(raw)) return null;
  const parts = raw.split('.');
  if (parts.length === 1) {
    // single integer/hex form
    const v = parts[0].startsWith('0x') ? parseInt(parts[0].slice(2), 16) : parseInt(parts[0], 10);
    if (!Number.isFinite(v) || v < 0 || v > 0xffffffff) return null;
    return v;
  }
  if (parts.length > 4) return null;
  const vals: number[] = [];
  for (const p of parts) {
    let v: number;
    if (p.startsWith('0x')) v = parseInt(p.slice(2), 16);
    else if (p.length > 1 && p.startsWith('0')) v = parseInt(p.slice(1), 8);
    else v = parseInt(p, 10);
    if (!Number.isFinite(v) || v < 0 || v > 0xffffffff) return null;
    vals.push(v);
  }
  // inet_aton semantics: prefix parts each contribute ONE byte; the LAST
  // part fills all remaining bytes (a.b → 1+3, a.b.c → 2+2, a.b.c.d → 3+1).
  const last = vals[vals.length - 1];
  const remainingBytes = 5 - vals.length; // bytes the last part must fill
  const maxLast = remainingBytes === 1 ? 0xff : remainingBytes === 2 ? 0xffff : remainingBytes === 3 ? 0xffffff : 0xffffffff;
  if (last > maxLast) return null;
  let out = 0;
  for (let i = 0; i < vals.length - 1; i++) out = (out << 8) | vals[i];
  out = (out << (8 * remainingBytes)) | last;
  return out >>> 0;
}

// ── IPv6 parsing ────────────────────────────────────────────

function hex16(s: string): number | null {
  if (!/^[0-9a-f]{1,4}$/.test(s)) return null;
  return parseInt(s, 16);
}

/**
 * Full IPv6 parser (v2.58.3): '::' compression, embedded dotted
 * IPv4 tail (::ffff:192.0.2.1), brackets and zone ids. Returns
 * 16 bytes or null. The classic audit bug — treating link-local
 * as exactly 'fe80' — is impossible here: the RANGE check below
 * matches fe80::/10 (fe80…febf) on the high bits.
 */
export function parseIPv6(input: string): Uint8Array | null {
  let s = input.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!s || !s.includes(':')) return null;

  // embedded IPv4 tail → replace with the two equivalent 16-bit groups
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1) {
    const tail = s.slice(lastColon + 1);
    if (tail.includes('.')) {
      const v4 = parseIPv4Strict(tail);
      if (v4 === null) return null;
      const hi = ((v4 >>> 16) & 0xffff).toString(16);
      const lo = (v4 & 0xffff).toString(16);
      s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
    }
  }

  const dbl = s.indexOf('::');
  const groups: number[] = [];
  if (dbl !== -1) {
    if (s.indexOf('::', dbl + 2) !== -1) return null; // '::' may appear once
    const left = s.slice(0, dbl);
    const right = s.slice(dbl + 2);
    const lg = left ? left.split(':') : [];
    const rg = right ? right.split(':') : [];
    const explicit = lg.length + rg.length;
    if (explicit > 7) return null;
    for (const g of lg) {
      const v = hex16(g);
      if (v === null) return null;
      groups.push(v);
    }
    for (let i = 0; i < 8 - explicit; i++) groups.push(0);
    for (const g of rg) {
      const v = hex16(g);
      if (v === null) return null;
      groups.push(v);
    }
  } else {
    const parts = s.split(':');
    if (parts.length !== 8) return null;
    for (const p of parts) {
      const v = hex16(p);
      if (v === null) return null;
      groups.push(v);
    }
  }
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = groups[i] >>> 8;
    out[i * 2 + 1] = groups[i] & 0xff;
  }
  return out;
}

// ── range checks ────────────────────────────────────────────

interface V4Range { base: number; bits: number; /** never allowed, even with the local exception */ always?: boolean }
// clang-format off
const V4_BLOCKED: V4Range[] = [
  { base: 0x00000000, bits: 8,  always: true },  // 0.0.0.0/8   "this network"
  { base: 0x0A000000, bits: 8 },                 // 10.0.0.0/8      RFC1918
  { base: 0x64400000, bits: 10, always: true },  // 100.64.0.0/10   CGNAT shared
  { base: 0x7F000000, bits: 8 },                 // 127.0.0.0/8     loopback
  { base: 0xA9FE0000, bits: 16, always: true },  // 169.254.0.0/16  link-local + cloud metadata (169.254.169.254)
  { base: 0xAC100000, bits: 12 },                // 172.16.0.0/12   RFC1918
  { base: 0xC0000000, bits: 24, always: true },  // 192.0.0.0/24    IETF assignments
  { base: 0xC0000200, bits: 24, always: true },  // 192.0.2.0/24    TEST-NET-1
  { base: 0xC0586300, bits: 24, always: true },  // 192.88.99.0/24  6to4 relay
  { base: 0xC0A80000, bits: 16 },                // 192.168.0.0/16  RFC1918
  { base: 0xC6120000, bits: 15, always: true },  // 198.18.0.0/15   benchmarking
  { base: 0xC6336400, bits: 24, always: true },  // 198.51.100.0/24 TEST-NET-2
  { base: 0xCB007100, bits: 24, always: true },  // 203.0.113.0/24  TEST-NET-3
  { base: 0xE0000000, bits: 4,  always: true },  // 224.0.0.0/4     multicast
  { base: 0xF0000000, bits: 4,  always: true },  // 240.0.0.0/4     reserved
];
// clang-format on

function ipv4In(ip: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
}

/** Is this IPv4 (32-bit int) blocked? `allowLocal` covers loopback+RFC1918 only. */
export function isBlockedIPv4(ip: number, allowLocal: boolean): boolean {
  for (const r of V4_BLOCKED) {
    if (ipv4In(ip, r.base, r.bits)) {
      if (r.always) return true;
      return !allowLocal;
    }
  }
  return false;
}

/** IPv4 bytes (4) ← from a 16-byte v6 buffer. */
function v6BytesToV4(b: Uint8Array): number {
  return (((b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15]) >>> 0);
}

/**
 * Is this IPv6 (16 bytes) blocked? Handles the embedded-IPv4 forms:
 *   • ::/96 and ::ffff:0:0/96  (IPv4-mapped / v4-compatible)
 *   • 64:ff9b::/96             (NAT64)
 *   • 2002::/16                (6to4 — embedded v4 in bytes 2..5)
 * Link-local is fe80::/10 (fe80…febf) — matched on the high 10
 * bits, NOT the exact 'fe80' hextet. ULA fc00::/7 and AWS's
 * fd00:ec2::/25 metadata range are always blocked.
 */
export function isBlockedIPv6(b: Uint8Array, allowLocal: boolean): boolean {
  // v4-compatible ::/96 and v4-mapped ::ffff:0:0/96: the low 32 bits hold
  // an IPv4 — run the v4 policy on the embedded address. Both forms have
  // bytes 0..9 = 0; bytes 10..11 are 00 00 (compat) or ff ff (mapped).
  let zero80 = true;
  for (let i = 0; i < 10; i++) {
    if (b[i] !== 0) {
      zero80 = false;
      break;
    }
  }
  if (zero80 && (b[10] === 0x00 || b[10] === 0xff) && b[11] === b[10]) {
    const embedded = v6BytesToV4(b);
    if (embedded === 0 && b[10] === 0x00) return true; // :: (unspecified)
    if (embedded === 1 && b[10] === 0x00) return !allowLocal; // ::1 loopback
    // v4-mapped/compat → v4 policy on the embedded address
    return isBlockedIPv4(embedded, allowLocal);
  }

  // NAT64 64:ff9b::/96 — embedded IPv4 in the low 32 bits
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0 && b[8] === 0 && b[9] === 0 && b[10] === 0 && b[11] === 0) {
    return isBlockedIPv4(v6BytesToV4(b), allowLocal);
  }

  // 6to4 2002::/16 — embedded IPv4 in bytes 2..5
  if (b[0] === 0x20 && b[1] === 0x02) {
    const embedded = (((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0);
    if (isBlockedIPv4(embedded, allowLocal)) return true;
  }

  // 100::/64 discard-only
  if (b[0] === 0x01 && b[1] === 0x00 && b[2] === 0 && b[3] === 0 && b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0) return true;

  // Teredo 2001:0000::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;

  // documentation 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;

  // link-local fe80::/10 (1111111010 in the high bits — fe80..febf) — ALWAYS blocked
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;

  // ULA fc00::/7 (incl. AWS metadata fd00:ec2::/25) — ALWAYS blocked
  if ((b[0] & 0xfe) === 0xfc) return true;

  // multicast ff00::/8 — ALWAYS blocked
  if (b[0] === 0xff) return true;

  return false;
}

/**
 * Validate a hostname text as a literal IP (loose v4 forms and full v6,
 * incl. brackets). Returns null when the text is a NAME, or a boolean
 * "blocked" verdict when it is a literal.
 */
export function ipLiteralBlocked(host: string, allowLocal: boolean): boolean | null {
  const h = host.trim().toLowerCase();
  const v4 = parseIPv4Strict(h) ?? parseIPv4Loose(h);
  if (v4 !== null) return isBlockedIPv4(v4, allowLocal);
  const v6 = parseIPv6(h);
  if (v6 !== null) return isBlockedIPv6(v6, allowLocal);
  return null;
}

// ── policy: the explicit local-allow switch (default OFF) ──

/**
 * Deliberate local endpoints (local-only installs with Ollama/vLLM on
 * the same box). EXPLICIT setting only — AI_ALLOW_LOCAL_ENDPOINTS=true.
 * Default OFF: every localhost/private destination is refused. Even
 * when ON, link-local and cloud metadata NEVER pass (always-block
 * ranges above).
 */
export function outboundAllowLocalEndpoints(): boolean {
  return process.env.AI_ALLOW_LOCAL_ENDPOINTS === 'true';
}

export function outboundLocalBlockedHint(): string {
  return 'برای اتصال عمدی به سرویس محلی (نصب Local)، متغیر محیطی AI_ALLOW_LOCAL_ENDPOINTS=true را در فایل .env تنظیم کنید. مقاصد Link-local و Metadata هرگز مجاز نیستند.';
}

// ── target resolution (the entry the transport consumes) ────

export interface SafeOutboundTarget {
  url: URL;
  /** Verified address the transport MUST pin the socket to. */
  address: string;
  family: 4 | 6;
}

export type InjectableResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface SsrfCheckOptions {
  resolver?: InjectableResolver;
  /** Default: outboundAllowLocalEndpoints() (env, explicit, OFF). */
  allowLocalEndpoints?: boolean;
}

/** Default resolver: real DNS, all A/AAAA answers. */
export const defaultDnsResolver: InjectableResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Validate + resolve an outbound destination (fail-closed).
 * Throws SsrfGuardError (Persian, client-safe) on any refusal.
 * The returned `address` is the PINNED IP the caller must connect
 * to (see safe-outbound.ts — Host/SNI/TLS stay on the hostname).
 */
export async function assertSafeOutboundTarget(rawUrl: string, opts: SsrfCheckOptions = {}): Promise<SafeOutboundTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfGuardError('SSRF_URL', 'آدرس سرویس خارجی نامعتبر است.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfGuardError('SSRF_URL', 'آدرس سرویس خارجی باید با http یا https شروع شود.');
  }
  if (url.username || url.password) {
    throw new SsrfGuardError('SSRF_URL', 'آدرس سرویس خارجی نباید شامل اطلاعات کاربری باشد.');
  }
  const allowLocal = opts.allowLocalEndpoints ?? outboundAllowLocalEndpoints();

  const hostname = url.hostname.toLowerCase(); // WHATWG keeps brackets for v6
  const literal = ipLiteralBlocked(hostname, allowLocal);
  if (literal !== null) {
    if (literal) {
      throw new SsrfGuardError(
        'SSRF_BLOCKED',
        `آدرس مقصد (${hostname}) مجاز نیست — شبکهٔ داخلی/محلی/رزروشده است. ${allowLocal ? '' : outboundLocalBlockedHint()}`,
      );
    }
    const v4 = parseIPv4Strict(hostname) ?? parseIPv4Loose(hostname);
    // reconstruct the canonical literal for pinning
    return {
      url,
      address: v4 !== null ? ipv4ToString(v4) : hostname.replace(/^\[|\]$/g, ''),
      family: v4 !== null ? 4 : 6,
    };
  }

  // hostname → resolve + validate EVERY answer (mixed = reject)
  const resolve = opts.resolver ?? defaultDnsResolver;
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await resolve(hostname);
  } catch {
    // fail-closed: unverifiable destination
    throw new SsrfGuardError('SSRF_DNS', 'دامنهٔ سرویس خارجی قابل تأیید نیست (خطای DNS).');
  }
  if (!answers || answers.length === 0) {
    throw new SsrfGuardError('SSRF_DNS', 'دامنهٔ سرویس خارجی قابل تأیید نیست (پاسخ DNS خالی).');
  }
  const bad = answers.find((a) => ipLiteralBlocked(a.address, allowLocal) !== false);
  if (bad) {
    throw new SsrfGuardError(
      'SSRF_BLOCKED',
      `دامنهٔ سرویس به آدرس داخلی/محلی (${bad.address}) اشاره می‌کند — درخواست رد شد.`,
    );
  }
  const first = answers[0];
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}

function ipv4ToString(ip: number): string {
  return `${(ip >>> 24) & 0xff}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}`;
}
