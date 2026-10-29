#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
//  postbuild — v2.14.0 cross-platform static-asset copy
//
//  Replaces the previous Unix-only build step
//  (`cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/`),
//  which failed on regular Windows (cmd has no `cp`) even though
//  `next build` itself had succeeded. Uses node:fs.cpSync — identical
//  behaviour on Windows / macOS / Linux, zero extra dependencies.
// ════════════════════════════════════════════════════════════════
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const nextDir = join(root, '.next');
const standalone = join(nextDir, 'standalone');

if (!existsSync(standalone)) {
  console.error(
    '[postbuild] .next/standalone not found — did `next build` run with output: "standalone"?',
  );
  process.exit(1);
}

// .next/static → .next/standalone/.next/static
const staticDir = join(nextDir, 'static');
if (existsSync(staticDir)) {
  cpSync(staticDir, join(standalone, '.next', 'static'), { recursive: true });
  console.log('[postbuild] .next/static  → .next/standalone/.next/static');
} else {
  console.warn('[postbuild] WARNING: .next/static not found — skipping');
}

// public → .next/standalone/public
const publicDir = join(root, 'public');
if (existsSync(publicDir)) {
  cpSync(publicDir, join(standalone, 'public'), { recursive: true });
  console.log('[postbuild] public        → .next/standalone/public');
} else {
  console.warn('[postbuild] WARNING: public/ not found — skipping');
}

// ════════════════════════════════════════════════════════════════
//  v2.58.10 (final-review P0-2) — RELEASE HYGIENE GATE
//
//  The standalone output once carried prisma/dev.db, FIRST-LOGIN.txt,
//  tests/ and stray project files (the tracer is deliberately
//  conservative around dynamic fs access). next.config.ts now excludes
//  them at the trace level; THIS gate re-verifies the RESULT and fails
//  closed: anything that must never ship is removed AND reported —
//  and a leaked database, credential file, or env file FAILS THE
//  BUILD (a hygiene bug to fix, not something to sweep under the
//  carpet on the way to a release).
// ════════════════════════════════════════════════════════════════
import { readdirSync, rmSync, statSync } from 'node:fs';

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Patterns that must NEVER exist inside .next/standalone. */
const FATAL = [
  { test: (rel) => /^prisma\/.*\.db(\.|-|$)/.test(rel) || /(^|\/)dev\.db$/.test(rel) || /-wal$|-shm$/.test(rel) || /legacy-doubled-/.test(rel) || /\.test-runs/.test(rel), why: 'database file inside the standalone server bundle' },
  { test: (rel) => /^FIRST-LOGIN.*\.txt$/.test(rel) || /(^|\/)FIRST-LOGIN[^/]*\.txt$/.test(rel), why: 'plaintext credential file inside the standalone server bundle' },
  { test: (rel) => /(^|\/)\.env(\.|$)/.test(rel) && !/\.env\.example$/.test(rel), why: 'environment/secret file inside the standalone server bundle' },
];
/** Removed with a warning (bloat, not secrets) — traced project files. */
const REMOVE_ONLY = [
  { test: (rel) => /^tests\//.test(rel), why: 'test sources' },
  { test: (rel) => /^logs\//.test(rel), why: 'local log files' },
  { test: (rel) => /^storage\//.test(rel), why: 'uploaded user content' },
];

const files = walk(standalone).map((p) => p.slice(standalone.length + 1).replace(/\\/g, '/'));
let fatalCount = 0;
let removed = 0;
for (const rel of files) {
  const fatal = FATAL.find((f) => f.test(rel));
  if (fatal) {
    fatalCount += 1;
    console.error(`[postbuild] ✗ FATAL — ${rel} (${fatal.why}) — REMOVED, and the build FAILS`);
    try { rmSync(join(standalone, rel), { force: true }); } catch { /* best effort */ }
    continue;
  }
  const soft = REMOVE_ONLY.find((f) => f.test(rel));
  if (soft) {
    removed += 1;
    console.warn(`[postbuild] ⚠ removed ${rel} (${soft.why}) from the standalone bundle`);
    try { rmSync(join(standalone, rel), { force: true }); } catch { /* best effort */ }
  }
}
// empty leftover directories from the removals
for (const dir of ['tests', 'logs', 'storage']) {
  const p = join(standalone, dir);
  try {
    statSync(p);
    rmSync(p, { recursive: true, force: true });
  } catch { /* absent — fine */ }
}
if (fatalCount > 0) {
  console.error(`[postbuild] ✗ ${fatalCount} forbidden artifact(s) leaked into .next/standalone — fix the build tree, do not ship this output.`);
  process.exit(1);
}
if (removed > 0) {
  console.warn(`[postbuild] ⚠ ${removed} traced project file(s) removed from the standalone bundle (bloat only)`);
}

console.log('[postbuild] done — start production with: node .next/standalone/server.js');
