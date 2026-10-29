// ════════════════════════════════════════════════════════════
// AI SALES INTELLIGENCE — Shared types (v2.27.0)
// هوش مصنوعی فروش و تحلیل مکالمات
//
// Pure TypeScript types + UI label maps — NO server imports, so this
// module is safe to import from client components as well.
// ════════════════════════════════════════════════════════════

// ── Recording pipeline ──────────────────────────────────────
export type AiRecordingStatus =
  | 'uploaded' | 'queued' | 'transcribing' | 'analyzing' | 'completed' | 'failed';

export const AI_RECORDING_STATUS_LABEL: Record<AiRecordingStatus, string> = {
  uploaded: 'بارگذاری‌شده',
  queued: 'در صف پردازش',
  transcribing: 'در حال تبدیل صدا به متن',
  analyzing: 'در حال تحلیل مکالمه',
  completed: 'تکمیل‌شده',
  failed: 'خطا',
};

/** Ordered pipeline steps for the progress UI. */
export const AI_PIPELINE_STEPS: { key: AiRecordingStatus; label: string }[] = [
  { key: 'uploaded', label: 'بارگذاری' },
  { key: 'queued', label: 'صف' },
  { key: 'transcribing', label: 'تبدیل صدا به متن' },
  { key: 'analyzing', label: 'تحلیل مکالمه' },
  { key: 'completed', label: 'استخراج اقدام بعدی' },
];

// ── Intent ──────────────────────────────────────────────────
export const AI_INTENTS = [
  'inquiry', 'information_gathering', 'price_request', 'negotiation',
  'technical_evaluation', 'demo_request', 'purchase_intent', 'procurement',
  'tender', 'followup', 'complaint', 'after_sales', 'payment',
  'lost_opportunity', 'other',
] as const;
export type AiIntent = typeof AI_INTENTS[number];

export const AI_INTENT_LABEL: Record<AiIntent, string> = {
  inquiry: 'استعلام اولیه',
  information_gathering: 'گردآوری اطلاعات',
  price_request: 'درخواست قیمت',
  negotiation: 'مذاکره',
  technical_evaluation: 'ارزیابی فنی',
  demo_request: 'درخواست دمو',
  purchase_intent: 'قصد خرید',
  procurement: 'تدارکات',
  tender: 'مناقصه',
  followup: 'پیگیری',
  complaint: 'شکایت',
  after_sales: 'خدمات پس از فروش',
  payment: 'پرداخت',
  lost_opportunity: 'فرصت ازدست‌رفته',
  other: 'سایر',
};

// ── Temperature ─────────────────────────────────────────────
export type AiTemperature = 'cold' | 'warm' | 'hot' | 'very_hot';

export const AI_TEMPERATURE_LABEL: Record<AiTemperature, string> = {
  cold: 'سرد',
  warm: 'گرم',
  hot: 'داغ',
  very_hot: 'خیلی داغ',
};

export const AI_TEMPERATURE_COLOR: Record<AiTemperature, string> = {
  cold: '#0891b2',
  warm: '#d97706',
  hot: '#ea580c',
  very_hot: '#dc2626',
};

// ── Objections ──────────────────────────────────────────────
export const AI_OBJECTION_TYPES = [
  'price', 'budget', 'competitor', 'technical', 'brand', 'trust',
  'timing', 'delivery', 'warranty', 'service', 'payment_terms',
  'approval', 'procurement', 'tender', 'other',
] as const;
export type AiObjectionType = typeof AI_OBJECTION_TYPES[number];

export const AI_OBJECTION_TYPE_LABEL: Record<AiObjectionType, string> = {
  price: 'قیمت',
  budget: 'بودجه',
  competitor: 'رقیب',
  technical: 'فنی',
  brand: 'برند',
  trust: 'اعتماد',
  timing: 'زمان‌بندی',
  delivery: 'تحویل',
  warranty: 'گارانتی',
  service: 'خدمات',
  payment_terms: 'شرایط پرداخت',
  approval: 'تأییدیه',
  procurement: 'تدارکات',
  tender: 'مناقصه',
  other: 'سایر',
};

export interface AiObjection {
  type: AiObjectionType;
  description: string;
  severity: 'low' | 'medium' | 'high';
  resolved: boolean;
  recommendedResponse?: string;
}

// ── Next Best Action ────────────────────────────────────────
export const AI_ACTION_TYPES = [
  'call', 'whatsapp', 'email', 'catalog', 'price', 'quotation', 'demo',
  'meeting', 'technical_doc', 'decision_maker', 'payment', 'manager',
  'close', 'mark_lost',
] as const;
export type AiActionType = typeof AI_ACTION_TYPES[number];

export const AI_ACTION_TYPE_LABEL: Record<AiActionType, string> = {
  call: 'تماس با مشتری',
  whatsapp: 'ارسال پیام واتساپ',
  email: 'ارسال ایمیل',
  catalog: 'ارسال کاتالوگ',
  price: 'ارسال قیمت',
  quotation: 'صدور پیش‌فاکتور',
  demo: 'برنامه‌ریزی دمو',
  meeting: 'برنامه‌ریزی جلسه',
  technical_doc: 'درخواست مدرک فنی',
  decision_maker: 'تماس با تصمیم‌گیرنده',
  payment: 'پیگیری پرداخت',
  manager: 'مداخله مدیر',
  close: 'بستن فرصت',
  mark_lost: 'ثبت ازدست‌رفته',
};

/** Action types that materialize as a CRM Activity when executed. */
export const AI_ACTION_ACTIVITY_KIND: Partial<Record<AiActionType, 'call' | 'meeting' | 'task'>> = {
  call: 'call',
  whatsapp: 'task',
  email: 'task',
  catalog: 'task',
  price: 'task',
  quotation: 'task',
  demo: 'meeting',
  meeting: 'meeting',
  technical_doc: 'task',
  decision_maker: 'call',
  payment: 'task',
  manager: 'task',
  close: 'task',
  mark_lost: 'task',
};

export type AiActionStatus = 'suggested' | 'approved' | 'executed' | 'completed' | 'dismissed';
export const AI_ACTION_STATUS_LABEL: Record<AiActionStatus, string> = {
  suggested: 'پیشنهادی',
  approved: 'تأییدشده',
  executed: 'اجرا شده',
  completed: 'تکمیل',
  dismissed: 'ردشده',
};

export type AiApprovalMode = 'suggest' | 'confirm' | 'auto';
export const AI_APPROVAL_MODE_LABEL: Record<AiApprovalMode, string> = {
  suggest: 'فقط پیشنهاد',
  confirm: 'تأیید قبل از اجرا',
  auto: 'اجرای خودکار',
};

// ── Decision makers (org buying roles) ──────────────────────
export const AI_BUYING_ROLES = ['decision_maker', 'influencer', 'user', 'gatekeeper', 'procurement'] as const;
export type AiBuyingRole = typeof AI_BUYING_ROLES[number];
export const AI_BUYING_ROLE_LABEL: Record<AiBuyingRole, string> = {
  decision_maker: 'تصمیم‌گیرنده',
  influencer: 'تأثیرگذار',
  user: 'کاربر',
  gatekeeper: 'دروازه‌بان',
  procurement: 'تدارکات',
};

export interface AiDecisionMaker {
  name?: string;
  role?: string; // سمت سازمانی — پزشک، مدیر تجهیزات پزشکی، خرید، مالی...
  type: AiBuyingRole;
}

// ── Structured analysis (LLM extraction) ────────────────────
export interface AiScoreReason {
  factor: string;
  impact: number; // +1 / -1
  detail: string;
}

export interface AiActionDraft {
  type: AiActionType;
  title: string;
  detail?: string;
  priority: 'high' | 'medium' | 'low';
  dueAt?: string | null; // ISO
  reason: string;
  confidence: number; // 0-1
}

export interface AiAnalysisExtraction {
  summary: string;
  topic: string;
  callReason: string;
  customerNeed: string;
  customerProblems: string[];
  products: { name: string; quantity?: number | string; note?: string }[];
  budget: string;
  purchaseTimeframe: string;
  intent: AiIntent | '';
  temperature: AiTemperature | '';
  conversionScore: number;
  scoreReasons: AiScoreReason[];
  objections: AiObjection[];
  commitments: { rep: string[]; customer: string[] };
  openQuestions: string[];
  risks: string[];
  opportunities: string[];
  paymentTerms: string;
  competitors: string[];
  decisionMakers: AiDecisionMaker[];
  suggestedFollowupDate?: string | null; // ISO date
  suggestedFollowupReason?: string;
  stageSuggestion?: string;
  nextActions: AiActionDraft[];
  confidence: number; // 0-1
}

// ── Transcript ──────────────────────────────────────────────
export type AiSpeaker = 'rep' | 'customer' | 'other';
export const AI_SPEAKER_LABEL: Record<AiSpeaker, string> = {
  rep: 'کارشناس',
  customer: 'مشتری',
  other: 'سایر',
};

export interface AiTranscriptSegment {
  speaker: AiSpeaker;
  startSec?: number;
  endSec?: number;
  text: string;
}

// ── Coach ───────────────────────────────────────────────────
export const AI_COACH_CRITERIA = [
  'opening', 'rapport', 'needDiscovery', 'qualification', 'questionQuality',
  'presentation', 'listening', 'objectionHandling', 'negotiation',
  'closing', 'nextAction', 'professionalism', 'followupQuality',
] as const;
export type AiCoachCriterion = typeof AI_COACH_CRITERIA[number];

export const AI_COACH_CRITERIA_LABEL: Record<AiCoachCriterion, string> = {
  opening: 'شروع مکالمه',
  rapport: 'ایجاد ارتباط',
  needDiscovery: 'کشف نیاز',
  qualification: 'ارزیابی واجد شرایط بودن',
  questionQuality: 'کیفیت پرسش‌ها',
  presentation: 'ارائه محصول',
  listening: 'گوش دادن فعال',
  objectionHandling: 'مدیریت اعتراض',
  negotiation: 'مذاکره',
  closing: 'جمع‌بندی و بستن',
  nextAction: 'تعیین اقدام بعدی',
  professionalism: 'حرفه‌ای بودن',
  followupQuality: 'کیفیت پیگیری',
};

export interface AiCoachExtraction {
  qualityScore: number; // 0-100
  scores: Record<string, number>; // criterion → 0-100
  strengths: string[];
  improvements: string[];
  mistakes: string[];
  recommendations: string[];
  confidence: number;
}

// ── Customer memory ─────────────────────────────────────────
export interface AiCustomerMemoryData {
  summary: string;
  preferences: {
    preferredContactTime?: string;
    communicationStyle?: string;
    productInterests?: string[];
    [k: string]: unknown;
  };
  insights: {
    purchaseHistory?: string;
    openObjections?: string[];
    competitors?: string[];
    paymentBehavior?: string;
    decisionMakers?: AiDecisionMaker[];
    pastCommitments?: string[];
    relationshipNotes?: string[];
    [k: string]: unknown;
  };
}

// ── Pre-call brief ──────────────────────────────────────────
export interface AiPreCallBrief {
  centerId: string;
  centerName: string;
  lastCallAt?: string;
  lastCallSummary?: string;
  daysSinceLastCall?: number;
  totalCalls: number;
  openObjections: { type: string; typeLabel: string; description: string; severity: string }[];
  lastConversionScore?: number;
  lastTemperature?: string;
  suggestedFollowupDate?: string | null;
  suggestedFollowupReason?: string;
  pendingActions: { id: string; type: string; typeLabel: string; title: string; dueAt?: string | null }[];
  memorySummary?: string;
  memoryPreferences?: Record<string, unknown>;
  topicsToDiscuss: string[];
  suggestedQuestions: string[];
  recentDocuments: { id: string; docNumber: string; docType: string; status: string; createdAt: string }[];
  aiRecommendation: string;
  enoughData: boolean;
}
