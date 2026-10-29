// Round 66 — unit tests for src/lib/print-zoom.ts (full-screen print viewer).
import { describe, it, expect } from 'vitest';
import {
  ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, ZOOM_FIT,
  clampZoom, computeFitScale, stepZoom, zoomAtEdge,
} from '../src/lib/print-zoom';

describe('print-zoom — clampZoom', () => {
  it('clamps to [ZOOM_MIN, ZOOM_MAX]', () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    expect(clampZoom(0.87)).toBe(0.87);
    expect(clampZoom(1)).toBe(1);
  });
  it('never returns NaN/Infinity (guards the style attr)', () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(ZOOM_MAX);
    expect(clampZoom(-Infinity)).toBe(ZOOM_MIN);
  });
});

describe('print-zoom — computeFitScale', () => {
  it('fits the whole page = the SMALLER of the two ratios (A4 portrait in a wide dialog binds on height)', () => {
    const sheet = { w: 794, h: 1123 };                       // A4 @96dpi
    const wideDialog = { w: 1800, h: 900 };                  // full-screen viewer
    expect(computeFitScale(wideDialog, sheet)).toBeCloseTo(900 / 1123, 5);
    const narrowWindow = { w: 400, h: 900 };                 // phone-ish width binds
    expect(computeFitScale(narrowWindow, sheet)).toBeCloseTo(400 / 794, 5);
  });
  it('degenerate inputs fall back to ZOOM_MIN instead of NaN/0 division', () => {
    expect(computeFitScale({ w: 0, h: 0 }, { w: 794, h: 1123 })).toBe(ZOOM_MIN);
    expect(computeFitScale({ w: 800, h: 600 }, { w: 0, h: 0 })).toBe(ZOOM_MIN);
    expect(computeFitScale({ w: -5, h: 10 }, { w: 10, h: 10 })).toBe(ZOOM_MIN);
  });
  it('fit is clamped for tiny/huge viewports (never sub-ZOOM_MIN, never beyond ZOOM_MAX)', () => {
    // 10000px viewport would give ratio 12.6 → clamped to 2
    expect(computeFitScale({ w: 10000, h: 10000 }, { w: 794, h: 1123 })).toBe(ZOOM_MAX);
    // 100px viewport → ratio ~0.126 → clamped to ZOOM_MIN
    expect(computeFitScale({ w: 100, h: 100 }, { w: 794, h: 1123 })).toBe(ZOOM_MIN);
  });
});

describe('print-zoom — stepZoom', () => {
  it('steps by ZOOM_STEP and clamps at the edges', () => {
    expect(stepZoom(1, 1)).toBeCloseTo(1 + ZOOM_STEP, 5);
    expect(stepZoom(1, -1)).toBeCloseTo(1 - ZOOM_STEP, 5);
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });
  it('rounds away float drift (0.1 is not binary-exact)', () => {
    let z = 0.5;
    for (let i = 0; i < 10; i++) z = stepZoom(z, 1);
    expect(z).toBe(1.5); // exact — no 1.5000000000000002
  });
  it('steps from the CURRENT fit scale when the user zooms while fitted', () => {
    const fit = 0.87;
    expect(stepZoom(fit, 1)).toBeCloseTo(0.97, 5);
    expect(stepZoom(fit, -1)).toBeCloseTo(0.77, 5);
  });
});

describe('print-zoom — zoomAtEdge (button disabled states)', () => {
  it('flags both ends of the clamp range', () => {
    expect(zoomAtEdge(ZOOM_MIN)).toEqual({ min: true, max: false });
    expect(zoomAtEdge(ZOOM_MAX)).toEqual({ min: false, max: true });
    expect(zoomAtEdge(1)).toEqual({ min: false, max: false });
  });
  it('treats epsilon-out-of-range values as AT the edge (post-rounding safety)', () => {
    expect(zoomAtEdge(ZOOM_MIN - 1e-6).min).toBe(true);
    expect(zoomAtEdge(ZOOM_MAX + 1e-6).max).toBe(true);
  });
});

describe('print-zoom — constants', () => {
  it('ZOOM_FIT is the literal sentinel (serializable, comparable)', () => {
    expect(ZOOM_FIT).toBe('fit');
  });
});
