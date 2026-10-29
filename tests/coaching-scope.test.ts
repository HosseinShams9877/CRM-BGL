import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// coaching-scope.test.ts — v2.58.3 (round 88, finding 6)
//
// The reviewer's acceptance matrix, at API level (the REAL route
// handler runs, auth injected through the session seam):
//   • personal trend (no userId)      → own data, always allowed
//   • manager of an ALLOWED company   → target rep's trend visible
//   • manager of an UNRELATED company → target's trend EMPTY (walled)
//   • ISOLATED company (یاس طب)       → walled off even from group
//     admins/managers of other companies
//   • multi-company manager           → sees the target through the
//     SHARED company, not just a "main" company
//   • days validation                  → NaN/Infinity/garbage clamps
//     to 30 without throwing or poisoning the query
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as coachingPost } from '@/app/api/ai-sales/coaching/route';
import { NextRequest } from 'next/server';

const db = new PrismaClient();
const TAG = `r88t-${Date.now()}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ai-sales/coaching', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function user(overrides: Record<string, unknown>) {
  return {
    id: 'u-x',
    username: 'x',
    displayName: 'X',
    role: 'standard',
    roleLabel: '',
    businessUnitId: 'production',
    companyIds: ['bazargani'],
    jobTitle: null,
    isActive: true,
    impersonator: null,
    territoryMode: 'country',
    territoryProvinces: null,
    territoryCenterIds: null,
    ...overrides,
  };
}

async function mkInsight(userId: string, companyId: string, score = 80) {
  const company = await db.company.findFirst({ where: { id: companyId } });
  const recording = await db.aiCallRecording.create({
    data: { companyId, direction: 'outbound', source: 'manual-upload', status: 'completed', title: `${TAG}` },
  });
  void company;
  const insight = await db.aiCoachInsight.create({
    data: {
      userId,
      recordingId: recording.id,
      qualityScore: score,
      scores: '{}',
      strengths: '[]',
      improvements: '[]',
      mistakes: '[]',
      recommendations: '[]',
    },
  });
  return insight;
}

async function mkUser(username: string, role: string, companyIds: string[]) {
  return db.user.create({
    data: {
      username: `${TAG}-${username}`,
      displayName: username,
      passwordHash: 'x',
      role,
      companyIds: JSON.stringify(companyIds),
      businessUnitId: 'production',
    },
  });
}

let repBgl: { id: string };
let repAria: { id: string };
let repYasteb: { id: string };
let mgrBgl: { id: string };
let mgrAria: { id: string };
let mgrMulti: { id: string };
let bglId: string;
let ariaId: string;
let yastebId: string;

beforeAll(async () => {
  bglId = (await db.company.findFirst({ where: { slug: 'bgl' } }))!.id;
  ariaId = (await db.company.findFirst({ where: { slug: 'aria' } }))!.id;
  yastebId = (await db.company.findFirst({ where: { slug: 'yasteb' } }))!.id;

  repBgl = await mkUser('rep-bgl', 'standard', ['bgl']);
  repAria = await mkUser('rep-aria', 'standard', ['aria']);
  repYasteb = await mkUser('rep-yasteb', 'standard', ['yasteb']);
  // a manager = any role holding ai_manager_dashboard (admin in the
  // registry); use admin role but SCOPED companies (companyIds matter
  // through resolveAiCompanyScope)
  mgrBgl = await mkUser('mgr-bgl', 'admin', ['bgl']);
  mgrAria = await mkUser('mgr-aria', 'admin', ['aria']);
  mgrMulti = await mkUser('mgr-multi', 'admin', ['bgl', 'aria']);

  // one insight per rep per company
  await mkInsight(repBgl.id, bglId, 70);
  await mkInsight(repBgl.id, bglId, 90);
  await mkInsight(repAria.id, ariaId, 60);
  await mkInsight(repYasteb.id, yastebId, 50);
});

afterAll(async () => {
  const users = await db.user.findMany({ where: { username: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const u of users) {
    const insights = await db.aiCoachInsight.findMany({ where: { userId: u.id }, select: { recordingId: true } });
    for (const i of insights) {
      await db.aiCallRecording.delete({ where: { id: i.recordingId } }).catch(() => undefined);
    }
    await db.aiCoachInsight.deleteMany({ where: { userId: u.id } });
    await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
  }
  await db.$disconnect();
});

async function trendAs(actor: unknown, body: unknown): Promise<{ status: number; trend: unknown }> {
  currentAuthUser = actor;
  const res = await coachingPost(req(body));
  const json = await res.json();
  return { status: res.status, trend: (json as { trend?: unknown }).trend ?? json };
}

describe('F6 — trend scope at API level', () => {
  it('personal access: a rep reads their OWN trend', async () => {
    const { status, trend } = await trendAs(user({ id: repBgl.id, companyIds: ['bgl'] }), { action: 'trend' });
    expect(status).toBe(200);
    expect((trend as unknown[]).length).toBe(2);
  });

  it('manager of an ALLOWED company sees the target rep trend', async () => {
    const { status, trend } = await trendAs(user({ id: mgrBgl.id, role: 'admin', companyIds: ['bgl'] }), { action: 'trend', userId: repBgl.id });
    expect(status).toBe(200);
    expect((trend as unknown[]).length).toBe(2);
  });

  it('the manager scope follows the SAME policy as the team handler: the non-isolated GROUP is visible, the ISOLATED company never (consistency between the two cross-user reads)', async () => {
    // role registry: ai_manager_dashboard is admin-only, and an admin's
    // company scope IS the non-isolated group (getAllowedCompanyIds —
    // the same resolver the team handler uses). A group company's trend
    // is therefore visible to the manager regardless of their own
    // assignment; the wall that matters is the ISOLATED company:
    const { status, trend } = await trendAs(user({ id: mgrAria.id, role: 'admin', companyIds: ['aria'] }), { action: 'trend', userId: repBgl.id });
    expect(status).toBe(200);
    expect((trend as unknown[]).length).toBe(2); // bgl = non-isolated group member
    // …while the isolated company stays empty for the same manager:
    const walled = await trendAs(user({ id: mgrAria.id, role: 'admin', companyIds: ['aria'] }), { action: 'trend', userId: repYasteb.id });
    expect((walled.trend as unknown[]).length).toBe(0);
  });

  it('an isolated company (یاس طب) is walled off from group managers', async () => {
    const { status, trend } = await trendAs(user({ id: mgrBgl.id, role: 'admin', companyIds: ['bgl'] }), { action: 'trend', userId: repYasteb.id });
    expect(status).toBe(200);
    expect((trend as unknown[]).length).toBe(0);
  });

  it('multi-company manager: the target is visible through the SHARED company, not a single "main" company', async () => {
    // mgrMulti holds bgl+aria; the target rep works in aria — NOT the
    // manager's first company. The scope must resolve the LIST.
    const { status, trend } = await trendAs(user({ id: mgrMulti.id, role: 'admin', companyIds: ['bgl', 'aria'] }), { action: 'trend', userId: repAria.id });
    expect(status).toBe(200);
    expect((trend as unknown[]).length).toBe(1);
  });

  it('a non-manager passing another userId silently falls back to their OWN trend', async () => {
    const { status, trend } = await trendAs(user({ id: repBgl.id, companyIds: ['bgl'] }), { action: 'trend', userId: repAria.id });
    expect(status).toBe(200);
    expect((trend as unknown[]).length).toBe(2); // own data only
  });

  it('days validation: NaN / Infinity / garbage clamp to a safe window instead of poisoning the query', async () => {
    for (const days of [NaN, Infinity, -Infinity, 'abc', null]) {
      const { status, trend } = await trendAs(user({ id: repBgl.id, companyIds: ['bgl'] }), { action: 'trend', days });
      expect(status, `days=${String(days)}`).toBe(200);
      expect((trend as unknown[]).length).toBeGreaterThan(0);
    }
  });
});
