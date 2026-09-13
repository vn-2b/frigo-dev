// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  presentConfidence, presentDomainError, presentExpiry, presentPrice,
  presentPurchaseDate, provenanceLabel,
} from '../../src/web/lib/inventory-truth';
import { inventoryTruthApi, MAX_DECISION_KEY } from '../../src/web/services/inventory-truth';

// T13 Inventory UX V2 presentation truth: what the user is allowed to be told.

const NOW = Date.parse('2026-09-11T00:00:00Z');

describe('T13 expiry presentation', () => {
  it('AC11: UNKNOWN expiry is visibly distinct and never reads as fresh', () => {
    const unknown = presentExpiry({ expiryKind: 'UNKNOWN', expiryAt: null, estimatedExpiryAt: null }, NOW);
    expect(unknown.tone).toBe('unknown');
    expect(unknown.date).toBeNull();
    expect(unknown.label).toContain('Chưa rõ');
    expect(unknown.tone).not.toBe('fresh');
  });

  it('AC3: an estimated date is labelled as an estimate, not a fact', () => {
    const estimated = presentExpiry({ expiryKind: 'ESTIMATED', expiryAt: null, estimatedExpiryAt: '2026-09-20' }, NOW);
    expect(estimated.tone).toBe('estimated');
    expect(estimated.estimated).toBe(true);
    expect(estimated.label).toContain('ước tính');
    expect(estimated.date).toBe('2026-09-20');
  });

  it('presents a known future date as fresh and a past one as expired', () => {
    expect(presentExpiry({ expiryKind: 'KNOWN', expiryAt: '2026-09-30' }, NOW).tone).toBe('fresh');
    expect(presentExpiry({ expiryKind: 'KNOWN', expiryAt: '2026-09-01' }, NOW).tone).toBe('expired');
    expect(presentExpiry({ expiryKind: 'KNOWN', expiryAt: '2026-09-12' }, NOW).tone).toBe('expiring');
  });

  it('treats a missing date as unknown even when a kind claims otherwise', () => {
    expect(presentExpiry({ expiryKind: 'KNOWN', expiryAt: null, estimatedExpiryAt: null }, NOW).tone).toBe('unknown');
    expect(presentExpiry({}, NOW).tone).toBe('unknown');
  });

  it('distinguishes an expired estimate from an expired fact', () => {
    const expiredEstimate = presentExpiry({ expiryKind: 'ESTIMATED', estimatedExpiryAt: '2026-09-01' }, NOW);
    expect(expiredEstimate.tone).toBe('expired');
    expect(expiredEstimate.estimated).toBe(true);
    expect(expiredEstimate.label).toContain('Ước tính');
  });
});

describe('T13 provenance and unknown facts', () => {
  it('AC9: receipt and fridge scan provenance are distinguishable', () => {
    expect(provenanceLabel('receipt')).toBe('Từ hóa đơn');
    expect(provenanceLabel('scan')).toBe('Từ ảnh tủ lạnh');
    expect(provenanceLabel('manual')).toBe('Nhập thủ công');
    expect(provenanceLabel('legacy')).toBe('Dữ liệu cũ');
    expect(provenanceLabel(null)).toBe('Không rõ nguồn');
  });

  it('AC4: a missing price never renders as 0đ', () => {
    expect(presentPrice(undefined)).toBe('Không có giá');
    expect(presentPrice(null)).toBe('Không có giá');
    expect(presentPrice(85000)).toBe('85.000đ');
    // A genuine zero is a supplied fact and still renders as money.
    expect(presentPrice(0)).toBe('0đ');
  });

  it('AC4: a missing purchase date never becomes today', () => {
    expect(presentPurchaseDate(null)).toBe('Không rõ ngày mua');
    expect(presentPurchaseDate('2026-09-10')).toBe('2026-09-10');
  });

  it('AC4: absent confidence is shown as unknown, not high', () => {
    expect(presentConfidence(undefined)).toEqual({ label: 'Độ tin cậy: chưa rõ', tone: 'unknown' });
    expect(presentConfidence(0.12).tone).toBe('low');
    expect(presentConfidence(0.65).tone).toBe('medium');
    expect(presentConfidence(0.95).tone).toBe('high');
  });
});

describe('T13 recoverable error presentation', () => {
  it('AC12: authority/conflict codes get specific user-readable text', () => {
    expect(presentDomainError('INVENTORY_AUTHORITY_REQUIRED').message).toContain('quản lý theo lô');
    expect(presentDomainError('UNIT_MISMATCH').message).toContain('đơn vị');
    expect(presentDomainError('INSUFFICIENT_INVENTORY').message).toContain('không đủ');
    expect(presentDomainError('IDEMPOTENCY_CONFLICT').message).toContain('thao tác khác');
  });

  it('AC12: stale/conflict states ask for a refetch of authoritative state', () => {
    expect(presentDomainError('CONFLICT').refetch).toBe(true);
    expect(presentDomainError('STALE_SNAPSHOT').refetch).toBe(true);
    expect(presentDomainError('ALREADY_DECIDED').refetch).toBe(true);
    expect(presentDomainError('INVENTORY_AUTHORITY_REQUIRED').refetch).toBe(false);
  });

  it('AC12: an unmapped code falls back to readable text, never raw JSON', () => {
    const fallback = presentDomainError('SOMETHING_NEW');
    expect(fallback.message).not.toContain('{');
    expect(fallback.message).toContain('Vui lòng thử lại');
    expect(presentDomainError(null).message).toContain('Vui lòng thử lại');
  });
});

describe('T13 reconciliation decision key bounds', () => {
  // fetchJson refuses to call a household route without a private session.
  beforeEach(() => {
    localStorage.setItem('frigo_user_id', 'user-1');
    localStorage.setItem('frigo_household_id', 'household-1');
  });
  afterEach(() => localStorage.clear());

  it('AC8: a real observation id still yields a decision key the server accepts', async () => {
    // Regression: a real observation id is ~210 characters, so composing the
    // key inline blew the server's 160-character bound and made every
    // reconciliation decision fail validation from the UI.
    const observationId = `t10-observation:${'h'.repeat(36)}:RECEIPT:${'s'.repeat(145)}`;
    expect(observationId.length).toBeGreaterThan(MAX_DECISION_KEY);
    let sent: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ success: true, decision: {} }),
        { status: 201, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      await inventoryTruthApi.decideInventoryObservation({
        observationId, expectedObservationVersion: 1, decisionType: 'DISMISS',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(sent.decisionKey.length).toBeLessThanOrEqual(MAX_DECISION_KEY);
    expect(sent.observationId).toBe(observationId);
  });

  it('AC8: the collapsed key stays deterministic and distinguishes decisions', async () => {
    const observationId = `t10-observation:${'h'.repeat(36)}:RECEIPT:${'s'.repeat(145)}`;
    const keys: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init: any) => {
      keys.push(JSON.parse(init.body).decisionKey);
      return new Response(JSON.stringify({ success: true, decision: {} }),
        { status: 201, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      await inventoryTruthApi.decideInventoryObservation({
        observationId, expectedObservationVersion: 1, decisionType: 'DISMISS' });
      await inventoryTruthApi.decideInventoryObservation({
        observationId, expectedObservationVersion: 1, decisionType: 'DISMISS' });
      await inventoryTruthApi.decideInventoryObservation({
        observationId, expectedObservationVersion: 2, decisionType: 'DISMISS' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Same decision replays under one key; a different version is a different
    // decision and must not collide with it.
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
