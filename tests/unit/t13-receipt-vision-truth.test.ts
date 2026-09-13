import { describe, expect, it } from 'vitest';
import {
  correctionOf, lotExpiryFromEvidence, provenanceDataSource, rawScanEvidence,
  receiptLineFacts, receiptPurchasePrice, scanProvenance, trustworthyCalendarDate,
} from '../../src/worker/routes/../utils/scan-evidence';
import { ReceiptScanResultSchema, ReceiptItemSchema } from '../../packages/ai/src/schemas';
import { CloudflareAIProvider } from '../../packages/ai/src/providers/cloudflare';
import { MockAIProvider } from '../../packages/ai/src/providers/mock';

// T13 unit coverage for the receipt/vision truth boundary: what may become a
// fact, what must stay unknown, and what a provider is forbidden to invent.

describe('T13 expiry truth mapping', () => {
  it('promotes only an explicitly supplied date to KNOWN', () => {
    expect(lotExpiryFromEvidence('2026-09-20', 'supplied')).toEqual({
      expiryAt: '2026-09-20', estimatedExpiryAt: null, expiryKind: 'KNOWN',
    });
  });

  it('keeps an inferred shelf-life date ESTIMATED, never KNOWN', () => {
    expect(lotExpiryFromEvidence('2026-09-20', 'inferred')).toEqual({
      expiryAt: null, estimatedExpiryAt: '2026-09-20', expiryKind: 'ESTIMATED',
    });
  });

  it('represents no basis as UNKNOWN rather than a fabricated date', () => {
    expect(lotExpiryFromEvidence(null, 'absent')).toEqual({
      expiryAt: null, estimatedExpiryAt: null, expiryKind: 'UNKNOWN',
    });
    // A date with no basis cannot smuggle itself in as authority.
    expect(lotExpiryFromEvidence('2026-09-20', 'absent').expiryKind).toBe('UNKNOWN');
    // A basis with no date is still nothing.
    expect(lotExpiryFromEvidence(null, 'supplied').expiryKind).toBe('UNKNOWN');
  });

  it('never silently upgrades ESTIMATED to KNOWN', () => {
    const estimated = lotExpiryFromEvidence('2026-09-20', 'inferred');
    expect(estimated.expiryKind).toBe('ESTIMATED');
    expect(estimated.expiryAt).toBeNull();
  });
});

describe('T13 provenance', () => {
  it('derives provenance from the server-side scan type only', () => {
    expect(scanProvenance('receipt')).toBe('RECEIPT');
    expect(scanProvenance('fridge')).toBe('SCAN');
  });

  it('treats arbitrary client-controlled text as a fridge scan, never a receipt', () => {
    for (const hostile of ['RECEIPT', 'Receipt', 'receipt ', 'hoa-don', '', null, undefined, 1]) {
      expect(scanProvenance(hostile)).toBe('SCAN');
    }
  });

  it('exposes distinguishable UI provenance labels', () => {
    expect(provenanceDataSource('RECEIPT')).toBe('receipt');
    expect(provenanceDataSource('SCAN')).toBe('scan');
    expect(provenanceDataSource('MANUAL')).toBe('manual');
    expect(provenanceDataSource('LEGACY_BACKFILL')).toBe('legacy');
    expect(provenanceDataSource('SHOPPING')).toBe('shopping');
  });
});

describe('T13 purchase facts', () => {
  it('maps a whole-đồng amount into exact VND minor units', () => {
    expect(receiptPurchasePrice(85000)).toEqual({ currency: 'VND', amountMinor: 85000, minorDigits: 0 });
  });

  it('keeps a missing price absent instead of 0', () => {
    expect(receiptPurchasePrice(undefined)).toBeNull();
    expect(receiptPurchasePrice(null)).toBeNull();
    // 0 is a real supplied fact and must survive as one.
    expect(receiptPurchasePrice(0)).toEqual({ currency: 'VND', amountMinor: 0, minorDigits: 0 });
  });

  it('refuses unrepresentable amounts rather than rounding them', () => {
    // VND has no minor digits: a fractional đồng cannot be represented exactly.
    expect(receiptPurchasePrice(1000.5)).toBeNull();
    expect(receiptPurchasePrice(-1)).toBeNull();
    expect(receiptPurchasePrice(Number.NaN)).toBeNull();
    expect(receiptPurchasePrice(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });

  it('accepts only real calendar dates and never coerces today', () => {
    expect(trustworthyCalendarDate('2026-09-10')).toBe('2026-09-10');
    expect(trustworthyCalendarDate('2026-02-29')).toBeNull(); // 2026 is not a leap year
    expect(trustworthyCalendarDate('2026-13-01')).toBeNull();
    expect(trustworthyCalendarDate('10/09/2026')).toBeNull();
    expect(trustworthyCalendarDate('')).toBeNull();
    expect(trustworthyCalendarDate(undefined)).toBeNull();
  });

  it('carries receipt purchase facts and leaves absent ones null', () => {
    const facts = receiptLineFacts('RECEIPT', { purchase_date: '2026-09-10' },
      { total_price_vnd: 85000 });
    expect(facts).toEqual({
      purchasedAt: '2026-09-10',
      purchasePrice: { currency: 'VND', amountMinor: 85000, minorDigits: 0 },
    });

    const missing = receiptLineFacts('RECEIPT', { purchase_date: null }, {});
    expect(missing).toEqual({ purchasedAt: null, purchasePrice: null });
  });

  it('derives a line total from a unit price only when the product is exact', () => {
    expect(receiptLineFacts('RECEIPT', {}, { unit_price_vnd: 15000, estimated_quantity: 2 }).purchasePrice)
      .toEqual({ currency: 'VND', amountMinor: 30000, minorDigits: 0 });
    // A fractional quantity makes the product an estimate, not a receipt fact.
    expect(receiptLineFacts('RECEIPT', {}, { unit_price_vnd: 15000, estimated_quantity: 0.5 }).purchasePrice)
      .toBeNull();
  });

  it('never turns a NULL unit price into a 0₫ fact', () => {
    // Number(null) === 0, so an absent column must be rejected before coercion.
    expect(receiptLineFacts('RECEIPT', {}, {
      total_price_vnd: null, unit_price_vnd: null, estimated_quantity: 3,
    }).purchasePrice).toBeNull();
    expect(receiptLineFacts('RECEIPT', {}, { estimated_quantity: 3 }).purchasePrice).toBeNull();
  });

  it('never attributes purchase facts to a fridge scan', () => {
    expect(receiptLineFacts('SCAN', { purchase_date: '2026-09-10' }, { total_price_vnd: 85000 }))
      .toEqual({ purchasedAt: null, purchasePrice: null });
  });
});

describe('T13 raw vs confirmed evidence', () => {
  it('reads retained raw extraction', () => {
    expect(rawScanEvidence({ ocr_raw_name: 'Thịt heo', ocr_quantity: 2, ocr_unit: 'kg' }))
      .toEqual({ rawName: 'Thịt heo', quantity: 2, unit: 'kg' });
  });

  it('reports absent raw evidence as absent', () => {
    expect(rawScanEvidence({ ocr_raw_name: null, ocr_quantity: null, ocr_unit: null }))
      .toEqual({ rawName: null, quantity: null, unit: null });
  });

  it('keeps raw and confirmed separable after a correction', () => {
    const raw = rawScanEvidence({ ocr_raw_name: 'Thịt heo', ocr_quantity: 2, ocr_unit: 'kg' });
    const result = correctionOf(raw, { name: 'Thịt heo', quantity: 1.2, unit: 'kg' });
    expect(result.corrected).toBe(true);
    // The OCR claim of 2 kg survives alongside the confirmed 1.2 kg.
    expect(result.raw.quantity).toBe(2);
  });

  it('does not report a correction when the user accepted the extraction', () => {
    const raw = rawScanEvidence({ ocr_raw_name: 'Trứng gà', ocr_quantity: 6, ocr_unit: 'piece' });
    expect(correctionOf(raw, { name: 'Trứng gà', quantity: 6, unit: 'piece' }).corrected).toBe(false);
  });
});

describe('T13 provider no-fabrication', () => {
  it('allows legitimate absence in the receipt schema', () => {
    const parsed = ReceiptScanResultSchema.parse({ items: [] });
    expect(parsed.merchant_name).toBeUndefined();
    expect(parsed.purchase_date).toBeUndefined();
    expect(parsed.total_amount_vnd).toBeUndefined();
  });

  it('no longer defaults a missing confidence to 0.9', () => {
    const parsed = ReceiptItemSchema.parse({ raw_name: 'Cà chua', estimated_quantity: 2, unit: 'piece' });
    expect(parsed.confidence).toBeUndefined();
  });

  it('keeps an explicitly reported low confidence exactly', () => {
    expect(ReceiptItemSchema.parse({
      raw_name: 'Cà chua', estimated_quantity: 2, unit: 'piece', confidence: 0.12,
    }).confidence).toBe(0.12);
  });

  it('stops the Cloudflare provider fabricating price, date, merchant and confidence', async () => {
    const provider = new CloudflareAIProvider({
      run: async (_model: string, inputs: any) => {
        if (inputs?.prompt === 'agree') return {};
        // A receipt the model could only partially read.
        return { response: JSON.stringify({ items: [{ raw_name: 'Cà chua', estimated_quantity: 2, unit: 'piece' }] }) };
      },
    });
    const result = await provider.receiptScan({ imageBase64OrUrl: btoa('image-bytes'), mimeType: 'image/webp' });
    expect(result.merchant_name).toBeUndefined();
    expect(result.purchase_date).toBeUndefined();
    expect(result.total_amount_vnd).toBeUndefined();
    const [item] = result.items;
    expect(item.unit_price_vnd).toBeUndefined();
    expect(item.total_price_vnd).toBeUndefined();
    expect(item.confidence).toBeUndefined();
    // The whole result must still satisfy the schema with everything absent.
    expect(() => ReceiptScanResultSchema.parse(result)).not.toThrow();
  });

  it('preserves a genuinely reported low confidence instead of flooring it to 0.5', async () => {
    const provider = new CloudflareAIProvider({
      run: async (_model: string, inputs: any) => {
        if (inputs?.prompt === 'agree') return {};
        return { response: JSON.stringify({
          merchant_name: 'WinMart', purchase_date: '2026-09-10', total_amount_vnd: 85000,
          items: [{ raw_name: 'Thịt heo', estimated_quantity: 2, unit: 'kg',
            total_price_vnd: 85000, confidence: 0.11 }],
        }) };
      },
    });
    const result = await provider.receiptScan({ imageBase64OrUrl: btoa('image-bytes'), mimeType: 'image/webp' });
    expect(result.items[0].confidence).toBe(0.11);
    // Real facts still survive exactly when the model did read them.
    expect(result.merchant_name).toBe('WinMart');
    expect(result.purchase_date).toBe('2026-09-10');
    expect(result.items[0].total_price_vnd).toBe(85000);
  });

  it('emits a mock purchase date the receipt truth mapper can actually accept', async () => {
    // Regression: the mock emitted a vi-VN locale string ("13/9/2026"), so a
    // date the fixture genuinely carried was dropped as unprovable in every
    // preview and AI_MOCK_MODE run.
    const result = await new MockAIProvider().receiptScan({
      imageBase64OrUrl: btoa('image-bytes'), mimeType: 'image/webp',
    });
    expect(result.purchase_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(trustworthyCalendarDate(result.purchase_date)).toBe(result.purchase_date);
  });
});
