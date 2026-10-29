'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Paperclip, Download, Trash2, FileText, Loader2 } from 'lucide-react';
import { toJalaliString } from '@/lib/jalali';
import { toPersianNum } from './types';

// ==================== CENTER FILES (v2.19.0) ====================
// Wires the real /api/files module (real disk storage + SHA-256 checksums,
// built in v2.9.0) into the UI for the first time. Permission checks stay
// server-side: a 403 on the first list call collapses the whole section —
// users without upload_files simply don't see it.

interface FileRecord {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  category: string | null;
  createdAt: string;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${toPersianNum((bytes / (1024 * 1024)).toFixed(1))} مگابایت`;
  if (bytes >= 1024) return `${toPersianNum(Math.round(bytes / 1024))} کیلوبایت`;
  return `${toPersianNum(bytes)} بایت`;
}

export function CenterFiles({ centerId }: { centerId: string }) {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', centerId }),
      });
      if (res.status === 403) { setState('forbidden'); return; }
      if (!res.ok) { setState('error'); return; }
      const data = await res.json();
      setFiles(Array.isArray(data.files) ? data.files : []);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [centerId]);

  useEffect(() => {
    // Deferred via microtask — keeps the synchronous setState out of the
    // effect body (react-hooks/set-state-in-effect), same pattern as mailbox.
    queueMicrotask(load);
  }, [load]);

  const handleUpload = async (file: File) => {
    setBusy(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('centerId', centerId);
      const res = await fetch('/api/files', { method: 'POST', body: form });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUploadError(data.error || 'بارگذاری فایل ناموفق بود.');
        return;
      }
      await load();
    } catch {
      setUploadError('بارگذاری فایل ناموفق بود.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      if (res.ok) setFiles((prev) => prev.filter((f) => f.id !== id));
    } catch { /* list stays as-is */ }
    finally { setBusy(false); }
  };

  if (state === 'forbidden') return null; // no upload_files permission — hidden
  if (state === 'error') {
    return (
      <div className="text-center py-3 text-xs text-gray-400">
        بارگذاری فایل‌ها ناموفق بود —{' '}
        <button onClick={load} className="text-teal-600 hover:underline">تلاش مجدد</button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-bold text-gray-900 flex items-center gap-2">
          <Paperclip size={15} className="text-teal-600" /> اسناد و فایل‌ها ({toPersianNum(files.length)})
        </h4>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          aria-label="انتخاب فایل برای بارگذاری"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="h-8 gap-1.5 text-xs rounded-lg"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Paperclip size={12} />}
          بارگذاری فایل
        </Button>
      </div>

      {uploadError && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2 mb-2">{uploadError}</p>
      )}

      {state === 'loading' ? (
        <div className="flex items-center justify-center gap-2 py-4 text-gray-400 text-xs">
          <Loader2 size={14} className="animate-spin" /> در حال بارگذاری...
        </div>
      ) : files.length === 0 ? (
        <div className="text-center py-4 text-gray-400 text-xs border border-dashed border-gray-200 rounded-xl">
          فایلی برای این مرکز ثبت نشده است
        </div>
      ) : (
        <div className="space-y-2">
          {files.map((f) => (
            <div key={f.id} className="flex items-center gap-3 p-2.5 bg-gray-50 rounded-xl">
              <div className="w-8 h-8 rounded-lg bg-teal-50 text-teal-600 flex items-center justify-center shrink-0">
                <FileText size={14} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate" title={f.originalName}>{f.originalName}</p>
                <p className="text-[11px] text-gray-400">
                  {formatSize(f.size)} · {toJalaliString(f.createdAt)}
                </p>
              </div>
              <a
                href={`/api/files?id=${encodeURIComponent(f.id)}`}
                className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center hover:bg-blue-100 transition-colors shrink-0"
                aria-label={`دانلود ${f.originalName}`}
              >
                <Download size={14} />
              </a>
              <button
                onClick={() => handleDelete(f.id)}
                disabled={busy}
                className="w-8 h-8 rounded-lg bg-red-50 text-red-600 flex items-center justify-center hover:bg-red-100 transition-colors shrink-0 disabled:opacity-50"
                aria-label={`حذف ${f.originalName}`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
