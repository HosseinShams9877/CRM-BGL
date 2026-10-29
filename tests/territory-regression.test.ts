import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// territory-regression.test.ts — v2.58.3 (round 88, finding 1)
//
// THE REVIEWER'S ACCEPTANCE MATRIX, through the REAL route handlers
// (auth injected at the session seam; every guard, scope fragment
// and transaction is the production code path):
//
//   • a province-A expert cannot READ or MUTATE a province-B center's
//     records by direct id — List/Get/Create/Update/Delete/Notes/Status
//     across activities / after-sales / inventory / shipments / loyalty /
//     followups(+[id]+notes)
//   • mineOnly does NOT leak out-of-territory rows (the where.AND
//     overwrite bug)
//   • a REJECTED request leaves no DB side effects
//   • finance keeps company-wide reach (allowed exception preserved);
//     the holding admin does NOT gain isolated-company access
//   • the isolated company (یاس طب) stays walled off
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as activitiesPost } from '@/app/api/activities/route';
import { POST as afterSalesPost } from '@/app/api/after-sales/route';
import { POST as inventoryPost } from '@/app/api/inventory/route';
import { POST as shipmentsPost } from '@/app/api/shipments/route';
import { POST as loyaltyPost } from '@/app/api/loyalty/route';
import { POST as followupsPost, GET as followupsList } from '@/app/api/followups/route';
import { POST as followupResultPost } from '@/app/api/followups/[id]/route';
import { GET as followupNotesGet, POST as followupNotesPost } from '@/app/api/followups/[id]/notes/route';

const db = new PrismaClient();
const TAG = `r88g-${Date.now()}`;

function req(url: string, body: unknown, method: 'POST' | 'GET' = 'POST'): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

function asUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
  currentAuthUser = user;
  return fn();
}

async function jsonOf(res: unknown): Promise<Record<string, unknown>> {
  return (await (res as { json: () => Promise<unknown> }).json()) as Record<string, unknown>;
}

// ── fixture users (real rows: FKs need them) ────────────────
let expertA: { id: string; username: string; displayName: string; role: string; roleLabel: string; businessUnitId: string; companyIds: string[]; jobTitle: string | null; isActive: boolean; impersonator: null; territoryMode: string; territoryProvinces: string | null; territoryCenterIds: string | null };
let expertB: typeof expertA;
let financeUser: typeof expertA;
let adminUser: typeof expertA;
let isoUser: typeof expertA;

let centerTeh: { id: string; companyId: string };
let centerKhz: { id: string; companyId: string };
let centerYasteb: { id: string; companyId: string };

function territoryUser(base: typeof expertA, provinces: string[]) {
  return { ...base, territoryMode: 'provinces', territoryProvinces: JSON.stringify(provinces) };
}

async function mkUser(username: string, role: string, companyIds: string[], territory?: string[]) {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`,
      displayName: username,
      passwordHash: 'x',
      role,
      companyIds: JSON.stringify(companyIds),
      businessUnitId: 'production',
      territoryMode: territory ? 'provinces' : 'country',
      territoryProvinces: territory ? JSON.stringify(territory) : '[]',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'production', companyIds, jobTitle: null, isActive: true, impersonator: null,
    territoryMode: territory ? 'provinces' : 'country',
    territoryProvinces: territory ? JSON.stringify(territory) : '[]',
    territoryCenterIds: '[]',
  };
}

async function mkCenter(name: string, companyId: string, province: string) {
  return db.center.create({
    data: { name: `${TAG}-${name}`, customerType: 'b2b', companyId, province, businessUnitId: 'trading' },
  });
}

let activityKhz: { id: string };
let activityKhzOwn: { id: string }; // expertA's OWN row, out of territory
let activityTeh: { id: string };
let ticketKhz: { id: string };
let ticketTeh: { id: string };
let serialKhz: { id: string };
let serialKhzName: string;
let docKhz: { id: string };
let shipmentKhz: { id: string };
let loyaltyKhzCenter: { id: string };
let followupKhz: { id: string; companyId: string };
let followupTeh: { id: string; companyId: string };

beforeAll(async () => {
  const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
  const yasteb = (await db.company.findFirst({ where: { slug: 'yasteb' } }))!;

  expertA = await mkUser('expert-a', 'standard', ['bazargani'], ['تهران']);
  expertB = await mkUser('expert-b', 'standard', ['bazargani'], ['خوزستان']);
  financeUser = await mkUser('finance-u', 'finance', ['bazargani']);
  adminUser = await mkUser('admin-u', 'admin', []);
  isoUser = await mkUser('iso-u', 'standard', ['yasteb'], ['تهران']);

  centerTeh = await mkCenter('تهران', bazargani.id, 'تهران');
  centerKhz = await mkCenter('خوزستان', bazargani.id, 'خوزستان');
  centerYasteb = await mkCenter('یاس‌طب', yasteb.id, 'تهران');

  // activities
  activityKhz = await db.activity.create({
    data: { title: `${TAG} فع ت خ`, description: '', activityDate: new Date(), isPhoneCall: true, centerId: centerKhz.id, createdById: expertB.id, assignedTo: expertB.id, businessUnitId: 'production' },
  });
  activityKhzOwn = await db.activity.create({
    data: { title: `${TAG} فع خودم خ`, description: '', activityDate: new Date(), isPhoneCall: true, centerId: centerKhz.id, createdById: expertA.id, assignedTo: expertA.id, businessUnitId: 'production' },
  });
  activityTeh = await db.activity.create({
    data: { title: `${TAG} فع ت`, description: '', activityDate: new Date(), isPhoneCall: true, centerId: centerTeh.id, createdById: expertB.id, assignedTo: expertB.id, businessUnitId: 'production' },
  });

  // after-sales tickets
  ticketKhz = await db.serviceTicket.create({
    data: { businessUnitId: 'production', ticketNumber: `TS-${TAG}-1`, serialNumber: null, productCode: null, centerId: centerKhz.id, contactName: 'x', contactPhone: null, type: 'repair', priority: 'normal', status: 'open', warrantyStatus: 'unknown', issue: 'x', createdById: expertB.id },
  });
  ticketTeh = await db.serviceTicket.create({
    data: { businessUnitId: 'production', ticketNumber: `TS-${TAG}-2`, serialNumber: null, productCode: null, centerId: centerTeh.id, contactName: 'x', contactPhone: null, type: 'repair', priority: 'normal', status: 'open', warrantyStatus: 'unknown', issue: 'x', createdById: expertB.id },
  });

  // inventory serial (sold to the Khuzestan center)
  serialKhzName = `SN-${TAG}-1`;
  serialKhz = await db.inventorySerial.create({
    data: { serialNumber: serialKhzName, productCode: 'P001', status: 'sold', centerId: centerKhz.id, companyId: bazargani.id, notes: '', soldAt: new Date() },
  });

  // sales document (approved invoice, Khuzestan center) + shipment
  docKhz = await db.salesDocument.create({
    data: {
      documentNumber: `INV-${TAG}-1`, documentType: 'invoice', status: 'approved',
      totalAmount: 1000, discountAmount: 0, taxAmount: 0, finalAmount: 1000,
      centerId: centerKhz.id, companyId: bazargani.id, businessUnitId: 'production',
      issuedAt: new Date(), createdById: expertB.id,
    },
  });
  shipmentKhz = await db.salesShipment.create({
    data: { shipmentNumber: `SHP-${TAG}-1`, salesDocumentId: docKhz.id, status: 'preparing', carrierName: 'x', createdById: expertB.id },
  });

  // loyalty transaction on the Khuzestan center
  loyaltyKhzCenter = centerKhz;
  await db.loyaltyTransaction.create({
    data: { centerId: centerKhz.id, points: 10, reason: 'purchase', note: `${TAG}`, createdById: expertB.id, createdByName: 'x' },
  });

  // followups
  followupKhz = await db.periodicFollowup.create({
    data: { companyId: bazargani.id, centerId: centerKhz.id, centerName: `${TAG} خ`, personName: 'x', phone: null, frequency: 'monthly', frequencyDays: 30, nextFollowupDate: new Date().toISOString().slice(0, 10), status: 'upcoming', isActive: true },
  });
  followupTeh = await db.periodicFollowup.create({
    data: { companyId: bazargani.id, centerId: centerTeh.id, centerName: `${TAG} ت`, personName: 'x', phone: null, frequency: 'monthly', frequencyDays: 30, nextFollowupDate: new Date().toISOString().slice(0, 10), status: 'upcoming', isActive: true },
  });
  await db.followupNote.create({ data: { followupId: followupKhz.id, text: 'note' } });
});

afterAll(async () => {
  const centers = await db.center.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const centerIds = centers.map((c) => c.id);
  await db.followupNote.deleteMany({ where: { followupId: { in: (await db.periodicFollowup.findMany({ where: { centerId: { in: centerIds } }, select: { id: true } })).map((f) => f.id) } } }).catch(() => undefined);
  await db.periodicFollowup.deleteMany({ where: { centerId: { in: centerIds } } }).catch(() => undefined);
  await db.loyaltyTransaction.deleteMany({ where: { centerId: { in: centerIds } } }).catch(() => undefined);
  const docs = await db.salesDocument.findMany({ where: { documentNumber: { startsWith: `INV-${TAG}` } }, select: { id: true } });
  for (const d of docs) {
    await db.salesShipment.deleteMany({ where: { salesDocumentId: d.id } }).catch(() => undefined);
    await db.salesDocumentLog.deleteMany({ where: { salesDocumentId: d.id } }).catch(() => undefined);
    await db.salesDocument.delete({ where: { id: d.id } }).catch(() => undefined);
  }
  await db.inventorySerial.deleteMany({ where: { serialNumber: { startsWith: `SN-${TAG}` } } }).catch(() => undefined);
  await db.serviceTicket.deleteMany({ where: { ticketNumber: { startsWith: `TS-${TAG}` } } }).catch(() => undefined);
  await db.serviceTicketLog.deleteMany({ where: { ticketId: { in: (await db.serviceTicket.findMany({ where: { ticketNumber: { startsWith: `TS-${TAG}` } }, select: { id: true } })).map((t) => t.id) } } }).catch(() => undefined);
  await db.activity.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
  await db.center.deleteMany({ where: { id: { in: centerIds } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } }).catch(() => undefined);
  await db.$disconnect();
});

// ═══ ACTIVITIES ═════════════════════════════════════════════

describe('F1 — activities (territory + mineOnly composition)', () => {
  it('plain list: expert A (تهران) sees NO Khuzestan rows, Tehran rows stay', async () => {
    const res = await asUser(territoryUser(expertA, ['تهران']), () =>
      activitiesPost(req('/api/activities', { action: 'list', page: 1, pageSize: 50 })));
    const body = await jsonOf(res);
    const items = (body.items as Array<{ id: string }>).map((x) => x.id);
    expect(items).not.toContain(activityKhz.id);
    expect(items).not.toContain(activityKhzOwn.id);
    expect(items).toContain(activityTeh.id);
  });

  it('mineOnly (the where.AND overwrite bug): still NO out-of-territory rows', async () => {
    const res = await asUser(territoryUser(expertA, ['تهران']), () =>
      activitiesPost(req('/api/activities', { action: 'list', mineOnly: true, page: 1, pageSize: 50 })));
    const body = await jsonOf(res);
    const items = (body.items as Array<{ id: string }>).map((x) => x.id);
    // expertA's OWN Khuzestan row must stay hidden — the ownership
    // condition composes WITH the territory instead of replacing it
    expect(items).not.toContain(activityKhzOwn.id);
    expect(items).not.toContain(activityKhz.id);
  });

  it('get by direct id: out-of-territory → 404; in-territory → 200', async () => {
    const denied = await asUser(territoryUser(expertA, ['تهران']), () =>
      activitiesPost(req('/api/activities', { action: 'get', id: activityKhz.id })));
    expect(denied.status).toBe(404);
    const allowed = await asUser(territoryUser(expertA, ['تهران']), () =>
      activitiesPost(req('/api/activities', { action: 'get', id: activityTeh.id })));
    expect(allowed.status).toBe(200);
  });

  it('update by direct id: out-of-territory → 404 and NOTHING changes', async () => {
    const before = await db.activity.findUnique({ where: { id: activityKhz.id } });
    const res = await asUser(territoryUser(expertA, ['تهران']), () =>
      activitiesPost(req('/api/activities', { action: 'update', id: activityKhz.id, title: 'HACKED' })));
    expect(res.status).toBe(404);
    const after = await db.activity.findUnique({ where: { id: activityKhz.id } });
    expect(after?.title).toBe(before?.title);
  });

  it('delete by direct id: out-of-territory → 404, row survives', async () => {
    const res = await asUser(territoryUser(expertA, ['تهران']), () =>
      activitiesPost(req('/api/activities', { action: 'delete', id: activityKhz.id })));
    expect(res.status).toBe(404);
    expect(await db.activity.findUnique({ where: { id: activityKhz.id } })).not.toBeNull();
  });
});

// ═══ AFTER-SALES ════════════════════════════════════════════

describe('F1 — after-sales tickets', () => {
  it('list excludes out-of-territory tickets', async () => {
    const res = await asUser(territoryUser(expertA, ['تهران']), () =>
      afterSalesPost(req('/api/after-sales', { action: 'list', limit: 100 })));
    const body = await jsonOf(res);
    const ids = (body.data as Array<{ id: string }>).map((x) => x.id);
    expect(ids).not.toContain(ticketKhz.id);
    expect(ids).toContain(ticketTeh.id);
  });

  it('get / update / set-status by direct id → 404, no changes', async () => {
    const a = territoryUser(expertA, ['تهران']);
    const g = await asUser(a, () => afterSalesPost(req('/api/after-sales', { action: 'get', id: ticketKhz.id })));
    expect(g.status).toBe(404);
    const u = await asUser(a, () => afterSalesPost(req('/api/after-sales', { action: 'update', id: ticketKhz.id, issue: 'HACKED' })));
    expect(u.status).toBe(404);
    const s = await asUser(a, () => afterSalesPost(req('/api/after-sales', { action: 'set-status', id: ticketKhz.id, status: 'in_progress' })));
    expect(s.status).toBe(404);
    const row = await db.serviceTicket.findUnique({ where: { id: ticketKhz.id } });
    expect(row?.status).toBe('open');
    expect(row?.issue).toBe('x');
  });
});

// ═══ INVENTORY ══════════════════════════════════════════════

describe('F1 — inventory serials', () => {
  it('list excludes out-of-territory serials; get/update-status by id → 404', async () => {
    const a = territoryUser(expertA, ['تهران']);
    const l = await asUser(a, () => inventoryPost(req('/api/inventory', { action: 'list', page: 1, pageSize: 100 })));
    const body = await jsonOf(l);
    const ids = (body.items as Array<{ id: string }>).map((x) => x.id);
    expect(ids).not.toContain(serialKhz.id);

    const g = await asUser(a, () => inventoryPost(req('/api/inventory', { action: 'get', id: serialKhz.id })));
    expect(g.status).toBe(404);
    const st = await asUser(a, () => inventoryPost(req('/api/inventory', { action: 'update-status', id: serialKhz.id, status: 'returned' })));
    expect(st.status).toBe(404);
    const row = await db.inventorySerial.findUnique({ where: { id: serialKhz.id } });
    expect(row?.status).toBe('sold');
  });

  it('F2 regression — a returned serial KEEPS its company (no neutral-pool leak)', async () => {
    // expertB (خوزستان) is in-territory for this serial
    const res = await asUser(territoryUser(expertB, ['خوزستان']), () =>
      inventoryPost(req('/api/inventory', { action: 'update-status', id: serialKhz.id, status: 'returned' })));
    expect(res.status).toBe(200);
    let row = await db.inventorySerial.findUnique({ where: { id: serialKhz.id } });
    expect(row?.status).toBe('returned');
    expect(row?.companyId).not.toBeNull(); // THE FIX: company survives a return
    expect(row?.centerId).toBeNull();      // …while the center link is released

    // …and after restock (available), the company STILL holds it — an
    // isolated company's serial never lands in the shared pool
    await asUser(territoryUser(expertB, ['خوزستان']), () =>
      inventoryPost(req('/api/inventory', { action: 'update-status', id: serialKhz.id, status: 'available' })));
    row = await db.inventorySerial.findUnique({ where: { id: serialKhz.id } });
    expect(row?.companyId).not.toBeNull();
    expect(row?.soldAt).not.toBeNull(); // sales history preserved (warranty window)
  });
});

// ═══ SHIPMENTS ══════════════════════════════════════════════

describe('F1 — shipments', () => {
  it('list excludes out-of-territory shipments; get → 404; create for an out-of-territory doc → 403', async () => {
    const a = territoryUser(expertA, ['تهران']);
    const l = await asUser(a, () => shipmentsPost(req('/api/shipments', { action: 'list', page: 1, pageSize: 50 })));
    const body = await jsonOf(l);
    const ids = (body.data as Array<{ id: string }>).map((x) => x.id);
    expect(ids).not.toContain(shipmentKhz.id);

    const g = await asUser(a, () => shipmentsPost(req('/api/shipments', { action: 'get', id: shipmentKhz.id })));
    expect((g as { status?: number }).status ?? 0).toBe(404);

    const countBefore = await db.salesShipment.count();
    const c = await asUser(a, () => shipmentsPost(req('/api/shipments', { action: 'create', salesDocumentId: docKhz.id, status: 'preparing', carrierName: 'x' })));
    expect((c as { status?: number }).status ?? 0).toBe(403);
    expect(await db.salesShipment.count()).toBe(countBefore); // no side effect
  });
});

// ═══ LOYALTY ════════════════════════════════════════════════

describe('F1 — loyalty', () => {
  it('ledger excludes out-of-territory centers; add-points → 404 with no balance change', async () => {
    const a = territoryUser(expertA, ['تهران']);
    const l = await asUser(a, () => loyaltyPost(req('/api/loyalty', { action: 'list-transactions', limit: 200 })));
    const body = await jsonOf(l);
    const centers = (body.data as Array<{ centerId: string }>).map((x) => x.centerId);
    expect(centers).not.toContain(loyaltyKhzCenter.id);

    const before = await db.center.findUnique({ where: { id: loyaltyKhzCenter.id }, select: { loyaltyPoints: true } });
    const add = await asUser(a, () => loyaltyPost(req('/api/loyalty', { action: 'add-points', centerId: loyaltyKhzCenter.id, points: 500, reason: 'manual' })));
    expect(add.status).toBe(404);
    const after = await db.center.findUnique({ where: { id: loyaltyKhzCenter.id }, select: { loyaltyPoints: true } });
    expect(after?.loyaltyPoints).toBe(before?.loyaltyPoints);
  });
});

// ═══ FOLLOWUPS + NOTES ══════════════════════════════════════

describe('F1 — followups, [id] and notes', () => {
  it('list already excludes out-of-territory follow-ups', async () => {
    const res = await asUser(territoryUser(expertA, ['تهران']), () =>
      followupsList(new NextRequest('http://localhost/api/followups')));
    const rows = (await res.json()) as Array<{ id: string }>;
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(followupKhz.id);
    expect(ids).toContain(followupTeh.id);
  });

  it('direct [id] result POST → 404 with no history row', async () => {
    const historyBefore = await db.followupHistory.count({ where: { followupId: followupKhz.id } });
    const res = await asUser(territoryUser(expertA, ['تهران']), () =>
      followupResultPost(
        req('/api/followups/x', { method: 'POST', ...{} } as never, 'POST'),
        { params: Promise.resolve({ id: followupKhz.id }) } as never,
      ));
    expect(res.status).toBe(404);
    expect(await db.followupHistory.count({ where: { followupId: followupKhz.id } })).toBe(historyBefore);
  });

  it('notes GET → 404; notes POST → 404 with no note created', async () => {
    const a = territoryUser(expertA, ['تهران']);
    const g = await asUser(a, () => followupNotesGet(
      new NextRequest(`http://localhost/api/followups/${followupKhz.id}/notes`),
      { params: Promise.resolve({ id: followupKhz.id }) } as never,
    ));
    expect(g.status).toBe(404);

    const notesBefore = await db.followupNote.count({ where: { followupId: followupKhz.id } });
    const p = await asUser(a, () => followupNotesPost(
      req(`/api/followups/${followupKhz.id}/notes`, { text: 'HACK' }),
      { params: Promise.resolve({ id: followupKhz.id }) } as never,
    ));
    expect(p.status).toBe(404);
    expect(await db.followupNote.count({ where: { followupId: followupKhz.id } })).toBe(notesBefore);
  });

  it('create: out-of-territory center → 403; center of ANOTHER company → 400 (consistency)', async () => {
    const a = territoryUser(expertA, ['تهران']);
    const bazarganiId = followupKhz.companyId;
    // out-of-territory center of the SAME company
    const out = await asUser(a, () => followupsPost(req('/api/followups', {
      companyId: bazarganiId, centerId: centerKhz.id, centerName: 'x', personName: 'y', frequency: 'monthly',
    })));
    expect(out.status).toBe(403);
    // center of a DIFFERENT company (mismatch) — even IN territory
    const mismatch = await asUser(a, () => followupsPost(req('/api/followups', {
      companyId: bazarganiId, centerId: centerYasteb.id, centerName: 'x', personName: 'y', frequency: 'monthly',
    })));
    expect(mismatch.status).toBe(400);
    expect(await db.periodicFollowup.count({ where: { personName: 'y', centerName: 'x' } })).toBe(0);
  });
});

// ═══ PRESERVED EXCEPTIONS + ISOLATION ═══════════════════════

describe('F1 — preserved exceptions and company isolation', () => {
  it('finance keeps company-wide reach (the allowed exception) — territory-free, via a route finance may read', async () => {
    // finance holds view_other_sales_documents → shipments readable;
    // role finance resolves to a NULL territory scope, so BOTH provinces
    // of the company are visible to them.
    const res = await asUser(financeUser, () =>
      shipmentsPost(req('/api/shipments', { action: 'list', page: 1, pageSize: 100 })));
    const body = await jsonOf(res);
    const ids = (body.data as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toContain(shipmentKhz.id);   // خوزستان — finance is territory-free
  });

  it('the isolated company stays walled off from group users and the group admin', async () => {
    // a group-admin does not gain isolated-company access via these routes
    const l = await asUser(adminUser, () => inventoryPost(req('/api/inventory', { action: 'list', page: 1, pageSize: 100 })));
    const body = await jsonOf(l);
    const companies = (body.items as Array<{ companyId: string | null }>).map((x) => x.companyId);
    expect(companies).not.toContain(centerYasteb.companyId);

    // the isolated company's OWN user sees their data
    const iso = await asUser(isoUser, () => inventoryPost(req('/api/inventory', { action: 'list', page: 1, pageSize: 100 })));
    const isoBody = await jsonOf(iso);
    const isoCompanies = (isoBody.items as Array<{ companyId: string | null }>).map((x) => x.companyId);
    expect(isoCompanies.every((c) => c === null || c === centerYasteb.companyId)).toBe(true);
  });
});
