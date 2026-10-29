'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  Building2, Phone, X, Search, Plus, Check, Clock,
  AlertTriangle, Calendar, StickyNote, Send,
  MapPin, User as UserIcon, Layers, Activity,
  MessageCircle, Mail, Briefcase, Heart,
  RefreshCw, Star, Target, Hash, Eye, EyeOff, Loader2, KeyRound,
  // v2.31.5 — landscape login promo panel capability icons
  FileText, Sparkles, Boxes, BarChart3, ShieldCheck,
  // v2.35.0 — یاس طب company mark (ventilator sets)
  Wind,
} from 'lucide-react';
import { toast } from 'sonner';
import SalesExpertDashboard from '@/components/sales-expert-dashboard';
import SalesPipeline from '@/components/sales-pipeline';
import SalesCalendar from '@/components/sales-calendar';
import SalesCalls from '@/components/sales-calls';
import SalesCenters from '@/components/sales-centers';
import { CenterDossier } from '@/components/centers/center-dossier';
import SalesDocs from '@/components/sales-docs';
import CustomerClub from '@/components/customer-club';
import AfterSales from '@/components/after-sales';
import PartnerPricing from '@/components/partner-pricing';
import SalesProducts from '@/components/sales-products';
import Mailbox from '@/components/mailbox';

// v2.51.0 (r76) — «مرکز گزارش حرفه‌ای» (companies + experts + A4 PDF export)

import SalesCollections from '@/components/sales-collections';
import SmsDialog from '@/components/sms-dialog';
import { buildFollowupReminderSms } from '@/lib/sms/provider';
import SalesInventory from '@/components/sales-inventory';
import SalesVisits from '@/components/sales-visits';
import SalesProduction from '@/components/sales-production';
import SalesUsers from '@/components/sales-users';

import Sidebar from '@/components/sidebar';



import { QuickActivityScreen } from '@/components/quick-activity';
import { QuickProformaScreen } from '@/components/quick-proforma';
import { normalizeNavKey } from '@/lib/menu-catalog';
import { toJalaliString } from '@/lib/jalali';
import { AccessProvider } from '@/components/access-context';
import { COMPANY_MENUS } from '@/lib/menu-catalog';
import { resolveAllowedKeys, filterMenuByAccess, type MenuAccessMatrix } from '@/lib/access-config';

// v2.58.0 (audit 85-d #5): heavy, rarely-opened modules are code-split now —
// the app used to ship ONE monolithic client bundle (recharts + all report
// settings/AI code in the first paint). Each module lazy-loads on first
// open with a branded placeholder; behavior and props are unchanged.
const ModulePlaceholder = () => (
  <div dir="rtl" className="min-h-[60vh] flex flex-col items-center justify-center gap-3 text-slate-400">
    <div className="w-8 h-8 rounded-full border-[3px] border-teal-200 border-t-teal-600 animate-spin" />
    <p className="text-xs">در حال بارگذاری ماژول…</p>
  </div>
);
const SalesReports = dynamic(() => import('@/components/sales-reports'), { ssr: false, loading: ModulePlaceholder });
const ReportsCenter = dynamic(() => import('@/components/reports-center'), { ssr: false, loading: ModulePlaceholder });
const SalesSettings = dynamic(() => import('@/components/sales-settings'), { ssr: false, loading: ModulePlaceholder });
const AiSales = dynamic(() => import('@/components/ai-sales/ai-sales'), { ssr: false, loading: ModulePlaceholder });
const HoldingDashboard = dynamic(() => import('@/components/holding-dashboard'), { ssr: false, loading: ModulePlaceholder });
const CompanyReportDashboard = dynamic(() => import('@/components/company-report-dashboard'), { ssr: false, loading: ModulePlaceholder });

// ==================== TYPES ====================
// v2.26.0 — «checking» eliminates the login flicker: the previous initial
// state was 'login', so a user with a live session always saw the login
// screen flash for the duration of the /api/auth check round-trip.
type Screen = 'checking' | 'login' | 'dashboard';

/** Deep-link payload produced by the global search (opens the exact entity). */
export interface NavFocus {
  type: 'center' | 'product' | 'document' | 'person';
  id: string;
  label?: string;
}
type CompanySlug = 'holding' | 'bazargani' | 'aria' | 'bgl' | 'yasteb';

/** v2.35.0 — isolated company slugs (یاس طب): never enterable by admins
 * and never part of the holding aggregate. */
const ISOLATED_SLUGS = new Set<CompanySlug>(['yasteb']);
type FollowupStatus = 'all' | 'overdue' | 'today' | 'upcoming' | 'done';

interface CompanyConfig {
  name: string;
  description: string;
  type: string;
  typeEn: string;
  color: string;
  accent: string;
  icon: React.ReactNode;
  roleBadge: string;
}

interface UserData {
  id: string;
  username?: string;
  displayName: string;
  role: string;
  roleLabel: string;
  jobTitle?: string | null;
  accessibleCompanies: string[];
  /** v2.34.6 — admin impersonation banner (who switched into this account) */
  impersonating?: { byId: string; byName: string } | null;
}

interface FollowupItem {
  id: string;
  centerName: string;
  city: string | null;
  personName: string;
  phone: string | null;
  frequency: string;
  frequencyDays: number;
  nextFollowupDate: string | null;
  daysOverdue: number;
  totalFollowups: number;
  status: string;
  companyId: string;
  history: { id: string; method: string; result: string | null; note: string | null; createdAt: string }[];
  _count: { history: number; notes: number };
}

interface CompanyData {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: string;
  color: string;
  accentColor: string;
  followupCount: number;
  centerCount: number;
}

// ==================== CONSTANTS ====================
// v2.34.4 — group structure (round 51, user-confirmed legal names): three
// subsidiaries under هلدینگ بهبود گستر (BGL). type = the company's domain
// in the group (feeds the subsidiary dashboard header/badge); description
// mirrors the same taxonomy. The manufacturer's legal name is
// بهبود گستر لیام ایرانیان (میم); the similarly-spelled trader is
// بهبود گستر لیان ایرانیان (نون).
const COMPANIES: Record<CompanySlug, CompanyConfig> = {
  holding: {
    name: 'بهبود گستر (هلدینگ)',
    description: 'نمای کلی عملکرد تمامی شرکت‌های گروه',
    type: 'هلدینگ مادر گروه',
    typeEn: 'Holding',
    color: '#2E2A5C',
    accent: '#1F8B7D',
    icon: <Layers size={20} />,
    roleBadge: 'مدیر ارشد',
  },
  bazargani: {
    name: 'بهبود گستر لیان ایرانیان',
    description: 'واحد بازرگانی گروه — فروش عمده و تأمین کالا',
    type: 'واحد بازرگانی گروه',
    typeEn: 'B2B',
    color: '#1A5276',
    accent: '#2980B9',
    icon: <Briefcase size={20} />,
    roleBadge: 'کارشناس فروش',
  },
  aria: {
    name: 'آریا مدیکال',
    // v2.31.13 — user-confirmed scope wording (round 42): «فروش دستگاه و
    // تجهیزات کمک تنفسی» (devices AND equipment).
    description: 'فروش دستگاه و تجهیزات کمک تنفسی — واجد شرایط ارز دولتی',
    type: 'فروش دستگاه و تجهیزات کمک تنفسی',
    typeEn: 'B2C',
    color: '#4A235A',
    accent: '#8E44AD',
    icon: <Heart size={20} />,
    roleBadge: 'نماینده علمی',
  },
  bgl: {
    name: 'بهبود گستر لیام ایرانیان',
    description: 'تولیدکنندهٔ دستگاه‌های خلوص‌سنج گروه',
    type: 'تولید دستگاه‌های خلوص‌سنج',
    typeEn: 'B2B',
    color: '#2E2A5C',
    accent: '#1F8B7D',
    icon: <Star size={20} />,
    roleBadge: 'مدیر فروش',
  },
  yasteb: {
    // v2.35.0 — یاس طب: isolated company (تولید ست‌های ونتیلاتور). Fully
    // independent tenant outside the group aggregate; only its assigned
    // users ever land here.
    name: 'یاس طب',
    description: 'تولید ست‌های ونتیلاتور — شرکت مستقل (خارج از تجمیع گروه)',
    type: 'تولید ست‌های ونتیلاتور',
    typeEn: 'B2B',
    color: '#134E4A',
    accent: '#0D9488',
    icon: <Wind size={20} />,
    roleBadge: 'کارشناس فروش',
  },
};

const METHOD_LABELS: Record<string, string> = {
  phone: 'تلفن',
  visit: 'مراجعه حضوری',
  whatsapp: 'واتساپ',
  email: 'ایمیل',
};

const RESULT_LABELS: Record<string, string> = {
  ordered: 'سفارش ثبت شد',
  callback: 'تماس مجدد',
  not_available: 'در دسترس نبود',
  meeting_set: 'جلسه هماهنگ شد',
  sample_sent: 'نمونه ارسال شد',
  completed: 'تکمیل شد',
  rejected: 'عدم تمایل',
};

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: 'هفتگی',
  biweekly: 'دوهفته‌یکبار',
  monthly: 'ماهانه',
  bimonthly: 'دوماهانه',
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  overdue: { label: 'سررسید گذشته', color: '#dc2626', bg: '#fef2f2' },
  today: { label: 'امروز', color: '#d97706', bg: '#fffbeb' },
  upcoming: { label: 'آینده', color: '#2563eb', bg: '#eff6ff' },
  done: { label: 'انجام شده', color: '#059669', bg: '#ecfdf5' },
};

// ==================== HELPERS ====================
function toPersianNum(n: number | string): string {
  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (d) => persianDigits[parseInt(d)]);
}

function getStatusStyle(status: string) {
  return STATUS_CONFIG[status] || STATUS_CONFIG.upcoming;
}

// ==================== CANVAS PARTICLES ====================
function ParticleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // v2.26.0 — respects prefers-reduced-motion: one static frame instead
    // of an infinite rAF loop (the login screen stays calm for users who
    // asked the OS for reduced motion).
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let animFrame: number;
    const particles: { x: number; y: number; vx: number; vy: number; r: number }[] = [];
    const count = 60;
    const connectionDist = 120;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.6,
        vy: (Math.random() - 0.5) * 0.6,
        r: Math.random() * 2 + 1,
      });
    }

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < count; i++) {
        const p = particles[i];
        if (!reducedMotion) {
          p.x += p.vx;
          p.y += p.vy;
          if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
          if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(31, 139, 125, 0.5)';
        ctx.fill();

        for (let j = i + 1; j < count; j++) {
          const q = particles[j];
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < connectionDist) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.strokeStyle = `rgba(31, 139, 125, ${0.2 * (1 - dist / connectionDist)})`;
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }
      // Reduced-motion users get a single static frame — no loop.
      if (!reducedMotion) animFrame = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(animFrame);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />;
}

// ==================== LOGIN SCREEN ====================
function LoginScreen({ onLogin }: { onLogin: (user: UserData) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // v2.26.0 — silent-empty-field validation + password visibility toggle.
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const [showPassword, setShowPassword] = useState(false);
  // v2.31.4 — «فراموشی رمز عبور» recovery guide dialog (admin-mediated reset).
  const [showForgot, setShowForgot] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // No silent validation: empty fields get explicit Persian messages.
    const errs: typeof fieldErrors = {};
    if (!username.trim()) errs.username = 'نام کاربری را وارد کنید.';
    if (!password.trim()) errs.password = 'رمز عبور را وارد کنید.';
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', username: username.trim(), password }),
      });
      const data = await res.json();
      if (res.ok && data.user) {
        onLogin({
          id: data.user.id,
          displayName: data.user.displayName,
          role: data.user.role,
          roleLabel: data.user.roleLabel,
          jobTitle: data.user.jobTitle || null,
          accessibleCompanies: data.user.accessibleCompanies || [],
        });
      } else {
        setError(data.error || 'خطا در ورود');
      }
    } catch {
      setError('خطا در ارتباط با سرور');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center relative overflow-hidden animate-login-gradient"
      style={{
        background: 'linear-gradient(135deg, #0D0B1A 0%, #1A1640 40%, #2E2A5C 100%)',
      }}
    >
      <ParticleCanvas />

      {/* Ambient glows */}
      <div className="absolute top-1/4 right-1/4 w-96 h-96 rounded-full opacity-20 blur-3xl"
        style={{ background: 'radial-gradient(circle, #1F8B7D, transparent)' }}
      />
      <div className="absolute bottom-1/4 left-1/3 w-80 h-80 rounded-full opacity-15 blur-3xl"
        style={{ background: 'radial-gradient(circle, #4A235A, transparent)' }}
      />

      {/* v2.31.5 — LANDSCAPE SPLIT LAYOUT: promo panel (right side in
          RTL, lg+) + login form (left). Portrait keeps the previous
          centered design. Promo visual language is derived from the BGL
          logo: indigo/teal palette, the medical "+" cross motif, and
          rounded geometry. */}
      <div className="relative z-10 flex min-h-screen flex-col lg:flex-row">
        {/* ============ PROMO PANEL (landscape only) ============ */}
        <aside
          aria-label="معرفی امکانات سامانه"
          className="relative hidden flex-col justify-between gap-6 overflow-hidden p-8 lg:flex lg:w-[57%] xl:w-[59%] xl:p-10"
        >
          {/* Logo-inspired "+" cross pattern (subtle, decorative) */}
          <div
            aria-hidden
            className="absolute inset-0 opacity-[0.07]"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='34' height='34'%3E%3Cpath d='M17 11v12M11 17h12' stroke='%237DD3C8' stroke-width='1.3' stroke-linecap='round'/%3E%3C/svg%3E")`,
            }}
          />
          {/* Large ghost cross — the logo's signature symbol */}
          <svg
            aria-hidden
            viewBox="0 0 100 100"
            className="absolute -bottom-12 -right-8 h-72 w-72 text-teal-300 opacity-[0.06]"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
          >
            <path d="M50 18v64M18 50h64" />
          </svg>
          {/* Teal seam between the promo and form panels */}
          <div
            aria-hidden
            className="absolute inset-y-10 left-0 w-px bg-gradient-to-b from-transparent via-teal-400/40 to-transparent"
          />

          {/* Brand row — v2.31.6: official high-res holding logo (1500×930,
              pure-white background, sharper render) at ~40% larger scale,
              plus the holding's own tagline («The Future is Now...»)
              rendered in Persian beside the lockup. */}
          <div className="promo-enter promo-enter-1 relative z-10 flex items-center gap-4">
            <div className="rounded-2xl bg-white/95 px-4 py-3 shadow-2xl shadow-black/40">
              <img src="/logo-bgl.png" alt="لوگوی هلدینگ بهبود گستر (BGL)" className="w-28 h-auto object-contain" />
            </div>
            <div>
              <p className="text-base font-bold leading-7 text-white">هلدینگ بهبود گستر</p>
              <p className="text-xs text-teal-300/75">آینده، هم‌اکنون آغاز می‌شود</p>
            </div>
          </div>

          {/* Headline + capabilities grid */}
          <div className="relative z-10">
            <div className="promo-enter promo-enter-2 inline-flex items-center gap-2 rounded-full border border-teal-400/30 bg-teal-500/10 px-4 py-1.5 text-xs font-semibold text-teal-300">
              <Plus size={12} strokeWidth={3} aria-hidden />
              سامانه جامع مدیریت فروش هلدینگ BGL
            </div>
            <h2 className="promo-enter promo-enter-2 mt-3 text-xl font-extrabold leading-9 text-white xl:text-2xl">
              کل چرخهٔ فروش گروه، در <span className="text-teal-300">یک سامانهٔ فارسی</span>
            </h2>
            <p className="promo-enter promo-enter-2 mt-2 max-w-xl text-[13px] leading-7 text-gray-300/80">
              از پروندهٔ مراکز درمانی و اسناد فروش تا انبار، تولید، مالی و هوش مصنوعی فروش — برای هر سه شرکت گروه: تولید دستگاه، بازرگانی و فروش دستگاه و تجهیزات کمک تنفسی.
            </p>

            <div className="promo-enter promo-enter-3 mt-5 grid grid-cols-3 gap-3">
              {[
                { icon: FileText, title: 'سامانهٔ فروش یکپارچه', desc: 'کاریز فروش، پیش‌فاکتور، فاکتور و مرجوعی' },
                { icon: Sparkles, title: 'هوش مصنوعی فروش', desc: 'تحلیل تماس‌ها، مربی هوشمند، اقدام پیشنهادی' },
                { icon: Building2, title: 'مراکز و مشتریان', desc: 'پروندهٔ کامل مراکز درمانی و نقشهٔ جغرافیایی' },
                { icon: Boxes, title: 'انبار و تولید', desc: 'موجودی سری‌محور، حرکت کالا، سفارش تولید' },
                { icon: BarChart3, title: 'مالی و گزارش تلفیقی', desc: 'وصول مطالبات، تحلیل مالی، مقایسهٔ شرکت‌ها' },
                { icon: ShieldCheck, title: 'خدمات پس از فروش', desc: 'تیکت گارانتی، استعلام سریال، باشگاه مشتریان' },
              ].map((f) => (
                <div
                  key={f.title}
                  className="promo-feature flex items-start gap-2.5 rounded-xl border border-white/10 bg-white/[0.04] p-3 transition-colors hover:border-teal-400/40 hover:bg-white/[0.07]"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-teal-400/25 bg-teal-500/15 text-teal-300">
                    <f.icon size={15} aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-[12.5px] font-bold leading-5 text-white">{f.title}</h3>
                    <p className="mt-1 text-[11px] leading-5 text-gray-400">{f.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Stats — the "+" bullet echoes the logo motif */}
          <div className="promo-enter promo-enter-3 relative z-10 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] font-medium text-gray-200/90">
            <span className="flex items-center gap-1.5">
              <Plus size={11} strokeWidth={3} className="text-teal-300" aria-hidden />
              ۳ شرکت زیرمجموعه، یک سامانه
            </span>
            <span className="flex items-center gap-1.5">
              <Plus size={11} strokeWidth={3} className="text-teal-300" aria-hidden />
              ۲۰+ ماژول یکپارچه
            </span>
            <span className="flex items-center gap-1.5">
              <Plus size={11} strokeWidth={3} className="text-teal-300" aria-hidden />
              ۱۰۰٪ فارسی و راست‌چین
            </span>
          </div>
        </aside>

        {/* ============ FORM ============ */}
        <main className="relative z-10 flex flex-1 flex-col items-center justify-center gap-8 p-6">
          {/* Landscape caption */}
          <p className="hidden text-base font-bold text-teal-300/90 animate-fade-in lg:block">
            ورود کاربران سامانه
          </p>

          {/* Logo + title — portrait fallback (pre-v2.31.5 centered design) */}
          <div className="flex flex-col items-center gap-8 animate-fade-in-up lg:hidden">
            {/* Logo */}
            <div className="relative flex items-center justify-center w-32 h-32 mb-2">
              {/* Animated rings */}
              <div className="absolute inset-0 border-2 border-teal-400/30 rounded-full animate-ring-pulse" />
              <div className="absolute inset-[-8px] border border-teal-400/20 rounded-full animate-ring-pulse delay-500" />
              <div className="absolute inset-[-16px] border border-teal-400/10 rounded-full animate-ring-pulse delay-1000" />

              {/* Official BGL logo on white card (logo artwork is dark teal/navy) */}
              <div className="relative z-10 rounded-2xl bg-white/95 px-5 py-4 shadow-2xl shadow-black/40 animate-logo-fade">
                <img
                  src="/logo-bgl.png"
                  alt="لوگوی هلدینگ بهبود گستر (BGL)"
                  className="w-24 h-auto object-contain"
                />
              </div>
            </div>

            {/* Title */}
            <div className="text-center animate-logo-fade delay-300">
              <h1 className="text-2xl font-bold text-white mb-1">سامانه جامع مدیریت فروش هلدینگ BGL</h1>
              <p className="text-teal-300/70 text-sm">هلدینگ بهبود گستر</p>
            </div>
          </div>

        {/* Login Card */}
        <div className="glass rounded-2xl p-8 w-full max-w-sm animate-card-float">
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="login-username" className="block text-sm text-gray-300 mb-2">نام کاربری</label>
              <Input
                id="login-username"
                name="username"
                autoComplete="username"
                value={username}
                onChange={(e) => { setUsername(e.target.value); if (fieldErrors.username) setFieldErrors((p) => ({ ...p, username: undefined })); }}
                placeholder="نام کاربری خود را وارد کنید"
                aria-invalid={Boolean(fieldErrors.username)}
                className="bg-white/5 border-white/10 text-white placeholder:text-gray-500 focus:border-teal-400/50 h-11 rounded-xl"
                autoFocus
                dir="ltr"
              />
              {fieldErrors.username && (
                <p className="text-amber-300/90 text-xs mt-1.5" role="alert">{fieldErrors.username}</p>
              )}
            </div>
            <div>
              <label htmlFor="login-password" className="block text-sm text-gray-300 mb-2">رمز عبور</label>
              <div className="relative">
                <Input
                  id="login-password"
                  name="password"
                  autoComplete="current-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); if (fieldErrors.password) setFieldErrors((p) => ({ ...p, password: undefined })); }}
                  placeholder="رمز عبور"
                  aria-invalid={Boolean(fieldErrors.password)}
                  className="bg-white/5 border-white/10 text-white placeholder:text-gray-500 focus:border-teal-400/50 h-11 rounded-xl pl-11"
                  dir="ltr"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'پنهان کردن رمز عبور' : 'نمایش رمز عبور'}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200 transition-colors p-1"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {fieldErrors.password && (
                <p className="text-amber-300/90 text-xs mt-1.5" role="alert">{fieldErrors.password}</p>
              )}
            </div>

            {/* v2.31.4 — forgot-password link (admin-mediated recovery) */}
            <div className="flex justify-end -mt-2">
              <button
                type="button"
                onClick={() => setShowForgot(true)}
                className="text-xs text-teal-300/80 hover:text-teal-200 transition-colors"
              >
                فراموشی رمز عبور؟
              </button>
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-300 text-sm text-center animate-fade-in">
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="w-full h-11 rounded-xl text-white font-semibold transition-all duration-300 hover:opacity-90 hover:brightness-110 shadow-lg shadow-teal-500/25 hover:shadow-teal-400/35"
              style={{
                background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)',
              }}
            >
              {loading ? (
                <div className="flex items-center gap-2">
                  <RefreshCw size={16} className="animate-spin" />
                  <span>در حال ورود...</span>
                </div>
              ) : (
                'ورود به سامانه'
              )}
            </Button>
          </form>

          {/* v2.31.4 — forgot-password recovery guide (admin-mediated reset) */}
          <Dialog open={showForgot} onOpenChange={setShowForgot}>
            <DialogContent className="max-w-md rounded-2xl bg-[#171240] border-white/10 text-white shadow-2xl shadow-black/60">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-white text-base">
                  <span className="flex items-center justify-center w-8 h-8 rounded-full bg-teal-500/15 border border-teal-400/30">
                    <KeyRound size={15} className="text-teal-300" />
                  </span>
                  بازیابی رمز عبور
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4 text-sm leading-7 text-gray-300">
                <p>
                  برای حفظ امنیت حساب‌ها، بازیابی رمز عبور در این سامانه از طریق{' '}
                  <span className="text-teal-300 font-semibold">مدیر سیستم</span>{' '}
                  انجام می‌شود و نیازی به ایمیل یا پیامک ندارد.
                </p>
                <ol className="space-y-2.5">
                  <li className="flex items-start gap-2.5">
                    <span className="mt-1 flex-shrink-0 w-5 h-5 rounded-full bg-teal-500/15 border border-teal-400/30 text-[11px] font-bold text-teal-300 flex items-center justify-center">۱</span>
                    <span>نام کاربری خود را به مدیر سیستم اعلام کنید.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-1 flex-shrink-0 w-5 h-5 rounded-full bg-teal-500/15 border border-teal-400/30 text-[11px] font-bold text-teal-300 flex items-center justify-center">۲</span>
                    <span>مدیر از بخش «مدیریت کاربران» یک رمز جدید برای حساب شما تعیین می‌کند.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-1 flex-shrink-0 w-5 h-5 rounded-full bg-teal-500/15 border border-teal-400/30 text-[11px] font-bold text-teal-300 flex items-center justify-center">۳</span>
                    <span>مجدداً به همین صفحه برگردید و با رمز جدید وارد شوید.</span>
                  </li>
                </ol>
                {username.trim() && (
                  <div className="flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 text-xs">
                    <UserIcon size={14} className="text-teal-300 flex-shrink-0" />
                    <span className="text-gray-400">نام کاربری شما:</span>
                    <bdi dir="ltr" className="font-mono text-teal-200">{username.trim()}</bdi>
                    <span className="text-gray-500">— همین نام را به مدیر اعلام کنید.</span>
                  </div>
                )}
                <p className="text-xs text-gray-500 border-t border-white/10 pt-3 leading-6">
                  راهنمای مدیر سیستم: اگر رمز مدیر فراموش شده باشد، روی سرور از دستور{' '}
                  <code dir="ltr" className="font-mono text-gray-400 bg-white/5 rounded px-1.5 py-0.5">npm run reset:admin</code>{' '}
                  استفاده کنید.
                </p>
              </div>
            </DialogContent>
          </Dialog>

          <p className="text-center text-gray-500 text-xs mt-4">
            تمامی حقوق محفوظ است © هلدینگ بهبود گستر
          </p>
        </div>
        </main>
      </div>
    </div>
  );
}

// ==================== FOLLOW-UP SCREEN ====================
// v2.56.0 (round 81) — the r75 holding no-issuance defense-in-depth guard is
// RETIRED: the holding issues its own sales documents now (user round 81 —
// the royal-indigo proforma + the colorful BGL lockup), so the issuance UI
// (quick-proforma / sales-proformas / invoices / returns) mounts in the
// holding context exactly like every other company. The API layer accepts
// holding-stamped writes too (the issuer gates were removed with it).

function FollowupScreen({ activeCompany }: { activeCompany: CompanySlug }) {
  // v2.43.0 — REAL SMS reminder send from a followup row (was: nothing).
  const [smsOpen, setSmsOpen] = useState(false);
  // v2.26.0 — TWO datasets: `allFollowups` (unfiltered — drives the KPI
  // cards so the numbers stay truthful under any filter) and `followups`
  // (filtered — drives the table). Previously the KPIs were computed from
  // the filtered set, so switching to «امروز» silently rewrote every KPI.
  const [allFollowups, setAllFollowups] = useState<FollowupItem[]>([]);
  const [followups, setFollowups] = useState<FollowupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<FollowupStatus>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState('form');
  const [followupMethod, setFollowupMethod] = useState('phone');
  const [followupResult, setFollowupResult] = useState('');
  const [followupNote, setFollowupNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [setupForm, setSetupForm] = useState({ centerName: '', personName: '', phone: '', frequency: 'monthly', city: '' });
  const [newNoteText, setNewNoteText] = useState('');
  const [notes, setNotes] = useState<Array<{ id: string; text: string; createdAt: string }>>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteSubmitting, setNoteSubmitting] = useState(false);
  const [companies, setCompanies] = useState<CompanyData[]>([]);
  const [setupCompany, setSetupCompany] = useState('');
  const [setupSubmitting, setSetupSubmitting] = useState(false);

  // v2.26.0 — the old boolean-gate pattern (`followupsLoaded`) broke after
  // mutations: `setFollowupsLoaded(false)` when the flag was ALREADY false
  // produced no state change → the effect never re-ran → the list silently
  // kept stale data. loadFollowups is now a useCallback invoked directly
  // after every successful mutation.
  // v2.58.0 (audit 85-b): (1) request-sequence guard — out-of-order
  // responses can no longer render the previous query's rows; (2) the
  // search field keeps its own immediate value and only the DEBOUNCED
  // query drives loadFollowups — previously every keystroke fired a
  // request (plus a second unfiltered KPI request).
  const followupsSeqRef = useRef(0);
  const [searchInput, setSearchInput] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadFollowups = useCallback(async () => {
    const seq = ++followupsSeqRef.current;
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams();
      if (activeCompany !== 'holding') params.set('company', activeCompany);
      if (filterStatus !== 'all') params.set('status', filterStatus);
      if (search.trim()) params.set('search', search.trim());
      const res = await fetch(`/api/followups?${params.toString()}`);
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      if (seq !== followupsSeqRef.current) return; // stale response
      setFollowups(Array.isArray(data) ? data : []);
    } catch {
      if (seq !== followupsSeqRef.current) return;
      // A network failure must NOT masquerade as «موردی برای نمایش وجود
      // ندارد» — it gets its own error state with a retry action.
      setLoadError(true);
    } finally {
      if (seq === followupsSeqRef.current) setLoading(false);
    }
    // KPI dataset — always unfiltered for the active company
    try {
      const p2 = new URLSearchParams();
      if (activeCompany !== 'holding') p2.set('company', activeCompany);
      const res2 = await fetch(`/api/followups?${p2.toString()}`);
      if (res2.ok) {
        const d2 = await res2.json();
        if (seq === followupsSeqRef.current && Array.isArray(d2)) setAllFollowups(d2);
      }
    } catch { /* KPI keeps the previous snapshot on transient failure */ }
  }, [activeCompany, filterStatus, search]);

  // v2.58.0: debounced search commit (300ms) — one request per pause, not
  // per keystroke.
  const onSearchInput = (value: string) => {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => { setSearch(value); }, 300);
  };

  useEffect(() => {
    // Deferred via microtask — keeps the synchronous setLoading at the top
    // of loadFollowups out of the effect body (react-hooks/set-state-in-effect).
    queueMicrotask(() => { void loadFollowups(); });
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, [loadFollowups]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/companies');
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data)) {
          setCompanies(data);
          // v2.26.0 — the form's default company now follows the ACTIVE
          // company (priority: activeCompany → first permitted → first).
          // Previously it always defaulted to data[0], so a user working in
          // BGL was offered another company's name in the create dialog.
          const active = data.find((c: CompanyData) => c.slug === activeCompany);
          setSetupCompany(active?.id || data[0]?.id || '');
        }
      } catch { /* empty */ }
    };
    load();
    return () => { cancelled = true; };
  }, [activeCompany]);

  const selectedFollowup = followups.find((f) => f.id === selectedId);
  // Notes tab: load real notes when the tab opens or the selection changes
  // (v2.19.0 — replaced the placeholder card with the actual list).
  useEffect(() => {
    if (rightTab !== 'notes' || !selectedId) return;
    let cancelled = false;
    // Deferred via microtask — keeps the synchronous setState out of the
    // effect body (react-hooks/set-state-in-effect).
    queueMicrotask(async () => {
      setNotesLoading(true);
      try {
        const res = await fetch(`/api/followups/${selectedId}/notes`);
        const data = await res.json();
        if (!cancelled && Array.isArray(data.notes)) setNotes(data.notes);
      } catch {
        if (!cancelled) setNotes([]);
      }
      if (!cancelled) setNotesLoading(false);
    });
    return () => { cancelled = true; };
  }, [rightTab, selectedId]);

  // KPI cards read the UNFILTERED dataset (v2.26.0).
  const statsCounts = {
    overdue: allFollowups.filter((f) => f.status === 'overdue').length,
    today: allFollowups.filter((f) => f.status === 'today').length,
    upcoming: allFollowups.filter((f) => f.status === 'upcoming').length,
    done: allFollowups.filter((f) => f.status === 'done').length,
  };

  const handleFollowupSubmit = async () => {
    if (!selectedId || !followupMethod || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/followups/${selectedId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: followupMethod, result: followupResult || null, note: followupNote || null }),
      });
      // v2.26.0 — a failed submit used to silently do nothing; the user
      // got no feedback and the form kept pretending nothing happened.
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'ثبت پیگیری انجام نشد. لطفاً دوباره تلاش کنید.');
        return;
      }
      setFollowupMethod('phone');
      setFollowupResult('');
      setFollowupNote('');
      toast.success('پیگیری با موفقیت ثبت شد.');
      await loadFollowups();
    } catch {
      toast.error('ثبت پیگیری انجام نشد. لطفاً دوباره تلاش کنید.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddNote = async () => {
    if (!selectedId || !newNoteText.trim() || noteSubmitting) return;
    setNoteSubmitting(true);
    try {
      const res = await fetch(`/api/followups/${selectedId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: newNoteText.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'ثبت یادداشت انجام نشد. لطفاً دوباره تلاش کنید.');
        return;
      }
      const data = await res.json();
      if (data.note) setNotes((prev) => [data.note, ...prev]);
      setNewNoteText('');
      toast.success('یادداشت ثبت شد.');
      await loadFollowups();
    } catch {
      toast.error('ثبت یادداشت انجام نشد. لطفاً دوباره تلاش کنید.');
    } finally {
      setNoteSubmitting(false);
    }
  };

  const handleSetupSubmit = async () => {
    if (setupSubmitting) return;
    if (!setupForm.centerName.trim() || !setupForm.personName.trim() || !setupCompany) {
      toast.error('نام مرکز، نام شخص و شرکت را کامل کنید.');
      return;
    }
    setSetupSubmitting(true);
    try {
      const res = await fetch('/api/followups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...setupForm, companyId: setupCompany }),
      });
      // v2.26.0 — the dialog previously closed on ANY outcome (even a
      // 4xx/5xx), wiping the user's half-typed form. Now it only closes
      // after a confirmed 2xx; on failure it stays open with the data
      // intact and a Persian message.
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'ثبت پیگیری دوره‌ای انجام نشد. لطفاً دوباره تلاش کنید.');
        return;
      }
      setShowSetupModal(false);
      setSetupForm({ centerName: '', personName: '', phone: '', frequency: 'monthly', city: '' });
      toast.success('پیگیری دوره‌ای با موفقیت ثبت شد.');
      await loadFollowups();
    } catch {
      toast.error('ثبت پیگیری دوره‌ای انجام نشد. لطفاً دوباره تلاش کنید.');
    } finally {
      setSetupSubmitting(false);
    }
  };

  const filterTabs: { key: FollowupStatus; label: string }[] = [
    { key: 'all', label: 'همه' },
    { key: 'overdue', label: 'سررسید گذشته' },
    { key: 'today', label: 'امروز' },
    { key: 'upcoming', label: 'آینده' },
    { key: 'done', label: 'انجام شده' },
  ];

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-[calc(100vh-130px)]">
      {/* Left: List */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Stats bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {[
            { label: 'سررسید گذشته', count: statsCounts.overdue, color: '#dc2626', bg: '#fef2f2', icon: <AlertTriangle size={16} /> },
            { label: 'امروز', count: statsCounts.today, color: '#d97706', bg: '#fffbeb', icon: <Clock size={16} /> },
            { label: 'آینده', count: statsCounts.upcoming, color: '#2563eb', bg: '#eff6ff', icon: <Calendar size={16} /> },
            { label: 'کل', count: allFollowups.length, color: '#1F8B7D', bg: '#f0fdfa', icon: <Activity size={16} /> },
          ].map((s) => (
            <div key={s.label} className="rounded-xl p-4 border" style={{ background: s.bg, borderColor: `${s.color}20` }}>
              <div className="flex items-center gap-2 mb-1">
                <span style={{ color: s.color }}>{s.icon}</span>
                <span className="text-xs" style={{ color: s.color }}>{s.label}</span>
              </div>
              <div className="text-2xl font-bold" style={{ color: s.color }}>{toPersianNum(s.count)}</div>
            </div>
          ))}
        </div>

        {/* Search + filter */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="relative flex-1">
            <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              aria-label="جستجو"
              placeholder="جستجو در مرکز، شخص یا تلفن..."
              value={searchInput}
              onChange={(e) => onSearchInput(e.target.value)}
              className="pr-9 h-10 rounded-xl border-gray-200"
            />
          </div>
          <Dialog open={showSetupModal} onOpenChange={setShowSetupModal}>
            <DialogTrigger asChild>
              <Button className="h-10 rounded-xl gap-2 text-white" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                <Plus size={16} /> پیگیری جدید
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md" dir="rtl">
              <DialogHeader>
                <DialogTitle>ثبت پیگیری دوره‌ای جدید</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2">
                <div>
                  <label htmlFor="fu-company" className="block text-sm font-medium text-gray-700 mb-1.5">شرکت</label>
                  <select
                    id="fu-company"
                    value={setupCompany}
                    onChange={(e) => setSetupCompany(e.target.value)}
                    className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white"
                  >
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="fu-center" className="block text-sm font-medium text-gray-700 mb-1.5">نام مرکز</label>
                  <Input
                    id="fu-center"
                    value={setupForm.centerName}
                    onChange={(e) => setSetupForm({ ...setupForm, centerName: e.target.value })}
                    placeholder="نام مرکز یا شرکت"
                    className="h-10 rounded-lg"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="page-f735-1">نام شخص</label>
                    <Input id="page-f735-1"
                      value={setupForm.personName}
                      onChange={(e) => setSetupForm({ ...setupForm, personName: e.target.value })}
                      placeholder="نام و نام خانوادگی"
                      className="h-10 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="page-f744-2">تلفن</label>
                    <Input id="page-f744-2"
                      value={setupForm.phone}
                      onChange={(e) => setSetupForm({ ...setupForm, phone: e.target.value })}
                      placeholder="شماره تماس"
                      className="h-10 rounded-lg"
                      dir="ltr"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="page-f756-3">شهر</label>
                    <Input id="page-f756-3"
                      value={setupForm.city}
                      onChange={(e) => setSetupForm({ ...setupForm, city: e.target.value })}
                      placeholder="شهر"
                      className="h-10 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="page-f765-4">تناوب</label>
                    <select id="page-f765-4"
                      value={setupForm.frequency}
                      onChange={(e) => setSetupForm({ ...setupForm, frequency: e.target.value })}
                      className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white"
                    >
                      {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <Button
                  onClick={handleSetupSubmit}
                  disabled={setupSubmitting}
                  aria-busy={setupSubmitting}
                  className="w-full h-10 rounded-xl text-white gap-2"
                  style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
                >
                  {setupSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {setupSubmitting ? 'در حال ثبت...' : 'ثبت پیگیری دوره‌ای'}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilterStatus(tab.key)}
              className={`whitespace-nowrap px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 ${
                filterStatus === tab.key
                  ? 'text-white shadow-md'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
              style={filterStatus === tab.key ? { background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' } : undefined}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Followup cards */}
        <div className="flex-1 overflow-y-auto space-y-3 max-h-96 lg:max-h-none scrollbar-thin pr-1">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="bg-white rounded-xl p-4 border border-gray-100 animate-pulse">
                  <div className="flex gap-3">
                    <div className="w-10 h-10 rounded-lg bg-gray-200" />
                    <div className="flex-1 space-y-2">
                      <div className="w-3/4 h-4 rounded bg-gray-200" />
                      <div className="w-1/2 h-3 rounded bg-gray-100" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : loadError ? (
            // v2.26.0 — network failure gets its own state, never disguised
            // as an empty list
            <div className="text-center py-12 text-gray-500" role="alert">
              <AlertTriangle size={36} className="mx-auto mb-3 text-amber-500" />
              <p className="text-sm font-medium mb-1">دریافت اطلاعات با مشکل مواجه شد.</p>
              <p className="text-xs text-gray-400 mb-4">ارتباط با سرور برقرار نشد.</p>
              <Button variant="outline" onClick={() => void loadFollowups()} className="h-9 rounded-xl gap-2 text-xs">
                <RefreshCw size={13} /> تلاش مجدد
              </Button>
            </div>
          ) : followups.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <Target size={40} className="mx-auto mb-3 opacity-50" />
              <p className="text-sm font-medium text-gray-500 mb-1">
                {search.trim() || filterStatus !== 'all' ? 'پیگیری‌ای با این فیلترها یافت نشد' : 'هنوز پیگیری‌ای ثبت نشده است'}
              </p>
              <p className="text-xs">برای شروع، اولین پیگیری دوره‌ای را از دکمهٔ «پیگیری جدید» ثبت کنید.</p>
            </div>
          ) : (
            followups.map((f, i) => {
              const sc = getStatusStyle(f.status);
              return (
                <button
                  key={f.id}
                  onClick={() => { setSelectedId(f.id); setRightTab('form'); }}
                  className={`w-full text-right bg-white rounded-xl p-4 border transition-all duration-200 hover:shadow-md animate-fade-in-up opacity-0 ${selectedId === f.id ? 'ring-2 shadow-md' : 'border-gray-100'}`}
                  style={{ animationDelay: `${i * 40}ms`, ringColor: selectedId === f.id ? COMPANIES[activeCompany]?.accent || '#1F8B7D' : undefined } as React.CSSProperties}
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ background: `${sc.color}15` }}>
                      <Building2 size={18} style={{ color: sc.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold text-gray-900 truncate">{f.centerName}</span>
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium" style={{ background: sc.bg, color: sc.color }}>
                          {sc.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-gray-500">
                        <span className="flex items-center gap-1"><UserIcon size={12} />{f.personName}</span>
                        {f.city && <span className="flex items-center gap-1"><MapPin size={12} />{f.city}</span>}
                        <span className="flex items-center gap-1"><Phone size={12} />{f.phone || '-'}</span>
                      </div>
                      <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                        <span className="flex items-center gap-1"><Hash size={11} />{FREQUENCY_LABELS[f.frequency] || f.frequency}</span>
                        <span className="flex items-center gap-1"><MessageCircle size={11} />{toPersianNum(f.totalFollowups)} پیگیری</span>
                        {f.nextFollowupDate && (
                          <span className="flex items-center gap-1"><Calendar size={11} />{toPersianNum(toJalaliString(f.nextFollowupDate))}</span>
                        )}
                        {f.daysOverdue > 0 && (
                          <span className="text-red-500 font-medium">{toPersianNum(f.daysOverdue)} روز سررسید</span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right panel */}
      <div className="w-full lg:w-[420px] bg-white rounded-2xl border border-gray-100 shadow-sm flex flex-col max-h-[500px] lg:max-h-none">
        {selectedFollowup ? (
          <>
            {/* Header */}
            <div className="p-5 border-b border-gray-100">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-bold text-gray-900">{selectedFollowup.centerName}</h3>
                <div className="flex items-center gap-1">
                  {/* v2.43.0 — real SMS reminder to this contact */}
                  <button
                    onClick={() => setSmsOpen(true)}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-indigo-600 hover:bg-indigo-50 transition-colors"
                    title="ارسال پیامک یادآوری"
                    aria-label="ارسال پیامک یادآوری"
                  >
                    <MessageCircle size={15} />
                  </button>
                  <button onClick={() => setSelectedId(null)} className="text-gray-400 hover:text-gray-600">
                    <X size={18} />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <UserIcon size={14} /> {selectedFollowup.personName}
                {selectedFollowup.phone && <span>· {selectedFollowup.phone}</span>}
              </div>
            </div>

            {/* Tabs */}
            <Tabs value={rightTab} onValueChange={setRightTab} className="flex-1 flex flex-col min-h-0">
              <TabsList className="w-full grid grid-cols-3 rounded-none border-b bg-transparent p-0 h-auto">
                <TabsTrigger value="form" className="rounded-none border-b-2 border-transparent data-[state=active]:border-teal-500 data-[state=active]:bg-transparent data-[state=active]:shadow-none py-3 text-xs font-medium">
                  <Send size={14} className="ml-1" /> ثبت پیگیری
                </TabsTrigger>
                <TabsTrigger value="history" className="rounded-none border-b-2 border-transparent data-[state=active]:border-teal-500 data-[state=active]:bg-transparent data-[state=active]:shadow-none py-3 text-xs font-medium">
                  <Clock size={14} className="ml-1" /> تاریخچه
                </TabsTrigger>
                <TabsTrigger value="notes" className="rounded-none border-b-2 border-transparent data-[state=active]:border-teal-500 data-[state=active]:bg-transparent data-[state=active]:shadow-none py-3 text-xs font-medium">
                  <StickyNote size={14} className="ml-1" /> یادداشت‌ها
                </TabsTrigger>
              </TabsList>

              <TabsContent value="form" className="flex-1 overflow-y-auto p-5 mt-0">
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">روش تماس</label>
                    <div className="grid grid-cols-2 gap-2">
                      {Object.entries(METHOD_LABELS).map(([key, label]) => (
                        <button
                          key={key}
                          onClick={() => setFollowupMethod(key)}
                          className={`px-3 py-2.5 rounded-xl text-sm font-medium border transition-all duration-200 ${
                            followupMethod === key
                              ? 'text-white shadow-md'
                              : 'bg-gray-50 text-gray-600 border-gray-200 hover:border-gray-300'
                          }`}
                          style={followupMethod === key ? { background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' } : undefined}
                        >
                          {key === 'phone' && <Phone size={14} className="inline ml-1" />}
                          {key === 'visit' && <MapPin size={14} className="inline ml-1" />}
                          {key === 'whatsapp' && <MessageCircle size={14} className="inline ml-1" />}
                          {key === 'email' && <Mail size={14} className="inline ml-1" />}
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="page-f949-5">نتیجه</label>
                    <select id="page-f949-5"
                      value={followupResult}
                      onChange={(e) => setFollowupResult(e.target.value)}
                      className="w-full h-10 rounded-xl border border-gray-200 px-3 text-sm bg-white"
                    >
                      <option value="">انتخاب کنید...</option>
                      {Object.entries(RESULT_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="page-f963-6">توضیحات</label>
                    <Textarea id="page-f963-6"
                      value={followupNote}
                      onChange={(e) => setFollowupNote(e.target.value)}
                      placeholder="یادداشت پیگیری..."
                      className="rounded-xl border-gray-200 resize-none"
                      rows={4}
                    />
                  </div>

                  <Button
                    onClick={handleFollowupSubmit}
                    disabled={submitting}
                    className="w-full h-11 rounded-xl text-white font-semibold gap-2"
                    style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
                  >
                    {submitting ? <RefreshCw size={16} className="animate-spin" /> : <Check size={16} />}
                    ثبت پیگیری
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="history" className="flex-1 overflow-y-auto p-5 mt-0">
                {selectedFollowup.history.length === 0 ? (
                  <div className="text-center py-8 text-gray-400">
                    <Clock size={32} className="mx-auto mb-2 opacity-50" />
                    <p className="text-sm">تاریخچه‌ای ثبت نشده</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {selectedFollowup.history.map((h, i) => (
                      <div key={h.id} className="border border-gray-100 rounded-xl p-4 animate-fade-in opacity-0" style={{ animationDelay: `${i * 60}ms` }}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-teal-50 text-teal-700">
                            {METHOD_LABELS[h.method] || h.method}
                          </span>
                          <span className="text-xs text-gray-400" dir="ltr">{toPersianNum(toJalaliString(h.createdAt))}</span>
                        </div>
                        {h.result && (
                          <div className="text-sm text-gray-700 mb-1">
                            <span className="text-gray-500">نتیجه: </span>
                            {RESULT_LABELS[h.result] || h.result}
                          </div>
                        )}
                        {h.note && (
                          <div className="text-sm text-gray-600 bg-gray-50 rounded-lg p-2 mt-2">{h.note}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="notes" className="flex-1 flex flex-col min-h-0 mt-0">
                <div className="flex-1 overflow-y-auto p-5">
                  {notesLoading ? (
                    <div className="text-center py-8 text-gray-400">
                      <RefreshCw size={24} className="mx-auto mb-2 opacity-50 animate-spin" />
                      <p className="text-sm">در حال بارگذاری یادداشت‌ها...</p>
                    </div>
                  ) : notes.length === 0 ? (
                    <div className="text-center py-8 text-gray-400">
                      <StickyNote size={32} className="mx-auto mb-2 opacity-50" />
                      <p className="text-sm">یادداشتی ثبت نشده</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {notes.map((note) => (
                        <div key={note.id} className="bg-amber-50/70 border border-amber-100 rounded-lg p-3 text-sm text-amber-900">
                          <p className="leading-7 text-amber-800">{note.text}</p>
                          <p className="text-[11px] text-amber-500 mt-1.5">{toJalaliString(note.createdAt)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="p-4 border-t border-gray-100">
                  <div className="flex gap-2">
                    <Input
                      value={newNoteText}
                      onChange={(e) => setNewNoteText(e.target.value)}
                      placeholder="یادداشت جدید..."
                      aria-label="یادداشت جدید"
                      className="flex-1 h-10 rounded-xl border-gray-200"
                      onKeyDown={(e) => e.key === 'Enter' && handleAddNote()}
                    />
                    <Button onClick={handleAddNote} size="icon" aria-label="ارسال یادداشت" disabled={noteSubmitting} className="h-10 w-10 rounded-xl shrink-0 text-white" style={{ background: '#1F8B7D' }}>
                      {noteSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    </Button>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-center text-gray-400">
              <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3">
                <Target size={28} className="text-gray-300" />
              </div>
              <p className="text-sm">یک پیگیری را از لیست انتخاب کنید</p>
            </div>
          </div>
        )}
      </div>
      {/* v2.43.0 — real SMS reminder (provider-backed, logged in SmsLog) */}
      <SmsDialog
        open={smsOpen}
        onOpenChange={setSmsOpen}
        presetPhone={selectedFollowup?.phone || ''}
        presetText={
          selectedFollowup
            ? buildFollowupReminderSms({
                centerName: selectedFollowup.centerName,
                personName: selectedFollowup.personName,
                companyName: 'کارشناس پیگیری',
              })
            : ''
        }
        contextType="followup"
        centerName={selectedFollowup?.centerName || null}
        contextLabel={selectedFollowup ? `پیگیری دوره‌ای — ${selectedFollowup.centerName} (${selectedFollowup.personName})` : undefined}
      />
    </div>
  );
}

// ==================== DASHBOARD SCREEN ====================
// v2.26.0 — the shell was rebuilt around four invariants:
//  1. NAV GUARD — the current module is re-validated against the new
//     company's menu every time activeCompany changes (or the access
//     matrix arrives); an invalid module falls back to «dashboard» or
//     the first allowed key — never a blank screen, never the previous
//     tenant's module.
//  2. URL-AWARE NAV — ?company=&module= is mirrored into pushState, so
//     Back / Forward / Refresh / Bookmark / Deep-link all work without
//     rewriting the app into real routes (low-risk query-based approach).
//  3. ONE AUTH SOURCE — the user object flows down from HomePage; the
//     duplicate /api/auth check (and its permission flicker) is gone.
//  4. ONE MAIL POLLER — the unread count is polled here once and shared
//     with the sidebar badge and the topbar mail indicator (previously
//     three independent 60s pollers ran in parallel).
function DashboardScreen({
  activeCompany,
  onCompanyChange,
  user,
}: {
  activeCompany: CompanySlug;
  onCompanyChange: (s: CompanySlug) => void;
  user: UserData | null;
}) {
  const [nav, setNav] = useState<string>('sales-expert');
  const [navFocus, setNavFocus] = useState<NavFocus | null>(null);
  const [menuAccess, setMenuAccess] = useState<MenuAccessMatrix | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [companySwitching, setCompanySwitching] = useState(false);

  // — Access resolution (same pipeline the sidebar uses) —
  const visibleKeys = useMemo(() => {
    const allowedKeys = user
      ? resolveAllowedKeys(activeCompany, user.jobTitle, user.role || 'standard', menuAccess)
      : null;
    const items = filterMenuByAccess(COMPANY_MENUS[activeCompany] || [], allowedKeys);
    const keys = new Set<string>();
    for (const it of items) {
      keys.add(it.key);
      if (it.children) for (const c of it.children) keys.add(c.key);
    }
    return keys;
  }, [activeCompany, user, menuAccess]);

  // — Admin-customizable per-company × per-job-title matrix (single fetch) —
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get-menu-config' }),
        });
        const data = await res.json();
        if (!cancelled && res.ok) setMenuAccess(data.menuAccess || {});
      } catch { /* built-in defaults apply */ }
    })();
    return () => { cancelled = true; };
  }, [user]);

  // — Single shared unread-mail poller (60s) —
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const fetchUnread = async () => {
      try {
        const res = await fetch('/api/mail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unread-count' }),
        });
        const data = await res.json();
        if (!cancelled && res.ok) setUnreadCount(data.count || 0);
      } catch { /* ignore */ }
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [user]);

  // — NAV GUARD (PHASE 1), render-time: the effective module is derived
  // from the SAME key set the sidebar resolves. An invalid module (stale
  // after a company switch, revoked access, or a hand-crafted deep link)
  // renders the fallback view in the very same render — no flash of the
  // previous tenant's module, no blank screen, no cascading setState.
  const effectiveNav = useMemo(() => {
    // v2.34.8 — پروندهٔ مرکز: a full PAGE, not a sidebar menu item. It is
    // reached from the centers list / global-search deep links. Every API
    // the dossier calls is tenant- AND permission-gated server-side, so a
    // hand-crafted ?module=center-dossier URL can never read another
    // tenant's records — the page itself degrades to «مرکز یافت نشد».
    if (nav === 'center-dossier') return 'center-dossier';
    if (visibleKeys.size === 0) return nav;
    if (visibleKeys.has(nav)) return nav;
    if (visibleKeys.has('dashboard')) return 'dashboard';
    if (visibleKeys.has('sales-expert')) return 'sales-expert';
    return [...visibleKeys][0];
  }, [visibleKeys, nav]);

  // — Short, calm transition indicator on company switch —
  useEffect(() => {
    queueMicrotask(() => setCompanySwitching(true));
    const t = setTimeout(() => setCompanySwitching(false), 450);
    return () => clearTimeout(t);
  }, [activeCompany]);

  const company = COMPANIES[activeCompany];

  const handleLogout = async () => {
    // v2.58.0 (audit 85-b): a network throw used to abort the reload with
    // no feedback — the cookie may already be cleared server-side anyway,
    // so always land back on the login screen.
    try {
      await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logout' }),
      });
    } catch { /* session revoke is best-effort; reload still runs */ }
    window.location.reload();
  };

  // v2.34.6 — exit impersonation: revoke the borrowed session, return to admin
  const handleImpersonationExit = async () => {
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'impersonate-exit' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'خروج از حالت مشاهده ناموفق بود — از خروج معمولی استفاده کنید');
        return;
      }
      window.location.reload();
    } catch {
      toast.error('خطای شبکه — دوباره تلاش کنید');
    }
  };

  // — URL <-> state sync (query-based navigation, PHASE 16) —
  const syncUrl = useCallback((companySlug: string, module: string, replace = false, focus?: NavFocus) => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('company', companySlug);
      url.searchParams.set('module', module);
      // v2.34.0 — focus is part of the real URL (spec §9): person/center/
      // document deep-links survive Refresh / Back / Forward / new tab.
      if (focus) url.searchParams.set('focus', [focus.type, focus.id, focus.label ?? ''].filter(Boolean).map(encodeURIComponent).join(':'));
      else url.searchParams.delete('focus');
      if (replace) window.history.replaceState({ company: companySlug, module, focus }, '', url.toString());
      else window.history.pushState({ company: companySlug, module, focus }, '', url.toString());
    } catch { /* URL manipulation is best-effort — never block navigation */ }
  }, []);

  // Deep link entry: honor ?company=&module= once on mount (validated by
  // the render-time guard above and the parent's access checks).
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const url = new URL(window.location.href);
        const c = url.searchParams.get('company');
        const m = url.searchParams.get('module');
        if (c && ['holding', 'bazargani', 'aria', 'bgl', 'yasteb'].includes(c) && c !== activeCompany) {
          onCompanyChange(c as CompanySlug);
        }
        if (m) setNav(normalizeNavKey(m));
        const f = url.searchParams.get('focus');
        if (f) {
          const [type, id, label] = f.split(':').map(decodeURIComponent);
          if (type && id && ['person', 'center', 'product', 'document'].includes(type)) {
            setNavFocus({ type: type as NavFocus['type'], id, label: label || undefined });
          }
        } else {
          setNavFocus(null);
        }
      } catch { /* ignore malformed URLs */ }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back / Forward: follow the URL back into state.
  useEffect(() => {
    const onPop = () => {
      try {
        const url = new URL(window.location.href);
        const c = url.searchParams.get('company');
        const m = url.searchParams.get('module');
        if (c && ['holding', 'bazargani', 'aria', 'bgl', 'yasteb'].includes(c) && c !== activeCompany) {
          onCompanyChange(c as CompanySlug);
        }
        if (m) {
          setNav(normalizeNavKey(m)); // guard effect validates against the new company
        }
        const f = url.searchParams.get('focus');
        if (f) {
          const [type, id, label] = f.split(':').map(decodeURIComponent);
          if (type && id && ['person', 'center', 'product', 'document'].includes(type)) {
            setNavFocus({ type: type as NavFocus['type'], id, label: label || undefined });
          }
        } else {
          setNavFocus(null);
        }
      } catch { /* ignore */ }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [activeCompany, onCompanyChange]);

  const handleNavChange = useCallback((key: string, focus?: NavFocus) => {
    setNav(key);
    setNavFocus(focus ?? null);
    syncUrl(activeCompany, key, false, focus);
  }, [activeCompany, syncUrl]);

  const handleCompanyChange = useCallback((slug: CompanySlug) => {
    onCompanyChange(slug);
    // v2.31.13 — «داشبور آریا بیاد» (round 42): switching company now lands
    // on that company's report dashboard (داشبورد مدیریت) — the natural
    // overview of the tenant just entered, instead of silently staying on
    // «داشبورد من». The render-time NAV GUARD above falls back to
    // «داشبورد من» for roles without dashboard access (e.g. sales experts),
    // so restricted users keep their personal view — nothing breaks.
    setNav('dashboard');
    syncUrl(slug, 'dashboard');
  }, [onCompanyChange, syncUrl]);

  return (
    <Sidebar
      activeCompany={activeCompany}
      onCompanyChange={handleCompanyChange}
      activeNav={nav}
      onNavChange={handleNavChange}
      user={user ? { displayName: user.displayName, roleLabel: user.roleLabel, role: user.role, jobTitle: user.jobTitle || null, accessibleCompanies: user.accessibleCompanies } : null}
      onLogout={handleLogout}
      menuAccess={menuAccess}
      unreadCount={unreadCount}
    >
      {/* v2.34.6 — impersonation banner: impossible to miss while the admin
          operates inside another user's account; one click returns to admin. */}
      {user?.impersonating && (
        <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 flex flex-wrap items-center gap-2 text-xs text-amber-900 sticky top-0 z-40 shadow-sm">
          <span className="font-extrabold">👁 در حال مشاهدهٔ حساب «{user.displayName}»</span>
          <span className="text-amber-700">— ورود اضطراری توسط {user.impersonating.byName}؛ همهٔ اقدامات در گزارش ممیزی ثبت می‌شود.</span>
          <button
            onClick={handleImpersonationExit}
            className="mr-auto h-8 px-3 rounded-lg bg-amber-600 text-white text-[11px] font-bold hover:bg-amber-700 transition-colors"
          >
            بازگشت به حساب مدیر
          </button>
        </div>
      )}
      {/* Company visual context strip during a switch — subtle, calm, short. */}
      {companySwitching && (
        <div className="fixed top-0 right-0 left-0 h-[3px] z-[60] overflow-hidden" aria-hidden="true">
          <div className="h-full w-1/3 animate-company-switch-bar" style={{ background: `linear-gradient(90deg, transparent, ${company.accent}, transparent)` }} />
        </div>
      )}
      {/* key={activeCompany} — every company-dependent state is invalidated
          on switch: the whole module subtree remounts and refetches its own
          scoped data, so nothing from the previous tenant survives on screen. */}
      <AccessProvider
        activeCompany={activeCompany}
        jobTitle={user?.jobTitle}
        role={user?.role}
        menuAccess={menuAccess}
      >
        <main key={activeCompany} className="p-4 lg:p-6 max-w-7xl mx-auto bg-gray-50 min-h-[calc(100vh-56px)]">
          {effectiveNav === 'sales-expert' ? (
            // v2.18.0 — the dashboard's quick actions were dead: onNavigate was
            // never passed, so all four buttons (سفارش جدید / پیگیری جدید /
            // ثبت مراجعه / ارسال پیش‌فاکتور) silently did nothing.
            <SalesExpertDashboard
              userName={user?.displayName}
              onNavigate={(key) => {
                const map: Record<string, string> = {
                  'new-order': 'sales-proformas',
                  'new-followup': 'followup',
                  'log-visit': 'visits',
                  'send-quote': 'sales-proformas',
                };
                handleNavChange(map[key] || key);
              }}
            />
          ) : effectiveNav === 'quick-activity' ? (
            // v2.34.0 — spec §10: one click from the menu to the FULL form
            <QuickActivityScreen />
          ) : effectiveNav === 'quick-proforma' ? (
            // v2.34.9 — the quick proforma is a DEDICATED SPACIOUS FULL PAGE
            // (round 56: «صفحه اون خیلی جمع شده و باز تر بشه») — the old
            // auto-opened modal is retired from this route (the dialog stays
            // available inside the sales-documents module). ?module=quick-proforma
            // remains a real URL (Refresh re-opens the page).
            // v2.56.0 (r81) — the holding context mounts it too (issuance
            // unlocked — its proforma prints the royal-indigo template).
            <QuickProformaScreen
              userDisplayName={user?.displayName}
              activeCompanySlug={activeCompany}
              onViewDocs={() => handleNavChange('sales-proformas')}
            />
          ) : effectiveNav === 'mailbox' ? (
            <Mailbox activeTab="inbox" />
          ) : effectiveNav === 'calendar' ? (
            <SalesCalendar />
          ) : effectiveNav.startsWith('ai-') ? (
            // v2.27.0 — AI Sales Intelligence: route keys ai-dashboard |
            // ai-calls | ai-actions | ai-coaching | ai-playbook | ai-settings.
            // Internal tab visibility is re-checked against the same access
            // resolution the sidebar uses (see ai-sales.tsx).
            <AiSales
              key={nav}
              activeTab={effectiveNav}
              activeCompany={activeCompany}
              userRole={user?.role}
            />
          ) : effectiveNav.startsWith('calls') ? (
            // v2.22.0 — key={nav}: sibling sub-tab navigation used to be dead
            // (every tabbed component reads activeTab only at mount; clicking
            // another sub-tab in the sidebar while the module was mounted did
            // nothing). The key remounts on nav change so the tab initialises
            // to the requested view.
            <SalesCalls key={nav} activeTab={effectiveNav === 'calls-history' ? 'history' : effectiveNav === 'calls-scheduled' ? 'scheduled' : 'log'} />
          ) : effectiveNav === 'center-dossier' ? (
            // v2.34.8 — پروندهٔ اختصاصی مرکز: the dedicated full page that
            // replaces the old detail POPUP. Deep-linkable via
            // ?module=center-dossier&focus=center:ID (Refresh/Back/Bookmark
            // all work); Back returns to the first centers module the user
            // can see (deep-links can land users without centers-list here).
            <CenterDossier
              key={navFocus?.id || 'none'}
              centerId={navFocus?.type === 'center' ? navFocus.id : undefined}
              onBack={() => {
                const backKey = [...visibleKeys].find((k) => k.startsWith('centers')) || 'dashboard';
                handleNavChange(backKey);
              }}
            />
          ) : effectiveNav.startsWith('centers') ? (
            // v2.26.0 — explicit, complete menu→tab mapping (territory →
            // geographic zoning view; contracts → the contracts tab).
            <SalesCenters
              key={nav}
              activeTab={
                effectiveNav === 'centers-contacts' ? 'contacts'
                  : effectiveNav === 'centers-individuals' ? 'individuals'
                  : effectiveNav === 'centers-cats' ? 'categories'
                  : effectiveNav === 'centers-map' || effectiveNav === 'centers-territory' ? 'map'
                  : effectiveNav === 'centers-contracts' ? 'contracts'
                  : 'list'
              }
              focusEntityId={navFocus?.type === 'center' ? navFocus.id : undefined}
              focusPersonId={navFocus?.type === 'person' ? navFocus.id : undefined}
              // v2.34.8 — clicking a center now opens its DEDICATED PAGE
              // (پروندهٔ مرکز), not the old popup.
              onOpenDossier={(id, name) => handleNavChange('center-dossier', { type: 'center', id, label: name })}
            />
          ) : effectiveNav === 'loyalty' ? (
            <CustomerClub />
          ) : effectiveNav === 'partner-pricing' ? (
            <PartnerPricing />
          ) : effectiveNav.startsWith('aftersales') ? (
            <AfterSales key={nav} activeTab={nav} />
          ) : effectiveNav === 'sales-system-stages' ? (
            <SalesPipeline />
          ) : effectiveNav.startsWith('products') ? (
            <SalesProducts key={nav} activeTab={effectiveNav === 'products-specs' ? 'specs' : effectiveNav === 'products-cats' ? 'categories' : 'list'} focusProductId={navFocus?.type === 'product' ? navFocus.id : undefined} />
          ) : effectiveNav.startsWith('sales-') || effectiveNav === 'sales-docs' ? (
            // v2.56.0 (r81) — the holding context mounts the sales-documents
            // workspaces too (the r75 no-issuance guard is retired with the
            // API gates — the holding's proforma prints its own letterhead).
            <SalesDocs
                key={nav}
                activeTab={effectiveNav === 'sales-invoices' ? 'invoices' : effectiveNav === 'sales-checks' ? 'checks' : effectiveNav === 'sales-returns' ? 'returns' : 'proformas'}
                initialSearch={navFocus?.type === 'document' ? navFocus.label : undefined}
                // v2.31.9 — Lian proforma form: prefills «کارشناس فروش» with
                // the signed-in user and the seller card with the sidebar's
                // active company (until a buyer/center is picked).
                userDisplayName={user?.displayName}
                activeCompanySlug={activeCompany}
              />
          ) : effectiveNav === 'reports-center' ? (
            // v2.51.0 (r76) — the professional performance report center gets
            // its own page (charts + KPIs + PDF export), routed BEFORE the
            // generic reports-* branch so 'center' never falls into the
            // legacy sales-reports tab switch.
            <ReportsCenter key={effectiveNav} />
          ) : effectiveNav.startsWith('reports') ? (
            <SalesReports key={nav} activeTab={nav.replace('reports-', '')} />
          ) : effectiveNav === 'collections' ? (
            <SalesCollections />
          ) : effectiveNav.startsWith('inventory') ? (
            <SalesInventory
              key={nav}
              activeTab={effectiveNav === 'inventory-movements' ? 'movements' : effectiveNav === 'inventory-hesabfa' ? 'hesabfa' : 'stock'}
              companySlug={activeCompany}
              isAdmin={user?.role === 'admin'}
            />
          ) : effectiveNav === 'visits' ? (
            <SalesVisits />
          ) : effectiveNav.startsWith('production') ? (
            <SalesProduction key={nav} activeTab={effectiveNav === 'production-ship' ? 'shipments' : 'orders'} />
          ) : effectiveNav === 'users' ? (
            <SalesUsers />
          ) : effectiveNav.startsWith('settings') ? (
            <SalesSettings key={nav} activeTab={nav.replace('settings-', '')} />
          ) : effectiveNav === 'dashboard' ? (
            activeCompany === 'holding' ? (
              <HoldingDashboard />
            ) : (
              <CompanyReportDashboard
                companySlug={activeCompany as 'bazargani' | 'aria' | 'bgl'}
                companyName={company.name}
                companyType={company.type}
                color={company.color}
                accent={company.accent}
              />
            )
          ) : (
            <FollowupScreen activeCompany={activeCompany} />
          )}
        </main>
      </AccessProvider>
    </Sidebar>
  );
}

// ==================== MAIN PAGE ====================
export default function HomePage() {
  // v2.26.0 — «checking» initial state: a minimal branded splash renders
  // while the session is verified, so returning users never see the login
  // form flash before the dashboard takes over.
  const [screen, setScreen] = useState<Screen>('checking');
  const [activeCompany, setActiveCompany] = useState<CompanySlug>('holding');
  const [user, setUser] = useState<UserData | null>(null);

  useEffect(() => {
    // Check existing session
    const checkSession = async () => {
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'check' }),
        });
        const data = await res.json();
        if (data.authenticated && data.user) {
          const userData: UserData = {
            id: data.user.id,
            username: data.user.username,
            displayName: data.user.displayName,
            role: data.user.role,
            roleLabel: data.user.roleLabel,
            jobTitle: data.user.jobTitle || null,
            accessibleCompanies: data.user.accessibleCompanies || [],
            impersonating: data.impersonating || null,
          };
          setUser(userData);
          setScreen('dashboard');
          // Non-admin: set first accessible company
          if (data.user.role !== 'admin' && userData.accessibleCompanies.length > 0) {
            setActiveCompany(userData.accessibleCompanies[0] as CompanySlug);
          }
        } else {
          setScreen('login');
        }
      } catch {
        // Network failure → fail-safe to login (the form shows its own
        // server error when the user actually tries to submit).
        setScreen('login');
      }
    };
    checkSession();
  }, []);

  const handleLogin = (u: UserData) => {
    setUser(u);
    setScreen('dashboard');
    // Non-admin users start at their first accessible company
    if (u.role !== 'admin' && u.accessibleCompanies.length > 0) {
      setActiveCompany(u.accessibleCompanies[0] as CompanySlug);
    }
  };

  const handleCompanyChange = (slug: CompanySlug) => {
    // Only admin can access holding
    if (slug === 'holding' && user?.role !== 'admin') return;
    // v2.35.0 — isolated companies (یاس طب) are reserved for their
    // assigned users; group admins can never enter the isolated view.
    if (ISOLATED_SLUGS.has(slug) && user?.role === 'admin') return;
    // Check company access for non-admin users
    if (user && user.role !== 'admin' && user.accessibleCompanies.length > 0) {
      if (!user.accessibleCompanies.includes(slug)) return;
    }
    setActiveCompany(slug);
  };

  if (screen === 'checking') {
    // Minimal splash — no layout shift, branded, calm.
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4" data-testid="app-splash">
        <div className="w-14 h-14 rounded-2xl bg-white shadow-lg shadow-black/5 px-3 py-2 flex items-center justify-center">
          <img src="/logo-bgl.png" alt="لوگوی هلدینگ بهبود گستر (BGL)" className="w-full h-full object-contain" />
        </div>
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <Loader2 size={14} className="animate-spin" />
          در حال بررسی نشست...
        </div>
      </div>
    );
  }

  if (screen === 'login') {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return <DashboardScreen activeCompany={activeCompany} onCompanyChange={handleCompanyChange} user={user} />;
}
