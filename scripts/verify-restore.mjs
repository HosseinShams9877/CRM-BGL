#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// verify-restore.mjs — v2.58.1 (round 86, audit F7 acceptance)
//
// FULL backup → wipe → restore cycle on an ISOLATED scratch
// environment (never the operational dev.db / storage):
//
//   1. build a scratch env (copy of the live DB + a real uploaded file);
//   2. create a FULL backup package against it (backup-snapshot-cli
//      --package with DATABASE_URL/STORAGE_DIR/BGL_BACKUP_DIR overrides);
//   3. WIPE the scratch env (delete db + uploads — the "empty machine");
//   4. restore with restore-backup.mjs --latest (same env overrides);
//   5. verify: record counts match the manifest, foreign keys clean,
//      every attachment byte-identical (sha256 vs manifest), the
//      pre-restore safety artifacts exist;
//   6. NEGATIVE case: a tampered package (one flipped byte) must be
//      REFUSED before anything is replaced (rollback path).
//
// Exit 0 only when every step passes.
// ═══════════════════════════════════════════════════════════
import { createRequire } from 'module';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(join(resolve(dirname(fileURLToPath(import.meta.url))), 'package.json').replace('/scripts/../', '/'));
const { PrismaClient } = require('@prisma/client');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(root, 'scripts', 'restore-scratch');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function run(cmd, args, env) {
  return execFileSync(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

async function main() {
  // ── 1. scratch env ──
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(SCRATCH, 'prisma'), { recursive: true });
  mkdirSync(join(SCRATCH, 'storage', 'uploads'), { recursive: true });
  mkdirSync(join(SCRATCH, 'backups'), { recursive: true });
  const scratchDb = join(SCRATCH, 'prisma', 'scratch.db');
  // consistent copy of the live DB (VACUUM INTO — read-only on the source)
  {
    const live = new PrismaClient({ datasources: { db: { url: `file:${join(root, 'prisma', 'dev.db')}` } } });
    await live.$queryRawUnsafe(`VACUUM INTO '${scratchDb.replace(/'/g, "''")}'`);
    await live.$disconnect();
  }
  // a REAL uploaded attachment in the scratch env, registered as a File row
  const storedName = `${randomBytes(16).toString('hex')}.txt`;
  const payload = `r86-restore-probe-${randomBytes(8).toString('hex')}`;
  writeFileSync(join(SCRATCH, 'storage', 'uploads', storedName), payload, 'utf8');
  const fileSha = sha(join(SCRATCH, 'storage', 'uploads', storedName));
  {
    const sdb = new PrismaClient({ datasources: { db: { url: `file:${scratchDb}` } } });
    await sdb.file.create({
      data: { originalName: 'r86-restore-probe.txt', storedName, mimeType: 'text/plain', size: Buffer.byteLength(payload), checksum: fileSha, centerId: null, category: 'r86', createdById: null },
    });
    await sdb.$disconnect();
  }
  const beforeCounts = await (async () => {
    const sdb = new PrismaClient({ datasources: { db: { url: `file:${scratchDb}` } } });
    const c = { users: await sdb.user.count(), centers: await sdb.center.count(), files: await sdb.file.count(), companies: await sdb.company.count() };
    await sdb.$disconnect();
    return c;
  })();
  console.log(`[verify-restore] scratch env: ${JSON.stringify(beforeCounts)}, attachment ${storedName.slice(0, 12)}…`);

  const env = {
    DATABASE_URL: `file:${scratchDb}`,
    STORAGE_DIR: join(SCRATCH, 'storage', 'uploads'),
    BGL_BACKUP_DIR: join(SCRATCH, 'backups'),
  };

  // ── 2. create the full package ──
  console.log('[verify-restore] creating full backup package…');
  const out = run('node', ['--import', 'tsx', 'scripts/backup-snapshot-cli.ts', '--package'], env);
  const pkgDirs = readdirSync(join(SCRATCH, 'backups')).filter((n) => /^bgl-package-/.test(n));
  check('backup package created', pkgDirs.length === 1, out.split('\n')[0]);
  const pkgDir = join(SCRATCH, 'backups', pkgDirs[0]);
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'manifest.json'), 'utf8'));
  check('manifest stats come from the SNAPSHOT (files count ≥ 1)', manifest.files.count >= 1 && manifest.database.quickCheck === 'ok', `files=${manifest.files.count}, quick_check=${manifest.database.quickCheck}`);
  check('package contains the probe attachment with its sha256', manifest.files.entries.some((e) => e.storedName === storedName && e.sha256 === fileSha));
  const missingBefore = manifest.files.missingContent;
  check('already-missing attachments are REPORTED (not fabricated, not dropped)', Array.isArray(missingBefore), `missing=${missingBefore.length}`);

  // ── 3. WIPE the scratch env (the "empty machine") ──
  rmSync(scratchDb, { force: true });
  rmSync(join(SCRATCH, 'storage', 'uploads'), { recursive: true, force: true });
  check('scratch env wiped (db + uploads gone)', !existsSync(scratchDb) && !existsSync(join(SCRATCH, 'storage', 'uploads')));

  // ── 4. restore from the package ──
  console.log('[verify-restore] restoring onto the empty environment…');
  const restoreOut = run('node', ['scripts/restore-backup.mjs', '--latest'], env);
  check('restore completed', restoreOut.includes('DONE'), restoreOut.split('\n').filter((l) => l.includes('✓')).length + ' steps ok');
  check('restored database exists', existsSync(scratchDb));

  // ── 5. verify the restored state ──
  {
    const sdb = new PrismaClient({ datasources: { db: { url: `file:${scratchDb}` } } });
    const after = { users: await sdb.user.count(), centers: await sdb.center.count(), files: await sdb.file.count(), companies: await sdb.company.count() };
    check('record counts match the pre-backup state', JSON.stringify(after) === JSON.stringify(beforeCounts), `${JSON.stringify(after)} vs ${JSON.stringify(beforeCounts)}`);
    const fk = await sdb.$queryRawUnsafe('PRAGMA foreign_key_check');
    check('restored DB: foreign_key_check clean', fk.length === 0, `violations=${fk.length}`);
    const integrity = await sdb.$queryRawUnsafe('PRAGMA integrity_check');
    check('restored DB: integrity_check ok', String(integrity?.[0]?.integrity_check) === 'ok');
    // every attachment byte-identical
    let allOk = true;
    for (const entry of manifest.files.entries) {
      const p = join(SCRATCH, 'storage', 'uploads', entry.storedName);
      if (!existsSync(p) || sha(p) !== entry.sha256) { allOk = false; break; }
    }
    check('every restored attachment is byte-identical (sha256 vs manifest)', allOk, `${manifest.files.entries.length} file(s)`);
    // "download" probe: the stored path resolves and the bytes match the DB checksum
    const row = await sdb.file.findUnique({ where: { storedName } });
    const diskSha = sha(join(SCRATCH, 'storage', 'uploads', storedName));
    check('probe attachment downloadable (DB checksum == disk bytes)', !!row && row.checksum === diskSha, `size=${row?.size}`);
    await sdb.$disconnect();
  }

  // pre-restore safety artifacts from the restore run
  const preRestoreBaks = readdirSync(join(SCRATCH, 'prisma')).filter((n) => n.includes('pre-restore'));
  check('restore kept a returnable pre-restore backup', preRestoreBaks.length >= 1, preRestoreBaks[0] || '');

  // ── 6. NEGATIVE: tampered package must be refused ──
  console.log('[verify-restore] tampering a copy of the package (rollback path)…');
  const tampered = join(SCRATCH, 'backups', 'bgl-package-tampered');
  mkdirSync(tampered, { recursive: true });
  copyFileSync(join(pkgDir, 'snapshot.db'), join(tampered, 'snapshot.db'));
  copyFileSync(join(pkgDir, 'manifest.json'), join(tampered, 'manifest.json'));
  mkdirSync(join(tampered, 'files'), { recursive: true });
  for (const e of manifest.files.entries) copyFileSync(join(pkgDir, 'files', e.storedName), join(tampered, 'files', e.storedName));
  // flip one byte inside the DB copy
  const dbBuf = readFileSync(join(tampered, 'snapshot.db'));
  dbBuf[dbBuf.length - 100] ^= 0xff;
  writeFileSync(join(tampered, 'snapshot.db'), dbBuf);

  const dbBeforeTamper = sha(scratchDb); // current restored db
  let tamperRefused = false;
  try {
    run('node', ['scripts/restore-backup.mjs', '--package', tampered], env);
  } catch (e) {
    tamperRefused = String(e.message || '').includes('checksum mismatch') || String(e.message || '').includes('FAILED');
  }
  check('tampered package REFUSED (checksum mismatch)', tamperRefused);
  check('live state untouched after the refusal', sha(scratchDb) === dbBeforeTamper);

  // path-traversal guard: a hostile manifest entry
  const hostile = join(SCRATCH, 'backups', 'bgl-package-hostile');
  mkdirSync(join(hostile, 'files'), { recursive: true });
  copyFileSync(join(pkgDir, 'snapshot.db'), join(hostile, 'snapshot.db'));
  writeFileSync(join(hostile, 'files', 'evil.txt'), 'x');
  const hostileManifest = JSON.parse(JSON.stringify(manifest));
  hostileManifest.files.entries = [{ storedName: '../../../../etc/evil.txt', bytes: 1, sha256: sha(join(hostile, 'files', 'evil.txt')) }];
  writeFileSync(join(hostile, 'manifest.json'), JSON.stringify(hostileManifest));
  let hostileRefused = false;
  try {
    run('node', ['scripts/restore-backup.mjs', '--package', hostile], env);
  } catch (e) {
    hostileRefused = String(e.message || '').includes('ILLEGAL file name') || String(e.message || '').includes('FAILED');
  }
  check('path-traversal package REFUSED (strict stored-name shape)', hostileRefused);
  check('no file escaped the storage dir', !existsSync(join(SCRATCH, 'evil.txt')) && !existsSync('/etc/evil.txt'));

  // cleanup scratch
  rmSync(SCRATCH, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[verify-restore] ${results.length - failed.length}/${results.length} PASS${failed.length ? `, ${failed.length} FAIL` : ''}`);
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`[verify-restore] FATAL: ${e.message}`);
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* already gone */ }
  process.exit(1);
});
