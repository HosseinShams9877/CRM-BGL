// ═══════════════════════════════════════════════════════════
// money.ts — v2.47.0 (audit: Float → exact integer-Rial invariant)
//
// CONTEXT (decision, documented in SECURITY.md): the audit recommended
// Decimal/BigInt columns for all money. On this stack (SQLite + JSON API +
// 40+ UI consumers doing Number arithmetic) a Prisma Decimal field would
// change every API response from number to string and break the whole UI
// layer — a far worse regression than the (theoretical) precision risk.
//
// THE INVARIANT INSTEAD: Rial has no fractional unit. Every money value is
// an INTEGER, and integers up to 2^53 (~9×10^15 ریال) are stored EXACTLY
// in both JS float64 and SQLite REAL. With integer validation at every
// write boundary (validators.ts .int() + this helper) the float-precision
// bug class is eliminated without a breaking migration.
// ═══════════════════════════════════════════════════════════

/** Max sane Rial amount accepted anywhere (1e12 — validators' existing cap). */
export const RIAL_MAX = 1e12;

/**
 * Parse an untrusted value into an integer Rial amount.
 * Returns null when the value is not a finite INTEGER (fractional rial,
 * NaN, Infinity, junk). Callers answer a Persian 400.
 */
export function parseIntRial(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  return n;
}

/** Exact integer sum — integer inputs keep float64 addition exact (< 2^53). */
export function sumRial(values: number[]): number {
  let total = 0;
  for (const v of values) {
    total += Math.trunc(v); // defensive: a legacy fractional row cannot poison the sum
  }
  return total;
}

/** Format for logs/audit (plain digits, no locale noise). */
export function formatRial(n: number): string {
  return String(Math.trunc(n));
}
