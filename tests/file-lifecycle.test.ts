import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { PrismaClient } from '@prisma/client';
import {
  storeFileLifecycle,
  sweepStalePendingFiles,
  verifyStoredFileChecksum,
  streamStoredFile,
  storedFileSize,
  assertDownloadable,
  deleteFileLifecycle,
  PENDING_LEASE_MS,
  FILE_STATUS_PENDING,
  FILE_STATUS_COMMITTED,
  FILE_STATUS_DELETING,
} from '@/lib/file-lifecycle';
import { sha256Hex, generateStoredName } from '@/lib/storage';
import { ApiError } from '@/lib/api-error';

// ═══════════════════════════════════════════════════════════════
// file-lifecycle.test.ts — v2.58.3 (round 88, finding 9) → v2.58.4
// (external audit F06 — REAL delete-failure coverage)
//
// The reviewer's mandatory matrix (real FS + real SQLite, isolated
// temp STORAGE_DIR — never the operational storage):
//   • DB failure → NO file residue, NO row (both sides rolled back)
//   • rename failure → NO residue, NO row
//   • process interruption (crash between row + rename) → the pending
//     row is IDENTIFIABLE and RECOVERED by the sweeper
//   • invalid checksum → controlled error, stream closed
//   • v2.58.4: an FS delete failure (REAL EACCES via a read-only
//     storage dir) → honest 500, the row SURVIVES as 'deleting', the
//     bytes stay intact; a separate retry settles it
//   • v2.58.4: a DB row-delete failure (REAL trigger ABORT) after the
//     unlink → the row survives (bytes already gone); the sweeper
//     retries and reports honestly until it succeeds
//   • v2.58.4: a promote happens ONLY after size+checksum agreement —
//     a tampered candidate is REPORTED, never promoted, never deleted
//   • v2.58.4: a 'deleting' row is never downloadable
//   • pending files are NOT downloadable
//   • committed rows missing physical content are REPORTED only
//     (no fabrication, no auto-delete)
//   • async chunked verification — bounded memory by design
//
// (The old «unsuccessful file delete» test executed deleteMany on a
// NONEXISTENT id and asserted count=0 — the audit's finding: it tested
// nothing about a real delete failure. It is replaced by the blocks
// below, which inject REAL filesystem and database failures.)
// ═══════════════════════════════════════════════════════════════

const db = new PrismaClient();
const TAG = `r88f-${Date.now()}`;
let storageDir: string;

beforeAll(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgl-lifecycle-'));
  process.env.STORAGE_DIR = storageDir;
  await db.file.deleteMany({ where: { originalName: { contains: TAG } } });
});

afterAll(async () => {
  delete process.env.STORAGE_DIR;
  fs.rmSync(storageDir, { recursive: true, force: true });
  await db.file.deleteMany({ where: { originalName: { contains: TAG } } });
  await db.$disconnect();
});

const CONTENT = Buffer.from(`${TAG} — lifecycle test payload `.repeat(40));

async function dirEntries(): Promise<string[]> {
  return (await fsp.readdir(storageDir)).sort();
}

function mkRow(overrides: Record<string, unknown> = {}) {
  const storedName = generateStoredName(`${TAG}.pdf`);
  return {
    originalName: `${TAG}.pdf`,
    storedName,
    mimeType: 'application/pdf',
    size: CONTENT.length,
    checksum: sha256Hex(CONTENT),
    ...overrides,
  };
}

describe('storeFileLifecycle — the happy path', () => {
  it('temp → pending → rename → committed; no .part residue', async () => {
    const stored = await storeFileLifecycle({
      bytes: CONTENT,
      originalName: `${TAG}-happy.pdf`,
      mimeType: 'application/pdf',
    });
    const row = await db.file.findUnique({ where: { id: stored.id } });
    expect(row?.status).toBe(FILE_STATUS_COMMITTED);
    const entries = await dirEntries();
    expect(entries.filter((e) => e.includes(row!.storedName))).toEqual([row!.storedName]); // no .part
    expect(fs.readFileSync(path.join(storageDir, row!.storedName)).equals(CONTENT)).toBe(true);
    expect(storedFileSize(row!.storedName)).toBe(CONTENT.length);
  });
});

describe('MANDATORY — failure atomicity', () => {
  it('DB failure → file removed, row never created (no half state)', async () => {
    // unique constraint clash on storedName → the DB write fails
    const storedName = generateStoredName(`${TAG}.pdf`);
    const first = await storeFileLifecycle({ bytes: CONTENT, originalName: `${TAG}-a.pdf`, mimeType: 'application/pdf', storedName });
    expect(first.id).toBeTruthy();
    // second store with the SAME storedName: temp write ok, DB create → P2002
    await expect(
      storeFileLifecycle({ bytes: CONTENT, originalName: `${TAG}-b.pdf`, mimeType: 'application/pdf', storedName }),
    ).rejects.toBeInstanceOf(ApiError);
    // residue: exactly ONE file, ONE row
    expect((await dirEntries()).filter((e) => e.includes(storedName))).toEqual([storedName]);
    expect(await db.file.count({ where: { storedName } })).toBe(1);
  });

  it('rename failure → temp + row both rolled back', async () => {
    // sabotage: a DIRECTORY sits at the final rename target → rename fails
    const storedName = generateStoredName(`${TAG}.pdf`);
    await fsp.mkdir(path.join(storageDir, storedName)); // blocks the rename
    try {
      await expect(
        storeFileLifecycle({ bytes: CONTENT, originalName: `${TAG}-rename.pdf`, mimeType: 'application/pdf', storedName }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(await db.file.count({ where: { storedName } })).toBe(0);
      // the .part temp was cleaned by the rollback (the blocker dir remains)
      const parts = (await dirEntries()).filter((e) => e.endsWith('.part'));
      expect(parts).toEqual([]);
    } finally {
      await fsp.rm(path.join(storageDir, storedName), { recursive: true, force: true });
    }
  });
});

describe('MANDATORY — process interruption + recovery', () => {
  it('a crashed upload (row pending, no final file) is swept; a crashed POST-rename is PROMOTED', async () => {
    // (a) crash between row-create and rename: pending row + .part file
    const staleName = generateStoredName(`${TAG}.pdf`);
    await fsp.writeFile(path.join(storageDir, `${staleName}.part`), CONTENT);
    await db.file.create({ data: mkRow({ storedName: staleName, status: FILE_STATUS_PENDING, createdAt: new Date(Date.now() - PENDING_LEASE_MS - 60_000), originalName: `${TAG}-stale.pdf` }) });

    // (b) crash between rename and commit: final file EXISTS, row still pending
    const promoteName = generateStoredName(`${TAG}.pdf`);
    await fsp.writeFile(path.join(storageDir, promoteName), CONTENT);
    await db.file.create({ data: mkRow({ storedName: promoteName, status: FILE_STATUS_PENDING, createdAt: new Date(Date.now() - PENDING_LEASE_MS - 60_000), originalName: `${TAG}-promote.pdf` }) });

    // (c) an ACTIVE upload (young pending row + .part) — must stay untouched
    const activeName = generateStoredName(`${TAG}.pdf`);
    await fsp.writeFile(path.join(storageDir, `${activeName}.part`), CONTENT);
    await db.file.create({ data: mkRow({ storedName: activeName, status: FILE_STATUS_PENDING, createdAt: new Date(), originalName: `${TAG}-active.pdf` }) });

    // (d) a valid committed file — must stay untouched
    const validName = generateStoredName(`${TAG}.pdf`);
    await fsp.writeFile(path.join(storageDir, validName), CONTENT);
    await db.file.create({ data: mkRow({ storedName: validName, status: FILE_STATUS_COMMITTED, originalName: `${TAG}-valid.pdf` }) });

    const report = await sweepStalePendingFiles();

    // stale swept (row + .part), active + valid untouched
    expect(report.sweptPendingRows).toBe(1);
    expect(report.sweptTempFiles).toBe(1);
    expect(await db.file.findUnique({ where: { storedName: staleName } })).toBeNull();
    expect(fs.existsSync(path.join(storageDir, `${staleName}.part`))).toBe(false);

    // post-rename crash → PROMOTED to committed (bytes were durable)
    const promoted = await db.file.findUnique({ where: { storedName: promoteName } });
    expect(promoted?.status).toBe(FILE_STATUS_COMMITTED);

    // active upload untouched (still pending, .part intact)
    const active = await db.file.findUnique({ where: { storedName: activeName } });
    expect(active?.status).toBe(FILE_STATUS_PENDING);
    expect(fs.existsSync(path.join(storageDir, `${activeName}.part`))).toBe(true);

    // valid file untouched
    expect(fs.existsSync(path.join(storageDir, validName))).toBe(true);

    // cleanup the leftovers of this test
    await db.file.deleteMany({ where: { storedName: { in: [promoteName, activeName, validName] } } });
    for (const n of [promoteName, activeName, validName]) {
      await fsp.rm(path.join(storageDir, n), { force: true }).catch(() => undefined);
      await fsp.rm(path.join(storageDir, `${n}.part`), { force: true }).catch(() => undefined);
    }
  });

  it('unsuccessful file delete (REAL EACCES) → honest 500, the ROW survives as «deleting», the BYTES survive; a separate retry settles it', async () => {
    const name = generateStoredName(`${TAG}.pdf`);
    await fsp.writeFile(path.join(storageDir, name), CONTENT);
    const row = await db.file.create({ data: mkRow({ storedName: name, status: FILE_STATUS_COMMITTED, originalName: `${TAG}-locked.pdf` }) });

    // REAL filesystem failure: a read-only storage directory makes the
    // unlink fail with EACCES (the running user is not root).
    await fsp.chmod(storageDir, 0o555);
    try {
      await expect(deleteFileLifecycle(row.id)).rejects.toMatchObject({ status: 500 });
      // the OLD code answered 200 here and dropped the row — an untracked
      // orphan. The row must now stay, tracked as 'deleting', bytes intact:
      const tracked = await db.file.findUnique({ where: { id: row.id } });
      expect(tracked?.status).toBe(FILE_STATUS_DELETING);
      expect(fs.existsSync(path.join(storageDir, name))).toBe(true);
      // a 'deleting' row is never downloadable
      expect(() => assertDownloadable(tracked!.status)).toThrow(ApiError);

      // a SEPARATE retry (after the lock is gone) settles both sides
      await fsp.chmod(storageDir, 0o755);
      await deleteFileLifecycle(row.id);
      expect(await db.file.findUnique({ where: { id: row.id } })).toBeNull();
      expect(fs.existsSync(path.join(storageDir, name))).toBe(false);
    } finally {
      await fsp.chmod(storageDir, 0o755).catch(() => undefined);
    }
  }, 30_000);

  it('a DB row-delete failure after the unlink (REAL trigger ABORT) → the row survives; the sweeper retries and settles it', async () => {
    const name = generateStoredName(`${TAG}.pdf`);
    await fsp.writeFile(path.join(storageDir, name), CONTENT);
    const row = await db.file.create({ data: mkRow({ storedName: name, status: FILE_STATUS_COMMITTED, originalName: `${TAG}-dbfail.pdf` }) });
    // REAL database failure: the row DELETE is aborted (bytes already gone)
    const trig = `r89_fail_file_delete_${row.id.replace(/-/g, '_')}`;
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${trig} BEFORE DELETE ON "File" WHEN OLD."id" = '${row.id}' BEGIN SELECT RAISE(ABORT, 'injected row-delete failure'); END`,
    );
    try {
      await expect(deleteFileLifecycle(row.id)).rejects.toBeInstanceOf(Error);
      // bytes are settled (unlink ran first) but the row survives, tracked
      const tracked = await db.file.findUnique({ where: { id: row.id } });
      expect(tracked?.status).toBe(FILE_STATUS_DELETING);
      expect(fs.existsSync(path.join(storageDir, name))).toBe(false);

      // the sweeper retries the row delete → STILL blocked → REPORTED
      // honestly (never counted as success, row kept)
      const blocked = await sweepStalePendingFiles();
      expect(blocked.deletingFailures.some((f) => f.id === row.id)).toBe(true);
      expect(blocked.deletingRowsSettled).toBe(0);

      // lock removed → a later sweep settles it exactly
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trig}`);
      const settled = await sweepStalePendingFiles();
      expect(settled.deletingFailures.some((f) => f.id === row.id)).toBe(false);
      expect(await db.file.findUnique({ where: { id: row.id } })).toBeNull();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trig}`);
      await db.file.deleteMany({ where: { id: row.id } }).catch(() => undefined);
      await fsp.rm(path.join(storageDir, name), { force: true }).catch(() => undefined);
    }
  }, 30_000);

  it('a crashed delete (row «deleting», bytes already gone) is recovered by the sweep alone', async () => {
    const name = generateStoredName(`${TAG}.pdf`);
    // crash between unlink and row delete: NO bytes, row stuck in 'deleting'
    const row = await db.file.create({ data: mkRow({ storedName: name, status: FILE_STATUS_DELETING, originalName: `${TAG}-crash.pdf` }) });
    const report = await sweepStalePendingFiles();
    expect(report.deletingRowsSettled).toBeGreaterThanOrEqual(1);
    expect(await db.file.findUnique({ where: { id: row.id } })).toBeNull();
  });
});

describe('MANDATORY — checksum verification (async, chunked, fail-closed)', () => {
  // stored names must be server-shaped (resolveStoredPath validates the
  // 32-hex + sanitized-extension pattern — traversal-resistant)
  const okName = generateStoredName('verify.pdf');
  const badName = generateStoredName('tampered.pdf');

  beforeEach(async () => {
    await fsp.writeFile(path.join(storageDir, okName), CONTENT);
    await fsp.writeFile(path.join(storageDir, badName), Buffer.concat([CONTENT, Buffer.from('tampered')]));
  });
  afterEach(async () => {
    await fsp.rm(path.join(storageDir, okName), { force: true }).catch(() => undefined);
    await fsp.rm(path.join(storageDir, badName), { force: true }).catch(() => undefined);
  });

  it('a valid file passes; a tampered file fails with the controlled Persian error', async () => {
    await expect(verifyStoredFileChecksum(okName, sha256Hex(CONTENT))).resolves.toBeUndefined();
    await expect(verifyStoredFileChecksum(badName, sha256Hex(CONTENT))).rejects.toMatchObject({ status: 500 });
    // no expected checksum → legacy rows still verify as pass-through
    await expect(verifyStoredFileChecksum(okName, null)).resolves.toBeUndefined();
    // missing file → 410
    await expect(verifyStoredFileChecksum(generateStoredName('missing.pdf'), 'x')).rejects.toMatchObject({ status: 410 });
  });

  it('streamStoredFile streams the exact bytes (no full-buffer API contract)', async () => {
    const web = streamStoredFile(okName);
    const reader = web.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    expect(total).toBe(CONTENT.length);
    expect(Buffer.concat(chunks.map(Buffer.from)).equals(CONTENT)).toBe(true);
  });
});

describe('download gate + missing-content reporting', () => {
  it('pending files are NOT downloadable (assertDownloadable throws 410)', () => {
    expect(() => assertDownloadable(FILE_STATUS_PENDING)).toThrow(ApiError);
    expect(() => assertDownloadable(FILE_STATUS_COMMITTED)).not.toThrow();
  });

  it('committed rows without physical content are REPORTED (never deleted or fabricated)', async () => {
    const ghost = generateStoredName(`${TAG}.pdf`);
    const row = await db.file.create({ data: mkRow({ storedName: ghost, status: FILE_STATUS_COMMITTED, originalName: `${TAG}-ghost.pdf` }) });
    const report = await sweepStalePendingFiles();
    const entry = report.missingContentRows.find((m) => m.id === row.id);
    expect(entry).toBeDefined();            // reported…
    expect(await db.file.findUnique({ where: { id: row.id } })).not.toBeNull(); // …not deleted
    expect(fs.existsSync(path.join(storageDir, ghost))).toBe(false);             // …not fabricated
    await db.file.delete({ where: { id: row.id } });
  });
});
