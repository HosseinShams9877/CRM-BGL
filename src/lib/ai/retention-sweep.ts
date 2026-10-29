// ═══════════════════════════════════════════════════════════
// ai/retention-sweep.ts — v2.47.0 (audit: "retentionUntil بدون job حذفی")
//
// The telephony ingest stamps every AiCallRecording with retentionUntil
// (admin-configurable retentionDays) — but NOTHING ever deleted them:
// the promise of «نگهداری تا تاریخ X» was documentation, not behavior.
// This sweep closes the loop:
//   • recordings past retentionUntil are deleted (CASCADE removes their
//     transcripts, coaching notes and action records),
//   • their audio File row AND the bytes on disk go too — a deleted
//     recording must not leave a playable orphan behind,
//   • one AuditEvent summarizes each run (category: security),
//   • the run is bounded (MAX_PER_RUN) so a huge backlog cannot stall
//     the request that triggered it.
//
// Trigger points: telephony ingest (throttled to once per hour per
// process), the admin AI-settings save, and `npm run ai:retention`.
// ═══════════════════════════════════════════════════════════
import { db } from '@/lib/db';
import { getStorageDir } from '@/lib/storage';
import { deleteFileRowQuiet } from '@/lib/file-lifecycle';
import fs from 'fs';
import path from 'path';

const MAX_PER_RUN = 200;

export interface RetentionSweepResult {
  expiredFound: number;
  recordingsDeleted: number;
  audioFilesDeleted: number;
  diskBytesRemoved: number;
  errors: string[];
  skipped: number; // expired rows left for the next run (backlog > MAX_PER_RUN)
}

/** In-process throttle: opportunistic callers run at most one sweep/hour. */
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** True when an opportunistic sweep should run now (ingest hook). */
export function retentionSweepDue(): boolean {
  return Date.now() - lastSweepAt > SWEEP_INTERVAL_MS;
}

/** Byte size of a file about to be deleted (for the honest bytes counter). */
function fileSizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export async function sweepExpiredAiRecordings(): Promise<RetentionSweepResult> {
  const now = new Date();
  const result: RetentionSweepResult = {
    expiredFound: 0,
    recordingsDeleted: 0,
    audioFilesDeleted: 0,
    diskBytesRemoved: 0,
    errors: [],
    skipped: 0,
  };

  const expired = await db.aiCallRecording.findMany({
    where: { retentionUntil: { lt: now } },
    select: { id: true, audioFileId: true },
    take: MAX_PER_RUN + 1,
    orderBy: { retentionUntil: 'asc' },
  });
  result.expiredFound = expired.length;
  if (expired.length === 0) {
    lastSweepAt = Date.now();
    return result;
  }
  result.skipped = Math.max(0, expired.length - MAX_PER_RUN);
  const targets = expired.slice(0, MAX_PER_RUN);

  for (const rec of targets) {
    try {
      // 1) audio bytes + File row (a recording without its audio is not
      //    "deleted" in any meaningful privacy sense)
      //    v2.58.4 (external audit F06): the shared recoverable-delete
      //    contract — the row is marked 'deleting' and removed ONLY after
      //    the bytes are settled; a failed unlink keeps the row TRACKABLE
      //    (and is reported honestly below) instead of leaving untracked
      //    bytes behind a "deleted" counter.
      if (rec.audioFileId) {
        const file = await db.file.findUnique({
          where: { id: rec.audioFileId },
          select: { id: true, storedName: true, status: true, size: true },
        });
        if (file) {
          const bytes = fileSizeOf(path.join(getStorageDir(), file.storedName));
          const settled = await deleteFileRowQuiet(file);
          if (settled) {
            result.audioFilesDeleted += 1;
            result.diskBytesRemoved += bytes;
          } else {
            result.errors.push(`${file.storedName}: audio delete did not settle (row kept, retry next run)`);
          }
        }
      }
      // 2) the recording row itself (cascades transcripts/coaching/actions)
      await db.aiCallRecording.delete({ where: { id: rec.id } });
      result.recordingsDeleted += 1;
    } catch (e) {
      result.errors.push(`${rec.id}: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`);
    }
  }

  lastSweepAt = Date.now();

  if (result.recordingsDeleted > 0 || result.errors.length > 0) {
    await db.auditEvent
      .create({
        data: {
          eventType: 'AI_RETENTION_SWEEP',
          category: 'security',
          subject: 'retention-sweep',
          details:
            `deleted=${result.recordingsDeleted}; audioFiles=${result.audioFilesDeleted}; ` +
            `bytes=${result.diskBytesRemoved}; skipped=${result.skipped}; errors=${result.errors.length}`,
        },
      })
      .catch(() => undefined); // audit is best-effort
  }

  return result;
}
