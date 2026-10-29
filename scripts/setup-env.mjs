#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// setup-env.mjs — v2.47.0 (called by setup.bat / setup.sh)
//
// Honest .env handling for BGL_HMAC_SECRET (the old setup.bat step
// printed «already set - not touching it» even when the variable was
// MISSING entirely — the round-≤46 packaged .env carried a secret under
// a name nothing in the app ever read):
//   • BGL_HMAC_SECRET already non-empty  → untouched, honest message
//   • BGL_HMAC_SECRET="" (empty)         → filled with a random 64-hex
//   • no BGL_HMAC_SECRET line at all     → APPENDED with a random 64-hex
//     (heals a .env copied from an older package that lacked the line)
// Exits non-zero only on I/O failure — never on «already set».
// ═══════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync } from 'fs';
import crypto from 'crypto';

const ENV_PATH = new URL('../.env', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');

if (!existsSync(ENV_PATH)) {
  console.error('[setup-env] .env not found — expected setup.bat to have created it.');
  process.exit(1);
}

let text = readFileSync(ENV_PATH, 'utf8');
const QUOTE = String.fromCharCode(34);
const KEY = 'BGL_HMAC_SECRET=';
const randomHex = () => crypto.randomBytes(32).toString('hex');

const emptyPattern = new RegExp(`^${KEY}${QUOTE}${QUOTE}\\s*$`, 'm');
const anyPattern = new RegExp(`^${KEY}.*$`, 'm');
const nonEmptyPattern = new RegExp(`^${KEY}${QUOTE}?.+${QUOTE}?$`, 'm');

if (nonEmptyPattern.test(text) && !emptyPattern.test(text)) {
  console.log('  BGL_HMAC_SECRET already set - not touching it.');
} else if (anyPattern.test(text)) {
  text = text.replace(emptyPattern, `${KEY}${QUOTE}${randomHex()}${QUOTE}`);
  writeFileSync(ENV_PATH, text);
  console.log('  Generated BGL_HMAC_SECRET (random 64-hex) into .env');
} else {
  if (!text.endsWith('\n')) text += '\n';
  text += `BGL_HMAC_SECRET=${QUOTE}${randomHex()}${QUOTE}\n`;
  writeFileSync(ENV_PATH, text);
  console.log('  APPENDED BGL_HMAC_SECRET (random 64-hex) into .env (line was missing)');
}
