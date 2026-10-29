// ════════════════════════════════════════════════════════════
// STAFF PERFORMANCE CONTRACT (v2.43.1, r68)
//
// The staff-performance report (/api/reports action) and its UI
// tab (sales-reports.tsx StaffReportTab) used to define the row
// shape independently — the API returned `userName` while the UI
// read `name`, so the first real data row crashed the tab with
// `TypeError: Cannot read properties of undefined (reading
// 'charAt')` (reported live by the user; live-caught in r68).
//
// Both sides now share THIS single type + builder. The API maps
// raw aggregates through buildStaffPerfRow (compile error if a
// field goes missing) and the UI imports the same StaffPerfRow
// (compile error if it reads a renamed field) — the mismatch
// class is structurally impossible from now on.
// ════════════════════════════════════════════════════════════

/** Aggregates per creator, as produced by the report handler. */
export interface StaffPerfInput {
  userId: string;
  displayName: string;
  jobTitle?: string | null;
  roleLabel?: string | null;
  sales: number;
  orders: number;
  /** number of distinct centers (Set.size upstream) */
  centers: number;
  pipeline: number;
  won: number;
  lost: number;
}

/** The row contract consumed by StaffReportTab — SINGLE SOURCE. */
export interface StaffPerfRow {
  userId: string;
  userName: string;
  role: string;
  sales: number;
  orders: number;
  centers: number;
  pipeline: number;
  winRate: number;
  avgDealSize: number;
}

/** Every field the UI tab reads — regression-tested. */
export const STAFF_PERF_ROW_FIELDS: readonly (keyof StaffPerfRow)[] = [
  'userId', 'userName', 'role', 'sales', 'orders',
  'centers', 'pipeline', 'winRate', 'avgDealSize',
];

/** PURE — map one creator's aggregates into the shared row. */
export function buildStaffPerfRow(input: StaffPerfInput): StaffPerfRow {
  const won = input.won;
  const lost = input.lost;
  return {
    userId: input.userId,
    userName: input.displayName,
    role: input.jobTitle || input.roleLabel || '—',
    sales: Math.round(input.sales),
    orders: input.orders,
    centers: input.centers,
    pipeline: input.pipeline,
    winRate: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0,
    avgDealSize: input.orders > 0 ? Math.round(input.sales / input.orders) : 0,
  };
}

/** Sort rows by sales, best first (stable for equal sales). */
export function sortStaffPerfRows(rows: StaffPerfRow[]): StaffPerfRow[] {
  return [...rows].sort((a, b) => b.sales - a.sales);
}
