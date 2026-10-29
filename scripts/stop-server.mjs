#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
//  stop-server — v2.26.1 operational fix · v2.30.0 cross-platform
//
//  WHY THIS EXISTS: the Next.js standalone server spawns a child
//  process ("next-server"). Killing only the parent `node server.js`
//  leaves that child alive, still bound to :3000. Every later start
//  then fails with EADDRINUSE — and, worse, if the port is served by
//  an old process while a fresh build replaced the static chunks,
//  the app ships phantom-chunk 500s (a confusing outage that looks
//  like a build bug but is a stale process).
//
//  v2.30.0: Windows support — `ss` is Linux-only, so on win32 the
//  port→PID lookup now uses `netstat -ano` (ships with every
//  Windows) and kills via Node's TerminateProcess-backed signals.
//
//  Usage:
//    node scripts/stop-server.mjs          # stop :3000 (default)
//    node scripts/stop-server.mjs 3001     # stop a custom port
// ════════════════════════════════════════════════════════════════
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const port = process.argv[2] || '3000';

function pidsOnPort(p) {
  try {
    if (process.platform === 'win32') {
      // netstat ships with every Windows: -a all sockets, -n numeric,
      // -o owning PID. Filter LISTENING rows whose LOCAL endpoint ends
      // in ":<port>" (exact — ":3000" must not match ":30000").
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] !== 'TCP') continue;
        if (!/LISTENING/i.test(cols[3] || '')) continue;
        const local = cols[1] || '';
        if (local.endsWith(`:${p}`) && /^\d+$/.test(cols[4] || '')) {
          pids.add(cols[4]);
        }
      }
      return [...pids];
    }
    const out = execSync(`ss -tlnp 2>/dev/null | grep ':${p} ' || true`, { shell: '/bin/bash', encoding: 'utf8' });
    return [...out.matchAll(/pid=(\d+)/g)].map((m) => m[1]);
  } catch {
    return [];
  }
}

const victims = new Set(pidsOnPort(port));
if (victims.size === 0) {
  console.log(`[stop-server] nothing listening on :${port} — clean.`);
  process.exit(0);
}

for (const pid of victims) {
  try {
    process.kill(Number(pid), 'SIGTERM');
    console.log(`[stop-server] SIGTERM → pid ${pid}`);
  } catch {
    console.log(`[stop-server] pid ${pid} already gone`);
  }
}

// grace period, then force-kill survivors
await sleep(2500);
const remaining = pidsOnPort(port);
for (const pid of remaining) {
  try {
    process.kill(Number(pid), 'SIGKILL');
    console.log(`[stop-server] SIGKILL → pid ${pid}`);
  } catch { /* already dead */ }
}
const still = pidsOnPort(port);
if (still.length === 0) {
  console.log(`[stop-server] port :${port} is free.`);
  process.exit(0);
} else {
  console.error(`[stop-server] could not free :${port} (pids: ${still.join(', ')})`);
  process.exit(1);
}
