#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// scripts/sweep-cron.mjs — v2.58.10 (final-review P2: the operational
// sweeper registration)
//
// The one-shot UNATTENDED runner for the file-lifecycle job — built
// for Windows Task Scheduler / Unix cron (no TTY, no interaction).
// It drives the REAL interactive CLI (`scripts/files-health.ts`,
// via tsx) as a child process so the scheduled path and the operator
// path are ONE code path (same guards, same counters, same exit
// codes):
//   • default: 100% dry-run health report (zero deletes);
//   • --sweep: additionally recovers STALE pending uploads (aged
//     .part files past the grace window) — the same guarded code the
//     interactive CLI runs, never a raw rm;
//   • never runs --prune (record deletion stays human-confirmed).
//
// MONITORING: every run refreshes a machine-readable report at
// <root>/logs/files-sweep-report.json (last-run timestamp, exit
// code, tail of the output) — a monitoring check only needs that
// file's mtime + exitCode. Full output also lands in the cron log.
//
// Exit codes (cron-friendly, mirrored from the CLI):
//   0 = clean (or swept clean) · 1 = missing content detected ·
//   2 = operational/runner error (nothing deleted)
// ═══════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRootDefault = resolve(here, '..');
const argRoot = process.argv.find((a) => a.startsWith('--root='));
const root = argRoot ? resolve(projectRootDefault, argRoot.slice('--root='.length)) : projectRootDefault;
const doSweep = process.argv.includes('--sweep');

const cli = join(projectRootDefault, 'scripts', 'files-health.ts');

const report = {
  at: new Date().toISOString(),
  mode: doSweep ? 'sweep' : 'report',
  root,
  exitCode: null,
  tail: [],
};

function finish(exitCode) {
  report.exitCode = exitCode;
  // ── monitoring report (best-effort: a full disk never fails the job)
  try {
    const logsDir = join(root, 'logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, 'files-sweep-report.json'), JSON.stringify(report, null, 2) + '\n');
  } catch { /* best-effort */ }
  process.exit(exitCode);
}

const child = spawn(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), cli, ...(doSweep ? ['--sweep'] : [])], {
  cwd: root,
  env: { ...process.env, NO_COLOR: '1', CI: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => { out += String(d); process.stdout.write(d); });
child.stderr.on('data', (d) => { out += String(d); process.stderr.write(d); });
child.on('error', (err) => {
  console.error(`[sweep-cron] ✗ could not launch the CLI: ${String(err)}`);
  report.tail.push(`runner error: ${String(err)}`);
  finish(2);
});
child.on('close', (code) => {
  report.tail = out.trimEnd().split('\n').slice(-25);
  console.log(`[sweep-cron] done — CLI exit ${code === null ? 'killed' : code} · report: ${join(root, 'logs', 'files-sweep-report.json')}`);
  finish(code === null ? 2 : code);
});
