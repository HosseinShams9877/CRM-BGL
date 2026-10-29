import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { claimRecordingForProcessing, processRecording } from '@/lib/ai/engine/pipeline';
import { executeNextAction, approveNextAction, dismissNextAction } from '@/lib/ai/engine/nba';

// ═══════════════════════════════════════════════════════════════
// ai-concurrency.test.ts — v2.58.3 (round 88, finding 10)
//
// Part 2 — RECORDING CLAIM + LEASE:
//   • two concurrent claims → exactly ONE owner
//   • a completed recording is never re-claimable (restart/retry
//     cannot re-emit the completed output)
//   • a crashed worker (mid-pipeline status + EXPIRED lease) is
//     recoverable; a LIVE lease is not stealable
//
// Part 3 — NEXT-ACTION EXECUTION is atomic + idempotent:
//   • two concurrent executes on one action → exactly ONE Activity,
//     both callers get the SAME activity id
//   • approve/dismiss races resolve to exactly one flip
//   • a dismissed action cannot be executed
// Real Prisma + real SQLite (the worker's isolated DB), no mocks.
// ═══════════════════════════════════════════════════════════════

const db = new PrismaClient();
const TAG = `r88c-${Date.now()}`;

async function mkRecording(overrides: Record<string, unknown> = {}) {
  const company = await db.company.findFirst({ where: { slug: 'bazargani' } });
  return db.aiCallRecording.create({
    data: {
      companyId: company!.id,
      direction: 'outbound',
      source: 'manual-upload',
      status: 'uploaded',
      language: 'fa',
      title: `${TAG}`,
      ...overrides,
    },
  });
}

let actionSeq = 0;
async function mkAction(overrides: Record<string, unknown> = {}) {
  const company = await db.company.findFirst({ where: { slug: 'bazargani' } });
  actionSeq += 1;
  return db.aiNextAction.create({
    data: {
      companyId: company!.id,
      type: 'call',
      title: `${TAG} اقدام ${actionSeq}`,
      detail: '',
      priority: 'medium',
      reason: 'test',
      confidence: 0.9,
      status: 'suggested',
      ...overrides,
    },
  });
}

async function cleanup() {
  const recs = await db.aiCallRecording.findMany({ where: { title: TAG }, select: { id: true } });
  for (const r of recs) {
    await db.aiCallTranscript.deleteMany({ where: { recordingId: r.id } });
    await db.aiCallAnalysis.deleteMany({ where: { recordingId: r.id } });
    await db.aiNextAction.deleteMany({ where: { recordingId: r.id } });
    await db.aiCallRecording.delete({ where: { id: r.id } }).catch(() => undefined);
  }
  const actions = await db.aiNextAction.findMany({ where: { title: { startsWith: `${TAG} اقدام` } }, select: { id: true } });
  for (const a of actions) {
    const acts = await db.activity.findMany({ where: { title: { contains: '[اقدام AI]' } }, select: { id: true, centerId: true } });
    for (const act of acts) {
      await db.activity.delete({ where: { id: act.id } }).catch(() => undefined);
    }
    await db.auditEvent.deleteMany({ where: { subject: { startsWith: `${TAG} اقدام` } } });
    await db.aiNextAction.delete({ where: { id: a.id } }).catch(() => undefined);
  }
}

let ADMIN_ID = '';
beforeAll(async () => {
  const admin = await db.user.findFirst({ where: { role: 'admin' }, select: { id: true } });
  ADMIN_ID = admin!.id;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe('recording claim + lease (finding 10, part 2)', () => {
  it('two CONCURRENT claims → exactly one owner', async () => {
    const rec = await mkRecording();
    const results = await Promise.all([
      claimRecordingForProcessing(rec.id),
      claimRecordingForProcessing(rec.id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((x) => !x)).toHaveLength(1);
    await db.aiCallRecording.delete({ where: { id: rec.id } });
  });

  it('a completed recording is NOT re-claimable (no re-emitted output)', async () => {
    const rec = await mkRecording({ status: 'completed' });
    expect(await claimRecordingForProcessing(rec.id)).toBe(false);
    // processRecording on a completed row exits without touching it
    await processRecording(rec.id);
    const after = await db.aiCallRecording.findUnique({ where: { id: rec.id } });
    expect(after?.status).toBe('completed');
    await db.aiCallRecording.delete({ where: { id: rec.id } });
  });

  it('a crashed worker (expired lease, mid-pipeline status) is recoverable; a LIVE lease is not', async () => {
    // crashed 20 minutes ago: status 'transcribing', lease expired
    const crashed = await mkRecording({
      status: 'transcribing',
      leaseUntil: new Date(Date.now() - 20 * 60 * 1000),
    });
    expect(await claimRecordingForProcessing(crashed.id)).toBe(true); // recovered

    // live worker: lease in the future
    const live = await mkRecording({
      status: 'transcribing',
      leaseUntil: new Date(Date.now() + 10 * 60 * 1000),
    });
    expect(await claimRecordingForProcessing(live.id)).toBe(false); // not stealable

    await db.aiCallRecording.deleteMany({ where: { id: { in: [crashed.id, live.id] } } });
  });

  it('a failed recording stays terminal until an explicit retry re-queues it', async () => {
    const failed = await mkRecording({ status: 'failed', failReason: 'x' });
    expect(await claimRecordingForProcessing(failed.id)).toBe(false);
    // explicit re-queue (the retry action flips status back to queued)
    await db.aiCallRecording.update({ where: { id: failed.id }, data: { status: 'queued' } });
    expect(await claimRecordingForProcessing(failed.id)).toBe(true);
    await db.aiCallRecording.delete({ where: { id: failed.id } });
  });
});

describe('next-action execution — atomic + idempotent (finding 10, part 3)', () => {
  it('two CONCURRENT executes → exactly ONE Activity; both callers get the SAME id', async () => {
    const action = await mkAction();
    const [a, b] = await Promise.all([
      executeNextAction(action.id, ADMIN_ID, false),
      executeNextAction(action.id, ADMIN_ID, false),
    ]);
    // exactly one activity row exists for this action
    const row = await db.aiNextAction.findUnique({ where: { id: action.id } });
    expect(row?.status).toBe('executed');
    expect(row?.executedActivityId).toBeTruthy();
    const activityCount = await db.activity.count({ where: { id: row!.executedActivityId! } });
    expect(activityCount).toBe(1);
    // idempotent contract: both callers resolve to the SAME activity id
    // (the loser re-reads instead of duplicating)
    expect(a).toBe(row!.executedActivityId);
    expect(b).toBe(row!.executedActivityId);
    // total activities created = 1
    const all = await db.activity.findMany({ where: { title: { contains: action.title } } });
    expect(all).toHaveLength(1);
  });

  it('a REPEAT execute on an already-executed action returns the same id (no duplicate)', async () => {
    const action = await mkAction();
    const first = await executeNextAction(action.id, ADMIN_ID, false);
    expect(first).toBeTruthy();
    const second = await executeNextAction(action.id, ADMIN_ID, false);
    expect(second).toBe(first);
    const activities = await db.activity.findMany({ where: { title: { contains: action.title } } });
    expect(activities).toHaveLength(1);
  });

  it('approve race: a double-click resolves to exactly one flip', async () => {
    const action = await mkAction();
    const [r1, r2] = await Promise.all([
      approveNextAction(action.id, ADMIN_ID),
      approveNextAction(action.id, ADMIN_ID),
    ]);
    expect([r1, r2].filter(Boolean)).toHaveLength(1);
    const row = await db.aiNextAction.findUnique({ where: { id: action.id } });
    expect(row?.status).toBe('approved');
    expect(row?.approvedById).toBe(ADMIN_ID); // the winner (SQLite serializes)
  });

  it('a dismissed action cannot be executed', async () => {
    const action = await mkAction();
    expect(await dismissNextAction(action.id, ADMIN_ID, 'reason')).toBe(true);
    expect(await executeNextAction(action.id, ADMIN_ID, false)).toBeNull();
    const activities = await db.activity.findMany({ where: { title: { contains: action.title } } });
    expect(activities).toHaveLength(0);
  });
});
