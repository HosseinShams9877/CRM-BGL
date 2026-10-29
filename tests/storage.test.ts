// Unit tests — file storage policy helpers (P1-2, v2.9.0).
// Covers: extension sanitization, blocklist enforcement, size cap,
// MIME allowlist, checksum stability, path-traversal resistance.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  MAX_FILE_SIZE,
  BLOCKED_EXTENSIONS,
  sanitizeExtension,
  isBlockedExtension,
  checkUploadPolicy,
  sha256Hex,
  generateStoredName,
  getStorageDir,
  resolveStoredPath,
} from '@/lib/storage';

describe('sanitizeExtension', () => {
  it('lowercases a normal extension', () => {
    expect(sanitizeExtension('report.PDF')).toBe('pdf');
  });

  it('returns bin for files with no extension', () => {
    expect(sanitizeExtension('README')).toBe('bin');
  });

  it('returns bin for unicode or overlong suffixes', () => {
    expect(sanitizeExtension('file.فارسی')).toBe('bin');
    expect(sanitizeExtension('file.toolongextension')).toBe('bin');
  });

  it('takes only the last segment after a dot', () => {
    expect(sanitizeExtension('archive.tar.gz')).toBe('gz');
  });
});

describe('extension blocklist', () => {
  it('blocks executables and script types', () => {
    for (const ext of ['exe', 'bat', 'sh', 'ps1', 'dll', 'jar', 'vbs']) {
      expect(isBlockedExtension(ext)).toBe(true);
    }
  });

  it('blocks active content that can execute in browsers', () => {
    expect(BLOCKED_EXTENSIONS.has('svg')).toBe(true);
    expect(BLOCKED_EXTENSIONS.has('html')).toBe(true);
  });

  it('allows normal document extensions', () => {
    for (const ext of ['pdf', 'png', 'jpg', 'xlsx', 'docx', 'csv', 'txt']) {
      expect(isBlockedExtension(ext)).toBe(false);
    }
  });
});

describe('checkUploadPolicy', () => {
  it('accepts a normal PDF under the size cap', () => {
    const r = checkUploadPolicy('application/pdf', 1024, 'قرارداد.pdf');
    expect(r.ok).toBe(true);
  });

  it('rejects an oversized file with a Persian message', () => {
    const r = checkUploadPolicy('application/pdf', MAX_FILE_SIZE + 1, 'big.pdf');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('مگابایت');
  });

  it('rejects empty payloads', () => {
    const r = checkUploadPolicy('application/pdf', 0, 'empty.pdf');
    expect(r.ok).toBe(false);
  });

  it('rejects a blocked extension even with a lying MIME type', () => {
    // attack: rename malware.exe → claims image/png
    const r = checkUploadPolicy('image/png', 2048, 'invoice.png.exe');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('exe');
  });

  it('rejects an unknown MIME type that is not octet-stream', () => {
    const r = checkUploadPolicy('application/x-unknown-danger', 100, 'data.xud');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('پشتیبانی نمی‌شود');
  });

  it('allows unknown binaries (octet-stream) with a clean extension', () => {
    const r = checkUploadPolicy('application/octet-stream', 100, 'export.docm');
    expect(r.ok).toBe(true);
  });

  it('rejects a missing filename', () => {
    const r = checkUploadPolicy('application/pdf', 100, '');
    expect(r.ok).toBe(false);
  });

  it('is case-insensitive on the claimed MIME type', () => {
    const r = checkUploadPolicy('APPLICATION/PDF', 100, 'a.pdf');
    expect(r.ok).toBe(true);
  });
});

describe('sha256Hex', () => {
  it('matches the known SHA-256 of "abc"', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic for identical payloads', () => {
    const a = sha256Hex(Buffer.from('hello world'));
    const b = sha256Hex(Buffer.from('hello world'));
    expect(a).toBe(b);
  });

  it('changes when a single byte changes', () => {
    const a = sha256Hex(Buffer.from([1, 2, 3]));
    const b = sha256Hex(Buffer.from([1, 2, 4]));
    expect(a).not.toBe(b);
  });
});

describe('generateStoredName / resolveStoredPath', () => {
  it('produces 32-hex + sanitized extension', () => {
    const name = generateStoredName('عکس مرکز.PNG');
    expect(name).toMatch(/^[a-f0-9]{32}\.png$/);
  });

  it('refuses traversal-shaped stored names', () => {
    expect(resolveStoredPath('../../etc/passwd')).toBeNull();
    expect(resolveStoredPath('a/b/c.pdf')).toBeNull();
    expect(resolveStoredPath('short.pdf')).toBeNull();
    expect(resolveStoredPath('ABCDEF0123456789ABCDEF0123456789.pdf')).toBeNull(); // uppercase → not the server-generated shape
  });

  it('accepts a well-formed stored name inside the storage dir', () => {
    process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bgl-storage-'));
    try {
      const p = resolveStoredPath('abcdef0123456789abcdef0123456789.pdf');
      expect(p).toBe(path.join(process.env.STORAGE_DIR!, 'abcdef0123456789abcdef0123456789.pdf'));
    } finally {
      fs.rmSync(process.env.STORAGE_DIR!, { recursive: true, force: true });
      delete process.env.STORAGE_DIR;
    }
  });

  it('getStorageDir honors the STORAGE_DIR override', () => {
    const prev = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = '/tmp/bgl-test-uploads';
    try {
      expect(getStorageDir()).toBe('/tmp/bgl-test-uploads');
    } finally {
      if (prev === undefined) delete process.env.STORAGE_DIR;
      else process.env.STORAGE_DIR = prev;
    }
  });

  // v2.30.0 — the standalone server chdirs into .next/standalone; the default
  // uploads dir must anchor at the PROJECT root (two levels up), never inside
  // .next/ (which `next build` wipes → silent loss of every uploaded file).
  it('anchors the default at the project root when CWD is .next/standalone', () => {
    const prev = process.env.STORAGE_DIR;
    delete process.env.STORAGE_DIR;
    const prevCwd = process.cwd();
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bgl-standalone-'));
    const fakeStandalone = path.join(fakeRoot, '.next', 'standalone');
    fs.mkdirSync(fakeStandalone, { recursive: true });
    try {
      process.chdir(fakeStandalone);
      const dir = getStorageDir();
      const expected = path.join(fakeRoot, 'storage', 'uploads');
      expect(dir).toBe(expected);
      // and it must NOT live under .next/
      expect(dir.startsWith(path.join(fakeRoot, '.next'))).toBe(false);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(fakeRoot, { recursive: true, force: true });
      if (prev === undefined) delete process.env.STORAGE_DIR;
      else process.env.STORAGE_DIR = prev;
    }
  });

  it('keeps the plain CWD default outside standalone mode', () => {
    const prev = process.env.STORAGE_DIR;
    delete process.env.STORAGE_DIR;
    try {
      // vitest runs from the project root — not a .next/standalone path
      expect(getStorageDir()).toBe(path.join(process.cwd(), 'storage', 'uploads'));
    } finally {
      if (prev === undefined) delete process.env.STORAGE_DIR;
      else process.env.STORAGE_DIR = prev;
    }
  });
});
