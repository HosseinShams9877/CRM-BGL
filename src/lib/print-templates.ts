// ══════════════════════════════════════════════════════════════
// v2.52.0 — Per-company print template registry (تفکیک قالب چاپ).
//
// Every company registers its sender identity ONCE in settings
// (name, logo, tagline, addresses, bank…) — that part has been
// per-company since v2.35.0/v2.48.0. What stayed GLOBAL until now
// was the visual GRAPHIC LANGUAGE of the A4 proforma/invoice sheet
// (banner/wave/table colors). This module is the single source of
// truth for that visual layer, keyed per company:
//
//   Company.printTemplate (DB, nullable)  →  'bgl' (default) | 'lian' | …
//
//   • 'bgl'  — the v2.49.0 reference design (Emerald/Teal #00897B
//     banner, #00796B ink, Deep-Navy #1A2340 waves). Default for
//     every company without an explicit choice — byte-identical to
//     the pre-v2.52.0 constants, so existing prints NEVER change.
//   • 'lian' — the بهبود گستر لیان ایرانیان (واحد بازرگانی)
//     reference proforma (user round 77, upload «پیش فاکتور بقیه‌الله
//     بدون مالیات»): sea-green #2B826F banner, #006C66 ink,
//     dark-purple-indigo #34284D waves and the signature
//     indigo→teal gradient divider above the footer band.
//   • 'aria' — the آریا مدیکال reference proforma (user round 79,
//     upload «آریامدیکال»): a MEDICAL-BLUE graphic language — the
//     banner sweep as a cyan→navy gradient (#1AAFDA → #014874,
//     bright at the logo side, dark under the brand slogan),
//     petrol-blue #016C95 ink, the light steel-blue #92B1CC wave
//     streak, the bright vertical-gradient footer band and the brand
//     slogan «تنفس بهتر، زندگی بهتر» printed on the banner's left side.
//     This is also the design family the sheet layout itself was
//     born from (v2.31.8 — «redesigned after the official آریا
//     مدیکال invoice format»), so the fit is native.
//   • 'yasteb' — the یاس طب دارک reference proforma (user round 80,
//     upload «یاس طب»): an OCEAN-BLUE graphic language mirrored from
//     the BGL composition — the banner sweep runs TALL at the LEFT
//     (deep navy #013C7E under the white brand slogan) and fades to
//     white at the logo side (the colorful English lockup sits on the
//     light zone, the Persian name prints in navy ink), the cyan
//     #01C5CE wave streak rides the tapering right edge, table rows
//     wear the AliceBlue zebra #E1EDF7, and the footer band crosses
//     the page in a horizontal navy→light sweep with the signature
//     amber ribbon (#FEB801) and the English tagline «Medical
//     Products · For A Healthier Life».
//   • 'holding' — the بهبود گستر (هلدینگ) company (user round 81,
//     upload «bgl_transparent.png» — the group's colorful BGL lockup,
//     transparent): a ROYAL-INDIGO graphic language built from the
//     lockup's own duotone (deep teal #006C6F + dark indigo #28235D,
//     pixel-extracted from the upload). The banner sweep runs WHITE at
//     the RIGHT (the colorful lockup sits on the light zone with its
//     white plate, brand colors fully visible) through a soft
//     periwinkle #8E8CC4 into the deep indigo #28235D at the LEFT (the
//     white brand slogan «هلدینگ مادر گروه بهبود گستر» + the lockup's
//     own English line «The Future is Now»), the teal #006C6F wave
//     streak rides thick under the logo, table rows wear a lavender
//     zebra #F0EFF7, and the footer band crosses the page in a
//     horizontal teal→indigo duotone with the signature gradient
//     divider (teal→indigo, the mirror of Lian's) above it.
//
// PURE by design — no React, no Node APIs — so both the client
// print sheet and the settings preview (and unit tests, see
// tests/print-templates.test.ts) share the exact same values.
// Colors for 'lian'/'aria' were extracted PIXEL-EXACT from the
// uploaded reference rasters, not eyeballed.
// ══════════════════════════════════════════════════════════════

export type PrintTemplateKey = 'bgl' | 'lian' | 'aria' | 'yasteb' | 'holding';

export interface PrintTemplatePalette {
  /** Banner + footer band background (large white text sits on it). */
  banner: string;
  /** Interactive ink: tabs, table header, final sum row, labels,
   *  box borders — everything the reader's eye is guided by. */
  ink: string;
  /** Header/footer decorative wave color (secondary brand tone). */
  wave: string;
  /** Light hairline borders inside boxes / table rows. */
  line: string;
  /** Very light fill (meta labels, words-strip background). */
  soft: string;
}

/** A linear gradient (v2.54.0 — the Arya medical sweep). */
export interface PrintTemplateGradient {
  /** First stop — sits at the RIGHT edge of the banner (the logo/name
   *  side) / the TOP edge of the footer band. */
  from: string;
  /** v2.55.0 — optional MIDDLE stop at the 50% mark. The Yas-Tab ocean
   *  sweep needs three stops to stay vivid mid-banner (a plain
   *  white→navy blend turns gray-blue in the middle). null/undefined →
   *  the exact two-stop v2.54.0 rendering (byte-identical aria). */
  mid?: string | null;
  /** v2.55.0 — footer-band axis: true renders the gradient
   *  HORIZONTALLY (to left: 'from' at the right edge — the Yas-Tab
   *  navy-left/light-right band). false/undefined → the vertical
   *  180deg sweep (Arya, byte-identical). Ignored for banner
   *  gradients (always horizontal). */
  horizontal?: boolean;
  /** Second stop — the banner's LEFT edge / the footer band's bottom. */
  to: string;
}

/** Brand slogan printed on the banner's left side (Arya reference). */
export interface PrintTemplateSlogan {
  /** Main Persian line (white, bold). */
  fa: string;
  /** Small English line under it (white, lighter). */
  en: string;
}

export interface PrintTemplate {
  key: PrintTemplateKey;
  /** Persian display name (settings selector). */
  nameFa: string;
  /** One-line Persian description (settings selector). */
  descriptionFa: string;
  palette: PrintTemplatePalette;
  /**
   * Signature gradient divider printed between the signature boxes
   * and the footer band (the Lian reference's indigo→teal bar).
   * null → no divider (BGL default: none, exactly as v2.49.0).
   */
  divider: { from: string; to: string } | null;
  /**
   * v2.54.0 — optional BANNER gradient (the Arya medical sweep:
   * 'from' at the right/logo side → 'to' at the left). null → the
   * banner body fills with the solid palette.banner (bgl/lian —
   * byte-identical to their pre-v2.54.0 prints).
   */
  bannerGradient: PrintTemplateGradient | null;
  /**
   * v2.54.0 — optional FOOTER-BAND gradient, rendered VERTICALLY
   * (top→bottom, the Arya reference's medium→bright petrol sweep).
   * null → solid var(--banner) (unchanged for bgl/lian).
   */
  footerGradient: PrintTemplateGradient | null;
  /**
   * v2.54.0 — optional brand slogan printed at the banner's LEFT
   * side (the Arya reference composition: Persian slogan + English
   * tagline in white over the blue sweep). null → no slogan (the
   * banner stays exactly as bgl/lian render it).
   */
  bannerSlogan: PrintTemplateSlogan | null;
  /**
   * v2.54.0 — optional tint overrides for the two legacy hardcoded
   * brand-tinted spots (meta-box label fill / words-strip hairline).
   * null → the PRINT_CSS defaults (#eef6f4 / #d5e8e3) — byte-identical
   * bgl/lian prints; templates from another color family override both.
   */
  tints: { metaSoft: string; stripLine: string } | null;
  /**
   * v2.55.0 — MIRRORED banner wave geometry (the Yas-Tab composition):
   * the sweep runs TALL at the LEFT (the dark side) and tapers to
   * nothing at the right, and the wave streak rides thick at the
   * RIGHT edge (the cyan swoosh under the logo). false → the standard
   * v2.49.0 geometry (tall right / streak thick at left),
   * byte-identical for bgl/lian/aria.
   */
  mirrorWave: boolean;
  /**
   * v2.55.0 — zebra tint for the even table rows (the Yas-Tab
   * reference's AliceBlue #E1EDF7 rows). null → all-white rows
   * (the exact v2.49.0 table, unchanged for bgl/lian/aria).
   */
  zebra: string | null;
  /**
   * v2.55.0 — the amber signature ribbon sweeping across the footer
   * band (the Yas-Tab reference's gold diagonal, pixel-mapped
   * x≈47%→74%). null → no ribbon. A ribbon also raises the band's
   * min-height (the reference's taller footer proportion).
   */
  footerRibbon: { from: string; to: string } | null;
  /**
   * v2.55.0 — small brand tagline at the footer band's right end (the
   * Yas-Tab reference's «Medical Products · For A Healthier Life» in
   * navy ink over the light zone). null → none.
   */
  footerSlogan: { fa: string; en: string } | null;
  /**
   * v2.55.0 — footer wave color override (the Yas-Tab band keeps its
   * own deep-navy bottom edge). null → palette.wave (the shared
   * banner+footer wave color, unchanged for bgl/lian/aria).
   */
  footerWave: string | null;
  /**
   * v2.55.0 — org-name/tagline ink color for banners whose LOGO side
   * is light (the Yas-Tab white sweep: the Persian name prints in
   * deep navy instead of white). null → white text with the legacy
   * shadow, byte-identical for bgl/lian/aria.
   */
  bannerNameColor: string | null;
}

/** v2.49.0 BGL reference — EXACTLY the legacy constants (zero regression). */
export const PRINT_TEMPLATES: Record<PrintTemplateKey, PrintTemplate> = {
  bgl: {
    key: 'bgl',
    nameFa: 'پیش‌فرض BGL',
    descriptionFa: 'بنر سبز زمردی، موج سرمه‌ای تیره — زبان بصری استاندارد گروه',
    palette: {
      banner: '#00897B',
      ink: '#00796B',
      wave: '#1A2340',
      line: '#c9d6d4',
      soft: '#f2f7f6',
    },
    divider: null,
    bannerGradient: null,
    footerGradient: null,
    bannerSlogan: null,
    tints: null,
    mirrorWave: false,
    zebra: null,
    footerRibbon: null,
    footerSlogan: null,
    footerWave: null,
    bannerNameColor: null,
  },
  lian: {
    key: 'lian',
    // v2.53.0 — renamed from «لیان (بازرگانی)»: two companies now print
    // in this design (بازرگانی + تولید BGL — both round-77/78 references
    // are the same Lian-software family), so the name describes the
    // DESIGN, not a single company.
    nameFa: 'لیان — سبز دریایی',
    descriptionFa: 'بنر سبز دریایی، موج بنفش تیره و نوار گرادیانی امضا — طرح مرجع گروه (بازرگانی / تولید BGL)',
    // pixel-exact from the round-77 reference upload
    palette: {
      banner: '#2B826F',
      ink: '#006C66',
      wave: '#34284D',
      line: '#cdd9d4',
      soft: '#f2f6f4',
    },
    divider: { from: '#262361', to: '#02877B' },
    bannerGradient: null,
    footerGradient: null,
    bannerSlogan: null,
    tints: null,
    mirrorWave: false,
    zebra: null,
    footerRibbon: null,
    footerSlogan: null,
    footerWave: null,
    bannerNameColor: null,
  },
  aria: {
    key: 'aria',
    nameFa: 'آریا — آبی پزشکی',
    descriptionFa: 'بنر گرادیانی فیروزه‌ای تا سرمه‌ای، جوهر آبی پترول و شعار برند — طرح مرجع آریا مدیکال',
    // pixel-exact from the round-79 reference upload (آریامدیکال.png,
    // 1054×1492): banner sweep cyan #1AAFDA (right/logo side) → navy
    // #014874 (left/slogan side), table-header petrol #016C95 (center
    // of its gradient row), footer band vertical #1184C3→#2AA0D9,
    // wave = the light steel-blue streak #92B1CC riding the edge.
    palette: {
      // solid fallback: mid petrol-blue of the sweep (white text ≈ 4.6:1)
      banner: '#01689E',
      ink: '#016C95',
      // the reference's LIGHT steel-blue streak riding the wave edge
      // (#92B1CC in the uploaded raster) — reads over BOTH the navy
      // left (thick) and the cyan right (taper), unlike a dark wave
      // which would vanish against the navy side of the sweep.
      wave: '#92B1CC',
      line: '#c9d8e2',
      soft: '#eaf4fa',
    },
    divider: null,
    // the reference's cyan→navy sweep, mirrored EXACTLY as the reference
    // composes it: bright cyan at the right (logo side — the colorful
    // logo sits in a white plate over the light zone) and deep navy at
    // the LEFT (the white brand slogan prints over the dark zone)
    bannerGradient: { from: '#1AAFDA', to: '#014874' },
    // the reference footer's vertical medium→bright petrol sweep
    footerGradient: { from: '#1184C3', to: '#2AA0D9' },
    // the reference banner's left-side brand slogan (white script
    // «تنفس بهتر / زندگی بهتر» + English tagline)
    bannerSlogan: { fa: 'تنفس بهتر، زندگی بهتر', en: 'Better Breathing, A Healthier Life' },
    // light-blue family tints replacing the legacy teal-tinted spots
    tints: { metaSoft: '#E8F2FA', stripLine: '#C6DDEF' },
    mirrorWave: false,
    zebra: null,
    footerRibbon: null,
    footerSlogan: null,
    footerWave: null,
    bannerNameColor: null,
  },
  yasteb: {
    key: 'yasteb',
    nameFa: 'یاس طب دارک — آبی اقیانوسی',
    descriptionFa: 'بنر گرادیانی سرمه‌ای تا سفید با موج فیروزه‌ای، ردیف‌های زبرا و نوار طلایی فوتر — طرح مرجع یاس طب دارک',
    // pixel-exact from the round-80 reference upload (یاس طب.png,
    // 1054×1492): banner sweep white (right/logo side) → vivid blue
    // #1B86C9 → deep navy #013C7E (left/slogan side); table header
    // #115C9D; AliceBlue zebra #E1EDF7; the cyan #01C5CE streak riding
    // the tapering right edge; footer band horizontal light→navy with
    // the amber ribbon #FEB801→#FDD747 (reference gold band x 495..830)
    // and the deep-navy #002158 bottom edge.
    palette: {
      // solid fallback: the navy family center (white text ≈ 8:1)
      banner: '#014587',
      ink: '#115C9D',
      // the reference's cyan swoosh (#01C5CE sampled at x≈900, y≈50)
      wave: '#01C5CE',
      line: '#c7d9e8',
      soft: '#eff6fb',
    },
    divider: null,
    // the reference banner: dark navy holds the LEFT ~30%, sweeps
    // through vivid blue to WHITE at the right — the colorful English
    // lockup + the navy Persian name sit on the light zone (exactly
    // the reference composition). Three stops keep the middle vivid.
    bannerGradient: { from: '#FFFFFF', mid: '#1B86C9', to: '#013C7E' },
    // the reference footer's horizontal sweep: light blue right edge
    // (the English tagline zone) → mid blue → deep navy left
    footerGradient: { from: '#BEE0F8', mid: '#187FC8', to: '#013C7E', horizontal: true },
    // the reference banner's left-side brand slogan (white script over
    // the navy zone — «تنفس بهتر / زندگی بهتر» + the English tagline)
    bannerSlogan: { fa: 'تنفس بهتر، زندگی بهتر', en: 'Better Breathing · A Healthier Tomorrow' },
    // light-blue family tints replacing the legacy teal-tinted spots
    tints: { metaSoft: '#E6F1FA', stripLine: '#C3D9EA' },
    // the mirrored sweep: TALL at the left (dark), fading right; the
    // cyan streak rides thick at the RIGHT under the logo (reference)
    mirrorWave: true,
    // the reference table's AliceBlue zebra rows
    zebra: '#E1EDF7',
    // the reference footer's gold diagonal band (amber gradient)
    footerRibbon: { from: '#FDD747', to: '#FEB801' },
    // the reference footer's right-end English tagline (navy ink over
    // the light zone; fa stays empty — the reference prints English)
    footerSlogan: { fa: '', en: 'Medical Products · For A Healthier Life' },
    // the reference footer's deep-navy bottom edge (#002158 sampled)
    footerWave: '#002158',
    // the Persian org name/tagline print in deep navy on the white
    // sweep (white text would vanish over the light logo zone)
    bannerNameColor: '#013C7E',
  },
  holding: {
    key: 'holding',
    nameFa: 'هلدینگ — ایندیگوی سلطنتی',
    descriptionFa: 'بنر گرادیانی سفید تا ایندیگوی عمیق با رگهٔ فیروزه‌ای، زبرای بنفش‌روشن و فوتر دوتنهٔ ایندیگو — زبان بصری مادر گروه (رنگ‌ها از لوگوی BGL)',
    // pixel-exact from the round-81 logo upload (bgl_transparent.png,
    // 1265×718 transparent): the lockup's own duotone — deep teal
    // #006C6F (58% of the marks, the «GL»+«بهبود» glyphs) and dark
    // indigo #28235D (33%, the B symbol + «گستر» + tagline). The royal
    // ramp composes them: white (right/logo side) → periwinkle
    // #8E8CC4 → deep indigo (left/slogan side); the teal streak rides
    // thick at the RIGHT under the logo; the footer band sweeps the
    // same duotone horizontally (teal right → indigo left) with the
    // teal wave at its bottom edge.
    palette: {
      // solid fallback: the deep indigo of the ramp's dark end
      // (white text ≈ 13:1)
      banner: '#241F52',
      // the lockup's dark indigo — tabs, table header, final row,
      // labels (white text on it ≈ 12.6:1)
      ink: '#28235D',
      // the lockup's deep teal — the banner streak under the logo
      // and the footer band's bottom wave
      wave: '#006C6F',
      line: '#C9C7D9',
      soft: '#F4F3F9',
    },
    // the royal signature divider: teal→indigo (the MIRROR of Lian's
    // indigo→teal bar — same duotone, opposite direction)
    divider: { from: '#006C6F', to: '#28235D' },
    // the royal ramp: WHITE at the right (the colorful lockup on its
    // white plate reads at full brand color over the light zone) →
    // soft periwinkle → deep indigo at the LEFT (white slogan zone).
    // Three stops keep the middle a VIVID periwinkle (a plain
    // white→indigo blend turns gray-lavender mid-banner).
    bannerGradient: { from: '#FFFFFF', mid: '#8E8CC4', to: '#28235D' },
    // the footer's horizontal duotone: teal at the right edge (the
    // logo/streak side) sweeping to deep indigo at the left — mirrors
    // the banner's light-right/dark-left flow
    footerGradient: { from: '#006C6F', to: '#28235D', horizontal: true },
    // the holding identity on the banner's left (white over the deep
    // indigo zone) — the DB tagline + the lockup's own English line
    bannerSlogan: { fa: 'هلدینگ مادر گروه بهبود گستر', en: 'The Future is Now' },
    // lavender-family tints replacing the legacy teal-tinted spots
    tints: { metaSoft: '#EDECF5', stripLine: '#CFCADC' },
    // the mirrored sweep: TALL at the left (indigo), fading right;
    // the teal streak rides thick at the RIGHT under the logo
    mirrorWave: true,
    // lavender zebra rows (distinct from yasteb's AliceBlue blue)
    zebra: '#F0EFF7',
    footerRibbon: null,
    footerSlogan: null,
    // null → palette.wave (the deep teal bottom edge — reads over
    // BOTH the indigo left and the teal right of the duotone band)
    footerWave: null,
    // the Persian org name/tagline print in the lockup's dark indigo
    // on the white sweep (white text would vanish over the light zone)
    bannerNameColor: '#28235D',
  },
};

export const PRINT_TEMPLATE_KEYS = Object.keys(PRINT_TEMPLATES) as PrintTemplateKey[];

/** Type guard for untrusted input (API body, DB rows, legacy rows). */
export function isPrintTemplateKey(v: unknown): v is PrintTemplateKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PRINT_TEMPLATES, v);
}

/**
 * Resolve a stored Company.printTemplate to a live template object.
 * null/undefined/unknown values (incl. every legacy row and every
 * company without an explicit choice) resolve to 'bgl' — the exact
 * pre-v2.52.0 look. Never throws.
 */
export function resolvePrintTemplate(v: unknown): PrintTemplate {
  return isPrintTemplateKey(v) ? PRINT_TEMPLATES[v] : PRINT_TEMPLATES.bgl;
}
