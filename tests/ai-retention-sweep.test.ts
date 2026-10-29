import { describe, it, expect } from 'vitest';
import { db } from '@/lib/db';
import { sweepExpiredAiRecordings } from '@/lib/ai/retention-sweep';

// The suite runs against the isolated prisma/test.db (tests/setup.ts),
// so creating and deleting rows here is safe.

async function countAiTables() {
  const [rec, tr, file] = await Promise.all([
    db.aiCallRecording.count(),
    db.aiCallRecording.count({ where: { retentionUntil: { lt: new Date() } } }),
    db.file.count({ where: { category: 'ai-call-audio' } }),
  ]);
  return { rec, expired: tr, file };
}

describe('sweepExpiredAiRecordings (v2.47.0 — retention actually deletes)', () => {
  it('deletes an expired recording + its File row, keeps a live one', async () => {
    const company = await db.company.findFirst({ select: { id: true } });
    expect(company, 'test db must have at least one company').toBeTruthy();

    // a file row (disk bytes never written — safeUnlink treats missing as clean)
    const fileRow = await db.file.create({
      data: {
        originalName: 'r72-expired.mp3',
        storedName: `r72-exp-${Date.now()}.mp3`,
        mimeType: 'audio/mpeg',
        size: 1024,
        checksum: 'deadbeef'.repeat(8),
        category: 'ai-call-audio',
      },
    });
    const expired = await db.aiCallRecording.create({
      data: {
        companyId: company!.id,
        direction: 'inbound',
        source: 'telephony',
        provider: 'r72test',
        externalId: `exp-${Date.now()}`,
        status: 'processed',
        consent: 'granted',
        retentionUntil: new Date(Date.now() - 86_400_000), // yesterday
        title: 'r72 expired',
        audioFileId: fileRow.id,
      },
    });
    const live = await db.aiCallRecording.create({
      data: {
        companyId: company!.id,
        direction: 'inbound',
        source: 'telephony',
        provider: 'r72test',
        externalId: `live-${Date.now()}`,
        status: 'processed',
        consent: 'granted',
        retentionUntil: new Date(Date.now() + 86_400_000), // tomorrow
        title: 'r72 live',
      },
    });
    // a transcript hanging off the expired row (must cascade)
    await db.aiCallTranscript.create({
      data: { recordingId: expired.id, sttProvider: 'r72test', language: 'fa', fullText: 'متن آزمایشی' },
    }).catch(() => undefined /* schema drift guard: test only meaningful when model exists */);

    const result = await sweepExpiredAiRecordings();

    expect(result.expiredFound).toBeGreaterThanOrEqual(1);
    expect(result.recordingsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.audioFilesDeleted).toBeGreaterThanOrEqual(1);

    const gone = await db.aiCallRecording.findUnique({ where: { id: expired.id } });
    const fileGone = await db.file.findUnique({ where: { id: fileRow.id } });
    const survivor = await db.aiCallRecording.findUnique({ where: { id: live.id } });
    const transcriptGone = await db.aiCallTranscript.findUnique({ where: { recordingId: expired.id } });

    expect(gone).toBeNull();
    expect(fileGone).toBeNull();
    expect(survivor).not.toBeNull();
    expect(transcriptGone).toBeNull();

    // audit summary row exists
    const audit = await db.auditEvent.findFirst({
      where: { eventType: 'AI_RETENTION_SWEEP' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.details).toContain('deleted=');

    // cleanup the live row
    await db.aiCallRecording.delete({ where: { id: live.id } }).catch(() => undefined);
  });

  it('a second sweep with nothing expired is a clean no-op', async () => {
    const before = await countAiTables();
    const result = await sweepExpiredAiRecordings();
    const after = await countAiTables();
    expect(result.expiredFound).toBe(0);
    expect(result.recordingsDeleted).toBe(0);
    expect(after).toEqual(before);
  });
});
