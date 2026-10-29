// ════════════════════════════════════════════════════════════
// activity-products.ts — v2.34.9 quick-activity product tags
//
// The quick-activity form (round 56) lets the sales expert optionally tick
// which catalog products an activity was about. The selection is persisted
// on Activity.products as a JSON snapshot [{id,name}] — a product renamed
// or deleted later never rewrites history (the same creation-time snapshot
// semantics as buyerSnapshot on SalesDocument).
//
// Pure module — no DB, no Next.js imports (unit-tested in
// tests/activity-products.test.ts).
// ════════════════════════════════════════════════════════════

/** One ticked product on the activity form. */
export interface ActivityProductRef {
  id: string;
  name: string;
}

/** Hard cap — a form can never dump an unbounded array into the column. */
export const MAX_ACTIVITY_PRODUCTS = 20;

/** Cuids are 25 chars; 64 leaves generous headroom for other id shapes. */
export const ACTIVITY_PRODUCT_ID_MAX = 64;

/** Product names are printed in tight chips — keep them bounded. */
export const ACTIVITY_PRODUCT_NAME_MAX = 120;

/**
 * Normalize whatever the client sent into a clean, de-duplicated
 * ActivityProductRef[] and serialize it for the column. Anything invalid is
 * dropped silently (the picker is optional — a malformed payload must never
 * 400 the whole activity save), except that a non-array / non-object input
 * yields the empty snapshot "[]".
 *
 * Accepts BOTH shapes the two create endpoints receive:
 *   • JSON body  → an actual array value
 *   • multipart  → a JSON-encoded string ("[{...}]")
 */
export function sanitizeActivityProducts(input: unknown): string {
  let list: unknown = input;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return '[]';
    }
  }
  if (!Array.isArray(list)) return '[]';

  const seen = new Set<string>();
  const out: ActivityProductRef[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = typeof (raw as { id?: unknown }).id === 'string'
      ? (raw as { id: string }).id.trim()
      : '';
    const name = typeof (raw as { name?: unknown }).name === 'string'
      ? (raw as { name: string }).name.trim()
      : '';
    if (!id || id.length > ACTIVITY_PRODUCT_ID_MAX) continue;
    if (!name || name.length > ACTIVITY_PRODUCT_NAME_MAX) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
    if (out.length >= MAX_ACTIVITY_PRODUCTS) break;
  }
  return JSON.stringify(out);
}

/**
 * Parse a stored Activity.products snapshot for display. Tolerant of every
 * legacy/malformed value — always returns an array (possibly empty), never
 * throws: list UIs must not crash because one old row holds garbage.
 */
export function parseActivityProducts(raw: string | null | undefined): ActivityProductRef[] {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ActivityProductRef[] = [];
    for (const raw2 of parsed) {
      if (!raw2 || typeof raw2 !== 'object' || Array.isArray(raw2)) continue;
      const id = typeof (raw2 as { id?: unknown }).id === 'string' ? (raw2 as { id: string }).id : '';
      const name = typeof (raw2 as { name?: unknown }).name === 'string' ? (raw2 as { name: string }).name : '';
      if (id && name) out.push({ id, name });
    }
    return out;
  } catch {
    return [];
  }
}
