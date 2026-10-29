import { describe, it, expect } from 'vitest';
import {
  IRAN_PROVINCES,
  parseTerritoryArray,
  resolveTerritoryFromRow,
  territoryConfigProblem,
  centerTerritoryWhere,
  centerRelTerritoryWhere,
  docOwnershipTerritoryWhere,
  activityTerritoryWhere,
  invoiceTerritoryWhere,
  centerInTerritory,
  territorySummary,
} from '../src/lib/territory-scope';

// ════════════════════════════════════════════════════════════
// v2.36.0 — Sales Territory & Data Permission Management
// Pure where-fragment builders — no DB, mirrors the isolation tests.
// ════════════════════════════════════════════════════════════

const PROV = { mode: 'provinces', provinces: ['تهران', 'البرز'], centerIds: [] } as const;
const CENTERS = { mode: 'centers', provinces: [], centerIds: ['c1', 'c2'] } as const;
const DENY_ALL = { mode: 'none', provinces: [], centerIds: [] } as const;

describe('IRAN_PROVINCES', () => {
  it('has the canonical 31 provinces, unique', () => {
    expect(IRAN_PROVINCES).toHaveLength(31);
    expect(new Set(IRAN_PROVINCES).size).toBe(31);
    expect(IRAN_PROVINCES).toContain('تهران');
    expect(IRAN_PROVINCES).toContain('خراسان رضوی');
  });
});

describe('parseTerritoryArray', () => {
  it('parses a JSON array of strings', () => {
    expect(parseTerritoryArray('["تهران","البرز"]')).toEqual(['تهران', 'البرز']);
  });
  it('fails closed on garbage / non-array / empty strings', () => {
    expect(parseTerritoryArray('nonsense')).toEqual([]);
    expect(parseTerritoryArray('{"a":1}')).toEqual([]);
    expect(parseTerritoryArray('["x",1,null,""]')).toEqual(['x']);
    expect(parseTerritoryArray(null)).toEqual([]);
    expect(parseTerritoryArray(undefined)).toEqual([]);
  });
});

describe('resolveTerritoryFromRow', () => {
  it('admin / finance / production are never restricted', () => {
    for (const role of ['admin', 'finance', 'production']) {
      expect(
        resolveTerritoryFromRow({ role, territoryMode: 'provinces', territoryProvinces: '["تهران"]', territoryCenterIds: '[]' }),
      ).toBeNull();
    }
  });
  it('country mode → null (legacy unrestricted)', () => {
    expect(
      resolveTerritoryFromRow({ role: 'standard', territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]' }),
    ).toBeNull();
  });
  it('provinces mode resolves with the parsed list', () => {
    const t = resolveTerritoryFromRow({ role: 'standard', territoryMode: 'provinces', territoryProvinces: '["فارس"]', territoryCenterIds: '[]' });
    expect(t).toEqual({ mode: 'provinces', provinces: ['فارس'], centerIds: [] });
  });
  // v2.47.0 — EXPECTATION CHANGED (documented per audit rule):
  // the old "empty assignment resolves to null (never a full lockout)"
  // expectation was a fail-OPEN security hole — a corrupted or manually
  // edited row silently granted COUNTRY-WIDE access. Empty/broken
  // restricted lists and unknown modes must now resolve to deny-all.
  it('empty/broken restricted assignment → deny-all (fail-closed, v2.47.0)', () => {
    expect(
      resolveTerritoryFromRow({ role: 'standard', territoryMode: 'provinces', territoryProvinces: '[]', territoryCenterIds: '[]' }),
    ).toEqual(DENY_ALL);
    expect(
      resolveTerritoryFromRow({ role: 'standard', territoryMode: 'provinces', territoryProvinces: 'not-json', territoryCenterIds: '[]' }),
    ).toEqual(DENY_ALL);
    expect(
      resolveTerritoryFromRow({ role: 'standard', territoryMode: 'centers', territoryProvinces: '[]', territoryCenterIds: '[]' }),
    ).toEqual(DENY_ALL);
    expect(
      resolveTerritoryFromRow({ role: 'standard', territoryMode: 'centers', territoryProvinces: '[]', territoryCenterIds: '{"a":1}' }),
    ).toEqual(DENY_ALL);
  });
  // v2.47.0 — EXPECTATION CHANGED: unknown mode used to resolve to null
  // (unrestricted). Fail-closed requires zero access on unknown modes.
  it('unknown non-empty mode → deny-all (fail-closed, v2.47.0)', () => {
    expect(
      resolveTerritoryFromRow({ role: 'standard', territoryMode: 'galaxy', territoryProvinces: '[]', territoryCenterIds: '[]' }),
    ).toEqual(DENY_ALL);
  });
  it('NULL/empty mode value → legacy country default (documented deviation)', () => {
    expect(
      resolveTerritoryFromRow({ role: 'standard', territoryMode: '', territoryProvinces: '[]', territoryCenterIds: '[]' }),
    ).toBeNull();
  });
});

describe('territoryConfigProblem (v2.47.0)', () => {
  it('null for healthy rows (country / valid restricted / non-standard roles)', () => {
    expect(territoryConfigProblem({ role: 'admin', territoryMode: 'galaxy', territoryProvinces: '', territoryCenterIds: '' })).toBeNull();
    expect(territoryConfigProblem({ role: 'finance', territoryMode: 'provinces', territoryProvinces: '[]', territoryCenterIds: '[]' })).toBeNull();
    expect(territoryConfigProblem({ role: 'standard', territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]' })).toBeNull();
    expect(territoryConfigProblem({ role: 'standard', territoryMode: 'provinces', territoryProvinces: '["تهران"]', territoryCenterIds: '[]' })).toBeNull();
  });
  it('describes the problem for deny-all rows', () => {
    expect(territoryConfigProblem({ role: 'standard', territoryMode: 'provinces', territoryProvinces: '[]', territoryCenterIds: '[]' })).toContain('provinces');
    expect(territoryConfigProblem({ role: 'standard', territoryMode: 'centers', territoryProvinces: '[]', territoryCenterIds: '[]' })).toContain('centers');
    expect(territoryConfigProblem({ role: 'standard', territoryMode: 'galaxy', territoryProvinces: '[]', territoryCenterIds: '[]' })).toContain('ناشناخته');
  });
});

describe('centerTerritoryWhere', () => {
  it('null scope → undefined (no restriction)', () => {
    expect(centerTerritoryWhere(null)).toBeUndefined();
  });
  it('provinces mode → province IN', () => {
    expect(centerTerritoryWhere(PROV as never)).toEqual({ province: { in: ['تهران', 'البرز'] } });
  });
  it('centers mode → AND-wrapped id IN (never clobbers a top-level id)', () => {
    expect(centerTerritoryWhere(CENTERS as never)).toEqual({ AND: [{ id: { in: ['c1', 'c2'] } }] });
    // the exact regression of r57-e2e test 31: spreading into a literal
    // that already pins `id` must CONJOIN, not override
    const where = { id: 'other', ...centerTerritoryWhere(CENTERS as never) };
    expect(where).toEqual({ id: 'other', AND: [{ id: { in: ['c1', 'c2'] } }] });
  });
  it('deny-all → id IN [] (matches ZERO rows, v2.47.0)', () => {
    expect(centerTerritoryWhere(DENY_ALL as never)).toEqual({ AND: [{ id: { in: [] } }] });
  });
});

describe('centerRelTerritoryWhere', () => {
  it('null → undefined', () => {
    expect(centerRelTerritoryWhere(null)).toBeUndefined();
  });
  it('provinces → center relation filter', () => {
    expect(centerRelTerritoryWhere(PROV as never)).toEqual({ center: { province: { in: ['تهران', 'البرز'] } } });
  });
  it('centers → raw centerId column filter', () => {
    expect(centerRelTerritoryWhere(CENTERS as never)).toEqual({ centerId: { in: ['c1', 'c2'] } });
  });
  it('deny-all → centerId IN [] (matches ZERO rows, v2.47.0)', () => {
    expect(centerRelTerritoryWhere(DENY_ALL as never)).toEqual({ centerId: { in: [] } });
  });
});

describe('docOwnershipTerritoryWhere (v2.58.1 — ownership AND geography)', () => {
  it('null → own docs only (country mode: geography removed, ownership stays)', () => {
    expect(docOwnershipTerritoryWhere(null, 'u1')).toEqual({ createdById: 'u1' });
  });
  it('own docs AND center in territory (never colleagues\' docs)', () => {
    expect(docOwnershipTerritoryWhere(PROV as never, 'u1')).toEqual({
      AND: [
        { createdById: 'u1' },
        { OR: [{ center: { province: { in: ['تهران', 'البرز'] } } }, { centerId: null }] },
      ],
    });
    expect(docOwnershipTerritoryWhere(CENTERS as never, 'u1')).toEqual({
      AND: [
        { createdById: 'u1' },
        { OR: [{ centerId: { in: ['c1', 'c2'] } }, { centerId: null }] },
      ],
    });
  });
  it('deny-all → ONLY own documents (v2.47.0 contract preserved)', () => {
    expect(docOwnershipTerritoryWhere(DENY_ALL as never, 'u1')).toEqual({ createdById: 'u1' });
  });
});

describe('activityTerritoryWhere', () => {
  it('null → undefined', () => {
    expect(activityTerritoryWhere(null, 'u1')).toBeUndefined();
  });
  it('territory centers OR own center-less rows', () => {
    const w = activityTerritoryWhere(PROV as never, 'u1');
    expect(w).toEqual({
      OR: [
        { center: { province: { in: ['تهران', 'البرز'] } } },
        { AND: [{ centerId: null }, { OR: [{ createdById: 'u1' }, { assignedTo: 'u1' }] }] },
      ],
    });
  });
  it('deny-all → ONLY own center-less rows (v2.47.0)', () => {
    const w = activityTerritoryWhere(DENY_ALL as never, 'u1');
    expect(w).toEqual({
      OR: [
        { centerId: { in: [] } },
        { AND: [{ centerId: null }, { OR: [{ createdById: 'u1' }, { assignedTo: 'u1' }] }] },
      ],
    });
  });
});

describe('invoiceTerritoryWhere', () => {
  it('null → undefined', () => {
    expect(invoiceTerritoryWhere(null)).toBeUndefined();
  });
  it('scopes through centerAccount.center', () => {
    expect(invoiceTerritoryWhere(PROV as never)).toEqual({
      centerAccount: { center: { province: { in: ['تهران', 'البرز'] } } },
    });
    expect(invoiceTerritoryWhere(CENTERS as never)).toEqual({
      centerAccount: { centerId: { in: ['c1', 'c2'] } },
    });
  });
  it('deny-all → matches ZERO rows (v2.47.0)', () => {
    expect(invoiceTerritoryWhere(DENY_ALL as never)).toEqual({
      centerAccount: { centerId: { in: [] } },
    });
  });
});

describe('centerInTerritory', () => {
  it('unrestricted always true', () => {
    expect(centerInTerritory({ id: 'x', province: null }, null)).toBe(true);
  });
  it('provinces: null/foreign province false, own true', () => {
    const t = PROV as never;
    expect(centerInTerritory({ id: 'x', province: 'خوزستان' }, t)).toBe(false);
    expect(centerInTerritory({ id: 'x', province: null }, t)).toBe(false);
    expect(centerInTerritory({ id: 'x', province: 'تهران' }, t)).toBe(true);
  });
  it('centers mode matches id only', () => {
    const t = CENTERS as never;
    expect(centerInTerritory({ id: 'c1', province: 'فارس' }, t)).toBe(true);
    expect(centerInTerritory({ id: 'zz', province: 'تهران' }, t)).toBe(false);
  });
  it('deny-all → always false (v2.47.0)', () => {
    expect(centerInTerritory({ id: 'c1', province: 'تهران' }, DENY_ALL as never)).toBe(false);
  });
});

describe('territorySummary', () => {
  it('summarizes modes for chips', () => {
    expect(territorySummary({ territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]' })).toBe('کل کشور');
    expect(territorySummary({ territoryMode: 'provinces', territoryProvinces: '["تهران","البرز"]', territoryCenterIds: '[]' })).toBe('2 استان');
    expect(territorySummary({ territoryMode: 'centers', territoryProvinces: '[]', territoryCenterIds: '["a","b","c"]' })).toBe('3 مرکز خاص');
  });
  it('broken assignment honestly reports no access (v2.47.0 — was «کل کشور»)', () => {
    expect(territorySummary({ territoryMode: 'provinces', territoryProvinces: '[]', territoryCenterIds: '[]' })).toBe('بدون دسترسی (تخصیص ناقص)');
    expect(territorySummary({ territoryMode: 'centers', territoryProvinces: '[]', territoryCenterIds: '[]' })).toBe('بدون دسترسی (تخصیص ناقص)');
    expect(territorySummary({ territoryMode: 'galaxy', territoryProvinces: '[]', territoryCenterIds: '[]' })).toBe('بدون دسترسی (mode ناشناخته)');
  });
  it('legacy NULL mode still reads as whole country', () => {
    expect(territorySummary({ territoryMode: null as unknown as string, territoryProvinces: '[]', territoryCenterIds: '[]' })).toBe('کل کشور');
  });
});
