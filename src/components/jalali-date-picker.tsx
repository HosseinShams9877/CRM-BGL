'use client';

// ════════════════════════════════════════════════════════════════
// jalali-date-picker.tsx — v2.37.0 (round 63) shared Jalali
// (Shamsi) date picker: a read-only input + POPUP CALENDAR.
//
// THE USER'S REQUIREMENT: everywhere the project takes a date, the
// calendar must be PERSIAN, and selecting a date must happen by
// CLICKING a popup calendar — no typing required. The input is
// read-only (shows the selected Jalali date in Persian digits);
// clicking it (or the calendar icon) opens the popup below.
//
// v2.37.0 — PROFESSIONAL REDESIGN (user request «تقویم هم حرفه‌ای و
// جذاب»): gradient identity header (month + year navigation), a
// soft weekday strip, REAL adjacent-month days in the padding cells
// (clickable — they select directly), larger rounded day cells with
// smooth hover/today/selected states, and a footer showing today's
// full Jalali date with a one-click «برو به امروز».
//
// VALUE CONTRACT (identical to the previous typed inputs):
//   value    : Jalali 'YYYY/MM/DD' (jalaliPartsToString format)
//              or '' when nothing is selected yet (optional fields)
//   onChange : called with the same 'YYYY/MM/DD' string
//
// Consumers keep their existing state/validation untouched — the
// picker is a drop-in replacement for the old <Input> fields.
// ════════════════════════════════════════════════════════════════

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { CalendarDays, X, ChevronRight, ChevronLeft, Sparkles } from 'lucide-react';
import {
  gregorianToJalali,
  jalaliToGregorian,
  jalaliMonthLength,
  parseJalaliDate,
  jalaliPartsToString,
  jalaliMonthName,
  jalaliWeekDay,
} from '@/lib/jalali';

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
function toPersianDigits(text: string | number): string {
  return String(text).replace(/[0-9]/g, (c) => PERSIAN_DIGITS[Number(c)]);
}

/** Persian week starts شنبه (Saturday). Column index of a JS day. */
function weekColumn(jsDay: number): number {
  return (jsDay + 1) % 7; // Sat(6)→0 … Fri(5)→6
}

const WEEK_DAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];

export interface JalaliDatePickerProps {
  /** Selected Jalali date 'YYYY/MM/DD' ('' = nothing selected). */
  value: string;
  /** Receives the picked Jalali date 'YYYY/MM/DD'. */
  onChange: (jalali: string) => void;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  /** Extra classes for the input (height/rounding per surface). */
  inputClassName?: string;
  /** Show the «پاک کردن» (clear) action — for OPTIONAL date fields. */
  allowClear?: boolean;
  /** Disable the control (used by busy/submitting states). */
  disabled?: boolean;
}

interface DayCell {
  key: string; // Jalali 'YYYY/MM/DD'
  jd: number;
  inMonth: boolean;
}

export function JalaliDatePicker({
  value,
  onChange,
  id,
  ariaLabel = 'انتخاب تاریخ شمسی',
  placeholder = '۱۴۰۵/۰۶/۱۵',
  inputClassName = 'h-10 rounded-lg',
  allowClear = false,
  disabled = false,
}: JalaliDatePickerProps) {
  const [open, setOpen] = useState(false);
  // v2.37.0 — collision handling: near the viewport bottom the popup
  // would be clipped, so it flips ABOVE the input instead.
  const [dropUp, setDropUp] = useState(false);
  // month/year the popup is browsed on (defaults to value's month / today)
  const [view, setView] = useState<{ jy: number; jm: number }>(() => {
    const parsed = parseJalaliDate(value);
    if (parsed) return { jy: parsed[0], jm: parsed[1] };
    const [jy, jm] = gregorianToJalali(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
    return { jy, jm };
  });
  const boxRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // popup's approximate rendered height (gradient header + weekday
  // strip + 6×7 day grid + footer)
  const POPUP_HEIGHT = 420;

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

  // NOTE: no effect syncs `view` with `value` — toggle() re-anchors the
  // browsed month on every open, which is the only moment it matters
  // (and keeps the effect body free of synchronous setState).

  // outside click + Escape close
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

  // open → browse the selected month (or today's)
  const toggle = useCallback(() => {
    if (disabled) return;
    setOpen((o) => {
      if (!o) {
        const parsed = parseJalaliDate(value);
        if (parsed) setView({ jy: parsed[0], jm: parsed[1] });
        else {
          const [jy, jm] = gregorianToJalali(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
          setView({ jy, jm });
        }
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

  const todayJalali = useMemo(() => {
    const [jy, jm, jd] = gregorianToJalali(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
    return { key: jalaliPartsToString(jy, jm, jd), jy, jm, jd };
  }, []);

  const todayKey = todayJalali.key;

  // Full 6×7 grid with REAL adjacent-month days in the padding cells.
  const monthDays = useMemo(() => {
    const length = jalaliMonthLength(view.jy, view.jm);
    const [gy, gm, gd] = jalaliToGregorian(view.jy, view.jm, 1);
    const firstCol = weekColumn(new Date(gy, gm - 1, gd).getDay());
    const prevMonth = view.jm === 1 ? 12 : view.jm - 1;
    const prevYear = view.jm === 1 ? view.jy - 1 : view.jy;
    const prevLen = jalaliMonthLength(prevYear, prevMonth);
    const nextMonth = view.jm === 12 ? 1 : view.jm + 1;
    const nextYear = view.jm === 12 ? view.jy + 1 : view.jy;

    const cells: DayCell[] = [];
    for (let i = firstCol - 1; i >= 0; i--) {
      const jd = prevLen - i;
      cells.push({ key: jalaliPartsToString(prevYear, prevMonth, jd), jd, inMonth: false });
    }
    for (let jd = 1; jd <= length; jd++) {
      cells.push({ key: jalaliPartsToString(view.jy, view.jm, jd), jd, inMonth: true });
    }
    let nextDay = 1;
    while (cells.length % 7 !== 0 || cells.length < 42) {
      cells.push({ key: jalaliPartsToString(nextYear, nextMonth, nextDay), jd: nextDay, inMonth: false });
      nextDay++;
    }
    return cells;
  }, [view]);

  const pick = (key: string) => {
    onChange(key);
    setOpen(false);
  };

  const goToday = () => {
    setView({ jy: todayJalali.jy, jm: todayJalali.jm });
    pick(todayKey);
  };

  const shiftMonth = (delta: number) => {
    setView((v) => {
      let jy = v.jy;
      let jm = v.jm + delta;
      if (jm > 12) { jm = 1; jy += 1; }
      if (jm < 1) { jm = 12; jy -= 1; }
      return { jy, jm };
    });
  };

  const shiftYear = (delta: number) => setView((v) => ({ ...v, jy: v.jy + delta }));

  const display = value ? toPersianDigits(value) : '';

  // footer preview: today's full Jalali date, e.g. «شنبه ۸ شهریور ۱۴۰۵»
  const todayFullLabel = useMemo(() => {
    const g = new Date();
    const wd = jalaliWeekDay(g.getDay());
    return `${wd} ${toPersianDigits(todayJalali.jd)} ${jalaliMonthName(todayJalali.jm)} ${toPersianDigits(todayJalali.jy)}`;
  }, [todayJalali]);

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
          title="برای انتخاب تاریخ کلیک کنید"
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
          aria-label={open ? 'بستن تقویم' : 'باز کردن تقویم'}
          className="absolute left-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-teal-600 hover:bg-teal-50 transition-colors"
          tabIndex={-1}
        >
          <CalendarDays size={16} />
        </button>
      </div>

      {open && (
        <div
          ref={popupRef}
          role="dialog"
          aria-label={`تقویم ${jalaliMonthName(view.jm)} ${toPersianDigits(view.jy)}`}
          className={`absolute ${dropUp ? 'bottom-full mb-2' : 'top-full mt-2'} right-0 z-50 w-[308px] max-h-[calc(100vh-2rem)] overflow-y-auto bg-white rounded-2xl border border-gray-100 shadow-2xl animate-in fade-in slide-in-from-top-1 duration-150 select-none`}
        >
          {/* ── identity header: month nav on the gradient ── */}
          <div className="px-3 pt-3 pb-2.5" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
            <div className="flex items-center justify-between">
              <button type="button" onClick={() => shiftMonth(1)} aria-label="ماه بعد" className="p-1.5 rounded-lg text-white/90 hover:bg-white/15 transition-colors">
                <ChevronLeft size={16} />
              </button>
              <div className="text-center">
                <p className="text-sm font-bold text-white leading-5">{jalaliMonthName(view.jm)}</p>
              </div>
              <button type="button" onClick={() => shiftMonth(-1)} aria-label="ماه قبل" className="p-1.5 rounded-lg text-white/90 hover:bg-white/15 transition-colors">
                <ChevronRight size={16} />
              </button>
            </div>
            {/* year navigation */}
            <div className="flex items-center justify-center gap-2 mt-1">
              <button type="button" onClick={() => shiftYear(-1)} aria-label="سال قبل" className="px-2 py-0.5 rounded-md text-white/70 hover:text-white hover:bg-white/15 text-xs transition-colors">«</button>
              <span className="text-[13px] font-bold text-white tracking-wide">{toPersianDigits(view.jy)}</span>
              <button type="button" onClick={() => shiftYear(1)} aria-label="سال بعد" className="px-2 py-0.5 rounded-md text-white/70 hover:text-white hover:bg-white/15 text-xs transition-colors">»</button>
            </div>
          </div>

          {/* ── weekday strip ── */}
          <div className="grid grid-cols-7 gap-1 px-2 pt-2 pb-1">
            {WEEK_DAYS.map((d, i) => (
              <div key={d} className={`h-6 flex items-center justify-center text-[10px] font-bold ${i === 6 ? 'text-red-400' : 'text-gray-400'}`}>{d}</div>
            ))}
          </div>

          {/* ── day grid (real adjacent-month days in the padding) ── */}
          <div className="grid grid-cols-7 gap-1 px-2 pb-2">
            {monthDays.map((cell) => {
              const selected = cell.key === value;
              const isToday = cell.key === todayKey;
              return (
                <button
                  key={cell.key}
                  type="button"
                  onClick={() => pick(cell.key)}
                  aria-label={cell.key}
                  aria-current={isToday ? 'date' : undefined}
                  className={`relative h-9 rounded-[10px] text-xs font-medium transition-all flex items-center justify-center ${
                    selected
                      ? 'text-white shadow-md scale-[1.06] font-bold'
                      : isToday
                        ? 'ring-2 ring-teal-400 text-teal-700 font-bold hover:bg-teal-50'
                        : cell.inMonth
                          ? 'text-gray-700 hover:bg-teal-50 hover:text-teal-700'
                          : 'text-gray-300 hover:bg-gray-50 hover:text-gray-400'
                  }`}
                  style={selected ? { background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' } : undefined}
                >
                  {toPersianDigits(cell.jd)}
                  {isToday && !selected && (
                    <span className="absolute bottom-1 w-1 h-1 rounded-full bg-teal-500" />
                  )}
                  {isToday && selected && (
                    <span className="absolute bottom-1 w-1 h-1 rounded-full bg-white/90" />
                  )}
                </button>
              );
            })}
          </div>

          {/* ── footer: today preview + clear ── */}
          <div className="flex items-center justify-between px-2.5 py-2 border-t border-gray-50 bg-gray-50/40">
            <button
              type="button"
              onClick={goToday}
              className="flex items-center gap-1.5 text-[11px] font-bold text-teal-700 hover:bg-teal-50 px-2 py-1 rounded-md transition-colors"
              aria-label="برو به امروز"
            >
              <Sparkles size={11} /> امروز: {todayFullLabel}
            </button>
            {allowClear && (
              <button
                type="button"
                onClick={() => { onChange(''); setOpen(false); }}
                className="text-[11px] text-gray-400 hover:bg-gray-100 px-2 py-1 rounded-md transition-colors flex items-center gap-1"
                aria-label="پاک کردن تاریخ"
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
