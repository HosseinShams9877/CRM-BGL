-- v2.58.4 (external audit F04) — idempotency for sales-side payments.
-- Same contract as v2590 (IssuedInvoicePaymentIdempotency), for the
-- SalesDocumentFinance write paths: /api/sales-documents add-payment and
-- /api/accounting-cartable add-payment. A client retry with the same key
-- and payload replays the stored result (ONE receipt, ever); the same key
-- with a different payload is rejected with 409. Append-only request log
-- (no FK relations) — deliberate, mirroring v2590.
CREATE TABLE "SalesPaymentIdempotency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "idemKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "salesDocumentId" TEXT NOT NULL,
    "financeRecordId" TEXT,
    "resultJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesPaymentIdempotency_userId_idemKey_key" UNIQUE ("userId", "idemKey")
);
CREATE UNIQUE INDEX "SalesPaymentIdempotency_financeRecordId_key" ON "SalesPaymentIdempotency"("financeRecordId");
CREATE INDEX "SalesPaymentIdempotency_salesDocumentId_idx" ON "SalesPaymentIdempotency"("salesDocumentId");
