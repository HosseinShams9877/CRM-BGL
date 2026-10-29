-- v2.58.4 (external audit F05) — derived-invoice commercial ownership backfill.
--
-- Since v2.13.0 the approve flow derived the invoice sales document with
-- createdById = the APPROVER (the technical actor). Under the ownership-
-- based visibility policy (createdById is the commercial owner for
-- standard roles) the seller lost access to the final invoice of their
-- own sale. The application code now inherits createdById from the SOURCE
-- document; this migration repairs existing derived rows.
--
-- Contract (additive, reversible, no guessing):
--   • ONLY chains with a valid, non-null sourceDocumentId creator are
--     repaired; dangling or creator-less chains stay untouched;
--   • pre-repair values are captured in _v2611_owner_backfill_backup
--     (INSERT OR IGNORE — re-running never overwrites the original
--     value) so the change can be rolled back exactly;
--   • idempotent: re-running the UPDATE converges to the same state.
CREATE TABLE IF NOT EXISTS "_v2611_owner_backfill_backup" (
    "invoiceId"      TEXT NOT NULL PRIMARY KEY,
    "oldCreatedById" TEXT
);
INSERT OR IGNORE INTO "_v2611_owner_backfill_backup" ("invoiceId", "oldCreatedById")
SELECT d."id", d."createdById"
FROM "SalesDocument" d
WHERE d."documentType" = 'invoice'
  AND d."sourceDocumentId" IS NOT NULL
  AND d."createdById" IS NOT NULL;
UPDATE "SalesDocument"
SET "createdById" = (
    SELECT s."createdById"
    FROM "SalesDocument" s
    WHERE s."id" = "SalesDocument"."sourceDocumentId"
)
WHERE "documentType" = 'invoice'
  AND "sourceDocumentId" IS NOT NULL
  AND "createdById" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "SalesDocument" s
    WHERE s."id" = "SalesDocument"."sourceDocumentId"
      AND s."createdById" IS NOT NULL
  );
