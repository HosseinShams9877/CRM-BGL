// ════════════════════════════════════════════════════════
// Static display defaults for CompanyReportDashboard.
// Extracted from company-report-dashboard.tsx (P2-2
// decomposition) — pure data, no JSX, no client hooks.
// Real numbers are merged over these at runtime from
// /api/stats; zeroed fields stay zero when no real data
// exists (see the merge in the component).
// ════════════════════════════════════════════════════════

export type CompanySlug = 'bazargani' | 'aria' | 'bgl' | 'yasteb';

export interface CompanyReportDashboardProps {
  companySlug: CompanySlug;
  companyName: string;
  companyType: string;
  color: string;
  accent: string;
}

export interface CompanyDatum {
  totalSales: number; targetSales: number; lastMonthSales: number;
  activeCenters: number; totalCenters: number; newCenters: number;
  pendingInvoices: number; totalInvoices: number;
  collectionRate: number; avgPaymentDays: number;
  pipelineCount: number; pipelineValue: number;
  wonDeals: number; lostDeals: number; winRate: number;
  visits: number; calls: number; emails: number;
  overdueFollowups: number; avgDealSize: number;
  topProduct: string; topCity: string;
  monthlySales: number[];
  topCustomers: { name: string; city: string; amount: number; status: string }[];
  pipelineStages: { lead: number; qualified: number; proposal: number; negotiation: number; closed_won: number; closed_lost: number };
  collectionAging: { current: number; d30: number; d60: number; d90: number; d90plus: number };
  cityBreakdown: { city: string; sales: number; centers: number }[];
  dailyTrend: { day: string; sales: number; visits: number }[];
}

export const COMPANY_DATA: Record<CompanySlug, CompanyDatum> = {
  bazargani: {
    totalSales: 12500000000, targetSales: 15000000000, lastMonthSales: 11200000000,
    activeCenters: 124, totalCenters: 310, newCenters: 8,
    pendingInvoices: 18, totalInvoices: 95, collectionRate: 72, avgPaymentDays: 45,
    pipelineCount: 35, pipelineValue: 8900000000,
    wonDeals: 42, lostDeals: 8, winRate: 84,
    visits: 67, calls: 234, emails: 89,
    overdueFollowups: 12, avgDealSize: 480000000,
    topProduct: 'تجهیزات آزمایشگاهی', topCity: 'تهران',
    monthlySales: [8.5, 10.2, 9.1, 11.8, 12.5, 12.0, 12.5],
    pipelineStages: { lead: 12, qualified: 8, proposal: 9, negotiation: 4, closed_won: 42, closed_lost: 8 },
    collectionAging: { current: 42, d30: 22, d60: 15, d90: 10, d90plus: 11 },
    cityBreakdown: [
      { city: 'تهران', sales: 4200000000, centers: 45 },
      { city: 'اصفهان', sales: 2800000000, centers: 28 },
      { city: 'تبریز', sales: 1800000000, centers: 18 },
      { city: 'شیراز', sales: 1500000000, centers: 15 },
      { city: 'کرج', sales: 980000000, centers: 10 },
      { city: 'مشهد', sales: 800000000, centers: 8 },
    ],
    dailyTrend: [
      { day: 'شنبه', sales: 1.8, visits: 12 }, { day: 'یکشنبه', sales: 2.1, visits: 15 },
      { day: 'دوشنبه', sales: 1.5, visits: 9 }, { day: 'سه‌شنبه', sales: 2.4, visits: 11 },
      { day: 'چهارشنبه', sales: 1.9, visits: 13 }, { day: 'پنجشنبه', sales: 1.6, visits: 7 },
    ],
    topCustomers: [
      { name: 'بیمارستان شریعتی', city: 'تهران', amount: 2400000000, status: 'active' },
      { name: 'آزمایشگاه پاتولوژی نوین', city: 'اصفهان', amount: 1800000000, status: 'active' },
      { name: 'دانشگاه علوم پزشکی', city: 'تبریز', amount: 1500000000, status: 'active' },
      { name: 'بیمارستان سینا', city: 'شیراز', amount: 1200000000, status: 'pending' },
      { name: 'مرکز تحقیقاتی رازی', city: 'کرج', amount: 980000000, status: 'active' },
    ],
  },
  aria: {
    totalSales: 8200000000, targetSales: 10000000000, lastMonthSales: 7800000000,
    activeCenters: 87, totalCenters: 450, newCenters: 15,
    pendingInvoices: 25, totalInvoices: 142, collectionRate: 65, avgPaymentDays: 52,
    pipelineCount: 52, pipelineValue: 4500000000,
    wonDeals: 68, lostDeals: 15, winRate: 82,
    visits: 89, calls: 312, emails: 156,
    overdueFollowups: 23, avgDealSize: 120000000,
    topProduct: 'اسمالرت کاف', topCity: 'اصفهان',
    monthlySales: [5.2, 6.1, 7.3, 6.8, 8.2, 8.0, 8.2],
    pipelineStages: { lead: 20, qualified: 14, proposal: 10, negotiation: 5, closed_won: 68, closed_lost: 15 },
    collectionAging: { current: 30, d30: 25, d60: 18, d90: 14, d90plus: 13 },
    cityBreakdown: [
      { city: 'اصفهان', sales: 2200000000, centers: 22 },
      { city: 'تهران', sales: 1800000000, centers: 18 },
      { city: 'البرز', sales: 1200000000, centers: 14 },
      { city: 'مشهد', sales: 1000000000, centers: 12 },
      { city: 'فارس', sales: 800000000, centers: 10 },
      { city: 'آذربایجان شرقی', sales: 600000000, centers: 11 },
    ],
    dailyTrend: [
      { day: 'شنبه', sales: 1.2, visits: 18 }, { day: 'یکشنبه', sales: 1.5, visits: 21 },
      { day: 'دوشنبه', sales: 1.1, visits: 14 }, { day: 'سه‌شنبه', sales: 1.8, visits: 17 },
      { day: 'چهارشنبه', sales: 1.3, visits: 19 }, { day: 'پنجشنبه', sales: 1.0, visits: 10 },
    ],
    topCustomers: [
      { name: 'داروخانه دکتر عبادی', city: 'اصفهان', amount: 890000000, status: 'active' },
      { name: 'داروخانه شهرک غرب', city: 'تهران', amount: 760000000, status: 'active' },
      { name: 'فروشگاه ارغوان', city: 'مشهد', amount: 620000000, status: 'overdue' },
      { name: 'داروخانه مهر', city: 'کرج', amount: 540000000, status: 'active' },
      { name: 'داروخانه زندگی', city: 'شیراز', amount: 480000000, status: 'pending' },
    ],
  },
  bgl: {
    totalSales: 18600000000, targetSales: 20000000000, lastMonthSales: 17200000000,
    activeCenters: 42, totalCenters: 95, newCenters: 5,
    pendingInvoices: 12, totalInvoices: 68, collectionRate: 81, avgPaymentDays: 38,
    pipelineCount: 22, pipelineValue: 5200000000,
    wonDeals: 38, lostDeals: 4, winRate: 90,
    visits: 54, calls: 187, emails: 67,
    overdueFollowups: 6, avgDealSize: 890000000,
    topProduct: 'گاز طبی', topCity: 'تبریز',
    monthlySales: [12.0, 13.5, 14.2, 15.8, 16.1, 18.2, 18.6],
    pipelineStages: { lead: 8, qualified: 6, proposal: 5, negotiation: 3, closed_won: 38, closed_lost: 4 },
    collectionAging: { current: 55, d30: 20, d60: 12, d90: 8, d90plus: 5 },
    cityBreakdown: [
      { city: 'تبریز', sales: 4500000000, centers: 12 },
      { city: 'تهران', sales: 3800000000, centers: 10 },
      { city: 'کرج', sales: 2800000000, centers: 8 },
      { city: 'زاهدان', sales: 2100000000, centers: 6 },
      { city: 'بندرعباس', sales: 1200000000, centers: 4 },
      { city: 'اراک', sales: 800000000, centers: 3 },
    ],
    dailyTrend: [
      { day: 'شنبه', sales: 2.5, visits: 6 }, { day: 'یکشنبه', sales: 2.8, visits: 8 },
      { day: 'دوشنبه', sales: 2.2, visits: 5 }, { day: 'سه‌شنبه', sales: 3.1, visits: 7 },
      { day: 'چهارشنبه', sales: 2.6, visits: 4 }, { day: 'پنجشنبه', sales: 2.0, visits: 4 },
    ],
    topCustomers: [
      { name: 'صنایع شیمیایی آراک', city: 'اراک', amount: 3200000000, status: 'active' },
      { name: 'بهداشت مرکزی کرج', city: 'کرج', amount: 2800000000, status: 'active' },
      { name: 'سیال ایزو زاهدان', city: 'زاهدان', amount: 2100000000, status: 'active' },
      { name: 'دانشگاه صنعتی', city: 'تهران', amount: 1500000000, status: 'pending' },
      { name: 'نیروگاه بندرعباس', city: 'بندرعباس', amount: 1200000000, status: 'active' },
    ],
  },
  // v2.35.0 — یاس طب (isolated): NO placeholder numbers — the isolated
  // tenant starts from zero and only REAL /api/stats values render (the
  // dashboard merges real data over these neutral defaults).
  yasteb: {
    totalSales: 0, targetSales: 0, lastMonthSales: 0,
    activeCenters: 0, totalCenters: 0, newCenters: 0,
    pendingInvoices: 0, totalInvoices: 0, collectionRate: 0, avgPaymentDays: 0,
    pipelineCount: 0, pipelineValue: 0,
    wonDeals: 0, lostDeals: 0, winRate: 0,
    visits: 0, calls: 0, emails: 0,
    overdueFollowups: 0, avgDealSize: 0,
    topProduct: '—', topCity: '—',
    monthlySales: [0, 0, 0, 0, 0, 0, 0],
    pipelineStages: { lead: 0, qualified: 0, proposal: 0, negotiation: 0, closed_won: 0, closed_lost: 0 },
    collectionAging: { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 },
    cityBreakdown: [],
    dailyTrend: [
      { day: 'شنبه', sales: 0, visits: 0 }, { day: 'یکشنبه', sales: 0, visits: 0 },
      { day: 'دوشنبه', sales: 0, visits: 0 }, { day: 'سه‌شنبه', sales: 0, visits: 0 },
      { day: 'چهارشنبه', sales: 0, visits: 0 }, { day: 'پنجشنبه', sales: 0, visits: 0 },
    ],
    topCustomers: [],
  },
};

export const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر'];
