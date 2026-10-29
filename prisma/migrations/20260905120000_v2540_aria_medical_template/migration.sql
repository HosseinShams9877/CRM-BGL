-- v2.54.0 — round 79: the آریا مدیکال company (شرکت پزشکی) gets its
-- own medical-blue print template + the sender profile printed on its
-- proformas (pixel-extracted from the user's «آریامدیکال» reference
-- proforma upload). One additive schema change (Company.website) +
-- idempotent data backfill.

-- 1) Additive column: per-company website for the A4 footer contact
--    band (globe icon). NULL for every other company → the print
--    falls back to the global app.website (www.BGL.ir), exactly the
--    pre-v2.54.0 behavior.
ALTER TABLE "Company" ADD COLUMN "website" TEXT;

-- 2) آریا مدیکال: the round-79 reference is a distinct medical-BLUE
--    design family (navy→cyan gradient banner, petrol ink, bright
--    footer band) — bind the company to the new 'aria' template.
--    Guards keep the backfill idempotent (fresh installs re-run the
--    same file from seed.ts values; existing installs only touch a
--    company that never chose a template).
UPDATE "Company"
SET "printTemplate" = 'aria'
WHERE "slug" = 'aria' AND "printTemplate" IS NULL;

-- 3) آریا مدیکال sender profile from the reference: group phone
--    0912 515 4753 (the reference footer contact), the registered
--    address «تهران، خیابان نباب، خیابان آذربایجان» (the reference
--    footer's «Tehran, Navab St., Azarbaijan St.») and the site
--    www.ariamedical.ir printed under the globe icon.
UPDATE "Company"
SET "phone" = '09125154753',
    "headOfficeAddress" = 'تهران، خیابان نباب، خیابان آذربایجان',
    "website" = 'www.ariamedical.ir'
WHERE "slug" = 'aria'
  AND "phone" IS NULL
  AND "headOfficeAddress" IS NULL
  AND "website" IS NULL;
