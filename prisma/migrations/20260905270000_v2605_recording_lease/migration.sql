-- v2.58.3 (round 88, finding 10) — atomic processing claim + lease for
-- AiCallRecording. A worker claims a recording by flipping its status
-- (updateMany, conditional) and takes a leaseUntil; a crash mid-pipeline
-- leaves an EXPIRED lease that the next claim can recover. NULL lease =
-- not being processed.
ALTER TABLE "AiCallRecording" ADD COLUMN "leaseUntil" DATETIME;
