#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
//  start — v2.30.0 cross-platform standalone launcher
//
//  WHY THIS EXISTS: `node .next/standalone/server.js` alone does NOT
//  read the project's .env — the standalone server chdirs into
//  .next/standalone at boot (see its generated server.js), so on a
//  plain local machine (Windows/macOS/Linux, no systemd/PM2) every
//  server-side env var is simply missing: health honestly answers
//  {"status":"degraded","db":"fail"} while Prisma logs
//  "Environment variable not found: DATABASE_URL".
//
//  And worse: the Prisma client BUNDLED into .next/standalone resolves
//  a RELATIVE SQLite path against `.next/standalone/node_modules/
//  .prisma/client/` — a hidden, table-less database file that the next
//  `next build` deletes. /api/health still said "ok" against it
//  (SELECT 1 never opens the file): a textbook silent failure, found
//  while verifying the local Windows production run.
//
//  What this launcher does instead:
//   1. loads .env (then .env.local) — real environment variables
//      always win, mirroring Next.js dev precedence;
//   2. resolves a relative DATABASE_URL against <projectRoot>/prisma —
//      the exact semantics of `npm run dev` and the Prisma CLI — so dev
//      and `npm start` always share ONE database file. v2.47.0: legacy
//      "./prisma/dev.db" values (the round-≤46 starter .env) are
//      normalized — they used to resolve to the hidden doubled path
//      <root>/prisma/prisma/dev.db, silently bypassing the shipped
//      database (see resolveDatabaseUrl below);
//   3. binds to loopback by default (an IP-valued HOSTNAME from the
//      environment is honored — e.g. HOSTNAME=0.0.0.0 for LAN tests);
//   4. FAILS FAST in production when BGL_HMAC_SECRET is missing (the
//      login throttling would otherwise run on a public, guessable
//      fallback secret — a warn is not enough for a real deployment);
//   5. spawns the standalone server and forwards Ctrl+C / terminate.
//
//  Works identically on Windows / macOS / Linux — no PM2/systemd
//  needed for a local production run. Real server deployments keep
//  using systemd/PM2 with an ABSOLUTE DATABASE_URL per DEPLOYMENT.md.
// ════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// v2.58.5 (R7) — the SHARED environment resolver: the exact same file
// parsing + precedence + path semantics the health CLI and the db-heal
// use. One contract, three consumers, zero drift.
import { parseEnvFile, resolveDatabaseUrl, resolveStorageDir } from './lib/resolve-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. Minimal .env loader (comments, blank lines, KEY="value") ──
// (the parser itself lives in scripts/lib/resolve-env.mjs — shared)

const envPath = resolve(root, '.env');
const envLocalPath = resolve(root, '.env.local');
if (!existsSync(envPath) && !existsSync(envLocalPath)) {
  console.error(
    '[start] .env not found — copy .env.example to .env first (setup.bat / setup.sh does this for you).',
  );
  process.exit(1);
}
const fileVars = { ...parseEnvFile(envPath), ...parseEnvFile(envLocalPath) };
for (const [k, v] of Object.entries(fileVars)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

// ── 2. DATABASE_URL: relative → absolute against <root>/prisma ──
// (identical resolution to `npm run dev` / Prisma CLI, so both modes
// point at the very same SQLite file — the shared resolver's rule)
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[start] DATABASE_URL is not set — add it to .env (see .env.example).');
  process.exit(1);
}
process.env.DATABASE_URL = resolveDatabaseUrl(dbUrl, root);

// ── 2b. STORAGE_DIR: relative → absolute against <root> (v2.58.6 P4) ──
// the child server's cwd IS <root>, but normalizing here makes the
// contract explicit and cwd-proof for exotic spawn setups.
if (process.env.STORAGE_DIR) {
  process.env.STORAGE_DIR = resolveStorageDir(process.env.STORAGE_DIR, root);
}

if (!process.env.BGL_HMAC_SECRET) {
  // v2.47.0 — fail-fast (audit phase 1). The old behavior was a plain
  // warning while the auth layer silently fell back to a PUBLIC,
  // hard-coded dev secret: on any real deployment that made the login
  // brute-force throttle keys predictable by an attacker who simply
  // read the source. A missing secret must STOP the server, not warn.
  // NOTE: this launcher ONLY exists to start the production standalone
  // server (the generated server.js forces NODE_ENV="production"); an
  // unset NODE_ENV therefore counts as production here. An explicit
  // NODE_ENV=development keeps the old warn for local HTTP testing.
  const isProduction = !process.env.NODE_ENV || process.env.NODE_ENV === 'production';
  if (isProduction) {
    console.error(
      '[start] BGL_HMAC_SECRET is not set. The login throttle cannot run on the public fallback secret in production.\n' +
        '[start] Fix: add a line like  BGL_HMAC_SECRET="<64 hex chars>"  to .env (generate with:\n' +
        "[start]   node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" ) and start again.",
    );
    process.exit(1);
  }
  console.warn(
    '[start] WARNING: BGL_HMAC_SECRET is empty — generate one into .env before real production use.',
  );
}

// ── 3. Bind address: loopback by default, honor an explicit IP ──
// (a bare machine-name HOSTNAME leaked from some shells would make the
// generated server.js bind to a bogus interface — only IPs are honored)
const requested = process.env.HOSTNAME;
process.env.HOSTNAME = requested && isIP(requested) ? requested : '127.0.0.1';

// ── 4. Spawn the standalone server ──
const serverJs = resolve(root, '.next', 'standalone', 'server.js');
if (!existsSync(serverJs)) {
  console.error('[start] .next/standalone/server.js not found — run `npm run build` first.');
  process.exit(1);
}

console.log(`[start] DATABASE_URL → ${process.env.DATABASE_URL}`);
console.log(`[start] listening on  → http://${process.env.HOSTNAME}:${process.env.PORT || 3000}`);
console.log('[start] press Ctrl+C to stop (or: npm run stop)');

const child = spawn(process.execPath, [serverJs], {
  stdio: 'inherit',
  env: { ...process.env },
  cwd: root,
});
child.on('error', (err) => {
  console.error('[start] failed to launch the standalone server:', err.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code === null ? (signal ? 1 : 0) : code);
});
function forward(signal) {
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}
process.on('SIGINT', () => forward('SIGTERM'));
process.on('SIGTERM', () => forward('SIGTERM'));
