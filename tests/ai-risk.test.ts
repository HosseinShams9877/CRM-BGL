import { describe, it, expect } from 'vitest';
import { computeCenterRisk } from '../src/lib/ai/engine/risk';
import { getRolePermissions } from '../src/lib/ai/../auth';

const NOW = new Date(2026, 7, 27, 12, 0, 0);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000);

describe('v2.27.0 — Opportunity risk engine (rule-based, no LLM)', () => {
  it('healthy customer → low risk with no signals', () => {
    const r = computeCenterRisk({
      centerId: 'c1', centerName: 'بیمارستان مهر',
      paymentBehavior: 'good_payer',
      lastCallAt: daysAgo(3), lastConversionScore: 75, lastTemperature: 'hot',
      openObjectionCount: 0, overdueActions: 0, pendingActions: 1,
      lastActivityAt: daysAgo(2), lastProformaAt: daysAgo(10), now: NOW,
    });
    expect(r.riskScore).toBe(0);
    expect(r.signals).toHaveLength(0);
    expect(r.recommendedAction).toContain('عادی');
  });

  it('unresolved objections add capped points (R1)', () => {
    const r = computeCenterRisk({
      centerId: 'c1', centerName: 'X',
      lastCallAt: daysAgo(2), lastConversionScore: 60, lastTemperature: 'warm',
      openObjectionCount: 5, overdueActions: 0, pendingActions: 1,
      lastActivityAt: daysAgo(1), now: NOW,
    });
    const r1 = r.signals.find((s) => s.code === 'R1');
    expect(r1).toBeDefined();
    expect(r1?.points).toBe(25); // 10 + 5*5 → capped at 25
    expect(r.riskScore).toBe(25);
  });

  it('low conversion + cold temperature stack (R2+R3)', () => {
    const r = computeCenterRisk({
      centerId: 'c1', centerName: 'X',
      lastCallAt: daysAgo(2), lastConversionScore: 25, lastTemperature: 'cold',
      openObjectionCount: 0, overdueActions: 0, pendingActions: 0,
      lastActivityAt: daysAgo(1), now: NOW,
    });
    expect(r.signals.map((s) => s.code).sort()).toEqual(['R2', 'R3']);
    expect(r.riskScore).toBe(35);
    expect(r.recommendedAction).toContain('پیگیری');
  });

  it('proforma without follow-up call after 5+ days (R6)', () => {
    const r = computeCenterRisk({
      centerId: 'c1', centerName: 'X',
      lastCallAt: daysAgo(30), lastConversionScore: 60, lastTemperature: 'warm',
      openObjectionCount: 0, overdueActions: 0, pendingActions: 0,
      lastActivityAt: daysAgo(35), lastProformaAt: daysAgo(8), now: NOW,
    });
    const codes = r.signals.map((s) => s.code);
    expect(codes).toContain('R6');
    expect(codes).toContain('R7'); // no activity for 30 days
  });

  it('no proforma signal when the call happened AFTER the proforma', () => {
    const r = computeCenterRisk({
      centerId: 'c1', centerName: 'X',
      lastCallAt: daysAgo(2), lastConversionScore: 60, lastTemperature: 'warm',
      openObjectionCount: 0, overdueActions: 0, pendingActions: 0,
      lastActivityAt: daysAgo(2), lastProformaAt: daysAgo(8), now: NOW,
    });
    expect(r.signals.map((s) => s.code)).not.toContain('R6');
  });

  it('bad payer adds R8 and total caps at 100', () => {
    const r = computeCenterRisk({
      centerId: 'c1', centerName: 'X',
      paymentBehavior: 'bad_payer',
      lastCallAt: null, lastConversionScore: 10, lastTemperature: 'cold',
      openObjectionCount: 5, overdueActions: 3, pendingActions: 4,
      lastActivityAt: null, now: NOW,
    });
    expect(r.riskScore).toBe(100);
    const codes = r.signals.map((s) => s.code);
    expect(codes).toContain('R4'); // no call at all + open actions
    expect(codes).toContain('R5'); // overdue actions
    expect(codes).toContain('R8');
    expect(r.recommendedAction).toContain('فوری');
  });

  it('risk >= 60 → urgent recommendation; every signal carries a human reason', () => {
    const r = computeCenterRisk({
      centerId: 'c1', centerName: 'X',
      lastCallAt: daysAgo(40), lastConversionScore: 20, lastTemperature: 'cold',
      openObjectionCount: 3, overdueActions: 2, pendingActions: 3,
      lastActivityAt: daysAgo(40), now: NOW,
    });
    expect(r.riskScore).toBeGreaterThanOrEqual(60);
    expect(r.recommendedAction).toContain('فوری');
    for (const s of r.signals) {
      expect(s.reason.length).toBeGreaterThan(5);
      expect(s.points).toBeGreaterThan(0);
    }
  });
});

describe('v2.27.0 — AI RBAC flags (ai.* permissions)', () => {
  it('admin gets every AI permission', () => {
    const p = getRolePermissions('admin');
    expect(p.ai_calls_read).toBe(true);
    expect(p.ai_transcript_read).toBe(true);
    expect(p.ai_manager_dashboard).toBe(true);
    expect(p.ai_playbook_manage).toBe(true);
    expect(p.ai_settings_manage).toBe(true);
    expect(p.ai_usage_view).toBe(true);
  });
  it('standard (sales expert) gets calls/coaching but NOT manager/settings/playbook', () => {
    const p = getRolePermissions('standard');
    expect(p.ai_calls_read).toBe(true);
    expect(p.ai_transcript_read).toBe(true);
    expect(p.ai_coaching_read).toBe(true);
    expect(p.ai_manager_dashboard).toBe(false);
    expect(p.ai_playbook_manage).toBe(false);
    expect(p.ai_settings_manage).toBe(false);
    expect(p.ai_usage_view).toBe(false);
  });
  it('finance/production get no AI access', () => {
    expect(getRolePermissions('finance').ai_calls_read).toBe(false);
    expect(getRolePermissions('production').ai_calls_read).toBe(false);
  });
});
