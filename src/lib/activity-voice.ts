// ════════════════════════════════════════════════════════════
// ACTIVITY VOICE NOTE POLICY (v2.34.7)
//
// Pure helpers for the quick-activity voice note («ویس») feature.
// The generic /api/files policy allowlists document types and would
// reject audio, so the voice route owns a stricter, audio-only gate:
//   • MIME must be a known audio type (base type before ';' — MediaRecorder
//     reports e.g. "audio/webm;codecs=opus")
//   • Extension is server-derived from the canonical mime, never the
//     client filename (so a .exe claiming audio/ogg never lands on disk)
//   • Hard 10 MB cap (matches MAX_FILE_SIZE; quick notes are ~seconds long)
// No DB, no Next.js imports — unit-tested directly with Vitest.
// ════════════════════════════════════════════════════════════

export const MAX_VOICE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_VOICE_SECONDS = 300; // 5 min recorder cap (client-enforced, server-informed)

/** Canonical audio types we accept, mapped to the extension used on disk. */
const VOICE_MIME_TO_EXT: Record<string, string> = {
  'audio/webm': 'webm', // MediaRecorder default (Chrome/Firefox)
  'audio/ogg': 'ogg',   // MediaRecorder fallback (older Firefox)
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',   // MediaRecorder fallback (Safari)
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
};

/** Base MIME type — everything before ';' (drops codec parameters). */
export function voiceMimeBase(mimeType: string): string {
  return (mimeType || '').toLowerCase().split(';')[0].trim();
}

export function isAllowedVoiceMime(mimeType: string): boolean {
  return voiceMimeBase(mimeType) in VOICE_MIME_TO_EXT;
}

/** Storage extension for an accepted voice MIME (null when not accepted). */
export function voiceMimeExtension(mimeType: string): string | null {
  return VOICE_MIME_TO_EXT[voiceMimeBase(mimeType)] ?? null;
}

export interface VoicePolicyResult {
  ok: boolean;
  /** Persian rejection reason for the client. */
  reason?: string;
}

/** Combined gate for one uploaded voice blob. */
export function checkVoicePolicy(mimeType: string, size: number): VoicePolicyResult {
  if (!isAllowedVoiceMime(mimeType)) {
    return { ok: false, reason: 'فقط فایل صوتی (webm / ogg / mp3 / m4a / wav) پذیرفته می‌شود.' };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: 'فایل صوتی خالی است.' };
  }
  if (size > MAX_VOICE_BYTES) {
    return { ok: false, reason: 'حجم ویس نباید از ۱۰ مگابایت بیشتر باشد.' };
  }
  return { ok: true };
}

/**
 * Stable original-name for the File row. Server-generated so a hostile
 * client filename never reaches storage metadata semantics; carries the
 * date so the row is identifiable in the admin files list.
 */
export function voiceOriginalName(activityDateIso: string, ext: string): string {
  const day = (activityDateIso || '').slice(0, 10) || 'undated';
  return `voice-note-${day}.${ext}`;
}
