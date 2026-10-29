-- v2.58.4 (external audit F07) — exact-resume AI pipeline.
--
-- (a) Per-stage COMPLETION MARKERS on AiCallRecording: a crash after
--     stage N re-runs only stage N+1 — "one next-action exists" is no
--     longer mistaken for "all actions were created" (the audit's
--     incomplete-actions repro), and zero-action results are
--     distinguishable from "stage never ran".
-- (b) leaseToken: fencing for the processing lease — a stale worker
--     whose lease expired and was re-granted cannot write results
--     (its fenced updates match zero rows).
-- (c) AiNextAction.dedupeKey (UNIQUE): a stable per-recording action
--     identity — action creation resumes EXACTLY the missing rows
--     instead of skipping the whole stage or duplicating it.
ALTER TABLE "AiCallRecording" ADD COLUMN "actionsDone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiCallRecording" ADD COLUMN "memoryDone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiCallRecording" ADD COLUMN "coachingDone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiCallRecording" ADD COLUMN "leaseToken" TEXT;
ALTER TABLE "AiNextAction" ADD COLUMN "dedupeKey" TEXT;
CREATE UNIQUE INDEX "AiNextAction_dedupeKey_key" ON "AiNextAction"("dedupeKey");
