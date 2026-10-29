// ═══════════════════════════════════════════════════════════
// v2.31.7 — letterheadIdentity: issuing-company branding for the
// A4 print template. Documents owned by a subsidiary (آریا مدیکال)
// must print with that company's name + logo; everything else falls
// back to the global settings identity + the holding logo.
// v2.31.8 — tagline: issuing-company subtitle printed under the
// org name on the redesigned invoice format (nullable → null).
// v2.31.11 — fixtures synced with the round-40 group briefing: آریا's
// domain tagline (فروش دستگاه‌های کمک تنفسی). v2.34.4 — manufacturer
// renamed to its legal بهبود گستر لیام ایرانیان (round 51).
// v2.31.12 — full-lockup flag: a "-full" logo asset (e.g.
// /logo-aria-full.png) is a complete official lockup containing wordmark +
// Persian name + tagline; the letterhead prints it as one brand block. آریا
// now ships the official full lockup + official tagline from the logo.
// ═══════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { letterheadIdentity } from '../src/components/sales-docs-shared';

const SETTINGS = { companyName: 'هلدینگ بهبود گستر' };

describe('letterheadIdentity — issuing company overrides', () => {
  it('aria document: official FULL lockup + official tagline (v2.31.12)', () => {
    const r = letterheadIdentity(
      { name: 'آریا مدیکال', logo: '/logo-aria-full.png', tagline: 'فروش تجهیزات و مصرفی‌های پزشکی و آزمایشگاه' },
      SETTINGS,
    );
    expect(r.orgName).toBe('آریا مدیکال');
    expect(r.logoSrc).toBe('/logo-aria-full.png');
    expect(r.tagline).toBe('فروش تجهیزات و مصرفی‌های پزشکی و آزمایشگاه');
    expect(r.fullLockup).toBe(true);
  });

  it('bazargani document: official identity (بهبود گستر لیان ایرانیان + logo)', () => {
    const r = letterheadIdentity(
      { name: 'بهبود گستر لیان ایرانیان', logo: '/logo-bazargani.png', tagline: null },
      SETTINGS,
    );
    expect(r.orgName).toBe('بهبود گستر لیان ایرانیان');
    expect(r.logoSrc).toBe('/logo-bazargani.png');
    expect(r.tagline).toBeNull();
    expect(r.fullLockup).toBe(false);
  });

  it('holding document: uses the holding logo explicitly stored on the row', () => {
    const r = letterheadIdentity(
      { name: 'بهبود گستر (هلدینگ)', logo: '/logo-bgl.png' },
      SETTINGS,
    );
    expect(r.orgName).toBe('بهبود گستر (هلدینگ)');
    expect(r.logoSrc).toBe('/logo-bgl.png');
    expect(r.fullLockup).toBe(false);
  });

  it('company WITHOUT a logo (legacy row): name overrides, logo falls back to holding', () => {
    const r = letterheadIdentity({ name: 'بهبود گستر لیام ایرانیان', logo: null }, SETTINGS);
    expect(r.orgName).toBe('بهبود گستر لیام ایرانیان');
    expect(r.logoSrc).toBe('/logo-bgl.png');
  });

  it('empty-string logo behaves like null (fallback)', () => {
    const r = letterheadIdentity({ name: 'بهبود گستر لیام ایرانیان', logo: '' }, SETTINGS);
    expect(r.logoSrc).toBe('/logo-bgl.png');
  });

  it('empty-string tagline behaves like null (no subtitle)', () => {
    const r = letterheadIdentity({ name: 'بهبود گستر لیام ایرانیان', logo: null, tagline: '' }, SETTINGS);
    expect(r.tagline).toBeNull();
  });
});

describe('letterheadIdentity — fallbacks', () => {
  it('legacy center-less document (company=null): full settings identity, no tagline', () => {
    const r = letterheadIdentity(null, SETTINGS);
    expect(r.orgName).toBe('هلدینگ بهبود گستر');
    expect(r.logoSrc).toBe('/logo-bgl.png');
    expect(r.tagline).toBeNull();
    expect(r.fullLockup).toBe(false);
  });

  it('undefined company (pre-v2.25 row / missing relation): settings identity', () => {
    const r = letterheadIdentity(undefined, SETTINGS);
    expect(r.orgName).toBe('هلدینگ بهبود گستر');
    expect(r.logoSrc).toBe('/logo-bgl.png');
  });
});

describe('letterheadIdentity — full-lockup flag (v2.31.12)', () => {
  it('compact mark is NOT a full lockup', () => {
    const r = letterheadIdentity({ name: 'آریا مدیکال', logo: '/logo-aria.png' }, SETTINGS);
    expect(r.fullLockup).toBe(false);
  });

  it('detects the convention across extensions/assets', () => {
    expect(letterheadIdentity({ name: 'X', logo: '/logo-x-full.png' }, SETTINGS).fullLockup).toBe(true);
    expect(letterheadIdentity({ name: 'X', logo: '/logo-x-full.webp' }, SETTINGS).fullLockup).toBe(true);
    expect(letterheadIdentity({ name: 'X', logo: '/logo-fullness.png' }, SETTINGS).fullLockup).toBe(false);
    expect(letterheadIdentity({ name: 'X', logo: '/logofull.png' }, SETTINGS).fullLockup).toBe(false);
  });

  it('fallback logo (null/legacy) is never a full lockup', () => {
    expect(letterheadIdentity({ name: 'X', logo: null }, SETTINGS).fullLockup).toBe(false);
    expect(letterheadIdentity(null, SETTINGS).fullLockup).toBe(false);
  });
});

describe('letterheadIdentity — uploaded data-URL logos (v2.48.0)', () => {
  // v2.48.0 — logos uploaded from company settings are stored as data-URLs
  // (Company.logo). They behave like any compact mark: printed next to the
  // company name/tagline, never detected as a "-full" official lockup.
  const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

  it('data-URL logo prints as the company logo (name + logo side by side)', () => {
    const r = letterheadIdentity({ name: 'شرکت نمونه', logo: DATA_URL, tagline: 'شعار نمونه' }, SETTINGS);
    expect(r.orgName).toBe('شرکت نمونه');
    expect(r.logoSrc).toBe(DATA_URL);
    expect(r.tagline).toBe('شعار نمونه');
    expect(r.fullLockup).toBe(false);
  });

  it('a base64 payload that merely contains "-full." is NOT a lockup', () => {
    // A data-URL never matches the path convention — the flag is
    // convention-based on asset PATHS, and uploads are not asset paths.
    const fake = 'data:image/png;base64,LWZ1bGxu';
    const r = letterheadIdentity({ name: 'X', logo: fake }, SETTINGS);
    expect(r.fullLockup).toBe(false);
  });

  it('cleared logo (null after v2.48 removal) still falls back to the holding mark', () => {
    const r = letterheadIdentity({ name: 'شرکت نمونه', logo: null }, SETTINGS);
    expect(r.logoSrc).toBe('/logo-bgl.png');
    expect(r.orgName).toBe('شرکت نمونه');
  });
});

describe('letterheadIdentity — white-lockup detection (v2.53.0)', () => {
  // v2.53.0 — a "-white" logo path (e.g. /logo-bgl-white-full.png, the
  // all-white BGL lockup) renders DIRECTLY on the print banner color with
  // no white plate (round-77/78 reference composition). The flag is a
  // PATH convention exactly like "-full." — data-URL uploads can never
  // match (base64 charset has no hyphens).
  it('the shipped white BGL lockup is BOTH white and a full lockup', () => {
    const r = letterheadIdentity({ name: 'بهبود گستر لیام ایرانیان', logo: '/logo-bgl-white-full.png' }, SETTINGS);
    expect(r.whiteLogo).toBe(true);
    expect(r.fullLockup).toBe(true);
  });

  it('the white flag matches any "-white" asset path, not just BGL', () => {
    expect(letterheadIdentity({ name: 'X', logo: '/logo-x-white.png' }, SETTINGS).whiteLogo).toBe(true);
  });

  it('dark logos and fallbacks are NOT white', () => {
    expect(letterheadIdentity({ name: 'X', logo: '/logo-bgl.png' }, SETTINGS).whiteLogo).toBe(false);
    expect(letterheadIdentity({ name: 'X', logo: '/logo-aria-full.png' }, SETTINGS).whiteLogo).toBe(false);
    expect(letterheadIdentity({ name: 'X', logo: null }, SETTINGS).whiteLogo).toBe(false);
  });

  it('data-URL uploads are never white (plate rendering stays the safe default)', () => {
    const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    expect(letterheadIdentity({ name: 'X', logo: DATA_URL }, SETTINGS).whiteLogo).toBe(false);
  });

  it('a path merely CONTAINING "white" without the hyphen does not match', () => {
    expect(letterheadIdentity({ name: 'X', logo: '/logo-whitening.png' }, SETTINGS).whiteLogo).toBe(false);
  });
});
