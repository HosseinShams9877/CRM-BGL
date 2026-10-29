-- v2.58.0 (Round 85 audit 85-c) — hot-path indexes + business-key
-- uniqueness. All unique candidates verified duplicate-free on the live
-- database before this migration was written (0 duplicate documentNumber,
-- 0 duplicate invoiceNumber, 0 duplicate HesabfaContact(companyId, code)).

-- CreateIndex
CREATE INDEX `Activity_businessUnitId_isPhoneCall_activityDate_idx` ON `Activity`(`businessUnitId`, `isPhoneCall`, `activityDate`);
-- CreateIndex
CREATE INDEX `Activity_createdById_idx` ON `Activity`(`createdById`);
-- CreateIndex
CREATE INDEX `SalesDocument_documentType_status_idx` ON `SalesDocument`(`documentType`, `status`);
-- CreateIndex
CREATE INDEX `SalesDocument_issuedAt_idx` ON `SalesDocument`(`issuedAt`);
-- CreateIndex
CREATE INDEX `IssuedInvoice_status_dueDate_idx` ON `IssuedInvoice`(`status`, `dueDate`);
-- CreateIndex
CREATE INDEX `Center_updatedAt_idx` ON `Center`(`updatedAt`);
-- CreateIndex
CREATE INDEX `InventorySerial_updatedAt_idx` ON `InventorySerial`(`updatedAt`);

-- DropIndex (upgraded to unique below — a duplicated financial document
-- number must be structurally impossible, not just unlikely)
DROP INDEX `SalesDocument_documentNumber_idx`;
-- CreateIndex
CREATE UNIQUE INDEX `SalesDocument_documentNumber_key` ON `SalesDocument`(`documentNumber`);
-- CreateIndex
CREATE UNIQUE INDEX `IssuedInvoice_invoiceNumber_key` ON `IssuedInvoice`(`invoiceNumber`);

-- v2.58.1 (round 86, audit F5): the two HesabfaContact statements that used
-- to live here (DROP INDEX `HesabfaContact_companyId_code_idx` + CREATE
-- UNIQUE INDEX `HesabfaContact_companyId_code_key`) were moved to
-- 20260905240000_v2581_hesabfa_contact_unique: this folder's timestamp
-- (12:00) sorts BEFORE 20260905230000_v2570_hesabfa_full_sync (23:00) which
-- CREATEs the HesabfaContact table, so a fresh `migrate deploy` on an empty
-- database died here with "no such index: HesabfaContact_companyId_code_idx".
-- Removing them changes this file's checksum. Verified empirically on
-- Prisma 6.19/SQLite (round 86): `migrate deploy` and `migrate status` do
-- NOT re-verify checksums of already-applied migrations, so databases that
-- applied the original v2.58.0 file upgrade cleanly — v2581 re-runs the
-- same swap idempotently (IF EXISTS / IF NOT EXISTS). No manual step.

