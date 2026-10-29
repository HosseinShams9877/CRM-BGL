'use client';

// ════════════════════════════════════════════════════════════
// AI SALES — PLAYBOOK (v2.27.0)
// Browse + (admin) manage + Winning Call Mining → suggestions.
// ════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BookOpenText, Plus, Pencil, Trash2, Sparkles, RefreshCw } from 'lucide-react';
import { toPersianNum, faDate, AiSkeleton, AiEmptyState, AiErrorState, aiApiJson } from './shared';

const CATEGORIES: { key: string; label: string }[] = [
  { key: 'opening', label: 'شروع مکالمه' },
  { key: 'discovery', label: 'کشف نیاز' },
  { key: 'qualification', label: 'سنجش صلاحیت' },
  { key: 'objection', label: 'پاسخ اعتراض' },
  { key: 'pitch', label: 'ارائه محصول' },
  { key: 'closing', label: 'جمع‌بندی و بستن' },
  { key: 'followup', label: 'پیگیری' },
];

interface PlaybookItem {
  id: string; category: string; title: string; content: string;
  tags: string; source: string; createdAt: string;
}

interface MineSuggestion { category: string; title: string; content: string }

export function AiPlaybook({ companySlug, isAdmin }: { companySlug: string; isAdmin: boolean }) {
  const [items, setItems] = useState<PlaybookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [category, setCategory] = useState('all');
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<PlaybookItem | null>(null);
  const [mining, setMining] = useState(false);
  const [suggestions, setSuggestions] = useState<MineSuggestion[]>([]);

  const load = useCallback(async () => {
    const res = await aiApiJson<{ items: PlaybookItem[] }>('/api/ai-sales/playbook', {
      action: 'list', companySlug: companySlug === 'holding' ? undefined : companySlug,
      category: category === 'all' ? undefined : category,
    });
    setLoading(false);
    if (!res.ok || !res.data) { setError(res.error || 'خطا'); return; }
    setError('');
    setItems(res.data.items || []);
  }, [companySlug, category]);

  useEffect(() => {
    // kick off without calling setState synchronously (codebase pattern)
    void (async () => { await load(); })();
  }, [load]);

  const handleDelete = async (item: PlaybookItem) => {
    if (!window.confirm(`«${item.title}» حذف شود؟`)) return;
    const res = await aiApiJson('/api/ai-sales/playbook', { action: 'delete', id: item.id });
    if (res.ok) { toast.success('حذف شد.'); void load(); } else toast.error(res.error || 'خطا');
  };

  const handleMine = async () => {
    setMining(true);
    const res = await aiApiJson<{ suggestions: MineSuggestion[]; message: string }>('/api/ai-sales/playbook', {
      action: 'mine', companySlug: companySlug === 'holding' ? undefined : companySlug,
    });
    setMining(false);
    if (!res.ok) { toast.error(res.error || 'خطا'); return; }
    if (!res.data?.suggestions?.length) { toast.info(res.data?.message || 'الگوی برنده‌ای پیدا نشد.'); return; }
    setSuggestions(res.data.suggestions);
    toast.success(`${toPersianNum(res.data.suggestions.length)} پیشنهاد استخراج شد — بازبینی کنید.`);
  };

  const saveSuggestion = async (s: MineSuggestion) => {
    const res = await aiApiJson('/api/ai-sales/playbook', {
      action: 'save', companySlug: companySlug === 'holding' ? 'bazargani' : companySlug,
      category: s.category, title: s.title, content: s.content, tags: ['winning-mined'],
    });
    if (res.ok) {
      toast.success('در پلی‌بوک ذخیره شد.');
      setSuggestions((prev) => prev.filter((x) => x !== s));
      void load();
    } else toast.error(res.error || 'خطا');
  };

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-800 dark:text-slate-100">
            <BookOpenText size={18} className="text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
            پلی‌بوک فروش
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">اسکریپت‌ها، پرسش‌ها و پاسخ‌های برتر — استخراج‌شده از تماس‌های موفق و تجربه تیم.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isAdmin && (
            <>
              <Button size="sm" onClick={() => { setEditing(null); setEditOpen(true); }} className="gap-1.5 bg-cyan-600 hover:bg-cyan-700">
                <Plus size={14} aria-hidden="true" /> مورد جدید
              </Button>
              <Button size="sm" variant="outline" onClick={() => void handleMine()} disabled={mining} className="gap-1.5">
                <Sparkles size={14} className={mining ? 'animate-pulse' : ''} aria-hidden="true" />
                {mining ? 'در حال استخراج…' : 'استخراج الگوهای برنده'}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="فیلتر دسته"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">همه دسته‌ها</SelectItem>
            {CATEGORIES.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={() => { setLoading(true); void load(); }} className="h-8 gap-1 text-xs" aria-label="رفرش">
          <RefreshCw size={13} aria-hidden="true" /> رفرش
        </Button>
      </div>

      {suggestions.length > 0 && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50/70 p-3 dark:border-amber-800 dark:bg-amber-950/30">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-amber-800 dark:text-amber-200">
            <Sparkles size={14} aria-hidden="true" /> پیشنهادهای استخراج‌شده از تماس‌های برنده (نیازمند بازبینی)
          </h3>
          <ul className="space-y-2">
            {suggestions.map((s, i) => (
              <li key={i} className="rounded-xl border border-amber-200 bg-white p-3 dark:border-amber-900 dark:bg-slate-900">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-100">{s.title}</span>
                  <div className="flex gap-1.5">
                    <Button size="sm" onClick={() => void saveSuggestion(s)} className="h-7 gap-1 px-2 text-[11px] bg-emerald-600 hover:bg-emerald-700">ذخیره در پلی‌بوک</Button>
                    <Button size="sm" variant="ghost" onClick={() => setSuggestions((prev) => prev.filter((x) => x !== s))} className="h-7 px-2 text-[11px] text-slate-500">رد</Button>
                  </div>
                </div>
                <p className="mt-1 text-xs leading-6 text-slate-600 dark:text-slate-300">{s.content}</p>
                <span className="mt-1 inline-block rounded-full bg-cyan-100 px-2 py-0.5 text-[10px] text-cyan-800 dark:bg-cyan-950 dark:text-cyan-300">
                  {CATEGORIES.find((c) => c.key === s.category)?.label || s.category}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading && <AiSkeleton rows={4} />}
      {!loading && error && <AiErrorState message={error} onRetry={() => void load()} />}
      {!loading && !error && items.length === 0 && (
        <AiEmptyState title="پلی‌بوک خالی است" description={isAdmin ? 'اولین مورد را اضافه کنید یا از دکمه «استخراج الگوهای برنده» الگوهای تماس‌های موفق را استخراج کنید.' : 'پس از آنکه مدیر سیستم موارد پلی‌بوک را ثبت کند، اینجا نمایش داده می‌شود.'} />
      )}
      {!loading && !error && items.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {items.map((item) => (
            <div key={item.id} className="group rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="mb-1 inline-block rounded-full bg-cyan-100 px-2 py-0.5 text-[10px] font-semibold text-cyan-800 dark:bg-cyan-950 dark:text-cyan-300">
                    {CATEGORIES.find((c) => c.key === item.category)?.label || item.category}
                  </span>
                  <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">{item.title}</h3>
                  {item.source === 'winning-mined' && (
                    <span className="mt-0.5 inline-block text-[10px] text-emerald-600 dark:text-emerald-400">استخراج‌شده از تماس برنده</span>
                  )}
                </div>
                {isAdmin && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => { setEditing(item); setEditOpen(true); }} className="h-7 w-7 p-0 opacity-100 md:opacity-0 md:group-hover:opacity-100" aria-label="ویرایش">
                      <Pencil size={13} aria-hidden="true" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void handleDelete(item)} className="h-7 w-7 p-0 text-rose-600 opacity-100 md:opacity-0 md:group-hover:opacity-100" aria-label="حذف">
                      <Trash2 size={13} aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-slate-600 dark:text-slate-300">{item.content}</p>
              <p className="mt-2 text-[10px] text-slate-400">{faDate(item.createdAt)}</p>
            </div>
          ))}
        </div>
      )}

      {editOpen && (
        <PlaybookEditDialog
          key={editing?.id || 'new'}
          open={editOpen} onClose={() => setEditOpen(false)}
          editing={editing} companySlug={companySlug === 'holding' ? 'bazargani' : companySlug}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}

function PlaybookEditDialog({ open, onClose, editing, companySlug, onSaved }: {
  open: boolean; onClose: () => void; editing: PlaybookItem | null; companySlug: string; onSaved: () => void;
}) {
  const [category, setCategory] = useState(editing?.category || 'discovery');
  const [title, setTitle] = useState(editing?.title || '');
  const [content, setContent] = useState(editing?.content || '');
  const [saving, setSaving] = useState(false);

  // dialog mounts fresh per edit (parent key) — initial state derives from
  // props directly; no reset effect (sync setState in effects is banned).

  const save = async () => {
    if (!title.trim() || !content.trim()) { toast.error('عنوان و محتوا الزامی است.'); return; }
    setSaving(true);
    const res = await aiApiJson('/api/ai-sales/playbook', {
      action: 'save', id: editing?.id, companySlug,
      category, title: title.trim(), content: content.trim(),
    });
    setSaving(false);
    if (!res.ok) { toast.error(res.error || 'خطا'); return; }
    toast.success(editing ? 'به‌روزرسانی شد.' : 'ایجاد شد.');
    onSaved();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" dir="rtl">
        <DialogHeader><DialogTitle className="text-base">{editing ? 'ویرایش مورد پلی‌بوک' : 'مورد جدید پلی‌بوک'}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <label htmlFor="pb-cat" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">دسته‌بندی *</label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="pb-cat" className="h-9 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label htmlFor="pb-title" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">عنوان *</label>
            <input
              id="pb-title" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="مثلاً: پرسش کشف نیاز برای ICU"
              className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-xs outline-none focus:border-cyan-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
          </div>
          <div>
            <label htmlFor="pb-content" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">محتوا *</label>
            <Textarea id="pb-content" value={content} onChange={(e) => setContent(e.target.value)} rows={7} className="text-xs leading-6" placeholder="متن اسکریپت/پرسش/پاسخ…" />
          </div>
          <div className="flex justify-start gap-2 pt-1">
            <Button onClick={save} disabled={saving} className="bg-cyan-600 hover:bg-cyan-700">{saving ? 'در حال ذخیره…' : 'ذخیره'}</Button>
            <Button variant="outline" onClick={onClose}>انصراف</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
