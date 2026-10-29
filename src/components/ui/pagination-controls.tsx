'use client';

import React from 'react';
import { ChevronRight, ChevronLeft } from 'lucide-react';

function toPersianNum(n: number): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

interface PaginationControlsProps {
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
  label?: string;
}

/** RTL-aware pagination bar for list views (Didar/Payamgostar style). */
export default function PaginationControls({ page, totalPages, total, onPageChange, label = 'رکورد' }: PaginationControlsProps) {
  if (totalPages <= 1) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 px-4 py-2.5 flex items-center justify-between">
        <span className="text-[11px] text-gray-400">مجموع {toPersianNum(total)} {label}</span>
      </div>
    );
  }

  // Show up to 5 page buttons centered on current
  const pages: number[] = [];
  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  const end = Math.min(totalPages, start + 4);
  for (let p = start; p <= end; p++) pages.push(p);

  return (
    <div className="bg-white rounded-xl border border-gray-100 px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
      <span className="text-[11px] text-gray-400">
        نمایش صفحهٔ {toPersianNum(page)} از {toPersianNum(totalPages)} — مجموع {toPersianNum(total)} {label}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="w-8 h-8 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
          title="صفحهٔ قبل"
        >
          <ChevronRight size={14} />
        </button>
        {pages.map((p) => (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            className={`w-8 h-8 rounded-lg text-xs font-bold transition-colors ${
              p === page
                ? 'text-white shadow-sm'
                : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
            style={p === page ? { background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' } : undefined}
          >
            {toPersianNum(p)}
          </button>
        ))}
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="w-8 h-8 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
          title="صفحهٔ بعد"
        >
          <ChevronLeft size={14} />
        </button>
      </div>
    </div>
  );
}
