-- AlterTable
ALTER TABLE "Company" ADD COLUMN "printTemplate" TEXT;

-- Backfill (idempotent): the بازرگانی company starts on its dedicated
-- Lian template (sea-green + dark-purple, round-77 reference); every
-- other company stays null → 'bgl' default (zero visual regression).
UPDATE "Company" SET "printTemplate" = 'lian' WHERE "slug" = 'bazargani' AND "printTemplate" IS NULL;
