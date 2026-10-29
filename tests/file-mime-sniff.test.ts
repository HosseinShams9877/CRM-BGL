import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import {
  sniffContentMime,
  verifyUploadContent,
  verifyAudioContent,
} from '@/lib/storage';

// ═══════════════════════════════════════════════════════════════
// file-mime-sniff.test.ts — v2.58.7 (stage 7 — «MIME واقعی بررسی شود»)
//
// THE REGRESSION (confirmed on the pre-fix v2.58.6 code): the upload
// policy trusted the multipart MIME claim + an extension blocklist.
// A mislabeled upload (an HTML file claiming image/png) landed
// byte-identical on disk. Now the CONTENT is sniffed (magic bytes) and
// the claim is verified; active content (HTML/PHP/script) is rejected
// regardless of the claim; unverifiable payloads pass conservatively.
//
// The route-level half goes through the REAL /api/files handler with a
// scratch STORAGE_DIR: a rejected upload leaves ZERO residue (no row,
// no physical file) — the user's mandatory «Upload شکست بخورد: نباید
// فایل orphan ایجاد شود».
// ═══════════════════════════════════════════════════════════════

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 3)]);
const ZIP_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 4)]);
const OLE_BYTES = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(64, 5)]);
const MP3_ID3_BYTES = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 6)]);
const EBML_BYTES = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 7)]);
const HTML_BYTES = Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>');
const PHP_BYTES = Buffer.from('<?php echo "x"; ?>\n' + 'A'.repeat(200));
const PLAIN_TEXT_BYTES = Buffer.from('سلام — گزارش فروش ماه جاری ' + 'x'.repeat(200));
const OGG_BYTES = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 8)]);
const RIFF_WAV_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WAVE'), Buffer.alloc(64, 9)]);

describe('unit — sniffContentMime (magic bytes)', () => {
  it('recognizes the common binary families', () => {
    expect(sniffContentMime(PNG_BYTES)).toBe('image/png');
    expect(sniffContentMime(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffContentMime(PDF_BYTES)).toBe('application/pdf');
    expect(sniffContentMime(ZIP_BYTES)).toBe('zip-container');
    expect(sniffContentMime(OLE_BYTES)).toBe('ole-container');
    expect(sniffContentMime(MP3_ID3_BYTES)).toBe('audio/mpeg');
    expect(sniffContentMime(EBML_BYTES)).toBe('ebml');
    expect(sniffContentMime(OGG_BYTES)).toBe('audio/ogg');
    expect(sniffContentMime(RIFF_WAV_BYTES)).toBe('audio/wav');
  });

  it('recognizes active content regardless of the surrounding text', () => {
    expect(sniffContentMime(HTML_BYTES)).toBe('active-content');
    expect(sniffContentMime(PHP_BYTES)).toBe('active-content');
  });

  it('returns null for unrecognized clean content (conservative)', () => {
    expect(sniffContentMime(PLAIN_TEXT_BYTES)).toBeNull();
    expect(sniffContentMime(Buffer.alloc(0))).toBeNull();
    expect(sniffContentMime(Buffer.from('12'))).toBeNull();
  });
});

describe('unit — verifyUploadContent (the claim is checked against the content)', () => {
  it('REJECTS HTML masquerading as image/png (the classic mislabel)', () => {
    const r = verifyUploadContent('image/png', HTML_BYTES);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('کد فعال');
  });

  it('REJECTS a claim/content mismatch among decidable families', () => {
    // claims PDF, actually a ZIP
    expect(verifyUploadContent('application/pdf', ZIP_BYTES).ok).toBe(false);
    // claims PNG, actually a JPEG
    expect(verifyUploadContent('image/png', JPEG_BYTES).ok).toBe(false);
    // claims docx (zip family), actually OLE
    expect(
      verifyUploadContent('application/vnd.openxmlformats-officedocument.wordprocessingml.document', OLE_BYTES).ok,
    ).toBe(false);
  });

  it('ACCEPTS honest claims and unverifiable-but-clean payloads', () => {
    expect(verifyUploadContent('image/png', PNG_BYTES).ok).toBe(true);
    expect(verifyUploadContent('application/pdf', PDF_BYTES).ok).toBe(true);
    expect(verifyUploadContent('text/plain', PLAIN_TEXT_BYTES).ok).toBe(true);
    expect(verifyUploadContent('application/octet-stream', Buffer.alloc(128, 9)).ok).toBe(true);
  });

  it('REJECTS script-bearing text claiming text/plain', () => {
    expect(verifyUploadContent('text/plain', HTML_BYTES).ok).toBe(false);
  });
});

describe('unit — verifyAudioContent (the voice/call upload gate)', () => {
  it('ACCEPTS real audio families', () => {
    expect(verifyAudioContent(EBML_BYTES).ok).toBe(true); // MediaRecorder webm
    expect(verifyAudioContent(MP3_ID3_BYTES).ok).toBe(true);
    expect(verifyAudioContent(OGG_BYTES).ok).toBe(true);
    expect(verifyAudioContent(RIFF_WAV_BYTES).ok).toBe(true);
  });

  it('REJECTS HTML/script bytes claiming audio (pre-STT protection)', () => {
    const r = verifyAudioContent(HTML_BYTES);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('صوتی');
  });

  it('REJECTS image bytes claiming audio', () => {
    expect(verifyAudioContent(PNG_BYTES).ok).toBe(false);
  });

  it('ACCEPTS unknown-but-clean bytes (conservative for exotic recorders)', () => {
    expect(verifyAudioContent(Buffer.alloc(256, 11)).ok).toBe(true);
  });
});

// ── route-level: the REAL /api/files handler, scratch storage ──

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as filesPost } from '@/app/api/files/route';

const db = new PrismaClient();
const TAG = `r97mime-${Date.now().toString(36)}`;
let storageDir: string;

interface TestUser {
  id: string; username: string; displayName: string; role: string; roleLabel: string;
  businessUnitId: string; companyIds: string[]; jobTitle: string | null; isActive: boolean;
  impersonator: null; territoryMode: string; territoryProvinces: string | null; territoryCenterIds: string | null;
}

beforeAll(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgl-mime-'));
  process.env.STORAGE_DIR = storageDir;
  const u = await db.user.create({
    data: {
      username: `${TAG}-user`, displayName: 'mime user', passwordHash: 'x', role: 'standard',
      companyIds: JSON.stringify(['bazargani']), businessUnitId: 'trading',
    },
  });
  currentAuthUser = {
    id: u.id, username: u.username, displayName: u.displayName, role: 'standard', roleLabel: '',
    businessUnitId: 'trading', companyIds: ['bazargani'], jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]',
  } as TestUser;
});

afterAll(async () => {
  delete process.env.STORAGE_DIR;
  fs.rmSync(storageDir, { recursive: true, force: true });
  await db.file.deleteMany({ where: { originalName: { startsWith: `${TAG}` } } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

function uploadReq(fileName: string, mimeType: string, bytes: Buffer): NextRequest {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(bytes)], fileName, { type: mimeType }));
  fd.append('originalName', fileName);
  fd.append('mimeType', mimeType);
  return new NextRequest('http://localhost/api/files', { method: 'POST', body: fd });
}

describe('route — the REAL /api/files upload gate', () => {
  it('REGRESSION GUARD: HTML claiming image/png → 400 with ZERO residue (no row, no file on disk)', async () => {
    const name = `${TAG}-evil.png`;
    const res = await filesPost(uploadReq(name, 'image/png', HTML_BYTES));
    expect(res.status).toBe(400);
    expect(await db.file.count({ where: { originalName: name } })).toBe(0);
    expect((await fsp.readdir(storageDir)).length).toBe(0);
  });

  it('an honest PNG still stores (content policy is not a blanket ban)', async () => {
    const name = `${TAG}-honest.png`;
    const res = await filesPost(uploadReq(name, 'image/png', PNG_BYTES));
    expect(res.status).toBe(201);
    const row = await db.file.findFirst({ where: { originalName: name } });
    expect(row).not.toBeNull();
    expect(fs.existsSync(path.join(storageDir, row!.storedName))).toBe(true);
  });

  it('a mismatched decodable claim (PDF label, ZIP bytes) → 400, zero residue', async () => {
    const name = `${TAG}-fake.pdf`;
    const res = await filesPost(uploadReq(name, 'application/pdf', ZIP_BYTES));
    expect(res.status).toBe(400);
    expect(await db.file.count({ where: { originalName: name } })).toBe(0);
  });
});
