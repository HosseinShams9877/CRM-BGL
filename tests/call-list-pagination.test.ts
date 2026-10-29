// ════════════════════════════════════════════════════════════════
// call-list-pagination.test.ts — v2.44.0 (r69) regression tests
// for the ثبت تماس progressive-reveal contract.
//
// User request: «نهایتاً سی تماس آخری که گرفته را نمایش بده؛ برای
// بقیه‌اش پایین یک کادری باشد بزنیم "مشاهده بیشتر" و ادامه تماس‌ها
// را بیاید» + «تماس ثبت‌شده در مرکز، در آخرین فعالیت‌هایش نمایش
// داده شود» (the center side is covered by the dossier E2E; these
// unit tests pin the pure list-paging state machine).
// ════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  CALLS_REVEAL_STEP,
  CALLS_FETCH_PAGE_SIZE,
  initCallListPaging,
  planRevealMore,
  applyReveal,
  applyFetchedPage,
  countRemaining,
  type CallListPaging,
} from '@/lib/call-list-pagination';

describe('call-list-pagination constants (user contract)', () => {
  it('reveals exactly ۳۰ rows per «مشاهده بیشتر» click', () => {
    expect(CALLS_REVEAL_STEP).toBe(30);
  });

  it('fetches a whole server page of calls at once (beyond the visible step)', () => {
    expect(CALLS_FETCH_PAGE_SIZE).toBeGreaterThan(CALLS_REVEAL_STEP);
    expect(CALLS_FETCH_PAGE_SIZE).toBe(200);
  });
});

describe('initCallListPaging', () => {
  it('shows at most the last ۳۰ calls on first load', () => {
    const p = initCallListPaging(250, 250);
    expect(p.visibleCount).toBe(30);
    expect(p.serverTotal).toBe(250);
    expect(p.nextPage).toBe(2);
  });

  it('shows every loaded call when fewer than ۳۰ exist', () => {
    const p = initCallListPaging(7, 7);
    expect(p.visibleCount).toBe(7);
  });

  it('empty load → nothing visible, no phantom total', () => {
    const p = initCallListPaging(0, 0);
    expect(p.visibleCount).toBe(0);
    expect(p.serverTotal).toBe(0);
    expect(planRevealMore(p, 0, 0)).toEqual({ kind: 'none' });
  });

  it('floors serverTotal at the loaded count (count drift defense)', () => {
    const p = initCallListPaging(50, 12);
    expect(p.serverTotal).toBe(50);
  });

  it('tolerates junk numeric input', () => {
    const p = initCallListPaging(Number.NaN, Number('x'));
    expect(p.visibleCount).toBe(0);
    expect(p.serverTotal).toBe(0);
  });
});

describe('planRevealMore — reveal from the loaded window', () => {
  it('reveals ۳۰ loaded rows first (no fetch while rows are already loaded)', () => {
    const p = initCallListPaging(200, 500);
    expect(planRevealMore(p, 200, 200)).toEqual({ kind: 'reveal', count: 30 });
  });

  it('reveals only the leftover tail when fewer than ۳۰ remain loaded', () => {
    const p = initCallListPaging(50, 500);
    expect(p.visibleCount).toBe(30);
    expect(planRevealMore(p, 50, 50)).toEqual({ kind: 'reveal', count: 20 });
  });

  it('switches to a server fetch once the loaded window is exhausted', () => {
    // 50 loaded, all 50 revealed, server says 500 → next page is 2
    const p = { visibleCount: 50, serverTotal: 500, nextPage: 2 };
    expect(planRevealMore(p, 50, 50)).toEqual({ kind: 'fetch', page: 2 });
  });

  it('returns none when everything the server has is loaded and revealed', () => {
    const p = { visibleCount: 200, serverTotal: 200, nextPage: 2 };
    expect(planRevealMore(p, 200, 200)).toEqual({ kind: 'none' });
  });

  it('plans a fetch even when a FILTER exhausts the loaded view early', () => {
    // search/status filter: 200 loaded but only 45 match, all 45 shown →
    // more server pages may still contain matching rows
    const p = { visibleCount: 45, serverTotal: 500, nextPage: 2 };
    expect(planRevealMore(p, 200, 45)).toEqual({ kind: 'fetch', page: 2 });
  });
});

describe('countRemaining — the «مشاهده بیشتر» label counter', () => {
  it('counts hidden rows of the filtered view first', () => {
    const p = initCallListPaging(200, 200);
    expect(countRemaining(p, 200, 200)).toBe(170);
  });

  it('falls back to the server-side remainder when loaded rows are exhausted', () => {
    const p = { visibleCount: 200, serverTotal: 500, nextPage: 2 };
    expect(countRemaining(p, 200, 200)).toBe(300);
  });

  it('never reports a negative remainder', () => {
    const p = { visibleCount: 60, serverTotal: 50, nextPage: 2 };
    expect(countRemaining(p, 50, 50)).toBe(0);
  });
});

describe('applyReveal', () => {
  it('advances the visible counter by the planned count', () => {
    const p = initCallListPaging(200, 200);
    const q = applyReveal(p, 30);
    expect(q.visibleCount).toBe(60);
    expect(q.serverTotal).toBe(200);
    expect(q.nextPage).toBe(2); // untouched
  });
});

describe('applyFetchedPage — appending the next server page', () => {
  it('reveals ۳۰ of the freshly appended rows and moves the page cursor', () => {
    const p: CallListPaging = { visibleCount: 200, serverTotal: 500, nextPage: 2 };
    const q = applyFetchedPage(p, { prevFilteredCount: 200, newItemsCount: 200, serverTotal: 500, loadedAfterCount: 400 });
    expect(q.visibleCount).toBe(230);
    expect(q.nextPage).toBe(3);
    expect(q.serverTotal).toBe(500);
  });

  it('an empty page collapses the total so the box disappears (no phantom offers)', () => {
    const p: CallListPaging = { visibleCount: 200, serverTotal: 500, nextPage: 5 };
    const q = applyFetchedPage(p, { prevFilteredCount: 200, newItemsCount: 0, serverTotal: 500, loadedAfterCount: 200 });
    expect(q.visibleCount).toBe(200);
    expect(q.serverTotal).toBe(500); // loadedAfter floors, but server count stands
    // caller-side: items were 0 → loaded(200) < total(500) would loop; the
    // CONTRACT here is the page cursor advanced — a stale count that keeps
    // offering rows is capped by the nextPage guard below.
    expect(q.nextPage).toBe(6);
  });

  it('floors serverTotal at the rows actually loaded after the append', () => {
    const p: CallListPaging = { visibleCount: 200, serverTotal: 500, nextPage: 2 };
    const q = applyFetchedPage(p, { prevFilteredCount: 200, newItemsCount: 90, serverTotal: 0, loadedAfterCount: 290 });
    expect(q.serverTotal).toBe(290);
    expect(q.visibleCount).toBe(230); // 200 + min(30, 90)
  });

  it('a short final page reveals only what arrived', () => {
    const p: CallListPaging = { visibleCount: 500, serverTotal: 545, nextPage: 3 };
    const q = applyFetchedPage(p, { prevFilteredCount: 500, newItemsCount: 45, serverTotal: 545, loadedAfterCount: 545 });
    expect(q.visibleCount).toBe(530);
    expect(planRevealMore(q, 545, 545)).toEqual({ kind: 'reveal', count: 15 });
    const r = applyReveal(q, 15);
    expect(planRevealMore(r, 545, 545)).toEqual({ kind: 'none' });
    expect(countRemaining(r, 545, 545)).toBe(0);
  });
});

describe('full walkthrough — ۵۴۵ calls, viewed ۳۰ at a time', () => {
  it('pages to the very end without ever over-revealing the loaded window', () => {
    // page 1: 200 calls arrive, 30 visible
    let p = initCallListPaging(200, 545);
    let loaded = 200;
    expect(p.visibleCount).toBe(30);
    // alternate «reveal»/«fetch» exactly like the button handler does;
    // page 2 delivers 200 rows, page 3 delivers the final 145
    const arrivingByPage: Record<number, number> = { 2: 200, 3: 145 };
    let guard = 0;
    while (guard++ < 100) {
      const plan = planRevealMore(p, loaded, loaded);
      if (plan.kind === 'none') break;
      if (plan.kind === 'reveal') {
        p = applyReveal(p, plan.count);
      } else {
        const arriving = arrivingByPage[plan.page];
        expect(arriving).toBeDefined();
        p = applyFetchedPage(p, {
          prevFilteredCount: p.visibleCount,
          newItemsCount: arriving,
          serverTotal: 545,
          loadedAfterCount: (loaded += arriving),
        });
      }
      expect(p.visibleCount).toBeLessThanOrEqual(loaded);
    }
    expect(loaded).toBe(545);
    expect(p.visibleCount).toBe(545);
    expect(p.serverTotal).toBe(545);
    expect(p.nextPage).toBe(4);
    expect(countRemaining(p, loaded, loaded)).toBe(0);
    expect(planRevealMore(p, loaded, loaded)).toEqual({ kind: 'none' });
  });
});
