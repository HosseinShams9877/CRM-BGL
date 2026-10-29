import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { PrismaClient } from '@prisma/client';
import {
  storeFileLifecycle,
  sweepOrphanFinalFiles,
  FILE_STATUS_COMMITTED,
} from '@/lib/file-lifecycle';
import { generateStoredName } from '@/lib/storage';

// ═══════════════════════════════════════════════════════════════
// orphan-file-prune.test.ts — v2.58.7 (stage 7 — «File بدون DB Record
// حذف امن شود»).
//
// The pre-fix state: physical FINAL files with no owning DB row were
// counted by the health snapshot but NEVER collectable (only .part
// temps were swept). The new sweepOrphanFinalFiles safely deletes them:
//   • past the grace window (default 1h — in-flight uploads are
//     .part+pending-row, never bare finals, but the window is kept)
//   • only names passing the STRICT stored-name shape check (a weird
//     name is reported, never touched)
//   • DB rows are never touched; owned files are never touched
// ═══════════════════════════════════════════════════════════════

const db = new PrismaClient();
const TAG = `r97orp-${Date.now().toString(36)}`;
let storageDir: string;

const AGED_MS = 2 * 60 * 60 * 1000; // 2h — past the 1h grace window
const YOUNG_MS = 5 * 60 * 1000; // 5 min — inside the grace window

function validStoredName(): string {
  return generateStoredName(`${TAG}.pdf`);
}

function touchAge(p: string, ageMs: number): void {
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(p, at, at);
}

beforeAll(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgl-orphan-'));
  process.env.STORAGE_DIR = storageDir;
  await db.file.deleteMany({ where: { originalName: { contains: TAG } } });
});

afterAll(async () => {
  delete process.env.STORAGE_DIR;
  fs.rmSync(storageDir, { recursive: true, force: true });
  await db.file.deleteMany({ where: { originalName: { contains: TAG } } });
  await db.$disconnect();
});

describe('sweepOrphanFinalFiles — the safe orphan-bytes reclaim', () => {
  it('removes ONLY the aged, valid-shaped orphans; young/invalid/owned/.part untouched', async () => {
    // 1) OWNED file (row + bytes) — must survive untouched
    const owned = await storeFileLifecycle({
      bytes: Buffer.from(`${TAG} owned content`),
      originalName: `${TAG}-owned.pdf`,
      mimeType: 'application/pdf',
    });
    // 2) AGED orphan final (no row, 2h old) — the reclaim target
    const agedName = validStoredName();
    fs.writeFileSync(path.join(storageDir, agedName), Buffer.from(`${TAG} aged orphan`));
    touchAge(path.join(storageDir, agedName), AGED_MS);
    // 3) YOUNG orphan final (no row, 5 min old) — inside the grace window
    const youngName = validStoredName();
    fs.writeFileSync(path.join(storageDir, youngName), Buffer.from(`${TAG} young orphan`));
    touchAge(path.join(storageDir, youngName), YOUNG_MS);
    // 4) INVALID-named physical object — reported only, never touched
    fs.writeFileSync(path.join(storageDir, 'not-a-stored-name.txt'), Buffer.from('junk'));
    touchAge(path.join(storageDir, 'not-a-stored-name.txt'), AGED_MS);
    // 5) orphan .part — belongs to sweepStalePendingFiles, not this sweep
    const partName = `${validStoredName()}.part`;
    fs.writeFileSync(path.join(storageDir, partName), Buffer.from('partial'));
    touchAge(path.join(storageDir, partName), AGED_MS);

    const report = await sweepOrphanFinalFiles();

    expect(report.removedFiles).toBe(1); // exactly the aged valid orphan
    expect(report.skippedYoungFiles).toBe(1);
    expect(report.skippedInvalidNames).toEqual(['not-a-stored-name.txt']);
    expect(report.errors).toEqual([]);

    const entries = (await fsp.readdir(storageDir)).sort();
    expect(entries).toContain(owned.storedName); // owned survives
    expect(entries).toContain(youngName); // young survives
    expect(entries).toContain('not-a-stored-name.txt'); // invalid survives
    expect(entries).toContain(partName); // .part untouched
    expect(entries).not.toContain(agedName); // aged orphan gone

    const ownedRow = await db.file.findUnique({ where: { id: owned.id } });
    expect(ownedRow?.status).toBe(FILE_STATUS_COMMITTED);
    expect(fs.existsSync(path.join(storageDir, owned.storedName))).toBe(true);
  });

  it('is idempotent: a second run has nothing to remove', async () => {
    const report = await sweepOrphanFinalFiles();
    expect(report.removedFiles).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it('an empty storage dir is a clean no-op', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgl-orphan-empty-'));
    const prev = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = emptyDir;
    try {
      const report = await sweepOrphanFinalFiles();
      expect(report.removedFiles).toBe(0);
      expect(report.errors).toEqual([]);
    } finally {
      process.env.STORAGE_DIR = prev;
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
