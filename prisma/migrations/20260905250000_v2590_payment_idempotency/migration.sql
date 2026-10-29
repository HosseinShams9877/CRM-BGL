-- v2.58.1 (round 86, audit F2) — payment idempotency keys.
-- The UNIQUE(userId, idemKey) constraint is the race-safe guarantee for
-- duplicate/concurrent payment submissions (see schema.prisma comment).
-- Empty on creation; append-only from invoice-payments.ts.

-- CreateTable
CREATE TABLE "IssuedInvoicePaymentIdempotency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "idemKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "IssuedInvoicePaymentIdempotency_userId_idemKey_key" ON "IssuedInvoicePaymentIdempotency"("userId", "idemKey");
-- CreateIndex
CREATE UNIQUE INDEX "IssuedInvoicePaymentIdempotency_paymentId_key" ON "IssuedInvoicePaymentIdempotency"("paymentId");
-- CreateIndex
CREATE INDEX "IssuedInvoicePaymentIdempotency_invoiceId_idx" ON "IssuedInvoicePaymentIdempotency"("invoiceId");
