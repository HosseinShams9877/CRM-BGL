import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { PrismaClient } from '@prisma/client';
import {
  deleteFileRowQuiet,
  filesHealthSnapshot,
  FILE_STATUS_COMMITTED,
} from '@/lib/file-lifecycle';
import { generateStoredName } from '@/lib/storage';

// ═══════════════════════════════════════════════════════════════
// file-failclosed.test.ts — v2.58.11 (independent audit 2.58.10,
// P1-3b medium findings — reproduced RED on the shipped 2.58.10)
//
// FINDING 1 (fail-open delete): deleteFileRowQuiet() swallowed a
// FAILED 'committed → deleting' status flip and CONTINUED deleting
// the bytes — the DB row stayed 'committed' while its file vanished
// (download 410s, retention "deleted" audio still tracked). THE FIX:
// a failed or non-matching flip returns false WITHOUT touching the
// bytes — the caller reports an honest failure and a retry settles.
//
// FINDING 2 (fail-open health): filesHealthSnapshot() swallowed every
// physical-side error (unreadable storage dir, ownership query
// failure) and reported diskObjects/orphans = 0 — a BROKEN store
// looked perfectly healthy. THE FIX: only a genuinely ABSENT storage
// dir keeps zero counters; every other failure lands in
// snapshot.errors and the CLI exits non-zero.
// ═══════════════════════════════════════════════════════════════

const db = new PrismaClient();
const TAG = `r9111fc-${Date.now().toString(36)}`;
let storageDir: string;
const CONTENT = Buffer.from(`${TAG} fail-closed payload`);

beforeAll(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgl-failclosed-'));
  process.env.STORAGE_DIR = storageDir;
});

afterAll(async () => {
  delete process.env.STORAGE_DIR;
  fs.rmSync(storageDir, { recursive: true, force: true });
  await db.$disconnect();
});

describe('deleteFileRowQuiet — the status flip is load-bearing (fail-closed)', () => {
  it('a FAILED committed→deleting flip leaves the bytes AND the row untouched', async () => {
    const storedName = generateStoredName('a.pdf');
    const filePath = path.join(storageDir, storedName);
    await fsp.writeFile(filePath, CONTENT);
    const row = await db.file.create({
      data: {
        originalName: `${TAG}.pdf`, storedName, mimeType: 'application/pdf',
        size: CONTENT.length, checksum: null, status: FILE_STATUS_COMMITTED,
      },
    });
    try {
      // REAL, fully reversible DB failure during the flip
      await db.$executeRawUnsafe('ALTER TABLE "File" RENAME TO "File_sabotaged"');
      try {
        const settled = await deleteFileRowQuiet({ id: row.id, storedName, status: FILE_STATUS_COMMITTED });
        expect(settled).toBe(false);
        // THE 2.58.10 FAIL-OPEN: the bytes were already gone here.
        expect(fs.existsSync(filePath)).toBe(true);
      } finally {
        await db.$executeRawUnsafe('ALTER TABLE "File_sabotaged" RENAME TO "File"');
      }
      // row survived intact — still committed, still downloadable
      const after = await db.file.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe(FILE_STATUS_COMMITTED);
    } finally {
      await db.file.deleteMany({ where: { id: row.id } }).catch(() => undefined);
      await fsp.rm(filePath, { force: true }).catch(() => undefined);
    }
  });

  it('a flip that does not match the row (status changed between the read and the flip) refuses to touch the bytes', async () => {
    const storedName = generateStoredName('b.pdf');
    const filePath = path.join(storageDir, storedName);
    await fsp.writeFile(filePath, CONTENT);
    const row = await db.file.create({
      data: {
        originalName: `${TAG}.pdf`, storedName, mimeType: 'application/pdf',
        size: CONTENT.length, checksum: null, status: FILE_STATUS_COMMITTED,
      },
    });
    try {
      // simulate the race: the row's ACTUAL status changed after the caller
      // read it as committed — the conditional flip matches ZERO rows
      await db.file.update({ where: { id: row.id }, data: { status: 'deleting' } });
      const settled = await deleteFileRowQuiet({ id: row.id, storedName, status: FILE_STATUS_COMMITTED });
      expect(settled).toBe(false);
      expect(fs.existsSync(filePath)).toBe(true); // the bytes were NOT removed
    } finally {
      await db.file.deleteMany({ where: { id: row.id } }).catch(() => undefined);
      await fsp.rm(filePath, { force: true }).catch(() => undefined);
    }
  });

  it('happy path: a committed row with bytes settles (regression control)', async () => {
    const storedName = generateStoredName('c.pdf');
    const filePath = path.join(storageDir, storedName);
    await fsp.writeFile(filePath, CONTENT);
    const row = await db.file.create({
      data: {
        originalName: `${TAG}.pdf`, storedName, mimeType: 'application/pdf',
        size: CONTENT.length, checksum: null, status: FILE_STATUS_COMMITTED,
      },
    });
    try {
      const settled = await deleteFileRowQuiet({ id: row.id, storedName, status: FILE_STATUS_COMMITTED });
      expect(settled).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
      expect(await db.file.findUnique({ where: { id: row.id } })).toBeNull();
    } finally {
      await db.file.deleteMany({ where: { id: row.id } }).catch(() => undefined);
      await fsp.rm(filePath, { force: true }).catch(() => undefined);
    }
  });
});

describe('filesHealthSnapshot — physical errors are honest (fail-closed)', () => {
  it('an UNREADABLE storage location (ENOTDIR) is REPORTED, never "healthy zero orphans"', async () => {
    // a regular FILE where the storage dir should be — every readdir
    // fails with ENOTDIR. Pre-fix: swallowed → diskObjects=0,
    // orphans=0, perfectly healthy report.
    const blocker = path.join(os.tmpdir(), `${TAG}-blocker`);
    await fsp.writeFile(blocker, 'not a directory');
    const previous = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = blocker;
    try {
      const snap = await filesHealthSnapshot();
      expect(snap.errors.length).toBeGreaterThan(0);
      expect(snap.errors.some((e) => e.toLowerCase().includes('enotdir') || e.includes('storage'))).toBe(true);
      // physical counters must not claim a verified zero
      expect(snap.diskObjects).toBe(0);
      expect(snap.orphanFinalFiles).toBe(0);
      expect(snap.orphanPartFiles).toBe(0);
    } finally {
      process.env.STORAGE_DIR = previous;
      await fsp.rm(blocker, { force: true }).catch(() => undefined);
    }
  });

  it('a genuinely ABSENT storage dir stays a legitimate zero (no false alarm)', async () => {
    const previous = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = path.join(storageDir, 'does-not-exist-yet');
    try {
      const snap = await filesHealthSnapshot();
      expect(snap.errors.length).toBe(0);
      expect(snap.diskObjects).toBe(0);
    } finally {
      process.env.STORAGE_DIR = previous;
    }
  });

  it('a healthy store reports zero errors (regression control)', async () => {
    const snap = await filesHealthSnapshot();
    expect(snap.errors.length).toBe(0);
    expect(snap.storageDir).toBe(storageDir);
  });
});
