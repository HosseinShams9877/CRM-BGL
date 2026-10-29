#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// scripts/register-sweep-task.mjs — v2.58.10 (final-review P2)
//
// Registers the file-lifecycle sweeper as a SCHEDULED JOB — the
// final review found `files:sweep` existed but nothing ever ran it.
//
//   node scripts/register-sweep-task.mjs            → prints the exact
//     registration commands for THIS platform (read-only — review,
//     copy, run as admin);
//   node scripts/register-sweep-task.mjs --install  → registers it
//     (Windows: schtasks /Create DAILY; Linux: crontab entry, dedup
//     by the # bgl-crm-sweep marker line);
//   node scripts/register-sweep-task.mjs --remove   → removes it.
//
// The scheduled command runs `node scripts/sweep-cron.mjs --sweep`
// once a day at 03:30 local time (report + stale-.part recovery —
// NEVER --prune). Monitoring: logs/files-sweep-report.json (mtime +
// exitCode). Full runbook: SWEEP-RUNBOOK.md.
// ═══════════════════════════════════════════════════════════
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const mode = process.argv.includes('--remove') ? 'remove' : process.argv.includes('--install') ? 'install' : 'print';

const cronRunner = join(projectRoot, 'scripts', 'sweep-cron.mjs');
if (!existsSync(cronRunner)) {
  console.error(`[sweep-task] missing runner: ${cronRunner}`);
  process.exit(1);
}

const NODE = process.execPath;
const TASK_NAME = 'BGL-CRM File Sweep';
const CRON_MARKER = '# bgl-crm-sweep';
const CRON_LINE = `${CRON_MARKER} (daily 03:30) file-lifecycle sweep`;
const CRON_JOB = `30 3 * * * cd "${projectRoot}" && "${NODE}" "${cronRunner}" --sweep >> "${join(projectRoot, 'logs', 'sweep-cron.log')}" 2>&1`;

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

console.log('══════════════════════════════════════════════════');
console.log('  BGL CRM — ثبت Job زمان‌بندی‌شدهٔ sweeper فایل‌ها');
console.log(`  پروژه: ${projectRoot}`);
console.log(`  حالت: ${mode === 'print' ? 'فقط نمایش فرمان‌ها' : mode}`);
console.log('══════════════════════════════════════════════════');

if (process.platform === 'win32') {
  // ── Windows: Task Scheduler (daily 03:30, system-wide, highest privs NOT needed)
  const create = `schtasks /Create /TN "${TASK_NAME}" /SC DAILY /ST 03:30 /TR "\\"${NODE}\\" \\"${cronRunner}\\" --sweep" /F`;
  const remove = `schtasks /Delete /TN "${TASK_NAME}" /F`;
  const query = `schtasks /Query /TN "${TASK_NAME}"`;
  if (mode === 'print') {
    console.log('\nفرمان ثبت (در CMD با دسترسی مدیر):');
    console.log(`  ${create}`);
    console.log('\nفرمان حذف:');
    console.log(`  ${remove}`);
    console.log('\nبررسی وضعیت:');
    console.log(`  ${query}`);
    console.log('\nراهنمای کامل، مانیتورینگ و بازگردانی: SWEEP-RUNBOOK.md');
  } else if (mode === 'install') {
    const out = run(create);
    if (out === null) {
      console.error('  ✗ ثبت شکست خورد — فرمان را دستی با دسترسی مدیر اجرا کنید:');
      console.error(`    ${create}`);
      process.exit(1);
    }
    console.log(out.trim());
    console.log('  ✓ Job روزانهٔ ۰۳:۳۰ ثبت شد (نام: «BGL-CRM File Sweep»).');
  } else {
    const out = run(remove);
    console.log(out === null ? '  ℹ Job پیدا نشد (شاید ثبت نشده بود).' : `  ✓ حذف شد:\n${out.trim()}`);
  }
} else {
  // ── Linux/macOS: crontab (with marker-based dedup)
  const current = run('crontab -l 2>/dev/null') ?? '';
  const hasLine = current.split('\n').some((l) => l.includes(CRON_MARKER));
  if (mode === 'print') {
    console.log('\nخط cron پیشنهادی (روزانه ۰۳:۳۰):');
    console.log(`  ${CRON_JOB}`);
    console.log('\nثبت خودکار با: node scripts/register-sweep-task.mjs --install');
    console.log('راهنمای کامل، مانیتورینگ و بازگردانی: SWEEP-RUNBOOK.md');
  } else if (mode === 'install') {
    if (run('command -v crontab') === null) {
      console.error('  ✗ crontab در دسترس نیست — خط بالا را در schedulers دلخواه (systemd timer و…) قرار دهید.');
      process.exit(1);
    }
    if (hasLine) {
      console.log('  ✓ همین Job قبلاً ثبت شده است (خط marker موجود) — تغییری نکرد.');
      process.exit(0);
    }
    const next = `${current.trimEnd()}\n${CRON_LINE}\n${CRON_JOB}\n`;
    try {
      execSync('crontab -', { input: next, stdio: ['pipe', 'ignore', 'inherit'] });
      console.log('  ✓ Job روزانهٔ ۰۳:۳۰ به crontab اضافه شد.');
    } catch {
      console.error('  ✗ نوشتن crontab شکست خورد — خط بالا را دستی اضافه کنید.');
      process.exit(1);
    }
  } else {
    if (!hasLine) {
      console.log('  ℹ Job ثبت نشده بود — کاری برای حذف نیست.');
      process.exit(0);
    }
    const next = current.split('\n').filter((l) => !l.includes(CRON_MARKER) && l.trim() !== CRON_JOB).join('\n');
    try {
      execSync('crontab -', { input: `${next}\n`, stdio: ['pipe', 'ignore', 'inherit'] });
      console.log('  ✓ Job از crontab حذف شد.');
    } catch {
      console.error('  ✗ به‌روزرسانی crontab شکست خورد — خط bgl-crm-sweep را دستی حذف کنید.');
      process.exit(1);
    }
  }
}
