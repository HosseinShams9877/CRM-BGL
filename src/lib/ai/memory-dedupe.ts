// ════════════════════════════════════════════════════════════
// CUSTOMER-MEMORY DEDUPE (v2.58.7 — production hardening, D2).
//
// THE RACE (confirmed on the schema): AiCustomerMemory has NO unique
// constraint on (companyId, centerId, contactId) — contactId is NULLABLE
// and SQLite treats NULLs as distinct, so even a partial unique index
// could not fully bind the key. Both write paths (the engine's fenced
// merge and the manual route) do findFirst → update-or-create; two
// concurrent writers for the same center both see "not found" and both
// CREATE — duplicate rows. Later reads are findFirst: nondeterministic
// memory views, and a DB-side dedupe migration on live data is out of
// scope for this hardening round (see the audit report's migration plan).
//
// THE CODE-LEVEL CONTRACT (this module):
//   • reconcileCustomerMemoryDuplicates(tx, centerId, contactId) runs
//     INSIDE the SAME transaction as the write (engine: the fencedTx;
//     route: db.$transaction) and deletes every duplicate for the key,
//     keeping the LATEST updatedAt row — so exactly ONE row per
//     (center, contact) survives every write path, with last-write-wins
//     semantics (identical to what a serialized system would store).
//   • Call it AFTER the create/update inside the transaction; SQLite
//     serializes writers, so the reconcile sees the committed state.
// ════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';

type TxLike = Prisma.TransactionClient | typeof db;

/**
 * Delete duplicate memory rows for one (centerId, contactId) key,
 * keeping the newest by updatedAt. Returns the number of rows removed.
 * MUST run inside the write's transaction.
 */
export async function reconcileCustomerMemoryDuplicates(
  tx: TxLike,
  centerId: string,
  contactId: string | null,
): Promise<number> {
  const rows = await tx.aiCustomerMemory.findMany({
    where: { centerId, contactId },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });
  if (rows.length <= 1) return 0;
  const losers = rows.slice(1).map((r) => r.id);
  await tx.aiCustomerMemory.deleteMany({ where: { id: { in: losers } } });
  return losers.length;
}
