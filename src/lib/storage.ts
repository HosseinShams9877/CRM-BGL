import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * BGL CRM — Real file storage helpers (P1-2 remediation, v2.9.0).
 * Pure functions only — no DB, no Next.js imports — so they can be unit
 * tested directly with Vitest. The route layer owns auth + persistence.
 *
 * Security policy:
 *  - Hard size cap (default 10 MB) enforced BEFORE buffering the request.
 *  - Extension blocklist for executables / scripts / active content.
 *  - MIME allowlist for known-good types; unknown binaries pass only
 *    when their extension is not blocked (defense in depth, both layers
 *    must agree).
 *  - Stored names are server-generated (32 hex chars) — the client name
 *    is metadata only and never touches the filesystem.
 *  - Every stored file carries a SHA-256 checksum, re-verified on download.
 */

// ── Policy constants ──────────────────────────────────────────
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Extensions that must never be accepted, regardless of claimed MIME. */
export const BLOCKED_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'ps1', 'psm1', 'sh', 'bash',
  'dll', 'msi', 'msp', 'jar', 'vbs', 'vbe', 'wsf', 'wsh', 'hta',
  // active content — can execute script when opened in a browser
  'html', 'htm', 'xhtml', 'svg', 'xml', 'swf',
]);

/** MIME types accepted without further questions. */
export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip', 'application/x-zip-compressed',
  'text/plain', 'text/csv',
  'application/json',
]);

// ── Extension handling ────────────────────────────────────────
/**
 * Extract and sanitize the extension of an original filename.
 * Returns 'bin' for anything unexpected (no dots, unicode, too long, …).
 */
export function sanitizeExtension(originalName: string): string {
  const idx = originalName.lastIndexOf('.');
  if (idx < 0 || idx === originalName.length - 1) return 'bin'; // no dot / trailing dot
  const raw = originalName.slice(idx + 1);
  if (!/^[a-zA-Z0-9]{1,8}$/.test(raw)) return 'bin';
  return raw.toLowerCase();
}

/** True when the (lowercased) extension is on the blocklist. */
export function isBlockedExtension(ext: string): boolean {
  return BLOCKED_EXTENSIONS.has(ext.toLowerCase());
}

// ── Upload policy decision ────────────────────────────────────
export interface UploadPolicyResult {
  ok: boolean;
  reason?: string; // Persian message for the client
}

/**
 * Combined policy check for one upload candidate.
 * @param mimeType  MIME type claimed by the multipart part
 * @param size      byte length of the payload
 * @param originalName client-side filename (extension only is inspected)
 */
export function checkUploadPolicy(mimeType: string, size: number, originalName: string): UploadPolicyResult {
  if (!originalName || typeof originalName !== 'string' || originalName.trim().length === 0) {
    return { ok: false, reason: 'نام فایل ارسالی نامعتبر است.' };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: 'فایل خالی قابل بارگذاری نیست.' };
  }
  if (size > MAX_FILE_SIZE) {
    return { ok: false, reason: `حجم فایل نباید از ۱۰ مگابایت بیشتر باشد. (حجم ارسالی: ${Math.ceil(size / (1024 * 1024))} مگابایت)` };
  }
  const ext = sanitizeExtension(originalName);
  if (isBlockedExtension(ext)) {
    return { ok: false, reason: `افزودن فایل با پسوند «.${ext}» به دلایل امنیتی مجاز نیست.` };
  }
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim();
  const knownBinary = mime === 'application/octet-stream' || mime === '';
  if (!ALLOWED_MIME_TYPES.has(mime) && !knownBinary) {
    return { ok: false, reason: `نوع فایل «${mime || 'نامشخص'}» پشتیبانی نمی‌شود.` };
  }
  return { ok: true };
}

// ── Content sniffing (v2.58.7 — production hardening, stage 7) ──
// The policy above trusts the CLAIMED multipart MIME + extension. A
// mislabeled upload (an HTML file claiming image/png) previously landed
// byte-identical on disk — mitigated by the attachment disposition and
// the server-generated name, but "check the REAL MIME" it was not.
// These helpers sniff the actual magic bytes and verify the claim.

/** Canonical content families detected from leading bytes. */
export type SniffedContent =
  | 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/bmp' | 'image/tiff'
  | 'application/pdf'
  | 'zip-container'   // docx / xlsx / pptx / zip (PK\x03\x04)
  | 'ole-container'   // legacy .doc/.xls/.ppt (D0 CF 11 E0)
  | 'audio/mpeg' | 'audio/wav' | 'audio/ogg' | 'ebml' | 'mp4-container'
  | 'active-content'  // HTML / PHP / script text
  | null;             // unknown

function latinHead(bytes: Uint8Array, text: string, offset = 0): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Magic-byte sniffer — the REAL type of the payload (null = unrecognized). */
export function sniffContentMime(bytes: Uint8Array): SniffedContent {
  if (!bytes || bytes.length < 4) return null;
  const b = bytes;
  const eq = (sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);

  // Binary magic signatures first.
  if (eq([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (eq([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (latinHead(b, 'GIF87a') || latinHead(b, 'GIF89a')) return 'image/gif';
  if (latinHead(b, 'RIFF') && bytes.length >= 12 && latinHead(b, 'WEBP', 8)) return 'image/webp';
  if (latinHead(b, 'BM')) return 'image/bmp';
  if (eq([0x49, 0x49, 0x2a, 0x00]) || eq([0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
  if (latinHead(b, '%PDF')) return 'application/pdf';
  if (eq([0x50, 0x4b, 0x03, 0x04]) || eq([0x50, 0x4b, 0x05, 0x06]) || eq([0x50, 0x4b, 0x07, 0x08])) return 'zip-container';
  if (eq([0xd0, 0xcf, 0x11, 0xe0])) return 'ole-container';
  if (latinHead(b, 'ID3')) return 'audio/mpeg';
  if (eq([0xff, 0xfb]) || eq([0xff, 0xf3]) || eq([0xff, 0xf2])) return 'audio/mpeg';
  if (latinHead(b, 'RIFF') && bytes.length >= 12 && latinHead(b, 'WAVE', 8)) return 'audio/wav';
  if (latinHead(b, 'OggS')) return 'audio/ogg';
  if (eq([0x1a, 0x45, 0xdf, 0xa3])) return 'ebml'; // webm/mkv
  if (latinHead(b, 'ftyp', 4)) return 'mp4-container'; // m4a/mp4/mov

  // Textual active content — the only text we detect (and reject).
  if (isProbablyText(bytes)) {
    const head = Buffer.from(bytes.slice(0, 2048)).toString('latin1').toLowerCase();
    if (
      head.includes('<!doctype html') || head.includes('<html') ||
      head.includes('<script') || head.includes('<?php') ||
      head.includes('<svg') || head.includes('<iframe')
    ) {
      return 'active-content';
    }
  }
  return null;
}

/** Heuristic: any NUL byte in the head means binary; otherwise text-ish. */
function isProbablyText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 512);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return false;
  }
  return true;
}

/** Sniffed families that satisfy each CLAIMED mime (claim → acceptable sniff). */
const CLAIM_TO_SNIFF: Record<string, SniffedContent[]> = {
  'image/jpeg': ['image/jpeg'],
  'image/png': ['image/png'],
  'image/gif': ['image/gif'],
  'image/webp': ['image/webp'],
  'image/bmp': ['image/bmp'],
  'image/tiff': ['image/tiff'],
  'application/pdf': ['application/pdf'],
  'application/zip': ['zip-container'],
  'application/x-zip-compressed': ['zip-container'],
  'application/msword': ['ole-container'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['zip-container'],
  'application/vnd.ms-excel': ['ole-container'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['zip-container'],
  'application/vnd.ms-powerpoint': ['ole-container'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['zip-container'],
};

/** Audio families the voice/call-upload paths accept. */
const AUDIO_SNIFF_FAMILIES: SniffedContent[] = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'ebml', 'mp4-container'];

export interface ContentCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify the payload's REAL content against the claim (v2.58.7, stage 7).
 * Conservative by design — unverifiable payloads pass (only the magic-byte
 * families above are decidable); active content (HTML/PHP/script) is
 * rejected regardless of the claim; a claim that IS decidable must match.
 */
export function verifyUploadContent(mimeType: string, bytes: Uint8Array): ContentCheckResult {
  const sniffed = sniffContentMime(bytes);
  if (sniffed === 'active-content') {
    return { ok: false, reason: 'محتوای فایل شامل کد فعال (HTML/اسکریپت) است و قابل بارگذاری نیست.' };
  }
  const claim = (mimeType || '').toLowerCase().split(';')[0].trim();
  const acceptable = CLAIM_TO_SNIFF[claim];
  if (acceptable && sniffed !== null && !acceptable.includes(sniffed)) {
    return { ok: false, reason: 'محتوای فایل با نوع اعلان‌شده هم‌خوانی ندارد.' };
  }
  return { ok: true };
}

/**
 * Audio-specific content verification for the voice/call upload paths:
 * the sniffed family must be an audio family (webm/EBML counts —
 * MediaRecorder emits audio/webm). A text or image payload claiming
 * audio is refused before any STT spend.
 */
export function verifyAudioContent(bytes: Uint8Array): ContentCheckResult {
  const sniffed = sniffContentMime(bytes);
  if (sniffed === 'active-content') {
    return { ok: false, reason: 'محتوای فایل صوتی شامل کد فعال (HTML/اسکریپت) است و قابل بارگذاری نیست.' };
  }
  if (sniffed !== null && !AUDIO_SNIFF_FAMILIES.includes(sniffed)) {
    return { ok: false, reason: 'محتوای فایل صوتی با فرمت اعلان‌شده هم‌خوانی ندارد.' };
  }
  return { ok: true };
}

// ── Hashing & naming ──────────────────────────────────────────
/** SHA-256 of the payload as lowercase hex. */
export function sha256Hex(data: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Server-controlled storage name: 32 random hex chars + sanitized extension. */
export function generateStoredName(originalName: string): string {
  return `${crypto.randomBytes(16).toString('hex')}.${sanitizeExtension(originalName)}`;
}

// ── Filesystem layout ─────────────────────────────────────────
/**
 * Absolute uploads directory (env override → STORAGE_DIR).
 *
 * v2.30.0 — the standalone server (`.next/standalone/server.js`) chdirs into
 * `.next/standalone` at boot, so anchoring the default on `process.cwd()`
 * placed uploads INSIDE `.next/` — a directory that every `next build` wipes.
 * When we detect the standalone CWD we anchor the default two levels up —
 * the project root.
 *
 * v2.58.6 (user P4) — the RELATIVE-STORAGE_DIR contract is now IDENTICAL
 * to the shared CLI resolver (scripts/lib/resolve-env.mjs):
 *   • an absolute value (POSIX / Windows drive / UNC) passes through;
 *   • a RELATIVE value anchors at the PROJECT ROOT (start.mjs spawns
 *     the server with cwd=<root> — the app's real runtime contract),
 *     never at an incidental cwd;
 *   • legacy guard: when the OLD cwd-anchored location has data and the
 *     root-anchored one is empty, the data location wins — an existing
 *     install is never silently switched to a fresh empty folder.
 * Parity is enforced by tests/storage-path-parity.test.ts.
 */
function projectRootForStorage(): string {
  const cwd = process.cwd();
  if (/(?:^|[\\/])\.next[\\/]standalone$/.test(cwd)) {
    return path.resolve(cwd, '..', '..');
  }
  return cwd;
}

function dirHasContent(p: string): boolean {
  try {
    return fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function isAbsolutePath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return true; // POSIX / UNC
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true; // Windows drive letter
  return false;
}

export function getStorageDir(): string {
  const root = projectRootForStorage();
  const v = process.env.STORAGE_DIR?.trim();
  if (v) {
    if (isAbsolutePath(v)) return v;
    // v2.58.11 (Vercel deployment fix): these two resolves anchor a
    // RUNTIME env path (STORAGE_DIR) — statically unscopable, so
    // Turbopack would trace the whole project (and copy .env /
    // dev.db into .next/standalone). /*turbopackIgnore: true*/ is
    // its documented opt-out for intentionally dynamic access.
    const rootAnchored = path.resolve(/*turbopackIgnore: true*/ root, v);
    const cwdAnchored = path.resolve(/*turbopackIgnore: true*/ process.cwd(), v);
    // legacy data guard — keep the location that actually holds the data
    if (rootAnchored !== cwdAnchored && dirHasContent(cwdAnchored) && !dirHasContent(rootAnchored)) {
      return cwdAnchored;
    }
    return rootAnchored;
  }
  return path.join(root, 'storage', 'uploads');
}

/**
 * Resolve a stored name to an absolute path, refusing traversal.
 * Returns null when the resolved path escapes the uploads directory.
 */
export function resolveStoredPath(storedName: string): string | null {
  if (!/^[a-f0-9]{32}\.[a-z0-9]{1,8}$/.test(storedName)) return null; // strict shape
  const dir = getStorageDir();
  const full = path.resolve(dir, storedName);
  if (path.dirname(full) !== dir) return null; // escaped the uploads dir
  return full;
}
