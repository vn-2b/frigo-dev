import { describe, expect, it } from 'vitest';
import {
  InventoryObservationInputSchema, InventoryObservationSchema, ObservationError,
  observationFingerprint, observationIdentity,
} from '../../packages/domain/src/inventory-observations';
import { planInventoryReconciliation, type ReconciliationSnapshot } from '../../packages/domain/src/inventory-reconciliation';
import { InventoryLotSchema, type InventoryLot } from '../../packages/domain/src/inventory-truth';
import { toLotQuantity } from '../../packages/domain/src/inventory-truth';

const now = '2026-09-11T10:00:00Z';
const lotFixture: InventoryLot = InventoryLotSchema.parse({
  id: 'lot-1', householdId: 'h-1', ingredientId: 'CHICKEN_EGG', rawName: 'Eggs',
  quantityMilli: 2_000_000, canonicalUnit: 'g', storageLocationId: 'loc-fridge',
  state: 'ACTIVE', purchasedAt: null, openedAt: null, expiryAt: '2026-09-20',
  estimatedExpiryAt: null, expiryKind: 'KNOWN', sourceType: 'MANUAL', sourceId: null,
  version: 3, createdAt: now, updatedAt: now, purchasePrice: null,
  legacyExpiryAt: null, legacyExpiryKind: null, legacyExpirySource: null,
  legacyOpenedAt: null, legacyVersion: null,
});

const snapshot: ReconciliationSnapshot = {
  inventoryVersion: 7,
  lots: [{ lot: lotFixture, legacyItemId: 'item-9' }],
  locations: [{
    id: 'loc-fridge', householdId: 'h-1', type: 'FRIDGE', name: 'Fridge', sortOrder: 0,
    isDefault: true, createdAt: now, updatedAt: now,
  }, {
    id: 'loc-freezer', householdId: 'h-1', type: 'FREEZER', name: 'Freezer', sortOrder: 1,
    isDefault: true, createdAt: now, updatedAt: now,
  }],
};

const observationInput = (patch: Record<string, unknown> = {}) => ({
  sourceType: 'MANUAL' as const,
  sourceRef: 'count-1',
  observedAt: now,
  ingredientId: 'CHICKEN_EGG',
  rawName: null,
  lotId: null,
  legacyItemId: null,
  evidence: 'OBSERVED' as const,
  note: null,
  claim: { quantity: 2, unit: 'kg', quantityMilli: 2_000_000, canonicalUnit: 'g',
    storage: null, expiryDate: null, expiryKind: null, openedAt: null },
  ...patch,
});

const observation = (patch: Record<string, unknown> = {}) => InventoryObservationSchema.parse(rawObservation(patch));

const rawObservation = (patch: Record<string, unknown> = {}) => ({
  observationId: 't10-observation:h-1:MANUAL:count-1',
  householdId: 'h-1',
  sourceType: 'MANUAL',
  sourceRef: 'count-1',
  fingerprint: '{"claim":{}}',
  observedAt: now,
  recordedAt: now,
  ingredientId: 'CHICKEN_EGG',
  rawName: null,
  lotId: null,
  legacyItemId: null,
  evidence: 'OBSERVED',
  note: null,
  authoritativeInventoryVersion: 7,
  status: 'OPEN',
  version: 1,
  createdAt: now,
  updatedAt: now,
  claim: { quantity: 2, unit: 'kg', quantityMilli: 2_000_000, canonicalUnit: 'g',
    storage: null, expiryDate: null, expiryKind: null, openedAt: null },
  ...patch,
});

describe('observation schema', () => {
  it('accepts a complete observation input with a quantity claim', () => {
    const parsed = InventoryObservationInputSchema.parse(observationInput());
    expect(parsed.claim.quantity).toBe(2);
    expect(parsed.claim.unit).toBe('kg');
  });

  it('requires at least one claim', () => {
    const result = InventoryObservationInputSchema.safeParse(observationInput({
      claim: { quantity: null, unit: null, quantityMilli: null, canonicalUnit: null,
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }));
    expect(result.success).toBe(false);
  });

  it('requires some subject identity and forbids name-only-only subjects', () => {
    const anonymous = InventoryObservationInputSchema.safeParse(observationInput({
      ingredientId: null, rawName: null, lotId: null, legacyItemId: null,
    }));
    expect(anonymous.success).toBe(false);
    const rawNamed = InventoryObservationInputSchema.safeParse(observationInput({ ingredientId: null, rawName: 'Some jar' }));
    expect(rawNamed.success).toBe(true);
  });

  it('keeps quantity and unit, expiry date and kind paired', () => {
    expect(InventoryObservationInputSchema.safeParse(observationInput({
      claim: { quantity: 2, unit: null, quantityMilli: 2_000_000, canonicalUnit: 'g',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    })).success).toBe(false);
    expect(InventoryObservationInputSchema.safeParse(observationInput({
      claim: { quantity: null, unit: null, quantityMilli: null, canonicalUnit: null,
        storage: null, expiryDate: '2026-09-20', expiryKind: null, openedAt: null },
    })).success).toBe(false);
  });

  it('enforces categorical evidence semantics: UNKNOWN and ESTIMATED cannot claim quantity', () => {
    expect(InventoryObservationSchema.safeParse(rawObservation({ evidence: 'UNKNOWN' })).success).toBe(false);
    expect(InventoryObservationSchema.safeParse(rawObservation({ evidence: 'CONFIRMED' })).success).toBe(true);
  });

  it('couples estimated expiry evidence with estimated expiry kind only', () => {
    const estimated = InventoryObservationSchema.safeParse(rawObservation({
      evidence: 'ESTIMATED',
      claim: { quantity: null, unit: null, quantityMilli: null, canonicalUnit: null,
        storage: null, expiryDate: '2026-09-25', expiryKind: 'ESTIMATED', openedAt: null },
    }));
    expect(estimated.success).toBe(true);
    const mismatched = InventoryObservationSchema.safeParse(rawObservation({
      evidence: 'OBSERVED',
      claim: { quantity: null, unit: null, quantityMilli: null, canonicalUnit: null,
        storage: null, expiryDate: '2026-09-25', expiryKind: 'ESTIMATED', openedAt: null },
    }));
    expect(mismatched.success).toBe(false);
  });

  it('bounds source refs, notes and rejects NUL bytes', () => {
    expect(InventoryObservationInputSchema.safeParse(observationInput({ sourceRef: 'x'.repeat(201) })).success).toBe(false);
    expect(InventoryObservationInputSchema.safeParse(observationInput({ note: 'bad\0note' })).success).toBe(false);
    expect(InventoryObservationInputSchema.safeParse(observationInput({ note: 'x'.repeat(1001) })).success).toBe(false);
  });
});

describe('fingerprint and identity', () => {
  it('is deterministic for identical external evidence regardless of recording time', () => {
    const a = observationFingerprint(observationInput() as never);
    const b = observationFingerprint(observationInput() as never);
    expect(a).toBe(b);
    expect(observationIdentity('h-1', 'MANUAL', 'count-1')).toBe(observationIdentity('h-1', 'MANUAL', 'count-1'));
  });

  it('changes when the semantic claim changes but not when identity key fields repeat', () => {
    const changed = observationFingerprint(observationInput({
      claim: { quantity: 1.5, unit: 'kg', quantityMilli: 1_500_000, canonicalUnit: 'g',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }) as never);
    expect(changed).not.toBe(observationFingerprint(observationInput() as never));
    expect(observationIdentity('h-1', 'SCAN', 's-1')).not.toBe(observationIdentity('h-1', 'SCAN', 's-2'));
  });

  it('never derives identity from a timestamp', () => {
    expect(observationInput().observedAt).toBe(now);
    const earlier = observationInput({ observedAt: '2026-09-10T08:00:00Z' });
    expect(observationFingerprint(earlier as never)).toBe(observationFingerprint(observationInput() as never));
  });
});

describe('exact quantity comparison', () => {
  it('treats 2 kg, 2000 g and 2,000,000 milli as the same exact quantity', () => {
    expect(toLotQuantity(2, 'kg')).toEqual({ quantityMilli: 2_000_000, canonicalUnit: 'g' });
    expect(toLotQuantity(2000, 'g')).toEqual({ quantityMilli: 2_000_000, canonicalUnit: 'g' });
  });

  it('classifies an equal quantity as MATCH', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation()]);
    expect(finding.verdict).toBe('MATCH');
    expect(finding.matchedLotId).toBe('lot-1');
    expect(finding.proposals).toEqual([]);
  });

  it('proposes a correction for 1.5 kg against a 2 kg lot without rounding', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation({
      claim: { quantity: 1.5, unit: 'kg', quantityMilli: 1_500_000, canonicalUnit: 'g',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    })]);
    expect(finding.verdict).toBe('PROPOSE_CORRECTION');
    expect(finding.proposals).toEqual([{
      type: 'CORRECT', lotId: 'lot-1', expectedVersion: 3,
      changes: { quantity: 1.5, unit: 'kg' },
    }]);
  });

  it('treats an estimated quantity as conflict evidence, never as an automatic fix', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation({
      evidence: 'OBSERVED',
      claim: { quantity: 1.5, unit: 'kg', quantityMilli: 1_500_000, canonicalUnit: 'g',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    })]);
    expect(finding.verdict).toBe('PROPOSE_CORRECTION');
  });
});

describe('unit compatibility', () => {
  it('supports same-unit contextual comparison (pack vs pack) without mass conversion', () => {
    const packLot = { ...lotFixture, canonicalUnit: 'pack' as const, quantityMilli: 2000, ingredientId: 'CHICKEN_EGG' };
    const [finding] = planInventoryReconciliation({
      ...snapshot, lots: [{ lot: InventoryLotSchema.parse(packLot), legacyItemId: null }],
    }, [observation({
      claim: { quantity: 2, unit: 'pack', quantityMilli: 2000, canonicalUnit: 'pack',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    })]);
    expect(finding.verdict).toBe('MATCH');
  });

  it('never converts contextual units into mass/volume (2 packs vs grams is UNSUPPORTED)', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation({
      claim: { quantity: 2, unit: 'pack', quantityMilli: 2000, canonicalUnit: 'pack',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    })]);
    expect(finding.verdict).toBe('UNSUPPORTED');
    expect(finding.reasons).toContain('INCOMPATIBLE_UNIT');
  });
});

describe('lot candidate matching', () => {
  it('prefers an explicit native lot id', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation({
      lotId: 'lot-1', ingredientId: null,
    })]);
    expect(finding.matchedLotId).toBe('lot-1');
    expect(finding.verdict).toBe('MATCH');
  });

  it('resolves an explicit retained legacy mapping', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation({
      legacyItemId: 'item-9', ingredientId: null,
    })]);
    expect(finding.matchedLotId).toBe('lot-1');
  });

  it('classifies a missing referenced lot as STALE, not as a guess', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation({ lotId: 'missing-lot', ingredientId: null })]);
    expect(finding.verdict).toBe('STALE_OBSERVATION');
  });

  it('classifies two compatible candidates as AMBIGUOUS', () => {
    const second = { ...lotFixture, id: 'lot-2' };
    const [finding] = planInventoryReconciliation({
      ...snapshot, lots: [snapshot.lots[0], { lot: InventoryLotSchema.parse(second), legacyItemId: null }],
    }, [observation()]);
    expect(finding.verdict).toBe('AMBIGUOUS');
    expect(finding.proposals).toEqual([]);
  });

  it('refuses name-only matching: raw name without identity is UNSUPPORTED', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation({
      ingredientId: null, rawName: 'Eggs', lotId: null, legacyItemId: null,
    })]);
    expect(finding.verdict).toBe('UNSUPPORTED');
    expect(finding.reasons).toContain('IDENTITY_UNKNOWN');
  });

  it('classifies a known ingredient with no stock as UNSUPPORTED (no fabricated creation)', () => {
    const [finding] = planInventoryReconciliation({ ...snapshot, lots: [] }, [observation()]);
    expect(finding.verdict).toBe('UNSUPPORTED');
    expect(finding.reasons).toContain('NO_MATCHING_LOT');
  });
});

describe('expiry precedence', () => {
  const expiryClaim = (expiryDate: string, expiryKind: 'KNOWN' | 'ESTIMATED') => ({
    claim: { quantity: null, unit: null, quantityMilli: null, canonicalUnit: null,
      storage: null, expiryDate, expiryKind, openedAt: null },
  });

  it('keeps an observed expiry matching the confirmed lot as MATCH', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation(expiryClaim('2026-09-20', 'KNOWN'))]);
    expect(finding.verdict).toBe('MATCH');
  });

  it('proposes an expiry update for a differing observed expiry', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation(expiryClaim('2026-09-22', 'KNOWN'))]);
    expect(finding.verdict).toBe('PROPOSE_EXPIRY_UPDATE');
    expect(finding.proposals[0]).toMatchObject({ type: 'CORRECT', lotId: 'lot-1', expectedVersion: 3,
      changes: { expiryAt: '2026-09-22', expiryKind: 'KNOWN' } });
  });

  it('never lets an estimated expiry overwrite a confirmed expiry: conflict, authority retained', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation({
      evidence: 'ESTIMATED', ...expiryClaim('2026-09-25', 'ESTIMATED'),
    })]);
    expect(finding.verdict).toBe('CONFLICT');
    expect(finding.reasons).toContain('ESTIMATED_EXPIRY_VS_CONFIRMED');
    expect(finding.proposals).toEqual([]);
  });

  it('upgrades estimate evidence to confirmed when the observed date matches the estimate', () => {
    const estimatedLot = { ...lotFixture, expiryAt: null, estimatedExpiryAt: '2026-09-25', expiryKind: 'ESTIMATED' as const };
    const [finding] = planInventoryReconciliation({
      ...snapshot, lots: [{ lot: InventoryLotSchema.parse(estimatedLot), legacyItemId: null }],
    }, [observation(expiryClaim('2026-09-25', 'KNOWN'))]);
    expect(finding.verdict).toBe('PROPOSE_EXPIRY_UPDATE');
    expect(finding.proposals[0]).toMatchObject({ changes: { expiryAt: '2026-09-25', expiryKind: 'KNOWN' } });
  });

  it('records that conflicting expiry evidence is classified, not silently applied', () => {
    const confirmedLot = { ...lotFixture, expiryAt: '2026-09-20', expiryKind: 'USE_BY' as const };
    const [finding] = planInventoryReconciliation({
      ...snapshot, lots: [{ lot: InventoryLotSchema.parse(confirmedLot), legacyItemId: null }],
    }, [observation({
      evidence: 'ESTIMATED',
      claim: { quantity: null, unit: null, quantityMilli: null, canonicalUnit: null,
        storage: null, expiryDate: '2026-09-22', expiryKind: 'ESTIMATED', openedAt: null },
    })]);
    expect(finding.verdict).toBe('CONFLICT');
    expect(finding.reasons).toContain('ESTIMATED_EXPIRY_VS_CONFIRMED');
  });
});

describe('storage and staleness', () => {
  it('proposes a MOVE when observed storage differs from the authoritative location', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation({
      claim: { quantity: null, unit: null, quantityMilli: null, canonicalUnit: null,
        storage: 'freezer', expiryDate: null, expiryKind: null, openedAt: null },
    })]);
    expect(finding.verdict).toBe('PROPOSE_MOVE');
    expect(finding.proposals).toEqual([{
      type: 'MOVE', lotId: 'lot-1', expectedVersion: 3, storageLocationId: 'loc-freezer',
    }]);
  });

  it('classifies version drift between record time and reconcile time as STALE', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation({ authoritativeInventoryVersion: 6 })]);
    expect(finding.verdict).toBe('STALE_OBSERVATION');
    expect(finding.reasons).toContain('INVENTORY_VERSION_DRIFT');
  });

  it('classifies a terminal referenced lot as STALE', () => {
    const consumed = { ...lotFixture, state: 'CONSUMED' as const, quantityMilli: 0 };
    const [finding] = planInventoryReconciliation({
      ...snapshot, lots: [{ lot: InventoryLotSchema.parse(consumed), legacyItemId: null }],
    }, [observation({ lotId: 'lot-1', ingredientId: null })]);
    expect(finding.verdict).toBe('STALE_OBSERVATION');
    expect(finding.reasons).toContain('REFERENCED_LOT_TERMINAL');
  });

  it('skips non-open observations with NO_ACTION', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation({ status: 'RECONCILED' })]);
    expect(finding.verdict).toBe('NO_ACTION');
  });

  it('bounds the reconciliation batch', () => {
    const observations = Array.from({ length: 33 }, (_, index) =>
      observation({ sourceRef: `count-${index}` }));
    expect(() => planInventoryReconciliation(snapshot, observations)).toThrow(ObservationError);
  });

  it('composes a mixed quantity and storage claim into atomic same-version proposals', () => {
    const [finding] = planInventoryReconciliation(snapshot, [observation({
      claim: { quantity: 1.5, unit: 'kg', quantityMilli: 1_500_000, canonicalUnit: 'g',
        storage: 'freezer', expiryDate: null, expiryKind: null, openedAt: null },
    })]);
    expect(finding.verdict).toBe('PROPOSE_CORRECTION');
    expect(finding.proposals).toHaveLength(2);
    expect(finding.proposals[0]).toMatchObject({ type: 'CORRECT', expectedVersion: 3 });
    expect(finding.proposals[1]).toMatchObject({ type: 'MOVE', expectedVersion: 3 });
  });
});
