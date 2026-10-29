// ════════════════════════════════════════════════════════════
// FILE LIFECYCLE SERVICE (v2.58.3 — round 88, user finding 9)
//
// WHY: the old upload wrote bytes to the FINAL path first and
// registered the DB row second — a crash between the two left either
// an orphan file or (on the calls path) an orphan row, with NO state
// marking either. Downloads ran fs.readFileSync + a synchronous
// whole-file SHA-256 INSIDE the request path (unbounded memory), and
// the audio twin did the same.
//
// THE LIFECYCLE:
//   pending   row registered, bytes still moving (temp .part file)
//   committed bytes durable at the final path — downloadable
//
// Order of operations (all failure paths recoverable):
//   1. write bytes to <storedName>.part (temp, same filesystem)
//   2. DB row created with status='pending'
//   3. atomic rename .part → final (same fs = atomic)
//   4. row flipped to 'committed'
// A crash after (2) leaves a pending row + a .part file — IDENTIFIED
// and RECOVERED by sweepStalePendingFiles() (rows older than the
// lease window whose final file never appeared). Pending rows are
// never downloadable. The sweeper never touches a committed file or
// an upload younger than the window (an ACTIVE upload is safe).
//
// CHECKSUMS: verification at download time is ASYNC and chunked
// (bounded memory — no readFileSync loop in the request path); the
// response body is STREAMED (fs.createReadStream), and the stream is
// closed on error or checksum mismatch.
// ════════════════════════════════════════════════════════════

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { db } from '@/lib/db';
import { generateStoredName, getStorageDir, resolveStoredPath, sha256Hex } from '@/lib/storage';
import { logApiError } from '@/lib/logger';
import { ApiError } from '@/lib/api-error';

export const FILE_STATUS_PENDING = 'pending';
export const FILE_STATUS_COMMITTED = 'committed';
/** v2.58.4 (external audit F06) — a delete in flight: the bytes are not
 *  settled yet, so the tracking row MUST stay (recoverable via the
 *  sweeper). Never downloadable. */
export const FILE_STATUS_DELETING = 'deleting';

/** A pending row older than this is a crashed/interrupted upload. */
export const PENDING_LEASE_MS = 10 * 60 * 1000; // 10 minutes

/** Chunk size for async checksum verification (bounded memory). */
const VERIFY_CHUNK_BYTES = 64 * 1024;

// ── upload orchestration ────────────────────────────────────

export interface StoreFileInput {
  bytes: Buffer | Uint8Array;
  originalName: string;
  mimeType: string;
  storedName?: string;
  centerId?: string | null;
  category?: string | null;
  createdById?: string | null;
}

export interface StoredFile {
  id: string;
  storedName: string;
  checksum: string;
  size: number;
}

/**
 * Store a file through the full lifecycle (temp write → pending row →
 * atomic rename → committed). Any failure rolls back BOTH sides:
 * the temp/final file is removed and the pending row is deleted —
 * no half-finished state survives an ERROR (crashes are recovered by
 * the sweeper). Throws ApiError(500, Persian) on failure.
 */
export async function storeFileLifecycle(input: StoreFileInput): Promise<StoredFile> {
  const storageDir = getStorageDir();
  await fsp.mkdir(storageDir, { recursive: true });
  const storedName = input.storedName ?? generateStoredName(input.originalName);
  const finalPath = path.join(storageDir, storedName);
  const tempPath = `${finalPath}.part`;

  const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  const checksum = sha256Hex(bytes);

  let rowId: string | null = null;
  let renamed = false; // the final path is OURS only after the rename
  try {
    // 1. durable temp write (same filesystem as the final path)
    await fsp.writeFile(tempPath, bytes, { mode: 0o600 });

    // 2. register the row as PENDING (identifiable, recoverable)
    const row = await db.file.create({
      data: {
        originalName: (input.originalName || storedName).slice(0, 255),
        storedName,
        mimeType: input.mimeType || 'application/octet-stream',
        size: bytes.length, // server-measured, never the client's claim
        checksum,
        centerId: input.centerId ?? null,
        category: input.category ?? null,
        createdById: input.createdById ?? null,
        status: FILE_STATUS_PENDING,
      },
      select: { id: true },
    });
    rowId = row.id;

    // 3. atomic promote (same fs → rename is atomic)
    await fsp.rename(tempPath, finalPath);
    renamed = true;

    // 4. commit
    await db.file.update({
      where: { id: row.id },
      data: { status: FILE_STATUS_COMMITTED },
    });

    return { id: row.id, storedName, checksum, size: bytes.length };
  } catch (e: unknown) {
    // Rollback BOTH sides of THIS operation — nothing half-finished
    // survives an error. The temp file is always ours to remove; the
    // FINAL path is removed only when WE renamed it (a step-2 failure —
    // e.g. a storedName unique clash — must NOT delete the legitimate
    // file another row already owns under that name).
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    if (renamed) {
      await fsp.rm(finalPath, { force: true }).catch(() => undefined);
    }
    if (rowId) {
      await db.file.delete({ where: { id: rowId } }).catch(() => undefined);
    }
    logApiError('file-lifecycle', 'store failed:', storedName, e instanceof Error ? e.message : String(e));
    throw new ApiError(500, 'ذخیرهٔ فایل با خطا مواجه شد — عملیات به‌صورت کامل لغو شد.');
  }
}

// ── recovery ────────────────────────────────────────────────

export interface SweepReport {
  sweptPendingRows: number;
  sweptTempFiles: number;
  /** Pending rows whose final bytes appeared (crash after the atomic
   *  rename) — PROMOTED to committed after size+checksum agreement. */
  promotedRows: number;
  /** Stale pending rows whose final file FAILED size/checksum validation —
   *  reported, never promoted and never deleted (an admin decides). */
  invalidPendingRows: Array<{ id: string; storedName: string; reason: string }>;
  /** 'deleting' rows fully settled by this sweep (row removed — the bytes
   *  had already gone, or the retry unlink succeeded). */
  deletingRowsSettled: number;
  /** 'deleting' rows whose bytes still refuse to die — row KEPT + reported. */
  deletingFailures: Array<{ id: string; storedName: string }>;
  /** Orphan .part temp files (older than the lease, owned by no row) removed. */
  orphanPartFiles: number;
  /** Every step that failed (honest counters — successes only count real successes). */
  errors: string[];
  /** Committed rows whose physical file is missing — REPORTED, never deleted or fabricated. */
  missingContentRows: Array<{ id: string; storedName: string }>;
}

/** Size + checksum agreement check for a promotion candidate (async,
 *  chunked — bounded memory). Returns a reason string on mismatch. */
async function promotionMismatch(
  storedName: string,
  row: { size: number; checksum: string | null },
): Promise<string | null> {
  const storedPath = resolveStoredPath(storedName);
  if (!storedPath) return 'invalid stored name';
  let actualSize: number;
  try {
    actualSize = (await fsp.stat(storedPath)).size;
  } catch {
    return 'final file vanished mid-sweep';
  }
  if (actualSize !== row.size) {
    return `size mismatch (row ${row.size}B, disk ${actualSize}B)`;
  }
  if (row.checksum) {
    const hash = crypto.createHash('sha256');
    try {
      const stream = fs.createReadStream(storedPath, { highWaterMark: VERIFY_CHUNK_BYTES });
      for await (const chunk of stream) hash.update(chunk as Buffer);
    } catch {
      return 'unreadable during checksum';
    }
    if (hash.digest('hex') !== row.checksum) return 'checksum mismatch';
  }
  return null;
}

/** The shared delete core: settle one file row's bytes, then its row.
 *  NEVER deletes the tracking row before the bytes are settled. */
async function settleFileDeletion(
  row: { id: string; storedName: string; status: string },
  _opts: { throwOnFsFailure: boolean },
): Promise<{ settled: boolean; fsError?: string }> {
  const storedPath = resolveStoredPath(row.storedName);
  // A storedName that fails the shape check never had a real path; the
  // bytes cannot exist — settle the row (honest, no fabricated content).
  if (storedPath) {
    try {
      await fsp.unlink(storedPath);
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code !== 'ENOENT') {
        // REAL unlink failure (EACCES/EBUSY/…): the bytes are still on
        // disk — the row MUST stay trackable.
        const reason = e instanceof Error ? `${e.message}` : String(e);
        logApiError('file-lifecycle', 'delete fs failure (row kept):', row.storedName, reason);
        return { settled: false, fsError: reason };
      }
    }
  }
  // bytes settled (unlinked or never existed) → remove the row
  try {
    await db.file.delete({ where: { id: row.id } });
  } catch (e: unknown) {
    const reason = e instanceof Error ? `${e.message}` : String(e);
    logApiError('file-lifecycle', 'delete row failure (bytes already gone):', row.id, reason);
    return { settled: false, fsError: reason };
  }
  return { settled: true };
}

/**
 * v2.58.4 (external audit F06) — THE recoverable delete. The old
 * API delete ran removeQuietly() (unlink failures swallowed) and then
 * dropped the DB row: an EACCES/EBUSY produced a 200 «حذف شد» with the
 * bytes still on disk and NO row tracking them — a silent orphan. The
 * inverse crash (unlink ok, row delete fails) left a row whose bytes
 * were gone.
 *
 * Contract:
 *   1. the row is marked 'deleting' FIRST (a delete in flight — never
 *      downloadable, visible to the health tool);
 *   2. unlink failure → the row STAYS in 'deleting' with the real error
 *      logged and an honest 500 to the caller («رکورد نگه داشته شد») —
 *      a later retry or the sweeper settles it;
 *   3. success → the row is removed only AFTER the bytes are settled;
 *   4. a crash between unlink and row-delete leaves a 'deleting' row
 *      whose bytes are gone — the sweeper recovers exactly that.
 * Pending rows (never fully uploaded) are settled directly (row + temp).
 */
export async function deleteFileLifecycle(fileId: string): Promise<void> {
  const row = await db.file.findUnique({
    where: { id: fileId },
    select: { id: true, storedName: true, status: true },
  });
  if (!row) throw new ApiError(404, 'فایل یافت نشد.');
  if (row.status === FILE_STATUS_DELETING) {
    // a previous attempt left the deletion in flight — resume it
    const r = await settleFileDeletion(row, { throwOnFsFailure: true });
    if (!r.settled) {
      throw new ApiError(500, 'حذف فیزیکی فایل کامل نشد؛ رکورد فایل برای پیگیری نگه داشته شد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.');
    }
    return;
  }
  if (row.status === FILE_STATUS_PENDING) {
    // half-finished upload — no durable bytes to protect; settle row+temp
    await fsp.rm(`${resolveStoredPath(row.storedName)}.part`, { force: true }).catch(() => undefined);
    const r = await settleFileDeletion(row, { throwOnFsFailure: false });
    if (!r.settled) {
      throw new ApiError(500, 'حذف رکورد فایل ناقص ناموفق بود؛ رکورد نگه داشته شد.');
    }
    return;
  }
  // committed → mark deleting (conditional — a concurrent delete only
  // flips it once), then settle the bytes, then the row
  await db.file.updateMany({
    where: { id: row.id, status: FILE_STATUS_COMMITTED },
    data: { status: FILE_STATUS_DELETING },
  });
  const r = await settleFileDeletion({ ...row, status: FILE_STATUS_DELETING }, { throwOnFsFailure: true });
  if (!r.settled) {
    // fs failure: the row is already 'deleting' — it stays, tracked
    throw new ApiError(500, 'حذف فیزیکی فایل ناموفق بود؛ رکورد فایل برای پیگیری نگه داشته شد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.');
  }
}

/** Quiet variant for batch sweepers (AI retention): same contract, but
 *  failures are collected instead of thrown.
 *  v2.58.11 (independent audit P1-3b) — FAIL-CLOSED flip: the
 *  'committed → deleting' status change is LOAD-BEARING. The 2.58.10
 *  code swallowed its failure and settled the bytes anyway — a
 *  transient DB error left a 'committed' row whose file had just been
 *  unlinked (users hit 410s; retention counted audio as deleted while
 *  the row kept serving). Now a failed OR non-matching flip returns
 *  false WITHOUT touching the bytes: the row stays exactly as it was,
 *  the caller reports an honest failure, and a later retry settles. */
export async function deleteFileRowQuiet(
  row: { id: string; storedName: string; status: string },
): Promise<boolean> {
  if (row.status === FILE_STATUS_COMMITTED) {
    let marked: { count: number };
    try {
      marked = await db.file.updateMany({
        where: { id: row.id, status: FILE_STATUS_COMMITTED },
        data: { status: FILE_STATUS_DELETING },
      });
    } catch (e: unknown) {
      // fail-closed: the flip is the write barrier — without it the
      // bytes are NOT ours to remove
      logApiError(
        'file-lifecycle',
        'delete status-flip failed (bytes untouched — fail-closed):',
        row.storedName,
        e instanceof Error ? e.message : String(e),
      );
      return false;
    }
    if (!marked || marked.count !== 1) {
      // the row changed under us (re-committed / already deleting via
      // another path) — its current state governs, not our stale read
      logApiError(
        'file-lifecycle',
        'delete status-flip matched no committed row (bytes untouched — fail-closed):',
        row.storedName,
      );
      return false;
    }
  }
  const r = await settleFileDeletion({ ...row, status: FILE_STATUS_DELETING }, { throwOnFsFailure: false });
  return r.settled;
}

/**
 * Recover half-finished uploads and in-flight deletions:
 *   • pending rows older than the lease with NO final file → temp removed,
 *     row deleted;
 *   • pending rows whose final file appeared (crash after rename) →
 *     PROMOTED, but only after size+checksum agreement (a mismatch is
 *     REPORTED, never promoted, never deleted);
 *   • 'deleting' rows: bytes gone → row settled; bytes present → unlink
 *     retried; a failure keeps the row and is REPORTED (never counted
 *     as success);
 *   • orphan .part temp files older than the lease with no owning row
 *     are removed (crash between temp write and row registration);
 *   • committed rows without bytes are REPORTED only.
 * Every counter counts a REAL settled outcome; failures land in
 * errors/deletingFailures instead of being swallowed.
 */
export async function sweepStalePendingFiles(now = Date.now()): Promise<SweepReport> {
  const cutoff = new Date(now - PENDING_LEASE_MS);
  const report: SweepReport = {
    sweptPendingRows: 0,
    sweptTempFiles: 0,
    promotedRows: 0,
    invalidPendingRows: [],
    deletingRowsSettled: 0,
    deletingFailures: [],
    orphanPartFiles: 0,
    errors: [],
    missingContentRows: [],
  };

  // ── stale pending rows (cursor-paginated to exhaustion — v2.58.10:
  // the old unbounded single read put the whole stale set in memory;
  // the deleting phase's take:5_000 stopped settling after one page).
  // A DB failure in this phase → zero row removals (fail-closed) and
  // an honest error — the sweep never guesses when the table is
  // unreadable. ──
  let pendingCursor: string | undefined;
  let stalePagesRemaining = true;
  try {
    while (stalePagesRemaining) {
      const stale = await db.file.findMany({
        where: { status: FILE_STATUS_PENDING, createdAt: { lt: cutoff } },
        select: { id: true, storedName: true, size: true, checksum: true },
        orderBy: { id: 'asc' },
        take: 500,
        ...(pendingCursor ? { skip: 1, cursor: { id: pendingCursor } } : {}),
      });
      if (stale.length === 0) break;
      if (stale.length < 500) stalePagesRemaining = false;
      pendingCursor = stale[stale.length - 1].id;

  for (const row of stale) {
    // v2.58.7 (F3): the sweep previously built the path with a raw
    // path.join — a poisoned storedName (shape-checked everywhere ELSE:
    // downloads, deletes, streaming) could escape the storage dir here.
    // The same strict resolveStoredPath gate now applies; a bad shape is
    // REPORTED and the row left untouched (an admin inspects it).
    const finalPath = resolveStoredPath(row.storedName);
    if (!finalPath) {
      report.invalidPendingRows.push({ id: row.id, storedName: row.storedName, reason: 'storedName failed the strict shape check' });
      logApiError('file-lifecycle', 'sweep refused: invalid storedName shape:', row.storedName);
      continue;
    }
    const tempPath = `${finalPath}.part`;
    const hasFinal = fs.existsSync(finalPath);
    if (hasFinal) {
      // the rename happened but the commit didn't — PROMOTE only after
      // the bytes agree with the row (F12: checksum/size before promote)
      const mismatch = await promotionMismatch(row.storedName, row);
      if (mismatch) {
        report.invalidPendingRows.push({ id: row.id, storedName: row.storedName, reason: mismatch });
        logApiError('file-lifecycle', 'promote refused (bytes disagree with row):', row.storedName, mismatch);
        continue;
      }
      const updated = await db.file.updateMany({
        where: { id: row.id, status: FILE_STATUS_PENDING },
        data: { status: FILE_STATUS_COMMITTED },
      }).catch(() => null);
      if (updated && updated.count === 1) report.promotedRows += 1;
      else report.errors.push(`promote race lost for ${row.storedName}`);
      continue;
    }
    // no final file → the upload truly died; remove the residue
    let tempRemoved = false;
    if (fs.existsSync(tempPath)) {
      try {
        await fsp.rm(tempPath, { force: true });
        tempRemoved = true;
        report.sweptTempFiles += 1;
      } catch (e: unknown) {
        report.errors.push(`temp removal failed for ${row.storedName}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      await db.file.delete({ where: { id: row.id } });
      report.sweptPendingRows += 1;
      if (!tempRemoved && fs.existsSync(tempPath)) {
        // row gone but temp bytes remain — counted as a failure, honestly
        report.errors.push(`row swept but .part bytes remain for ${row.storedName}`);
      }
    } catch (e: unknown) {
      report.errors.push(`row removal failed for ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    }
  }
  } catch (e: unknown) {
    // fail-closed: the pending phase could not read the table — NOTHING
    // is removed by this phase; the error is reported honestly.
    report.errors.push(`pending-phase read failed — ZERO pending removals this run (fail-closed): ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 'deleting' rows: settle or retry (F06; cursor-paginated to
  // exhaustion — v2.58.10: the take:5_000 cap stopped settling after
  // the first page). Fail-closed on read failure, same rule. ──
  let deletingCursor: string | undefined;
  let deletingPagesRemaining = true;
  try {
    while (deletingPagesRemaining) {
      const deleting = await db.file.findMany({
        where: { status: FILE_STATUS_DELETING },
        select: { id: true, storedName: true, status: true },
        orderBy: { id: 'asc' },
        take: 500,
        ...(deletingCursor ? { skip: 1, cursor: { id: deletingCursor } } : {}),
      });
      if (deleting.length === 0) break;
      if (deleting.length < 500) deletingPagesRemaining = false;
      deletingCursor = deleting[deleting.length - 1].id;
      for (const row of deleting) {
        const settled = await deleteFileRowQuiet(row);
        if (settled) report.deletingRowsSettled += 1;
        else report.deletingFailures.push({ id: row.id, storedName: row.storedName });
      }
    }
  } catch (e: unknown) {
    report.errors.push(`deleting-phase read failed — ZERO deleting settlements this run (fail-closed): ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── orphan .part temp files (no owning row, older than the lease) ──
  const storageDir = getStorageDir();
  let dirEntries: string[] = [];
  try {
    dirEntries = await fsp.readdir(storageDir);
  } catch { /* no storage dir → nothing to sweep */ }
  // v2.58.10 (final-review P2 — ownership completeness): the pre-fix
  // code judged every .part against the FIRST 50,000 File rows — a
  // .part whose owning row sat beyond that page was misjudged an
  // orphan and DELETED (live-upload data loss). The candidates now
  // come FROM the directory, ownership is answered for EXACTLY those
  // names (chunked IN on the unique storedName, complete for any DB
  // size), and is RE-CHECKED immediately before every removal. A DB
  // failure anywhere in the ownership path fails CLOSED — zero
  // deletions from this phase, the error reported honestly.
  const oldPartCandidates: Array<{ name: string; base: string; p: string }> = [];
  for (const name of dirEntries) {
    if (!name.endsWith('.part')) continue;
    const p = path.join(storageDir, name);
    try {
      const st = await fsp.stat(p);
      if (now - st.mtimeMs < PENDING_LEASE_MS) continue; // too young — could be pre-row
      oldPartCandidates.push({ name, base: name.slice(0, -'.part'.length), p });
    } catch (e: unknown) {
      report.errors.push(`orphan .part stat failed for ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (oldPartCandidates.length > 0) {
    let owned: Set<string>;
    try {
      owned = await owningNamesFor(oldPartCandidates.map((c) => c.base));
    } catch (e: unknown) {
      owned = new Set();
      report.errors.push(`ownership query failed — ZERO .part deletions this run (fail-closed): ${e instanceof Error ? e.message : String(e)}`);
      oldPartCandidates.length = 0; // nothing is removable without proven ownership
    }
    for (const c of oldPartCandidates) {
      if (owned.has(c.base)) continue; // an owning row exists — never an orphan
      // re-check ownership IMMEDIATELY before the removal (a concurrent
      // registration may have landed between the batch query and the rm)
      try {
        const stillOwned = await db.file.findFirst({ where: { storedName: c.base }, select: { id: true } });
        if (stillOwned) continue;
      } catch (e: unknown) {
        report.errors.push(`ownership re-check failed for ${c.name} — not removed (fail-closed): ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      try {
        await fsp.rm(c.p, { force: true });
        report.orphanPartFiles += 1;
      } catch (e: unknown) {
        report.errors.push(`orphan .part removal failed for ${c.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // committed rows without physical content: REPORTED only (never
  // deleted, never fabricated — an admin decides what to do)
  try {
    report.missingContentRows = await reportMissingContent();
  } catch (e: unknown) {
    report.errors.push(`missing-content report failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return report;
}

/** Committed rows whose stored file is absent on disk (report-only).
 *  v2.58.10 (final-review P2): paginates with a cursor to EXHAUSTION —
 *  the old take:5_000 cap silently stopped reporting after the first
 *  5,000 committed rows. */
export async function reportMissingContent(): Promise<Array<{ id: string; storedName: string }>> {
  const missing: Array<{ id: string; storedName: string }> = [];
  let cursorId: string | undefined;
  for (;;) {
    const page: Array<{ id: string; storedName: string }> = await db.file.findMany({
      where: { status: FILE_STATUS_COMMITTED },
      select: { id: true, storedName: true },
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });
    if (page.length === 0) break;
    for (const row of page) {
      const p = resolveStoredPath(row.storedName);
      if (!p || !fs.existsSync(p)) missing.push(row);
    }
    if (page.length < 500) break;
    cursorId = page[page.length - 1].id;
  }
  return missing;
}

// ── health snapshot (read-only — the CLI's dry-run default) ──

/** v2.58.10 (final-review P2 — ownership completeness): answer "which of
 *  THESE candidate names does a File row own?" EXACTLY — chunked IN
 *  queries on the UNIQUE storedName, complete for any table size (no
 *  page cap can miss an owner). Throws on DB failure so every caller
 *  can fail closed instead of guessing. */
const OWNERSHIP_QUERY_CHUNK = 500;
async function owningNamesFor(candidates: string[]): Promise<Set<string>> {
  const owned = new Set<string>();
  for (let i = 0; i < candidates.length; i += OWNERSHIP_QUERY_CHUNK) {
    const chunk = candidates.slice(i, i + OWNERSHIP_QUERY_CHUNK);
    const rows = await db.file.findMany({
      where: { storedName: { in: chunk } },
      select: { storedName: true },
    });
    for (const r of rows) owned.add(r.storedName);
  }
  return owned;
}

export interface FilesHealthSnapshot {
  totalRows: number;
  committedRows: number;
  pendingRows: number;
  deletingRows: number;
  /** Pending rows older than the lease (crashed uploads a --sweep settles). */
  stalePendingRows: number;
  missingContentRows: Array<{
    id: string;
    storedName: string;
    originalName: string;
    size: number;
    centerId: string | null;
    createdAt: Date;
  }>;
  /** Physical final-named objects with no DB row (harmless orphan bytes). */
  orphanFinalFiles: number;
  /** Physical .part temp files with no owning row (a --sweep settles the stale ones). */
  orphanPartFiles: number;
  diskObjects: number;
  storageDir: string;
  /** v2.58.11 (independent audit P1-3b): PHYSICAL-side inspection failures.
   *  Non-empty ⇒ the physical counters (diskObjects / orphan*) are
   *  UNRELIABLE for this run — treat the snapshot as UNHEALTHY, never as
   *  "verified zero orphans" (the 2.58.10 code swallowed these errors and
   *  a broken store reported perfectly healthy). A genuinely ABSENT
   *  storage dir stays a legitimate, error-free zero. */
  errors: string[];
}

/** v2.58.4 (external audit F12) — ONE read-only health view shared by the
 *  CLI and anything else; no mutation, no fabricated content.
 *  v2.58.10 (final-review P2): every counter is EXACT at any row count —
 *  stale pending is a COUNT query, missing content paginates to
 *  exhaustion, and orphan judging uses the exact ownership set of the
 *  ACTUAL disk entries (never a capped row page). */
export async function filesHealthSnapshot(now = Date.now()): Promise<FilesHealthSnapshot> {
  const cutoff = new Date(now - PENDING_LEASE_MS);
  const errors: string[] = [];
  const [totalRows, committedRows, pendingRows, deletingRows, stalePendingRows] = await Promise.all([
    db.file.count(),
    db.file.count({ where: { status: FILE_STATUS_COMMITTED } }),
    db.file.count({ where: { status: FILE_STATUS_PENDING } }),
    db.file.count({ where: { status: FILE_STATUS_DELETING } }),
    db.file.count({ where: { status: FILE_STATUS_PENDING, createdAt: { lt: cutoff } } }),
  ]);

  // missing content: cursor-paginated to EXHAUSTION (the old take:5_000
  // silently stopped reporting after 5,000 committed rows)
  const missingContentRows: FilesHealthSnapshot['missingContentRows'] = [];
  let cursorId: string | undefined;
  for (;;) {
    const page = await db.file.findMany({
      where: { status: FILE_STATUS_COMMITTED },
      select: { id: true, storedName: true, originalName: true, size: true, centerId: true, createdAt: true },
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });
    if (page.length === 0) break;
    for (const row of page) {
      const p = resolveStoredPath(row.storedName);
      if (!p || !fs.existsSync(p)) missingContentRows.push(row);
    }
    if (page.length < 500) break;
    cursorId = page[page.length - 1].id;
  }

  const storageDir = getStorageDir();
  let diskObjects = 0;
  let orphanFinalFiles = 0;
  let orphanPartFiles = 0;
  // v2.58.11 (P1-3b): the physical block is HONEST — only a genuinely
  // absent storage dir (ENOENT — a fresh install) keeps a legitimate
  // zero; every other failure (unreadable dir, ownership query failure)
  // lands in errors and marks the physical counters unreliable.
  let entries: string[];
  try {
    entries = fs.readdirSync(storageDir);
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code !== 'ENOENT') {
      errors.push(`storage dir unreadable — physical counters UNRELIABLE this run: ${code || ''} ${e instanceof Error ? e.message : String(e)}`);
      logApiError('file-lifecycle', 'health snapshot: storage dir unreadable:', storageDir, e instanceof Error ? e.message : String(e));
    }
    entries = [];
  }
  if (entries.length > 0) {
    // exact ownership of the ACTUAL disk names (chunked IN, no cap)
    const partBases = entries.filter((n) => n.endsWith('.part')).map((n) => n.slice(0, -'.part'.length));
    const finals = entries.filter((n) => !n.endsWith('.part'));
    try {
      const [ownedParts, ownedFinals] = await Promise.all([
        owningNamesFor(partBases),
        owningNamesFor(finals),
      ]);
      for (const name of entries) {
        diskObjects += 1;
        if (name.endsWith('.part')) {
          if (!ownedParts.has(name.slice(0, -'.part'.length))) orphanPartFiles += 1;
        } else if (!ownedFinals.has(name)) {
          orphanFinalFiles += 1;
        }
      }
    } catch (e: unknown) {
      // fail-closed: without proven ownership, orphan counters are
      // UNVERIFIED — report the failure, keep the counters at zero, and
      // never present the run as a clean bill of health
      errors.push(`ownership query failed — orphan counters UNRELIABLE this run: ${e instanceof Error ? e.message : String(e)}`);
      logApiError('file-lifecycle', 'health snapshot: ownership query failed:', e instanceof Error ? e.message : String(e));
      diskObjects = 0;
      orphanFinalFiles = 0;
      orphanPartFiles = 0;
    }
  }

  return {
    totalRows, committedRows, pendingRows, deletingRows, stalePendingRows,
    missingContentRows, orphanFinalFiles, orphanPartFiles, diskObjects, storageDir, errors,
  };
}

// ── orphan FINAL files: safe deletion (v2.58.7 — stage 7) ──

export interface OrphanPruneReport {
  /** Physical objects removed (no DB row, past the grace window). */
  removedFiles: number;
  /** Orphans younger than the grace window — left alone, retried next run. */
  skippedYoungFiles: number;
  /** Objects whose name fails the strict stored-name shape — reported only. */
  skippedInvalidNames: string[];
  /** Everything that went wrong, honestly reported. */
  errors: string[];
}

/**
 * Safely delete physical FINAL files that no DB row owns (v2.58.7, the
 * user's stage-7 requirement: «File بدون DB Record حذف امن شود»).
 *
 * SAFETY CONTRACT:
 *   • only objects PAST the grace window (default 1 h — an in-flight
 *     upload is a .part + pending row; a fresh final without a row can
 *     only be a pre-fix crash leftover, but we still give it an hour);
 *   • only objects passing the STRICT stored-name shape check (a weird
 *     name is reported, never touched);
 *   • .part temp files belong to sweepStalePendingFiles, not here;
 *   • DB rows are NEVER touched — this only reclaims orphaned BYTES.
 */
export async function sweepOrphanFinalFiles(
  graceMs = 60 * 60 * 1000,
  now = Date.now(),
): Promise<OrphanPruneReport> {
  const report: OrphanPruneReport = {
    removedFiles: 0,
    skippedYoungFiles: 0,
    skippedInvalidNames: [],
    errors: [],
  };
  const storageDir = getStorageDir();
  let dirEntries: string[];
  try {
    dirEntries = await fsp.readdir(storageDir);
  } catch {
    return report; // no storage dir → nothing to prune
  }
  // v2.58.10 (final-review P2 — ownership completeness): the same capped
  // first-50k set used to judge FINAL files here — an owned file whose
  // row sat beyond the page was DELETED (data loss). Candidates come
  // from the directory; ownership is answered EXACTLY for those names
  // and re-checked immediately before every removal; a DB failure in
  // the ownership path fails CLOSED (zero removals, honest errors).
  const finalCandidates: string[] = dirEntries.filter((n) => !n.endsWith('.part'));
  if (finalCandidates.length > 0) {
    let owned: Set<string>;
    try {
      owned = await owningNamesFor(finalCandidates);
    } catch (e: unknown) {
      report.errors.push(`ownership query failed — ZERO final-file removals this run (fail-closed): ${e instanceof Error ? e.message : String(e)}`);
      return report;
    }
    for (const name of finalCandidates) {
      if (owned.has(name)) continue; // a live row owns it
      // strict shape gate — same rule as every download/delete path
      const storedPath = resolveStoredPath(name);
      if (!storedPath) {
        report.skippedInvalidNames.push(name);
        continue;
      }
      try {
        const st = await fsp.stat(storedPath);
        if (now - st.mtimeMs < graceMs) {
          report.skippedYoungFiles += 1;
          continue;
        }
        // re-check ownership IMMEDIATELY before the removal (a concurrent
        // registration may have landed between the batch query and the rm)
        const stillOwned = await db.file.findFirst({ where: { storedName: name }, select: { id: true } });
        if (stillOwned) continue;
        await fsp.rm(storedPath, { force: true });
        report.removedFiles += 1;
      } catch (e: unknown) {
        report.errors.push(`orphan final removal failed for ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return report;
}

// ── download discipline (async checksum + streaming) ────────

/**
 * ASYNC, chunked SHA-256 verification with bounded memory (64 KiB
 * chunks through a stream — no readFileSync loop, no whole file in
 * RAM). Throws ApiError(500) on mismatch, ApiError(410) if the file
 * vanished mid-check; both close the stream first.
 */
export async function verifyStoredFileChecksum(
  storedName: string,
  expected: string | null | undefined,
): Promise<void> {
  const storedPath = resolveStoredPath(storedName);
  if (!storedPath || !fs.existsSync(storedPath)) {
    throw new ApiError(410, 'محتوای فایل روی سرور یافت نشد. با پشتیبانی تماس بگیرید.');
  }
  if (!expected) return; // legacy rows without a checksum still stream

  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(storedPath, { highWaterMark: VERIFY_CHUNK_BYTES });
  try {
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
  } catch (e: unknown) {
    stream.destroy();
    logApiError('file-lifecycle', 'checksum read failed:', storedName, e instanceof Error ? e.message : String(e));
    throw new ApiError(500, 'خواندن فایل برای اعتبارسنجی یکپارچگی با خطا مواجه شد.');
  }
  const actual = hash.digest('hex');
  if (actual !== expected) {
    // stream already ended, but destroy defensively (the contract: the
    // stream is CLOSED on error or checksum mismatch)
    stream.destroy();
    logApiError('file-lifecycle', 'CHECKSUM MISMATCH — possible tampering:', storedName);
    throw new ApiError(500, 'یکپارچگی فایل نقض شده است. دانلود متوقف شد.');
  }
}

/**
 * Stream the stored file as a Web ReadableStream (zero full-file
 * buffering). The caller wraps it in the response; disposal is handled
 * by the stream itself (auto-close on end/error).
 */
export function streamStoredFile(storedName: string): ReadableStream<Uint8Array> {
  const storedPath = resolveStoredPath(storedName);
  if (!storedPath || !fs.existsSync(storedPath)) {
    throw new ApiError(410, 'محتوای فایل روی سرور یافت نشد. با پشتیبانی تماس بگیرید.');
  }
  const node = fs.createReadStream(storedPath, { highWaterMark: 256 * 1024 });
  return Readable.toWeb(node) as ReadableStream<Uint8Array>;
}

/** Byte length of a stored file (for Content-Length) without buffering it. */
export function storedFileSize(storedName: string): number {
  const storedPath = resolveStoredPath(storedName);
  if (!storedPath) return 0;
  try {
    return fs.statSync(storedPath).size;
  } catch {
    return 0;
  }
}

/** Guard used by every download path: pending files are NOT downloadable. */
export function assertDownloadable(status: string): void {
  if (status !== FILE_STATUS_COMMITTED) {
    // pending/stale — reads as absent; no state leak
    throw new ApiError(410, 'محتوای فایل روی سرور یافت نشد. با پشتیبانی تماس بگیرید.');
  }
}
