import {
  CATEGORY_CFG, Center, CenterCategory, CenterContact, CenterGrade, GRADE_CFG,
} from './types';

// ==================== API ADAPTER ====================
/** Shape returned by /api/centers list action. */
export interface ApiCenter {
  id: string;
  name: string;
  province: string | null;
  city: string | null;
  phone: string | null;
  mobile?: string | null;
  customerType?: string | null;
  segment?: string | null;
  loyaltyPoints?: number | null;
  paymentBehavior?: string | null;
  commissionPercent?: number | null;
  status: string;
  isArchived: boolean;
  tags: string; // JSON string
  customFields?: string;
  createdAt: string;
  updatedAt: string;
  /** v2.26.2+ — numeric CAS token; REQUIRED by the update action since
   *  v2.27.1 removed the updatedAt fallback. The edit dialog reads it
   *  from the list row; without this field every card-path edit 428s. */
  version?: number;
  extraContacts?: ApiContact[];
  _count?: { accounts: number; activities: number; extraContacts: number };
}

/** Shape of CenterContact rows returned by the API. */
export interface ApiContact {
  id: string;
  centerId: string;
  title: string;
  person: string | null;
  phone: string;
  notes: string | null;
  isAgent?: boolean;
  personality?: string;
  createdByName?: string | null;
  createdAt: string;
}

/** Convert an API center row into the component's Center shape. */
export function adaptCenter(a: ApiCenter): Center {
  // v2.14.0 — single parse, with legacy double-encoded rows unfolded
  // (rows written while the old double-JSON bug was live parse to a STRING
  // on the first pass; a second pass recovers the object).
  let extra: Record<string, unknown> = {};
  try {
    const first: unknown = JSON.parse(a.customFields || '{}');
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      extra = first as Record<string, unknown>;
    } else if (typeof first === 'string') {
      try {
        const second: unknown = JSON.parse(first);
        if (second && typeof second === 'object' && !Array.isArray(second)) {
          extra = second as Record<string, unknown>;
        }
      } catch { /* keep {} */ }
    }
  } catch { /* ignore */ }
  let tags: string[] = [];
  try { tags = JSON.parse(a.tags || '[]'); } catch { /* ignore */ }
  const category = (extra.category as CenterCategory) || 'other';
  const grade = (extra.grade as CenterGrade) || 'C';
  const contacts: CenterContact[] = (a.extraContacts || []).map((ct) => ({
    id: ct.id,
    fullName: ct.person || ct.title,
    role: ct.title,
    phone: ct.phone,
    mobile: ct.phone,
    email: '',
    isPrimary: false,
    isAgent: Boolean(ct.isAgent),
    notes: ct.notes || '',
    contactId: ct.id,
    centerId: ct.centerId,
    centerName: a.name,
  }));
  return {
    id: a.id,
    name: a.name,
    category: CATEGORY_CFG[category] ? category : 'other',
    status: a.isArchived ? 'inactive' : 'active',
    grade: GRADE_CFG[grade] ? grade : 'C',
    customerType: a.customerType === 'end_user' ? 'end_user' : 'organization',
    segment: a.segment || '',
    mobile: a.mobile || '',
    loyaltyPoints: Number(a.loyaltyPoints || 0),
    paymentBehavior: a.paymentBehavior || 'unknown',
    commissionPercent: Number(a.commissionPercent || 0),
    city: a.city || '—',
    province: a.province || '—',
    address: String(extra.address || '') || '—',
    phone: a.phone || '—',
    website: String(extra.website || ''),
    contacts,
    totalSales: Number(extra.totalSales || 0),
    orderCount: a._count?.activities || 0,
    lastOrderDate: String(extra.lastOrderDate || ''),
    lastFollowup: String(extra.lastFollowup || ''),
    tags,
    notes: String(extra.notes || ''),
    isFavorite: Boolean(extra.isFavorite),
    updatedAt: a.updatedAt || undefined,
    // v2.29.1 — pass the numeric CAS token through (regression fix: the
    // update action has REQUIRED the token since v2.27.1 removed the
    // updatedAt fallback, but adaptCenter dropped it — so every center
    // edit opened from the list card answered 428 and could never save.
    // Caught by the first end-to-end browser scene on this path.)
    version: a.version,
  };
}
