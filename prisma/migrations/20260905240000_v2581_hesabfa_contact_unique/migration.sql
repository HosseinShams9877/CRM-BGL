-- v2.58.1 (round 86, audit F5) — fresh-install ordering repair.
-- The HesabfaContact (companyId, code) unique upgrade originally lived in
-- 20260905120000_v2580_audit_indexes_uniques, whose timestamp sorts BEFORE
-- 20260905230000_v2570_hesabfa_full_sync — the migration that CREATEs the
-- HesabfaContact table. A fresh `migrate deploy` on an empty database
-- therefore failed with "no such index: HesabfaContact_companyId_code_idx".
-- The statements now run HERE, after v2570, in every install order.
--
-- Both statements are IDEMPOTENT by design so the same migration is safe on:
--   • fresh installs — v2570 just created the table + the plain index;
--   • upgraded v2.58.0 databases — v2580 (as originally applied) already
--     performed this swap; both statements become verified no-ops.
-- Duplicate data is impossible either way (v2580 verified 0 duplicates
-- against the live database before the unique key was ever created).

-- DropIndex (was plain `HesabfaContact_companyId_code_idx` from v2570)
DROP INDEX IF EXISTS `HesabfaContact_companyId_code_idx`;
-- CreateIndex (upgrade to unique — (companyId, code) is the manual
-- center-mapping key; duplicates would silently mis-route the mapping)
CREATE UNIQUE INDEX IF NOT EXISTS `HesabfaContact_companyId_code_key` ON `HesabfaContact`(`companyId`, `code`);
