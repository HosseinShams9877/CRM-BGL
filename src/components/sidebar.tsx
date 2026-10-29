'use client';

import React, { useState, useEffect, useRef } from 'react';

import TopNavbar from '@/components/top-navbar';
import { CompanySlug, COMPANY_MENUS, MenuNode } from '@/lib/menu-catalog';
import { MenuAccessMatrix, resolveAllowedKeys, filterMenuByAccess } from '@/lib/access-config';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { BarChart3, Target, Building2, Layers, Heart, Star, ChevronDown, ChevronLeft, ChevronRight, LogOut, Settings, Users, MapPin, CreditCard, Package, Truck, ClipboardList, UserCircle, Briefcase, Shield, Calendar, ChartColumnIncreasing, Phone, Kanban, Receipt, Warehouse, Route, Boxes, Wrench, Undo2, Tag, Store, Contact2, Mail, FileCheck, Handshake, ClipboardCheck, ListChecks, Timer, Trophy, Headphones, HandCoins, UserRound, ShieldCheck, Brain, Sparkles, ListTodo, GraduationCap, BookOpenText, Bot, AudioLines, Zap, FilePlus2, Wind } from 'lucide-react';

// ==================== TYPES ====================
interface MenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  /** v2.34.0 — primary daily-work items render above the «سایر بخش‌ها» separator. */
  group?: 'primary' | 'secondary';
  children?: { key: string; label: string; icon?: React.ReactNode }[];
  badge?: string | undefined;
  badgeColor?: string;
}

interface CompanyItem {
  slug: CompanySlug;
  name: string;
  shortName: string;
  icon: React.ReactNode;
  color: string;
  accent: string;
  type: string;
  /** v2.31.8 — official logo asset (public/*.png). Rendered in the
   *  company switcher and the topbar identity chip; companies without
   *  an installed logo keep their lucide icon mark. */
  logo?: string | null;
  /** v2.35.0 — isolated company (شرکت مستقل): rendered in a separate
   *  «شرکت‌های مستقل» group with a badge; never merged into group views. */
  isIsolated?: boolean;
}

interface SidebarProps {
  activeCompany: CompanySlug;
  onCompanyChange: (slug: CompanySlug) => void;
  activeNav: string;
  /** Accepts an optional deep-link focus payload (from the global search)
   *  that flows straight through to the dashboard shell. */
  onNavChange: (key: string, focus?: { type: 'center' | 'product' | 'document' | 'person'; id: string; label?: string }) => void;
  user: { displayName: string; roleLabel: string; role?: string; jobTitle?: string | null; accessibleCompanies?: string[] } | null;
  onLogout: () => void;
  /** v2.26.0 — the access matrix & unread count are fetched ONCE in the
   *  dashboard shell and shared with the topbar; the sidebar no longer runs
   *  its own duplicate pollers/fetches. */
  menuAccess?: MenuAccessMatrix | null;
  unreadCount?: number;
  children: React.ReactNode;
}

function toPersianNum(n: number | string): string {
  const d = '\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

// ==================== COMPANY LIST ====================
// Business model labels reflect each company's go-to-market:
// بازرگانی = B2B (مراکز درمانی خصوصی/دولتی + همکاران و نمایندگان)
// آریا مدیکال = B2C (مصرف‌کننده نهایی) — تولید = ترکیبی B2B + B2C
// v2.34.4 — user-confirmed legal names (round 51): the manufacturer is
// بهبود گستر لیام ایرانیان (میم — تولید دستگاه) and the trader is
// بهبود گستر لیان ایرانیان (نون — بازرگانی). The old manufacturer label
// «بهبود گستر لیان» was a round-40 typo colliding with the trader.
// shortName BGL → تولید: BGL names the HOLDING (هلدینگ بهبود گستر), not
// the manufacturing subsidiary.
const COMPANIES: CompanyItem[] = [
  { slug: 'holding', name: 'بهبود گستر (هلدینگ)', shortName: 'هلدینگ', icon: <Layers size={18} />, color: '#2E2A5C', accent: '#1F8B7D', type: 'هلدینگ مادر گروه', logo: '/logo-bgl.png' },
  { slug: 'bazargani', name: 'بهبود گستر لیان ایرانیان', shortName: 'بازرگانی', icon: <Briefcase size={18} />, color: '#1A5276', accent: '#2980B9', type: 'واحد بازرگانی گروه', logo: '/logo-bazargani.png' },
  { slug: 'aria', name: 'آریا مدیکال', shortName: 'آریا', icon: <Heart size={18} />, color: '#4A235A', accent: '#8E44AD', type: 'فروش دستگاه و تجهیزات کمک تنفسی', logo: '/logo-aria.png' },
  { slug: 'bgl', name: 'بهبود گستر لیام ایرانیان', shortName: 'تولید', icon: <Star size={18} />, color: '#2E2A5C', accent: '#1F8B7D', type: 'تولید دستگاه‌های خلوص‌سنج', logo: '/logo-bgl-company.png' },
  // v2.35.0 — یاس طب: isolated company (تولید ست‌های ونتیلاتور). Fully
  // independent tenant — shown ONLY to users assigned to it, never to
  // group admins, never merged into the holding aggregate.
  { slug: 'yasteb', name: 'یاس طب', shortName: 'یاس طب', icon: <Wind size={18} />, color: '#134E4A', accent: '#0D9488', type: 'تولید ست‌های ونتیلاتور (مستقل)', isIsolated: true },
];

/** v2.31.8 — company brand mark: the official logo on a white tile, or the
 *  lucide icon on a tinted tile when no logo is installed. Logos are
 *  white-background PNGs, so they need a light tile on the dark sidebar;
 *  the icon fallback colours itself per context (white on dark, accent on
 *  the light dropdown). */
function CompanyMark({ logo, icon, accent, tile = 'w-9 h-9 rounded-xl', dark = true }: {
  logo?: string | null;
  icon: React.ReactNode;
  accent: string;
  tile?: string;
  dark?: boolean;
}) {
  if (logo) {
    return (
      <div className={`${tile} bg-white flex items-center justify-center shrink-0 overflow-hidden`}>
        <img src={logo} alt="" className="w-full h-full object-contain p-[3px]" loading="lazy" />
      </div>
    );
  }
  return (
    <div className={`${tile} flex items-center justify-center shrink-0`} style={{ background: `${accent}${dark ? '30' : '15'}`, color: dark ? '#fff' : accent }}>
      {icon}
    </div>
  );
}

// ==================== MENU ICONS (attached to the shared catalog) ====================
const PARENT_ICONS: Record<string, React.ReactNode> = {
  'dashboard': <BarChart3 size={18} />,
  'sales-expert': <UserCircle size={18} />,
  'sales-system': <Store size={18} />,
  'mailbox': <Mail size={18} />,
  'quick-activity': <Zap size={18} />,
  'quick-proforma': <FilePlus2 size={18} />,
  'sales-system-stages': <Kanban size={18} />,
  'followup': <Target size={18} />,
  'calls': <Phone size={18} />,
  'centers': <Building2 size={18} />,
  'products': <Boxes size={18} />,
  'calendar': <Calendar size={18} />,
  'reports': <ChartColumnIncreasing size={18} />,
  'users': <Users size={18} />,
  'settings': <Settings size={18} />,
  'collections': <CreditCard size={18} />,
  'visits': <MapPin size={18} />,
  'inventory': <Package size={18} />,
  'production': <Truck size={18} />,
  'loyalty': <Trophy size={18} />,
  'aftersales': <Headphones size={18} />,
  'partner-pricing': <HandCoins size={18} />,
  'ai-intelligence': <Brain size={18} />,
};

const CHILD_ICONS: Record<string, React.ReactNode> = {
  'sales-system-stages': <Layers size={14} />,
  'sales-proformas': <FileCheck size={14} />,
  'sales-invoices': <Receipt size={14} />,
  'sales-returns': <Undo2 size={14} />,
  'calls-log': <Phone size={14} />,
  'calls-history': <Timer size={14} />,
  'calls-scheduled': <Calendar size={14} />,
  'centers-list': <ListChecks size={14} />,
  'centers-contacts': <Contact2 size={14} />,
  'centers-map': <MapPin size={14} />,
  'centers-cats': <ClipboardList size={14} />,
  'centers-territory': <MapPin size={14} />,
  'centers-contracts': <Handshake size={14} />,
  'centers-individuals': <UserRound size={14} />,
  'aftersales-tickets': <ClipboardList size={14} />,
  'aftersales-warranty': <ShieldCheck size={14} />,
  'products-list': <Package size={14} />,
  'products-specs': <Wrench size={14} />,
  'products-cats': <Tag size={14} />,
  'inventory-stock': <Warehouse size={14} />,
  'inventory-movements': <Route size={14} />,
  'inventory-hesabfa': <Warehouse size={14} />,
  'production-orders': <ClipboardCheck size={14} />,
  'production-ship': <Truck size={14} />,
  'settings-access': <Shield size={14} />,
  // v2.51.0 (r76) — professional reports center (companies + experts + PDF)
  'reports-center': <ChartColumnIncreasing size={14} />,
  'ai-dashboard': <Sparkles size={14} />,
  'ai-calls': <AudioLines size={14} />,
  'ai-actions': <ListTodo size={14} />,
  'ai-coaching': <GraduationCap size={14} />,
  'ai-playbook': <BookOpenText size={14} />,
  'ai-settings': <Bot size={14} />,
};

/** Build the icon-enriched menu tree for a company from the shared catalog. */
function buildMenus(company: CompanySlug, unreadCount: number): MenuItem[] {
  const catalog: MenuNode[] = COMPANY_MENUS[company] || [];
  return catalog.map((m) => ({
    key: m.key,
    label: m.label,
    group: m.group === 'primary' ? 'primary' : 'secondary',
    icon: PARENT_ICONS[m.key] || <Layers size={18} />,
    badge: m.key === 'mailbox' && unreadCount > 0 ? toPersianNum(unreadCount) : undefined,
    badgeColor: '#dc2626',
    children: m.children?.map((c) => ({
      key: c.key,
      label: c.label,
      icon: CHILD_ICONS[c.key],
    })),
  }));
}

// ==================== SIDEBAR COMPONENT ====================
export default function Sidebar({ activeCompany, onCompanyChange, activeNav, onNavChange, user, onLogout, menuAccess, unreadCount = 0, children }: SidebarProps) {
  // v2.26.0 — desktop collapse and the mobile drawer are now fully separate
  // states. Previously one shared `collapsed` leaked between viewport modes:
  // collapse on desktop, then shrink to mobile → the drawer opened with no
  // labels. The mobile drawer is ALWAYS fully expanded.
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openMenus, setOpenMenus] = useState<Set<string>>(new Set());
  const [showCompanyList, setShowCompanyList] = useState(false);
  // Outside-click / Escape surface for the company dropdown.
  const companyBoxRef = useRef<HTMLDivElement>(null);

  // v2.26.0 — close the company dropdown on outside click and Escape
  // (it previously stayed open until an option was picked).
  useEffect(() => {
    if (!showCompanyList) return;
    const onMouseDown = (e: MouseEvent) => {
      if (companyBoxRef.current && !companyBoxRef.current.contains(e.target as Node)) setShowCompanyList(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowCompanyList(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showCompanyList]);

  const company = COMPANIES.find(c => c.slug === activeCompany) || COMPANIES[0];
  const allMenuItems = buildMenus(activeCompany, unreadCount);
  // Per-company × per-job-title access (see lib/access-config.ts). Admins see everything.
  const allowedKeys = user ? resolveAllowedKeys(activeCompany, user.jobTitle, user.role || 'standard', menuAccess ?? null) : null;
  const menuItems = filterMenuByAccess(allMenuItems, allowedKeys);

  // Filter companies based on user's accessible companies.
  // v2.35.0 — isolated companies (یاس طب): admins NEVER see them (the
  // group switcher stays group-only); assigned non-admin users do.
  const baseList = user?.role === 'admin'
    ? COMPANIES.filter((c) => !c.isIsolated)
    : COMPANIES;
  const filteredCompanies = user?.role !== 'admin' && user?.accessibleCompanies && user.accessibleCompanies.length > 0
    ? baseList.filter(c => c.slug === 'holding' ? user.role === 'admin' : user.accessibleCompanies!.includes(c.slug))
    : baseList;

  const toggleSubmenu = (key: string) => {
    setOpenMenus(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleNav = (key: string) => {
    onNavChange(key);
    setMobileOpen(false);
    setShowCompanyList(false);
  };

  const handleCompanyChange = (slug: CompanySlug) => {
    onCompanyChange(slug);
    setShowCompanyList(false);
    setMobileOpen(false);
  };

  /**
   * The sidebar body. `collapsed` ONLY applies to the fixed desktop rail —
   * the mobile Sheet drawer always renders the expanded form.
   *
   * v2.26.0 height architecture (mobile):
   *   Drawer (max 100dvh)
   *    ├ header  → shrink-0
   *    ├ nav     → flex-1 min-h-0 overflow-y-auto   (the ONLY scroller)
   *    └ footer  → shrink-0 (profile + logout always reachable)
   */
  const renderSidebarContent = (collapsed: boolean) => (
    <div className="flex flex-col h-full min-h-0">
      {/* ---- LOGO ---- */}
      <div className="flex items-center gap-3 px-4 h-14 shrink-0 border-b border-white/10">
        <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
          <svg width="22" height="22" viewBox="0 0 80 80">
            <rect x="4" y="4" width="72" height="72" rx="16" fill="none" stroke="#1F8B7D" strokeWidth="3" />
            <text x="40" y="52" textAnchor="middle" fill="white" fontSize="26" fontWeight="700" fontFamily="Vazirmatn">BGL</text>
          </svg>
        </div>
        {!collapsed && (
          <div className="flex-1 min-w-0 animate-fade-in">
            <p className="text-white font-bold text-sm truncate">سامانه فروش</p>
            <p className="text-white/40 text-[11px] truncate">هلدینگ بهبود گستر</p>
          </div>
        )}
        <button
          onClick={() => setDesktopCollapsed(!desktopCollapsed)}
          className={`hidden lg:flex w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 items-center justify-center transition-colors shrink-0 ${collapsed ? '' : ''}`}
          title={collapsed ? 'باز کردن منو' : 'جمع کردن منو'}
          aria-label={collapsed ? 'باز کردن منو' : 'جمع کردن منو'}
          aria-expanded={!collapsed}
        >
          {/* RTL: the rail docks to the RIGHT edge — collapsing pushes it
              further right (chevron-right); expanding pulls it left. */}
          {collapsed ? <ChevronLeft size={14} className="text-white/70" /> : <ChevronRight size={14} className="text-white/70" />}
        </button>
      </div>

      {/* ---- COMPANY SELECTOR ---- */}
      <div className="px-3 py-3 shrink-0">
        <div className="relative" ref={companyBoxRef}>
          <button
            onClick={() => { if (collapsed) { const fcs = filteredCompanies.map(c => c.slug); const idx = fcs.indexOf(activeCompany); onCompanyChange(fcs[(idx + 1) % fcs.length] as CompanySlug); } else { setShowCompanyList(!showCompanyList); } }}
            className="w-full flex items-center gap-3 p-2.5 rounded-xl bg-white/10 hover:bg-white/15 transition-colors"
            aria-haspopup="listbox"
            aria-expanded={!collapsed && showCompanyList}
            aria-label={`شرکت فعال: ${company.name}`}
          >
            <CompanyMark logo={company.logo} icon={company.icon} accent={company.accent} tile="w-9 h-9 rounded-xl" />
            {!collapsed && (
              <>
                <div className="flex-1 min-w-0 text-right">
                  <p className="text-white text-xs font-bold truncate">{company.shortName}</p>
                  <p className="text-white/40 text-[11px]">{company.type}</p>
                </div>
                <ChevronDown size={14} className={`text-white/50 transition-transform duration-200 ${showCompanyList ? 'rotate-180' : ''}`} />
              </>
            )}
          </button>

          {/* Company dropdown */}
          {showCompanyList && !collapsed && (
            <div className="absolute top-full mt-1.5 right-0 left-0 bg-white dark:bg-[oklch(0.21_0.02_260)] backdrop-blur-xl rounded-xl shadow-2xl border border-gray-200 dark:border-white/10 overflow-hidden z-50 animate-scale-in" role="listbox" aria-label="انتخاب شرکت">
              {filteredCompanies.filter((c) => !c.isIsolated).map((c) => {
                return (
                  <button
                    key={c.slug}
                    onClick={() => handleCompanyChange(c.slug)}
                    role="option"
                    aria-selected={activeCompany === c.slug}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-right transition-colors ${activeCompany === c.slug ? 'bg-teal-50' : 'hover:bg-gray-50'}`}
                  >
                    <CompanyMark logo={c.logo} icon={c.icon} accent={c.accent} tile="w-8 h-8 rounded-lg" dark={false} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-gray-900 dark:text-gray-100 truncate">{c.name}</p>
                      <p className="text-[11px] text-gray-400">{c.type}</p>
                    </div>
                    {activeCompany === c.slug && <div className="w-2 h-2 rounded-full" style={{ background: c.accent }} />}
                  </button>
                );
              })}
              {/* v2.35.0 — isolated companies in their own separated group */}
              {filteredCompanies.some((c) => c.isIsolated) && (
                <>
                  <div className="px-3 pt-2.5 pb-1 border-t border-gray-100 dark:border-white/10 mt-1">
                    <p className="text-[10px] font-bold text-teal-700 dark:text-teal-400">شرکت‌های مستقل (خارج از تجمیع گروه)</p>
                  </div>
                  {filteredCompanies.filter((c) => c.isIsolated).map((c) => (
                    <button
                      key={c.slug}
                      onClick={() => handleCompanyChange(c.slug)}
                      role="option"
                      aria-selected={activeCompany === c.slug}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 text-right transition-colors ${activeCompany === c.slug ? 'bg-teal-50' : 'hover:bg-gray-50'}`}
                    >
                      <CompanyMark logo={c.logo} icon={c.icon} accent={c.accent} tile="w-8 h-8 rounded-lg" dark={false} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-gray-900 dark:text-gray-100 truncate">{c.name}</p>
                        <p className="text-[11px] text-gray-400">{c.type}</p>
                      </div>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-teal-50 text-teal-700 border border-teal-200 shrink-0">مستقل</span>
                      {activeCompany === c.slug && <div className="w-2 h-2 rounded-full" style={{ background: c.accent }} />}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---- NAVIGATION MENU — the only scrollable region ---- */}
      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-4" aria-label="منوی اصلی">
        <div className="space-y-0.5">
          {menuItems.map((item, idx) => {
            // v2.34.0 — labeled separator between the daily-work primaries
            // and everything else (spec §10: منو شلوغ نشود). Collapsed mode
            // shows a discreet dot rule instead of the label.
            const showSeparator = idx > 0 && item.group !== 'primary' && menuItems[idx - 1].group === 'primary';
            const hasChildren = item.children && item.children.length > 0;
            const isOpen = openMenus.has(item.key);
            const isActive = activeNav === item.key || (hasChildren && item.children!.some(c => activeNav === c.key));

            return (
              <div key={item.key}>
                {showSeparator && !collapsed && (
                  <div className="pt-4 pb-2 px-3" data-menu-separator>
                    <p className="text-[10px] font-bold tracking-wide text-white/35 border-t border-white/10 pt-3">سایر بخش‌ها</p>
                  </div>
                )}
                {showSeparator && collapsed && (
                  <div className="my-3 mx-3 border-t border-white/10" data-menu-separator aria-hidden="true" />
                )}
                {/* Parent item */}
                <button
                  onClick={() => hasChildren ? toggleSubmenu(item.key) : handleNav(item.key)}
                  aria-expanded={hasChildren ? isOpen : undefined}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-200 group relative ${
                    isActive && !hasChildren
                      ? 'bg-white/20 text-white shadow-sm'
                      : isActive && hasChildren
                      ? 'bg-white/10 text-white/90'
                      : 'text-white/60 hover:text-white hover:bg-white/10'
                  }`}
                  title={collapsed ? item.label : undefined}
                >
                  <span className={`shrink-0 transition-colors ${isActive ? 'text-teal-300' : 'text-white/50 group-hover:text-white'}`}>
                    {item.icon}
                  </span>
                  {!collapsed && (
                    <>
                      <span className="flex-1 text-right truncate">{item.label}</span>
                      {item.badge && (
                        <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center"
                          style={{ background: item.badgeColor || '#dc2626', color: '#fff' }}>
                          {item.badge}
                        </span>
                      )}
                      {hasChildren && (
                        <ChevronDown size={14} className={`text-white/30 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                      )}
                    </>
                  )}
                  {/* Active indicator bar */}
                  {isActive && !hasChildren && (
                    <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1 h-5 rounded-l-full" style={{ background: company.accent }} />
                  )}
                </button>

                {/* Submenu */}
                {hasChildren && isOpen && !collapsed && (
                  <div className="mr-5 mt-0.5 space-y-0.5 border-r border-white/10 pr-3 animate-fade-in">
                    {item.children!.map((child) => {
                      const childActive = activeNav === child.key;
                      return (
                        <button
                          key={child.key}
                          onClick={() => handleNav(child.key)}
                          aria-current={childActive ? 'page' : undefined}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200 ${
                            childActive
                              ? 'text-teal-300'
                              : 'text-white/40 hover:text-white/80 hover:bg-white/5'
                          }`}
                        >
                          {child.icon && <span className="shrink-0 opacity-60">{child.icon}</span>}
                          <span>{child.label}</span>
                          {childActive && <div className="mr-auto w-1.5 h-1.5 rounded-full" style={{ background: company.accent }} />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      {/* ---- FOOTER: User + Logout — always visible, never scrolled away ---- */}
      <div className="shrink-0 border-t border-white/10 px-3 py-3">
        {/* v2.58.1 badge (audit 85-d #7 + round 86) — support can now
            identify the customer's build at a glance (was nowhere in the UI). */}
        {!collapsed && (
          <p className="text-center text-[10px] text-white/25 mb-2" dir="ltr">BGL CRM v2.58.11</p>
        )}
        {user && (
          <div className={`flex items-center gap-3 p-2.5 rounded-xl bg-white/5 ${!collapsed ? 'mb-2' : ''}`}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
              style={{ background: `linear-gradient(135deg, ${company.accent}, ${company.color})` }}>
              {user.displayName.charAt(0)}
            </div>
            {!collapsed && (
              <div className="flex-1 min-w-0 animate-fade-in">
                <p className="text-white text-xs font-bold truncate">{user.displayName}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${user.role && user.role !== 'admin' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                  <p className="text-white/40 text-[11px] truncate">{user.roleLabel}</p>
                </div>
              </div>
            )}
            <div className={`flex items-center gap-1 animate-fade-in ${collapsed ? 'flex-col' : ''}`}>
              {/* v2.26.0 — the decorative fake bell (static red dot, no
                  action, no data) is REMOVED. The real notification bell
                  lives in the top navbar and is backed by actual pending
                  approvals / overdue follow-ups. Two identical-looking bells
                  with different behavior confused users; now there is one. */}
              <button onClick={onLogout} className="text-white/50 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-colors min-w-[32px] min-h-[32px] flex items-center justify-center" title="خروج" aria-label="خروج از حساب">
                <LogOut size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* ---- MOBILE DRAWER (v2.26.0) ----
          Replaced the plain fixed divs with the Radix-based Sheet:
          focus trap, Escape-to-close, aria-modal, focus return, overlay
          click-to-close — all the dialog semantics a drawer must have.
          Height is bounded to 100dvh and ONLY the nav region scrolls. */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="right"
          hideClose
          className="w-[290px] sm:w-72 p-0 border-l-0 h-full max-h-[100dvh] flex flex-col"
        >
          <SheetTitle className="sr-only">منوی اصلی</SheetTitle>
          <div className="h-full max-h-[100dvh] flex flex-col" style={{ background: 'linear-gradient(180deg, #1a1640 0%, #2E2A5C 100%)' }}>
            {renderSidebarContent(false)}
          </div>
        </SheetContent>
      </Sheet>

      {/* ---- DESKTOP SIDEBAR ---- */}
      <aside
        className={`hidden lg:flex flex-col fixed top-0 right-0 bottom-0 z-40 transition-all duration-300 ease-in-out ${
          desktopCollapsed ? 'w-[72px]' : 'w-[260px]'
        }`}
        style={{ background: 'linear-gradient(180deg, #1a1640 0%, #2E2A5C 100%)' }}
      >
        {renderSidebarContent(desktopCollapsed)}
      </aside>

      {/* ---- MAIN CONTENT WRAPPER (wraps children) ---- */}
      <div
        className={`transition-all duration-300 ease-in-out min-h-screen ${
          desktopCollapsed ? 'lg:mr-[72px]' : 'lg:mr-[260px]'
        }`}
      >
        {/* Top navbar — ONE instance for all viewports (the hamburger is
            CSS-hidden on lg). Rendering it twice used to double every
            navbar poller and duplicate dropdown state. */}
        <div className="sticky top-0 z-40">
          <TopNavbar
            companyLabel={company.name}
            companyType={company.type}
            companyLogo={company.logo ?? null}
            user={user}
            onLogout={onLogout}
            onNavigate={onNavChange}
            unreadCount={unreadCount}
            onMenuClick={() => setMobileOpen(true)}
          />
        </div>

        {/* Page content */}
        {children}
      </div>
    </>
  );
}
