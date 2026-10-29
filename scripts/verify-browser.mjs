#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// verify-browser.mjs — v2.58.1 (round 86)
//
// Browser smoke verification (package.json `test:e2e` / `test:multidialog`
// targets) using Playwright against the LIVE dev server:
//   1. admin session loads the app; zero console/page errors on the
//      dashboard, centers, calls and settings modules;
//   2. the Settings → پشتیبان‌گیری tab shows the v2.58.1 UI: the full
//      «پشتیبان‌گیری کامل الان» button (real backup package) AND the
//      honestly-labeled «خروجی داده (JSON)» secondary button;
//   3. table header/body alignment probe (r84 regression guard): sample
//      the calls table and verify each data cell's effective text-align
//      matches its column header;
//   4. multi-dialog behavior: open + close a dialog, open another —
//      no stuck overlays (the v2.29.1 multidialog class of bugs);
//   5. screenshots to scripts/shots-r86/ for the audit trail.
// Uses the r82 session-injection pattern (temp admin + session row,
// deleted afterwards). Exit 0 only when every check passes.
// Usage: node scripts/verify-browser.mjs [--base http://localhost:3000]
// ═══════════════════════════════════════════════════════════
import { createRequire } from 'module';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(join(resolve(dirname(fileURLToPath(import.meta.url))), 'package.json').replace('/scripts/../', '/'));

// Node ≥18 native web globals — destructured so lint sees local bindings.
const { fetch: gfetch } = globalThis;

const { PrismaClient } = require('@prisma/client');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '--base=http://localhost:3000').split('=')[1];
// v2.58.6 (user P-gates rule): the harness's DIRECT client must see the
// SAME database the server under test uses (DATABASE_URL wins — gate runs
// use a throwaway copy; the bare default stays prisma/dev.db for an
// operator verifying their own install).
const { resolveDatabaseFile } = await import('./lib/resolve-env.mjs');
const dbFile = resolveDatabaseFile(process.env.DATABASE_URL || 'file:./dev.db', root);
const db = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
const SHOTS = join(root, 'scripts', 'shots-r86');
mkdirSync(SHOTS, { recursive: true });

const TAG = `r86b-${Date.now()}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const health = await gfetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health || health.status === 'fail') {
    console.error(`[verify-browser] server unhealthy: ${JSON.stringify(health)}`);
    process.exit(1);
  }

  // temp admin + session (r82 pattern)
  const token = randomBytes(32).toString('hex');
  const { sha256Token } = await import('./lib/session-helper.mjs');
  const user = await db.user.create({
    data: { username: `${TAG}-admin`, displayName: 'r86 browser verify', passwordHash: 'x', role: 'admin', companyIds: '[]', businessUnitId: 'trading', isActive: true },
  });
  await db.session.create({ data: { id: sha256Token(token), userId: user.id, displayName: 'r86b', browserName: 'verify', ipHash: 'r86' } });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await ctx.addCookies([{ name: 'bgl_session', value: token, url: BASE }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    // 1) module smoke — zero console errors
    for (const [mod, shot] of [
      ['dashboard', 'dashboard.png'],
      ['centers', 'centers.png'],
      ['calls-log', 'calls.png'],
      ['settings', 'settings.png'],
    ]) {
      errors.length = 0;
      const company = mod === 'settings' ? 'bgl' : 'bgl';
      await page.goto(`${BASE}/?company=${company}&module=${mod}`, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: join(SHOTS, shot), fullPage: false });
      check(`module ${mod}: loads with ZERO console errors`, errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 160));
    }

    // 2) backup tab — v2.58.1 UI (nav key: settings-backup)
    errors.length = 0;
    await page.goto(`${BASE}/?company=bgl&module=settings-backup`, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: join(SHOTS, 'backup-tab.png'), fullPage: false });
    const fullBtn = await page.getByText('پشتیبان‌گیری کامل الان').count();
    const exportBtn = await page.getByText('خروجی داده (JSON)').count();
    check('backup tab shows «پشتیبان‌گیری کامل الان» (real package)', fullBtn >= 1, `count=${fullBtn}`);
    check('backup tab labels the JSON export honestly as «خروجی داده»', exportBtn >= 1, `count=${exportBtn}`);
    check('backup tab renders without console errors', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 160));

    // 3) table alignment probe (r84 guard) — calls table
    await page.goto(`${BASE}/?company=bgl&module=calls-log`, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(1200);
    const misaligned = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      let bad = 0;
      for (const t of tables) {
        const headCells = Array.from(t.querySelectorAll('thead th'));
        const bodyRows = Array.from(t.querySelectorAll('tbody tr'));
        if (headCells.length === 0 || bodyRows.length === 0) continue;
        const firstRow = Array.from(bodyRows[0].querySelectorAll('td'));
        const cols = Math.min(headCells.length, firstRow.length);
        for (let i = 0; i < cols; i++) {
          const hAlign = getComputedStyle(headCells[i]).textAlign;
          const hDir = getComputedStyle(headCells[i]).direction;
          const dAlign = getComputedStyle(firstRow[i]).textAlign;
          const dDir = getComputedStyle(firstRow[i]).direction;
          // effective alignment: 'start' flips with direction
          const eff = (a, d) => (a === 'start' ? (d === 'rtl' ? 'right' : 'left') : a === 'end' ? (d === 'rtl' ? 'left' : 'right') : a);
          if (eff(hAlign, hDir) !== eff(dAlign, dDir)) bad++;
        }
      }
      return bad;
    });
    check('calls table: every column header aligns with its data cells', misaligned === 0, `misaligned=${misaligned}`);

    // 4) multi-dialog behavior — collections module's «اقدام جدید» opens a
    // real Radix dialog; Escape must close it (v2.29.1 multidialog class).
    await page.goto(`${BASE}/?company=bgl&module=collections`, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500);
    const newActionBtn = page.getByText('اقدام جدید').first();
    if (await newActionBtn.count()) {
      await newActionBtn.click();
      await page.waitForTimeout(1000);
      const openDialogs1 = await page.locator('[role="dialog"]').count();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      const openDialogs2 = await page.locator('[role="dialog"]').count();
      check('dialog opens and Escape closes it cleanly', openDialogs1 >= 1 && openDialogs2 === 0, `open=${openDialogs1}, after-esc=${openDialogs2}`);
      // re-open (second dialog after a close — the multidialog regression)
      if (openDialogs1 >= 1) {
        await newActionBtn.click();
        await page.waitForTimeout(900);
        const openDialogs3 = await page.locator('[role="dialog"]').count();
        check('a SECOND dialog opens after closing the first', openDialogs3 >= 1, `open=${openDialogs3}`);
        await page.screenshot({ path: join(SHOTS, 'dialog.png'), fullPage: false });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
    } else {
      // fallback: the calls module's new-call dialog
      await page.goto(`${BASE}/?company=bgl&module=calls-log`, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(2000);
      const callBtn = page.getByText('تماس جدید').first();
      if (await callBtn.count()) {
        await callBtn.click();
        await page.waitForTimeout(900);
        const openDialogs1 = await page.locator('[role="dialog"]').count();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        check('new-call dialog opens and Escape closes it', openDialogs1 >= 1 && (await page.locator('[role="dialog"]').count()) === 0);
      } else {
        check('a dialog-bearing surface is reachable', false, 'neither collections nor calls dialog buttons found');
      }
    }

    // 5) LTR/RTL sanity: html dir attribute
    const dir = await page.evaluate(() => document.documentElement.getAttribute('dir'));
    check('document direction is RTL (Persian UI)', dir === 'rtl', `dir=${dir}`);
  } finally {
    await browser.close();
    // cleanup temp admin
    await db.session.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    const residue = await db.user.count({ where: { username: { startsWith: TAG } } });
    check('cleanup: temp browser admin removed', residue === 0, `residue=${residue}`);
    await db.$disconnect();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[verify-browser] ${results.length - failed.length}/${results.length} PASS${failed.length ? `, ${failed.length} FAIL` : ''}`);
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`[verify-browser] FATAL: ${e.message}`);
  await db.user.deleteMany({ where: { username: { startsWith: TAG } } }).catch(() => null);
  await db.$disconnect();
  process.exit(1);
});
