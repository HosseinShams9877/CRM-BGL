'use client';
// ════════════════════════════════════════════════════════════
// center-combobox.tsx — v2.34.0 generic searchable center picker
// Server-side debounced search via /api/centers (tenant- and
// permission-scoped). Replaces the legacy <select> limited to
// pageSize=200 — 1,508 migrated centers made a static dropdown
// unusable. Generic enough for any dialog needing a center ref.
//
// v2.38.0 (round 64) — PickedCenter grew the buyer-identity block
// + owning company: the quick-proforma «مشخصات خریدار» card now uses
// this picker and pre-fills straight from the picked row (the search
// action returns those fields since v2.38.0). All additions are
// OPTIONAL — the quick-activity usage is byte-identical. New `size`
// prop: 'sm' (default, the old look) / 'md' (the quick-proforma
// roomy form: h-11, rounded-xl, text-sm).
// ════════════════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { Search, X, Building2, Loader2 } from 'lucide-react';

export interface PickedCenter {
  id: string;
  name: string;
  city?: string | null;
  province?: string | null;
  // v2.38.0 — buyer-identity block + owning company (all optional:
  // legacy callers ignore them; present in /api/centers search rows).
  nationalId?: string | null;
  economicCode?: string | null;
  postalCode?: string | null;
  contactName?: string | null;
  address?: string | null;
  phone?: string | null;
  mobile?: string | null;
  company?: { slug: string; name: string } | null;
}

export function CenterCombobox({
  value,
  onChange,
  placeholder = 'جستجوی مرکز…',
  disabled,
  autoFocus,
  size = 'sm',
}: {
  value: PickedCenter | null;
  onChange: (c: PickedCenter | null) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** 'sm' = the legacy compact look (quick-activity dialogs) · 'md' = the
   *  roomy quick-proforma form. Default 'sm' — zero visual change for
   *  existing consumers. */
  size?: 'sm' | 'md';
}) {
  const md = size === 'md';
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PickedCenter[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // close on outside click
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // debounced server search
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/centers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'search', q, pageSize: 20 }),
        });
        const data = (await res.json()) as { centers?: PickedCenter[] };
        setItems(data.centers ?? []);
        setCursor(0);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [q, open]);

  const pick = (c: PickedCenter) => {
    onChange(c);
    setOpen(false);
    setQ('');
  };

  return (
    <div className="relative" ref={rootRef} data-center-combobox>
      <div className="relative">
        <Search size={md ? 16 : 14} className={`absolute end-3 top-1/2 -translate-y-1/2 text-gray-400 ${md ? 'pe-0.5' : ''}`} />
        {value ? (
          <div
            className={`flex items-center justify-between ${md ? 'h-11 rounded-xl border border-gray-200 bg-white px-3.5' : 'h-10 rounded-lg border border-gray-200 bg-white px-3'}`}
            data-combobox-selected
          >
            <span className={`flex items-center gap-2 ${md ? 'text-sm' : 'text-xs'} text-gray-800 font-medium truncate`}>
              <Building2 size={md ? 15 : 13} className="text-teal-600 shrink-0" />
              {value.name}
              {value.city ? <span className="text-gray-400 font-normal">— {value.city}</span> : null}
            </span>
            {!disabled && (
              <button type="button" onClick={() => onChange(null)} className="text-gray-400 hover:text-red-500 shrink-0 ms-2" aria-label="حذف انتخاب">
                <X size={md ? 15 : 14} />
              </button>
            )}
          </div>
        ) : (
          <input
            data-combobox-input
            type="text"
            dir="rtl"
            disabled={disabled}
            autoFocus={autoFocus}
            value={q}
            onFocus={() => setOpen(true)}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, items.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
              else if (e.key === 'Enter' && open && items[cursor]) { e.preventDefault(); pick(items[cursor]); }
              else if (e.key === 'Escape') { setOpen(false); }
            }}
            placeholder={placeholder}
            className={md
              ? 'w-full h-11 rounded-xl border border-gray-200 bg-white px-3.5 pe-10 text-sm focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400'
              : 'w-full h-10 rounded-lg border border-gray-200 bg-white px-3 pe-9 text-xs focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400'}
          />
        )}
      </div>
      {open && !value && (
        <div className={`absolute z-50 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-gray-100 ${md ? 'rounded-xl shadow-xl' : 'rounded-xl shadow-lg'}`} data-combobox-list>
          {loading ? (
            <div className={`p-3 ${md ? 'text-[13px]' : 'text-xs'} text-gray-400 flex items-center gap-2`}><Loader2 size={13} className="animate-spin" /> در حال جستجو…</div>
          ) : items.length === 0 ? (
            <div className={`p-3 ${md ? 'text-[13px]' : 'text-xs'} text-gray-400`}>موردی یافت نشد</div>
          ) : items.map((c, i) => (
            <button
              key={c.id}
              type="button"
              data-combobox-option={c.id}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(c)}
              className={'w-full text-right px-3 py-2 flex items-center gap-2 ' + (md ? 'text-sm' : 'text-xs') + ' ' + (i === cursor ? 'bg-teal-50 text-teal-800' : 'text-gray-700 hover:bg-gray-50')}
            >
              <Building2 size={md ? 14 : 13} className="text-gray-400 shrink-0" />
              <span className="font-medium truncate">{c.name}</span>
              {c.city ? <span className="text-gray-400">— {c.city}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
