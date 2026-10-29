'use client';

// ════════════════════════════════════════════════════════════════
// time-picker.tsx — v2.37.0 (round 63) shared click-to-select TIME
// picker — the twin of JalaliDatePicker.
//
// THE USER'S REQUIREMENT: the time must be selectable by CLICKING a
// popup, exactly like the Shamsi date — no typing. The input is
// read-only (shows the picked time in Persian digits); clicking it
// (or the clock icon) opens the popup: a 24-hour grid, a 5-minute
// grid, quick chips and «الان».
//
// VALUE CONTRACT (identical to the old typed/native inputs):
//   value    : 'HH:MM' (Latin digits, 24h) or '' when nothing is
//              picked yet (optional time fields)
//   onChange : called with the same 'HH:MM' string
//
// Draft semantics: clicking an hour only highlights it; the value is
// EMITTED once hour AND minute are both known (a minute click with no
// hour yet adopts the current hour), then the popup closes.
// ════════════════════════════════════════════════════════════════

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Clock, X, Zap } from 'lucide-react';
import { toPersianTime, timeParts, nowTimeValue } from '@/lib/time-utils';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

/** Quick presets — the hours a sales floor actually schedules around. */
const QUICK_TIMES: { label: string; value: string }[] = [
  { label: '۸ صبح', value: '08:00' },
  { label: '۱۲ ظهر', value: '12:00' },
  { label: '۱۷ عصر', value: '17:00' },
];

export interface TimePickerProps {
  /** Selected time 'HH:MM' ('' = nothing selected). */
  value: string;
  /** Receives the picked time 'HH:MM'. */
  onChange: (time: string) => void;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  /** Extra classes for the input (height/rounding per surface). */
  inputClassName?: string;
  /** Show the «پاک کردن» (clear) action — for OPTIONAL time fields. */
  allowClear?: boolean;
  /** Disable the control (used by busy/submitting states). */
  disabled?: boolean;
}

export function TimePicker({
  value,
  onChange,
  id,
  ariaLabel = 'انتخاب ساعت',
  placeholder = '۰۹:۳۰',
  inputClassName = 'h-10 rounded-lg',
  allowClear = false,
  disabled = false,
}: TimePickerProps) {
  const [open, setOpen] = useState(false);
  // v2.37.0 — collision handling: near the viewport bottom the popup
  // would be clipped, so it flips ABOVE the input instead.
  const [dropUp, setDropUp] = useState(false);
  // draft {h, m} — only emitted once BOTH are known
  const [draft, setDraft] = useState<{ h: number | null; m: number | null }>(() => {
    const p = timeParts(value);
    return p ? { h: p[0], m: p[1] } : { h: null, m: null };
  });
  const boxRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // popup's approximate rendered height (header + grids + chips + footer)
  const POPUP_HEIGHT = 430;

  // post-render clamp: if the flip estimate was off by a few pixels the
  // popup can still poke past the viewport edge — nudge it back in.
  useEffect(() => {
    if (!open) return;
    const el = popupRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let dy = 0;
    if (r.top < 8) dy = 8 - r.top;
    else if (r.bottom > window.innerHeight - 8) dy = window.innerHeight - 8 - r.bottom;
    if (dy !== 0) el.style.transform = `translateY(${Math.round(dy)}px)`;
    return () => { el.style.transform = ''; };
  }, [open]);

  // outside click + Escape close (cancel — an incomplete draft is dropped)
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = useCallback(() => {
    if (disabled) return;
    setOpen((o) => {
      if (!o) {
        // re-anchor the draft on the current value every open
        const p = timeParts(value);
        setDraft(p ? { h: p[0], m: p[1] } : { h: null, m: null });
        // flip above the input when there is no room below
        const rect = boxRef.current?.getBoundingClientRect();
        if (rect) {
          const spaceBelow = window.innerHeight - rect.bottom;
          const spaceAbove = rect.top;
          setDropUp(spaceBelow < POPUP_HEIGHT && spaceAbove > spaceBelow);
        } else {
          setDropUp(false);
        }
      }
      return !o;
    });
  }, [disabled, value]);

  const pickHour = (h: number) => {
    setDraft((d) => {
      const next = { ...d, h };
      if (next.m !== null) {
        onChange(`${String(h).padStart(2, '0')}:${String(next.m).padStart(2, '0')}`);
        setOpen(false);
      }
      return next;
    });
  };

  const pickMinute = (m: number) => {
    // no hour chosen yet → adopt the current hour
    const h = draft.h ?? new Date().getHours();
    onChange(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    setDraft({ h, m });
    setOpen(false);
  };

  const pickNow = () => {
    const now = nowTimeValue();
    onChange(now);
    const p = timeParts(now);
    setDraft(p ? { h: p[0], m: p[1] } : { h: null, m: null });
    setOpen(false);
  };

  const pickQuick = (t: string) => {
    onChange(t);
    const p = timeParts(t);
    setDraft(p ? { h: p[0], m: p[1] } : { h: null, m: null });
    setOpen(false);
  };

  const display = value ? toPersianTime(value) : '';
  const previewH = draft.h !== null ? toPersianTime(String(draft.h).padStart(2, '0')) : '۰۰';
  const previewM = draft.m !== null ? toPersianTime(String(draft.m).padStart(2, '0')) : '۰۰';
  const previewDim = draft.h === null || draft.m === null;

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <input
          id={id}
          type="text"
          readOnly
          role="button"
          tabIndex={0}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={ariaLabel}
          title="برای انتخاب ساعت کلیک کنید"
          value={display}
          placeholder={placeholder}
          onClick={toggle}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
          disabled={disabled}
          dir="ltr"
          className={`w-full ${inputClassName} bg-white border border-gray-200 text-center text-xs text-gray-800 placeholder:text-gray-300 cursor-pointer focus:outline-none focus:ring-2 focus:ring-teal-200 focus:border-teal-300 transition-colors pr-3 pl-9 ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
        />
        <button
          type="button"
          onClick={toggle}
          aria-label={open ? 'بستن انتخاب ساعت' : 'باز کردن انتخاب ساعت'}
          className="absolute left-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-teal-600 hover:bg-teal-50 transition-colors"
          tabIndex={-1}
        >
          <Clock size={16} />
        </button>
      </div>

      {open && (
        <div
          ref={popupRef}
          role="dialog"
          aria-label="انتخاب ساعت"
          className={`absolute ${dropUp ? 'bottom-full mb-2' : 'top-full mt-2'} right-0 z-50 w-[300px] max-h-[calc(100vh-2rem)] overflow-y-auto bg-white rounded-2xl border border-gray-100 shadow-2xl animate-in fade-in slide-in-from-top-1 duration-150 select-none`}
        >
          {/* gradient header — matches the JalaliDatePicker identity */}
          <div className="px-3 py-2.5 flex items-center justify-between" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
            <div className="flex items-center gap-1.5 text-white">
              <Clock size={13} className="opacity-80" />
              <span className="text-xs font-bold">انتخاب ساعت</span>
            </div>
            <span dir="ltr" className={`text-sm font-bold tracking-wide ${previewDim ? 'text-white/50' : 'text-white'}`}>
              {previewH}:{previewM}
            </span>
          </div>

          <div className="p-3 space-y-2.5">
            {/* hours */}
            <div>
              <p className="text-[10px] font-bold text-gray-400 mb-1">ساعت</p>
              <div className="grid grid-cols-6 gap-1" role="group" aria-label="ساعت">
                {HOURS.map((h) => {
                  const on = draft.h === h;
                  return (
                    <button
                      key={h}
                      type="button"
                      onClick={() => pickHour(h)}
                      aria-label={`ساعت ${toPersianTime(String(h).padStart(2, '0'))}`}
                      aria-pressed={on}
                      className={`h-8 rounded-[10px] text-[11px] font-medium transition-all flex items-center justify-center ${
                        on
                          ? 'text-white shadow-sm'
                          : 'text-gray-600 bg-gray-50/70 hover:bg-teal-50 hover:text-teal-700'
                      }`}
                      style={on ? { background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' } : undefined}
                    >
                      {toPersianTime(String(h).padStart(2, '0'))}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* minutes */}
            <div>
              <p className="text-[10px] font-bold text-gray-400 mb-1">دقیقه</p>
              <div className="grid grid-cols-6 gap-1" role="group" aria-label="دقیقه">
                {MINUTES.map((m) => {
                  const on = draft.m === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => pickMinute(m)}
                      aria-label={`دقیقه ${toPersianTime(String(m).padStart(2, '0'))}`}
                      aria-pressed={on}
                      className={`h-8 rounded-[10px] text-[11px] font-medium transition-all flex items-center justify-center ${
                        on
                          ? 'text-white shadow-sm'
                          : 'text-gray-600 bg-gray-50/70 hover:bg-teal-50 hover:text-teal-700'
                      }`}
                      style={on ? { background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' } : undefined}
                    >
                      {toPersianTime(String(m).padStart(2, '0'))}
                    </button>
                  );
                })}
              </div>
              <p className="text-[9px] text-gray-300 mt-1 leading-4">برای دقیقه‌های دیگر، نزدیک‌ترین مقدار ۵تایی را انتخاب کنید.</p>
            </div>

            {/* quick presets */}
            <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-gray-50">
              <button
                type="button"
                onClick={pickNow}
                className="flex items-center gap-1 text-[11px] font-bold text-white px-2.5 py-1.5 rounded-lg transition-transform hover:scale-[1.03] active:scale-95"
                style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
                aria-label="همین حالا"
              >
                <Zap size={11} /> الان {toPersianTime(nowTimeValue())}
              </button>
              {QUICK_TIMES.map((q) => (
                <button
                  key={q.value}
                  type="button"
                  onClick={() => pickQuick(q.value)}
                  className="text-[11px] font-medium text-teal-700 bg-teal-50 border border-teal-100 px-2.5 py-1.5 rounded-lg hover:bg-teal-100 transition-colors"
                  aria-label={`ساعت ${q.label}`}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>

          {/* footer */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-gray-50 bg-gray-50/40">
            <span className="text-[10px] text-gray-400">با انتخاب ساعت و دقیقه، ساعت ثبت می‌شود</span>
            {allowClear && (
              <button
                type="button"
                onClick={() => { onChange(''); setDraft({ h: null, m: null }); setOpen(false); }}
                className="text-[11px] text-gray-400 hover:bg-gray-100 px-2 py-1 rounded-md transition-colors flex items-center gap-1"
                aria-label="پاک کردن ساعت"
              >
                <X size={11} /> پاک کردن
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
