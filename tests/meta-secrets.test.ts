// Unit tests — meta-key secret masking (v2.58.0, round 85 / audit 85-a #1).
// Real-world bug this guards: /api/settings `get` returned EVERY Meta row
// raw, so one admin response carried sms.api_key, sms.password,
// ai_bridge.api_key, ai_sales.telephony_secret and legacy hesabfa tokens
// straight to the browser (cache, devtools, proxy logs). The route now
// masks via maskMetaValue — these tests pin the classification contract.
import { describe, it, expect } from 'vitest';
import { isSecretMetaKey, maskMetaValue, SECRET_META_MASK } from '@/lib/meta-secrets';

describe('isSecretMetaKey — classification', () => {
  it('classifies every live credential key as secret', () => {
    for (const key of [
      'sms.api_key',
      'sms.password',
      'ai_bridge.api_key',
      'ai_sales.telephony_secret',
      'hesabfa.webhook_secret',
      'hesabfa.api_token',
    ]) {
      expect(isSecretMetaKey(key), key).toBe(true);
    }
  });

  it('never classifies ordinary config, policy or counter keys', () => {
    for (const key of [
      'app.name',
      'app.website',
      'sms.provider',
      'sms.sender',
      'sms.username',
      'sms.daily_limit',
      'sms.enabled',
      'ai_bridge.stt_url',
      'ai_bridge.stt_model',
      'ai_sales.stt_provider',
      'backup.history',
      'docseq.INV.260903',
      'dashboard.cmtdxbpl80001nzbodsg1en9j',
      // policy NUMBERS that merely START with a credential word — masked
      // values here would break the security settings screen:
      'security.password_min_length',
      'security.require_upper',
      'security.session_minutes',
    ]) {
      expect(isSecretMetaKey(key), key).toBe(false);
    }
  });

  it('recognizes separator variants of credential segments', () => {
    expect(isSecretMetaKey('x.apikey')).toBe(true);
    expect(isSecretMetaKey('x.api-key')).toBe(true);
    expect(isSecretMetaKey('unit.telephony_secret')).toBe(true);
    // the credential word must END its segment, not just appear in it
    expect(isSecretMetaKey('x.password_policy_note')).toBe(false);
    expect(isSecretMetaKey('x.resettokens')).toBe(false);
  });
});

describe('maskMetaValue — masking behavior', () => {
  it('masks a configured secret, never leaks its value', () => {
    expect(maskMetaValue('sms.api_key', 'SG.kj3ht983ht9')).toBe(SECRET_META_MASK);
    expect(maskMetaValue('sms.api_key', 'SG.kj3ht983ht9')).not.toContain('SG');
  });

  it('keeps an unset secret as empty string (is-configured stays distinguishable)', () => {
    expect(maskMetaValue('sms.password', '')).toBe('');
  });

  it('passes non-secret values through untouched', () => {
    expect(maskMetaValue('app.name', 'سامانه فروش')).toBe('سامانه فروش');
    expect(maskMetaValue('docseq.INV.260903', '4')).toBe('4');
    expect(maskMetaValue('security.password_min_length', '8')).toBe('8');
  });
});
