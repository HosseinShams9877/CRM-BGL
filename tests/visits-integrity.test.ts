import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// visits-integrity.test.ts — v2.58.4 (user issue 3: visits data
// destruction protection).
//
// THE REGRESSION (confirmed on the pre-fix code): the visits blob
// lives in ONE Meta row. When its JSON was corrupted, BOTH the read
// helper AND the mutation loop silently treated it as `[]` — and the
// mutation then WROTE `[]` back: one "successful" update/create/
// delete destroyed EVERY visit in the system (zero-deletion
// guarantee violated; a controlled error was never raised).
//
// THE CONTRACT (v2.58.4):
//   • a corrupt (unparseable / non-array) visits blob ABORTS every
//     mutation with a controlled Persian error — NOTHING is written;
//   • the original (corrupt) value is preserved BYTE-IDENTICALLY so
//     an admin can repair it from the backup;
//   • the failure is logged server-side with a REQUEST ID;
//   • reads (list/stats) degrade to an empty view but never write;
//   • a VALID blob still mutates normally (the guard is about
//     corruption, not about locking the route).
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as visitsPost } from '@/app/api/visits/route';

const db = new PrismaClient();
const TAG = `r90vis-${Date.now().toString(36)}`;
const KEY = 'visits_data';

const CORRUPT = '{"corrupted": [';                    // unparseable JSON
const CORRUPT_NON_ARRAY = '{"rows": 12, "note": "خ"}';  // parses, NOT an array

let adminUser: Awaited<ReturnType<typeof mkUser>>;
let centerId: string;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/visits', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function mkUser(username: string, role: string) {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`,
      displayName: username,
      passwordHash: 'x',
      role,
      companyIds: JSON.stringify(['bgl']),
      businessUnitId: 'trading',
      roleLabel: '',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'trading', companyIds: ['bgl'], jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: null, territoryCenterIds: null,
  };
}

async function jsonOf(res: unknown): Promise<Record<string, unknown>> {
  return (await (res as { json: () => Promise<unknown> }).json()) as Record<string, unknown>;
}

async function currentBlob(): Promise<string | null> {
  const row = await db.meta.findUnique({ where: { key: KEY } });
  return row?.value ?? null;
}

async function setBlob(value: string) {
  await db.meta.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
}

async function clearBlob() {
  await db.meta.deleteMany({ where: { key: KEY } });
}

beforeAll(async () => {
  adminUser = await mkUser('adm', 'admin');
  currentAuthUser = adminUser;
  const company = await db.company.findFirstOrThrow({ where: { slug: 'bgl' } });
  const center = await db.center.create({
    data: { name: `${TAG}-center`, customerType: 'b2b', companyId: company.id, province: 'تهران', businessUnitId: 'trading' },
  });
  centerId = center.id;
});

afterAll(async () => {
  await clearBlob();
  await db.center.deleteMany({ where: { name: `${TAG}-center` } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

describe('issue 3 — a corrupt visits blob never destroys data', () => {
  // labels only — the bodies are built INSIDE each test, after beforeAll
  // has created the center (centerId is module-scope and assigned late).
  const mutationLabels: Array<[string, 'create' | 'update' | 'delete']> = [
    ['create', 'create'],
    ['update', 'update'],
    ['delete', 'delete'],
  ];

  function mutationBody(kind: 'create' | 'update' | 'delete'): Record<string, unknown> {
    if (kind === 'create') return { action: 'create', centerId, date: '1403-01-01', purpose: 'p' };
    if (kind === 'update') return { action: 'update', id: 'whatever', purpose: 'p2' };
    return { action: 'delete', id: 'whatever' };
  }

  it.each(mutationLabels)('corrupt JSON: %s is REFUSED (controlled 409 CONFLICT — v2.58.7) and the original blob survives byte-identically', async (_label, kind) => {
    await setBlob(CORRUPT);
    const res = await visitsPost(req(mutationBody(kind)));
    // v2.58.7 (stage 5): 409 CONFLICT — the user's mandatory test matrix
    // («Visit خراب * Update * نتیجه: 409»). Still a CONTROLLED error: a
    // clean JSON body with a Persian message, not a crash, and NOTHING
    // is written.
    expect(res.status).toBe(409);
    const payload = await jsonOf(res);
    expect(String(payload.error)).toContain('بازدید');
    expect(String(payload.error)).not.toContain('/'); // no paths leak
    // ZERO data destruction: the corrupt original is preserved EXACTLY
    expect(await currentBlob()).toBe(CORRUPT);
  });

  it.each(mutationLabels)('valid-JSON-but-NOT-an-array: %s is REFUSED (409), original preserved', async (_label, kind) => {
    await setBlob(CORRUPT_NON_ARRAY);
    const res = await visitsPost(req(mutationBody(kind)));
    expect(res.status).toBe(409);
    expect(await currentBlob()).toBe(CORRUPT_NON_ARRAY);
  });

  it('v2.58.7 (stage 5): reads NEVER degrade a corrupt blob to a silent empty list — a controlled 409 surfaces the corruption', async () => {
    await setBlob(CORRUPT);
    const list = await visitsPost(req({ action: 'list' }));
    // the pre-fix behavior returned 200 + [] — masking the corruption
    // (the user kept working; the next VALID mutation was the one that
    // finally overwrote the only copy). Reads now fail closed with the
    // SAME controlled error as mutations.
    expect(list.status).toBe(409);
    expect(String((await jsonOf(list)).error)).toContain('بازدید');
    const stats = await visitsPost(req({ action: 'stats' }));
    expect(stats.status).toBe(409);
    // the read path still NEVER writes
    expect(await currentBlob()).toBe(CORRUPT);
  });

  it('v2.58.7 (stage 5): valid-JSON-non-array reads fail closed too (logged, preserved)', async () => {
    await setBlob(CORRUPT_NON_ARRAY);
    const list = await visitsPost(req({ action: 'list' }));
    expect(list.status).toBe(409);
    expect(await currentBlob()).toBe(CORRUPT_NON_ARRAY);
  });
});

describe('issue 3 — a VALID blob still mutates normally (guard is corruption-only)', () => {
  beforeEach(async () => {
    await clearBlob();
  });

  it('create works on a healthy (missing) blob', async () => {
    const res = await visitsPost(req({ action: 'create', centerId, date: '1403-01-02', purpose: 'p' }));
    expect(res.status).toBe(201);
    const blob = await currentBlob();
    expect(blob).not.toBeNull();
    const parsed = JSON.parse(blob!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it('create + update + delete work on a healthy blob', async () => {
    await setBlob(JSON.stringify([
      { id: 'v1', centerId, centerName: '', date: '1403-01-01', time: '', purpose: 'p', result: '', nextAction: '', assignedTo: adminUser.id, assignedToName: 'a', status: 'planned', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]));
    const upd = await visitsPost(req({ action: 'update', id: 'v1', purpose: 'p2' }));
    expect(upd.status).toBe(200);
    const del = await visitsPost(req({ action: 'delete', id: 'v1' }));
    expect(del.status).toBe(200);
    expect(JSON.parse((await currentBlob())!)).toEqual([]);
  });
});
