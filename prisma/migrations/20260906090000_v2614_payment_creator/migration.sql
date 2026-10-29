-- v2.58.4 (user issue 1 — payment ownership) — record WHO registered
-- each payment. The ownership matrix of the accounting cartable needs
-- the payment CREATOR: a finance_write-only user (every standard
-- salesperson carries finance_write) may edit/delete only the payment
-- rows THEY created, and only on their OWN documents.
--
-- Contract (additive, reversible, zero data movement):
--   • nullable column — legacy rows keep NULL (creator unknown);
--     NULL is FAIL-CLOSED for finance_write-only users (only full
--     cartable holders — admin/finance — may touch them);
--   • no FK constraint (mirrors SalesDocumentLog.userId, the audit
--     convention for user references that must survive user
--     re-creation cycles);
--   • index for the ownership lookups.
ALTER TABLE "SalesDocumentFinance" ADD COLUMN "createdById" TEXT;
CREATE INDEX "SalesDocumentFinance_createdById_idx" ON "SalesDocumentFinance"("createdById");
