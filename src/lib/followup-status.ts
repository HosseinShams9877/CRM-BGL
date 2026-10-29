// ─────────────────────────────────────────────────────────────
//  Periodic follow-up due status (v2.15.0 — sixth-round audit, item 6)
//
//  The stored `status`/`daysOverdue` columns were frozen at write time, so a
//  follow-up whose `nextFollowupDate` had passed could linger as 'upcoming'
//  forever and never enter the overdue alert. The effective status is now
//  DERIVED from the date at read time (list endpoint + dashboard stats).
// ─────────────────────────────────────────────────────────────

export interface FollowupStatusRow {
  nextFollowupDate?: string | null;
  status?: string | null;
  daysOverdue?: number | null;
}

/** Derive the effective due status from `nextFollowupDate` at read time.
 *  - stored 'done' is terminal and preserved;
 *  - rows without a next date (legacy) keep their stored status;
 *  - otherwise: past → overdue (+ days), today → today, future → upcoming. */
export function computeFollowupStatus(
  row: FollowupStatusRow,
): { status: string; daysOverdue: number } {
  const stored = row.status || 'upcoming';
  if (stored === 'done') return { status: 'done', daysOverdue: 0 };

  const next = row.nextFollowupDate;
  if (!next) return { status: stored, daysOverdue: row.daysOverdue || 0 };

  const today = new Date().toISOString().slice(0, 10);
  const diff = Math.round((Date.parse(next) - Date.parse(today)) / 86_400_000);
  if (Number.isNaN(diff)) return { status: stored, daysOverdue: row.daysOverdue || 0 };

  if (diff < 0) return { status: 'overdue', daysOverdue: -diff };
  if (diff === 0) return { status: 'today', daysOverdue: 0 };
  return { status: 'upcoming', daysOverdue: 0 };
}
