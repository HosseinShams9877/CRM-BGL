// v2.52.0 — unit tests for the per-company print template registry
// (src/lib/print-templates.ts). The registry is the single source of
// truth for the A4 sheet's graphic language, so the invariants here
// are exactly the product's separation promises:
//   1. 'bgl' keeps the EXACT v2.49.0 constants (zero regression for
//      every company without an explicit template — incl. all legacy
//      rows and all null/undefined/unknown DB values).
//   2. 'lian' matches the round-77 reference upload pixel-extraction
//      (sea-green banner, dark-purple wave, #006C66 ink, divider).
//   3. 'aria' (v2.54.0) matches the round-79 medical-blue reference
//      (navy→cyan banner gradient, petrol ink, footer gradient, slogan).
//   4. 'yasteb' (v2.55.0) matches the round-80 ocean-blue reference
//      (mirrored white→navy sweep, cyan streak, zebra, amber ribbon).
//   5. 'holding' (v2.56.0) matches the round-81 royal-indigo design
//      built from the uploaded BGL lockup's own duotone
//      (teal #006C6F + indigo #28235D).
//   6. resolvePrintTemplate NEVER throws on untrusted input.
import { describe, expect, it } from 'vitest';
import {
  PRINT_TEMPLATES,
  PRINT_TEMPLATE_KEYS,
  isPrintTemplateKey,
  resolvePrintTemplate,
} from '../src/lib/print-templates';

describe('print-templates registry', () => {
  it('registers exactly the five shipped templates', () => {
    expect(PRINT_TEMPLATE_KEYS).toEqual(['bgl', 'lian', 'aria', 'yasteb', 'holding']);
  });

  it('every template is fully populated (no missing palette slot)', () => {
    for (const key of PRINT_TEMPLATE_KEYS) {
      const t = PRINT_TEMPLATES[key];
      expect(t.key).toBe(key);
      expect(t.nameFa.length).toBeGreaterThan(0);
      expect(t.descriptionFa.length).toBeGreaterThan(0);
      expect(t.palette.banner).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(t.palette.ink).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(t.palette.wave).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(t.palette.line).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(t.palette.soft).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('bgl keeps the EXACT v2.49.0 constants (zero visual regression)', () => {
    // these literals are the pre-v2.52.0 document-print.tsx constants —
    // if this test fails, an existing company's print changed color.
    expect(PRINT_TEMPLATES.bgl.palette.banner).toBe('#00897B');
    expect(PRINT_TEMPLATES.bgl.palette.ink).toBe('#00796B');
    expect(PRINT_TEMPLATES.bgl.palette.wave).toBe('#1A2340');
    expect(PRINT_TEMPLATES.bgl.palette.line).toBe('#c9d6d4');
    expect(PRINT_TEMPLATES.bgl.palette.soft).toBe('#f2f7f6');
    // bgl renders NO gradient divider (exact v2.49.0 DOM)
    expect(PRINT_TEMPLATES.bgl.divider).toBeNull();
    // v2.54.0 — bgl keeps NO gradients, NO slogan, NO tint overrides
    // (byte-identical pre-v2.54.0 banner/footer DOM + CSS).
    expect(PRINT_TEMPLATES.bgl.bannerGradient).toBeNull();
    expect(PRINT_TEMPLATES.bgl.footerGradient).toBeNull();
    expect(PRINT_TEMPLATES.bgl.bannerSlogan).toBeNull();
    expect(PRINT_TEMPLATES.bgl.tints).toBeNull();
    // v2.55.0 — bgl keeps NO mirrored wave, NO zebra, NO ribbon/slogan/
    // footerWave override, NO dark name ink (byte-identical DOM attrs).
    expect(PRINT_TEMPLATES.bgl.mirrorWave).toBe(false);
    expect(PRINT_TEMPLATES.bgl.zebra).toBeNull();
    expect(PRINT_TEMPLATES.bgl.footerRibbon).toBeNull();
    expect(PRINT_TEMPLATES.bgl.footerSlogan).toBeNull();
    expect(PRINT_TEMPLATES.bgl.footerWave).toBeNull();
    expect(PRINT_TEMPLATES.bgl.bannerNameColor).toBeNull();
  });

  it('lian matches the round-77 reference pixel extraction', () => {
    // extracted from the uploaded reference raster (2479×3508 @300dpi)
    expect(PRINT_TEMPLATES.lian.palette.banner).toBe('#2B826F'); // banner sea-green
    expect(PRINT_TEMPLATES.lian.palette.ink).toBe('#006C66');    // tabs/table/borders
    expect(PRINT_TEMPLATES.lian.palette.wave).toBe('#34284D');   // dark purple-indigo wave
    expect(PRINT_TEMPLATES.lian.divider).toEqual({ from: '#262361', to: '#02877B' });
    // v2.54.0 — lian keeps NO banner/footer gradient, NO slogan, NO
    // tints (byte-identical pre-v2.54.0 prints).
    expect(PRINT_TEMPLATES.lian.bannerGradient).toBeNull();
    expect(PRINT_TEMPLATES.lian.footerGradient).toBeNull();
    expect(PRINT_TEMPLATES.lian.bannerSlogan).toBeNull();
    expect(PRINT_TEMPLATES.lian.tints).toBeNull();
    // v2.55.0 — lian keeps the standard wave geometry and none of the
    // yasteb capabilities (byte-identical prints).
    expect(PRINT_TEMPLATES.lian.mirrorWave).toBe(false);
    expect(PRINT_TEMPLATES.lian.zebra).toBeNull();
    expect(PRINT_TEMPLATES.lian.footerRibbon).toBeNull();
    expect(PRINT_TEMPLATES.lian.footerSlogan).toBeNull();
    expect(PRINT_TEMPLATES.lian.footerWave).toBeNull();
    expect(PRINT_TEMPLATES.lian.bannerNameColor).toBeNull();
  });

  it('aria matches the round-79 medical-blue reference pixel extraction', () => {
    // extracted from the uploaded reference raster (1054×1492 A4):
    // banner sweep #1AAFDA (right/logo side) → #014874 (left/slogan
    // side), petrol table-header ink #016C95, footer vertical
    // #1184C3→#2AA0D9, light steel-blue wave streak #92B1CC.
    expect(PRINT_TEMPLATES.aria.palette.ink).toBe('#016C95');
    expect(PRINT_TEMPLATES.aria.palette.wave).toBe('#92B1CC');
    expect(PRINT_TEMPLATES.aria.bannerGradient).toEqual({ from: '#1AAFDA', to: '#014874' });
    expect(PRINT_TEMPLATES.aria.footerGradient).toEqual({ from: '#1184C3', to: '#2AA0D9' });
    // gradient stop colors are hex literals (print-safe, no CSS var refs)
    const bg = PRINT_TEMPLATES.aria.bannerGradient!;
    const fg = PRINT_TEMPLATES.aria.footerGradient!;
    expect(bg.from).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(bg.to).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(fg.from).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(fg.to).toMatch(/^#[0-9A-Fa-f]{6}$/);
    // the reference brand slogan (Persian + English)
    expect(PRINT_TEMPLATES.aria.bannerSlogan).toEqual({
      fa: 'تنفس بهتر، زندگی بهتر',
      en: 'Better Breathing, A Healthier Life',
    });
    // blue-family tint overrides (meta label fill / words-strip border)
    expect(PRINT_TEMPLATES.aria.tints).toEqual({ metaSoft: '#E8F2FA', stripLine: '#C6DDEF' });
    // no divider in the Arya reference (the footer band handles the split)
    expect(PRINT_TEMPLATES.aria.divider).toBeNull();
    // v2.55.0 — aria keeps the standard wave geometry, all-white table
    // rows, NO ribbon/slogan/footerWave override and white org-name ink
    // (byte-identical pre-v2.55.0 prints: its gradient gains no mid stop
    // and stays vertical).
    expect(PRINT_TEMPLATES.aria.mirrorWave).toBe(false);
    expect(PRINT_TEMPLATES.aria.zebra).toBeNull();
    expect(PRINT_TEMPLATES.aria.footerRibbon).toBeNull();
    expect(PRINT_TEMPLATES.aria.footerSlogan).toBeNull();
    expect(PRINT_TEMPLATES.aria.footerWave).toBeNull();
    expect(PRINT_TEMPLATES.aria.bannerNameColor).toBeNull();
    expect(PRINT_TEMPLATES.aria.bannerGradient!.mid ?? null).toBeNull();
    expect(PRINT_TEMPLATES.aria.footerGradient!.horizontal ?? false).toBe(false);
  });

  it('yasteb matches the round-80 ocean-blue reference pixel extraction', () => {
    // extracted from the uploaded reference raster (یاس طب.png,
    // 1054×1492 A4): banner sweep WHITE (right/logo side) → vivid blue
    // → deep navy #013C7E (left/slogan side), table header #115C9D,
    // AliceBlue zebra #E1EDF7, cyan streak #01C5CE, footer horizontal
    // #BEE0F8→#187FC8→#013C7E, amber ribbon #FDD747→#FEB801 (the
    // reference gold band x 495..830) and deep-navy #002158 bottom.
    expect(PRINT_TEMPLATES.yasteb.palette.banner).toBe('#014587');
    expect(PRINT_TEMPLATES.yasteb.palette.ink).toBe('#115C9D');
    expect(PRINT_TEMPLATES.yasteb.palette.wave).toBe('#01C5CE');
    // the mirrored three-stop sweep (mid keeps the middle vivid)
    expect(PRINT_TEMPLATES.yasteb.bannerGradient).toEqual({
      from: '#FFFFFF', mid: '#1B86C9', to: '#013C7E',
    });
    // the horizontal footer band gradient
    expect(PRINT_TEMPLATES.yasteb.footerGradient).toEqual({
      from: '#BEE0F8', mid: '#187FC8', to: '#013C7E', horizontal: true,
    });
    // the reference brand slogans (banner left + footer right)
    expect(PRINT_TEMPLATES.yasteb.bannerSlogan).toEqual({
      fa: 'تنفس بهتر، زندگی بهتر',
      en: 'Better Breathing · A Healthier Tomorrow',
    });
    expect(PRINT_TEMPLATES.yasteb.footerSlogan).toEqual({
      fa: '',
      en: 'Medical Products · For A Healthier Life',
    });
    // the signature yasteb capabilities
    expect(PRINT_TEMPLATES.yasteb.mirrorWave).toBe(true);
    expect(PRINT_TEMPLATES.yasteb.zebra).toBe('#E1EDF7');
    expect(PRINT_TEMPLATES.yasteb.footerRibbon).toEqual({ from: '#FDD747', to: '#FEB801' });
    expect(PRINT_TEMPLATES.yasteb.footerWave).toBe('#002158');
    expect(PRINT_TEMPLATES.yasteb.bannerNameColor).toBe('#013C7E');
    // blue-family tints; no divider (the ribbon footer carries the split)
    expect(PRINT_TEMPLATES.yasteb.tints).toEqual({ metaSoft: '#E6F1FA', stripLine: '#C3D9EA' });
    expect(PRINT_TEMPLATES.yasteb.divider).toBeNull();
  });

  it('holding matches the round-81 BGL-lockup duotone pixel extraction', () => {
    // extracted from the uploaded lockup (bgl_transparent.png, 1265×718
    // transparent): deep teal #006C6F (58% of the marks) + dark indigo
    // #28235D (33%). The royal ramp composes them: white (right/logo
    // side) → periwinkle #8E8CC4 → deep indigo (left/slogan side).
    expect(PRINT_TEMPLATES.holding.palette.banner).toBe('#241F52');
    expect(PRINT_TEMPLATES.holding.palette.ink).toBe('#28235D');
    expect(PRINT_TEMPLATES.holding.palette.wave).toBe('#006C6F');
    // the royal three-stop sweep (mid keeps the middle a vivid periwinkle)
    expect(PRINT_TEMPLATES.holding.bannerGradient).toEqual({
      from: '#FFFFFF', mid: '#8E8CC4', to: '#28235D',
    });
    // the horizontal teal→indigo duotone footer
    expect(PRINT_TEMPLATES.holding.footerGradient).toEqual({
      from: '#006C6F', to: '#28235D', horizontal: true,
    });
    // the holding identity + the lockup's own English line
    expect(PRINT_TEMPLATES.holding.bannerSlogan).toEqual({
      fa: 'هلدینگ مادر گروه بهبود گستر',
      en: 'The Future is Now',
    });
    // the mirrored sweep + the lavender zebra
    expect(PRINT_TEMPLATES.holding.mirrorWave).toBe(true);
    expect(PRINT_TEMPLATES.holding.zebra).toBe('#F0EFF7');
    // the royal signature divider (teal→indigo — the mirror of Lian's)
    expect(PRINT_TEMPLATES.holding.divider).toEqual({ from: '#006C6F', to: '#28235D' });
    // lavender-family tints
    expect(PRINT_TEMPLATES.holding.tints).toEqual({ metaSoft: '#EDECF5', stripLine: '#CFCADC' });
    // the indigo org-name ink over the white logo zone
    expect(PRINT_TEMPLATES.holding.bannerNameColor).toBe('#28235D');
    // NO ribbon and NO footer slogan (a clean premium footer — the
    // duotone band + divider carry the split) and the footer wave
    // inherits the palette teal
    expect(PRINT_TEMPLATES.holding.footerRibbon).toBeNull();
    expect(PRINT_TEMPLATES.holding.footerSlogan).toBeNull();
    expect(PRINT_TEMPLATES.holding.footerWave).toBeNull();
  });

  it('the five templates are visually DISTINCT (real separation)', () => {
    const a = PRINT_TEMPLATES.bgl.palette;
    const b = PRINT_TEMPLATES.lian.palette;
    const c = PRINT_TEMPLATES.aria.palette;
    const d = PRINT_TEMPLATES.yasteb.palette;
    const e = PRINT_TEMPLATES.holding.palette;
    expect(a.banner).not.toBe(b.banner);
    expect(a.wave).not.toBe(b.wave);
    expect(a.ink).not.toBe(b.ink);
    // aria is a gradient/slogan template and a blue family; yasteb is a
    // DISTINCT blue family (mirrored sweep, zebra rows, amber ribbon)
    expect(c.ink).not.toBe(a.ink);
    expect(c.ink).not.toBe(b.ink);
    expect(c.wave).not.toBe(a.wave);
    expect(c.wave).not.toBe(b.wave);
    expect(PRINT_TEMPLATES.aria.bannerGradient).not.toBeNull();
    expect(PRINT_TEMPLATES.bgl.bannerGradient).toBeNull();
    expect(PRINT_TEMPLATES.lian.bannerGradient).toBeNull();
    // yasteb vs aria: different ink, different wave, mirrored geometry,
    // different gradient endpoints, and the ribbon/zebra capabilities
    expect(d.ink).not.toBe(c.ink);
    expect(d.wave).not.toBe(c.wave);
    expect(d.ink).not.toBe(a.ink);
    expect(d.wave).not.toBe(a.wave);
    expect(PRINT_TEMPLATES.yasteb.mirrorWave).not.toBe(PRINT_TEMPLATES.aria.mirrorWave);
    expect(PRINT_TEMPLATES.yasteb.zebra).not.toBeNull();
    expect(PRINT_TEMPLATES.aria.zebra).toBeNull();
    expect(PRINT_TEMPLATES.yasteb.footerRibbon).not.toBeNull();
    expect(PRINT_TEMPLATES.aria.footerRibbon).toBeNull();
    expect(PRINT_TEMPLATES.yasteb.bannerGradient!.to).not.toBe(PRINT_TEMPLATES.aria.bannerGradient!.to);
    // holding vs every other: a distinct INDIGO ink + teal wave (the
    // logo duotone), a different ramp (periwinkle mid vs yasteb's vivid
    // blue), the mirrored divider direction vs lian, and the teal right
    // end of the footer gradient (yasteb's is light blue)
    expect(e.ink).not.toBe(a.ink);
    expect(e.ink).not.toBe(b.ink);
    expect(e.ink).not.toBe(c.ink);
    expect(e.ink).not.toBe(d.ink);
    expect(e.wave).not.toBe(a.wave);
    expect(e.wave).not.toBe(b.wave);
    expect(e.wave).not.toBe(c.wave);
    expect(e.wave).not.toBe(d.wave);
    expect(PRINT_TEMPLATES.holding.bannerGradient!.mid).not.toBe(
      PRINT_TEMPLATES.yasteb.bannerGradient!.mid,
    );
    expect(PRINT_TEMPLATES.holding.bannerGradient!.to).not.toBe(
      PRINT_TEMPLATES.yasteb.bannerGradient!.to,
    );
    expect(PRINT_TEMPLATES.holding.divider!.from).not.toBe(PRINT_TEMPLATES.lian.divider!.from);
    expect(PRINT_TEMPLATES.holding.footerGradient!.from).not.toBe(
      PRINT_TEMPLATES.yasteb.footerGradient!.from,
    );
    expect(PRINT_TEMPLATES.holding.zebra).not.toBe(PRINT_TEMPLATES.yasteb.zebra);
    expect(PRINT_TEMPLATES.holding.footerRibbon).toBeNull();
    expect(PRINT_TEMPLATES.yasteb.footerRibbon).not.toBeNull();
  });
});

describe('isPrintTemplateKey', () => {
  it('accepts registered keys', () => {
    expect(isPrintTemplateKey('bgl')).toBe(true);
    expect(isPrintTemplateKey('lian')).toBe(true);
    expect(isPrintTemplateKey('aria')).toBe(true);
    expect(isPrintTemplateKey('yasteb')).toBe(true);
    expect(isPrintTemplateKey('holding')).toBe(true);
  });

  it('rejects untrusted values without throwing', () => {
    for (const v of [null, undefined, '', 'BGL', 'lian ', 0, true, {}, [], Symbol('x')]) {
      expect(isPrintTemplateKey(v)).toBe(false);
    }
  });
});

describe('resolvePrintTemplate', () => {
  it('resolves registered keys to their template', () => {
    expect(resolvePrintTemplate('lian').key).toBe('lian');
    expect(resolvePrintTemplate('bgl').key).toBe('bgl');
    expect(resolvePrintTemplate('aria').key).toBe('aria');
    expect(resolvePrintTemplate('yasteb').key).toBe('yasteb');
    expect(resolvePrintTemplate('holding').key).toBe('holding');
  });

  it('null / undefined / legacy / unknown values degrade to bgl (never throws)', () => {
    // null = every pre-v2.52.0 row and every company without a choice
    for (const v of [null, undefined, 'bgl', '', 'corporate', 'LIAN', 42, {}]) {
      expect(resolvePrintTemplate(v).key).toBe('bgl');
    }
  });
});
