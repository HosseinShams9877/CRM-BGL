// ════════════════════════════════════════════════════════════════
// keyboard-layout.ts — v2.35.1 (round 61) Latin→Persian keyboard
// layout auto-detection for search.
//
// THE USER'S REPORT: searching «بیمارستان ساسان» while the OS
// keyboard is (by mistake) on the ENGLISH layout produces a query
// like «shk» / «shshk» — س lives on the S key, ا on H, ن on K — and
// the search silently returns nothing. Persian users hit this
// constantly (typing before checking the layout indicator).
//
// FIX STRATEGY (OR-union, never replace): every search surface that
// already builds an OR-filter ALSO matches the query's Persian-
// layout twin(s) when the query is Latin-script only. The original
// Latin query keeps matching too (product codes, document numbers,
// English brand names), so legitimate Latin searches are unchanged.
//
// MAPPING — standard Persian layout (ISIRI 9147), base letters:
//   q ض · w ص · e ث · r ق · t ف · y غ · u ع · i ه · o خ · p ح
//   a ش · s س · d ی · f ب · g ل · h ا · j ت · k ن · l م
//   z ظ · x ط · c ز · v ر · b ذ · n د · m پ · , و · ; ک · ' گ
//   [ ج · ] چ
//
// SHIFT-AWARE TWIN: «آ» is Shift+H and opens a large share of real
// Persian names (آقای، آزاد، آزمایشگاه، آذرشهر…). An UPPERCASE H in
// the query is therefore ALSO converted with آ, as a second twin
// alongside the case-insensitive base twin. Wrong guesses are
// harmless by construction — the OR-union can only ADD rows, never
// remove them. (Other shifted keys are diacritics/brackets and are
// deliberately not mapped.)
// ════════════════════════════════════════════════════════════════

/** English (QWERTY) key → Persian (ISIRI 9147) letter, base row. */
const LATIN_TO_PERSIAN: Record<string, string> = {
  q: 'ض', w: 'ص', e: 'ث', r: 'ق', t: 'ف', y: 'غ', u: 'ع', i: 'ه', o: 'خ', p: 'ح',
  a: 'ش', s: 'س', d: 'ی', f: 'ب', g: 'ل', h: 'ا', j: 'ت', k: 'ن', l: 'م',
  z: 'ظ', x: 'ط', c: 'ز', v: 'ر', b: 'ذ', n: 'د', m: 'پ',
  '[': 'ج', ']': 'چ', ';': 'ک', "'": 'گ', ',': 'و',
};

/** Shifted Persian letters worth matching (everything else is noise). */
const LATIN_TO_PERSIAN_SHIFTED: Record<string, string> = {
  h: 'آ',
};

/** Arabic/Persian script blocks (letters, presentation forms). */
const PERSIAN_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** True when the text already contains Persian/Arabic-script letters. */
export function hasPersianScript(text: string): boolean {
  return PERSIAN_SCRIPT_RE.test(text);
}

/** Char-by-char Latin→Persian conversion; unmapped chars pass through. */
export function latinToPersianLayout(text: string): string {
  let out = '';
  for (const ch of text) out += LATIN_TO_PERSIAN[ch.toLowerCase()] ?? ch;
  return out;
}

/**
 * Shift-aware conversion: an UPPERCASE key with a meaningful shifted
 * Persian letter (H → آ) maps to the shifted letter; everything else
 * falls back to the base map. «Hrhd» → «آقای» while «hrhd» → «اقای».
 */
export function latinToPersianLayoutShiftAware(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += (ch !== lower && LATIN_TO_PERSIAN_SHIFTED[lower])
      ? LATIN_TO_PERSIAN_SHIFTED[lower]
      : LATIN_TO_PERSIAN[lower] ?? ch;
  }
  return out;
}

/**
 * Search variants of a query: the raw text plus (when the query is
 * Latin-script only) its Persian-layout twins — the case-insensitive
 * base twin and, when it differs, the shift-aware twin (آ from H).
 * Duplicates collapse; order = [raw, baseTwin?, shiftTwin?].
 */
export function searchVariants(query: string): string[] {
  const raw = query.trim();
  if (!raw || hasPersianScript(raw)) return [raw];
  const base = latinToPersianLayout(raw);
  const shifted = latinToPersianLayoutShiftAware(raw);
  const variants = [raw];
  if (base !== raw) variants.push(base);
  if (shifted !== raw && shifted !== base) variants.push(shifted);
  return variants;
}

/**
 * The single best Persian twin for DISPLAY (hint chips): the
 * shift-aware twin when the query mixes cases («Hrhd» → «آقای»),
 * otherwise the base twin («shk» → «سان», «SHK» → «سان» — a
 * uniform-CAPS query reads as caps-lock, not as shifted letters).
 * Null when the query already contains Persian script or has no
 * mappable Latin letters (digits, symbols, empty text).
 */
export function detectLayoutFix(query: string): string | null {
  const raw = query.trim();
  if (!raw || hasPersianScript(raw)) return null;
  const base = latinToPersianLayout(raw);
  if (base === raw) return null;
  const mixedCase = raw !== raw.toUpperCase() && raw !== raw.toLowerCase();
  return mixedCase ? latinToPersianLayoutShiftAware(raw) : base;
}
