-- v2.57.0 (round 83) — full read/sync Hesabfa cache per upload/حسابفا.txt
-- New caches: item catalog, contacts (with balance), invoices (read-only).
-- InventorySerial: Hesabfa provenance + reservation bookkeeping.

-- CreateTable: HesabfaItem
CREATE TABLE "HesabfaItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "hesabfaId" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL DEFAULT '',
    "barCode" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL DEFAULT '',
    "buyPrice" REAL NOT NULL DEFAULT 0,
    "sellPrice" REAL NOT NULL DEFAULT 0,
    "categoryPath" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "HesabfaItem_companyId_itemCode_key" ON "HesabfaItem"("companyId", "itemCode");
CREATE INDEX "HesabfaItem_companyId_active_idx" ON "HesabfaItem"("companyId", "active");

-- CreateTable: HesabfaContact
CREATE TABLE "HesabfaContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "hesabfaId" INTEGER NOT NULL,
    "code" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "contactType" INTEGER NOT NULL DEFAULT 0,
    "phone" TEXT NOT NULL DEFAULT '',
    "mobile" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "province" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "nationalCode" TEXT NOT NULL DEFAULT '',
    "balance" REAL NOT NULL DEFAULT 0,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "HesabfaContact_companyId_hesabfaId_key" ON "HesabfaContact"("companyId", "hesabfaId");
CREATE INDEX "HesabfaContact_companyId_code_idx" ON "HesabfaContact"("companyId", "code");

-- CreateTable: HesabfaInvoice
CREATE TABLE "HesabfaInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "hesabfaId" INTEGER NOT NULL,
    "number" TEXT NOT NULL DEFAULT '',
    "invoiceType" INTEGER NOT NULL DEFAULT 0,
    "date" TEXT NOT NULL DEFAULT '',
    "contactHesabfaId" INTEGER NOT NULL DEFAULT 0,
    "contactCode" TEXT NOT NULL DEFAULT '',
    "contactName" TEXT NOT NULL DEFAULT '',
    "totalAmount" REAL NOT NULL DEFAULT 0,
    "paidAmount" REAL NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "itemsJson" TEXT NOT NULL DEFAULT '[]',
    "serialsJson" TEXT NOT NULL DEFAULT '[]',
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "HesabfaInvoice_companyId_hesabfaId_key" ON "HesabfaInvoice"("companyId", "hesabfaId");
CREATE INDEX "HesabfaInvoice_companyId_invoiceType_date_idx" ON "HesabfaInvoice"("companyId", "invoiceType", "date");
CREATE INDEX "HesabfaInvoice_companyId_contactHesabfaId_idx" ON "HesabfaInvoice"("companyId", "contactHesabfaId");

-- AlterTable: InventorySerial — Hesabfa provenance + reservations
ALTER TABLE "InventorySerial" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE "InventorySerial" ADD COLUMN "hesabfaItemCode" TEXT NOT NULL DEFAULT '';
ALTER TABLE "InventorySerial" ADD COLUMN "hesabfaInvoiceNumber" TEXT NOT NULL DEFAULT '';
ALTER TABLE "InventorySerial" ADD COLUMN "hesabfaInvoiceId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InventorySerial" ADD COLUMN "hesabfaContactCode" TEXT NOT NULL DEFAULT '';
ALTER TABLE "InventorySerial" ADD COLUMN "reservedById" TEXT;
ALTER TABLE "InventorySerial" ADD COLUMN "reservedAt" DATETIME;
ALTER TABLE "InventorySerial" ADD COLUMN "reservationExpiresAt" DATETIME;
CREATE INDEX "InventorySerial_source_hesabfaInvoiceNumber_idx" ON "InventorySerial"("source", "hesabfaInvoiceNumber");
