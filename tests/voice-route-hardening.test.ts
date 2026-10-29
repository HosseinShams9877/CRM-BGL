import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// voice-route-hardening.test.ts — v2.58.7 (A6 + F1)
//
// THE TWO REGRESSIONS (confirmed on the pre-fix v2.58.6 code):
//   • A6: the voice route never checked the TERRITORY (its plain twin
//     does) — a scoped expert could attach voice notes to an
//     out-of-territory center.
//   • F1: the route wrote the FINAL file FIRST, then inserted the DB
//     rows — a DB failure in between left a physical orphan file that
//     no sweeper ever collected. Also: a content-type lie (HTML bytes
//     claiming audio) went to disk + STT.
//
// THE CONTRACT (through the REAL route handler, scratch STORAGE_DIR):
//   • out-of-territory center → 404, zero activity/file/bytes
//   • content lie → 400, zero residue
//   • Activity-insert failure (a REAL SQLite trigger) → 500 + the
//     stored file is COMPENSATED (no row, no bytes)
//   • CONTROL: an in-territory, honest webm voice note stores fine
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as voicePost, GET as voiceGet } from '@/app/api/activities/voice/route';

const db = new PrismaClient();
const TAG = `r97voice-${Date.now().toString(36)}`;
let storageDir: string;

interface TestUser {
  id: string; username: string; displayName: string; role: string; roleLabel: string;
  businessUnitId: string; companyIds: string[]; jobTitle: string | null; isActive: boolean;
  impersonator: null; territoryMode: string; territoryProvinces: string | null; territoryCenterIds: string | null;
}

function asUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
  currentAuthUser = user;
  return fn();
}

const EBML_BYTES = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 7)]);
const HTML_BYTES = Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>' + 'A'.repeat(2048));

let expertTeh: TestUser;
let countryUser: TestUser;
let centerTeh: { id: string };
let centerKhz: { id: string };

beforeAll(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgl-voice-'));
  process.env.STORAGE_DIR = storageDir;

  const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
  async function mkUser(username: string, territory?: string[]): Promise<TestUser> {
    const u = await db.user.create({
      data: {
        username: `${TAG}-${username}`, displayName: username, passwordHash: 'x', role: 'standard',
        companyIds: JSON.stringify(['bazargani']), businessUnitId: 'trading',
        territoryMode: territory ? 'provinces' : 'country',
        territoryProvinces: territory ? JSON.stringify(territory) : '[]',
      },
    });
    return {
      id: u.id, username: u.username, displayName: u.displayName, role: 'standard', roleLabel: '',
      businessUnitId: 'trading', companyIds: ['bazargani'], jobTitle: null, isActive: true, impersonator: null,
      territoryMode: territory ? 'provinces' : 'country',
      territoryProvinces: territory ? JSON.stringify(territory) : '[]',
      territoryCenterIds: '[]',
    };
  }
  expertTeh = await mkUser('expert-teh', ['تهران']);
  countryUser = await mkUser('country-u');

  centerTeh = await db.center.create({
    data: { name: `${TAG}-teh`, customerType: 'b2b', companyId: bazargani.id, province: 'تهران', businessUnitId: 'trading' },
  });
  centerKhz = await db.center.create({
    data: { name: `${TAG}-khz`, customerType: 'b2b', companyId: bazargani.id, province: 'خوزستان', businessUnitId: 'trading' },
  });
});

afterAll(async () => {
  delete process.env.STORAGE_DIR;
  fs.rmSync(storageDir, { recursive: true, force: true });
  await db.activity.deleteMany({ where: { title: { startsWith: `${TAG}` } } });
  await db.file.deleteMany({ where: { originalName: { startsWith: 'voice-note' } } });
  await db.center.deleteMany({ where: { name: { startsWith: `${TAG}-` } } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

function voiceReq(centerId: string | null, bytes: Buffer, mimeType = 'audio/webm;codecs=opus'): NextRequest {
  const fd = new FormData();
  fd.append('audio', new File([new Uint8Array(bytes)], 'note.webm', { type: mimeType }));
  fd.append('title', `ویس ${TAG}`);
  fd.append('activityDate', new Date().toISOString().slice(0, 10));
  if (centerId) fd.append('centerId', centerId);
  return new NextRequest('http://localhost/api/activities/voice', { method: 'POST', body: fd });
}

async function zeroResidue(): Promise<boolean> {
  const files = await fsp.readdir(storageDir);
  return files.length === 0;
}

describe('A6 — the territory gate on the voice route', () => {
  it('REGRESSION GUARD: an out-of-territory center → 404 with zero writes (no activity, no file row, no bytes)', async () => {
    const res = await asUser(expertTeh, () => voicePost(voiceReq(centerKhz.id, EBML_BYTES)));
    expect(res.status).toBe(404);
    expect(await db.activity.count({ where: { title: `ویس ${TAG}` } })).toBe(0);
    expect(await zeroResidue()).toBe(true);
  });

  it('CONTROL: the same user records fine on an in-territory center', async () => {
    const res = await asUser(expertTeh, () => voicePost(voiceReq(centerTeh.id, EBML_BYTES)));
    expect(res.status).toBe(201);
    expect(await db.activity.count({ where: { title: `ویس ${TAG}` } })).toBe(1);
    expect((await fsp.readdir(storageDir)).length).toBe(1);
    // cleanup for the following tests
    const act = await db.activity.findFirstOrThrow({ where: { title: `ویس ${TAG}` } });
    await db.activity.delete({ where: { id: act.id } });
    const fileRow = await db.file.findFirst({ where: { originalName: { startsWith: 'voice-note' } } });
    if (fileRow) await db.file.delete({ where: { id: fileRow.id } });
    fs.rmSync(path.join(storageDir, fileRow?.storedName ?? ''), { force: true });
  });

  it('a country-mode user records on any in-company center (territory is scoped-only)', async () => {
    const res = await asUser(countryUser, () => voicePost(voiceReq(centerKhz.id, EBML_BYTES)));
    expect(res.status).toBe(201);
    // cleanup
    const act = await db.activity.findFirstOrThrow({ where: { title: `ویس ${TAG}` } });
    await db.activity.delete({ where: { id: act.id } });
    const fileRow = await db.file.findFirst({ where: { originalName: { startsWith: 'voice-note' } } });
    if (fileRow) await db.file.delete({ where: { id: fileRow.id } });
    fs.rmSync(path.join(storageDir, fileRow?.storedName ?? ''), { force: true });
  });
});

describe('stage 7 — the audio content lie', () => {
  it('HTML bytes claiming audio/webm → 400, zero residue (no STT, no disk, no row)', async () => {
    const res = await asUser(expertTeh, () => voicePost(voiceReq(centerTeh.id, HTML_BYTES)));
    expect(res.status).toBe(400);
    expect(await db.activity.count({ where: { title: `ویس ${TAG}` } })).toBe(0);
    expect(await zeroResidue()).toBe(true);
  });
});

describe('F1 — DB-failure compensation (the orphan-file window is closed)', () => {
  const TRIGGER = 'r97_voice_fail_activity';

  it('an Activity-insert failure (REAL SQLite trigger) → the stored file is deleted again — NO orphan', async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON "Activity" BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    try {
      const res = await asUser(expertTeh, () => voicePost(voiceReq(centerTeh.id, EBML_BYTES)));
      expect(res.status).toBe(500);
      // THE ORPHAN TEST: no physical file, no File row, no Activity row
      expect(await zeroResidue()).toBe(true);
      expect(await db.file.count({ where: { originalName: { startsWith: 'voice-note' } } })).toBe(0);
      expect(await db.activity.count({ where: { title: `ویس ${TAG}` } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
    }
  });
});

describe('F2 — playback is streamed with the shared lifecycle helpers', () => {
  it('GET returns an audio stream for the caller\'s own voice activity (no whole-file buffer)', async () => {
    const create = await asUser(expertTeh, () => voicePost(voiceReq(centerTeh.id, EBML_BYTES)));
    expect(create.status).toBe(201);
    const body = (await (create as { json(): Promise<unknown> }).json()) as { activity: { id: string } };
    const activityId = body.activity.id;
    const get = new NextRequest(`http://localhost/api/activities/voice?id=${activityId}`, { method: 'GET' });
    const res = await asUser(expertTeh, () => voiceGet(get));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/');
    expect(Number(res.headers.get('content-length'))).toBe(EBML_BYTES.length);
    // cleanup
    await db.activity.delete({ where: { id: activityId } });
    const fileRow = await db.file.findFirst({ where: { originalName: { startsWith: 'voice-note' } } });
    if (fileRow) await db.file.delete({ where: { id: fileRow.id } });
    fs.rmSync(path.join(storageDir, fileRow?.storedName ?? ''), { force: true });
  });

  it('a scoped expert cannot stream ANOTHER user\'s out-of-territory voice activity (404)', async () => {
    // country user creates a voice note on the Khuzestan center
    const create = await asUser(countryUser, () => voicePost(voiceReq(centerKhz.id, EBML_BYTES)));
    expect(create.status).toBe(201);
    const body = (await (create as { json(): Promise<unknown> }).json()) as { activity: { id: string } };
    const activityId = body.activity.id;
    // the Tehran-scoped expert tries to stream it
    const get = new NextRequest(`http://localhost/api/activities/voice?id=${activityId}`, { method: 'GET' });
    const res = await asUser(expertTeh, () => voiceGet(get));
    expect(res.status).toBe(404);
    // cleanup
    await db.activity.delete({ where: { id: activityId } });
    const fileRow = await db.file.findFirst({ where: { originalName: { startsWith: 'voice-note' } } });
    if (fileRow) await db.file.delete({ where: { id: fileRow.id } });
    fs.rmSync(path.join(storageDir, fileRow?.storedName ?? ''), { force: true });
  });
});
