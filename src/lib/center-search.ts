// ════════════════════════════════════════════════════════════════
// center-search.ts — v2.34.11 shared Persian search normalization
// for Center rows (list filter, combobox, contacts search).
//
// ROUND-58 FIX. Two defects made center search miss real rows:
//   1. The API's local normalizePersian DELETED zero-width joiners
//      (ZWNJ \u200c), while the r55 backfill that wrote the stored
//      Center.searchKey values REPLACED them with a space — so
//      «مرکز ام‌البنین» produced the key «…ام البنین…» but a query
//      typed with a ZWNJ collapsed to «امالبنین» and never matched.
//      ZWNJ is a word SEPARATOR in Persian orthography (نیم‌فاصله),
//      so it now normalizes to a space on BOTH sides — queries typed
//      with a space, with a ZWNJ, or against stored ZWNJ names all
//      converge to the same form.
//   2. The quick-activity/quick-proforma combobox search
//      (action:'search') matched only name/city with a partial
//      character map (ي/ك) — it skipped searchKey, province,
//      phone and mobile entirely.
//
// Both surfaces now build their OR-filter from the same helpers, and
// buildSearchKey writes keys byte-identical to the stored backfill.
//
// ROUND-61 EXTENSION (v2.35.1): a Latin-script query typed while the
// OS keyboard was on the English layout («shk» for «سان») now also
// matches its Persian-layout twin on every text field — see
// lib/keyboard-layout.ts for the detector and the mapping.
// ════════════════════════════════════════════════════════════════

import { searchVariants } from '@/lib/keyboard-layout';

/** Persian/Arabic → canonical Persian + separator normalization. */
export function normalizePersian(text: string): string {
  return text
    .replace(/[یي]/g, 'ی')
    .replace(/[کك]/g, 'ک')
    .replace(/ة/g, 'ه')
    .replace(/[\u200c\u200d]/g, ' ') // ZWNJ/ZWJ are word separators, not deletions
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Text fields folded into Center.searchKey (order matters: name first). */
export interface SearchKeySource {
  name: string;
  province?: string | null;
  city?: string | null;
  phone?: string | null;
  mobile?: string | null;
  address?: string | null;
}

/**
 * Concatenate a center's searchable text into one normalized key.
 * Byte-identical to the r55 backfill (ZWNJ→space semantics included),
 * so API-written and backfilled keys stay interchangeable.
 */
export function buildSearchKey(center: SearchKeySource): string {
  const parts = [center.name, center.province, center.city, center.phone, center.mobile, center.address]
    .filter(Boolean)
    .join(' ');
  return normalizePersian(parts);
}

/**
 * Prisma OR-filter for tolerant center matching, shared by the list
 * handler and the combobox so the two surfaces can never drift again.
 * `searchKey` folds phone/mobile/address text into the match too, so a
 * raw-digit phone query hits through it without dedicated clauses.
 */
export function centerSearchOr(search: string): Record<string, unknown>[] {
  const norm = normalizePersian(search);
  const raw = search.trim();
  const clauses: Record<string, unknown>[] = [
    { searchKey: { contains: norm } },
    { name: { contains: norm } },
    { name: { contains: raw } },
    { city: { contains: norm } },
    { city: { contains: raw } },
    { province: { contains: norm } },
    { province: { contains: raw } },
  ];
  // v2.35.1 (round 61) — keyboard-layout auto-fix: a Latin-only query
  // typed while the OS layout was English («shk» for «سان», the exact
  // user report) also matches its Persian-layout twins on every text
  // field (base twin + shift-aware twin — «آ» from uppercase H). The
  // original Latin clauses stay, so Latin codes/names keep matching;
  // Persian queries take this branch never (shape unchanged — the
  // round-58 tests lock the 7-clause layout byte-for-byte).
  const twins = searchVariants(search).slice(1);
  for (const twin of twins) {
    const twinNorm = normalizePersian(twin);
    clauses.push(
      { searchKey: { contains: twinNorm } },
      { name: { contains: twinNorm } },
      { city: { contains: twinNorm } },
      { province: { contains: twinNorm } },
    );
  }
  return clauses;
}
