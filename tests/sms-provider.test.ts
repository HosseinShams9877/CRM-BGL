// ════════════════════════════════════════════════════════════
// SMS PROVIDER — pure unit tests (v2.43.0)
// Phone normalization, text rules, per-provider request builders
// and response parsers — no network, no DB.
// ════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  normalizeIranMobile, validateSmsText, buildSmsRequest, parseSmsResponse,
  buildCollectionReminderSms, buildFollowupReminderSms, buildTestSms,
  SMS_MAX_CHARS, isSmsProviderId,
} from '../src/lib/sms/provider';

describe('normalizeIranMobile', () => {
  it('accepts the canonical 09 form', () => {
    expect(normalizeIranMobile('09121234567')).toBe('09121234567');
  });
  it('normalizes +98 / 0098 / 98 / bare 9 forms', () => {
    expect(normalizeIranMobile('+989121234567')).toBe('09121234567');
    expect(normalizeIranMobile('00989121234567')).toBe('09121234567');
    expect(normalizeIranMobile('989121234567')).toBe('09121234567');
    expect(normalizeIranMobile('9121234567')).toBe('09121234567');
  });
  it('strips spaces, dashes and parentheses users paste', () => {
    expect(normalizeIranMobile('0912 123 4567')).toBe('09121234567');
    expect(normalizeIranMobile('0912-123-4567')).toBe('09121234567');
    expect(normalizeIranMobile('(0912) 1234567')).toBe('09121234567');
  });
  it('rejects landlines, short/long, letters and non-mobile prefixes', () => {
    expect(normalizeIranMobile('02188776655')).toBeNull();  // tehran landline
    expect(normalizeIranMobile('0912')).toBeNull();          // too short
    expect(normalizeIranMobile('091212345678')).toBeNull();  // too long
    expect(normalizeIranMobile('0912abc4567')).toBeNull();   // letters
    expect(normalizeIranMobile('08001234567')).toBeNull();   // 08 prefix
    expect(normalizeIranMobile('')).toBeNull();
  });
});

describe('validateSmsText', () => {
  it('accepts normal text and trims are irrelevant (length only)', () => {
    expect(validateSmsText('سلام')).toEqual({ ok: true });
    expect(validateSmsText('x'.repeat(SMS_MAX_CHARS))).toEqual({ ok: true });
  });
  it('rejects empty and oversized bodies', () => {
    expect(validateSmsText('')).toEqual({ ok: false, error: expect.any(String) });
    expect(validateSmsText('x'.repeat(SMS_MAX_CHARS + 1))).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('isSmsProviderId', () => {
  it('accepts the three supported providers only', () => {
    expect(isSmsProviderId('kavenegar')).toBe(true);
    expect(isSmsProviderId('melipayamak')).toBe(true);
    expect(isSmsProviderId('sms_ir')).toBe(true);
    expect(isSmsProviderId('twilio')).toBe(false);
    expect(isSmsProviderId(42)).toBe(false);
  });
});

describe('buildSmsRequest', () => {
  const cfg = { apiKey: 'TEST-KEY-123', username: 'user1', password: 'pass1', sender: '10004346' };

  it('kavenegar: GET with key in path + encoded query', () => {
    const r = buildSmsRequest('kavenegar', cfg, '09121234567', 'سلام جهان');
    expect('url' in r && r.url).toContain('https://api.kavenegar.com/v1/TEST-KEY-123/sms/send.json');
    expect('url' in r && r.url).toContain('receptor=09121234567');
    expect('url' in r && r.url).toContain('sender=10004346');
    expect('method' in r && r.method).toBe('GET');
    expect((r as { body?: string }).body).toBeUndefined();
  });
  it('melipayamak: POST JSON with username/password/from/to/text', () => {
    const r = buildSmsRequest('melipayamak', cfg, '09121234567', 'سلام');
    expect('url' in r && r.url).toBe('https://rest.payamak-panel.com/api/SendSMS/SendSMS');
    expect('method' in r && r.method).toBe('POST');
    if ('body' in r && r.body) {
      const b = JSON.parse(r.body);
      expect(b).toMatchObject({ username: 'user1', password: 'pass1', to: '09121234567', from: '10004346', text: 'سلام' });
    } else {
      throw new Error('melipayamak request missing body');
    }
  });
  it('sms_ir: POST with x-api-key header and lineNumber/mobiles', () => {
    const r = buildSmsRequest('sms_ir', cfg, '09121234567', 'سلام');
    expect('url' in r && r.url).toBe('https://api.sms.ir/v1/send/bulk');
    expect('headers' in r && r.headers['x-api-key']).toBe('TEST-KEY-123');
    if ('body' in r && r.body) {
      const b = JSON.parse(r.body);
      expect(b).toMatchObject({ lineNumber: '10004346', messageText: 'سلام', mobiles: ['09121234567'] });
    } else {
      throw new Error('sms_ir request missing body');
    }
  });
  it('fails closed on bad phone / empty text / missing config', () => {
    expect(buildSmsRequest('kavenegar', cfg, '02188776655', 'x')).toEqual({ error: expect.any(String) });
    expect(buildSmsRequest('kavenegar', cfg, '09121234567', '')).toEqual({ error: expect.any(String) });
    expect(buildSmsRequest('kavenegar', { ...cfg, apiKey: ' ' }, '09121234567', 'x')).toEqual({ error: expect.any(String) });
    expect(buildSmsRequest('melipayamak', { ...cfg, username: '', password: '' }, '09121234567', 'x')).toEqual({ error: expect.any(String) });
    expect(buildSmsRequest('sms_ir', { ...cfg, sender: '' }, '09121234567', 'x')).toEqual({ error: expect.any(String) });
  });
});

describe('parseSmsResponse', () => {
  it('kavenegar: 200 + return.status 200 → sent with messageid', () => {
    const body = JSON.stringify({ return: { status: 200, message: 'تایید شد' }, entries: [{ messageid: 4654321 }] });
    const r = parseSmsResponse('kavenegar', 200, body);
    expect(r).toEqual({ ok: true, messageId: '4654321' });
  });
  it('kavenegar: 401 → Persian auth error', () => {
    const r = parseSmsResponse('kavenegar', 401, '');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('کلید API');
  });
  it('melipayamak: RetStatus 1 → sent; other → error', () => {
    const ok = parseSmsResponse('melipayamak', 200, JSON.stringify({ Value: '11', RetStatus: 1, StrRetStatus: 'Ok' }));
    expect(ok.ok).toBe(true);
    expect(ok.messageId).toBe('11');
    const bad = parseSmsResponse('melipayamak', 200, JSON.stringify({ RetStatus: 11, StrRetStatus: 'InsufficientCredit' }));
    expect(bad.ok).toBe(false);
  });
  it('sms_ir: status 1 → sent; status≠1 → error; 401 → auth error', () => {
    const ok = parseSmsResponse('sms_ir', 200, JSON.stringify({ status: 1, messageId: 12345 }));
    expect(ok.ok).toBe(true);
    expect(ok.messageId).toBe('12345');
    const bad = parseSmsResponse('sms_ir', 200, JSON.stringify({ status: 13 }));
    expect(bad.ok).toBe(false);
    const auth = parseSmsResponse('sms_ir', 401, '');
    expect(auth.error).toContain('کلید API');
  });
});

describe('templates', () => {
  it('collection reminder carries center, invoice number, amount and overdue days', () => {
    const t = buildCollectionReminderSms({
      centerName: 'بیمارستان شهید مدنی', invoiceNumber: 'INV-260902-0001',
      amountRial: 125000000, overdueDays: 12, companyName: 'بهبود گستر لیام ایرانیان',
    });
    expect(t).toContain('بیمارستان شهید مدنی');
    expect(t).toContain('INV-260902-0001');
    expect(t).toContain('۱۲۵٬۰۰۰٬۰۰۰'); // fa-IR grouped digits
    expect(t).toContain('بهبود گستر لیام ایرانیان');
    expect(t).toContain('۱۲ روز');
  });
  it('followup reminder greets the person when known', () => {
    const t = buildFollowupReminderSms({ centerName: 'کلینیک آرش', personName: 'آقای رضایی', companyName: 'CRM' });
    expect(t).toContain('آقای رضایی عزیز');
    const t2 = buildFollowupReminderSms({ centerName: 'کلینیک آرش', personName: null, companyName: 'CRM' });
    expect(t2).toContain('کلینیک آرش گرامی');
  });
  it('test message is identifiable', () => {
    expect(buildTestSms('هلدینگ BGL')).toContain('پیامک آزمایشی');
  });
});
