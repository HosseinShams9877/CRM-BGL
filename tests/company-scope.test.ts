// Unit tests — owner-aware tenant isolation (v2.31.2, round 30).
// Real-world bug this guards: a center-less activity (the calendar UI's
// default — the center dropdown is optional) was treated as company-neutral
// by optionalCenterCompanyWhere(), so a BGL user could LIST, READ and EDIT
// an Aria user's personal task, and the activity report counted foreign
// users. buildOwnerScopedCenterWhere() replaces that fragment for
// user-owned rows (Activity, ServiceTicket).
import { describe, it, expect } from 'vitest';
import {
  buildOwnerScopedCenterWhere,
  DEFAULT_OWNER_ID_FIELDS,
} from '@/lib/company-scope';

const FRAG = (companyIds: string[], colleagueUserIds: string[]) =>
  buildOwnerScopedCenterWhere(companyIds, colleagueUserIds);

describe('buildOwnerScopedCenterWhere — structure', () => {
  it('scopes center-backed rows to the allowed company ids', () => {
    const f = FRAG(['comp-bgl'], ['u-reza']) as { OR: unknown[] };
    expect(f.OR[0]).toEqual({ center: { companyId: { in: ['comp-bgl'] } } });
  });

  it('allows a center-less row only when its owner is a colleague', () => {
    const f = FRAG(['comp-bgl'], ['u-reza', 'u-hossein']) as {
      OR: [unknown, { AND: [{ centerId: null }, { OR: unknown[] }] }];
    };
    const branch = f.OR[1];
    expect(branch.AND[0]).toEqual({ centerId: null });
    expect(branch.AND[1].OR).toEqual([
      { createdById: { in: ['u-reza', 'u-hossein'] } },
      { assignedTo: { in: ['u-reza', 'u-hossein'] } },
    ]);
  });

  it('matches the creator OR the assignee (either makes the row visible)', () => {
    const f = FRAG(['c'], ['u1', 'u2']) as {
      OR: [unknown, { AND: [unknown, { OR: Array<Record<string, unknown>> }] }];
    };
    const owners = f.OR[1].AND[1].OR;
    expect(owners.some((o) => 'createdById' in o)).toBe(true);
    expect(owners.some((o) => 'assignedTo' in o)).toBe(true);
  });
});

describe('buildOwnerScopedCenterWhere — fail-closed paths', () => {
  it('a user with NO colleagues sees only center-backed rows of their companies', () => {
    // no colleague match possible → the center-less branch can never fire
    const f = FRAG(['comp-bgl'], []) as {
      OR: [unknown, { AND: [unknown, Record<string, unknown>] }];
    };
    const ownerMatch = f.OR[1].AND[1];
    expect(ownerMatch).toEqual({ createdById: { in: [] } });
  });

  it('a user with NO companies matches nothing at all (empty company set)', () => {
    // getAllowedCompanyIds semantics: empty assignment → matches nothing
    const f = FRAG([], ['u1']) as { OR: [{ center: { companyId: { in: string[] } } }, unknown] };
    expect(f.OR[0].center.companyId.in).toEqual([]);
  });

  it('the center-less branch requires centerId null (center-backed rows never fall through)', () => {
    const f = FRAG(['c'], ['u1']) as {
      OR: [unknown, { AND: [{ centerId: string | null }, unknown] }];
    };
    expect(f.OR[1].AND[0].centerId).toBeNull();
  });
});

describe('buildOwnerScopedCenterWhere — custom owner columns', () => {
  it('honours non-default column names for future models', () => {
    const f = buildOwnerScopedCenterWhere(['c'], ['u1'], {
      creator: 'reporterId',
      assignee: 'technicianId',
    }) as {
      OR: [unknown, { AND: [unknown, { OR: Array<Record<string, unknown>> }] }];
    };
    const owners = f.OR[1].AND[1].OR;
    expect(owners).toEqual([
      { reporterId: { in: ['u1'] } },
      { technicianId: { in: ['u1'] } },
    ]);
  });

  it('default owner columns match the Activity and ServiceTicket schema', () => {
    // both models name their raw user-id columns createdById / assignedTo
    expect(DEFAULT_OWNER_ID_FIELDS).toEqual({
      creator: 'createdById',
      assignee: 'assignedTo',
    });
  });
});

describe('buildOwnerScopedCenterWhere — the round-30 leak scenario, as data', () => {
  // Simulated rows + a tiny in-memory matcher mirroring Prisma's evaluation
  // of the fragment, to prove the isolation semantics end-to-end.
  const companies = { aria: 'comp-aria', bgl: 'comp-bgl' };
  const users = {
    sara: { id: 'u-sara', companyIds: ['aria'] },
    reza: { id: 'u-reza', companyIds: ['bgl'] },
    dual: { id: 'u-dual', companyIds: ['bazargani', 'bgl'] },
  };
  const rows = [
    { id: 'act-a', centerId: 'ctr-aria', centerCompanyId: companies.aria, createdById: 'u-sara', assignedTo: 'u-sara' },
    { id: 'act-b', centerId: null, centerCompanyId: null, createdById: 'u-sara', assignedTo: 'u-sara' },
    { id: 'act-c', centerId: 'ctr-bgl', centerCompanyId: companies.bgl, createdById: 'u-reza', assignedTo: 'u-reza' },
    { id: 'act-d', centerId: null, centerCompanyId: null, createdById: 'u-reza', assignedTo: 'u-reza' },
    { id: 'act-e', centerId: null, centerCompanyId: null, createdById: 'u-dual', assignedTo: null },
    { id: 'act-orph', centerId: null, centerCompanyId: null, createdById: null, assignedTo: null },
  ];

  const matches = (row: (typeof rows)[number], frag: Record<string, unknown>): boolean => {
    const branches = (frag as { OR: unknown[] }).OR;
    return branches.some((b) => {
      if ('center' in (b as object)) {
        const ids = ((b as { center: { companyId: { in: string[] } } }).center.companyId.in);
        return row.centerCompanyId !== null && ids.includes(row.centerCompanyId);
      }
      const and = (b as { AND: [{ centerId: null }, Record<string, unknown>] }).AND;
      if (row.centerId !== null) return false; // centerId must be null
      const ownerMatch = and[1];
      if ('OR' in ownerMatch) {
        return (ownerMatch as { OR: Array<Record<string, { in: string[] }>> }).OR.some((cond) => {
          const col = Object.keys(cond)[0] as 'createdById' | 'assignedTo';
          const ids = cond[col].in;
          return row[col] !== null && ids.includes(row[col]);
        });
      }
      // fail-closed: { createdById: { in: [] } } → no owner can ever match
      return false;
    });
  };

  const colleaguesOf = (slugs: string[]) =>
    Object.values(users)
      .filter((u) => u.companyIds.some((s) => slugs.includes(s)))
      .map((u) => u.id);

  it('reza (bgl) can no longer see or edit sara’s (aria) center-less task — the reported leak', () => {
    const frag = FRAG([companies.bgl], colleaguesOf(['bgl']));
    const visible = rows.filter((r) => matches(r, frag)).map((r) => r.id);
    // C (bgl center), D (reza's own center-less), E (dual colleague shares bgl)
    expect(visible).toEqual(['act-c', 'act-d', 'act-e']);
    expect(visible).not.toContain('act-b'); // ← the round-30 leak, now closed
    expect(visible).not.toContain('act-a');
  });

  it('sara (aria) sees only her own world', () => {
    const frag = FRAG([companies.aria], colleaguesOf(['aria']));
    const visible = rows.filter((r) => matches(r, frag)).map((r) => r.id);
    expect(visible).toEqual(['act-a', 'act-b']);
  });

  it('a dual-company user’s center-less rows are visible to both companies (they work for both)', () => {
    const rezaFrag = FRAG([companies.bgl], colleaguesOf(['bgl']));
    const saraFrag = FRAG([companies.aria], colleaguesOf(['aria']));
    expect(matches(rows[4], rezaFrag)).toBe(true);  // act-e by u-dual
    expect(matches(rows[4], saraFrag)).toBe(false); // dual shares bgl, not aria
  });

  it('orphan rows (no owner at all) are admin-only — fail-closed', () => {
    const frag = FRAG([companies.bgl], colleaguesOf(['bgl']));
    expect(matches(rows[5], frag)).toBe(false);
  });
});
