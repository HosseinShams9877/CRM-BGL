// ═══════════════════════════════════════════════════════════
// print-zoom.ts — v2.40.0
//
// Pure math for the full-screen document print viewer
// (DocumentPrintDialog). The A4 sheet keeps its natural print
// size (210mm) and the on-screen PREVIEW is scaled to fit the
// dialog («تمام صفحه») or to a manual zoom percentage — the
// print output itself is never affected (the body-level print
// master renders unscaled; @page size stays A4).
// ═══════════════════════════════════════════════════════════

export const ZOOM_MIN = 0.35;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

/** Sentinel for the auto-fit mode (show the whole page). */
export const ZOOM_FIT = 'fit' as const;

/** 'fit' = auto-fit the whole page into the viewport; a number = manual scale (1 = 100%). */
export type ZoomState = typeof ZOOM_FIT | number;

export function clampZoom(z: number): number {
  if (Number.isNaN(z)) return 1; // neutral fallback — never reaches the style attr
  if (z === Infinity) return ZOOM_MAX;
  if (z === -Infinity) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/**
 * Scale that shows the WHOLE sheet inside the viewport (the smaller of the
 * width/height ratios). Zero/negative inputs (first paint, hidden dialog)
 * fall back to ZOOM_MIN so the caller never divides by zero or renders NaN.
 */
export function computeFitScale(
  viewport: { w: number; h: number },
  sheet: { w: number; h: number },
): number {
  if (viewport.w <= 0 || viewport.h <= 0 || sheet.w <= 0 || sheet.h <= 0) return ZOOM_MIN;
  return clampZoom(Math.min(viewport.w / sheet.w, viewport.h / sheet.h));
}

/**
 * Manual zoom step. Rounded to 3 decimals so repeated +/- clicks never
 * drift (0.1 is not representable in binary floating point).
 */
export function stepZoom(current: number, dir: 1 | -1): number {
  return clampZoom(Math.round((current + dir * ZOOM_STEP) * 1000) / 1000);
}

/** Whether the manual +/- affordance should be disabled at the clamp edges. */
export function zoomAtEdge(z: number): { min: boolean; max: boolean } {
  const c = clampZoom(z);
  return { min: c <= ZOOM_MIN + 1e-9, max: c >= ZOOM_MAX - 1e-9 };
}
