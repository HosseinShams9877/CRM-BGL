import { describe, it, expect } from 'vitest';
import {
  testOpenAiCompatEndpoint, validateEndpointUrl,
} from '@/lib/ai/connection-test';

// ════════════════════════════════════════════════════════════
// CONNECTION TEST CORE (v2.28.1) — pure-function unit tests.
// fetch is injectable, so every branch (2xx/401/404/5xx/network/
// timeout/keyless) is covered without a live endpoint.
// ════════════════════════════════════════════════════════════

type FetchCall = { url: string; headers: Record<string, string>; body: unknown };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(status: number, body: unknown, capture?: FetchCall[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
    }
    return jsonResponse(status, body);
  }) as unknown as typeof fetch;
}

describe('validateEndpointUrl', () => {
  it('accepts a full http chat-completions URL', () => {
    expect(validateEndpointUrl('http://localhost:11434/v1/chat/completions')).toEqual({
      ok: true,
      url: 'http://localhost:11434/v1/chat/completions',
    });
  });

  it('rejects a malformed URL with a Persian error', () => {
    const r = validateEndpointUrl('not-a-url');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('آدرس سرویس نامعتبر');
  });

  it('rejects non-http schemes', () => {
    const r = validateEndpointUrl('ftp://example.com/v1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('http');
  });
});

describe('testOpenAiCompatEndpoint — success path', () => {
  it('reports ok with model echo and latency', async () => {
    const r = await testOpenAiCompatEndpoint({
      url: 'http://localhost:11434/v1/chat/completions',
      model: 'qwen2.5:14b',
      fetchImpl: mockFetch(200, { model: 'qwen2.5:14b', choices: [{ message: { content: 'ok' } }] }),
    });
    expect(r.ok).toBe(true);
    expect(r.model).toBe('qwen2.5:14b');
    expect(typeof r.latencyMs).toBe('number');
    expect(r.message).toContain('اتصال برقرار است');
  });

  it('falls back to the requested model when the server does not echo one', async () => {
    const r = await testOpenAiCompatEndpoint({
      url: 'http://localhost:8000/v1/chat/completions',
      model: 'glm-4',
      fetchImpl: mockFetch(200, { choices: [] }),
    });
    expect(r.ok).toBe(true);
    expect(r.model).toBe('glm-4');
  });

  it('treats a 2xx non-JSON body as reachable', async () => {
    const fetchImpl = (async () => new Response('plain', { status: 200 })) as unknown as typeof fetch;
    const r = await testOpenAiCompatEndpoint({
      url: 'http://localhost:8080/v1/chat/completions',
      model: 'm',
      fetchImpl,
    });
    expect(r.ok).toBe(true);
  });
});

describe('testOpenAiCompatEndpoint — failure diagnosis', () => {
  it('401 → auth hint (key wrong; local servers need none)', async () => {
    const r = await testOpenAiCompatEndpoint({
      url: 'https://api.example.com/v1/chat/completions',
      model: 'm',
      fetchImpl: mockFetch(401, { error: 'bad key' }),
    });
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(401);
    expect(r.message).toContain('احراز هویت');
  });

  it('404 → full-path hint mentioning chat/completions', async () => {
    const r = await testOpenAiCompatEndpoint({
      url: 'http://localhost:11434/v1',
      model: 'm',
      fetchImpl: mockFetch(404, {}),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Chat Completions');
  });

  it('5xx → server-side error wording', async () => {
    const r = await testOpenAiCompatEndpoint({
      url: 'http://localhost:8000/v1/chat/completions',
      model: 'm',
      fetchImpl: mockFetch(503, {}),
    });
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(503);
    expect(r.message).toContain('سمت سرویس');
  });

  it('network refusal → domain/proxy/firewall wording', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const r = await testOpenAiCompatEndpoint({
      url: 'https://api.sanctioned.example/v1/chat/completions',
      model: 'm',
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('اتصال شبکه');
  });

  it('timeout → deadline wording with the sanctioned-service note', async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }) as unknown as typeof fetch;
    const r = await testOpenAiCompatEndpoint({
      url: 'https://api.sanctioned.example/v1/chat/completions',
      model: 'm',
      timeoutMs: 30,
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('پاسخی دریافت نشد');
    expect(r.message).toContain('ایران');
  });
});

describe('testOpenAiCompatEndpoint — request shape & secret hygiene', () => {
  const calls: FetchCall[] = [];

  it('keyless endpoints send no Authorization header (Ollama/vLLM)', async () => {
    await testOpenAiCompatEndpoint({
      url: 'http://localhost:11434/v1/chat/completions',
      model: 'qwen2.5:14b',
      fetchImpl: mockFetch(200, {}, calls),
    });
    expect(calls.at(-1)?.headers['Authorization']).toBeUndefined();
  });

  it('keyed endpoints send the Bearer token', async () => {
    await testOpenAiCompatEndpoint({
      url: 'https://api.example.com/v1/chat/completions',
      apiKey: 'sk-secret-123',
      model: 'm',
      fetchImpl: mockFetch(200, {}, calls),
    });
    expect(calls.at(-1)?.headers['Authorization']).toBe('Bearer sk-secret-123');
  });

  it('probe body is a minimal chat completion (max_tokens 1)', async () => {
    await testOpenAiCompatEndpoint({
      url: 'http://localhost:11434/v1/chat/completions',
      model: 'qwen2.5:14b',
      fetchImpl: mockFetch(200, {}, calls),
    });
    const body = calls.at(-1)?.body as Record<string, unknown>;
    expect(body.max_tokens).toBe(1);
    expect(body.model).toBe('qwen2.5:14b');
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('the API key never leaks into any failure message', async () => {
    const key = 'sk-very-secret-key-987654321';
    const results = await Promise.all([
      testOpenAiCompatEndpoint({ url: 'https://x.example/v1/chat/completions', apiKey: key, model: 'm', fetchImpl: mockFetch(401, {}) }),
      testOpenAiCompatEndpoint({ url: 'https://x.example/v1/chat/completions', apiKey: key, model: 'm', fetchImpl: mockFetch(404, {}) }),
      testOpenAiCompatEndpoint({ url: 'https://x.example/v1/chat/completions', apiKey: key, model: 'm', fetchImpl: mockFetch(500, {}) }),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.message).not.toContain(key);
    }
  });

  it('rejects an invalid URL before any network call', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return jsonResponse(200, {}); }) as unknown as typeof fetch;
    const r = await testOpenAiCompatEndpoint({ url: '::bad::', model: 'm', fetchImpl });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});
