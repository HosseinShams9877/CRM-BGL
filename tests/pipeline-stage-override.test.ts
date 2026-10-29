// ════════════════════════════════════════════════════════════════
// pipeline-stage-override.test.ts — v2.45.0 (r70) regression tests
// for the drag & drop stage-pin contract.
//
// User request: «کاریز فروش — جابه‌جایی مراحل با درگ کردن و جابه‌جایی
// با موس بین ستون‌ها باشد» — cards must be movable between columns
// with the mouse. These tests pin the PURE decision logic shared by
// the board, the center dossier, and the move-stage API.
// ════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  PIPELINE_STAGE_KEYS,
  PINNABLE_STAGE_KEYS,
  PIPELINE_STAGE_LABELS,
  isPipelineStageKey,
  isPinnableStage,
  normalizePinnedStage,
  effectiveStage,
  planStageMove,
  workflowEventClearsPin,
} from '@/lib/pipeline-stage-override';

describe('stage key sets (user contract)', () => {
  it('exposes the board\u2019s ۸ columns (۷ live stages + terminal لغو)', () => {
    expect(PIPELINE_STAGE_KEYS).toHaveLength(8);
    expect(PIPELINE_STAGE_KEYS).toContain('presentation');
    expect(PIPELINE_STAGE_KEYS).toContain('dispatch');
    expect(PIPELINE_STAGE_KEYS).toContain('cancelled');
  });

  it('the terminal «لغو شده» column is NOT pinnable (drag ≠ cancel)', () => {
    expect(PINNABLE_STAGE_KEYS).toHaveLength(7);
    expect(PINNABLE_STAGE_KEYS).not.toContain('cancelled');
    expect(isPinnableStage('cancelled')).toBe(false);
  });

  it('every pinnable stage carries a Persian label (API messages)', () => {
    for (const k of PINNABLE_STAGE_KEYS) {
      expect(PIPELINE_STAGE_LABELS[k].length).toBeGreaterThan(0);
    }
  });
});

describe('isPipelineStageKey / normalizePinnedStage', () => {
  it('accepts the known keys', () => {
    for (const k of PIPELINE_STAGE_KEYS) expect(isPipelineStageKey(k)).toBe(true);
  });

  it('rejects junk without throwing', () => {
    expect(isPipelineStageKey('nonsense')).toBe(false);
    expect(isPipelineStageKey(null)).toBe(false);
    expect(isPipelineStageKey(42)).toBe(false);
    expect(isPipelineStageKey(undefined)).toBe(false);
  });

  it('normalize collapses junk / cancelled / wrong types to null → derived', () => {
    expect(normalizePinnedStage('hacked-value')).toBeNull();
    expect(normalizePinnedStage('cancelled')).toBeNull();
    expect(normalizePinnedStage(null)).toBeNull();
    expect(normalizePinnedStage(undefined)).toBeNull();
    expect(normalizePinnedStage({ stage: 'invoice' })).toBeNull();
  });

  it('normalize keeps a valid pin intact', () => {
    expect(normalizePinnedStage('negotiation')).toBe('negotiation');
    expect(normalizePinnedStage('proforma-followup')).toBe('proforma-followup');
  });
});

describe('effectiveStage — pin over derived, cancelled always terminal', () => {
  it('null pin → the derived stage, bit-for-bit (legacy rows unchanged)', () => {
    expect(effectiveStage('proforma', null, 'draft')).toBe('proforma');
    expect(effectiveStage('invoice', undefined, 'approved')).toBe('invoice');
  });

  it('a valid pin WINS over the derived stage (the point of drag & drop)', () => {
    expect(effectiveStage('presentation', 'negotiation', 'draft')).toBe('negotiation');
    expect(effectiveStage('invoice', 'proforma', 'approved')).toBe('proforma');
  });

  it('an invalid stored pin is ignored (board never breaks on bad data)', () => {
    expect(effectiveStage('proforma', 'legacy-junk', 'draft')).toBe('proforma');
  });

  it('a CANCELLED document stays terminal even if a pin survived', () => {
    expect(effectiveStage('cancelled', 'negotiation', 'cancelled')).toBe('cancelled');
  });
});

describe('planStageMove — what a drop resolves to', () => {
  it('same column → no-op', () => {
    expect(planStageMove({ from: 'invoice', target: 'invoice', liveStatus: 'approved', hasRealShipment: false }))
      .toEqual({ kind: 'same' });
  });

  it('a live card dragged to another column → a real pinned move', () => {
    const plan = planStageMove({ from: 'presentation', target: 'negotiation', liveStatus: 'draft', hasRealShipment: false });
    expect(plan).toEqual({ kind: 'pin', stage: 'negotiation' });
  });

  it('dragging INTO the terminal لغو column is rejected with guidance', () => {
    const plan = planStageMove({ from: 'proforma', target: 'cancelled', liveStatus: 'draft', hasRealShipment: false });
    expect(plan.kind).toBe('rejected');
    if (plan.kind === 'rejected') {
      expect(plan.reason).toContain('لغو');
    }
  });

  it('a cancelled card refuses to move at all', () => {
    const plan = planStageMove({ from: 'cancelled', target: 'negotiation', liveStatus: 'cancelled', hasRealShipment: false });
    expect(plan.kind).toBe('rejected');
  });

  it('a dispatched card may be dragged out (manual override) even with a real shipment', () => {
    const plan = planStageMove({ from: 'dispatch', target: 'invoice', liveStatus: 'approved', hasRealShipment: true });
    expect(plan).toEqual({ kind: 'pin', stage: 'invoice' });
  });

  it('an approved card may be dragged into «ارسال بار» (with the real-send hint left to the caller)', () => {
    const plan = planStageMove({ from: 'invoice', target: 'dispatch', liveStatus: 'approved', hasRealShipment: false });
    expect(plan).toEqual({ kind: 'pin', stage: 'dispatch' });
  });
});

describe('workflowEventClearsPin — real events supersede manual placement', () => {
  it('every status transition + shipment event clears the pin', () => {
    for (const ev of ['submit-approval', 'approve', 'reject', 'cancel', 'shipment-created', 'shipment-returned', 'shipment-deleted']) {
      expect(workflowEventClearsPin(ev)).toBe(true);
    }
  });

  it('irrelevant events leave the pin alone', () => {
    expect(workflowEventClearsPin('move-stage')).toBe(false);
    expect(workflowEventClearsPin('update')).toBe(false);
    expect(workflowEventClearsPin('add-payment')).toBe(false);
  });
});
