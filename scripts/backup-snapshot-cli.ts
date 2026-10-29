// ═══════════════════════════════════════════════════════════
// backup-snapshot-cli.ts — v2.47.0 → v2.58.1 (round 86, audit F7)
// CLI wrapper for the same backup machinery the /api/backup route uses
// (src/lib/backup-snapshot.ts). Cron-friendly:
//   npm run backup:snapshot                  (DB snapshot, default keep=14)
//   npx tsx scripts/backup-snapshot-cli.ts --package   (FULL package:
//        database + stored files incl. voice notes + verified manifest)
//   npx tsx scripts/backup-snapshot-cli.ts --keep 7
// Exit codes: 0 = verified backup written; 1 = anything less.
// (scripts/backup-cron.mjs remains the richer cron tool — same
// VACUUM INTO mechanism, plus optional uploads archive.)
// ═══════════════════════════════════════════════════════════
import { mkdirSync } from 'fs';
import {
  createDbSnapshot, createBackupPackage, rotateSnapshots, rotatePackages,
  backupDir, DEFAULT_KEEP,
} from '../src/lib/backup-snapshot';
import { db } from '../src/lib/db';

const argNum = (flag: string, dflt: number): number => {
  const i = process.argv.indexOf(flag);
  const v = i !== -1 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : dflt;
};

async function main() {
  const keep = argNum('--keep', DEFAULT_KEEP);
  const fullPackage = process.argv.includes('--package');
  mkdirSync(backupDir(), { recursive: true });

  if (fullPackage) {
    // v2.58.1 (audit F7) — the FULL restorable package: DB + files.
    const manifest = await createBackupPackage('cli');
    const removedPkgs = await rotatePackages(keep);
    const removedDb = await rotateSnapshots(keep);
    const mb = (manifest.database.bytes / 1_048_576).toFixed(1);
    console.log(
      `[backup:package] database ${mb} MB (quick_check=${manifest.database.quickCheck}, sha256=${manifest.database.sha256.slice(0, 16)}…) + ${manifest.files.count} files (${(manifest.files.totalBytes / 1_048_576).toFixed(1)} MB)`,
    );
    console.log(`  rows: ${JSON.stringify(manifest.database.tableCounts)}`);
    if (manifest.files.missingContent.length > 0) {
      console.log(`  ⚠ ${manifest.files.missingContent.length} File record(s) had no bytes on disk (reported, not fabricated):`);
      for (const m of manifest.files.missingContent.slice(0, 10)) console.log(`      - ${m}`);
    }
    console.log(`  rotated: ${removedPkgs.length} package(s), ${removedDb.length} snapshot(s)`);
    console.log(`  restore: node scripts/restore-backup.mjs --latest`);
    return;
  }

  const manifest = await createDbSnapshot('cli');
  const removed = await rotateSnapshots(keep);
  console.log(
    `[backup:snapshot] ${manifest.file} (${(manifest.bytes / 1_048_576).toFixed(1)} MB) ` +
      `quick_check=${manifest.quickCheck} sha256=${manifest.sha256.slice(0, 16)}… rotated=${removed.length}`,
  );
  console.log(`  rows: ${JSON.stringify(manifest.tableCounts)}`);
}

main()
  .catch((e) => { console.error(`[backup] FAILED: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
