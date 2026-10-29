'use client';

// ════════════════════════════════════════════════════════════
// ACCESS CONTEXT (v2.26.0) — single source of truth for
// sidebar-level AND internal-tab-level visibility.
//
// The sidebar has always filtered its menu through
// filterMenuByAccess(resolveAllowedKeys(...)); the tabbed modules
// (SalesReports / SalesSettings / SalesCenters / …) rendered every
// internal tab regardless of the company catalog or the job-title
// matrix. This provider exposes the EXACT same resolved key set the
// sidebar shows, so an internal tab can never be visible (or
// reachable via a direct nav key / deep link) unless the sidebar
// would show its menu item too.
// ════════════════════════════════════════════════════════════

import React, { createContext, useContext, useMemo } from 'react';
import { COMPANY_MENUS, CompanySlug } from '@/lib/menu-catalog';
import { MenuAccessMatrix, resolveAllowedKeys, filterMenuByAccess } from '@/lib/access-config';

export interface AccessValue {
  /** All menu keys (parents + children) visible to the CURRENT user in the CURRENT company — same resolution the sidebar uses. */
  visibleKeys: Set<string>;
  /** Whether an internal tab with the given menu key may render. */
  isTabAllowed: (menuKey: string) => boolean;
  /** Filter a tab descriptor list down to allowed tabs. */
  filterTabs: <T extends { key: string }>(tabs: T[]) => T[];
  /** The first allowed key from a preferred list (fallback provided by caller). */
  firstAllowed: (preferred: string[], fallback: string) => string;
}

const AccessContext = createContext<AccessValue | null>(null);

export function AccessProvider({
  activeCompany,
  jobTitle,
  role,
  menuAccess,
  children,
}: {
  activeCompany: CompanySlug;
  jobTitle?: string | null;
  role?: string;
  menuAccess: MenuAccessMatrix | null;
  children: React.ReactNode;
}) {
  const value = useMemo<AccessValue>(() => {
    const allowedKeys = resolveAllowedKeys(activeCompany, jobTitle, role || 'standard', menuAccess);
    // Same pipeline as the sidebar: catalog → access filter → visible keys.
    const items = filterMenuByAccess(COMPANY_MENUS[activeCompany] || [], allowedKeys);
    const visibleKeys = new Set<string>();
    for (const it of items) {
      visibleKeys.add(it.key);
      if (it.children) for (const c of it.children) visibleKeys.add(c.key);
    }
    const isTabAllowed = (menuKey: string) => visibleKeys.has(menuKey);
    const filterTabs = <T extends { key: string }>(tabs: T[]) => tabs.filter((t) => visibleKeys.has(t.key));
    const firstAllowed = (preferred: string[], fallback: string) => preferred.find((k) => visibleKeys.has(k)) || fallback;
    return { visibleKeys, isTabAllowed, filterTabs, firstAllowed };
  }, [activeCompany, jobTitle, role, menuAccess]);

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

/** Access info for the active company. Falls back to full access outside the dashboard shell. */
export function useTabAccess(): AccessValue {
  const ctx = useContext(AccessContext);
  return useMemo(() => {
    if (ctx) return ctx;
    const all = (): boolean => true;
    return {
      visibleKeys: new Set<string>(),
      isTabAllowed: all,
      filterTabs: <T extends { key: string }>(tabs: T[]) => tabs,
      firstAllowed: (preferred: string[], fallback: string) => preferred[0] || fallback,
    };
  }, [ctx]);
}
