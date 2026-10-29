// ══════════════════════════════════════════════════════════════
// resolve-env.mjs — v2.58.5 (user finding R7)
//
// THE ONE shared environment resolver for EVERY script that must see
// the same database / storage the RUNNING APP sees: start.mjs (the
// launcher), files-health.ts (the health CLI), setup-db-heal.mjs
// (the upgrade heal), and the maintenance/backup tools.
//
// Precedence — IDENTICAL to the app's real runtime contract:
//   1. a non-empty process.env value (the system environment always
//      wins — same rule start.mjs applies and Next.js applies);
//   2. .env.local;
//   3. .env;
//   4. the documented default.
// (An EMPTY-STRING value is treated as unset — matches the health
// CLI's old behavior and keeps `STORAGE_DIR=` honest.)
//
// Path semantics — the Prisma contract, reproduced exactly:
//   • DATABASE_URL `file:` — a RELATIVE path resolves against
//     <root>/prisma (the schema dir, how the generated client
//     resolves it); an absolute POSIX/Windows/UNC path passes
//     through; a missing URL defaults to <root>/prisma/dev.db;
//   • STORAGE_DIR (v2.58.6, user P4) — a RELATIVE custom dir resolves
//     against the PROJECT ROOT (the app's real runtime contract:
//     start.mjs spawns the server with cwd=<root>, so the launcher,
//     the app and every CLI agree on ONE directory no matter where
//     the CLI was launched). An absolute path (POSIX / Windows drive /
//     UNC) passes through unchanged. Existing installs are protected:
//     when the LEGACY cwd-anchored location has data and the
//     root-anchored one is empty, the data location wins (never a
//     silent switch to a fresh empty folder); when BOTH have data the
//     root contract wins and the conflict is REPORTED (resolveAppEnv
//     exposes storageConflict — files are never moved speculatively).
//
// The resolver NEVER mutates process.env and NEVER prints values
// (callers may print resolved PATHS — paths are not secrets).
// ══════════════════════════════════════════════════════════════
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Parse one .env-style file → Record<string,string>. Missing or
 *  unreadable file → {} (the caller decides what that means). */
export function parseEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const vars = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function isAbsolutePath(p) {
  if (!p) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return true; // POSIX / UNC
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true; // Windows drive letter
  return false;
}

/** Prisma's SQLite semantics with the v2.47.0 launcher normalization:
 *  a RELATIVE path resolves against <root>/prisma, and a leading
 *  "prisma/" segment is STRIPPED first — the exact rule start.mjs
 *  applies, so the CLI and the launcher always agree on ONE file
 *  (the historical doubled <root>/prisma/prisma/dev.db bug). */
export function resolveDatabaseFile(url, root) {
  const prismaDir = join(root, 'prisma');
  if (!url || !url.startsWith('file:')) return join(prismaDir, 'dev.db');
  const raw = url.slice('file:'.length).split('?')[0];
  if (isAbsolutePath(raw)) return raw;
  const normalized = raw.replace(/^(?:\.\/)?prisma[\\/]/, '');
  return resolve(prismaDir, normalized);
}

/** The absolute `file:` URL form (what start.mjs sets for the server). */
export function resolveDatabaseUrl(url, root) {
  if (!url || !url.startsWith('file:')) return url ?? '';
  const qIdx = url.indexOf('?');
  const queryPart = qIdx === -1 ? '' : url.slice(qIdx);
  return `file:${resolveDatabaseFile(url, root).replace(/\\/g, '/')}${queryPart}`;
}

/** Does a directory exist AND hold at least one entry? (best-effort) */
function dirHasContent(p) {
  try {
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

/**
 * The effective STORAGE_DIR (absolute):
 *  • absolute POSIX / Windows-drive / UNC value → unchanged;
 *  • relative value → anchored at the PROJECT ROOT (never the CLI's
 *    cwd — v2.58.6 P4), with the legacy-data guard below;
 *  • empty/unset → <root>/storage/uploads.
 * Legacy guard: when the OLD cwd-anchored destination has data and
 * the root-anchored one is empty, the data location wins — an
 * existing install is never silently switched to an empty folder.
 */
export function resolveStorageDir(value, root, cwd = process.cwd()) {
  const v = value ? String(value).trim() : '';
  if (v) {
    if (isAbsolutePath(v)) return v;
    const rootAnchored = resolve(root, v);
    const cwdAnchored = resolve(cwd, v);
    if (rootAnchored !== cwdAnchored && dirHasContent(cwdAnchored) && !dirHasContent(rootAnchored)) {
      return cwdAnchored; // the data location wins (report, never move)
    }
    return rootAnchored;
  }
  return join(root, 'storage', 'uploads');
}

/**
 * The shared app-environment snapshot.
 * v2.58.6 (P4): storageConflict reports a relative STORAGE_DIR whose
 * legacy cwd-anchored location ALSO holds data — callers print both
 * paths and the migration guidance; nothing is moved automatically.
 * @returns {{
 *   root: string,
 *   databaseUrl: string | undefined,
 *   databaseSource: 'process-env' | '.env.local' | '.env' | 'default',
 *   dbFile: string,
 *   storageDir: string,
 *   storageSource: 'process-env' | '.env.local' | '.env' | 'default',
 *   storageConflict: { effective: string, legacy: string } | null,
 * }}
 */
export function resolveAppEnv({ root, env = process.env }) {
  const envLocal = parseEnvFile(join(root, '.env.local'));
  const envFile = parseEnvFile(join(root, '.env'));
  const pick = (key) => {
    if (env[key] !== undefined && env[key] !== '') return { value: env[key], source: 'process-env' };
    if (envLocal[key] !== undefined && envLocal[key] !== '') return { value: envLocal[key], source: '.env.local' };
    if (envFile[key] !== undefined && envFile[key] !== '') return { value: envFile[key], source: '.env' };
    return { value: undefined, source: 'default' };
  };
  const db = pick('DATABASE_URL');
  const storage = pick('STORAGE_DIR');
  const storageDir = resolveStorageDir(storage.value, root);

  // P4 conflict report: a relative STORAGE_DIR whose LEGACY cwd-anchored
  // location also holds data — the effective dir follows the app contract;
  // the legacy dir is reported so the operator can merge/migrate by hand.
  let storageConflict = null;
  const sv = storage.value ? String(storage.value).trim() : '';
  if (sv && !isAbsolutePath(sv)) {
    const rootAnchored = resolve(root, sv);
    const cwdAnchored = resolve(process.cwd(), sv);
    if (rootAnchored !== cwdAnchored && dirHasContent(cwdAnchored)) {
      storageConflict = { effective: storageDir, legacy: cwdAnchored };
    }
  }

  return {
    root,
    databaseUrl: db.value,
    databaseSource: db.source,
    dbFile: resolveDatabaseFile(db.value, root),
    storageDir,
    storageSource: storage.source,
    storageConflict,
  };
}
