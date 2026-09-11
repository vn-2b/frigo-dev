import { describe, expect, it } from 'vitest';
import {
  MAX_FEFO_EFFECTS,
  MAX_FEFO_RECEIPT_BYTES,
  MAX_FEFO_SNAPSHOT_LOTS,
  compareFefoLots,
  parseInventoryFefoCommand,
  planInventoryFefo,
} from '../../packages/domain/src/inventory-fefo';
import { LotCommandError, type LotCommandContext } from '../../packages/domain/src/inventory-lot-commands';
import { defaultStorageLocations, type InventoryLot } from '../../packages/domain/src/inventory-truth';

const householdId = 'household-a';
const timestamp = '2026-09-11T09:00:00Z';
const context: LotCommandContext = {
  householdId,
  now: '2026-09-11T17:00:00Z',
  locations: defaultStorageLocations(householdId, timestamp, timestamp),
  ingredientIds: ['RICE', 'CHICKEN_EGG'],
};

function lot(patch: Partial<InventoryLot> = {}): InventoryLot {
  return {
    id: 'lot-a', householdId, ingredientId: 'RICE', rawName: 'Rice', quantityMilli: 1000,
    canonicalUnit: 'g', storageLocationId: context.locations[0].id, state: 'ACTIVE',
    purchasedAt: null, openedAt: null, expiryAt: null, estimatedExpiryAt: null,
    expiryKind: 'UNKNOWN', sourceType: 'MANUAL', sourceId: null, version: 1,
    createdAt: timestamp, updatedAt: timestamp, purchasePrice: null,
    legacyExpiryAt: null, legacyExpiryKind: null, legacyExpirySource: null,
    legacyOpenedAt: null, legacyVersion: null, ...patch,
  };
}

function use(quantity: number, unit = 'g') {
  return parseInventoryFefoCommand({ type: 'USE', mode: 'FEFO', ingredientId: 'RICE', quantity, unit });
}

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrow(LotCommandError);
  expect(action).toThrow(expect.objectContaining({ code }));
}

describe('T09E FEFO command parsing', () => {
  it('normalizes only universal units with exact milli-quantities', () => {
    expect(parseInventoryFefoCommand({
      type: 'USE', mode: 'FEFO', ingredientId: 'RICE', quantity: 0.25, unit: 'kg',
      reason: 'Cooked dinner', expectedInventoryVersion: 7,
    })).toEqual({
      type: 'USE', mode: 'FEFO', ingredientId: 'RICE', quantityMilli: 250_000,
      canonicalUnit: 'g', reason: 'Cooked dinner', expectedInventoryVersion: 7,
    });
    expect(use(1.25, 'l')).toMatchObject({ quantityMilli: 1_250_000, canonicalUnit: 'ml' });
    expect(use(2, 'piece')).toMatchObject({ quantityMilli: 2000, canonicalUnit: 'piece' });
  });

  it.each(['pack', 'bunch', 'slice'])('rejects contextual %s quantities without product context', (unit) => {
    expectCode(() => use(1, unit), 'UNSUPPORTED_FEFO_UNIT');
  });

  it.each([
    { type: 'USE', mode: 'FEFO', ingredientId: 'RICE', quantity: 1, unit: 'g', extra: true },
    { type: 'USE', mode: 'FEFO', ingredientId: 'RICE', quantity: 0, unit: 'g' },
    { type: 'USE', mode: 'FEFO', ingredientId: 'rice', quantity: 1, unit: 'g' },
    { type: 'USE', mode: 'FEFO', ingredientId: `R${'I'.repeat(200)}`, quantity: 1, unit: 'g' },
    { type: 'USE', mode: 'FEFO', ingredientId: 'RICE', quantity: 1, unit: 'g', reason: 'bad\0reason' },
  ])('rejects malformed external commands', (input) => {
    expectCode(() => parseInventoryFefoCommand(input), 'INVALID_COMMAND');
  });

  it.each([0.0001, 0.1 + 0.2, Number.MAX_SAFE_INTEGER])('rejects lossy quantity %s without rounding', (quantity) => {
    expectCode(() => use(quantity), 'UNREPRESENTABLE_QUANTITY');
  });

  it('publishes bounded FEFO constants', () => {
    expect({ MAX_FEFO_EFFECTS, MAX_FEFO_SNAPSHOT_LOTS, MAX_FEFO_RECEIPT_BYTES }).toEqual({
      MAX_FEFO_EFFECTS: 32, MAX_FEFO_SNAPSHOT_LOTS: 1000, MAX_FEFO_RECEIPT_BYTES: 262_144,
    });
  });
});

describe('T09E deterministic FEFO ordering', () => {
  it('orders known expiry, estimated expiry, unknown expiry, purchase, creation and binary ID ties', () => {
    const ordered = [
      lot({ id: 'z-known', expiryAt: '2026-09-12', expiryKind: 'KNOWN' }),
      lot({ id: 'a-estimated', estimatedExpiryAt: '2026-09-12', expiryKind: 'ESTIMATED' }),
      lot({ id: 'purchase-earlier', purchasedAt: '2026-09-01' }),
      lot({ id: 'created-earlier', createdAt: '2026-09-01T00:00:00Z' }),
      lot({ id: 'a-id' }),
      lot({ id: 'z-id' }),
    ];
    expect([...ordered].sort(compareFefoLots).map(({ id }) => id)).toEqual([
      'z-known', 'a-estimated', 'purchase-earlier', 'created-earlier', 'a-id', 'z-id',
    ]);
  });

  it('compares creation instants chronologically rather than lexically', () => {
    const later = lot({ id: 'later', createdAt: '2026-09-11T09:00:00+07:00' });
    const earlier = lot({ id: 'earlier', createdAt: '2026-09-11T01:30:00Z' });
    expect(compareFefoLots(earlier, later)).toBeLessThan(0);
  });
});

describe('T09E pure multi-lot FEFO planning', () => {
  it('plans exact, partial, two-lot and three-lot decrements in FEFO order', () => {
    const lots = [
      lot({ id: 'late', quantityMilli: 1000, expiryAt: '2026-10-01', expiryKind: 'KNOWN' }),
      lot({ id: 'early', quantityMilli: 1000, expiryAt: '2026-09-12', expiryKind: 'KNOWN' }),
      lot({ id: 'middle', quantityMilli: 1000, expiryAt: '2026-09-20', expiryKind: 'KNOWN' }),
    ];
    expect(planInventoryFefo(use(1), lots, context).map((plan) => [plan.before?.id, plan.after.quantityMilli, plan.after.state]))
      .toEqual([['early', 0, 'CONSUMED']]);
    expect(planInventoryFefo(use(1.5), lots, context).map((plan) => [plan.before?.id, plan.after.quantityMilli]))
      .toEqual([['early', 0], ['middle', 500]]);
    expect(planInventoryFefo(use(2.5), lots, context).map((plan) => [plan.before?.id, plan.after.quantityMilli]))
      .toEqual([['early', 0], ['middle', 0], ['late', 500]]);
  });

  it('ignores foreign, mismatched, terminal and zero lots', () => {
    const plans = planInventoryFefo(use(1), [
      lot({ id: 'foreign', householdId: 'household-b', quantityMilli: 5000 }),
      lot({ id: 'ingredient', ingredientId: 'CHICKEN_EGG', quantityMilli: 5000 }),
      lot({ id: 'terminal', state: 'CONSUMED', quantityMilli: 0 }),
      lot({ id: 'zero', quantityMilli: 0 }),
      lot({ id: 'eligible', quantityMilli: 1000 }),
    ], context);
    expect(plans.map((plan) => plan.before?.id)).toEqual(['eligible']);
  });

  it('rejects duplicate IDs and insufficient inventory before producing any plans or mutating input', () => {
    const lots = [lot({ id: 'duplicate', quantityMilli: 1000 }), lot({ id: 'duplicate', quantityMilli: 1000 })];
    const duplicateSnapshot = structuredClone(lots);
    expectCode(() => planInventoryFefo(use(1), lots, context), 'DUPLICATE_LOT_ID');
    expect(lots).toEqual(duplicateSnapshot);

    const insufficient = [lot({ id: 'only', quantityMilli: 1000 })];
    const snapshot = structuredClone(insufficient);
    expectCode(() => planInventoryFefo(use(2), insufficient, context), 'INSUFFICIENT_INVENTORY');
    expect(insufficient).toEqual(snapshot);
  });

  it('enforces snapshot and effect limits', () => {
    const snapshot = Array.from({ length: MAX_FEFO_SNAPSHOT_LOTS + 1 }, (_, index) => lot({ id: `lot-${index}` }));
    expectCode(() => planInventoryFefo(use(1), snapshot, context), 'FEFO_LIMIT_EXCEEDED');

    const lots = Array.from({ length: MAX_FEFO_EFFECTS + 1 }, (_, index) => lot({ id: `lot-${index}`, quantityMilli: 1 }));
    expect(planInventoryFefo(use(0.032), lots.slice(0, MAX_FEFO_EFFECTS), context)).toHaveLength(MAX_FEFO_EFFECTS);
    expectCode(() => planInventoryFefo(use(0.033), lots, context), 'FEFO_LIMIT_EXCEEDED');
  });

  it('uses BigInt accumulation so safe individual lots do not overflow the snapshot total', () => {
    const lots = [
      lot({ id: 'one', quantityMilli: 4_000_000_000_000_000 }),
      lot({ id: 'two', quantityMilli: 4_000_000_000_000_000 }),
      lot({ id: 'three', quantityMilli: 4_000_000_000_000_000 }),
    ];
    const command = use(8_000_000_000_000, 'piece');
    expect(planInventoryFefo(command, lots.map((entry) => ({ ...entry, canonicalUnit: 'piece' })), context)
      .map((plan) => plan.after.quantityMilli)).toEqual([0, 0]);
  });
});
