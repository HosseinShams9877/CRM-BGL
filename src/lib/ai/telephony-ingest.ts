import { db } from '@/lib/db';
import { getAiSettings, isAiEnabledForCompany } from './settings';
import { parseExtMap, normalizePhone, type TelephonyEvent } from './providers/telephony';
import { aiAudit } from './api-helpers';
import { generateStoredName, sha256Hex, getStorageDir } from '@/lib/storage';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ════════════════════════════════════════════════════════════
// TELEPHONY INGESTION SERVICE (v2.28.0)
//
// DB-dependent half of the call-center webhook. Called only after
// parseTelephonyEvent() + verifyHmac() succeeded. Responsibilities:
//
//   1. idempotency    — (provider, externalId) dedup, indexed
//   2. company route  — payload slug → default company → agent user
//                       → unique global number match → unroutable
//   3. number match   — CenterContact.phone → Center.mobile →
//                       Center.phone (normalized compare in JS;
//                       endsWith(6) candidate narrowing in SQL)
//   4. agent match    — ext map (settings) → username → User
//   5. audio storage  — same disk+File pattern as manual upload
//   6. recording row  — source='telephony', queued for pipeline
//
// The pipeline itself is kicked by the route layer with `after()`
// so the webhook always returns fast (contract: 202 within ms).
// ════════════════════════════════════════════════════════════

export type TelephonyIngestResult =
  | {
      ok: true; duplicate: boolean; recordingId: string;
      companyId: string; centerId: string | null; contactId: string | null; userId: string | null;
    }
  | { ok: false; status: number; error: string };

/** Load the raw meta value without the 60s settings cache (webhook path — must be fresh enough for secret checks). */
async function readMetaValue(key: string): Promise<string | undefined> {
  const row = await db.meta.findUnique({ where: { key } });
  return row?.value;
}

// ── Company routing ─────────────────────────────────────────

interface ResolvedAgent {
  userId: string | null;
  companyId: string | null; // the agent user's own company, when set
}

/** ext map (settings) → username → User (id + company). */
async function resolveAgent(event: TelephonyEvent): Promise<ResolvedAgent> {
  if (!event.agentExt) return { userId: null, companyId: null };
  const extMap = parseExtMap(await readMetaValue('ai_sales.telephony_ext_map'));
  const username = extMap[event.agentExt];
  if (!username) return { userId: null, companyId: null };
  const u = await db.user.findUnique({ where: { username }, select: { id: true, companyId: true } });
  if (!u) return { userId: null, companyId: null };
  return { userId: u.id, companyId: u.companyId ?? null };
}

async function resolveCompanyId(event: TelephonyEvent, agentCompanyId: string | null): Promise<string | null> {
  // 1) explicit slug in the payload (PBX admin configured it)
  if (event.companySlug) {
    const c = await db.company.findUnique({ where: { slug: event.companySlug }, select: { id: true, isActive: true } });
    if (c && c.isActive) return c.id;
    return null; // explicit-but-unknown → unroutable (never silently fall back)
  }
  // 2) default company from settings
  const defaultSlug = (await readMetaValue('ai_sales.telephony_company')) || '';
  if (defaultSlug) {
    const c = await db.company.findUnique({ where: { slug: defaultSlug }, select: { id: true, isActive: true } });
    if (c && c.isActive) return c.id;
  }
  // 3) the matched agent's own company
  if (agentCompanyId) return agentCompanyId;
  return null;
}

// ── Number → Center/Contact matching ────────────────────────

interface NumberMatch {
  centerId: string;
  contactId: string | null;
  ambiguous: boolean;
}

function persianTail(normalized: string, n: number): string {
  // last-n digits rendered in Persian digits (DB may store fa digits)
  const map = '۰۱۲۳۴۵۶۷۸۹';
  return normalized.slice(-n).split('').map((d) => map[Number(d)]).join('');
}

/**
 * Match the caller number against the company's centers/contacts.
 * Two-pass SQL narrowing (latin + persian suffix) + exact normalized
 * compare in JS — DB values keep their original formatting, so an
 * exact SQL equality would miss every prefix/format variant.
 */
async function matchNumber(normalized: string, companyId: string): Promise<NumberMatch | null> {
  const tail = normalized.length >= 6 ? normalized.slice(-6) : normalized;
  const tails = [tail, persianTail(normalized, 6)];

  const contactCandidates = await db.centerContact.findMany({
    where: {
      center: { companyId },
      OR: tails.flatMap((t) => [{ phone: { endsWith: t } }]),
    },
    select: { id: true, centerId: true, phone: true },
    take: 50,
  });
  for (const c of contactCandidates) {
    if (normalizePhone(c.phone) === normalized) {
      return { centerId: c.centerId, contactId: c.id, ambiguous: false };
    }
  }

  const centerCandidates = await db.center.findMany({
    where: {
      companyId,
      isArchived: false,
      OR: tails.flatMap((t) => [
        { phone: { endsWith: t } },
        { mobile: { endsWith: t } },
      ]),
    },
    select: { id: true, phone: true, mobile: true },
    take: 50,
  });
  const centerHits = centerCandidates.filter(
    (c) => normalizePhone(c.phone || '') === normalized || normalizePhone(c.mobile || '') === normalized,
  );
  if (centerHits.length > 0) {
    // deterministic on ambiguity: earliest id (cuid ≈ creation order)
    centerHits.sort((a, b) => (a.id < b.id ? -1 : 1));
    return { centerId: centerHits[0].id, contactId: null, ambiguous: centerHits.length > 1 };
  }
  return null;
}

/** Global fallback when no company could be resolved — unique number wins. */
async function matchNumberGlobal(normalized: string): Promise<NumberMatch | null> {
  const tail = normalized.slice(-6);
  const tails = [tail, persianTail(normalized, 6)];

  const contacts = await db.centerContact.findMany({
    where: { OR: tails.flatMap((t) => [{ phone: { endsWith: t } }]) },
    select: { id: true, centerId: true, phone: true, center: { select: { companyId: true } } },
    take: 50,
  });
  const contactHit = contacts.find((c) => normalizePhone(c.phone) === normalized);
  if (contactHit) return { centerId: contactHit.centerId, contactId: contactHit.id, ambiguous: false };

  const centers = await db.center.findMany({
    where: { isArchived: false, OR: tails.flatMap((t) => [{ phone: { endsWith: t } }, { mobile: { endsWith: t } }]) },
    select: { id: true, phone: true, mobile: true, companyId: true },
    take: 50,
  });
  const centerHits = centers.filter(
    (c) => normalizePhone(c.phone || '') === normalized || normalizePhone(c.mobile || '') === normalized,
  );
  if (centerHits.length > 0) {
    centerHits.sort((a, b) => (a.id < b.id ? -1 : 1));
    return { centerId: centerHits[0].id, contactId: null, ambiguous: centerHits.length > 1 };
  }
  return null;
}

// ── Main entry ──────────────────────────────────────────────

/**
 * Ingest one verified telephony event. Idempotent on
 * (provider, externalId). Never throws — failures come back as
 * { ok:false, status, error } with a Persian, PBX-admin-readable
 * message. Caller decides the HTTP mapping.
 */
export async function ingestTelephonyCall(event: TelephonyEvent): Promise<TelephonyIngestResult> {
  // 1) idempotency
  const existing = await db.aiCallRecording.findFirst({
    where: { provider: event.provider, externalId: event.externalId },
    select: { id: true },
  });
  if (existing) {
    return { ok: true, duplicate: true, recordingId: existing.id, companyId: '', centerId: null, contactId: null, userId: null };
  }

  // 2) company routing + number/agent matching
  const agent = await resolveAgent(event);
  let companyId = await resolveCompanyId(event, agent.companyId);
  let match: NumberMatch | null;
  if (companyId) {
    match = await matchNumber(event.normalizedNumber, companyId);
  } else {
    // no configured route — a globally unique number match still makes the call routable
    match = await matchNumberGlobal(event.normalizedNumber);
    if (match) {
      const center = await db.center.findUnique({ where: { id: match.centerId }, select: { companyId: true } });
      companyId = center?.companyId ?? null;
    }
  }

  // AI module must be enabled for the target company
  if (!companyId) {
    return {
      ok: false, status: 422,
      error: 'شرکت مقصد قابل تعیین نیست — companySlug در رویداد، شرکت پیش‌فرض تلفنی یا تطبیق یکتای شماره لازم است.',
    };
  }
  if (!(await isAiEnabledForCompany(companyId))) {
    return { ok: false, status: 422, error: 'ماژول هوش مصنوعی برای شرکت مقصد فعال نیست.' };
  }

  const agentUserId = agent.userId;

  // 3) audio storage (identical to manual upload)
  const buffer = Buffer.from(event.audioBase64, 'base64');
  if (buffer.length < 512 || buffer.length > 60 * 1024 * 1024) {
    return { ok: false, status: 400, error: 'فایل صوتی پس از رمزگشایی معتبر نیست.' };
  }
  const storedName = generateStoredName(event.fileName);
  const dir = getStorageDir();
  fs.mkdirSync(dir, { recursive: true });
  const absPath = path.join(dir, storedName);
  fs.writeFileSync(absPath, buffer);
  const checksum = await sha256Hex(buffer);

  // v2.47.0 — the DB creates are wrapped so a failure (unique-race loss,
  // disk-full, schema drift…) never leaves an ORPHAN audio file behind:
  // the audit contract is «file on disk <=> row in DB».
  try {
    const stored = await db.file.create({
      data: {
        originalName: event.fileName.slice(0, 255),
        storedName,
        mimeType: event.mimeType || 'application/octet-stream',
        size: buffer.length,
        checksum,
        centerId: match?.centerId ?? null,
        category: 'ai-call-audio',
        createdById: agentUserId ?? null,
      },
    });

    // 4) recording row
    const settings = await getAiSettings();
    const retentionUntil = new Date(Date.now() + settings.retentionDays * 24 * 3600 * 1000);
    const autoTitle =
      event.title ||
      `تماس ${event.direction === 'inbound' ? 'ورودی از' : 'خروجی به'} ${event.callerNumber}` +
        (event.agentExt ? ` — داخلی ${event.agentExt}` : '');
    try {
      const recording = await db.aiCallRecording.create({
        data: {
          companyId,
          centerId: match?.centerId ?? null,
          contactId: match?.contactId ?? null,
          userId: agentUserId,
          direction: event.direction,
          source: 'telephony',
          provider: event.provider,
          externalId: event.externalId,
          status: 'queued',
          durationSec: event.durationSec,
          language: 'fa',
          consent: event.consent,
          retentionUntil,
          title: autoTitle.slice(0, 200),
          audioFileId: stored.id,
          createdById: agentUserId ?? null,
        },
      });

      await aiAudit(
        'AI_TELEPHONY_INGESTED',
        `recording=${recording.id}`,
        `provider=${event.provider}; externalId=${event.externalId}; number=${event.callerNumber}; ` +
          `center=${match?.centerId ?? 'unmatched'}; agent=${agentUserId ?? 'unmapped'}; bytes=${buffer.length}` +
          (match?.ambiguous ? '; AMBIGUOUS-MATCH' : ''),
        agentUserId ?? undefined,
      );

      // v2.47.0 — opportunistic retention sweep (≤ once/hour per process):
      // retentionUntil now actually MEANS something. Never blocks the
      // ingest response path on errors.
      try {
        const { retentionSweepDue, sweepExpiredAiRecordings } = await import('@/lib/ai/retention-sweep');
        if (retentionSweepDue()) await sweepExpiredAiRecordings();
      } catch { /* best-effort */ }

      return {
        ok: true, duplicate: false, recordingId: recording.id,
        companyId, centerId: match?.centerId ?? null, contactId: match?.contactId ?? null, userId: agentUserId,
      };
    } catch (recErr) {
      // v2.47.0 — race-safe idempotency: the schema now enforces
      // @@unique([provider, externalId]). Two concurrent webhooks with the
      // same externalId: exactly ONE recording/file is created; the loser
      // recognizes P2002 and reports the existing row as a duplicate
      // (the old findFirst->create pair silently created BOTH).
      if (isUniqueViolation(recErr)) {
        const winner = await db.aiCallRecording.findFirst({
          where: { provider: event.provider, externalId: event.externalId },
          select: { id: true },
        });
        if (winner) {
          // lose the race cleanly: drop OUR file row + bytes, keep the winner's
          await db.file.delete({ where: { id: stored.id } }).catch(() => undefined);
          safeUnlink(absPath);
          return { ok: true, duplicate: true, recordingId: winner.id, companyId: '', centerId: null, contactId: null, userId: null };
        }
      }
      throw recErr;
    }
  } catch (e) {
    // any other failure -> no orphan file, honest error surface
    safeUnlink(absPath);
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 500, error: `ثبت تماس تلفنی شکست خورد: ${msg.slice(0, 200)}` };
  }
}

// ── Secret helpers (settings API side) ──────────────────────

/** v2.47.0 — Prisma unique-constraint violation (P2002) detector. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/** v2.47.0 — unlink that never throws (a missing file is already clean). */
function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

/** Cryptographically strong webhook secret (48 hex chars). */
export function generateTelephonySecret(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** Mask for admin UI: first 6 + … + last 4. */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 12) return '•'.repeat(secret.length);
  return `${secret.slice(0, 6)}${'•'.repeat(18)}${secret.slice(-4)}`;
}
