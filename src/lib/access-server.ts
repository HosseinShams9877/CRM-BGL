// ════════════════════════════════════════════════════════════
// ACCESS SERVER — DB-backed helpers for the job-title registry
// and the menu-access matrix (both persisted in the Meta table).
// Server-only module (imports db).
// ════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import {
  JobTitle, MenuAccessMatrix, DEFAULT_JOB_TITLES, isValidJobTitleKey, sanitizeMatrixRow,
} from './access-config';
import { COMPANY_SLUGS } from './menu-catalog';

export const JOB_TITLES_META_KEY = 'job_titles';
export const MENU_ACCESS_META_KEY = 'menu_access';

/** Read the job-title registry from Meta, falling back to built-in defaults. */
export async function getJobTitleRegistry(): Promise<JobTitle[]> {
  const meta = await db.meta.findUnique({ where: { key: JOB_TITLES_META_KEY } });
  if (meta?.value) {
    try {
      const parsed = JSON.parse(meta.value);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
          .filter((t): t is JobTitle => !!t && typeof t.key === 'string' && typeof t.label === 'string')
          .map((t) => ({
            key: t.key,
            label: t.label,
            baseRole: ['admin', 'finance', 'production', 'standard'].includes(t.baseRole) ? t.baseRole : 'standard',
            desc: typeof t.desc === 'string' ? t.desc : undefined,
            isSystem: !!t.isSystem,
          }));
      }
    } catch { /* fall through to defaults */ }
  }
  return DEFAULT_JOB_TITLES;
}

/** Validate & persist the job-title registry. Throws Error with Persian message. */
export async function saveJobTitleRegistry(titles: unknown): Promise<JobTitle[]> {
  if (!Array.isArray(titles)) throw new Error('ساختار عناوین شغلی نامعتبر است.');

  const seen = new Set<string>();
  const clean: JobTitle[] = [];
  for (const raw of titles) {
    const t = raw as Partial<JobTitle>;
    if (!t || typeof t.key !== 'string' || typeof t.label !== 'string' || !t.key.trim() || !t.label.trim()) {
      throw new Error('هر عنوان شغلی نیاز به کلید لاتین و عنوان فارسی دارد.');
    }
    const key = t.key.trim();
    const label = t.label.trim();
    if (!isValidJobTitleKey(key)) {
      throw new Error(`کلید «${key}» نامعتبر است. کلید باید ۳ تا ۳۰ کاراکتر لاتین کوچک، رقم یا زیرخط باشد و با حرف شروع شود.`);
    }
    if (seen.has(key)) throw new Error(`کلید «${key}» تکراری است.`);
    seen.add(key);
    const baseRole = ['admin', 'finance', 'production', 'standard'].includes(t.baseRole || '') ? t.baseRole! : 'standard';
    clean.push({
      key, label, baseRole,
      desc: typeof t.desc === 'string' && t.desc.trim() ? t.desc.trim() : undefined,
      isSystem: !!t.isSystem,
    });
  }

  // System titles must always exist with their locked base roles
  for (const sys of DEFAULT_JOB_TITLES) {
    if (sys.isSystem) {
      const found = clean.find((t) => t.key === sys.key);
      if (!found) throw new Error(`عنوان سیستمی «${sys.label}» قابل حذف نیست.`);
      if (found.baseRole !== sys.baseRole) {
        throw new Error(`نقش پایهٔ عنوان سیستمی «${sys.label}» قابل تغییر نیست.`);
      }
    }
  }

  // Deleting a custom title that is still assigned to users must be blocked
  const removed = (await getJobTitleRegistry()).filter((prev) => !clean.some((t) => t.key === prev.key));
  for (const gone of removed) {
    const count = await db.user.count({ where: { jobTitle: gone.key } });
    if (count > 0) {
      throw new Error(`عنوان «${gone.label}» به ${count} کاربر اختصاص دارد. ابتدا عنوان کاربران را تغییر دهید.`);
    }
  }

  await db.meta.upsert({
    where: { key: JOB_TITLES_META_KEY },
    update: { value: JSON.stringify(clean) },
    create: { key: JOB_TITLES_META_KEY, value: JSON.stringify(clean) },
  });
  return clean;
}

/** Read the saved menu-access matrix from Meta (may be partial / empty). */
export async function getMenuAccessMatrix(): Promise<MenuAccessMatrix> {
  const meta = await db.meta.findUnique({ where: { key: MENU_ACCESS_META_KEY } });
  if (meta?.value) {
    try {
      const parsed = JSON.parse(meta.value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as MenuAccessMatrix;
    } catch { /* ignore */ }
  }
  return {};
}

/** Validate & persist the menu-access matrix. Throws Error with Persian message. */
export async function saveMenuAccessMatrix(matrix: unknown): Promise<MenuAccessMatrix> {
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    throw new Error('ساختار ماتریس دسترسی نامعتبر است.');
  }
  const clean: MenuAccessMatrix = {};
  const registry = await getJobTitleRegistry();
  const titleKeys = new Set(registry.map((t) => t.key));
  for (const [title, companies] of Object.entries(matrix as Record<string, unknown>)) {
    if (!titleKeys.has(title)) continue; // silently drop rows of removed titles
    if (!companies || typeof companies !== 'object') continue;
    clean[title] = {};
    for (const [company, keys] of Object.entries(companies as Record<string, unknown>)) {
      if (!COMPANY_SLUGS.includes(company as never)) continue;
      if (!Array.isArray(keys)) continue;
      const row = keys.filter((k): k is string => typeof k === 'string');
      clean[title][company] = sanitizeMatrixRow(company as (typeof COMPANY_SLUGS)[number], row);
    }
  }
  await db.meta.upsert({
    where: { key: MENU_ACCESS_META_KEY },
    update: { value: JSON.stringify(clean) },
    create: { key: MENU_ACCESS_META_KEY, value: JSON.stringify(clean) },
  });
  return clean;
}

/** Resolve base role + display label for a job-title key (fallbacks included). */
export async function resolveJobTitleForUser(jobTitle?: string | null): Promise<{ baseRole: string; label: string | null }> {
  if (!jobTitle) return { baseRole: 'standard', label: null };
  const registry = await getJobTitleRegistry();
  const entry = registry.find((t) => t.key === jobTitle);
  if (!entry) return { baseRole: 'standard', label: null };
  return { baseRole: entry.baseRole, label: entry.label };
}
