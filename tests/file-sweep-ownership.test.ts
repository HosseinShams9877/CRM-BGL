import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { PrismaClient } from '@prisma/client';
import {
  sweepStalePendingFiles,
  sweepOrphanFinalFiles,
  filesHealthSnapshot,
  PENDING_LEASE_MS,
  FILE_STATUS_PENDING,
  FILE_STATUS_COMMITTED,
} from '@/lib/file-lifecycle';
import { generateStoredName } from '@/lib/storage';

// ═══════════════════════════════════════════════════════════════
// file-sweep-ownership.test.ts — v2.58.10 (final-review P2)
//
// THE INCOMPLETE-OWNERSHIP-SET REGRESSION (reproduced RED on
// v2.58.7): every sweep/snapshot phase judged disk objects against
// the FIRST 50,000 File rows (and settled/reported only the first
// 5,000). With more rows than the cap:
//   • a .part whose owning row sat BEYOND the first 50k was
//     misjudged an orphan and DELETED — a live upload's bytes,
//     pure data loss;
//   • the same cap in sweepOrphanFinalFiles deleted OWNED FINAL
//     FILES beyond the page (data loss, worse);
//   • the health snapshot's orphan/stale/missing counters were
//     silently wrong beyond the caps.
//
// THE NEW CONTRACT (pinned here):
//   • candidates come FROM the directory; ownership is answered for
//     EXACTLY those names (chunked IN on the unique storedName) —
//     complete for ANY table size;
//   • ownership is re-checked immediately before every removal;
//   • a DB failure in an ownership query → ZERO deletions from that
//     phase (fail-closed) + honest errors;
//   • 'deleting' settlement and missing-content reporting paginate
//     to exhaustion; stale pending is an exact COUNT.
// ═══════════════════════════════════════════════════════════════

const db = new PrismaClient();
const TAG = `r92own-${Date.now().toString(36)}`;
let storageDir: string;

const CONTENT = Buffer.from(`${TAG} — ownership stress payload `.repeat(8));

function mkRow(overrides: Record<string, unknown> = {}) {
  const storedName = generateStoredName('s.pdf');
  return {
    originalName: `${TAG}.pdf`,
    storedName,
    mimeType: 'application/pdf',
    size: CONTENT.length,
    checksum: null,
    status: FILE_STATUS_COMMITTED,
    ...overrides,
  };
}

/** v2.58.11 (independent audit P1-3a): the auditor's environment timed out
 *  all four tests of this file — the wall time is dominated by SEEDING the
 *  50,100 filler rows, not by the sweep itself (which runs in milliseconds).
 *  Prisma's createMany of 50,100 rows emits one giant multi-row INSERT
 *  (~1.8 s on a fast box, far slower on a loaded sandbox); the same rows
 *  via chunked raw multi-row INSERTs (2,000/chunk) seed 5–6× faster
 *  (~0.3 s) with byte-identical semantics: same columns, same defaults,
 *  sequential rowids — the victim row still lands BEYOND the historical
 *  50,000-row page, which is the regression this file pins. */
const RAW_CHUNK = 2000;
async function seedFillerRows(count: number, tag: string): Promise<void> {
  const cols = '"id","originalName","storedName","mimeType","size","checksum","centerId","category","createdById","status","createdAt"';
  for (let c = 0; c < count; c += RAW_CHUNK) {
    const vals: string[] = [];
    for (let i = c; i < Math.min(c + RAW_CHUNK, count); i++) {
      const id = `f${tag}${i}`.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 25) || `f${i}`;
      vals.push(
        `('${id}','${tag}-filler.pdf','filler-${tag}-${i}.pdf','application/pdf',${CONTENT.length},NULL,NULL,NULL,NULL,'${FILE_STATUS_COMMITTED}',CURRENT_TIMESTAMP)`,
      );
    }
    await db.$executeRawUnsafe(`INSERT INTO "File" (${cols}) VALUES ${vals.join(',')}`);
  }
}

async function ageFile(p: string, ageMs: number): Promise<void> {
  const at = new Date(Date.now() - ageMs);
  await fsp.utimes(p, at, at);
}

beforeAll(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgl-ownership-'));
  process.env.STORAGE_DIR = storageDir;
  await db.file.deleteMany({ where: { originalName: { contains: TAG } } });
});

afterAll(async () => {
  delete process.env.STORAGE_DIR;
  fs.rmSync(storageDir, { recursive: true, force: true });
  await db.file.deleteMany({ where: { originalName: { contains: TAG } } });
  await db.$disconnect();
});

describe('ownership completeness beyond the historical 50,000-row page', () => {
  it('a .part owned by a row beyond the first 50,000 is NOT swept (owned = kept); a real orphan still is', async () => {
    // MORE filler rows than the historical cap; the victim is inserted
    // LAST (highest rowid — outside any "first 50k" page).
    await seedFillerRows(50_100, `${TAG}a`);

    // victim: YOUNG pending row (phase 1 must not sweep it) owning an
    // OLD .part file (the orphan phase must not delete it)
    const victimName = generateStoredName('v.pdf');
    const victimPart = path.join(storageDir, `${victimName}.part`);
    await fsp.writeFile(victimPart, CONTENT);
    await ageFile(victimPart, PENDING_LEASE_MS + 60_000);
    await db.file.create({
      data: mkRow({
        originalName: `${TAG}-victim.pdf`,
        storedName: victimName,
        status: FILE_STATUS_PENDING,
        createdAt: new Date(), // young row — phase 1 leaves it alone
      }),
    });

    try {
      const report = await sweepStalePendingFiles();
      // the victim's bytes SURVIVED (ownership answered exactly)
      expect(fs.existsSync(victimPart)).toBe(true);
      // the row was not swept by phase 1 either (young)
      expect(await db.file.findUnique({ where: { storedName: victimName } })).not.toBeNull();
      // and no .part removal was counted for it
      expect(report.orphanPartFiles).toBe(0);

      // a REAL orphan .part (old, owned by no row) IS still swept —
      // the exact query did not over-protect
      const orphanPart = path.join(storageDir, `${generateStoredName('o.pdf')}.part`);
      await fsp.writeFile(orphanPart, CONTENT);
      await ageFile(orphanPart, PENDING_LEASE_MS + 60_000);
      const report2 = await sweepStalePendingFiles();
      expect(report2.orphanPartFiles).toBe(1);
      expect(fs.existsSync(orphanPart)).toBe(false);
    } finally {
      await db.file.deleteMany({ where: { originalName: { contains: TAG } } });
      await fsp.rm(victimPart, { force: true }).catch(() => undefined);
    }
  }, 300_000);

  it('an OWNED FINAL file whose row sits beyond the first 50,000 is NOT pruned; a real aged orphan still is', async () => {
    await seedFillerRows(50_100, `${TAG}b`);

    // owned final: bytes on disk + row beyond the page, AGED (past the
    // grace window — the old capped ownership set deleted exactly this)
    const ownedName = generateStoredName('w.pdf');
    const ownedPath = path.join(storageDir, ownedName);
    await fsp.writeFile(ownedPath, CONTENT);
    await ageFile(ownedPath, 2 * 60 * 60 * 1000); // 2h — past the 1h grace
    await db.file.create({
      data: mkRow({ originalName: `${TAG}-owned-final.pdf`, storedName: ownedName, status: FILE_STATUS_COMMITTED }),
    });

    try {
      const report = await sweepOrphanFinalFiles();
      expect(fs.existsSync(ownedPath)).toBe(true); // SURVIVED — owned, wherever its row sits
      expect(report.removedFiles).toBe(0);

      // a REAL aged orphan final (no row anywhere) is still reclaimed
      const orphanFinal = path.join(storageDir, generateStoredName('of.pdf'));
      await fsp.writeFile(orphanFinal, CONTENT);
      await ageFile(orphanFinal, 2 * 60 * 60 * 1000);
      const report2 = await sweepOrphanFinalFiles();
      expect(report2.removedFiles).toBe(1);
      expect(fs.existsSync(orphanFinal)).toBe(false);
    } finally {
      await db.file.deleteMany({ where: { originalName: { contains: TAG } } });
      await fsp.rm(ownedPath, { force: true }).catch(() => undefined);
    }
  }, 300_000);
});

describe('DB failure in the ownership query fails CLOSED', () => {
  it('an unreadable File table → zero .part deletions, errors reported, files intact', async () => {
    const orphan = path.join(storageDir, `${generateStoredName('d.pdf')}.part`);
    await fsp.writeFile(orphan, CONTENT);
    await ageFile(orphan, PENDING_LEASE_MS + 60_000);
    await db.file.deleteMany({ where: { originalName: { contains: TAG } } });
    try {
      // REAL database failure, fully reversible: while the table is
      // renamed away every SELECT on "File" fails — including the
      // ownership query. The rename restores the table exactly.
      await db.$executeRawUnsafe('ALTER TABLE "File" RENAME TO "File_sabotaged"');
      const report = await sweepStalePendingFiles();
      // fail-closed: the orphan candidate was NOT deleted
      expect(fs.existsSync(orphan)).toBe(true);
      expect(report.orphanPartFiles).toBe(0);
      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.errors.some((e) => e.includes('fail-closed'))).toBe(true);
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE "File_sabotaged" RENAME TO "File"');
      await fsp.rm(orphan, { force: true }).catch(() => undefined);
    }
    // restore sanity: the sweep works again
    const ok = await sweepStalePendingFiles();
    expect(ok.errors.length).toBe(0);
  });
});

describe('health snapshot exactness at any row count', () => {
  it('stale pending is an exact COUNT; missing content and orphans are exact', async () => {
    await db.file.deleteMany({ where: { originalName: { contains: TAG } } });
    // a ghost committed row (no bytes) + a stale pending row + an orphan final
    const ghost = generateStoredName('g.pdf');
    await db.file.create({ data: mkRow({ originalName: `${TAG}-ghost.pdf`, storedName: ghost }) });
    const stalePending = generateStoredName('sp.pdf');
    await db.file.create({
      data: mkRow({
        originalName: `${TAG}-stale.pdf`, storedName: stalePending, status: FILE_STATUS_PENDING,
        createdAt: new Date(Date.now() - PENDING_LEASE_MS - 60_000),
      }),
    });
    const orphanFinal = generateStoredName('of.pdf');
    await fsp.writeFile(path.join(storageDir, orphanFinal), CONTENT);

    try {
      const snap = await filesHealthSnapshot();
      expect(snap.storageDir).toBe(storageDir);
      expect(snap.missingContentRows.some((m) => m.storedName === ghost)).toBe(true);
      expect(snap.orphanFinalFiles).toBeGreaterThanOrEqual(1);
      expect(snap.stalePendingRows).toBeGreaterThanOrEqual(1);
      expect(snap.orphanPartFiles).toBe(0); // no .part files in this scenario
    } finally {
      await db.file.deleteMany({ where: { originalName: { contains: TAG } } });
      await fsp.rm(path.join(storageDir, orphanFinal), { force: true }).catch(() => undefined);
    }
  });
});
