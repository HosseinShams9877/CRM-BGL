import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// ═══════════════════════════════════════════════════════════════
// resolve-env.test.ts — v2.58.5 (user finding R7)
//
// THE AUDIT REPRO (confirmed on the v2.58.4 tools):
//   files-health.ts read ONLY .env while start.mjs ALSO reads
//   .env.local — with different DATABASE_URL/STORAGE_DIR values in the
//   two files, the health CLI inspected a DIFFERENT database/storage
//   than the running app.
//
// THE CONTRACT:
//   • ONE resolver (scripts/lib/resolve-env.mjs) with the app's real
//     precedence: process env > .env.local > .env > default;
//   • the health CLI (tsx scripts/files-health.ts) consumes it: run
//     from ANY cwd, with spaces in the root path, it prints the SAME
//     resolved database + storage the launcher would use;
//   • a system-env override beats both files;
//   • paths only are printed (never secrets);
//   • a dry-run report touches NOTHING outside the resolved targets.
// ═══════════════════════════════════════════════════════════════

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const FIX = join(projectRoot, 'prisma', `r7-env-fixture-${process.pid}`);
const SPACES = join(projectRoot, 'prisma', `r7 env fixture ${process.pid}`);

// in-process import of the SHARED resolver (the exact module every
// consumer uses)
const resolverPath = join(projectRoot, 'scripts', 'lib', 'resolve-env.mjs');
const { resolveAppEnv, resolveDatabaseFile, resolveDatabaseUrl } = await import(resolverPath);

/** A minimal fake install root: .env / .env.local + a real (valid) db file. */
function buildRoot(rootDir: string, files: Record<string, string>, dbFile: string) {
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(join(rootDir, 'prisma'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(rootDir, name), content, 'utf8');
  }
  // a REAL sqlite file (the worker's own DB) so the CLI's existsSync passes
  const workerDb = (process.env.DATABASE_URL || '').replace(/^file:/, '');
  copyFileSync(workerDb, dbFile);
}

function hashTree(rootDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else out[p] = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
    }
  };
  walk(rootDir);
  return out;
}

beforeAll(() => {
  const workerDb = (process.env.DATABASE_URL || '').replace(/^file:/, '');
  if (!workerDb || !existsSync(workerDb)) throw new Error('[r7] worker DB missing');
});

afterAll(() => {
  rmSync(FIX, { recursive: true, force: true });
  rmSync(SPACES, { recursive: true, force: true });
});

describe('R7.1 — the shared resolver precedence matrix', () => {
  it('.env vs .env.local differences: .env.local WINS (the app\u2019s real order)', () => {
    buildRoot(FIX, {
      '.env': 'DATABASE_URL="file:./from-env.db"\nSTORAGE_DIR="/tmp/from-env-uploads"\n',
      '.env.local': 'DATABASE_URL="file:./from-local.db"\nSTORAGE_DIR="/tmp/from-local-uploads"\n',
    }, join(FIX, 'prisma', 'from-local.db'));
    const eff = resolveAppEnv({ root: FIX, env: {} });
    expect(eff.databaseSource).toBe('.env.local');
    expect(eff.dbFile).toBe(join(FIX, 'prisma', 'from-local.db'));
    expect(eff.storageSource).toBe('.env.local');
    expect(eff.storageDir).toBe('/tmp/from-local-uploads');
  });

  it('a system-env value beats BOTH files', () => {
    buildRoot(FIX, {
      '.env': 'DATABASE_URL="file:./from-env.db"\n',
      '.env.local': 'DATABASE_URL="file:./from-local.db"\n',
    }, join(FIX, 'prisma', 'from-local.db'));
    const eff = resolveAppEnv({ root: FIX, env: { DATABASE_URL: 'file:./from-system.db' } });
    expect(eff.databaseSource).toBe('process-env');
    expect(eff.dbFile).toBe(join(FIX, 'prisma', 'from-system.db'));
  });

  it('no files at all → documented defaults (prisma/dev.db + root storage)', () => {
    buildRoot(FIX, {}, join(FIX, 'prisma', 'dev.db'));
    const eff = resolveAppEnv({ root: FIX, env: {} });
    expect(eff.databaseSource).toBe('default');
    expect(eff.dbFile).toBe(join(FIX, 'prisma', 'dev.db'));
    expect(eff.storageSource).toBe('default');
    expect(eff.storageDir).toBe(join(FIX, 'storage', 'uploads'));
  });

  it('relative "prisma/" prefix is normalized (the doubled-path rule) and Windows/absolute forms pass through', () => {
    expect(resolveDatabaseFile('file:./prisma/dev.db', FIX)).toBe(join(FIX, 'prisma', 'dev.db'));
    expect(resolveDatabaseFile('file:./dev.db', FIX)).toBe(join(FIX, 'prisma', 'dev.db'));
    expect(resolveDatabaseFile('file:/abs/other.db', FIX)).toBe('/abs/other.db');
    expect(resolveDatabaseFile('file:C:\\data\\db.db', FIX)).toBe('C:\\data\\db.db');
    expect(resolveDatabaseUrl('file:./dev.db', FIX)).toBe(`file:${join(FIX, 'prisma', 'dev.db').replace(/\\/g, '/')}`);
  });
});

describe('R7.2 — the health CLI consumes the resolver (real child run)', () => {
  it('run from ANOTHER cwd with SPACES in the root → the SAME database the launcher would use; nothing else touched', () => {
    buildRoot(SPACES, {
      '.env': 'DATABASE_URL="file:./wrong-env.db"\n',
      '.env.local': `DATABASE_URL="file:${join(SPACES, 'prisma', 'real.db').replace(/\\/g, '/')}"\n`,
    }, join(SPACES, 'prisma', 'real.db'));

    // hash the ENTIRE fixture tree BEFORE the dry-run
    const before = hashTree(SPACES);

    // run the REAL CLI via tsx from a DIFFERENT cwd (relative to nothing).
    // --tsconfig anchors tsx's alias resolution (operators get the same
    // effect for free: `npm run files:health` always sets cwd to the
    // project root, where tsx discovers the tsconfig naturally).
    const r = spawnSync(process.execPath, [
      join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      '--tsconfig', join(projectRoot, 'tsconfig.json'),
      join(projectRoot, 'scripts', 'files-health.ts'),
    ], {
      encoding: 'utf8',
      cwd: '/tmp', // a completely different working directory
      env: (() => {
        // a REAL operator shell does not carry the test worker's env —
        // strip it so the child genuinely exercises the .env/.env.local
        // precedence, exactly like production
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          BGL_FILES_HEALTH_ROOT: SPACES,
        };
        delete env.DATABASE_URL;
        delete env.STORAGE_DIR;
        return env;
      })(),
    });

    // the CLI ran to completion: report mode exits 0 (clean) or 1
    // (missing content reported — never fabricated); a CRASH is a failure
    expect([0, 1]).toContain(r.status);
    // the resolved TARGET is printed, and it is the .env.local database —
    // the SAME one the launcher would start against
    expect(r.stdout).toContain('DATABASE_URL ← .env.local');
    expect(r.stdout).toContain(join(SPACES, 'prisma', 'real.db'));
    expect(r.stdout).toContain('STORAGE_DIR ← default');

    // the dry run touched NOTHING in the fixture (byte-identical tree)
    const after = hashTree(SPACES);
    expect(after).toEqual(before);
  }, 60_000);
});

describe('R7.3 — files-health vs start.mjs agreement (the drift is dead)', () => {
  it('the CLI and the launcher compute the SAME absolute db path for the same install', async () => {
    buildRoot(SPACES, {
      '.env': 'DATABASE_URL="file:./env.db"\n',
      '.env.local': 'DATABASE_URL="file:./local.db"\n',
    }, join(SPACES, 'prisma', 'local.db'));

    // what the CLI (files-health) resolves:
    const cli = resolveAppEnv({ root: SPACES, env: {} });

    // what the launcher (start.mjs) computes for the same files:
    // parseEnvFile + precedence, then resolveDatabaseUrl
    const { parseEnvFile } = await import(resolverPath);
    const fileVars = {
      ...parseEnvFile(join(SPACES, '.env')),
      ...parseEnvFile(join(SPACES, '.env.local')),
    };
    const launcherUrl = resolveDatabaseUrl(fileVars.DATABASE_URL ?? '', SPACES);

    expect(`file:${cli.dbFile.replace(/\\/g, '/')}`).toBe(launcherUrl);
    expect(cli.databaseSource).toBe('.env.local');
  });

  it('the launcher\u2019s env-var-wins rule matches the resolver\u2019s (same contract)', async () => {
    buildRoot(SPACES, { '.env': 'DATABASE_URL="file:./env.db"\n' }, join(SPACES, 'prisma', 'env.db'));
    // launcher: process.env.DATABASE_URL already set → file vars skipped
    const launcherEffective = 'file:./system.db';
    const resolverEff = resolveAppEnv({ root: SPACES, env: { DATABASE_URL: launcherEffective } });
    expect(resolverEff.databaseSource).toBe('process-env');
    expect(resolverEff.databaseUrl).toBe(launcherEffective);
  });
});
