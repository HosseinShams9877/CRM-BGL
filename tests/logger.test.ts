import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forScope, logApiError } from '@/lib/logger';

describe('logger (P2-6)', () => {
  const originalLevel = process.env.BGL_LOG_LEVEL;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLevel === undefined) delete process.env.BGL_LOG_LEVEL;
    else process.env.BGL_LOG_LEVEL = originalLevel;
  });

  it('emits error with scope tag and ISO timestamp', () => {
    logApiError('billing', 'boom');
    const call = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    const line = call[0] as string;
    expect(line).toMatch(/\[billing API\] ERROR boom/);
    expect(line).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('redacts password/token key-value pairs in message text', () => {
    logApiError('users', 'login failed {"password":"hunter2"} for user admin');
    const line = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(line).toContain('[REDACTED]');
    expect(line).not.toContain('hunter2');
  });

  it('redacts sensitive keys in structured meta objects', () => {
    forScope('auth').error('oops', { token: 'abc123', user: 'admin' });
    const call = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.stringify(call)).not.toContain('abc123');
    expect(JSON.stringify(call)).toContain('[REDACTED]');
    expect(JSON.stringify(call)).toContain('admin');
  });

  it('stringifies Error objects with name and message', () => {
    logApiError('files', new Error('disk full'));
    const line = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(line).toContain('Error: disk full');
  });

  it('forScope exposes all four levels', () => {
    const log = forScope('test-scope');
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    expect((console.log as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2); // debug+info in dev
    expect((console.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((console.error as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
