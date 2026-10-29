import { describe, it, expect } from 'vitest';
import {
  analysisExtractionSchema, coachExtractionSchema,
  normalizeIntent, normalizeTemperature, normalizeObjectionType, normalizeSeverity,
  normalizePriority, normalizeActionType, normalizeBuyingRole, normalizeIsoDate,
} from '../src/lib/ai/extraction';
import { extractJsonObject } from '../src/lib/ai/providers/llm';

describe('v2.27.0 — LLM extraction validation (hallucination guards)', () => {
  it('accepts a well-formed analysis and clamps numeric ranges', () => {
    const parsed = analysisExtractionSchema.safeParse({
      summary: 'مشتری درباره قیمت ونتیلاتور سوال داشت.',
      topic: 'استعلام قیمت',
      callReason: 'پیگیری پیش‌فاکتور',
      customerNeed: 'دستگاه ICU',
      customerProblems: ['نبود بودجه'],
      products: [{ name: 'ونتیلاتور', quantity: 2 }],
      budget: '',
      purchaseTimeframe: 'سه ماه دیگر',
      intent: 'price_request',
      temperature: 'hot',
      conversionScore: 180, // out of range → clamped by zod max? (schema uses min(0).max(100).catch(0))
      scoreReasons: [{ factor: 'درخواست پیش‌فاکتور', impact: 1, detail: '...' }],
      objections: [{ type: 'price', description: 'گران است', severity: 'high', resolved: false }],
      commitments: { rep: ['ارسال کاتالوگ'], customer: ['بررسی داخلی'] },
      openQuestions: ['تصمیم‌گیرنده کیست؟'],
      risks: [], opportunities: [],
      paymentTerms: '', competitors: ['رقیب X'],
      decisionMakers: [{ name: 'آقای رضایی', role: 'مدیر تجهیزات', type: 'decision_maker' }],
      suggestedFollowupDate: '2026-09-05',
      suggestedFollowupReason: 'پس از جلسه کمیسیون',
      stageSuggestion: 'پیش‌فاکتور',
      nextActions: [{ type: 'call', title: 'تماس پیگیری', priority: 'high', dueAt: '2026-09-05', reason: 'مشتری خواست', confidence: 0.9 }],
      segments: [{ speaker: 'rep', text: 'سلام' }],
      confidence: 0.9,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // out-of-range score is CLAMPED to the 0-100 window (never trust
      // the model blindly — but keep the signal instead of zeroing it)
      expect(parsed.data.conversionScore).toBe(100);
      expect(parsed.data.nextActions).toHaveLength(1);
    }
  });

  it('defaults every missing field instead of failing (partial grounded data beats none)', () => {
    const parsed = analysisExtractionSchema.safeParse({ summary: 'فقط خلاصه' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.objections).toEqual([]);
      expect(parsed.data.commitments.rep).toEqual([]);
      expect(parsed.data.confidence).toBe(0.5);
    }
  });

  it('normalizes creative enum values to safe fallbacks', () => {
    expect(normalizeIntent('price_request')).toBe('price_request');
    expect(normalizeIntent('PURCHASE')).toBe('other');
    expect(normalizeIntent('خرید نهایی')).toBe('other');
    expect(normalizeTemperature('very hot')).toBe('very_hot');
    expect(normalizeTemperature('HOT')).toBe('hot');
    expect(normalizeTemperature('')).toBe('');
    expect(normalizeObjectionType('Warranty')).toBe('warranty');
    expect(normalizeObjectionType('نامشخص')).toBe('other');
    expect(normalizeSeverity('بالا')).toBe('high');
    expect(normalizeSeverity('weird')).toBe('medium');
    expect(normalizePriority('فوری')).toBe('high');
    expect(normalizePriority('xx')).toBe('medium');
    expect(normalizeActionType('send_email')).toBe(''); // unknown type dropped by NBA engine
    expect(normalizeBuyingRole('CEO')).toBe('influencer');
  });

  it('accepts only real ISO dates (no Persian/garbage dates slip through)', () => {
    expect(normalizeIsoDate('2026-09-05')).toBe('2026-09-05T09:00:00.000Z');
    expect(normalizeIsoDate('2026-09-05T14:00')).toBe('2026-09-05T09:00:00.000Z');
    expect(normalizeIsoDate('۱۴۰۵/۰۶/۱۲')).toBeNull();
    expect(normalizeIsoDate('het weekend')).toBeNull();
    expect(normalizeIsoDate(null)).toBeNull();
  });

  it('validates coach extraction with score clamping', () => {
    const parsed = coachExtractionSchema.safeParse({
      qualityScore: 88,
      scores: { opening: 90, rapport: 85, needDiscovery: 40 },
      strengths: ['شروع خوب'],
      improvements: ['کشف نیاز'],
      mistakes: [],
      recommendations: ['از سوالات باز استفاده کنید'],
      confidence: 0.8,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.qualityScore).toBe(88);
  });
});

describe('v2.27.0 — LLM JSON extraction (fence/robust parsing)', () => {
  it('parses plain JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips markdown fences', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('extracts the first balanced object from chatty output', () => {
    expect(extractJsonObject('تحلیل انجام شد. نتیجه:\n{"summary":"خوب","score":72}\nموفق باشید')).toEqual({ summary: 'خوب', score: 72 });
  });
  it('handles braces inside JSON strings', () => {
    expect(extractJsonObject('{"note":"متن {شبیه} پرانتز"}')).toEqual({ note: 'متن {شبیه} پرانتز' });
  });
  it('returns null for non-JSON garbage', () => {
    expect(extractJsonObject('هیچ JSONی اینجا نیست')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });
});
