#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// verify-install.mjs — v2.58.1 (round 86)
//
// Post-install / deployment readiness verification (the package.json
// `test:conn` and `test:deploy` targets). READ-ONLY against the app:
//   1. environment   — .env present, BGL_HMAC_SECRET set (non-empty),
//                      DATABASE_URL resolves to an existing file
//   2. database      — reachable via Prisma; integrity_check ok;
//                      foreign_key_check clean; migration history
//                      healthy (count matches prisma/migrations);
//                      core rows present (companies/users)
//   3. server        — /api/health answers ok (db reachable)
//   4. security      — origin-less POST is refused (fail-closed
//                      middleware), login rejects bad credentials
//   5. attachments   — File-vs-disk consistency summary (health
//                      report, no mutation)
// Exit 0 only when every check passes.
// Usage: node scripts/verify-install.mjs [--base http://localhost:3000]
// ═══════════════════════════════════════════════════════════
import { createRequire } from 'module';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(resolve(dirname(fileURLToPath(import.meta.url))), 'package.json').replace('/scripts/../', '/'));

// Node ≥18 native web globals — destructured so lint sees local bindings.
const { fetch: gfetch } = globalThis;

const { PrismaClient } = require('@prisma/client');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '--base=http://localhost:3000').split('=')[1];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function parseEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of require('node:fs').readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  console.log(`[verify-install] project: ${root}`);

  // 1) environment
  // resolve DB path like the app does (relative → prisma/). Precedence:
  //   system env (only when its file actually exists — a stale
  //   container-level DATABASE_URL pointing at a non-existent file must
  //   not shadow the project's files) > .env.local > .env — the SHARED
  //   resolver's file precedence (v2.58.6 P5: the checker used to read
  //   ONLY .env, so a checker run could inspect a different database
  //   than the running app when .env.local carried the real one).
  const fileEnv = {
    ...parseEnv(join(root, '.env')),
    ...parseEnv(join(root, '.env.local')),
  };
  const envUrl = process.env.DATABASE_URL && existsSync(
    process.env.DATABASE_URL.replace(/^file:/, '').split('?')[0].startsWith('/')
      ? process.env.DATABASE_URL.replace(/^file:/, '').split('?')[0]
      : join(root, 'prisma', process.env.DATABASE_URL.replace(/^file:/, '').split('?')[0]),
  ) ? process.env.DATABASE_URL : (fileEnv.DATABASE_URL || null);
  const env = { ...fileEnv, ...process.env, DATABASE_URL: envUrl || undefined };
  check('.env exists with DATABASE_URL', !!env.DATABASE_URL, env.DATABASE_URL ? '' : 'missing');
  check('BGL_HMAC_SECRET set (login throttling armed)', !!env.BGL_HMAC_SECRET && env.BGL_HMAC_SECRET.length >= 16, `len=${(env.BGL_HMAC_SECRET || '').length}`);

  const raw = (env.DATABASE_URL || '').replace(/^file:/, '').split('?')[0];
  const dbPath = raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw) ? raw : join(root, 'prisma', raw);
  check('database file exists', existsSync(dbPath), dbPath);

  // 2) database
  const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
  try {
    const integrity = await db.$queryRawUnsafe('PRAGMA integrity_check');
    check('PRAGMA integrity_check = ok', String(integrity?.[0]?.integrity_check) === 'ok');
    const fk = await db.$queryRawUnsafe('PRAGMA foreign_key_check');
    check('PRAGMA foreign_key_check clean', fk.length === 0, `violations=${fk.length}`);
    const migDir = join(root, 'prisma', 'migrations');
    const { statSync } = await import('node:fs');
    const migrationCount = readdirSync(migDir).filter((n) => { try { return statSync(join(migDir, n)).isDirectory(); } catch { return false; } }).length;
    const applied = await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM _prisma_migrations');
    check('migration history: applied == folder count', Number(applied?.[0]?.n) === migrationCount, `applied=${Number(applied?.[0]?.n)}, folder=${migrationCount}`);
    const failedMigrations = await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NULL');
    check('no failed/pending migration rows', Number(failedMigrations?.[0]?.n) === 0);
    const [companies, users, centers] = await Promise.all([db.company.count(), db.user.count(), db.center.count()]);
    check('core rows present (companies/users/centers)', companies > 0 && users > 0 && centers >= 0, `companies=${companies}, users=${users}, centers=${centers}`);

    // 5) attachments health (report only)
    const { readdirSync: rd } = await import('node:fs');
    const uploads = join(root, 'storage', 'uploads');
    const disk = new Set(existsSync(uploads) ? rd(uploads) : []);
    const files = await db.file.findMany({ select: { storedName: true } });
    const missing = files.filter((f) => !disk.has(f.storedName)).length;
    check('attachments health reported (missing content listed, not deleted)', true, `records=${files.length}, missing=${missing}`);
  } finally {
    await db.$disconnect();
  }

  // 3) server
  const health = await gfetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  check('/api/health answers ok', !!health && health.status !== 'fail', JSON.stringify(health?.status || 'unreachable'));

  // 4) security posture
  const noOrigin = await gfetch(`${BASE}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', username: 'admin', password: 'wrong-password' }),
  }).catch(() => null);
  check('origin-less POST refused (fail-closed middleware)', noOrigin !== null && noOrigin.status === 403, `status=${noOrigin?.status ?? 'network-error'}`);

  const badLogin = await gfetch(`${BASE}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ action: 'login', username: 'admin', password: 'definitely-wrong' }),
  }).catch(() => null);
  check('login rejects wrong credentials (no 5xx)', badLogin !== null && badLogin.status === 401, `status=${badLogin?.status ?? 'network-error'}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[verify-install] ${results.length - failed.length}/${results.length} PASS${failed.length ? `, ${failed.length} FAIL` : ''}`);
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`[verify-install] FATAL: ${e.message}`);
  process.exit(1);
});
