import { z } from 'zod';

/**
 * Shared Zod validation schemas for critical API payloads (P1-3).
 * Routes parse untrusted bodies through these before touching the database.
 * Every schema returns a Persian error via `.parse()` failure → the caller
 * wraps it in `safeParse` and returns 400 with the first issue message.
 */

// ── Auth ──
export const loginSchema = z.object({
  action: z.literal('login'),
  username: z.string({ error: 'نام کاربری الزامی است.' }).trim().min(1, 'نام کاربری الزامی است.').max(64),
  password: z.string({ error: 'رمز عبور الزامی است.' }).min(1, 'رمز عبور الزامی است.').max(128),
});

export const changePasswordSchema = z.object({
  action: z.literal('change-password'),
  currentPassword: z.string().min(1, 'رمز فعلی الزامی است.'),
  newPassword: z.string().min(8, 'رمز جدید حداقل ۸ نویسه باشد.').max(128),
});

// ── After-sales: ticket create ──
// v2.22.0 — centerId is OPTIONAL again. The services dialog is serial-first:
// the center resolves from the inventory serial server-side, and a
// contact-only ticket (caller name, no center record yet) is a legitimate
// walk-in. The v2.8.0 schema made centerId mandatory, which silently broke
// EVERY ticket creation from the UI (the dialog never sent one) — every
// submit answered 400 «انتخاب مرکز الزامی است.» for 14 versions.
export const ticketCreateSchema = z.object({
  action: z.literal('create'),
  centerId: z.string().trim().min(1, 'انتخاب مرکز الزامی است.').optional().nullable(),
  serialNumber: z.string().trim().max(64).optional().nullable(),
  productCode: z.string().trim().max(64).optional().nullable(),
  contactName: z.string().trim().max(120).optional().nullable(),
  contactPhone: z.string().trim().max(30).optional().nullable(),
  type: z.enum(['repair', 'maintenance', 'installation', 'training', 'replacement'], {
    error: 'نوع تیکت نامعتبر است.',
  }).default('repair'),
  priority: z.enum(['low', 'normal', 'high', 'critical'], { error: 'اولویت نامعتبر است.' }).default('normal'),
  issue: z.string({ error: 'شرح مشکل الزامی است.' }).trim().min(3, 'شرح مشکل حداقل ۳ نویسه باشد.').max(2000),
  warrantyStatus: z.enum(['in_warranty', 'out_of_warranty', 'unknown']).optional(),
  assignedTo: z.string().trim().optional().nullable(),
});

// ── Accounting cartable: payment create ──
// v2.47.0 (audit): every money field is an INTEGER RIAL. Rial has no
// fractional unit in practice, and integer values are stored EXACTLY in
// both SQLite REAL and JS float64 (< 2^53) — the float-precision class of
// bugs is eliminated at the write boundary instead of chasing Decimal
// migrations through every API consumer (documented in SECURITY.md).
export const paymentCreateSchema = z.object({
  action: z.literal('add-payment'),
  salesDocumentId: z.string({ error: 'شناسه سند الزامی است.' }).trim().min(1, 'شناسه سند الزامی است.'),
  amount: z.number({ error: 'مبلغ پرداخت الزامی است.' }).int('مبلغ پرداخت باید عدد ریالیِ صحیح باشد.').positive('مبلغ پرداخت باید بزرگ‌تر از صفر باشد.').max(1e12, 'مبلغ غیرمنطقی است.'),
  paymentMethod: z.enum(['cash', 'card', 'transfer', 'cheque', 'pos', 'online'], {
    error: 'روش پرداخت نامعتبر است.',
  }).default('cash'),
  paymentDate: z.string().trim().optional(),
  referenceNumber: z.string().trim().max(64).optional(),
  description: z.string().trim().max(500).optional(),
});

// ── Centers: create/update common fields ──
export const centerSaveSchema = z.object({
  name: z.string({ error: 'نام مرکز الزامی است.' }).trim().min(2, 'نام مرکز حداقل ۲ نویسه باشد.').max(200),
  customerType: z.enum(['organization', 'end_user']).default('organization'),
  segment: z.string().trim().max(50).default(''),
  mobile: z.string().trim().max(20).regex(/^$|^[0-9+\-\s]+$/, 'موبایل فقط شامل رقم باشد.').optional().nullable(),
  phone: z.string().trim().max(20).regex(/^$|^[0-9+\-\s]+$/, 'تلفن فقط شامل رقم باشد.').optional().nullable(),
  province: z.string().trim().max(60).optional().nullable(),
  city: z.string().trim().max(60).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
});

// ── Sales documents: create ──
export const salesDocCreateSchema = z.object({
  action: z.literal('create'),
  centerId: z.string().trim().optional().nullable(),
  documentType: z.enum(['proforma', 'invoice', 'return']).default('proforma'),
  description: z.string().trim().max(2000).optional(),
  items: z.array(z.object({
    productId: z.string().trim().optional().nullable(),
    productName: z.string({ error: 'نام محصول هر ردیف الزامی است.' }).trim().min(1, 'نام محصول الزامی است.').max(200),
    quantity: z.number({ error: 'تعداد الزامی است.' }).int('تعداد باید عدد صحیح باشد.').positive('تعداد باید مثبت باشد.').max(1e6),
    unitPrice: z.number().int('قیمت واحد باید عدد ریالیِ صحیح باشد.').min(0, 'قیمت واحد نمی‌تواند منفی باشد.').max(1e12),
    discount: z.number().int('تخفیف باید عدد ریالیِ صحیح باشد.').min(0).max(1e12).default(0),
  })).min(1, 'حداقل یک ردیف کالا لازم است.'),
});

// ── Files module (P1-2) ──
export const filesListSchema = z.object({
  action: z.literal('list'),
  centerId: z.string().trim().max(64).optional().nullable(),
  category: z.string().trim().max(64).optional().nullable(),
});

export const filesDeleteSchema = z.object({
  action: z.literal('delete'),
  id: z.string({ error: 'شناسه فایل الزامی است.' }).trim().min(1, 'شناسه فایل الزامی است.'),
});

// ── Helper: parse + Persian 400 ──
export function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  const first = result.error.issues[0];
  return { ok: false, error: first?.message || 'دادهٔ ارسالی نامعتبر است.' };
}
