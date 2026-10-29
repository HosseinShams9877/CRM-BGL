// Unit tests — Zod validation schemas (P1-3) + Jalali date utilities.
// Part of the v2.8.0 test foundation (audit P1-7).
import { describe, it, expect } from 'vitest';
import {
  loginSchema,
  ticketCreateSchema,
  paymentCreateSchema,
  parseBody,
} from '@/lib/validators';
import { toJalaliString, jalaliMonthName, formatJalaliFull } from '@/lib/jalali';

describe('loginSchema', () => {
  it('accepts a valid login payload', () => {
    const r = parseBody(loginSchema, { action: 'login', username: 'admin', password: 'x' });
    expect(r.ok).toBe(true);
  });

  it('rejects a missing username with a Persian message', () => {
    const r = parseBody(loginSchema, { action: 'login', password: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('نام کاربری');
  });

  it('rejects an empty password', () => {
    const r = parseBody(loginSchema, { action: 'login', username: 'admin', password: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('رمز عبور');
  });

  it('rejects non-string types', () => {
    const r = parseBody(loginSchema, { action: 'login', username: 123, password: 'x' });
    expect(r.ok).toBe(false);
  });
});

describe('ticketCreateSchema', () => {
  const valid = {
    action: 'create',
    centerId: 'ck123',
    issue: 'دستگاه روشن نمی‌شود',
    type: 'repair',
    priority: 'high',
  };

  it('accepts a valid ticket and applies defaults', () => {
    const r = parseBody(ticketCreateSchema, valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.type).toBe('repair');
      expect(r.data.priority).toBe('high');
    }
  });

  it('rejects a too-short issue description', () => {
    const r = parseBody(ticketCreateSchema, { ...valid, issue: 'ب' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('شرح مشکل');
  });

  it('rejects an invalid ticket type', () => {
    const r = parseBody(ticketCreateSchema, { ...valid, type: 'explosion' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('نوع تیکت');
  });

  it('rejects a missing centerId', () => {
    const r = parseBody(ticketCreateSchema, { ...valid, centerId: '' });
    expect(r.ok).toBe(false);
  });

  // v2.22.0 — the services dialog NEVER sends centerId (serial-first flow:
  // the server resolves the center from the inventory serial; contact-only
  // walk-ins carry none). The v2.8.0 required field broke every UI create.
  it('accepts the UI payload with NO centerId (serial/contact-only ticket)', () => {
    const r = parseBody(ticketCreateSchema, {
      action: 'create',
      contactName: 'مشتری تلفنی',
      type: 'repair',
      priority: 'normal',
      issue: 'دستگاه روشن نمی‌شود',
    });
    expect(r.ok).toBe(true);
  });
});

describe('paymentCreateSchema', () => {
  it('accepts a valid payment with defaults', () => {
    const r = parseBody(paymentCreateSchema, {
      action: 'add-payment', salesDocumentId: 'd1', amount: 150000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.paymentMethod).toBe('cash');
  });

  it('rejects a non-positive amount', () => {
    const r = parseBody(paymentCreateSchema, {
      action: 'add-payment', salesDocumentId: 'd1', amount: -5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('صفر');
  });

  it('rejects a string amount (type coercion is NOT allowed)', () => {
    const r = parseBody(paymentCreateSchema, {
      action: 'add-payment', salesDocumentId: 'd1', amount: '150000',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid payment method', () => {
    const r = parseBody(paymentCreateSchema, {
      action: 'add-payment', salesDocumentId: 'd1', amount: 100, paymentMethod: 'barter',
    });
    expect(r.ok).toBe(false);
  });
});

describe('Jalali date utilities', () => {
  it('converts a known Gregorian date to Jalali', () => {
    // 2026-08-26 → 1405/06/04
    expect(toJalaliString('2026-08-26')).toBe('1405/06/04');
  });

  it('handles null and invalid inputs gracefully', () => {
    expect(toJalaliString(null)).toBe('');
    expect(toJalaliString(undefined)).toBe('');
    expect(toJalaliString('not-a-date')).toBe('');
  });

  it('returns a month name for a Jalali month number', () => {
    expect(jalaliMonthName(1)).toBe('فروردین');
    expect(jalaliMonthName(7)).toBe('مهر');
    expect(jalaliMonthName(12)).toBe('اسفند');
  });

  it('formats a full Jalali date with weekday', () => {
    const full = formatJalaliFull('2026-08-26');
    expect(full).toContain('1405');
    expect(full.length).toBeGreaterThan(10);
  });
});
