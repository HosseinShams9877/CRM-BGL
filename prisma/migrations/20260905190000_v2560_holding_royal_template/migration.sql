-- v2.56.0 — round 81: the بهبود گستر (هلدینگ) company (هلدینگ مادر گروه)
-- gets its own ROYAL-INDIGO print template + the sender profile printed
-- on its proformas (duotone pixel-extracted from the user's
-- «bgl_transparent.png» logo upload). Data-only and idempotent: no
-- schema change (the printTemplate/website columns already exist since
-- v2.52.0/v2.54.0).

-- 1) holding: the round-81 design is a distinct royal-indigo family
--    (white→periwinkle→indigo gradient banner with the teal streak,
--    lavender zebra rows, teal→indigo duotone footer) — bind the
--    company to the new 'holding' template. Guard keeps it idempotent
--    (fresh installs re-run the same values from seed.ts; existing
--    installs only touch a company that never chose a template).
UPDATE "Company"
SET "printTemplate" = 'holding'
WHERE "slug" = 'holding' AND "printTemplate" IS NULL;

-- 2) holding brand assets + sender profile: the uploaded colorful BGL
--    lockup (/logo-holding.png — transparent, sits on the banner's
--    white zone at full brand color), the group phone 0912 515 4753
--    (the contact printed in every group reference footer), the group
--    headquarters «تهران، بزرگ‌راه تهران–قم، شهرک صنعتی شمس‌آباد، خیابان
--    پنجم شمالی (دفتر مرکزی)» (the دفتر مرکزی registered on the group
--    companies) and the group site www.BGL.ir printed under the globe
--    icon. Guards keep the swap idempotent: only a row still carrying
--    the legacy default logo AND no contact data of its own is touched.
UPDATE "Company"
SET "logo" = '/logo-holding.png',
    "phone" = '09125154753',
    "headOfficeAddress" = 'تهران، بزرگ‌راه تهران–قم، شهرک صنعتی شمس‌آباد، خیابان پنجم شمالی (دفتر مرکزی)',
    "website" = 'www.BGL.ir'
WHERE "slug" = 'holding'
  AND "logo" = '/logo-bgl.png'
  AND "phone" IS NULL
  AND "headOfficeAddress" IS NULL
  AND "website" IS NULL;
