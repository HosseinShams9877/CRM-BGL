// ════════════════════════════════════════════════════════
// Meta-key secret classification (v2.58.0, audit 85-a #1)
//
// /api/settings used to dump every Meta row RAW — including third-party
// credentials (sms.api_key / sms.password / ai_bridge.api_key /
// ai_sales.telephony_secret / hesabfa tokens). This lib centralizes the
// classification + masking so the route and its unit tests share ONE
// contract (mirrors the masking discipline of /api/ai-bridge,
// /api/ai-sales/settings and lib/sms/settings.ts).
//
// Classification rule: a key is a secret when one of its DOT-separated
// segments ENDS with a credential word (password | api[_-]?key | token |
// secret | credential), preceded by a segment start or _ / -. Ending
// (not containing) is what keeps policy keys like
// `security.password_min_length` OUT — the tests pin this exact contract.
// ════════════════════════════════════════════════════════

const SECRET_SEG_RE = /(?:^|[_-])(?:password|api[_-]?key|token|secret|credential)$/i;

/** Meta keys whose value is a credential — never returned raw to a client. */
export function isSecretMetaKey(key: string): boolean {
  return key.split('.').some((seg) => SECRET_SEG_RE.test(seg));
}

/** Mask used for a configured secret; an unset secret stays ''. */
export const SECRET_META_MASK = '••••••••';

/** Mask the value when (and only when) its key names a credential. */
export function maskMetaValue(key: string, value: string): string {
  return isSecretMetaKey(key) ? (value ? SECRET_META_MASK : '') : value;
}
