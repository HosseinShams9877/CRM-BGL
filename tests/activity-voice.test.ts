// Unit tests for the activity voice-note policy (v2.34.7).
// Pure module — no DB, no Next.js imports.
import { describe, it, expect } from 'vitest';
import {
  MAX_VOICE_BYTES,
  MAX_VOICE_SECONDS,
  voiceMimeBase,
  isAllowedVoiceMime,
  voiceMimeExtension,
  checkVoicePolicy,
  voiceOriginalName,
} from '../src/lib/activity-voice';

describe('voiceMimeBase', () => {
  it('drops codec parameters', () => {
    expect(voiceMimeBase('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(voiceMimeBase('audio/ogg;codecs=opus')).toBe('audio/ogg');
  });
  it('lowercases and trims', () => {
    expect(voiceMimeBase('  Audio/MP4 ')).toBe('audio/mp4');
  });
  it('survives empty input', () => {
    expect(voiceMimeBase('')).toBe('');
  });
});

describe('isAllowedVoiceMime', () => {
  it('accepts every MediaRecorder output family', () => {
    for (const m of ['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-m4a']) {
      expect(isAllowedVoiceMime(m), m).toBe(true);
    }
  });
  it('rejects non-audio and spoofed types', () => {
    for (const m of ['video/webm', 'application/octet-stream', 'audio/flac', 'text/plain', '']) {
      expect(isAllowedVoiceMime(m), m).toBe(false);
    }
  });
});

describe('voiceMimeExtension', () => {
  it('maps base mimes to disk extensions', () => {
    expect(voiceMimeExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(voiceMimeExtension('audio/mp4')).toBe('m4a');
    expect(voiceMimeExtension('audio/mpeg')).toBe('mp3');
    expect(voiceMimeExtension('audio/wav')).toBe('wav');
  });
  it('returns null for rejected types', () => {
    expect(voiceMimeExtension('video/webm')).toBeNull();
    expect(voiceMimeExtension('')).toBeNull();
  });
});

describe('checkVoicePolicy', () => {
  it('accepts a normal webm note under the cap', () => {
    expect(checkVoicePolicy('audio/webm;codecs=opus', 48_000)).toEqual({ ok: true });
  });
  it('rejects non-audio mime with a Persian reason', () => {
    const r = checkVoicePolicy('image/png', 1000);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('فایل صوتی');
  });
  it('rejects empty payloads', () => {
    const r = checkVoicePolicy('audio/webm', 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });
  it('rejects payloads over the 10 MB cap', () => {
    const r = checkVoicePolicy('audio/webm', MAX_VOICE_BYTES + 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('۱۰ مگابایت');
  });
});

describe('voiceOriginalName', () => {
  it('derives a stable, dated, ext-only server name', () => {
    expect(voiceOriginalName('2026-08-30T12:00:00.000Z', 'webm')).toBe('voice-note-2026-08-30.webm');
  });
  it('handles a missing date without throwing', () => {
    expect(voiceOriginalName('', 'm4a')).toBe('voice-note-undated.m4a');
  });
});

describe('recorder caps', () => {
  it('caps match the documented limits', () => {
    expect(MAX_VOICE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_VOICE_SECONDS).toBe(300);
  });
});
