'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PaginationControls from '@/components/ui/pagination-controls';
import { SkeletonList } from '@/hooks/use-api';
import { toast } from 'sonner';
import {
  Search, Plus, Inbox, Send, Mail, MailOpen, Trash2, Reply,
  User as UserIcon, Users, CheckCheck, ChevronDown,
} from 'lucide-react';

// ═══════════════════════════════════════════════════════════
// Internal mailbox — inbox / sent / compose, wired to /api/mail
// ═══════════════════════════════════════════════════════════

export type MailTab = 'inbox' | 'sent';

interface MailUser {
  id: string;
  displayName: string;
  roleLabel?: string;
}

interface Letter {
  id: string;
  subject: string;
  body: string;
  senderId: string | null;
  createdAt: string;
  /** inbox rows only */
  isRead?: boolean;
  readAt?: string | null;
  recipients?: Array<{ userId: string; isRead: boolean }>;
  /** joined sender (populated client-side from users list) */
  senderName?: string;
}

interface InboxResponse {
  letters: Letter[];
  total: number;
  unreadCount: number;
  page: number;
  totalPages: number;
}

interface SentResponse {
  letters: Letter[];
  total: number;
  page: number;
  totalPages: number;
}

// ── helpers ────────────────────────────────────────────────
function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'همین الان';
  if (mins < 60) return `${toPersianNum(mins)} دقیقه پیش`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${toPersianNum(hours)} ساعت پیش`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${toPersianNum(days)} روز پیش`;
  return new Date(iso).toLocaleDateString('fa-IR');
}

async function apiCall(action: string, payload: Record<string, unknown> = {}) {
  const res = await fetch('/api/mail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'خطای سرور'), { status: res.status });
  return data;
}

// ── letter detail dialog ───────────────────────────────────
function LetterDetail({ letter, senderName, users, onClose, onMarkRead, onReply, onDelete }: {
  letter: Letter;
  senderName: string;
  users: MailUser[];
  onClose: () => void;
  onMarkRead: (letter: Letter) => void;
  onReply: (letter: Letter) => void;
  onDelete: (letter: Letter) => void;
}) {
  useEffect(() => {
    if (letter.isRead === false) onMarkRead(letter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [letter.id]);

  const recipientNames = (letter.recipients || [])
    .map((r) => users.find((u) => u.id === r.userId)?.displayName || 'کاربر حذف‌شده');

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[min(32rem,calc(100vw-2rem))]" dir="rtl">
      <DialogHeader><DialogTitle className="text-right">{letter.subject}</DialogTitle></DialogHeader>
      <div className="space-y-4 mt-2">
        <div className="bg-gray-50 rounded-xl p-3 space-y-1.5 text-xs">
          <div className="flex items-center gap-2 text-gray-600">
            <UserIcon size={12} />
            <span className="font-bold text-gray-800">{senderName}</span>
          </div>
          <div className="flex items-center gap-2 text-gray-500">
            <Users size={12} />
            <span>گیرندگان: {recipientNames.length > 0 ? recipientNames.join('، ') : '—'}</span>
          </div>
          <div className="flex items-center gap-2 text-gray-400">
            <Mail size={12} />
            <span>{timeAgo(letter.createdAt)}</span>
            {letter.recipients && letter.recipients.every((r) => r.isRead) && (
              <Badge className="bg-emerald-50 text-emerald-600 hover:bg-emerald-50 text-[11px]">
                <CheckCheck size={9} className="ml-1" /> همه خوانده‌اند
              </Badge>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4 min-h-[120px] text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
          {letter.body || '— بدون متن —'}
        </div>

        <div className="flex items-center gap-2">
          {letter.senderId && (
            <Button onClick={() => onReply(letter)} className="flex-1 h-9 gap-1.5 text-xs rounded-lg text-white" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
              <Reply size={13} /> پاسخ
            </Button>
          )}
          <Button onClick={() => onDelete(letter)} variant="outline" className="h-9 gap-1.5 text-xs rounded-lg text-red-600 border-red-200 hover:bg-red-50">
            <Trash2 size={13} /> حذف
          </Button>
        </div>
      </div>
      </DialogContent>
    </Dialog>
  );
}

// ── compose dialog ─────────────────────────────────────────
function ComposeDialog({ users, open, onOpenChange, onSent, replyTo }: {
  users: MailUser[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
  replyTo?: { subject: string; senderId: string | null } | null;
}) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Prefill/reset the reply form asynchronously so the effect body itself
    // stays free of synchronous setState (react-hooks/set-state-in-effect).
    queueMicrotask(() => {
      if (open && replyTo) {
        setSubject(replyTo.subject.startsWith('پاسخ:') ? replyTo.subject : `پاسخ: ${replyTo.subject}`);
        setSelected(replyTo.senderId ? [replyTo.senderId] : []);
        setBody('');
      } else if (open) {
        setSubject(''); setBody(''); setSelected([]);
      }
      setError(null);
    });
  }, [open, replyTo]);

  const toggleUser = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    if (!subject.trim()) { setError('موضوع نامه الزامی است.'); return; }
    if (selected.length === 0) { setError('حداقل یک گیرنده انتخاب کنید.'); return; }
    setBusy(true);
    setError(null);
    try {
      await apiCall('send', { subject: subject.trim(), body, recipientIds: selected });
      toast.success('نامه ارسال شد');
      onOpenChange(false);
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ارسال');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(32rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader><DialogTitle>{replyTo ? 'پاسخ به نامه' : 'نامهٔ جدید'}</DialogTitle></DialogHeader>
        <div className="space-y-4 mt-2">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="mailbox-f207-1">موضوع *</label>
            <Input id="mailbox-f207-1" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="موضوع نامه..." className="h-10 rounded-lg" />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-gray-700">گیرندگان * ({toPersianNum(selected.length)} انتخاب‌شده)</label>
              <button type="button" onClick={() => setSelected(selected.length === users.length ? [] : users.map((u) => u.id))}
                className="text-[11px] text-teal-700 hover:underline">
                {selected.length === users.length ? 'حذف انتخاب‌ها' : 'انتخاب همه'}
              </button>
            </div>
            <div className="border border-gray-100 rounded-xl max-h-44 overflow-y-auto p-2 space-y-1">
              {users.length === 0 && <p className="text-xs text-gray-400 text-center py-3">کاربر دیگری برای ارسال وجود ندارد</p>}
              {users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => toggleUser(u.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-colors text-right ${
                    selected.includes(u.id) ? 'bg-teal-50 text-teal-800 border border-teal-200' : 'hover:bg-gray-50 text-gray-700 border border-transparent'
                  }`}
                >
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0 ${
                    selected.includes(u.id) ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {u.displayName.slice(0, 1)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold truncate">{u.displayName}</p>
                    {u.roleLabel && <p className="text-[11px] text-gray-400 truncate">{u.roleLabel}</p>}
                  </div>
                  {selected.includes(u.id) && <CheckCheck size={14} className="text-teal-600 shrink-0" />}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="mailbox-f246-2">متن نامه</label>
            <Textarea id="mailbox-f246-2" value={body} onChange={(e) => setBody(e.target.value)} placeholder="متن پیام..." className="rounded-lg resize-none" rows={6} />
          </div>

          <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
            {busy ? 'در حال ارسال...' : 'ارسال نامه'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── main mailbox component ─────────────────────────────────
export default function Mailbox({ activeTab: propTab }: { activeTab?: string }) {
  const [activeTab, setActiveTab] = useState<MailTab>(propTab === 'sent' ? 'sent' : 'inbox');
  const [letters, setLetters] = useState<Letter[]>([]);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const [users, setUsers] = useState<MailUser[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string>('');
  const [detail, setDetail] = useState<Letter | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [replyTo, setReplyTo] = useState<{ subject: string; senderId: string | null } | null>(null);

  // Load users (for compose + sender names) — the mail directory action
  // (v2.19.0): works for every mailbox user, no manage_users needed.
  useEffect(() => {
    (async () => {
      try {
        const data = await apiCall('directory');
        if (data.users) {
          setUsers(data.users.map((u: { id: string; displayName: string; roleLabel?: string }) => ({
            id: u.id, displayName: u.displayName, roleLabel: u.roleLabel,
          })));
        }
      } catch { /* directory optional — compose shows empty on failure */ }

      // Current user id (for sender resolution in sent view)
      try {
        const me = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'check' }),
        }).then((r) => r.json());
        if (me?.user?.id) setCurrentUserId(me.user.id);
      } catch { /* ignore */ }
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const action = activeTab === 'sent' ? 'list-sent' : 'list-inbox';
      const data = await apiCall(action, { page, pageSize });
      const resp = data as unknown as InboxResponse & SentResponse;
      setLetters(resp.letters || []);
      setTotal(resp.total || 0);
      if (resp.unreadCount !== undefined) setUnreadCount(resp.unreadCount);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در دریافت نامه‌ها');
      setLetters([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab, page]);

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `load` asynchronous (react-hooks/set-state-in-effect).
  useEffect(() => {
    queueMicrotask(load);
  }, [load]);

  const refreshUnread = useCallback(async () => {
    try {
      const data = await apiCall('unread-count');
      setUnreadCount(data.count || 0);
    } catch { /* ignore */ }
  }, []);

  const markRead = async (letter: Letter) => {
    try {
      await apiCall('mark-read', { id: letter.id });
      setLetters((prev) => prev.map((l) => (l.id === letter.id ? { ...l, isRead: true } : l)));
      refreshUnread();
    } catch { /* ignore */ }
  };

  const handleDelete = async (letter: Letter) => {
    try {
      await apiCall('delete', { id: letter.id });
      toast.success('نامه حذف شد');
      setDetail(null);
      load();
      refreshUnread();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در حذف');
    }
  };

  const openDetail = (letter: Letter) => setDetail(letter);

  const senderName = (letter: Letter): string => {
    if (letter.senderId === currentUserId) return 'شما';
    const u = users.find((x) => x.id === letter.senderId);
    return u?.displayName || 'کاربر حذف‌شده';
  };

  const filtered = useMemo(() => letters.filter((l) => {
    if (!search.trim()) return true;
    const q = search.trim();
    return l.subject.includes(q) || l.body.includes(q) || senderName(l).includes(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [letters, search, users, currentUserId]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice(0, pageSize);

  const stats = [
    { label: 'نامه‌های ورودی', value: toPersianNum(activeTab === 'inbox' ? total : total), icon: <Inbox size={15} />, color: '#1F8B7D', bg: '#ecfdf5' },
    { label: 'خوانده‌نشده', value: toPersianNum(unreadCount), icon: <Mail size={15} />, color: '#dc2626', bg: '#fef2f2' },
    { label: 'همکاران قابل ارسال', value: toPersianNum(users.length), icon: <Users size={15} />, color: '#6366f1', bg: '#eef2ff' },
  ];

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {stats.map((s, i) => (
          <div key={i} className="bg-white rounded-xl p-3.5 border border-gray-100 animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 50}ms` }}>
            <div className="flex items-center gap-2 mb-1.5">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: s.bg, color: s.color }}>{s.icon}</div>
              <span className="text-[11px] text-gray-400 hidden lg:block">{s.label}</span>
            </div>
            <p className="text-lg font-bold" style={{ color: s.color }}>{s.value}</p>
            <p className="text-[11px] text-gray-400 lg:hidden mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => { setActiveTab('inbox'); setPage(1); }}
              className={`relative flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all ${
                activeTab === 'inbox' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Inbox size={14} /> صندوق ورودی
              {unreadCount > 0 && (
                <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">{toPersianNum(unreadCount)}</span>
              )}
            </button>
            <button
              onClick={() => { setActiveTab('sent'); setPage(1); }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all ${
                activeTab === 'sent' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Send size={14} /> ارسالی‌ها
            </button>
          </div>

          <div className="relative flex-1">
            <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو در موضوع و متن..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" />
          </div>

          <button
            onClick={() => { setReplyTo(null); setShowCompose(true); }}
            className="h-9 gap-1.5 text-white text-xs rounded-lg px-3 font-medium flex items-center shrink-0"
            style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
          >
            <Plus size={13} /> نامهٔ جدید
          </button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <SkeletonList count={4} />
      ) : error ? (
        <div className="bg-white rounded-xl border border-red-100 p-10 text-center">
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <button onClick={load} className="text-xs text-teal-700 hover:underline">تلاش مجدد</button>
        </div>
      ) : paged.length === 0 ? (
        <div className="bg-white rounded-xl border border-dashed border-gray-200 p-12 text-center">
          <div className="w-14 h-14 rounded-2xl bg-gray-50 flex items-center justify-center mx-auto mb-3">
            <Mail size={22} className="text-gray-300" />
          </div>
          <p className="text-sm font-bold text-gray-600 mb-1">
            {activeTab === 'inbox' ? 'صندوق ورودی شما خالی است' : 'نامه‌ای ارسال نکرده‌اید'}
          </p>
          <p className="text-xs text-gray-400 mb-4">با اولین نامه، هماهنگی تیمی درون سامانه ثبت می‌شود</p>
          <button onClick={() => { setReplyTo(null); setShowCompose(true); }} className="text-xs text-teal-700 hover:underline font-medium">
            نوشتن نامهٔ جدید
          </button>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {paged.map((letter, i) => {
              const unread = activeTab === 'inbox' && letter.isRead === false;
              const readByAll = activeTab === 'sent' && letter.recipients?.every((r) => r.isRead);
              const readCount = letter.recipients?.filter((r) => r.isRead).length || 0;
              return (
                <button
                  key={letter.id}
                  onClick={() => openDetail(letter)}
                  className={`w-full text-right bg-white rounded-xl border transition-all hover:shadow-sm animate-fade-in-up opacity-0 ${
                    unread ? 'border-teal-200 bg-teal-50/30' : 'border-gray-100'
                  }`}
                  style={{ animationDelay: `${i * 30}ms` }}
                >
                  <div className="flex items-center gap-3 p-4">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                      unread ? 'bg-teal-100 text-teal-700' : 'bg-gray-100 text-gray-400'
                    }`}>
                      {unread ? <Mail size={16} /> : <MailOpen size={16} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <h4 className={`text-sm truncate ${unread ? 'font-extrabold text-gray-900' : 'font-bold text-gray-700'}`}>
                          {letter.subject}
                        </h4>
                        {unread && <span className="w-2 h-2 rounded-full bg-teal-500 shrink-0" />}
                        {readByAll && (
                          <Badge className="bg-emerald-50 text-emerald-600 hover:bg-emerald-50 text-[11px] shrink-0">
                            <CheckCheck size={9} className="ml-1" /> خوانده شد
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-gray-500">
                        <span className="flex items-center gap-1">
                          <UserIcon size={10} />
                          {activeTab === 'sent' ? `به ${toPersianNum(letter.recipients?.length || 0)} گیرنده` : senderName(letter)}
                        </span>
                        <span className="text-gray-300">|</span>
                        <span className="truncate">{(letter.body || '').slice(0, 60) || 'بدون متن'}</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end shrink-0 gap-1">
                      <span className="text-[11px] text-gray-400">{timeAgo(letter.createdAt)}</span>
                      {activeTab === 'sent' && letter.recipients && (
                        <span className="text-[11px] text-gray-400">
                          {toPersianNum(readCount)}/{toPersianNum(letter.recipients.length)} خوانده
                        </span>
                      )}
                      <ChevronDown size={12} className="text-gray-300" />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <PaginationControls page={safePage} totalPages={totalPages} total={total} onPageChange={setPage} label="نامه" />
        </>
      )}

      {/* Detail dialog */}
      {detail && (
        <LetterDetail
          letter={detail}
          senderName={senderName(detail)}
          users={users}
          onClose={() => setDetail(null)}
          onMarkRead={markRead}
          onReply={(l) => { setDetail(null); setReplyTo({ subject: l.subject, senderId: l.senderId }); setShowCompose(true); }}
          onDelete={handleDelete}
        />
      )}

      {/* Compose dialog */}
      <ComposeDialog
        users={users.filter((u) => u.id !== currentUserId)}
        open={showCompose}
        onOpenChange={setShowCompose}
        onSent={() => { load(); refreshUnread(); }}
        replyTo={replyTo}
      />
    </div>
  );
}
