import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { planRotation, snapshotFileName, createDbSnapshot } from '@/lib/backup-snapshot';

describe('snapshotFileName (pure)', () => {
  it('formats bgl-snapshot-YYYYMMDD-HHMMSSmmm.db', () => {
    const name = snapshotFileName(new Date(2026, 8, 3, 14, 5, 9, 7));
    expect(name).toBe('bgl-snapshot-20260903-140509007.db');
  });
  it('unique within a second is NOT guaranteed but is deterministic for the instant', () => {
    const d = new Date(2026, 0, 1, 0, 0, 0);
    expect(snapshotFileName(d)).toBe(snapshotFileName(d));
  });
});

describe('planRotation (pure)', () => {
  const files = (mtimes: number[]) => mtimes.map((mtimeMs, i) => ({ name: `f${i}.db`, mtimeMs }));

  it('keeps the newest N and deletes the rest', () => {
    const { keep, delete: del } = planRotation(files([5, 1, 9, 3, 7]), 3);
    expect(keep).toEqual(['f2.db', 'f4.db', 'f0.db']);
    expect(del).toEqual(['f3.db', 'f1.db']);
  });
  it('fewer files than the limit → nothing deleted', () => {
    const { delete: del } = planRotation(files([1, 2]), 14);
    expect(del).toEqual([]);
  });
  it('keep=1 never deletes everything (floor at 1)', () => {
    const { keep, delete: del } = planRotation(files([1, 2, 3]), 0);
    expect(keep).toEqual(['f2.db']);
    expect(del).toEqual(['f1.db', 'f0.db']);
  });
});

describe('createDbSnapshot (against the isolated test db)', () => {
  it('creates a quick_check-ok snapshot + manifest with matching sha256', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r72-backup-'));
    (process.env as Record<string, string>).BGL_BACKUP_DIR = dir;

    const manifest = await createDbSnapshot('cli');

    const abs = join(dir, manifest.file);
    expect(existsSync(abs)).toBe(true);
    expect(statSync(abs).size).toBe(manifest.bytes);
    expect(manifest.quickCheck).toBe('ok');
    expect(manifest.createdVia).toBe('cli');
    // checksum round-trip
    const { readFileSync } = await import('fs');
    const sha = createHash('sha256').update(readFileSync(abs)).digest('hex');
    expect(sha).toBe(manifest.sha256);
    // manifest file exists next to it
    expect(existsSync(`${abs}.manifest.json`)).toBe(true);
    // table counts are real numbers
    expect(manifest.tableCounts.users).toBeGreaterThan(0);
    expect(manifest.tableCounts.centers).toBeGreaterThan(0);
    // jalali date present
    expect(manifest.jalaliDate).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
    // only our snapshot in the temp dir (plus its manifest)
    const names = readdirSync(dir);
    expect(names.filter((n) => n.endsWith('.db'))).toHaveLength(1);

    delete (process.env as Record<string, string>).BGL_BACKUP_DIR;
  });

  it('a second snapshot in the same second gets a distinct name (no clobber)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r72-backup2-'));
    (process.env as Record<string, string>).BGL_BACKUP_DIR = dir;
    const a = await createDbSnapshot('cli');
    const b = await createDbSnapshot('cli');
    expect(a.file).not.toBe(b.file);
    delete (process.env as Record<string, string>).BGL_BACKUP_DIR;
  });
});

describe('manifest shape contract (consumed by UI + restore script)', () => {
  it('manifest JSON parses back with all required keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r72-backup3-'));
    (process.env as Record<string, string>).BGL_BACKUP_DIR = dir;
    const manifest = await createDbSnapshot('cli');
    writeFileSync(join(dir, 'probe.json'), JSON.stringify(manifest));
    const parsed = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    for (const key of ['file', 'bytes', 'sha256', 'createdAt', 'jalaliDate', 'appVersion', 'quickCheck', 'tableCounts', 'createdVia']) {
      expect(parsed, `missing key: ${key}`).toHaveProperty(key);
    }
    delete (process.env as Record<string, string>).BGL_BACKUP_DIR;
  });
});
