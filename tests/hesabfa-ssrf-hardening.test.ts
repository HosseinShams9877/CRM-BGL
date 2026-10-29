import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// hesabfa-ssrf-hardening.test.ts — v2.58.7 (stage 4 — S1 + S2)
//
// THE REGRESSION (confirmed on the pre-fix v2.58.6 code): the entire
// Hesabfa integration called a RAW fetch() on the stored baseUrl —
// no SSRF guard, and Node's fetch FOLLOWS REDIRECTS. connection-set
// accepted ANY string as baseUrl with no URL validation. A crafted
// baseUrl sent apiKey/loginToken (in the POST body) to an attacker
// host or an internal address.
//
// THE CONTRACT:
//   • S1: hesabfaCall rides the guarded transport — a literal private/
//     link-local/metadata target is refused BEFORE any connection,
//     mapped to a NON-retryable HesabfaError with the guard's
//     client-safe Persian message
//   • S2: connection-set validates the URL shape (http/https only,
//     parseable, bounded length) at STORE time
// (Redirect/DNS-rebinding/rebinding-pinning semantics of the guarded
//  transport itself are covered by tests/ssrf-guard.test.ts.)
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

// The transport is the REAL guarded one here — the whole point is that
// the guard refuses the private targets BEFORE any network I/O (the
// literal-IP blocklist runs at check time, not connect time).
import { hesabfaCall, HesabfaError } from '@/lib/hesabfa-client';
import { POST as hesabfaPost } from '@/app/api/hesabfa/route';

const db = new PrismaClient();
const TAG = `r97hf-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/hesabfa', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function asUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
  currentAuthUser = user;
  return fn();
}

interface TestUser {
  id: string; username: string; displayName: string; role: string; roleLabel: string;
  businessUnitId: string; companyIds: string[]; jobTitle: string | null; isActive: boolean;
  impersonator: null; territoryMode: string; territoryProvinces: string | null; territoryCenterIds: string | null;
}

let adminUser: TestUser;

beforeAll(async () => {
  const u = await db.user.create({
    data: {
      username: `${TAG}-admin`, displayName: 'hf admin', passwordHash: 'x', role: 'admin',
      companyIds: JSON.stringify([]), businessUnitId: 'trading',
    },
  });
  adminUser = {
    id: u.id, username: u.username, displayName: u.displayName, role: 'admin', roleLabel: '',
    businessUnitId: 'trading', companyIds: [], jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]',
  };
});

afterAll(async () => {
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

describe('S1 — hesabfaCall refuses private targets through the guarded transport', () => {
  const PRIVATE_BASES = [
    'http://127.0.0.1:9999',
    'http://10.0.0.5:8080',
    'http://172.16.0.1',
    'http://192.168.1.10',
    'http://169.254.169.254/latest/meta-data', // the cloud-metadata endpoint
    'http://[::1]:8080',
    'http://[fe80::1]/',
    'http://[fc00::5]/',
    'http://[::ffff:127.0.0.1]/', // IPv4-mapped IPv6
    'http://0x7f.0.0.1/', // hex-encoded 127.0.0.1
  ];

  it.each(PRIVATE_BASES)('%s → NON-retryable HesabfaError, guard-refused, NO connection', async (baseUrl: string) => {
    const settings = { apiKey: 'k', loginToken: 't', baseUrl };
    let err: unknown;
    try {
      await hesabfaCall('setting/getBusinessInfo', settings);
      expect.fail('expected a refusal');
    } catch (e) {
      err = e;
    }
    // mapped to a HesabfaError that will NOT be retried 3× with delays
    expect(err).toBeInstanceOf(HesabfaError);
    const hfErr = err as HesabfaError;
    expect(hfErr.retryable).toBe(false);
    expect(hfErr.message.length).toBeGreaterThan(0);
  });

  it('the legit default endpoint shape is NOT refused at the URL stage (parse/protocol level)', async () => {
    // The guard's URL-level checks (protocol, credentials, shape) pass for
    // the default Hesabfa host; DNS/connect is not attempted here — the
    // point is that connection-set and the client accept the LEGITIMATE
    // shape while every private literal above is refused.
    const settings = { apiKey: 'k', loginToken: 't', baseUrl: 'https://api.hesabfa.com/v1' };
    let err: unknown = null;
    try {
      await hesabfaCall('setting/getBusinessInfo', settings);
    } catch (e) {
      err = e; // a network/DNS failure is EXPECTED in the sandbox — NOT a guard refusal
    }
    if (err instanceof HesabfaError) {
      // a guard refusal would be non-retryable with the guard's message;
      // a DNS/network failure in the sandbox is retryable with the network
      // message — assert we did not get the SSRF refusal for the legit host
      expect((err as HesabfaError).message).not.toContain('مجاز');
    }
  });
});

describe('S2 — connection-set validates the baseUrl at store time', () => {
  it.each([
    ['javascript:alert(1)'],
    ['not a url at all'],
    ['ftp://files.example.com'],
    ['file:///etc/passwd'],
  ])('REJECTS «%s» with a 400 — nothing stored', async (baseUrl) => {
    const res = await asUser(adminUser, () =>
      hesabfaPost(req({ action: 'connection-set', companySlug: 'bazargani', apiKey: `${TAG}-key`, loginToken: `${TAG}-tok`, baseUrl })));
    expect(res.status).toBe(400);
    const conn = await db.hesabfaConnection.findFirst({ where: { apiKey: `${TAG}-key` } });
    expect(conn).toBeNull();
  });

  it('ACCEPTS the legitimate https endpoint and stores it', async () => {
    const res = await asUser(adminUser, () =>
      hesabfaPost(req({ action: 'connection-set', companySlug: 'bazargani', apiKey: `${TAG}-key2`, loginToken: `${TAG}-tok2`, baseUrl: 'https://api.hesabfa.com/v1' })));
    expect(res.status).toBe(200);
    const conn = await db.hesabfaConnection.findFirst({ where: { apiKey: `${TAG}-key2` } });
    expect(conn?.baseUrl).toBe('https://api.hesabfa.com/v1');
    // cleanup
    await db.hesabfaConnection.delete({ where: { companyId: conn!.companyId } });
  });
});
