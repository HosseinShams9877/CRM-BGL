import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// safe-outbound-cleanup.test.ts — v2.58.5 (user finding R5)
//
// THE AUDIT REPRO (confirmed on the v2.58.4 code):
//   • wrapBodyWithDeadline's guardedRead returned the value on
//     SUCCESS without calling the cleanup callback — the timer
//     stayed armed (a LATE deadline fired after the operation had
//     fully succeeded) and the transport resources were never freed;
//   • the wrapper's own dispose() called the RAW res.dispose()
//     directly, bypassing the cleanup callback entirely (timer
//     never cleared on the dispose path).
//
// THE CONTRACT (fake timers + an instrumented transport):
//   • a successful text/json/bytes read clears the timer AND
//     disposes the transport;
//   • dispose() without reading the body runs the FULL cleanup;
//   • body error, deadline timeout, over-cap response → cleanup ran;
//   • double dispose is safe (idempotent, no destructive repeat);
//   • after a successful read, NO late deadline ever fires.
// The deadline, size cap, IP pinning and redirect policy are
// unchanged — only the resource-release paths are under test here.
// ═══════════════════════════════════════════════════════════════

import { safeOutboundFetch, type SafeOutboundResponse } from '@/lib/safe-outbound';
import type { SafeOutboundTarget } from '@/lib/ssrf-guard';

interface TransportLog {
  disposed: number;
  reads: number;
}

/** An instrumented transport whose body methods are controllable. */
function makeTransport(opts: {
  body?: () => Promise<string>;
  failRead?: boolean;
  hangBody?: boolean;
}) {
  const log: TransportLog & { aborted: number } = { disposed: 0, reads: 0, aborted: 0 };
  const transport = async (
    _target: SafeOutboundTarget,
    _init: unknown,
    ctx: { signal: AbortSignal },
  ): Promise<SafeOutboundResponse> => {
    // observe LATE aborts: a cleared timer never fires the signal
    ctx.signal.addEventListener('abort', () => { log.aborted += 1; }, { once: true });
    const res: SafeOutboundResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      text: async () => {
        if (opts.failRead) throw new Error('body read failed');
        if (opts.hangBody) await new Promise(() => undefined); // never resolves
        log.reads += 1;
        return opts.body ? await opts.body() : '{"ok":true}';
      },
      json: async <T>() => JSON.parse(await res.text()) as T,
      bytes: async () => new TextEncoder().encode(await res.text()),
      dispose: () => {
        log.disposed += 1; // counts EVERY raw dispose call
      },
    };
    return res;
  };
  return { transport, log };
}

const resolver = async () => [{ address: '93.184.216.34', family: 4 }];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('R5 — resource cleanup on every exit path', () => {
  it('SUCCESSFUL text read: timer cleared + transport disposed + no late deadline', async () => {
    const { transport, log } = makeTransport({});
    const guarded = await safeOutboundFetch('https://service.example.com/v1/complete', {}, {
      timeoutMs: 5_000,
      transport,
      resolver,
      allowLocalEndpoints: false,
    });
    const text = await guarded.text();
    expect(text).toBe('{"ok":true}');

    // THE FIX: a successful read releases the timer AND the transport
    expect(log.disposed).toBeGreaterThanOrEqual(1);
    expect(log.reads).toBe(1);

    // advance PAST the deadline — the late timer must NOT have fired:
    // no abort on the transport signal, no unhandled rejection
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.aborted).toBe(0); // ← THE TIMER WAS REALLY CLEARED
    expect(log.disposed).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('SUCCESSFUL json/bytes reads also release everything', async () => {
    for (const read of ['json', 'bytes'] as const) {
      const { transport, log } = makeTransport({});
      const guarded = await safeOutboundFetch('https://service.example.com/v1/complete', {}, {
        timeoutMs: 5_000, transport, resolver, allowLocalEndpoints: false,
      });
      if (read === 'json') {
        expect(await guarded.json()).toEqual({ ok: true });
      } else {
        expect(await guarded.bytes()).toBeInstanceOf(Uint8Array);
      }
      expect(log.disposed).toBeGreaterThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(log.aborted).toBe(0);
    }
  }, 20_000);

  it('dispose() WITHOUT reading the body: the FULL cleanup runs (timer + transport)', async () => {
    const { transport, log } = makeTransport({});
    const guarded = await safeOutboundFetch('https://service.example.com/v1/complete', {}, {
      timeoutMs: 5_000, transport, resolver, allowLocalEndpoints: false,
    });
    expect(log.disposed).toBe(0); // nothing released yet
    guarded.dispose();            // ← THE FIX: the wrapper's dispose now runs the FULL cleanup
    expect(log.disposed).toBeGreaterThanOrEqual(1);
    expect(log.reads).toBe(0);

    // the timer is gone: advancing past the deadline is a no-op
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.disposed).toBeGreaterThanOrEqual(1);
    expect(log.aborted).toBe(0); // ← the wrapper's dispose cleared the timer
  }, 20_000);

  it('DOUBLE dispose: no error, no destructive repeat effect', async () => {
    const { transport } = makeTransport({});
    const guarded = await safeOutboundFetch('https://service.example.com/v1/complete', {}, {
      timeoutMs: 5_000, transport, resolver, allowLocalEndpoints: false,
    });
    expect(() => {
      guarded.dispose();
      guarded.dispose();
      guarded.dispose();
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
  }, 20_000);

  it('body read ERROR → cleanup runs', async () => {
    const { transport, log } = makeTransport({ failRead: true });
    const guarded = await safeOutboundFetch('https://service.example.com/v1/complete', {}, {
      timeoutMs: 5_000, transport, resolver, allowLocalEndpoints: false,
    });
    await expect(guarded.text()).rejects.toThrow('body read failed');
    expect(log.disposed).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(10_000);
  }, 20_000);

  it('hanging body → deadline fires, cleanup runs, Persian timeout surfaces', async () => {
    const { transport, log } = makeTransport({ hangBody: true });
    const guarded = await safeOutboundFetch('https://service.example.com/v1/complete', {}, {
      timeoutMs: 5_000, transport, resolver, allowLocalEndpoints: false,
    });
    const readPromise = guarded.text();
    // attach the rejection assertion BEFORE advancing the timers so the
    // rejected promise is never momentarily unhandled
    const expectation = expect(readPromise).rejects.toMatchObject({ name: 'SafeOutboundTimeoutError' });
    // the deadline rejects the read and releases the resources
    await vi.advanceTimersByTimeAsync(5_100);
    await expectation;
    expect(log.disposed).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('over-cap response → SizeError + cleanup', async () => {
    const { transport, log } = makeTransport({ body: async () => 'x'.repeat(100) });
    const guarded = await safeOutboundFetch('https://service.example.com/v1/complete', {}, {
      timeoutMs: 5_000, maxResponseBytes: 10, transport, resolver, allowLocalEndpoints: false,
    });
    await expect(guarded.text()).rejects.toMatchObject({ name: 'SafeOutboundSizeError' });
    expect(log.disposed).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
