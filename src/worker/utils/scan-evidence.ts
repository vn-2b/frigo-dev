import type { LotExpiryFields } from './inventory-authority';

// T13 receipt/vision truth mapping. Everything here converts EVIDENCE (OCR /
// vision extraction plus the user's review) into the exact inputs the T09 lot
// authority accepts. Nothing in this module writes inventory: it only decides
// what is provable. The governing invariants are DEC-003 and MASTER_CONTEXT:
// UNKNOWN != ZERO, ESTIMATED != CONFIRMED, and no fabricated purchase, price,
// merchant or expiry fact.

/** Server-side scan type. Never derived from client-supplied text. */
export type ScanProvenanceType = 'RECEIPT' | 'SCAN';

/**
 * Authoritative provenance for a confirmed line. `scan_type` is the column the
 * server itself wrote when the scan was created, so a client cannot relabel a
 * fridge photo as a receipt (or the reverse) to smuggle purchase facts in.
 */
export function scanProvenance(scanType: unknown): ScanProvenanceType {
  return scanType === 'receipt' ? 'RECEIPT' : 'SCAN';
}

/** UI-facing provenance label source. Receipts stay distinguishable from scans. */
export function provenanceDataSource(sourceType: string): string {
  switch (sourceType) {
    case 'RECEIPT': return 'receipt';
    case 'SCAN': return 'scan';
    case 'SHOPPING': return 'shopping';
    case 'LEGACY_BACKFILL': return 'legacy';
    default: return 'manual';
  }
}

/**
 * How a confirmed expiry date was established.
 *   `supplied`  - an explicit dated fact (user date picker, receipt-printed
 *                 expiry). Becomes KNOWN.
 *   `inferred`  - derived from a day chip or a default shelf life. Becomes
 *                 ESTIMATED, never KNOWN.
 *   `absent`    - no date and no sanctioned estimate. Becomes UNKNOWN.
 */
export type ExpiryBasis = 'supplied' | 'inferred' | 'absent';

export const UNKNOWN_EXPIRY: LotExpiryFields = {
  expiryAt: null, estimatedExpiryAt: null, expiryKind: 'UNKNOWN',
};

/**
 * Expiry truth mapper. A date without a basis is never promoted: an inferred
 * shelf-life date is ESTIMATED evidence, so it lands in `estimatedExpiryAt`
 * and can never silently become KNOWN authority.
 */
export function lotExpiryFromEvidence(expiryDate: string | null | undefined,
  basis: ExpiryBasis): LotExpiryFields {
  if (basis === 'absent' || !expiryDate) return { ...UNKNOWN_EXPIRY };
  if (basis === 'inferred') {
    return { expiryAt: null, estimatedExpiryAt: expiryDate, expiryKind: 'ESTIMATED' };
  }
  return { expiryAt: expiryDate, estimatedExpiryAt: null, expiryKind: 'KNOWN' };
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Accept a calendar date only when it is a real, unambiguous day. A malformed
 * or impossible OCR date is absence, never a coerced "today".
 */
export function trustworthyCalendarDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!CALENDAR_DATE.test(trimmed)) return null;
  const [year, month, day] = trimmed.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1] ? trimmed : null;
}

export interface PurchasePriceMinor {
  currency: 'VND';
  amountMinor: number;
  minorDigits: 0;
}

/**
 * Convert a receipt money fact into the project's exact minor-unit
 * representation. VND has zero minor digits, so only whole đồng are
 * representable; a fractional or out-of-range OCR amount is unprovable and
 * therefore absent. Missing price stays null — it is never coerced to 0,
 * because 0đ is itself a factual claim.
 */
export function receiptPurchasePrice(amountVnd: unknown): PurchasePriceMinor | null {
  if (amountVnd === null || amountVnd === undefined) return null;
  const amount = Number(amountVnd);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (!Number.isSafeInteger(amount)) return null;
  return { currency: 'VND', amountMinor: amount, minorDigits: 0 };
}

export interface ReceiptLineFacts {
  /** Receipt-level purchase date, when the receipt actually carries one. */
  purchasedAt: string | null;
  /** Line total in VND minor units, when the receipt actually carries one. */
  purchasePrice: PurchasePriceMinor | null;
}

/**
 * Purchase facts for one confirmed receipt line. Fridge scans carry none: a
 * photo of a fridge proves nothing about what anything cost or when it was
 * bought, so inventing those facts there would be fabrication.
 */
export function receiptLineFacts(provenance: ScanProvenanceType, scan: {
  purchase_date?: unknown;
}, line: { total_price_vnd?: unknown; unit_price_vnd?: unknown; estimated_quantity?: unknown }): ReceiptLineFacts {
  if (provenance !== 'RECEIPT') return { purchasedAt: null, purchasePrice: null };
  // Prefer the printed line total. A unit price is only promoted to a line
  // total when the multiplication is exact and the quantity is a whole count;
  // a derived fractional amount is an estimate, not a receipt fact.
  let price = receiptPurchasePrice(line.total_price_vnd);
  if (price === null) {
    // A missing unit price must stay missing. `Number(null)` is 0, so an
    // absent column would otherwise fabricate a "this cost 0₫" receipt fact.
    if (line.unit_price_vnd === null || line.unit_price_vnd === undefined) {
      return { purchasedAt: trustworthyCalendarDate(scan.purchase_date), purchasePrice: null };
    }
    const unitPrice = Number(line.unit_price_vnd);
    const quantity = Number(line.estimated_quantity);
    if (Number.isSafeInteger(unitPrice) && unitPrice >= 0
      && Number.isSafeInteger(quantity) && quantity > 0) {
      price = receiptPurchasePrice(unitPrice * quantity);
    }
  }
  return { purchasedAt: trustworthyCalendarDate(scan.purchase_date), purchasePrice: price };
}

export interface RawScanEvidence {
  rawName: string | null;
  quantity: number | null;
  unit: string | null;
}

/** Raw extraction as persisted by 0031; absent when it was never retained. */
export function rawScanEvidence(row: {
  ocr_raw_name?: unknown; ocr_quantity?: unknown; ocr_unit?: unknown;
}): RawScanEvidence {
  const quantity = row.ocr_quantity === null || row.ocr_quantity === undefined
    ? null : Number(row.ocr_quantity);
  return {
    rawName: typeof row.ocr_raw_name === 'string' ? row.ocr_raw_name : null,
    quantity: quantity !== null && Number.isFinite(quantity) && quantity > 0 ? quantity : null,
    unit: typeof row.ocr_unit === 'string' ? row.ocr_unit : null,
  };
}

/**
 * Whether the user's confirmed values differ from the retained extraction.
 * Used to record correction provenance so raw and confirmed stay separable
 * after the fact.
 */
export function correctionOf(raw: RawScanEvidence, confirmed: {
  name: string; quantity: number; unit: string;
}): { corrected: boolean; raw: RawScanEvidence } {
  const corrected = (raw.rawName !== null && raw.rawName !== confirmed.name)
    || (raw.quantity !== null && raw.quantity !== confirmed.quantity)
    || (raw.unit !== null && raw.unit !== confirmed.unit);
  return { corrected, raw };
}
