// ══════════════════════════════════════════════════════════════════
//  call-list-pagination.ts — v2.44.0 (round 69)
//
//  User request (ثبت تماس screen):
//  «نهایتاً سی تا تماس آخری که گرفته را نمایش بده؛ برای بقیه‌اش پایین
//   یک کادری باشد بزنیم "مشاهده بیشتر" و ادامه تماس‌ها را بیاید.»
//
//  Contract (PURE — no React, no fetch; unit-tested in
//  tests/call-list-pagination.test.ts):
//    • the list renders at most CALLS_REVEAL_STEP (۳۰) rows initially;
//    • each «مشاهده بیشتر» click reveals the next ۳۰ rows;
//    • when every LOADED row is already revealed but the server says
//      more call pages exist (serverTotal > loaded), the next server
//      page (CALLS_FETCH_PAGE_SIZE rows) is fetched and appended, then
//      the reveal continues — so a center with hundreds of calls pages
//      through its whole history ۳۰ at a time;
//    • visibleCount indexes the FILTERED view (search / status / tab);
//      a count larger than the filtered array is harmless — Array.slice
//      caps it, and the plan functions never over-reveal loaded rows.
// ══════════════════════════════════════════════════════════════════

/** Rows revealed per «مشاهده بیشتر» click (the user-asked ۳۰). */
export const CALLS_REVEAL_STEP = 30;

/** Rows fetched from /api/activities per server page. 200 keeps the
 *  initial payload one request (same weight as the old mixed-activity
 *  fetch) while stats and tab badges stay based on a real page, and the
 *  «مشاهده بیشتر» box keeps working far beyond it via follow-up pages. */
export const CALLS_FETCH_PAGE_SIZE = 200;

export interface CallListPaging {
  /** How many rows of the filtered view are currently rendered. */
  visibleCount: number;
  /** Total call rows matching the server-side scope (all pages). */
  serverTotal: number;
  /** 1-based NEXT server page to fetch (2 = only page 1 fetched so far). */
  nextPage: number;
}

export type RevealPlan =
  | { kind: 'reveal'; count: number }
  | { kind: 'fetch'; page: number }
  | { kind: 'none' };

function toCount(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** State right after a (re)load of server page 1. */
export function initCallListPaging(loadedCount: number, serverTotal: number): CallListPaging {
  const loaded = toCount(loadedCount);
  return {
    visibleCount: Math.min(CALLS_REVEAL_STEP, loaded),
    serverTotal: Math.max(toCount(serverTotal), loaded),
    nextPage: 2,
  };
}

/** Decide what the next «مشاهده بیشتر» click must do.
 *  Priority: reveal loaded rows first (instant); fetch a server page only
 *  when the filtered view is exhausted AND the server has more rows. */
export function planRevealMore(paging: CallListPaging, loadedCount: number, filteredCount: number): RevealPlan {
  const remaining = toCount(filteredCount) - paging.visibleCount;
  if (remaining >= CALLS_REVEAL_STEP) return { kind: 'reveal', count: CALLS_REVEAL_STEP };
  if (remaining > 0) return { kind: 'reveal', count: remaining };
  if (toCount(loadedCount) < paging.serverTotal) return { kind: 'fetch', page: paging.nextPage };
  return { kind: 'none' };
}

/** Rows still hidden behind the «مشاهده بیشتر» box (for its label). */
export function countRemaining(paging: CallListPaging, loadedCount: number, filteredCount: number): number {
  const filteredRemaining = toCount(filteredCount) - paging.visibleCount;
  if (filteredRemaining > 0) return filteredRemaining;
  return Math.max(paging.serverTotal - toCount(loadedCount), 0);
}

/** Apply a { kind: 'reveal' } plan. */
export function applyReveal(paging: CallListPaging, count: number): CallListPaging {
  return { ...paging, visibleCount: paging.visibleCount + Math.max(1, toCount(count) || 1) };
}

/** Apply a { kind: 'fetch' } plan AFTER the rows were appended:
 *  - prevFilteredCount: filtered row count BEFORE the append (the click
 *    happened with the filtered view exhausted, so this is what was on
 *    screen);
 *  - newItemsCount: appended rows (deduped client-side);
 *  - serverTotal: the fresh `total` from the page response;
 *  - loadedAfterCount: loaded rows after the append (floors serverTotal,
 *    and when a page comes back EMPTY it collapses the counter so the
 *    box disappears instead of offering phantom rows forever). */
export function applyFetchedPage(
  paging: CallListPaging,
  opts: { prevFilteredCount: number; newItemsCount: number; serverTotal: number; loadedAfterCount: number },
): CallListPaging {
  const loadedAfter = toCount(opts.loadedAfterCount);
  const serverTotal = Math.max(toCount(opts.serverTotal), loadedAfter);
  return {
    visibleCount: toCount(opts.prevFilteredCount) + Math.min(CALLS_REVEAL_STEP, toCount(opts.newItemsCount)),
    serverTotal,
    nextPage: paging.nextPage + 1,
  };
}
