// ════════════════════════════════════════════════════════════
// nav-url.ts — v2.34.0 real-URL contract for the SPA dashboard
// URL shape: ?company=<slug>&module=<key>&focus=<type>:<id>[:<label>]
// Everything the app renders must be addressable: Refresh, Back,
// Forward and open-in-new-tab all restore the exact view.
// Pure module — no React, no window access at import time.
// ════════════════════════════════════════════════════════════

export interface NavFocus {
  type: 'person' | 'center' | 'document';
  id: string;
  label?: string;
}

export interface NavState {
  company: string | null;   // null → holding (default, omitted from URL)
  module: string | null;    // null → company default module
  focus: NavFocus | null;
}

export function encodeFocus(f: NavFocus): string {
  const parts = [f.type, f.id];
  if (f.label) parts.push(f.label);
  return parts.map(encodeURIComponent).join(':');
}

export function decodeFocus(raw: string): NavFocus | null {
  if (!raw) return null;
  const parts = raw.split(':').map(decodeURIComponent);
  const [type, id, label] = parts;
  if (!type || !id) return null;
  if (type !== 'person' && type !== 'center' && type !== 'document') return null;
  return { type, id, label: label || undefined };
}

/** Serialize the full nav state to a query string (no leading '?'). */
export function buildNavQuery(state: NavState): string {
  const params = new URLSearchParams();
  if (state.company && state.company !== 'holding') params.set('company', state.company);
  if (state.module) params.set('module', state.module);
  if (state.focus) params.set('focus', encodeFocus(state.focus));
  const q = params.toString();
  return q ? `?${q}` : '';
}

/** Full href for direct linking / new-tab opens. */
export function buildNavHref(state: NavState, origin?: string): string {
  const q = buildNavQuery(state);
  return origin ? `${origin}/${q}` : `/${q}`;
}

/** Parse a location (search string) into nav state. */
export function parseNavSearch(search: string): NavState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const company = params.get('company') || null;
  const moduleRaw = params.get('module') || null;
  const focus = decodeFocus(params.get('focus') || '');
  return {
    company: company || null,
    module: moduleRaw || null,
    focus,
  };
}

/** pushState a nav change without adding redundant history entries. */
export function pushNavState(state: NavState): void {
  if (typeof window === 'undefined') return;
  const q = buildNavQuery(state);
  window.history.pushState({ company: state.company, module: state.module, focus: state.focus }, '', q || '/');
}

/** replaceState (in-place update — no new history entry). */
export function replaceNavState(state: NavState): void {
  if (typeof window === 'undefined') return;
  const q = buildNavQuery(state);
  window.history.replaceState({ company: state.company, module: state.module, focus: state.focus }, '', q || '/');
}
