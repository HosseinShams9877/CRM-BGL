// ═══════════════════════════════════════════════════════════
// backup-snapshot.ts — v2.47.0 (audit: «MAX_ROWS=2000 بدون restore»)
//
// The old /api/backup "export" returns a truncated JSON dump of a few
// tables (2000 rows each) — better than the fake rows it replaced, but
// it is NOT a backup: no file snapshot, no checksum, no manifest, and
// nothing on this earth can restore it back into the app.
//
// This module provides a REAL, verifiable, restorable backup:
//   1. WAL-checkpoint + `VACUUM INTO` — SQLite's online-backup: a
//      transactionally consistent snapshot file while the CRM keeps
//      running (same mechanism as scripts/backup-cron.mjs, v2.29.0).
//   2. quick_check verification ON THE SNAPSHOT — an unverified
//      backup is not a backup.
//   3. sha256 checksum + manifest (row counts of the core tables,
//      app version, timestamps) stored next to the snapshot.
//   4. rotation — keep the newest N snapshots, delete the rest.
// Restore: scripts/restore-backup.mjs --file <snapshot> (or --latest).
// ═══════════════════════════════════════════════════════════
import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { db } from '@/lib/db';
import { toJalaliString } from '@/lib/jalali';
import { getStorageDir } from '@/lib/storage';

export const BACKUP_DIR_NAME = 'backups';
export const DEFAULT_KEEP = 14;

export interface BackupManifest {
  file: string;            // snapshot file name (inside backups/)
  bytes: number;
  sha256: string;
  createdAt: string;       // ISO
  jalaliDate: string;
  appVersion: string;
  quickCheck: string;      // 'ok' expected
  tableCounts: Record<string, number>;
  createdVia: 'api' | 'cli';
}

export function backupDir(): string {
  if (process.env.BGL_BACKUP_DIR) return resolve(process.env.BGL_BACKUP_DIR);
  return join(process.cwd(), BACKUP_DIR_NAME);
}

/** PURE (unit-tested): which snapshot files survive rotation. */
export function planRotation(
  files: { name: string; mtimeMs: number }[],
  keep = DEFAULT_KEEP,
): { keep: string[]; delete: string[] } {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    keep: sorted.slice(0, Math.max(1, keep)).map((f) => f.name),
    delete: sorted.slice(Math.max(1, keep)).map((f) => f.name),
  };
}

/** PURE (unit-tested): snapshot file name for a given instant (ms included —
 *  rapid successive snapshots, e.g. tests or a double-click, never clobber). */
export function snapshotFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `bgl-snapshot-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${String(now.getMilliseconds()).padStart(3, '0')}.db`
  );
}

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function sqlStringLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ═══════════════════════════════════════════════════════════
//  v2.58.11 (Vercel deployment fix) — SQLite-only raw SQL guard
//
//  The snapshot/package machinery below is SQLite-native: `PRAGMA
//  wal_checkpoint(TRUNCATE)`, `VACUUM INTO` and `PRAGMA quick_check` are
//  SQLite statements with no PostgreSQL equivalent (Postgres has no file to
//  copy and no quick_check). Against the production PostgreSQL datasource
//  they used to blow up as a raw `syntax error at or near "PRAGMA"`
//  (SQLSTATE 42601). Fail closed instead with an honest, actionable error;
//  the JSON "export" action of /api/backup still works on every engine.
// ═══════════════════════════════════════════════════════════
function assertSqliteDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.startsWith('file:')) {
    throw new Error(
      'پشتیبان‌گیری فیزیکی (snapshot/package) فقط روی دیتابیس SQLite ممکن است؛ ' +
        'دیتابیس تنظیم‌شده PostgreSQL است. از عملیات «خروجی JSON» (export) استفاده کنید، ' +
        'یا برای پشتیبان PostgreSQL از ابزار pg_dump استفاده کنید.',
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  v2.58.11 (Vercel deployment fix) — TURBOPACK TRACING
//
//  Every fs call below targets backupDir(), which is resolved from
//  env (BACKUP_DIR / STORAGE_DIR) at RUNTIME — it cannot be scoped
//  statically. Turbopack's tracer therefore treats each of these as
//  "dynamic filesystem access", falls back to tracing the WHOLE
//  project, and copies it into .next/standalone (26 build warnings;
//  .env and dev.db leak into the server bundle and postbuild's
//  hygiene gate fails the build). The /*turbopackIgnore: true*/
//  comments are Turbopack's documented opt-out for exactly this
//  case: "this access is intentionally runtime-scoped — don't trace
//  it". The accesses themselves are unchanged.
// ════════════════════════════════════════════════════════════════

async function countCoreTables(dbUrl: string): Promise<Record<string, number>> {
  // v2.58.1 (audit F7): counts are taken from THE SNAPSHOT ITSELF (a
  // dedicated probe connection), never from the live database — the live
  // DB keeps mutating while the backup is being built, so a manifest
  // stamped from it could disagree with the snapshot it describes.
  const { PrismaClient } = await import('@prisma/client');
  const probe = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  try {
    const [companies, centers, products, users, salesDocuments, issuedInvoices, activities, sessions] =
      await Promise.all([
        probe.company.count(),
        probe.center.count(),
        probe.product.count(),
        probe.user.count(),
        probe.salesDocument.count(),
        probe.issuedInvoice.count(),
        probe.activity.count(),
        probe.session.count({ where: { revokedAt: null } }),
      ]);
    return { companies, centers, products, users, salesDocuments, issuedInvoices, activities, activeSessions: sessions };
  } finally {
    await probe.$disconnect();
  }
}

/**
 * Create + verify a snapshot. Throws on any failure — callers surface a
 * Persian error (a backup that "probably worked" is worse than a failure).
 */
export async function createDbSnapshot(createdVia: 'api' | 'cli' = 'cli'): Promise<BackupManifest> {
  assertSqliteDatabase();
  const dir = backupDir();

  // 1) fold the WAL into the main file so the snapshot is complete
  await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');

  const fileName = snapshotFileName();
  const abs = join(dir, fileName);
  if (existsSync(abs)) {
    throw new Error(`فایل پشتیبان «${fileName}» همین حالا وجود دارد — یک ثانیه بعد دوباره تلاش کنید.`);
  }

  // 2) consistent online snapshot
  await db.$queryRawUnsafe(`VACUUM INTO ${sqlStringLiteral(abs)}`);

  // 3) verify integrity ON THE SNAPSHOT (not the live db)
  const { PrismaClient } = await import('@prisma/client');
  const probe = new PrismaClient({ datasources: { db: { url: `file:${abs}` } } });
  let quickCheck: string;
  try {
    const rows = (await probe.$queryRawUnsafe('PRAGMA quick_check')) as Array<{ quick_check?: string }>;
    quickCheck = String(rows?.[0]?.quick_check ?? 'unknown');
  } finally {
    await probe.$disconnect();
  }
  if (quickCheck !== 'ok') {
    try { unlinkSync(abs); } catch { /* leave the bad file for inspection if unlink fails */ }
    throw new Error(`پشتیبان ساخته شد اما آزمون صحت آن پاس نشد (quick_check=${quickCheck}) — کنار گذاشته شد.`);
  }

  // 4) manifest — stats measured on the SNAPSHOT (see countCoreTables)
  const manifest: BackupManifest = {
    file: fileName,
    bytes: statSync(abs).size,
    sha256: sha256File(abs),
    createdAt: new Date().toISOString(),
    jalaliDate: toJalaliString(new Date()),
    appVersion: String(process.env.npm_package_version || 'unknown'),
    quickCheck,
    tableCounts: await countCoreTables(`file:${abs}`),
    createdVia,
  };
  const { writeFile } = await import('fs/promises');
  await writeFile(join(dir, `${fileName}.manifest.json`), JSON.stringify(manifest, null, 2), 'utf8');

  return manifest;
}

/** Rotate: delete the oldest snapshots (and their manifests) beyond `keep`. */
export async function rotateSnapshots(keep = DEFAULT_KEEP): Promise<string[]> {
  const dir = backupDir();
  if (!existsSync(/*turbopackIgnore: true*/ dir)) return [];
  const files = readdirSync(/*turbopackIgnore: true*/ dir)
    .filter((n) => /^bgl-snapshot-.*\.db$/.test(n))
    .map((name) => ({ name, mtimeMs: statSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ dir, name)).mtimeMs }));
  const { delete: doomed } = planRotation(files, keep);
  for (const name of doomed) {
    try { unlinkSync(join(/*turbopackIgnore: true*/ dir, name)); } catch { /* already gone */ }
    try { unlinkSync(join(dir, `${name}.manifest.json`)); } catch { /* no manifest */ }
  }
  return doomed;
}

/** History for the settings UI: newest-first manifest entries. */
export async function listSnapshots(limit = 20): Promise<BackupManifest[]> {
  const dir = backupDir();
  if (!existsSync(/*turbopackIgnore: true*/ dir)) return [];
  const names = readdirSync(/*turbopackIgnore: true*/ dir)
    .filter((n) => /^bgl-snapshot-.*\.db$/.test(n))
    .map((name) => ({ name, mtimeMs: statSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((f) => f.name);
  const out: BackupManifest[] = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, `${name}.manifest.json`), 'utf8')) as BackupManifest);
    } catch {
      // snapshot without a manifest still shows a minimal entry
      out.push({
        file: name,
        bytes: statSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ dir, name)).size,
        sha256: '',
        createdAt: new Date(statSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ dir, name)).mtimeMs).toISOString(),
        jalaliDate: '',
        appVersion: 'unknown',
        quickCheck: 'unknown',
        tableCounts: {},
        createdVia: 'cli',
      });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  v2.58.1 (round 86, audit F7) — FULL BACKUP PACKAGE
//  (database + stored files, incl. voice notes, in one restorable dir)
//
//  A DB-only snapshot is a real backup of the LEDGER but not of the
//  attachments: File rows without their bytes are dead links after a
//  restore. A package is a directory under backups/:
//    bgl-package-<timestamp>/
//      ├─ manifest.json      (format/version/checksums/table counts —
//      │                      every stat measured on the SNAPSHOT itself)
//      ├─ snapshot.db        (VACUUM INTO + quick_check, sha256-verified)
//      └─ files/<storedName> (every physical file the File rows reference;
//                             sha256 per file, strict name shape)
//
//  Health honesty (no fabrication, no silent deletion):
//    • files.missingContent — File rows whose bytes are ALREADY absent on
//      disk are LISTED in the manifest, not invented and not dropped.
//    • files.orphanDiskFiles — physical files with no DB row (counted).
//  Secrets: the package deliberately contains NO .env values (HMAC key,
//  provider credentials) — see RESTORE-BACKUP.md prerequisites.
// ═══════════════════════════════════════════════════════════

/** Strict stored-name shape (mirrors storage.resolveStoredPath). */
const STORED_NAME_RE = /^[a-f0-9]{32}\.[a-z0-9]{1,8}$/;

export interface PackageFileEntry {
  storedName: string;
  bytes: number;
  sha256: string;
}

export interface BackupPackageManifest {
  format: 'bgl-crm-backup-package';
  version: 2;
  appVersion: string;
  createdAt: string;
  jalaliDate: string;
  createdVia: 'api' | 'cli';
  database: {
    file: string;
    bytes: number;
    sha256: string;
    quickCheck: string;
    tableCounts: Record<string, number>;
  };
  files: {
    count: number;
    totalBytes: number;
    entries: PackageFileEntry[];
    /** File rows whose bytes were already missing on disk — reported, never fabricated or deleted. */
    missingContent: string[];
    /** Physical files on disk with no DB row (count only). */
    orphanDiskFiles: number;
  };
}

export function packageDirName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `bgl-package-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${String(now.getMilliseconds()).padStart(3, '0')}`
  );
}

/**
 * Build a full backup package (DB + files). Throws on any failure.
 */
export async function createBackupPackage(
  createdVia: 'api' | 'cli' = 'cli',
): Promise<BackupPackageManifest> {
  assertSqliteDatabase();
  const root = backupDir();
  mkdirSync(root, { recursive: true });
  const pkgDir = join(root, packageDirName());
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(pkgDir, 'files'), { recursive: true });

  // 1) consistent DB snapshot into the package (WAL folded first — this
  //    is the same online mechanism createDbSnapshot uses, but the file
  //    lands INSIDE the package directory).
  await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
  const dbFile = join(pkgDir, 'snapshot.db');
  await db.$queryRawUnsafe(`VACUUM INTO ${sqlStringLiteral(dbFile)}`);

  // quick_check + sha256 of the snapshot
  const { PrismaClient } = await import('@prisma/client');
  const probe = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
  let quickCheck: string;
  try {
    const rows = (await probe.$queryRawUnsafe('PRAGMA quick_check')) as Array<{ quick_check?: string }>;
    quickCheck = String(rows?.[0]?.quick_check ?? 'unknown');
    if (quickCheck !== 'ok') {
      throw new Error(`آزمون صحت پشتیبان پاس نشد (quick_check=${quickCheck}) — بسته ساخته نشد.`);
    }
  } finally {
    await probe.$disconnect();
  }

  // 2) files: every File row's stored bytes + health report
  const storageDir = getStorageDir();
  const onDisk = existsSync(storageDir) ? new Set(readdirSync(storageDir).filter((n) => STORED_NAME_RE.test(n))) : new Set<string>();
  const fileRows = await db.file.findMany({ select: { storedName: true } });
  const entries: PackageFileEntry[] = [];
  const missingContent: string[] = [];
  for (const row of fileRows) {
    if (!STORED_NAME_RE.test(row.storedName)) {
      // legacy/odd name — copy verbatim only if it exists; the restore
      // side re-validates every name against the strict shape.
      if (!onDisk.has(row.storedName)) { missingContent.push(row.storedName); continue; }
    }
    const src = join(storageDir, row.storedName);
    if (!existsSync(src)) { missingContent.push(row.storedName); continue; }
    const dst = join(pkgDir, 'files', row.storedName);
    copyFileSync(src, dst);
    entries.push({ storedName: row.storedName, bytes: statSync(dst).size, sha256: sha256File(dst) });
  }
  const orphanDiskFiles = [...onDisk].filter((n) => !fileRows.some((r) => r.storedName === n)).length;

  const manifest: BackupPackageManifest = {
    format: 'bgl-crm-backup-package',
    version: 2,
    appVersion: String(process.env.npm_package_version || 'unknown'),
    createdAt: new Date().toISOString(),
    jalaliDate: toJalaliString(new Date()),
    createdVia,
    database: {
      file: 'snapshot.db',
      bytes: statSync(dbFile).size,
      sha256: sha256File(dbFile),
      quickCheck,
      tableCounts: await countCoreTables(`file:${dbFile}`),
    },
    files: {
      count: entries.length,
      totalBytes: entries.reduce((s, e) => s + e.bytes, 0),
      entries,
      missingContent,
      orphanDiskFiles,
    },
  };
  writeFileSync(join(pkgDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/** Newest-first list of package manifests (history UI + restore --latest). */
export async function listPackages(limit = 20): Promise<BackupPackageManifest[]> {
  const dir = backupDir();
  if (!existsSync(/*turbopackIgnore: true*/ dir)) return [];
  const names = readdirSync(/*turbopackIgnore: true*/ dir)
    .filter((n) => /^bgl-package-\d{8}-\d{9}$/.test(n))
    .map((name) => ({ name, mtimeMs: statSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((f) => f.name);
  const out: BackupPackageManifest[] = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, name, 'manifest.json'), 'utf8')) as BackupPackageManifest);
    } catch {
      // package without a readable manifest — minimal placeholder
      out.push({
        format: 'bgl-crm-backup-package',
        version: 2,
        appVersion: 'unknown',
        createdAt: new Date(statSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ dir, name)).mtimeMs).toISOString(),
        jalaliDate: '',
        createdVia: 'cli',
        database: { file: 'snapshot.db', bytes: 0, sha256: '', quickCheck: 'unknown', tableCounts: {} },
        files: { count: 0, totalBytes: 0, entries: [], missingContent: [], orphanDiskFiles: 0 },
      });
    }
  }
  return out;
}

/** Rotate packages: keep the newest N package directories. */
export async function rotatePackages(keep = DEFAULT_KEEP): Promise<string[]> {
  const dir = backupDir();
  if (!existsSync(/*turbopackIgnore: true*/ dir)) return [];
  const { rmSync } = await import('fs');
  const names = readdirSync(/*turbopackIgnore: true*/ dir)
    .filter((n) => /^bgl-package-\d{8}-\d{9}$/.test(n))
    .map((name) => ({ name, mtimeMs: statSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const doomed = names.slice(Math.max(1, keep)).map((n) => n.name);
  for (const name of doomed) {
    try { rmSync(join(/*turbopackIgnore: true*/ dir, name), { recursive: true, force: true }); } catch { /* already gone */ }
  }
  return doomed;
}
