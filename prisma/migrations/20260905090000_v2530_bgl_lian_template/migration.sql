-- v2.53.0 — round 78: the BGL production company (بهبود گستر لیام
-- ایرانیان) joins the Lian reference design family, and the two
-- reference companies get the all-white BGL lockup on their banner.
-- Pure DATA backfill (idempotent WHERE guards) — no schema change.

-- 1) BGL company: the round-78 reference proforma («لیام») is the same
--    Lian-software design the بازرگانی company already prints in
--    (sea-green banner + dark-purple waves + gradient divider), with the
--    BGL identity. Phone: the group contact printed in both reference
--    footers (0912 515 4753).
UPDATE "Company"
SET "printTemplate" = 'lian',
    "logo" = '/logo-bgl-white-full.png',
    "phone" = '09125154753'
WHERE "slug" = 'bgl' AND "printTemplate" IS NULL;

-- 2) بازرگانی: the round-77 reference banner ALSO shows the all-white
--    BGL lockup sitting directly on the teal banner (no white plate) —
--    swap its white-background rectangle asset for the same white lockup.
UPDATE "Company"
SET "logo" = '/logo-bgl-white-full.png'
WHERE "slug" = 'bazargani' AND "logo" = '/logo-bazargani.png';

-- 3) Global footer website (both references print www.BGL.ir in the
--    contact band under the globe icon): upsert, preserving any value
--    the operator already registered in general settings.
INSERT INTO "Meta" ("key", "value", "updatedAt")
VALUES ('app.website', 'www.BGL.ir', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
