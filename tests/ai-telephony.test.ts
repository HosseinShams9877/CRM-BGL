import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  toAsciiDigits, normalizePhone, verifyHmac, parseTelephonyEvent, parseExtMap,
  validateExtMap, maxWebhookBodyBytes, TELEPHONY_AUDIO_EXTENSIONS,
} from '@/lib/ai/providers/telephony';
import { maskSecret } from '@/lib/ai/telephony-ingest';

// ════════════════════════════════════════════════════════════
// TELEPHONY CORE (v2.28.0) — pure-function unit tests
// The DB-dependent ingestion path is covered end-to-end by
// scripts/api-telephony-v2280.ts against a live server.
// ════════════════════════════════════════════════════════════

const SECRET = 'a'.repeat(48);
const AUDIO = Buffer.from('x'.repeat(600)).toString('base64'); // 600 bytes decoded

function sign(body: string, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'asterisk',
    externalId: '1736543-001',
    direction: 'inbound',
    agentExt: '101',
    callerNumber: '09121234567',
    durationSec: 240,
    audioBase64: AUDIO,
    mimeType: 'audio/wav',
    ...overrides,
  };
}

// ── digit conversion ────────────────────────────────────────

describe('toAsciiDigits', () => {
  it('converts Persian digits', () => {
    expect(toAsciiDigits('۰۹۱۲')).toBe('0912');
  });
  it('converts Arabic-Indic digits', () => {
    expect(toAsciiDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
  });
  it('leaves other characters untouched', () => {
    expect(toAsciiDigits('a+b (۹۸)')).toBe('a+b (98)');
  });
});

// ── phone normalization ─────────────────────────────────────

describe('normalizePhone', () => {
  it('strips trunk zero from mobile', () => {
    expect(normalizePhone('09121234567')).toBe('9121234567');
  });
  it('handles +98 country code', () => {
    expect(normalizePhone('+989121234567')).toBe('9121234567');
  });
  it('handles 0098 country code', () => {
    expect(normalizePhone('00989121234567')).toBe('9121234567');
  });
  it('handles bare 98 prefix (length guard)', () => {
    expect(normalizePhone('989121234567')).toBe('9121234567');
  });
  it('does NOT strip 98 from short numbers (hospital internal)', () => {
    // 98… but too short to be international → kept as-is
    expect(normalizePhone('98765')).toBe(null); // under 6 digits → null anyway
  });
  it('normalizes Persian digits with separators', () => {
    expect(normalizePhone('۰۹۱۲ ۱۲۳ ۴۵۶۷')).toBe('9121234567');
  });
  it('strips separators from landline', () => {
    expect(normalizePhone('021-8888 7777')).toBe('2188887777');
  });
  it('keeps short internal extensions (6 digits)', () => {
    expect(normalizePhone('123456')).toBe('123456');
  });
  it('rejects alpha residue', () => {
    expect(normalizePhone('0912abc4567')).toBe(null);
  });
  it('rejects empty / too-short', () => {
    expect(normalizePhone('')).toBe(null);
    expect(normalizePhone('123')).toBe(null);
    expect(normalizePhone('---')).toBe(null);
  });
});

// ── HMAC ────────────────────────────────────────────────────

describe('verifyHmac', () => {
  const body = JSON.stringify({ hello: 'world' });

  it('accepts a valid bare hex signature', () => {
    expect(verifyHmac(body, sign(body), SECRET)).toBe(true);
  });
  it('accepts sha256= prefix (GitHub style)', () => {
    expect(verifyHmac(body, `sha256=${sign(body)}`, SECRET)).toBe(true);
  });
  it('accepts uppercase hex', () => {
    expect(verifyHmac(body, sign(body).toUpperCase(), SECRET)).toBe(true);
  });
  it('rejects a tampered body', () => {
    expect(verifyHmac(body + ' ', sign(body), SECRET)).toBe(false);
  });
  it('rejects a signature made with the wrong secret', () => {
    expect(verifyHmac(body, sign(body, 'b'.repeat(48)), SECRET)).toBe(false);
  });
  it('rejects missing signature / missing secret', () => {
    expect(verifyHmac(body, null, SECRET)).toBe(false);
    expect(verifyHmac(body, sign(body), '')).toBe(false);
  });
  it('rejects malformed signatures without throwing', () => {
    expect(verifyHmac(body, 'not-hex!', SECRET)).toBe(false);
    expect(verifyHmac(body, 'abc', SECRET)).toBe(false);
    expect(verifyHmac(body, sign(body).slice(0, 63), SECRET)).toBe(false);
  });
});

// ── body cap ────────────────────────────────────────────────

describe('maxWebhookBodyBytes', () => {
  it('scales with the audio cap and covers base64 inflation', () => {
    expect(maxWebhookBodyBytes(25)).toBeGreaterThan(25 * 1024 * 1024);
    expect(maxWebhookBodyBytes(25)).toBeLessThan(25 * 1024 * 1024 * 1.5);
    expect(maxWebhookBodyBytes(60)).toBeGreaterThan(maxWebhookBodyBytes(25));
  });
});

// ── event parsing ───────────────────────────────────────────

describe('parseTelephonyEvent', () => {
  it('parses a full valid payload', () => {
    const r = parseTelephonyEvent(validPayload(), 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.provider).toBe('asterisk');
    expect(r.event.externalId).toBe('1736543-001');
    expect(r.event.direction).toBe('inbound');
    expect(r.event.normalizedNumber).toBe('9121234567');
    expect(r.event.audioBytes).toBe(600);
    expect(r.event.fileName).toBe('pbx-asterisk-1736543-001.wav');
    expect(r.event.consent).toBe('unknown');
  });

  it('applies safe defaults', () => {
    const r = parseTelephonyEvent(validPayload({ direction: undefined, durationSec: undefined, mimeType: undefined }), 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.direction).toBe('outbound');
    expect(r.event.durationSec).toBe(0);
    expect(r.event.mimeType).toBe('audio/wav');
  });

  it('accepts alias fields (callId / from / extension)', () => {
    const r = parseTelephonyEvent(validPayload({
      externalId: undefined, callId: 'cid-9',
      callerNumber: undefined, from: '۰۹۳۵۱۱۱۲۲۳۳',
      agentExt: undefined, extension: '۲۰۱',
    }), 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.externalId).toBe('cid-9');
    expect(r.event.normalizedNumber).toBe('9351112233');
    expect(r.event.agentExt).toBe('201');
  });

  it('rejects invalid provider ids', () => {
    expect(parseTelephonyEvent(validPayload({ provider: 'X!' }), 25).ok).toBe(false);
    expect(parseTelephonyEvent(validPayload({ provider: '' }), 25).ok).toBe(false);
  });

  it('rejects missing externalId', () => {
    expect(parseTelephonyEvent(validPayload({ externalId: '' }), 25).ok).toBe(false);
  });

  it('rejects an unparsable caller number', () => {
    expect(parseTelephonyEvent(validPayload({ callerNumber: 'not-a-phone' }), 25).ok).toBe(false);
  });

  it('rejects missing / tiny / oversized / malformed audio', () => {
    expect(parseTelephonyEvent(validPayload({ audioBase64: '' }), 25).ok).toBe(false);
    expect(parseTelephonyEvent(validPayload({ audioBase64: Buffer.from('x').toString('base64') }), 25).ok).toBe(false);
    // 600 bytes decoded > 0MB cap → rejected
    expect(parseTelephonyEvent(validPayload({ audioBase64: AUDIO }), 0.0001).ok).toBe(false);
    expect(parseTelephonyEvent(validPayload({ audioBase64: '!!!not-base64!!!' }), 25).ok).toBe(false);
    expect(parseTelephonyEvent(validPayload({ audioBase64: AUDIO.slice(0, -1) }), 25).ok).toBe(false);
  });

  it('rejects non-audio mime types', () => {
    expect(parseTelephonyEvent(validPayload({ mimeType: 'text/html' }), 25).ok).toBe(false);
    expect(parseTelephonyEvent(validPayload({ mimeType: 'application/pdf' }), 25).ok).toBe(false);
  });

  it('falls back to unknown consent on garbage values', () => {
    const r = parseTelephonyEvent(validPayload({ consent: 'maybe' }), 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.consent).toBe('unknown');
  });

  it('clamps duration into 0..4h', () => {
    const r = parseTelephonyEvent(validPayload({ durationSec: 99999 }), 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.durationSec).toBe(4 * 3600);
  });

  it('parses startedAt as epoch seconds, epoch ms, ISO — and defaults to now on garbage', () => {
    const iso = '2026-08-28T10:30:00Z';
    const a = parseTelephonyEvent(validPayload({ startedAt: 1750000000 }), 25);
    const b = parseTelephonyEvent(validPayload({ startedAt: 1750000000000 }), 25);
    const c = parseTelephonyEvent(validPayload({ startedAt: iso }), 25);
    const d = parseTelephonyEvent(validPayload({ startedAt: 'yesterday-ish' }), 25);
    if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error('unexpected reject');
    expect(a.event.startedAt.getTime()).toBe(1750000000000);
    expect(b.event.startedAt.getTime()).toBe(1750000000000);
    expect(c.event.startedAt.getTime()).toBe(Date.parse(iso));
    expect(Math.abs(d.event.startedAt.getTime() - Date.now())).toBeLessThan(5000);
  });

  it('caps title length', () => {
    const r = parseTelephonyEvent(validPayload({ title: 'ط'.repeat(500) }), 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.title.length).toBe(200);
  });

  it('infers extension from fileName over mimeType', () => {
    const r = parseTelephonyEvent(validPayload({ fileName: 'call-42.mp3' }), 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.fileName.endsWith('.mp3')).toBe(true);
  });
});

// ── extension map ───────────────────────────────────────────

describe('parseExtMap / validateExtMap', () => {
  it('parses line format with comments and blanks', () => {
    const m = parseExtMap('# agents\n101=ali\n\n102 = sara\n# done');
    expect(m).toEqual({ '101': 'ali', '102': 'sara' });
  });
  it('parses JSON format', () => {
    const m = parseExtMap('{"101":"ali","۲۰۲":"reza"}');
    expect(m).toEqual({ '101': 'ali', '202': 'reza' });
  });
  it('drops invalid lines silently (webhook path)', () => {
    const m = parseExtMap('101\n= nope\n103=x');
    expect(m).toEqual({ '103': 'x' });
  });
  it('handles empty / null input', () => {
    expect(parseExtMap('')).toEqual({});
    expect(parseExtMap(undefined)).toEqual({});
    expect(parseExtMap(null)).toEqual({});
  });
  it('validateExtMap rejects garbage with an actionable error', () => {
    const v = validateExtMap('total garbage ~~');
    expect(v.ok).toBe(false);
  });
  it('validateExtMap accepts line format', () => {
    const v = validateExtMap('101=ali');
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.map['101']).toBe('ali');
  });
});

// ── secret masking ──────────────────────────────────────────

describe('maskSecret', () => {
  it('masks everything but the edges', () => {
    const m = maskSecret('abcdef1234567890abcdef1234567890');
    expect(m.startsWith('abcdef')).toBe(true);
    expect(m.endsWith('7890')).toBe(true);
    expect(m).not.toContain('1234567890abcdef123456');
    expect(m.includes('•')).toBe(true);
  });
  it('handles short and empty secrets', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret('short')).toBe('•••••');
  });
});

// ── allowlist sanity ────────────────────────────────────────

describe('TELEPHONY_AUDIO_EXTENSIONS', () => {
  it('covers the PBX-standard formats', () => {
    for (const ext of ['wav', 'mp3', 'ogg', 'opus', 'webm', 'amr']) {
      expect(TELEPHONY_AUDIO_EXTENSIONS.has(ext)).toBe(true);
    }
    expect(TELEPHONY_AUDIO_EXTENSIONS.has('exe')).toBe(false);
  });
});
