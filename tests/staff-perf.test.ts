// ════════════════════════════════════════════════════════════════
// staff-perf.test.ts — v2.43.1 (r68) regression tests for the
// shared staff-performance row contract.
//
// Live bug: /api/reports staff-performance returned `userName`
// while StaffReportTab read `name` → first real row rendered
// `undefined.charAt(0)` → the whole reports tab crashed (user-
// reported). The contract now lives in src/lib/staff-perf.ts and
// BOTH the API handler and the UI tab derive from it; these tests
// pin the exact runtime shape the UI depends on.
// ════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  buildStaffPerfRow,
  sortStaffPerfRows,
  STAFF_PERF_ROW_FIELDS,
  type StaffPerfInput,
} from '@/lib/staff-perf';

const baseInput: StaffPerfInput = {
  userId: 'u1',
  displayName: 'حمیده حمیدیان',
  jobTitle: 'sales_expert',
  roleLabel: 'کارشناس فروش',
  sales: 1_234_567.6,
  orders: 3,
  centers: 12,
  pipeline: 5,
  won: 4,
  lost: 1,
};

describe('buildStaffPerfRow — the shared API↔UI contract', () => {
  it('produces every field the UI tab reads (regression: userName crash)', () => {
    const row = buildStaffPerfRow(baseInput);
    for (const field of STAFF_PERF_ROW_FIELDS) {
      expect(row[field], `field ${field} must be present`).not.toBeUndefined();
    }
  });

  it('maps displayName → userName (the exact field the tab renders)', () => {
    const row = buildStaffPerfRow(baseInput);
    expect(row.userName).toBe('حمیده حمیدیان');
    // avatar initial path: (s.userName || '—').trim().charAt(0)
    expect((row.userName || '—').trim().charAt(0)).toBe('ح');
  });

  it('never emits the legacy field name `name` (the crash source)', () => {
    const row = buildStaffPerfRow(baseInput) as unknown as Record<string, unknown>;
    expect(row.name).toBeUndefined();
  });

  it('rounds sales and avgDealSize; winRate = won/(won+lost)', () => {
    const row = buildStaffPerfRow(baseInput);
    expect(row.sales).toBe(1_234_568);
    expect(row.winRate).toBe(80);
    expect(row.avgDealSize).toBe(411_523); // round(1234567.6 / 3)
  });

  it('winRate 0 and avgDealSize 0 for an empty pipeline (no division by zero)', () => {
    const row = buildStaffPerfRow({ ...baseInput, won: 0, lost: 0, orders: 0 });
    expect(row.winRate).toBe(0);
    expect(row.avgDealSize).toBe(0);
  });

  it('role falls back jobTitle → roleLabel → dash', () => {
    expect(buildStaffPerfRow(baseInput).role).toBe('sales_expert');
    expect(buildStaffPerfRow({ ...baseInput, jobTitle: null }).role).toBe('کارشناس فروش');
    expect(buildStaffPerfRow({ ...baseInput, jobTitle: null, roleLabel: null }).role).toBe('—');
  });

  it('keeps the response JSON-serialisable (plain object, no Set leakage)', () => {
    const row = buildStaffPerfRow(baseInput);
    expect(() => JSON.stringify(row)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(row));
    for (const field of STAFF_PERF_ROW_FIELDS) {
      expect(parsed[field]).not.toBeUndefined();
    }
  });
});

describe('sortStaffPerfRows', () => {
  it('sorts best sales first', () => {
    const a = buildStaffPerfRow({ ...baseInput, userId: 'a', sales: 100 });
    const b = buildStaffPerfRow({ ...baseInput, userId: 'b', sales: 900 });
    const c = buildStaffPerfRow({ ...baseInput, userId: 'c', sales: 500 });
    expect(sortStaffPerfRows([a, b, c]).map((r) => r.userId)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the input array', () => {
    const a = buildStaffPerfRow({ ...baseInput, userId: 'a', sales: 100 });
    const b = buildStaffPerfRow({ ...baseInput, userId: 'b', sales: 900 });
    const input = [a, b];
    sortStaffPerfRows(input);
    expect(input[0]).toBe(a);
  });
});
