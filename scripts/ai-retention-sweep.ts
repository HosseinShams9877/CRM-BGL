// ═══════════════════════════════════════════════════════════
// ai-retention-sweep.ts — v2.47.0
// CLI entry for the expired-call-data sweep (see src/lib/ai/retention-sweep.ts).
// Usage:  npm run ai:retention        (cron-friendly: exit 0 = swept, 1 = errors)
// ═══════════════════════════════════════════════════════════
import { sweepExpiredAiRecordings } from '../src/lib/ai/retention-sweep';
import { db } from '../src/lib/db';

async function main() {
  const r = await sweepExpiredAiRecordings();
  console.log(
    `[ai:retention] expired=${r.expiredFound} deleted=${r.recordingsDeleted} ` +
      `audioFiles=${r.audioFilesDeleted} bytesRemoved=${r.diskBytesRemoved} ` +
      `skipped=${r.skipped} errors=${r.errors.length}`,
  );
  for (const e of r.errors) console.error(`  ! ${e}`);
  if (r.errors.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
