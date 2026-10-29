// tests/hesabfa-serial.test.ts — v2.57.0 (round 83)
// Pure contracts of the Hesabfa serial engine + env mapping + AFS.
import { describe, it, expect } from 'vitest';
import {
  extractSerialsFromText, extractSerialsFromItem, extractSerialsFromItems,
  decideSerialSync, historyActionFor, historyDescriptionFor, availableForSale,
  OPERATIONAL_SERIAL_STATUSES, hesabfaInvoiceTypeLabel,
  HESABFA_INVOICE_SALE, HESABFA_INVOICE_PURCHASE,
} from '../src/lib/hesabfa-serial';

describe('extractSerialsFromText', () => {
  it('finds all three prefixes', () => {
    expect(extractSerialsFromText('OXP031322 و OX4455 و SC9911')).toEqual(['OXP031322', 'OX4455', 'SC9911']);
  });
  it('matches lowercase variants (legacy data had them)', () => {
    expect(extractSerialsFromText('oxp2219 ok د')).toEqual(['OXP2219']);
  });
  it('keeps inner dashes', () => {
    expect(extractSerialsFromText('SC-1200-44')).toEqual(['SC-1200-44']);
  });
  it('rejects too-short words (prefix + <4 chars)', () => {
    expect(extractSerialsFromText('OX12 OX1')).toEqual([]);
  });
  it('scans Persian-separated tokens (، ؛)', () => {
    expect(extractSerialsFromText('OXP031322، OX4455؛ SC9911')).toEqual(['OXP031322', 'OX4455', 'SC9911']);
  });
  it('ignores words that merely start with the letters', () => {
    expect(extractSerialsFromText('OXAN دستگاه SCUFFER لوله')).toEqual([]);
  });
  it('non-string / empty → []', () => {
    expect(extractSerialsFromText(null)).toEqual([]);
    expect(extractSerialsFromText(undefined)).toEqual([]);
    expect(extractSerialsFromText('')).toEqual([]);
    expect(extractSerialsFromText(42)).toEqual([]);
  });
  it('dedupes (uppercase normalization)', () => {
    expect(extractSerialsFromText('oxp1234 OXP1234')).toEqual(['OXP1234']);
  });
});

describe('extractSerialsFromItem(s)', () => {
  it('scans Description / Note / Tag fields', () => {
    const item = { Description: 'سریال: OXP031322', Note: '', Tag: 'OX4455' };
    expect(extractSerialsFromItem(item)).toEqual(['OXP031322', 'OX4455']);
  });
  it('dedupes across fields and items', () => {
    const items = [
      { Description: 'SC9911', RowDescription: 'SC9911' },
      { Name: 'OX4455' },
      { Description: 'OX4455' },
    ];
    expect(extractSerialsFromItems(items)).toEqual(['SC9911', 'OX4455']);
  });
  it('non-array input → []', () => {
    expect(extractSerialsFromItems(null)).toEqual([]);
    expect(extractSerialsFromItems('OX4455')).toEqual([]);
  });
});

describe('decideSerialSync — purchase (type 1)', () => {
  it('unknown serial → create-available (enters stock)', () => {
    expect(decideSerialSync(HESABFA_INVOICE_PURCHASE, null)).toEqual({ kind: 'create-available' });
  });
  it('available serial → update-meta only (no duplicate history)', () => {
    expect(decideSerialSync(HESABFA_INVOICE_PURCHASE, 'available')).toEqual({ kind: 'update-meta' });
  });
  it('returned / defective → restock', () => {
    expect(decideSerialSync(HESABFA_INVOICE_PURCHASE, 'returned')).toEqual({ kind: 'restock' });
    expect(decideSerialSync(HESABFA_INVOICE_PURCHASE, 'defective')).toEqual({ kind: 'restock' });
  });
  it('sold serial → update-meta (historical purchase keeps sold)', () => {
    expect(decideSerialSync(HESABFA_INVOICE_PURCHASE, 'sold')).toEqual({ kind: 'update-meta' });
  });
});

describe('decideSerialSync — sale (type 0)', () => {
  it('unknown serial → create-sold (late discovery)', () => {
    expect(decideSerialSync(HESABFA_INVOICE_SALE, null)).toEqual({ kind: 'create-sold' });
  });
  it('available → mark-sold', () => {
    expect(decideSerialSync(HESABFA_INVOICE_SALE, 'available')).toEqual({ kind: 'mark-sold' });
  });
  it('sold → update-meta (idempotent re-sync)', () => {
    expect(decideSerialSync(HESABFA_INVOICE_SALE, 'sold')).toEqual({ kind: 'update-meta' });
  });
  it('returned/defective stay kept (operational reality wins)', () => {
    expect(decideSerialSync(HESABFA_INVOICE_SALE, 'returned')).toEqual({ kind: 'skip-kept' });
    expect(decideSerialSync(HESABFA_INVOICE_SALE, 'defective')).toEqual({ kind: 'skip-kept' });
  });
});

describe('decideSerialSync — operational statuses NEVER clobbered', () => {
  it('demo / reserved / expert are skipped on BOTH invoice types', () => {
    for (const st of ['demo', 'reserved', 'expert']) {
      expect(decideSerialSync(HESABFA_INVOICE_SALE, st)).toEqual({ kind: 'skip-operational' });
      expect(decideSerialSync(HESABFA_INVOICE_PURCHASE, st)).toEqual({ kind: 'skip-operational' });
      expect(OPERATIONAL_SERIAL_STATUSES.has(st)).toBe(true);
    }
  });
  it('case-insensitive status matching', () => {
    expect(decideSerialSync(HESABFA_INVOICE_SALE, 'Demo')).toEqual({ kind: 'skip-operational' });
    expect(decideSerialSync(HESABFA_INVOICE_SALE, 'RESERVED')).toEqual({ kind: 'skip-operational' });
  });
  it('empty-string status behaves like unknown', () => {
    expect(decideSerialSync(HESABFA_INVOICE_SALE, '')).toEqual({ kind: 'create-sold' });
  });
});

describe('history helpers', () => {
  it('actions map to the CRM lifecycle vocabulary', () => {
    expect(historyActionFor({ kind: 'create-available' }, 1)).toBe('entered');
    expect(historyActionFor({ kind: 'mark-sold' }, 0)).toBe('sold');
    expect(historyActionFor({ kind: 'restock' }, 1)).toBe('adjusted');
    expect(historyActionFor({ kind: 'update-meta' }, 0)).toBe('synced');
  });
  it('descriptions reuse the legacy wording family', () => {
    expect(historyDescriptionFor({ kind: 'create-sold' }, 0, '1023')).toContain('سینک فروش سریال از فاکتور فروش حسابفا');
    expect(historyDescriptionFor({ kind: 'create-available' }, 1, '1024')).toContain('سینک ورود/موجودی سریال از فاکتور خرید حسابفا');
  });
});

describe('hesabfaInvoiceTypeLabel (legacy mapping)', () => {
  it('0 = فروش, 1 = خرید', () => {
    expect(hesabfaInvoiceTypeLabel(0)).toBe('فروش');
    expect(hesabfaInvoiceTypeLabel(1)).toBe('خرید');
  });
});

describe('availableForSale (spec formula)', () => {
  it('stock − active reservations', () => {
    expect(availableForSale(10, [{ expiresAt: null }])).toBe(9);
    expect(availableForSale(10, [{ expiresAt: new Date(Date.now() + 60_000) }])).toBe(9);
  });
  it('expired reservations no longer reduce availability', () => {
    expect(availableForSale(10, [{ expiresAt: new Date(Date.now() - 60_000) }])).toBe(10);
  });
  it('never goes below zero', () => {
    expect(availableForSale(2, [{ expiresAt: null }, { expiresAt: null }, { expiresAt: null }])).toBe(0);
  });
});
