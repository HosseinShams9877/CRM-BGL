-- v2.58.3 (round 88, finding 9) — File lifecycle states.
-- Every existing row is a completed, disk-backed record → 'committed'.
-- New uploads land as 'pending' between DB registration and the atomic
-- rename, and flip to 'committed' once the bytes are durable. Stale
-- pending rows (crash between the two writes) are identifiable and
-- recoverable by the sweeper; pending files are never downloadable.
ALTER TABLE "File" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'committed';
CREATE INDEX "File_status_idx" ON "File"("status");
