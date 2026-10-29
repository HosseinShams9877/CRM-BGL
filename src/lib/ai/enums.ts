// ════════════════════════════════════════════════════════════
// AI SALES ENUM SETS (v2.27.0)
// Set variants of the const arrays in ./types for O(1) validation
// without importing server-only modules.
// ════════════════════════════════════════════════════════════

import {
  AI_INTENTS,
  AI_OBJECTION_TYPES,
  AI_ACTION_TYPES,
  AI_BUYING_ROLES,
} from './types';

export const AI_INTENTS_SET = new Set<string>(AI_INTENTS);
export { AI_INTENTS };
export const AI_TEMPERATURES_SET = new Set<string>(['cold', 'warm', 'hot', 'very_hot']);
export const AI_OBJECTION_TYPES_SET = new Set<string>(AI_OBJECTION_TYPES);
export const AI_ACTION_TYPES_SET = new Set<string>(AI_ACTION_TYPES);
export const AI_BUYING_ROLES_SET = new Set<string>(AI_BUYING_ROLES);
