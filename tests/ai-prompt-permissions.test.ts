import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// ai-prompt-permissions.test.ts — v2.58.4 (user issue 2: AI
// bridge global-prompt management permissions).
//
// THE REGRESSION (confirmed on the pre-fix code): the `prompts`,
// `save-prompt` and `delete-prompt` actions had NO permission gate
// at all — ANY authenticated user could list, overwrite and delete
// the GLOBAL prompt templates everyone else chats with (prompt
// poisoning), and the title/content had no length caps (a multi-MB
// body could be stored in the Meta row).
//
// THE CONTRACT (v2.58.4):
//   • global prompt list/create/update/delete require the dedicated
//     `ai_prompt_manage` permission (admin holds it; standard,
//     finance and production do not);
//   • prompt title ≤ 200 chars, content ≤ 20 000 chars;
//   • empty title/content still rejected (existing behavior kept);
//   • the prompts response never carries provider/secret settings.
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as aiPost } from '@/app/api/ai-bridge/route';
import { getRolePermissions } from '@/lib/auth';

const db = new PrismaClient();
const TAG = `r90pr-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ai-bridge', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function asUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
  currentAuthUser = user;
  return fn();
}

async function jsonOf(res: unknown): Promise<Record<string, unknown>> {
  return (await (res as { json: () => Promise<unknown> }).json()) as Record<string, unknown>;
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

let stdUser: Awaited<ReturnType<typeof mkUser>>;
let adminUser: Awaited<ReturnType<typeof mkUser>>;
let finUser: Awaited<ReturnType<typeof mkUser>>;
// the route keeps ids that already carry the canonical prefix verbatim
const PROMPT_KEY = `ai_bridge.prompt_${TAG}-demo`;

beforeAll(async () => {
  stdUser = await mkUser('std', 'standard');
  adminUser = await mkUser('adm', 'admin');
  finUser = await mkUser('fin', 'finance');
});

afterAll(async () => {
  await db.meta.deleteMany({ where: { key: { startsWith: `ai_bridge.prompt_${TAG}` } } });
  await db.meta.deleteMany({ where: { key: { startsWith: `${TAG}.` } } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

describe('issue 2 — the ai_prompt_manage permission exists and is admin-held', () => {
  it('admin has ai_prompt_manage; standard/finance/production do not', () => {
    expect(getRolePermissions('admin').ai_prompt_manage).toBe(true);
    expect(getRolePermissions('standard').ai_prompt_manage).toBe(false);
    expect(getRolePermissions('finance').ai_prompt_manage).toBe(false);
    expect(getRolePermissions('production').ai_prompt_manage).toBe(false);
  });
});

describe('issue 2 — prompt management is gated (MANDATORY matrix)', () => {
  it('MANDATORY: a standard user listing prompts → 403', async () => {
    const res = await asUser(stdUser, () => aiPost(req({ action: 'prompts' })));
    expect(res.status).toBe(403);
  });

  it('MANDATORY: a standard user saving a prompt → 403 (nothing stored)', async () => {
    const res = await asUser(stdUser, () =>
      aiPost(req({ action: 'save-prompt', id: PROMPT_KEY, title: 'x', content: 'y' })));
    expect(res.status).toBe(403);
    expect(await db.meta.count({ where: { key: PROMPT_KEY } })).toBe(0);
  });

  it('MANDATORY: a standard user deleting a prompt → 403 (row survives)', async () => {
    await db.meta.create({
      data: { key: PROMPT_KEY, value: JSON.stringify({ title: 't', content: 'c' }) },
    });
    const res = await asUser(stdUser, () => aiPost(req({ action: 'delete-prompt', id: PROMPT_KEY })));
    expect(res.status).toBe(403);
    expect(await db.meta.count({ where: { key: PROMPT_KEY } })).toBe(1);
    await db.meta.deleteMany({ where: { key: PROMPT_KEY } });
  });

  it('finance (no ai_prompt_manage) → 403 too', async () => {
    const res = await asUser(finUser, () => aiPost(req({ action: 'prompts' })));
    expect(res.status).toBe(403);
  });

  it('MANDATORY: admin lists prompts → 200', async () => {
    const res = await asUser(adminUser, () => aiPost(req({ action: 'prompts' })));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(Array.isArray(body.prompts)).toBe(true);
    // the prompt list must never carry provider/secret settings
    expect(JSON.stringify(body)).not.toContain('api_key');
    expect(JSON.stringify(body)).not.toContain('api_url');
  });

  it('admin saves a prompt → 200 + persisted; admin deletes it → 200 + gone', async () => {
    const save = await asUser(adminUser, () =>
      aiPost(req({ action: 'save-prompt', id: PROMPT_KEY, title: 'عنوان', content: 'محتوا' })));
    expect(save.status).toBe(200);
    const row = await db.meta.findUnique({ where: { key: PROMPT_KEY } });
    expect(row).not.toBeNull();

    const del = await asUser(adminUser, () => aiPost(req({ action: 'delete-prompt', id: PROMPT_KEY })));
    expect(del.status).toBe(200);
    expect(await db.meta.count({ where: { key: PROMPT_KEY } })).toBe(0);
  });
});

describe('issue 2 — prompt shape limits', () => {
  it('an over-long title ( > 200 chars ) → 400', async () => {
    const res = await asUser(adminUser, () =>
      aiPost(req({ action: 'save-prompt', title: 'ط'.repeat(201), content: 'c' })));
    expect(res.status).toBe(400);
  });

  it('an over-long content ( > 20 000 chars ) → 400 (nothing stored)', async () => {
    const res = await asUser(adminUser, () =>
      aiPost(req({ action: 'save-prompt', title: 't', content: 'م'.repeat(20_001) })));
    expect(res.status).toBe(400);
    const metas = await db.meta.findMany({ where: { key: { startsWith: 'ai_bridge.prompt_' } } });
    for (const m of metas) {
      expect(m.value.length).toBeLessThan(20_500);
    }
  });

  it('empty title / empty content still → 400', async () => {
    const r1 = await asUser(adminUser, () => aiPost(req({ action: 'save-prompt', title: '   ', content: 'c' })));
    expect(r1.status).toBe(400);
    const r2 = await asUser(adminUser, () => aiPost(req({ action: 'save-prompt', title: 't', content: '  ' })));
    expect(r2.status).toBe(400);
  });
});
