import { describe, it, expect, vi } from 'vitest';

// The client module imports db + logger — stub the db import (never touched
// by the pure functions under test) so the module loads without Prisma.
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/logger', () => ({
  forScope: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

// v2.58.7 (stage 4): hesabfaCall now rides the SSRF-GUARDED transport
// (safeOutboundFetch — DNS pinning, no redirects, private-range block,
// deadline + size cap) instead of a raw global fetch. The network seam
// moves with it: these tests stub the GUARDED door. The semantic
// assertions (envelope unwrap, auth-no-retry, 5xx-retry, paging) are
// byte-identical to the previous contract.
let outboundImpl: ((url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }, opts?: Record<string, unknown>) => Promise<{
  ok: boolean; status: number; statusText: string; headers: Record<string, string>;
  text: () => Promise<string>; json: () => Promise<unknown>; bytes: () => Promise<Uint8Array>; dispose: () => void;
}>) | null = null;
vi.mock('@/lib/safe-outbound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safe-outbound')>();
  return {
    ...actual,
    safeOutboundFetch: vi.fn((url: string, init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string | Uint8Array }, opts?: Record<string, unknown>) =>
      outboundImpl!(url, init as { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }, opts)),
  };
});

import {
  HESABFA_READ_ONLY_PATHS, HesabfaError, hesabfaCall, maskSecret, fetchAllItems,
} from '@/lib/hesabfa-client';
import { isStale, resolveCompanyScope } from '@/lib/hesabfa-sync';

const SETTINGS = { apiKey: 'k', loginToken: 't', baseUrl: 'https://api.hesabfa.com/v1' };

/** Install a canned guarded-transport response (and capture calls). */
function stubOutbound(handler: (url: string, init: { body?: string | Uint8Array }) => { status?: number; body?: string }): { calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  outboundImpl = async (url, init) => {
    calls.push({ url, body: init.body !== undefined ? JSON.parse(String(init.body)) : null });
    const canned = handler(url, init as { body?: string | Uint8Array });
    const text = canned.body ?? '';
    return {
      ok: (canned.status ?? 200) < 400,
      status: canned.status ?? 200,
      statusText: 'stub',
      headers: {},
      text: async () => text,
      json: async () => JSON.parse(text),
      bytes: async () => new Uint8Array(Buffer.from(text)),
      dispose: () => undefined,
    };
  };
  return { calls };
}

function clearOutbound(): void {
  outboundImpl = null;
}

describe('hesabfa-client — structural READ-ONLY guarantee', () => {
  it('whitelists only read paths', () => {
    for (const p of HESABFA_READ_ONLY_PATHS) {
      expect(p).toMatch(/^(item|setting|contact|invoice)\//);
      expect(p.toLowerCase()).not.toMatch(/save|update|delete|create|send/);
    }
  });

  it('REJECTS any write path BEFORE a network call', async () => {
    const { calls } = stubOutbound(() => ({ status: 200, body: '{}' }));
    await expect(hesabfaCall('item/saveItem', SETTINGS)).rejects.toThrow(HesabfaError);
    await expect(hesabfaCall('invoice/deleteInvoice', SETTINGS)).rejects.toThrow('فقط‌خواندنی');
    expect(calls.length).toBe(0);
    clearOutbound();
  });

  it('rejects empty credentials without calling the API', async () => {
    const { calls } = stubOutbound(() => ({ status: 200, body: '{}' }));
    await expect(hesabfaCall('item/getItems', { apiKey: '', loginToken: '', baseUrl: 'x' })).rejects.toThrow();
    expect(calls.length).toBe(0);
    clearOutbound();
  });

  it('unwraps the Hesabfa envelope {Success, ErrorCode, ErrorMessage, Result}', async () => {
    stubOutbound(() => ({ status: 200, body: JSON.stringify({ Success: true, ErrorCode: 0, ErrorMessage: '', Result: [{ Code: 'A1' }] }) }));
    const res = await hesabfaCall<unknown[]>('item/getItems', SETTINGS, {});
    expect(res).toEqual([{ Code: 'A1' }]);
    clearOutbound();
  });

  it('surfaces Hesabfa error messages (auth errors are NOT retried)', async () => {
    let calls = 0;
    stubOutbound(() => {
      calls += 1;
      return { status: 200, body: JSON.stringify({ Success: false, ErrorCode: 11, ErrorMessage: 'Invalid apiKey', Result: null }) };
    });
    await expect(hesabfaCall('setting/getBusinessInfo', SETTINGS)).rejects.toThrow('Invalid apiKey');
    expect(calls).toBe(1); // no retry on auth errors
    clearOutbound();
  });

  it('retries transient 5xx with backoff then succeeds', async () => {
    let calls = 0;
    stubOutbound(() => {
      calls += 1;
      if (calls < 3) return { status: 502, body: 'boom' };
      return { status: 200, body: JSON.stringify({ Success: true, Result: 'ok' }) };
    });
    const res = await hesabfaCall<string>('setting/getBusinessInfo', SETTINGS);
    expect(res).toBe('ok');
    expect(calls).toBe(3);
    clearOutbound();
  });

  it('masks secrets for the client (last 4 visible only)', () => {
    expect(maskSecret('abcdef123456')).toBe('••••••••3456');
    expect(maskSecret('')).toBe('');
    expect(maskSecret('short')).toContain('••••');
  });

  it('paginates item/getItems until a short page (queryInfo skip/take)', async () => {
    const { calls } = stubOutbound(() => {
      const n = calls2.length === 1 ? 100 : 37;
      const Items = Array.from({ length: n }, (_, i) => ({ Code: `P${(calls2.length - 1) * 100 + i + 1}` }));
      return { status: 200, body: JSON.stringify({ Success: true, Result: { Items, Total: 137 } }) };
    });
    // stubOutbound pushes into its own `calls` array — alias it here
    const calls2 = calls;
    const items = await fetchAllItems(SETTINGS);
    expect(items.length).toBe(137);
    expect(calls.length).toBe(2);
    expect((calls[0].body as { queryInfo: { Skip: number; Take: number } }).queryInfo).toEqual({ Skip: 0, Take: 100, Filters: null, OrderBy: '', OrderDesc: false });
    expect((calls[1].body as { queryInfo: { Skip: number } }).queryInfo.Skip).toBe(100);
    clearOutbound();
  });
});

describe('hesabfa-sync — pure helpers', () => {
  it('staleness rule: floor of 60 minutes regardless of a smaller interval', () => {
    const fiftyMinAgo = new Date(Date.now() - 50 * 60 * 1000);
    expect(isStale(fiftyMinAgo, 15)).toBe(false);   // age 50 < max(15,60)=60 → fresh
    expect(isStale(fiftyMinAgo, 120)).toBe(false);  // age 50 < max(120,60)=120 → fresh
  });

  it('staleness rule: interval floors at one hour', () => {
    const twoHAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(isStale(twoHAgo, 15)).toBe(true);   // age 2h > max(15,60)=60 → stale
    expect(isStale(twoHAgo, 240)).toBe(false); // age 2h < max(240,60)=240 → still fresh
    expect(isStale(new Date(), 60)).toBe(false);
    expect(isStale(null, 60)).toBe(true);
  });

  it('resolveCompanyScope: admin without filter sees ALL companies', () => {
    const companies = [{ id: 'c1', slug: 'bazargani' }, { id: 'c2', slug: 'aria' }, { id: 'c3', slug: 'bgl' }];
    expect(resolveCompanyScope('admin', [], null, companies)).toEqual(['c1', 'c2', 'c3']);
  });

  it('resolveCompanyScope: admin with a filter sees ONLY that company', () => {
    const companies = [{ id: 'c1', slug: 'bazargani' }, { id: 'c2', slug: 'aria' }];
    expect(resolveCompanyScope('admin', [], 'aria', companies)).toEqual(['c2']);
  });

  it('resolveCompanyScope: regular user = intersection with own companies', () => {
    const companies = [{ id: 'c1', slug: 'bazargani' }, { id: 'c2', slug: 'aria' }, { id: 'c3', slug: 'bgl' }];
    expect(resolveCompanyScope('standard', ['aria'], null, companies)).toEqual(['c2']);
    expect(resolveCompanyScope('standard', ['aria', 'bgl'], null, companies)).toEqual(['c2', 'c3']);
  });

  it('resolveCompanyScope: unauthorized slug → EMPTY (IDOR-safe)', () => {
    const companies = [{ id: 'c1', slug: 'bazargani' }, { id: 'c2', slug: 'aria' }];
    expect(resolveCompanyScope('standard', ['aria'], 'bazargani', companies)).toEqual([]);
  });

  it('resolveCompanyScope: invalid slug is ignored, not an error', () => {
    const companies = [{ id: 'c1', slug: 'bazargani' }];
    expect(resolveCompanyScope('admin', [], 'nope', companies)).toEqual([]);
  });
});
