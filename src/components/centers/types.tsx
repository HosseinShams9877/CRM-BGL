import React from 'react';
import { Building2, Heart, Globe, FolderTree, Layers, Briefcase, Beaker } from 'lucide-react';


// ==================== TYPES ====================
// v2.26.0 — «contracts» = the cooperation-terms view behind the BGL
// «قراردادها» menu item (it previously fell through to the plain list).
export type CentersTab = 'list' | 'individuals' | 'contacts' | 'categories' | 'map' | 'contracts';
export type CenterCategory = 'hospital' | 'lab' | 'pharma' | 'university' | 'industry' | 'clinic' | 'other';
export type CenterStatus = 'active' | 'inactive' | 'prospect' | 'suspended';
export type CenterGrade = 'A' | 'B' | 'C' | 'D';
export type ViewMode = 'grid' | 'table';

export interface CenterContact {
  id: string;
  fullName: string;
  role: string;
  phone: string;
  mobile: string;
  email: string;
  isPrimary: boolean;
  /** آیا این شخص رابط شرکت است؟ (دسترسی به رگ خواب) */
  isAgent: boolean;
  notes: string;
  /** شناسهٔ ردیف CenterContact برای API رگ خواب */
  contactId?: string;
  centerId?: string;
  centerName?: string;
}

export interface Center {
  id: string;
  name: string;
  /** company id needed by the followups API (populated in the list view; optional elsewhere) */
  followupCompanyId?: string;
  category: CenterCategory;
  status: CenterStatus;
  grade: CenterGrade;
  /** مدل کسب‌وکار (v2.6.0) */
  customerType: 'organization' | 'end_user';
  segment: string; // government | private | partner | ''
  mobile: string;
  loyaltyPoints: number;
  paymentBehavior: string; // good_payer | bad_payer | unknown
  commissionPercent: number;
  city: string;
  province: string;
  address: string;
  phone: string;
  website: string;
  contacts: CenterContact[];
  totalSales: number;
  orderCount: number;
  lastOrderDate: string;
  lastFollowup: string;
  tags: string[];
  notes: string;
  isFavorite: boolean;
  /** v2.23.0 — optimistic-concurrency token for the edit dialog (stale → 409) */
  updatedAt?: string;
  /** v2.26.2 — numeric CAS token (exact compare; preferred over updatedAt) */
  version?: number;
  /** v2.31.9 — buyer identity block (Lian proforma format): pre-fills the
   *  پیش‌فاکتور data-entry form and prints in «مشخصات خریدار». */
  nationalId?: string | null;
  economicCode?: string | null;
  postalCode?: string | null;
  /** کارشناس خرید — the buyer-side contact printed on the proforma. */
  contactName?: string | null;
}

export interface Contact {
  id: string;
  fullName: string;
  role: string;
  centerName: string;
  centerId: string;
  phone: string;
  mobile: string;
  email: string;
  city: string;
  isPrimary: boolean;
  lastContactDate: string;
  totalCalls: number;
}

export interface Category {
  id: string;
  key: CenterCategory;
  name: string;
  icon: React.ReactNode;
  color: string;
  bg: string;
  count: number;
  totalSales: number;
}

// ==================== CONFIGS ====================
export const CATEGORY_CFG: Record<CenterCategory, { label: string; icon: React.ReactNode; color: string; bg: string }> = {
  hospital: { label: 'بیمارستان', icon: <Heart size={14} />, color: '#dc2626', bg: '#fef2f2' },
  lab: { label: 'آزمایشگاه', icon: <Beaker size={14} />, color: '#0891b2', bg: '#ecfeff' },
  pharma: { label: 'داروسازی', icon: <Briefcase size={14} />, color: '#7c3aed', bg: '#f5f3ff' },
  university: { label: 'دانشگاه', icon: <Globe size={14} />, color: '#059669', bg: '#ecfdf5' },
  industry: { label: 'صنعتی', icon: <Layers size={14} />, color: '#d97706', bg: '#fffbeb' },
  clinic: { label: 'کلینیک', icon: <Building2 size={14} />, color: '#1F8B7D', bg: '#ecfdf5' },
  other: { label: 'سایر', icon: <FolderTree size={14} />, color: '#6b7280', bg: '#f3f4f6' },
};

export const STATUS_CFG: Record<CenterStatus, { label: string; color: string; bg: string }> = {
  active: { label: 'فعال', color: '#059669', bg: '#ecfdf5' },
  inactive: { label: 'غیرفعال', color: '#6b7280', bg: '#f3f4f6' },
  prospect: { label: 'سرنخ', color: '#6366f1', bg: '#eef2ff' },
  suspended: { label: 'معلق', color: '#d97706', bg: '#fffbeb' },
};

export const GRADE_CFG: Record<CenterGrade, { label: string; color: string; bg: string; stars: number }> = {
  A: { label: 'عالی', color: '#d97706', bg: '#fffbeb', stars: 4 },
  B: { label: 'خوب', color: '#059669', bg: '#ecfdf5', stars: 3 },
  C: { label: 'متوسط', color: '#0891b2', bg: '#ecfeff', stars: 2 },
  D: { label: 'ضعیف', color: '#6b7280', bg: '#f3f4f6', stars: 1 },
};

// ==================== BUSINESS-MODEL BADGES (v2.6.0) ====================
export const TYPE_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  organization: { label: 'سازمانی', color: '#1d4ed8', bg: '#eff6ff' },
  end_user: { label: 'مشتری نهایی', color: '#7c3aed', bg: '#f5f3ff' },
};

export const SEGMENT_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  government: { label: 'دولتی', color: '#0e7490', bg: '#ecfeff' },
  private: { label: 'خصوصی', color: '#059669', bg: '#ecfdf5' },
  partner: { label: 'همکار / نماینده', color: '#b45309', bg: '#fffbeb' },
};

export const BEHAVIOR_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  good_payer: { label: 'خوش‌حساب', color: '#059669', bg: '#ecfdf5' },
  bad_payer: { label: 'بدحساب', color: '#dc2626', bg: '#fef2f2' },
  unknown: { label: 'خوش‌حسابی نامشخص', color: '#6b7280', bg: '#f3f4f6' },
};

// ==================== HELPERS ====================
export function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

export function formatCurrency(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد ریال';
  if (amount >= 1_000_000) return toPersianNum((amount / 1_000_000).toFixed(0)) + ' میلیون ریال';
  return toPersianNum(amount.toLocaleString()) + ' ریال';
}
