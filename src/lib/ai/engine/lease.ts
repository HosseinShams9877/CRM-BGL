import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';

// ════════════════════════════════════════════════════════════
// LEASE FENCING PRIMITIVES (v2.58.5 — user finding R4)
//
// Shared by pipeline.ts, nba.ts and memory.ts so that EVERY write the
// AI processing worker makes — recording state, transcript, analysis,
// memory, next-actions, coach insight, worker-failure marks — is
// committed in a SHORT transaction whose FIRST statement atomically
// proves lease ownership (and takes the SQLite RESERVED lock). A
// stale worker whose lease was re-granted to a newer owner matches
// zero rows and aborts via LeaseLostError; its stale results can
// never land next to (or over) the new owner's.
// ════════════════════════════════════════════════════════════

export class LeaseLostError extends Error {
  constructor() {
    super('processing lease was re-granted to a newer worker');
    this.name = 'LeaseLostError';
  }
}

/** The processing lease window; renewed before each long network stage. */
export const PROCESSING_LEASE_MS = 15 * 60 * 1000;

/** Fenced write on the RECORDING row only (state/marker updates). */
export async function fencedUpdate(
  recordingId: string,
  token: string,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await db.aiCallRecording.updateMany({
    where: { id: recordingId, leaseToken: token },
    data,
  });
  if (res.count !== 1) throw new LeaseLostError();
}

/**
 * Fenced transaction for EVERY pipeline write: the guard statement is a
 * no-op UPDATE on the recording row conditioned on the lease token — it
 * acquires the write lock AND proves ownership atomically (a separate
 * check before a long await is NOT sufficient; the commit and the proof
 * must be one operation). Network calls must run BEFORE this, never
 * inside.
 */
export async function fencedTx<T>(
  recordingId: string,
  token: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const guard = await tx.$executeRawUnsafe(
      'UPDATE "AiCallRecording" SET "leaseToken" = "leaseToken" WHERE "id" = ? AND "leaseToken" = ?',
      recordingId, token,
    );
    if (guard !== 1) throw new LeaseLostError();
    return fn(tx);
  }, { timeout: 20_000, maxWait: 5_000 });
}

/** Lease renewal before a long network stage (fenced — a stale worker
 *  cannot extend a lease it no longer owns). */
export async function renewLease(recordingId: string, token: string): Promise<void> {
  await fencedUpdate(recordingId, token, {
    leaseUntil: new Date(Date.now() + PROCESSING_LEASE_MS),
  });
}

/** The lease identity every stage write must carry. */
export interface LeaseContext {
  recordingId: string;
  token: string;
}
