-- v2.55.0 — round 80: the یاس طب دارک company (شرکت مستقل، تولید
-- ست‌های ونتیلاتور) gets its own OCEAN-BLUE print template + the
-- sender profile printed on its proformas (pixel-extracted from the
-- user's «یاس طب» reference proforma upload). Data-only and
-- idempotent: no schema change (the printTemplate/website columns
-- already exist since v2.52.0/v2.54.0).

-- 1) یاس طب دارک: the round-80 reference is a distinct ocean-blue
--    design family (mirrored navy→white gradient banner, cyan wave
--    streak, AliceBlue zebra rows, amber footer ribbon) — bind the
--    company to the new 'yasteb' template. Guard keeps it idempotent
--    (fresh installs re-run the same values from seed.ts; existing
--    installs only touch a company that never chose a template).
UPDATE "Company"
SET "printTemplate" = 'yasteb'
WHERE "slug" = 'yasteb' AND "printTemplate" IS NULL;

-- 2) یاس طب دارک brand assets + sender profile from the reference:
--    the extracted English lockup (/logo-yasteb.png — the colorful
--    yas-teb mark that sits on the banner's white sweep), the group
--    phone 0912 515 4753 (the reference footer contact), the
--    registered address «تهران، خیابان نباب، خیابان آذربایجان» (the
--    reference footer's «Tehran, Navab St., Azarbaijan St.») and the
--    site www.yastebderak.ir printed under the globe icon. The
--    tagline drops the parenthetical «(شرکت مستقل)» — isolation is a
--    system property, not a printed matter (matches the reference's
--    clean letterhead subtitle).
UPDATE "Company"
SET "logo" = '/logo-yasteb.png',
    "phone" = '09125154753',
    "headOfficeAddress" = 'تهران، خیابان نباب، خیابان آذربایجان',
    "website" = 'www.yastebderak.ir',
    "tagline" = 'تولیدکنندهٔ ست‌های ونتیلاتور'
WHERE "slug" = 'yasteb'
  AND "logo" IS NULL
  AND "phone" IS NULL
  AND "headOfficeAddress" IS NULL
  AND "website" IS NULL;
