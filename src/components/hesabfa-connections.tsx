'use client';
// ════════════════════════════════════════════════════════════
// hesabfa-connections.tsx — v2.33.0 per-company Hesabfa settings card
// One Hesabfa business per company: apiKey + loginToken per tab,
// masked secrets (empty field = keep existing), test connection,
// disconnect (connection+warehouses+snapshots of THAT company only)
// and sync policies (interval / match field / unmatched policy).
// ════════════════════════════════════════════════════════════
import { useCallback, useEffect, useState } from 'react';
import { Server, Check, RefreshCw, Trash2, PlugZap, AlertTriangle, Package, Users, FileText, Warehouse, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface WarehouseInfo { code: string; name: string; active: boolean }
interface ConnectionInfo {
  companySlug: string; companyName: string; connected: boolean;
  unit: 'production' | 'trading' | null;
  apiKeyMasked: string; loginTokenMasked: string; baseUrl: string;
  businessName: string | null;
  lastTestAt: string | null; lastTestOk: boolean | null; lastTestMsg: string | null;
  lastSyncAt: string | null; lastSyncStats: Record<string, number> | null;
  stale: boolean; warehouses: WarehouseInfo[];
}
interface EnvCredInfo {
  unit: 'production' | 'trading'; companySlug: string; present: boolean;
  apiKeyMasked: string; loginTokenMasked: string; baseUrl: string;
}

const UNIT_LABEL: Record<string, string> = {
  production: 'واحد تولیدی (سریالی)',
  trading: 'واحد بازرگانی (تعدادی)',
};

const fmt = (iso: string | null): string => {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
};

export function HesabfaConnectionsCard() {
  const [conns, setConns] = useState<ConnectionInfo[]>([]);
  const [envCreds, setEnvCreds] = useState<EnvCredInfo[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'forbidden'>('loading');
  const [tab, setTab] = useState<string>('');
  const [apiKey, setApiKey] = useState('');
  const [loginToken, setLoginToken] = useState('');
  const [interval_, setInterval_] = useState('60');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch('/api/hesabfa', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || 'خطای سرور');
    return data as Record<string, unknown>;
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/hesabfa', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connections' }),
      });
      if (res.status === 403) { setStatus('forbidden'); return; }
      const data = (await res.json()) as { connections: ConnectionInfo[] };
      setConns(data.connections ?? []);
      setStatus('ready');
      setTab((t) => t || data.connections?.[0]?.companySlug || '');
      const envRes = await call({ action: 'env-credentials' });
      setEnvCreds((envRes.env ?? []) as EnvCredInfo[]);
      const pol = await call({ action: 'settings' });
      const s = (pol.settings ?? {}) as Record<string, string>;
      setInterval_(s.syncIntervalMinutes || '60');
    } catch {
      setError('خطا در دریافت وضعیت اتصال‌ها');
      setStatus('ready');
    }
  }, [call]);

  const current = conns.find((c) => c.companySlug === tab) ?? null;

  // microtask queue — keeps the sync setState at the top of `load` async
  // (react-hooks/set-state-in-effect pattern used across the codebase).
  useEffect(() => {
    queueMicrotask(load);
  }, [load]);

  const save = async () => {
    if (!tab) return;
    setBusy('save'); setMessage(null); setError(null);
    try {
      await call({ action: 'connection-set', companySlug: tab, apiKey, loginToken });
      setApiKey(''); setLoginToken('');
      setMessage('اطلاعات اتصال ذخیره شد');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ذخیره');
    } finally { setBusy(null); }
  };

  const test = async () => {
    if (!tab) return;
    setBusy('test'); setMessage(null); setError(null);
    try {
      const r = await call({ action: 'test-connection', companySlug: tab });
      setMessage(String(r.message ?? ''));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در تست اتصال');
    } finally { setBusy(null); }
  };

  const disconnect = async () => {
    if (!tab) return;
    setBusy('del'); setMessage(null); setError(null);
    try {
      await call({ action: 'connection-delete', companySlug: tab });
      setMessage('اتصال این شرکت قطع و داده‌هایش حذف شد');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در قطع اتصال');
    } finally { setBusy(null); }
  };

  const savePolicies = async () => {
    setBusy('policy'); setMessage(null); setError(null);
    try {
      await call({ action: 'settings', mode: 'set', syncIntervalMinutes: interval_ });
      setMessage('سیاست‌های همگام‌سازی ذخیره شد');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ذخیره');
    } finally { setBusy(null); }
  };

  const syncSection = async (section: 'items' | 'contacts' | 'invoices' | 'inventory') => {
    if (!tab) return;
    setBusy(`sync-${section}`); setMessage(null); setError(null);
    try {
      const action = section === 'inventory' ? 'sync-inventory' : `sync-${section}`;
      const r = await call({ action, companySlug: tab });
      setMessage(String(r.message ?? ''));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطای همگام‌سازی');
    } finally { setBusy(null); }
  };

  const importEnv = async () => {
    if (!tab) return;
    setBusy('env'); setMessage(null); setError(null);
    try {
      const r = await call({ action: 'env-import', companySlug: tab });
      setMessage(String(r.message ?? ''));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطای ورود اعتبارنامه');
    } finally { setBusy(null); }
  };

  if (status === 'loading') {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 border-2 border-teal-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-gray-400">در حال بارگذاری حسابفا…</span>
        </div>
      </div>
    );
  }
  if (status === 'forbidden') {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-5 text-xs text-gray-400">تنظیمات حسابفا فقط برای مدیر سیستم.</div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: '#05966915', color: '#059669' }}><Server size={18} /></div>
          <div>
            <h4 className="text-sm font-bold text-gray-900">حسابفا (فقط خواندن)</h4>
            <p className="text-[11px] text-gray-400">اتصال مستقل هر شرکت به کسب‌وکار حسابفا خودش — انبارها و موجودی کاملاً جدا</p>
          </div>
        </div>
      </div>

      {message && <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 text-[11px] text-emerald-700 mb-3">{message}</div>}
      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-[11px] text-red-600 mb-3">{error}</div>}

      {/* v2.57.0 — env credentials strip (masked, read-only) */}
      <div className="bg-gray-50/70 border border-gray-100 rounded-xl p-3 mb-4" data-hesabfa-env="strip">
        <p className="text-[11px] font-bold text-gray-600 mb-2">اعتبارنامه‌های متغیرهای محیطی (.env)</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {envCreds.map((e) => {
            const co = conns.find((c) => c.companySlug === e.companySlug);
            const active = e.present && co?.connected;
            return (
              <div key={e.unit} className="flex items-center justify-between gap-2 bg-white border border-gray-100 rounded-lg px-2.5 py-2" data-hesabfa-env-unit={e.unit}>
                <div className="min-w-0">
                  <p className="text-[11px] font-bold text-gray-700 truncate">{UNIT_LABEL[e.unit]}</p>
                  <p className="text-[10px] text-gray-400 truncate" dir="ltr">{e.present ? `${e.apiKeyMasked} · ${e.loginTokenMasked}` : 'تنظیم نشده'}</p>
                </div>
                <span className={'text-[10px] px-2 py-0.5 rounded-full shrink-0 ' + (active ? 'bg-emerald-50 text-emerald-600' : e.present ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-gray-400')}>
                  {active ? 'فعال' : e.present ? 'موجود' : 'ناموجود'}
                </span>
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-gray-400 mt-2">این دو واحد در هر بار باز شدن تنظیمات به‌صورت خودکار از .env وارد می‌شوند؛ مقادیر خام هرگز به مرورگر نمی‌روند.</p>
      </div>

      {/* per-company tabs */}
      <div className="flex flex-wrap gap-1.5 mb-4" role="tablist" aria-label="شرکت‌ها">
        {conns.map((c) => (
          <button
            key={c.companySlug}
            role="tab"
            aria-selected={tab === c.companySlug}
            data-hesabfa-tab={c.companySlug}
            onClick={() => { setTab(c.companySlug); setApiKey(''); setLoginToken(''); setMessage(null); setError(null); }}
            className={'text-[11px] font-medium px-3 py-1.5 rounded-full border transition ' +
              (tab === c.companySlug ? 'border-teal-600 bg-teal-50 text-teal-700' : 'border-gray-200 text-gray-500 hover:border-gray-300')}
          >
            {c.companyName}
            <span className={'inline-block w-1.5 h-1.5 rounded-full ms-1.5 align-middle ' + (c.connected ? 'bg-emerald-500' : 'bg-gray-300')} />
          </button>
        ))}
      </div>

      {current && (
        <div className="space-y-3" data-hesabfa-panel={current.companySlug}>
          {/* status line */}
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className={'px-2 py-1 rounded-full font-medium ' + (current.connected ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-500')}>
              {current.connected ? 'متصل' : 'متصل نیست'}
            </span>
            {current.unit && (
              <span className="px-2 py-1 rounded-full font-medium bg-indigo-50 text-indigo-600">{UNIT_LABEL[current.unit]}</span>
            )}
            {current.businessName && <span className="text-gray-500">کسب‌وکار: <b>{current.businessName}</b></span>}
            {current.lastSyncAt && (
              <span className={current.stale ? 'text-amber-600 flex items-center gap-1' : 'text-gray-400'}>
                {current.stale && <AlertTriangle size={12} />}
                آخرین همگام‌سازی: {fmt(current.lastSyncAt)}
                {current.stale ? ' (قدیمی)' : ''}
              </span>
            )}
            {current.lastTestMsg && (
              <span className={current.lastTestOk ? 'text-emerald-600' : 'text-red-500'}>{current.lastTestMsg}</span>
            )}
          </div>

          {/* secret inputs — empty = keep existing */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="hesabfa-apikey">API Key</label>
              <Input
                id="hesabfa-apikey" value={apiKey} onChange={(e) => setApiKey(e.target.value)} dir="ltr"
                placeholder={current.connected ? current.apiKeyMasked : 'apiKey کسب‌وکار حسابفا'}
                className="h-10 rounded-lg font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="hesabfa-logintoken">Login Token</label>
              <Input
                id="hesabfa-logintoken" value={loginToken} onChange={(e) => setLoginToken(e.target.value)} dir="ltr"
                placeholder={current.connected ? current.loginTokenMasked : 'loginToken کسب‌وکار حسابفا'}
                className="h-10 rounded-lg font-mono text-xs"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={busy !== null} className="h-9 gap-1.5 text-white text-xs rounded-lg px-4" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
              <Check size={13} /> {busy === 'save' ? 'در حال ذخیره…' : 'ذخیرهٔ اعتبارنامه'}
            </Button>
            <Button onClick={test} disabled={busy !== null || !current.connected} variant="outline" className="h-9 gap-1.5 text-xs rounded-lg px-4">
              <PlugZap size={13} /> {busy === 'test' ? 'در حال تست…' : 'تست اتصال'}
            </Button>
            <Button onClick={importEnv} disabled={busy !== null || !current.unit} variant="outline" className="h-9 gap-1.5 text-xs rounded-lg px-4" title="ورود اعتبارنامهٔ این واحد از متغیرهای محیطی">
              <Server size={13} /> {busy === 'env' ? '…' : 'دریافت از .env'}
            </Button>
            <Button onClick={disconnect} disabled={busy !== null || !current.connected} variant="outline" className="h-9 gap-1.5 text-xs rounded-lg px-4 text-red-600 border-red-200 hover:bg-red-50">
              <Trash2 size={13} /> {busy === 'del' ? '…' : 'قطع اتصال'}
            </Button>
          </div>

          {/* v2.57.0 — per-section sync (spec: تست اتصال / کالاها / مشتریان /
              فاکتورها / موجودی / سریال‌ها). Invoices+serials are one button
              because serials come from invoice lines. */}
          <div className="border-t border-gray-100 pt-3">
            <p className="text-[11px] font-bold text-gray-600 mb-2">همگام‌سازی بخش‌ها (یک‌طرفه — فقط خواندن از حسابفا)</p>
            <div className="flex flex-wrap gap-2" data-hesabfa-sync-sections={current.companySlug}>
              {([
                { key: 'items', label: 'همگام‌سازی کالاها', icon: <Package size={13} /> },
                { key: 'contacts', label: 'همگام‌سازی مشتریان', icon: <Users size={13} /> },
                { key: 'invoices', label: 'همگام‌سازی فاکتورها و سریال‌ها', icon: <FileText size={13} /> },
                { key: 'inventory', label: 'همگام‌سازی موجودی و انبارها', icon: <Warehouse size={13} /> },
              ] as const).map((s) => (
                <Button
                  key={s.key}
                  onClick={() => syncSection(s.key)}
                  disabled={busy !== null || !current.connected}
                  variant="outline"
                  data-hesabfa-sync-btn={s.key}
                  className="h-9 gap-1.5 text-xs rounded-lg px-3.5"
                >
                  {busy === `sync-${s.key}` ? <Loader2 size={13} className="animate-spin" /> : s.icon}
                  {busy === `sync-${s.key}` ? 'در حال همگام‌سازی…' : s.label}
                </Button>
              ))}
            </div>
            {current.lastSyncStats && (
              <p className="text-[10px] text-gray-400 mt-2" dir="rtl">
                آخرین نتیجه: {JSON.stringify(current.lastSyncStats)}
              </p>
            )}
          </div>

          {/* warehouses of this company */}
          {current.warehouses.length > 0 && (
            <div className="border-t border-gray-100 pt-3">
              <p className="text-[11px] text-gray-500 mb-1.5">انبارهای این شرکت در حسابفا:</p>
              <div className="flex flex-wrap gap-1.5">
                {current.warehouses.map((w) => (
                  <span key={w.code} className="text-[11px] bg-gray-50 border border-gray-200 rounded-full px-2.5 py-1 text-gray-600">
                    {w.name} <span className="text-gray-400" dir="ltr">({w.code})</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* sync policy (shared) */}
      <div className="border-t border-gray-100 mt-4 pt-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="hesabfa-interval">بازهٔ همگام‌سازی خودکار (دقیقه)</label>
          <Input id="hesabfa-interval" value={interval_} onChange={(e) => setInterval_(e.target.value)} dir="ltr" className="h-9 rounded-lg w-28 text-xs" />
        </div>
        <Button onClick={savePolicies} disabled={busy !== null} variant="outline" className="h-9 gap-1.5 text-xs rounded-lg px-4">
          <RefreshCw size={13} /> {busy === 'policy' ? '…' : 'ذخیرهٔ سیاست'}
        </Button>
        <p className="text-[11px] text-gray-400">هرچه باشد، دادهٔ قدیمی‌تر از یک ساعت با برچسب «قدیمی» نمایش داده می‌شود.</p>
      </div>
    </div>
  );
}
