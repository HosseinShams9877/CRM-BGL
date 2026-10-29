import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// ai-sales-access-policy.test.ts — v2.58.11 (independent audit
// 2.58.10, P1-1 + P1-2 — reproduced RED on the shipped 2.58.10)
//
// P1-1 — THE AI SALES TERRITORY/BU/OWNERSHIP GAP:
// the auditor's live probe: a STANDARD user of the RIGHT company but
// OUTSIDE the center's province read the AI customer memory with 200.
// Every AI Sales route funneled through company-only helpers
// (centerInCompanyScope / canAccessRecording / resolveAiCompanyScope)
// — none of them enforced Territory, Business Unit or ownership.
//
// P1-2 — THE INACTIVE-COMPANY BYPASS:
// a user assigned to a DEACTIVATED company kept full read/write: the
// non-admin company resolution never checked Company.isActive (the
// admin branch already resolved to ACTIVE non-isolated companies).
//
// THE CONTRACT (pinned here, at REAL-ROUTE level):
//   • memory get/update, brief, calls create-manual, single recording
//     reads (get/transcript/analyze/retry/delete/audio) and next-action
//     operations enforce Company + Business Unit + Territory + active
//     company SIMULTANEOUSLY — an out-of-scope center answers 404
//     (fail-closed, no existence leak — the centers-route convention);
//   • centerless recordings/actions of OTHER users are invisible to
//     territory-restricted experts (ownership dimension);
//   • an INACTIVE company drops out of the user's allowed set on
//     every read/write; the ADMIN explicit-slug exception stays
//     documented and tested;
//   • positive controls: in-territory expert, country-mode expert and
//     admin keep their access — no over-blocking regression.
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as memoryPost } from '@/app/api/ai-sales/memory/route';
import { POST as briefPost } from '@/app/api/ai-sales/brief/route';
import { POST as callsPost } from '@/app/api/ai-sales/calls/route';
import { POST as actionsPost } from '@/app/api/ai-sales/actions/route';
import {
  getAllowedCompanyIds,
  assertCanAccessCompanySlug,
  resolveScopedCompanyId,
} from '@/lib/company-scope';

const db = new PrismaClient();
const TAG = `r9111-${Date.now().toString(36)}`;

function req(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) });
}

interface TestUser {
  id: string; username: string; displayName: string; role: string; roleLabel: string;
  businessUnitId: string; companyIds: string[]; jobTitle: string | null; isActive: boolean;
  impersonator: null; territoryMode: string; territoryProvinces: string | null; territoryCenterIds: string | null;
}

function user(overrides: Partial<TestUser>): TestUser {
  return {
    id: 'u-anonymous', username: 'anon', displayName: 'Anon', role: 'standard', roleLabel: '',
    businessUnitId: 'production', companyIds: ['bgl'], jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: null, territoryCenterIds: null,
    ...overrides,
  };
}

async function asUser<T>(u: unknown, fn: () => Promise<T>): Promise<T> {
  currentAuthUser = u;
  try { return await fn(); } finally { currentAuthUser = null; }
}

// ── fixtures ────────────────────────────────────────────────
let companyBgl: { id: string; slug: string };
let companyAria: { id: string; slug: string };
let companyYasteb: { id: string; slug: string };
let centerIn: string;   // bgl, تهران (in territory)
let centerOut: string;  // bgl, فارس (outside territory)
let centerAriaTehran: string;
let centerYasteb: string;
let repTehran: TestUser;   // standard, bgl, provinces=[تهران]
let repCountry: TestUser;  // standard, bgl, country
let adminUser: TestUser;
let repYasteb: TestUser;

beforeAll(async () => {
  companyBgl = (await db.company.findFirstOrThrow({ where: { slug: 'bgl' }, select: { id: true, slug: true } }))!;
  companyAria = (await db.company.findFirstOrThrow({ where: { slug: 'aria' }, select: { id: true, slug: true } }))!;
  companyYasteb = (await db.company.findFirstOrThrow({ where: { slug: 'yasteb' }, select: { id: true, slug: true } }))!;

  centerIn = (await db.center.create({
    data: { name: `${TAG}-center-in`, companyId: companyBgl.id, province: 'تهران', businessUnitId: 'production' },
  })).id;
  centerOut = (await db.center.create({
    data: { name: `${TAG}-center-out`, companyId: companyBgl.id, province: 'فارس', businessUnitId: 'production' },
  })).id;
  centerAriaTehran = (await db.center.create({
    data: { name: `${TAG}-center-aria`, companyId: companyAria.id, province: 'تهران', businessUnitId: 'production' },
  })).id;
  centerYasteb = (await db.center.create({
    data: { name: `${TAG}-center-yasteb`, companyId: companyYasteb.id, province: 'تهران', businessUnitId: 'production' },
  })).id;

  const mkDbUser = async (suffix: string, role: string, slugs: string[]) => {
    const row = await db.user.create({
      data: {
        username: `${TAG}-${suffix}`, displayName: suffix, passwordHash: 'x', role,
        companyIds: JSON.stringify(slugs), businessUnitId: 'production', isActive: true,
        territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]',
      },
    });
    return row;
  };
  const dbTehran = await mkDbUser('tehran', 'standard', ['bgl']);
  const dbCountry = await mkDbUser('country', 'standard', ['bgl']);
  const dbAdmin = await mkDbUser('admin', 'admin', ['bgl']);
  const dbYasteb = await mkDbUser('yasteb', 'standard', ['yasteb']);

  repTehran = user({
    id: dbTehran.id, username: dbTehran.username, displayName: dbTehran.displayName,
    companyIds: ['bgl'], territoryMode: 'provinces', territoryProvinces: JSON.stringify(['تهران']),
  });
  repCountry = user({ id: dbCountry.id, username: dbCountry.username, displayName: dbCountry.displayName });
  adminUser = user({ id: dbAdmin.id, username: dbAdmin.username, displayName: dbAdmin.displayName, role: 'admin' });
  repYasteb = user({ id: dbYasteb.id, username: dbYasteb.username, displayName: dbYasteb.displayName, companyIds: ['yasteb'] });
});

afterAll(async () => {
  await db.aiCustomerMemory.deleteMany({ where: { centerId: { in: [centerIn, centerOut, centerAriaTehran, centerYasteb] } } });
  await db.aiCallRecording.deleteMany({ where: { title: { startsWith: TAG } } });
  await db.aiNextAction.deleteMany({ where: { title: { startsWith: TAG } } });
  await db.center.deleteMany({ where: { id: { in: [centerIn, centerOut, centerAriaTehran, centerYasteb] } } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.company.update({ where: { id: companyYasteb.id }, data: { isActive: true } }).catch(() => undefined);
  await db.$disconnect();
});

// ── P1-1: memory route (the auditor's exact probe) ──────────
describe('P1-1 — AI memory: company alone is NOT the policy', () => {
  it('RED→GREEN: a standard user of the right company but OUTSIDE the center province gets 404, not 200', async () => {
    const res = await asUser(repTehran, () =>
      memoryPost(req('/api/ai-sales/memory', { action: 'get', centerId: centerOut })));
    expect(res.status).toBe(404);
  });

  it('the manual memory WRITE is denied the same way (update on an out-of-territory center)', async () => {
    const res = await asUser(repTehran, () =>
      memoryPost(req('/api/ai-sales/memory', { action: 'update', centerId: centerOut, summary: 'x' })));
    expect(res.status).toBe(404);
    expect(await db.aiCustomerMemory.count({ where: { centerId: centerOut } })).toBe(0);
  });

  it('positive control: the same user INSIDE their territory reads and writes the memory', async () => {
    const get = await asUser(repTehran, () =>
      memoryPost(req('/api/ai-sales/memory', { action: 'get', centerId: centerIn })));
    expect(get.status).toBe(200);
    const upd = await asUser(repTehran, () =>
      memoryPost(req('/api/ai-sales/memory', { action: 'update', centerId: centerIn, summary: `${TAG} ok` })));
    expect(upd.status).toBe(200);
  });

  it('business unit is part of the policy: a center of another BU answers 404 (centers-route parity)', async () => {
    const otherBuCenter = await db.center.create({
      data: { name: `${TAG}-center-bu`, companyId: companyBgl.id, province: 'تهران', businessUnitId: 'trading' },
    });
    try {
      const res = await asUser(repTehran, () =>
        memoryPost(req('/api/ai-sales/memory', { action: 'get', centerId: otherBuCenter.id })));
      expect(res.status).toBe(404);
    } finally {
      await db.center.delete({ where: { id: otherBuCenter.id } });
    }
  });

  it('positive control: a country-mode expert and an admin are NOT blocked by territory', async () => {
    const r1 = await asUser(repCountry, () => memoryPost(req('/api/ai-sales/memory', { action: 'get', centerId: centerOut })));
    expect(r1.status).toBe(200);
    const r2 = await asUser(adminUser, () => memoryPost(req('/api/ai-sales/memory', { action: 'get', centerId: centerOut })));
    expect(r2.status).toBe(200);
  });
});

// ── P1-1: brief ─────────────────────────────────────────────
describe('P1-1 — pre-call brief is territory-gated', () => {
  it('out-of-territory center → 404; in-territory center → 200', async () => {
    const out = await asUser(repTehran, () =>
      briefPost(req('/api/ai-sales/brief', { centerId: centerOut })));
    expect(out.status).toBe(404);
    const inn = await asUser(repTehran, () =>
      briefPost(req('/api/ai-sales/brief', { centerId: centerIn })));
    expect(inn.status).toBe(200);
  });
});

// ── P1-1: calls (recordings) ────────────────────────────────
describe('P1-1 — call recordings enforce territory + ownership', () => {
  it('RED→GREEN: get of a recording whose center is outside the territory → 404', async () => {
    const rec = await db.aiCallRecording.create({
      data: { companyId: companyBgl.id, centerId: centerOut, userId: repCountry.id, title: `${TAG}-rec-out`, status: 'completed' },
    });
    try {
      const res = await asUser(repTehran, () => callsPost(req('/api/ai-sales/calls', { action: 'get', id: rec.id })));
      expect(res.status).toBe(404);
    } finally {
      await db.aiCallRecording.delete({ where: { id: rec.id } });
    }
  });

  it('positive control: a recording INSIDE the territory is readable', async () => {
    const rec = await db.aiCallRecording.create({
      data: { companyId: companyBgl.id, centerId: centerIn, userId: repCountry.id, title: `${TAG}-rec-in`, status: 'completed' },
    });
    try {
      const res = await asUser(repTehran, () => callsPost(req('/api/ai-sales/calls', { action: 'get', id: rec.id })));
      expect(res.status).toBe(200);
    } finally {
      await db.aiCallRecording.delete({ where: { id: rec.id } });
    }
  });

  it('a CENTERLESS recording of ANOTHER user is invisible to a territory-restricted expert (ownership)', async () => {
    const rec = await db.aiCallRecording.create({
      data: { companyId: companyBgl.id, centerId: null, userId: repCountry.id, title: `${TAG}-rec-noc`, status: 'completed' },
    });
    try {
      const res = await asUser(repTehran, () => callsPost(req('/api/ai-sales/calls', { action: 'get', id: rec.id })));
      expect(res.status).toBe(404);
    } finally {
      await db.aiCallRecording.delete({ where: { id: rec.id } });
    }
  });

  it('a CENTERLESS recording of one’s OWN is visible to the same restricted expert', async () => {
    const rec = await db.aiCallRecording.create({
      data: { companyId: companyBgl.id, centerId: null, userId: repTehran.id, title: `${TAG}-rec-own`, status: 'completed' },
    });
    try {
      const res = await asUser(repTehran, () => callsPost(req('/api/ai-sales/calls', { action: 'get', id: rec.id })));
      expect(res.status).toBe(200);
    } finally {
      await db.aiCallRecording.delete({ where: { id: rec.id } });
    }
  });

  it('list: an out-of-territory recording does not appear for the restricted expert', async () => {
    const recOut = await db.aiCallRecording.create({
      data: { companyId: companyBgl.id, centerId: centerOut, userId: repCountry.id, title: `${TAG}-list-out`, status: 'completed' },
    });
    const recIn = await db.aiCallRecording.create({
      data: { companyId: companyBgl.id, centerId: centerIn, userId: repCountry.id, title: `${TAG}-list-in`, status: 'completed' },
    });
    try {
      const res = await asUser(repTehran, () => callsPost(req('/api/ai-sales/calls', { action: 'list', search: TAG })));
      expect(res.status).toBe(200);
      const body = await res.json() as { items: Array<{ id: string }> };
      const ids = body.items.map((i) => i.id);
      expect(ids).toContain(recIn.id);
      expect(ids).not.toContain(recOut.id);
    } finally {
      await db.aiCallRecording.deleteMany({ where: { id: { in: [recOut.id, recIn.id] } } });
    }
  });

  it('create-manual on an out-of-territory center is refused', async () => {
    const res = await asUser(repTehran, () =>
      callsPost(req('/api/ai-sales/calls', { action: 'create-manual', centerId: centerOut, transcriptText: 'سلام' })));
    expect(res.status).toBe(404);
    expect(await db.aiCallRecording.count({ where: { centerId: centerOut, title: { startsWith: TAG } } })).toBe(0);
  });
});

// ── P1-1: next actions ──────────────────────────────────────
describe('P1-1 — next-action operations enforce territory + ownership', () => {
  it('approve on an action whose center is outside the territory is denied', async () => {
    const act = await db.aiNextAction.create({
      data: { companyId: companyBgl.id, centerId: centerOut, type: 'call', title: `${TAG}-act-out`, status: 'suggested' },
    });
    try {
      const res = await asUser(repTehran, () => actionsPost(req('/api/ai-sales/actions', { action: 'approve', id: act.id })));
      expect([403, 404]).toContain(res.status);
      const row = await db.aiNextAction.findUnique({ where: { id: act.id } });
      expect(row?.status).toBe('suggested'); // untouched
    } finally {
      await db.aiNextAction.delete({ where: { id: act.id } });
    }
  });

  it('approve on an in-territory action works (positive control)', async () => {
    const act = await db.aiNextAction.create({
      data: { companyId: companyBgl.id, centerId: centerIn, type: 'call', title: `${TAG}-act-in`, status: 'suggested' },
    });
    try {
      const res = await asUser(repTehran, () => actionsPost(req('/api/ai-sales/actions', { action: 'approve', id: act.id })));
      expect(res.status).toBe(200);
    } finally {
      await db.aiNextAction.delete({ where: { id: act.id } });
    }
  });

  it('list filters out-of-territory actions for the restricted expert', async () => {
    const actOut = await db.aiNextAction.create({
      data: { companyId: companyBgl.id, centerId: centerOut, type: 'call', title: `${TAG}-alist-out`, status: 'suggested' },
    });
    const actIn = await db.aiNextAction.create({
      data: { companyId: companyBgl.id, centerId: centerIn, type: 'call', title: `${TAG}-alist-in`, status: 'suggested' },
    });
    try {
      // the rep sees only their companies' actions by company — plus
      // territory now; the out-of-province action must be gone.
      const res = await asUser(repTehran, () => actionsPost(req('/api/ai-sales/actions', { action: 'list', pageSize: 100 })));
      expect(res.status).toBe(200);
      const body = await res.json() as { items: Array<{ id: string; title: string }> };
      const titles = body.items.map((i) => i.title);
      expect(titles).toContain(`${TAG}-alist-in`);
      expect(titles).not.toContain(`${TAG}-alist-out`);
    } finally {
      await db.aiNextAction.deleteMany({ where: { id: { in: [actOut.id, actIn.id] } } });
    }
  });
});

// ── P1-2: inactive companies ────────────────────────────────
describe('P1-2 — an inactive company is outside the user’s scope', () => {
  it('getAllowedCompanyIds: a deactivated company drops out for its assigned (non-admin) user', async () => {
    await db.company.update({ where: { id: companyYasteb.id }, data: { isActive: false } });
    try {
      const ids = await getAllowedCompanyIds(repYasteb);
      expect(ids).not.toContain(companyYasteb.id);
      // and the admin's group list never contained it (isolated), while
      // the ACTIVE companies of a normal user stay intact
      const bglIds = await getAllowedCompanyIds(repTehran);
      expect(bglIds).toContain(companyBgl.id);
    } finally {
      await db.company.update({ where: { id: companyYasteb.id }, data: { isActive: true } });
    }
  });

  it('RED→GREEN: a user of a deactivated company reads the AI memory with 404, not 200', async () => {
    await db.company.update({ where: { id: companyYasteb.id }, data: { isActive: false } });
    try {
      const res = await asUser(repYasteb, () =>
        memoryPost(req('/api/ai-sales/memory', { action: 'get', centerId: centerYasteb })));
      expect(res.status).toBe(404);
    } finally {
      await db.company.update({ where: { id: companyYasteb.id }, data: { isActive: true } });
    }
  });

  it('assertCanAccessCompanySlug: non-admin + inactive slug → 403; admin explicit slug stays the documented exception', async () => {
    // aria: a NON-isolated group company — isolates 403 admins on a
    // separate (documented) rule, so this isolates the isActive dimension
    await db.company.update({ where: { id: companyAria.id }, data: { isActive: false } });
    try {
      const ariaUser = user({ companyIds: ['aria'] });
      await expect(assertCanAccessCompanySlug(ariaUser, 'aria')).rejects.toMatchObject({ status: 403 });
      // admin exception: explicit, documented — management of a
      // deactivated company (e.g. reactivation) stays possible
      const ref = await assertCanAccessCompanySlug(adminUser, 'aria');
      expect(ref.id).toBe(companyAria.id);
    } finally {
      await db.company.update({ where: { id: companyAria.id }, data: { isActive: true } });
    }
  });

  it('resolveScopedCompanyId never files a new row into a deactivated company (default or explicit)', async () => {
    await db.company.update({ where: { id: companyYasteb.id }, data: { isActive: false } });
    try {
      const explicit = await resolveScopedCompanyId(repYasteb, 'yasteb');
      expect(explicit.ok).toBe(false); // refused write target
      const fallback = await resolveScopedCompanyId(repYasteb, undefined);
      expect(fallback.ok === true && fallback.companyId === undefined).toBe(true); // nothing usable left
    } finally {
      await db.company.update({ where: { id: companyYasteb.id }, data: { isActive: true } });
    }
  });
});
