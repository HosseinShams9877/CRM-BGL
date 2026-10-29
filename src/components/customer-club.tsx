'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CUSTOMER_TYPE_LABELS, SEGMENT_LABELS, LOYALTY_REASON_LABELS } from '@/lib/business-model';
import { Search, Trophy, Gift, TrendingUp, Award, Plus, Minus, Building2, UserRound, ThumbsUp, ThumbsDown, Wallet, RefreshCw, Loader2 } from 'lucide-react';
// v2.35.1 (round 61) — keyboard-layout auto-fix (client-side filter twins)
import { searchVariants } from '@/lib/keyboard-layout';

// ════════════════════════════════════════════════════════════════
//  CUSTOMER CLUB — باشگاه مشتریان (آریا B2C + BGL ترکیبی)
//  گزارش مشتریان برتر (بیشترین خرید، بیشترین تناوب، وفادارترین)
//  + دفتر امتیازها + امتیازدهی دستی + وضعیت خوش‌حسابی
// ════════════════════════════════════════════════════════════════

function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد تومان';
  if (amount >= 1_000_000) return toPersianNum(Math.round(amount / 1_000_000).toLocaleString()) + ' میلیون تومان';
  return toPersianNum(amount.toLocaleString()) + ' تومان';
}

interface ClubCustomer {
  centerId: string;
  name: string;
  province: string;
  city: string;
  mobile: string;
  customerType: string;
  segment: string;
  loyaltyPoints: number;
  paymentBehavior: string;
  creditScore: number;
  totalAmount: number;
  purchaseCount: number;
  lastPurchase: string | null;
  daysSinceLastPurchase: number | null;
  loyaltyIndex: number;
  avgPurchase: number;
}

interface ClubData {
  byAmount: ClubCustomer[];
  byFrequency: ClubCustomer[];
  byLoyalty: ClubCustomer[];
  goodPayers: ClubCustomer[];
  badPayers: ClubCustomer[];
  summary: {
    totalCustomers: number;
    activeBuyers: number;
    totalPoints: number;
    goodPayers: number;
    badPayers: number;
    individuals: number;
    organizations: number;
  };
}

interface LoyaltyTransaction {
  id: string;
  centerId: string;
  points: number;
  reason: string;
  note: string;
  documentNumber: string | null;
  createdByName: string | null;
  createdAt: string;
  center?: { id: string; name: string; customerType?: string };
}

type ClubView = 'top' | 'points' | 'behavior';

// ── Point adjustment dialog ──
function PointsDialog({ customer, open, onOpenChange, onDone }: {
  customer: ClubCustomer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'add' | 'redeem'>('add');
  const [points, setPoints] = useState('10');
  const [reason, setReason] = useState('manual');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      // Reset the form asynchronously so the effect body itself stays free of
      // synchronous setState (react-hooks/set-state-in-effect).
      queueMicrotask(() => {
        setMode('add');
        setPoints('10');
        setReason('manual');
        setNote('');
      });
    }
  }, [open, customer]);

  const submit = async () => {
    if (!customer) return;
    const p = Math.round(Number(points));
    if (!Number.isFinite(p) || p <= 0) {
      toast.error('امتیاز باید عددی مثبت باشد');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/loyalty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add-points',
          centerId: customer.centerId,
          points: mode === 'add' ? p : -p,
          reason: mode === 'add' ? reason : 'redeem',
          note: note || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت امتیاز');
      toast.success(data.message || 'امتیاز ثبت شد');
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در ثبت امتیاز');
    } finally {
      setBusy(false);
    }
  };

  if (!customer) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gift size={18} className="text-amber-500" />
            مدیریت امتیاز — {customer.name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div className="bg-amber-50 rounded-xl p-3 text-center">
            <p className="text-2xl font-bold text-amber-600">{toPersianNum(customer.loyaltyPoints)}</p>
            <p className="text-[11px] text-gray-500 mt-0.5">امتیاز فعلی باشگاه مشتریان</p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setMode('add')}
              className={`h-11 rounded-xl border text-sm font-medium transition-colors flex items-center justify-center gap-1.5 ${mode === 'add' ? 'border-green-300 bg-green-50 text-green-700' : 'border-gray-200 bg-white text-gray-500'}`}>
              <Plus size={15} /> اعطای امتیاز
            </button>
            <button type="button" onClick={() => setMode('redeem')}
              className={`h-11 rounded-xl border text-sm font-medium transition-colors flex items-center justify-center gap-1.5 ${mode === 'redeem' ? 'border-red-300 bg-red-50 text-red-700' : 'border-gray-200 bg-white text-gray-500'}`}>
              <Minus size={15} /> کسر امتیاز
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="customerclub-f167-1">تعداد امتیاز</label>
              <Input id="customerclub-f167-1" value={points} onChange={(e) => setPoints(e.target.value)} dir="ltr" inputMode="numeric" className="h-10 rounded-lg" />
            </div>
            {mode === 'add' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="customerclub-f172-2">دلیل</label>
                <select id="customerclub-f172-2" value={reason} onChange={(e) => setReason(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white">
                  <option value="manual">دستی</option>
                  <option value="good_payer_bonus">پاداش خوش‌حسابی</option>
                  <option value="referral">معرفی مشتری</option>
                  <option value="adjustment">اصلاح</option>
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="customerclub-f184-3">توضیح (اختیاری)</label>
            <Textarea id="customerclub-f184-3" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="rounded-lg resize-none" placeholder="مثلاً: پاداش خرید بیش از ۵ میلیون تومان" />
          </div>

          <Button onClick={submit} disabled={busy} className="w-full h-11 rounded-xl text-white font-semibold"
            style={{ background: mode === 'add' ? 'linear-gradient(135deg, #059669, #065f46)' : 'linear-gradient(135deg, #dc2626, #991b1b)' }}>
            {busy ? 'در حال ثبت...' : mode === 'add' ? `اعطای ${toPersianNum(points)} امتیاز` : `کسر ${toPersianNum(points)} امتیاز`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function CustomerClub() {
  const [data, setData] = useState<ClubData | null>(null);
  const [transactions, setTransactions] = useState<LoyaltyTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ClubView>('top');
  const [rankBy, setRankBy] = useState<'amount' | 'frequency' | 'loyalty'>('amount');
  const [search, setSearch] = useState('');
  const [pointsCustomer, setPointsCustomer] = useState<ClubCustomer | null>(null);
  const [showPoints, setShowPoints] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [clubRes, txRes] = await Promise.all([
        fetch('/api/loyalty', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'top-customers', limit: 50 }),
        }),
        fetch('/api/loyalty', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list-transactions', limit: 30 }),
        }),
      ]);
      const club = await clubRes.json();
      const tx = await txRes.json();
      if (!clubRes.ok) throw new Error(club.error || 'خطا در دریافت داده‌ها');
      setData(club.data || null);
      setTransactions(Array.isArray(tx.data) ? tx.data : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در دریافت داده‌ها');
    } finally {
      setLoading(false);
    }
  }, []);

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `load` asynchronous (react-hooks/set-state-in-effect).
  useEffect(() => {
    queueMicrotask(load);
  }, [load]);

  const ranked = useMemo(() => {
    if (!data) return [];
    const list = rankBy === 'amount' ? data.byAmount : rankBy === 'frequency' ? data.byFrequency : data.byLoyalty;
    return list.filter((c) => {
      if (!search.trim()) return true;
      // v2.35.1 (round 61) — Latin-typed queries also match their Persian twins
      const qs = searchVariants(search).map((v) => v.toLowerCase());
      return qs.some((v) => c.name.includes(v) || c.mobile.includes(v) || c.city.includes(v));
    });
  }, [data, rankBy, search]);

  const summary = data?.summary;

  const rankIcon = (i: number) => {
    if (i === 0) return <Trophy size={16} className="text-amber-500 fill-amber-100" />;
    if (i === 1) return <Award size={16} className="text-gray-400 fill-gray-100" />;
    if (i === 2) return <Award size={16} className="text-orange-700 fill-orange-100" />;
    return <span className="text-xs font-bold text-gray-400 w-4 text-center">{toPersianNum(i + 1)}</span>;
  };

  return (
    <div className="space-y-4" dir="rtl">
      {/* Header stats */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-teal-100 text-teal-600"><Building2 size={16} /></div>
            <span className="text-[11px] text-gray-400 hidden lg:block">کل مشتریان</span>
          </div>
          <p className="text-lg lg:text-xl font-bold text-gray-900">{toPersianNum(summary?.totalCustomers ?? 0)}</p>
          <p className="text-[11px] text-gray-400 lg:hidden">کل مشتریان</p>
        </div>
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-green-100 text-green-600"><TrendingUp size={16} /></div>
            <span className="text-[11px] text-gray-400 hidden lg:block">خریدکرده</span>
          </div>
          <p className="text-lg lg:text-xl font-bold text-gray-900">{toPersianNum(summary?.activeBuyers ?? 0)}</p>
          <p className="text-[11px] text-gray-400 lg:hidden">خریدکرده</p>
        </div>
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-amber-100 text-amber-600"><Gift size={16} /></div>
            <span className="text-[11px] text-gray-400 hidden lg:block">مجموع امتیاز</span>
          </div>
          <p className="text-lg lg:text-xl font-bold text-amber-600">{toPersianNum(summary?.totalPoints ?? 0)}</p>
          <p className="text-[11px] text-gray-400 lg:hidden">مجموع امتیاز</p>
        </div>
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-violet-100 text-violet-600"><UserRound size={16} /></div>
            <span className="text-[11px] text-gray-400 hidden lg:block">مشتری نهایی</span>
          </div>
          <p className="text-lg lg:text-xl font-bold text-violet-600">{toPersianNum(summary?.individuals ?? 0)}</p>
          <p className="text-[11px] text-gray-400 lg:hidden">مشتری نهایی</p>
        </div>
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-green-100 text-green-600"><ThumbsUp size={16} /></div>
            <span className="text-[11px] text-gray-400 hidden lg:block">خوش‌حساب</span>
          </div>
          <p className="text-lg lg:text-xl font-bold text-green-600">{toPersianNum(summary?.goodPayers ?? 0)}</p>
          <p className="text-[11px] text-gray-400 lg:hidden">خوش‌حساب</p>
        </div>
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-red-100 text-red-600"><ThumbsDown size={16} /></div>
            <span className="text-[11px] text-gray-400 hidden lg:block">بدحساب</span>
          </div>
          <p className="text-lg lg:text-xl font-bold text-red-600">{toPersianNum(summary?.badPayers ?? 0)}</p>
          <p className="text-[11px] text-gray-400 lg:hidden">بدحساب</p>
        </div>
      </div>

      {/* View tabs */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            <button onClick={() => setView('top')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all ${view === 'top' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              <Trophy size={14} /> مشتریان برتر
            </button>
            <button onClick={() => setView('points')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all ${view === 'points' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              <Gift size={14} /> دفتر امتیازها
            </button>
            <button onClick={() => setView('behavior')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all ${view === 'behavior' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              <Wallet size={14} /> خوش‌حسابی
            </button>
          </div>
          <div className="flex items-center gap-2">
            {view === 'top' && (
              <select value={rankBy} onChange={(e) => setRankBy(e.target.value as 'amount' | 'frequency' | 'loyalty')} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
                <option value="amount">رتبه‌بندی: بیشترین مبلغ خرید</option>
                <option value="frequency">رتبه‌بندی: بیشترین تناوب خرید</option>
                <option value="loyalty">رتبه‌بندی: امتیاز وفاداری</option>
              </select>
            )}
            {view === 'top' && (
              <div className="relative">
                <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو..." className="pr-8 h-9 w-44 rounded-lg text-xs border-gray-200" />
              </div>
            )}
            <Button onClick={load} variant="outline" size="sm" className="h-9 gap-1.5 text-xs rounded-lg">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> به‌روزرسانی
            </Button>
          </div>
        </div>
      </div>

      {loading && !data ? (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-teal-600" />
          <p className="text-sm text-gray-400">در حال دریافت داده‌های باشگاه...</p>
        </div>
      ) : view === 'top' ? (
        /* ── مشتریان برتر ── */
        ranked.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
            <Trophy size={36} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">هنوز دادهٔ خریدی برای رتبه‌بندی ثبت نشده است</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-[11px] text-gray-500">
                    <th className="py-3 px-3 text-right font-medium">رتبه</th>
                    <th className="py-3 px-3 text-right font-medium">مشتری</th>
                    <th className="py-3 px-3 text-right font-medium">نوع</th>
                    <th className="py-3 px-3 text-right font-medium">مجموع خرید</th>
                    <th className="py-3 px-3 text-right font-medium">تعداد خرید</th>
                    <th className="py-3 px-3 text-right font-medium">میانگین خرید</th>
                    <th className="py-3 px-3 text-right font-medium">آخرین خرید</th>
                    <th className="py-3 px-3 text-right font-medium">امتیاز</th>
                    <th className="py-3 px-3 text-right font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((c, i) => (
                    <tr key={c.centerId} className="border-t border-gray-50 hover:bg-gray-50/50 transition-colors">
                      <td className="py-3 px-3">{rankIcon(i)}</td>
                      <td className="py-3 px-3">
                        <p className="font-bold text-gray-900 text-xs">{c.name}</p>
                        <p className="text-[11px] text-gray-400">{c.city || c.province}{c.mobile ? ` · ${c.mobile}` : ''}</p>
                      </td>
                      <td className="py-3 px-3">
                        <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium"
                          style={{ background: c.customerType === 'end_user' ? '#f5f3ff' : '#eff6ff', color: c.customerType === 'end_user' ? '#7c3aed' : '#1d4ed8' }}>
                          {CUSTOMER_TYPE_LABELS[c.customerType] || c.customerType}
                        </span>
                        {c.segment && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium mr-1" style={{ background: '#fffbeb', color: '#b45309' }}>
                            {SEGMENT_LABELS[c.segment] || c.segment}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 font-bold text-gray-900 text-xs">{formatCurrency(c.totalAmount)}</td>
                      <td className="py-3 px-3 text-xs text-gray-600">{toPersianNum(c.purchaseCount)}</td>
                      <td className="py-3 px-3 text-xs text-gray-600">{formatCurrency(c.avgPurchase)}</td>
                      <td className="py-3 px-3 text-xs text-gray-500">
                        {c.daysSinceLastPurchase === null ? '—' : c.daysSinceLastPurchase === 0 ? 'امروز' : `${toPersianNum(c.daysSinceLastPurchase)} روز پیش`}
                      </td>
                      <td className="py-3 px-3">
                        <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-600">
                          <Gift size={12} /> {toPersianNum(c.loyaltyPoints)}
                        </span>
                      </td>
                      <td className="py-3 px-3">
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px] rounded-lg"
                          onClick={() => { setPointsCustomer(c); setShowPoints(true); }}>
                          <Wallet size={11} /> امتیاز
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : view === 'points' ? (
        /* ── دفتر امتیازها ── */
        transactions.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
            <Gift size={36} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">هنوز تراکنش امتیازی ثبت نشده است</p>
            <p className="text-[11px] mt-1">امتیاز خرید به‌صورت خودکار با «فروش سریع» اعمال می‌شود (هر ۱۰۰ هزار تومان = ۱ امتیاز)</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
            {transactions.map((tx) => (
              <div key={tx.id} className="flex items-center gap-3 p-3">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${tx.points > 0 ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}`}>
                  {tx.points > 0 ? <Plus size={16} /> : <Minus size={16} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-gray-900">{tx.center?.name || '—'}</span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{LOYALTY_REASON_LABELS[tx.reason] || tx.reason}</span>
                    {tx.documentNumber && <span className="text-[11px] text-gray-400" dir="ltr">{tx.documentNumber}</span>}
                  </div>
                  {tx.note && <p className="text-[11px] text-gray-500 mt-0.5 truncate">{tx.note}</p>}
                  <p className="text-[11px] text-gray-400 mt-0.5">{tx.createdByName || '—'} · {new Date(tx.createdAt).toLocaleDateString('fa-IR')}</p>
                </div>
                <span className={`text-sm font-bold shrink-0 ${tx.points > 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {tx.points > 0 ? '+' : ''}{toPersianNum(tx.points)}
                </span>
              </div>
            ))}
          </div>
        )
      ) : (
        /* ── خوش‌حسابی ── */
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[
            { title: 'خوش‌حساب‌ها', icon: <ThumbsUp size={15} />, list: data?.goodPayers || [], color: '#059669', bg: '#ecfdf5' },
            { title: 'بدحساب‌ها', icon: <ThumbsDown size={15} />, list: data?.badPayers || [], color: '#dc2626', bg: '#fef2f2' },
          ].map((group) => (
            <div key={group.title} className="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <div className="p-3 border-b border-gray-50 flex items-center gap-2" style={{ background: group.bg }}>
                <span style={{ color: group.color }}>{group.icon}</span>
                <h4 className="text-sm font-bold" style={{ color: group.color }}>{group.title}</h4>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/70 font-bold" style={{ color: group.color }}>{toPersianNum(group.list.length)}</span>
              </div>
              {group.list.length === 0 ? (
                <div className="p-8 text-center text-xs text-gray-400">موردی ثبت نشده است</div>
              ) : (
                <div className="divide-y divide-gray-50 max-h-[420px] overflow-y-auto">
                  {group.list.map((c) => (
                    <div key={c.centerId} className="flex items-center gap-3 p-3">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold shrink-0" style={{ background: `linear-gradient(135deg, ${group.color}, ${group.color}bb)` }}>
                        {c.name.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-gray-900 truncate">{c.name}</p>
                        <p className="text-[11px] text-gray-400">
                          {CUSTOMER_TYPE_LABELS[c.customerType]}{c.segment ? ` · ${SEGMENT_LABELS[c.segment]}` : ''} · {toPersianNum(c.purchaseCount)} خرید
                        </p>
                      </div>
                      <div className="text-left shrink-0">
                        <p className="text-xs font-bold text-gray-900">{formatCurrency(c.totalAmount)}</p>
                        {c.mobile && <p className="text-[11px] text-gray-400" dir="ltr">{c.mobile}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <PointsDialog customer={pointsCustomer} open={showPoints} onOpenChange={setShowPoints} onDone={load} />
    </div>
  );
}
