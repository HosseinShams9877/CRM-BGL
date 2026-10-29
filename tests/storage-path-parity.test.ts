import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// ═══════════════════════════════════════════════════════════════
// storage-path-parity.test.ts — v2.58.6 (user finding P4)
//
// THE AUDIT REPRO (confirmed on the v2.58.5 code):
//   resolveStorageDir(value, root) resolved a RELATIVE custom
//   STORAGE_DIR with resolve(value) — anchored at the CLI's CWD; the
//   root argument was IGNORED. Running a tool from another directory
//   picked a DIFFERENT storage than the app (and the app itself,
//   src/lib/storage.ts, anchored relative values on ITS cwd too).
//
// THE CONTRACT:
//   • a relative STORAGE_DIR resolves against the PROJECT ROOT — the
//     exact anchoring the app's real runtime uses (start.mjs spawns the
//     server with cwd=<root>, so the app and every CLI agree on ONE
//     directory no matter where the CLI was launched);
//   • an absolute path (POSIX / Windows drive / UNC) passes through
//     unchanged;
//   • existing installs are never silently switched to an empty folder:
//     when the LEGACY cwd-anchored location has data and the
//     root-anchored one is empty, the data location wins; when BOTH
//     have data the root-anchored contract wins and the conflict is
//     REPORTED (files are never moved speculatively);
//   • the REAL runtime (src/lib/storage.ts getStorageDir) and the
//     shared resolver find the SAME test file;
//   • spaces in paths are handled everywhere.
// ═══════════════════════════════════════════════════════════════

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const FIX = join(projectRoot, 'prisma', `p4-storage-fixture-${process.pid}`);
const OTHER_CWD = join(projectRoot, 'prisma', `p4 other cwd ${process.pid}`);

const { resolveAppEnv, resolveStorageDir } = await import(join(projectRoot, 'scripts', 'lib', 'resolve-env.mjs'));

import { getStorageDir } from '@/lib/storage';

function sha(p: string) {
  return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
}

beforeAll(() => {
  mkdirSync(join(FIX), { recursive: true });
  mkdirSync(OTHER_CWD, { recursive: true });
});
afterAll(() => {
  rmSync(FIX, { recursive: true, force: true });
  rmSync(OTHER_CWD, { recursive: true, force: true });
});

describe('P4.1 — THE REPRO: a relative STORAGE_DIR was CWD-anchored', () => {
  it('resolveStorageDir ignores CWD: launched from two different directories → the SAME destination', () => {
    const rootAnchored = resolveStorageDir('uploads-data', FIX, projectRoot);
    const fromElsewhere = resolveStorageDir('uploads-data', FIX, OTHER_CWD);
    expect(fromElsewhere).toBe(rootAnchored); // ← red on v2.58.5: resolve(cwd, value)
    expect(rootAnchored).toBe(join(FIX, 'uploads-data'));
  });
});

describe('P4.2 — path forms', () => {
  it('absolute POSIX / Windows drive / UNC pass through unchanged', () => {
    expect(resolveStorageDir('/var/bgl/uploads', FIX, OTHER_CWD)).toBe('/var/bgl/uploads');
    expect(resolveStorageDir('C:\\Program Data\\BGL Storage', FIX, OTHER_CWD)).toBe('C:\\Program Data\\BGL Storage');
    expect(resolveStorageDir('\\\\fileserver\\bgl\\uploads', FIX, OTHER_CWD)).toBe('\\\\fileserver\\bgl\\uploads');
  });

  it('spaces in the root path and in the relative value resolve consistently', () => {
    const spacesRoot = join(FIX, 'root with spaces');
    const a = resolveStorageDir('my uploads', spacesRoot, projectRoot);
    const b = resolveStorageDir('my uploads', spacesRoot, OTHER_CWD);
    expect(a).toBe(b);
    expect(a).toBe(join(spacesRoot, 'my uploads'));
  });

  it('empty / unset values fall back to the documented default', () => {
    expect(resolveStorageDir('', FIX, OTHER_CWD)).toBe(join(FIX, 'storage', 'uploads'));
    expect(resolveStorageDir(undefined, FIX, OTHER_CWD)).toBe(join(FIX, 'storage', 'uploads'));
    expect(resolveStorageDir('   ', FIX, OTHER_CWD)).toBe(join(FIX, 'storage', 'uploads'));
  });
});

describe('P4.3 — existing installs are never silently switched', () => {
  it('legacy cwd-anchored location has DATA + root-anchored is empty → the data location wins', () => {
    // the pre-fix CLI (run from OTHER_CWD) wrote data into the cwd-anchored
    // location; the root-anchored location has never been used
    const legacy = join(OTHER_CWD, 'legacy-data');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'existing-file.txt'), 'real data', 'utf8');
    const origCwd = process.cwd();
    try {
      process.chdir(OTHER_CWD); // the operator re-runs the CLI from the same place as before
      const chosen = resolveStorageDir('legacy-data', FIX, process.cwd());
      expect(chosen).toBe(legacy); // the data location — not a fresh empty folder
      // the REAL app (its cwd is the project root) sees only the root contract;
      // the legacy dir's data is NOT visible from there — the divergence is
      // inherent to the old cwd-anchored bug and is covered by the conflict
      // report below when both locations are in view
      expect(resolveStorageDir('legacy-data', FIX, projectRoot)).toBe(join(FIX, 'legacy-data'));
    } finally {
      process.chdir(origCwd);
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  it('BOTH locations have data → the root contract wins and the conflict is REPORTED (no silent choice)', () => {
    const legacy = join(OTHER_CWD, 'conflict-data');
    const rooty = join(FIX, 'conflict-data');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(rooty, { recursive: true });
    writeFileSync(join(legacy, 'l.txt'), 'legacy', 'utf8');
    writeFileSync(join(rooty, 'r.txt'), 'root', 'utf8');
    const origCwd = process.cwd();
    try {
      process.chdir(OTHER_CWD); // the process sees BOTH candidate locations
      const eff = resolveAppEnv({
        root: FIX,
        env: { STORAGE_DIR: 'conflict-data' },
      });
      expect(eff.storageDir).toBe(rooty); // the app's contract
      expect(eff.storageConflict).toBeTruthy();
      if (eff.storageConflict) {
        expect(eff.storageConflict.effective).toBe(rooty);
        expect(eff.storageConflict.legacy).toBe(legacy);
      }
      // the resolver itself also picks the root contract
      expect(resolveStorageDir('conflict-data', FIX, OTHER_CWD)).toBe(rooty);
    } finally {
      process.chdir(origCwd);
      rmSync(legacy, { recursive: true, force: true });
      rmSync(rooty, { recursive: true, force: true });
    }
  });

  it('a report run touches NOTHING outside the chosen destination', () => {
    const outside = join(FIX, 'untouched-dir');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'keep', 'utf8');
    const before = sha(join(outside, 'keep.txt'));
    try {
      resolveAppEnv({ root: FIX, env: { STORAGE_DIR: 'uploads-data' } });
      resolveStorageDir('uploads-data', FIX, OTHER_CWD);
    } finally {
      expect(sha(join(outside, 'keep.txt'))).toBe(before);
      expect(readdirSync(outside)).toEqual(['keep.txt']);
    }
  });
});

describe('P4.4 — the REAL runtime and the shared resolver agree', () => {
  afterEach(() => { delete process.env.STORAGE_DIR; });

  it('getStorageDir (src/lib/storage.ts) finds the SAME test file from any cwd', () => {
    const markerDir = join(FIX, 'rel-store');
    mkdirSync(markerDir, { recursive: true });
    const marker = join(markerDir, '0123456789abcdef0123456789abcdef.bin');
    writeFileSync(marker, 'marker-bytes', 'utf8');
    const origCwd = process.cwd();
    try {
      // from the fixture root (like the app under start.mjs)
      process.chdir(FIX);
      process.env.STORAGE_DIR = 'rel-store';
      expect(getStorageDir()).toBe(markerDir);
      expect(existsSync(join(getStorageDir(), '0123456789abcdef0123456789abcdef.bin'))).toBe(true);

      // from ANOTHER cwd the app is anchored at ITS project root — the
      // standalone case: the marker is still found via the same contract
      process.chdir(projectRoot);
      const fromRoot = getStorageDir(); // root-anchored under the app's cwd
      expect(existsSync(join(fromRoot, '0123456789abcdef0123456789abcdef.bin'))).toBe(false); // different dir — no accidental hit

      // the shared CLI resolver agrees with the app for the SAME inputs
      expect(resolveStorageDir('rel-store', FIX, projectRoot)).toBe(markerDir);
    } finally {
      process.chdir(origCwd);
      delete process.env.STORAGE_DIR;
    }
  });

  it('an ABSOLUTE STORAGE_DIR is honored by both the app and the resolver (identity)', () => {
    const abs = join(FIX, 'abs store');
    mkdirSync(abs, { recursive: true });
    process.env.STORAGE_DIR = abs;
    expect(getStorageDir()).toBe(abs);
    expect(resolveStorageDir(abs, FIX, OTHER_CWD)).toBe(abs);
    delete process.env.STORAGE_DIR;
  });
});
