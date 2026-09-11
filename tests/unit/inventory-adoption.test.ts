import { describe, expect, it } from 'vitest';
import {
  MAX_INVENTORY_ADOPTION_EFFECTS, MAX_INVENTORY_ADOPTION_SNAPSHOT_ROWS,
  planInventoryAdoption, type InventoryAdoptionIntent, type InventoryAdoptionProjection,
  type InventoryAdoptionSnapshot,
} from '../../packages/domain/src/inventory-adoption';
import { defaultStorageLocations, legacyInventoryToLot, type InventoryLot } from '../../packages/domain/src/inventory-truth';

const householdId = 'household-adoption';
const createdAt = '2026-09-01 10:00:00';
const updatedAt = '2026-09-09 11:00:00';
const now = '2026-09-11T12:00:00Z';
const row = (patch: Partial<InventoryAdoptionProjection> = {}): InventoryAdoptionProjection => ({
  id: 'legacy-a', household_id: householdId, ingredient_id: 'CHICKEN_EGG', name: 'Egg',
  quantity: 10, unit: 'piece', storage: 'fridge', expiry_date: null, opened_at: null,
  expiry_kind: 'unknown', expiry_source: 'unknown', version: 7,
  category: 'custom', data_source: 'scan', freshness: 'use_soon', added_date: '2026-09-01',
  created_at: createdAt, updated_at: updatedAt, ...patch,
});
function snapshot(rows = [row()], existing = true): InventoryAdoptionSnapshot {
  return {
    complete: true, householdId, inventoryVersion: 12,
    householdCreatedAt: createdAt, householdUpdatedAt: updatedAt, activationCommandId: null,
    legacyRows: rows,
    lots: existing ? rows.map((source) => ({ lot: legacyInventoryToLot(source), legacyItemId: null })) : [],
    locations: defaultStorageLocations(householdId, createdAt, updatedAt), ingredientIds: ['CHICKEN_EGG'],
  };
}
const intent = (patch: Partial<InventoryAdoptionIntent> = {}): InventoryAdoptionIntent => ({
  expectedInventoryVersion: 12, now, terminalEvidence: [], ...patch,
});
function expectCode(action: () => unknown, code: string) {
  expect(action).toThrow(expect.objectContaining({ code }));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function objectReferences(value: unknown): object[] {
  if (value === null || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(objectReferences)];
}

describe('T09F pure whole-household adoption preparation', () => {
  it('preserves backfill provenance, raw projection metadata and independent versions', () => {
    const source = snapshot();
    const plan = planInventoryAdoption(source, intent());
    expect(plan.effects).toHaveLength(1);
    expect(plan.effects[0]).toEqual({
      ordinal: 0, lotId: 't08-legacy:legacy-a', legacyItemId: 'legacy-a', snapshotMissing: false,
      before: source.lots[0].lot,
      after: { ...source.lots[0].lot, version: 2, updatedAt: now },
      projectionBefore: source.legacyRows[0], projectionAfter: source.legacyRows[0],
      deltaMilli: 0, terminalEvidence: null,
    });
    expect(plan.effects[0].after).toMatchObject({ sourceType: 'LEGACY_BACKFILL', sourceId: 'legacy-a', legacyVersion: 7 });
    expect(plan.missingSnapshots).toEqual([]);
    expect(plan.missingLocations).toEqual([]);
    expect(plan.activation).toEqual({ kind: 'ACTIVATE_HOUSEHOLD', emptyHousehold: false });
  });

  it.each([
    ['kg', 0.000001, 'g', 1], ['kg', 0.2, 'g', 200000], ['l', 1.25, 'ml', 1250000],
    ['pack', 0.1, 'pack', 100], ['bunch', 1, 'bunch', 1000], ['slice', 0.5, 'slice', 500],
  ] as const)('retains %s display quantity without pooling or normalization', (unit, quantity, canonicalUnit, quantityMilli) => {
    const plan = planInventoryAdoption(snapshot([row({ unit, quantity })]), intent());
    expect(plan.effects[0].after).toMatchObject({ canonicalUnit, quantityMilli });
    expect(plan.effects[0].projectionAfter).toMatchObject({ unit, quantity });
  });

  it('does not promote unknown raw expiry/opening evidence into purchase facts', () => {
    const raw = row({ expiry_date: '2026-02-30', opened_at: 'yesterday', expiry_kind: 'use_by', expiry_source: 'unknown' });
    const { after, projectionAfter } = planInventoryAdoption(snapshot([raw]), intent()).effects[0];
    expect(after).toMatchObject({ expiryAt: null, expiryKind: 'UNKNOWN', openedAt: null, purchasedAt: null,
      purchasePrice: null, legacyExpiryAt: raw.expiry_date, legacyOpenedAt: raw.opened_at,
      legacyExpiryKind: 'use_by', legacyExpirySource: 'unknown' });
    expect(projectionAfter).toEqual(raw);
  });

  it('advances only the lot version even when the legacy version is already maximal', () => {
    const source = snapshot([row({ version: Number.MAX_SAFE_INTEGER })]);
    const effect = planInventoryAdoption(source, intent()).effects[0];
    expect(effect.before.version).toBe(1);
    expect(effect.after.version).toBe(2);
    expect(effect.after.legacyVersion).toBe(Number.MAX_SAFE_INTEGER);
    expect(effect.projectionAfter).toEqual(effect.projectionBefore);
  });

  it('plans all missing snapshots before mappings and preserves an existing custom default', () => {
    const source = snapshot([row({ id: 'b' }), row({ id: 'a' })]);
    source.lots = [source.lots[0]];
    source.locations[0].id = 'custom-fridge';
    source.lots[0].lot.storageLocationId = 'custom-fridge';
    source.locations = [source.locations[0]];
    const plan = planInventoryAdoption(source, intent());
    expect(plan.missingLocations.map(({ type }) => type)).toEqual(['FREEZER', 'PANTRY']);
    expect(plan.missingSnapshots).toHaveLength(1);
    expect(plan.missingSnapshots[0]).toMatchObject({ id: 't08-legacy:a', version: 1, storageLocationId: 'custom-fridge' });
    expect(plan.effects.map(({ legacyItemId, ordinal, snapshotMissing }) => [legacyItemId, ordinal, snapshotMissing]))
      .toEqual([['a', 0, true], ['b', 1, false]]);
  });

  it('returns an explicit empty-household activation intent without a fictitious stock event', () => {
    const source = snapshot([]);
    source.locations = [];
    const plan = planInventoryAdoption(source, intent());
    expect(plan.effects).toEqual([]);
    expect(plan.missingSnapshots).toEqual([]);
    expect(plan.missingLocations).toHaveLength(3);
    expect(plan.activation).toEqual({ kind: 'ACTIVATE_HOUSEHOLD', emptyHousehold: true });
    expect(source.activationCommandId).toBeNull();
  });

  it('is deterministic and neither mutates nor retains references to caller-owned inputs', () => {
    const source = snapshot([row({ id: 'b' }), row({ id: 'a' })], false);
    const request = intent();
    const before = structuredClone({ source, request });
    const result = planInventoryAdoption(source, request);
    expect({ source, request }).toEqual(before);
    expect(result).toEqual(planInventoryAdoption({ ...source, legacyRows: [...source.legacyRows].reverse() }, request));
    result.effects[0].before.rawName = 'changed';
    result.effects[0].projectionAfter.name = 'changed';
    result.missingSnapshots[0].rawName = 'changed';
    expect({ source, request }).toEqual(before);
    expect(result.effects[0].after.rawName).toBe('Egg');
    expect(result.effects[0].projectionBefore.name).toBe('Egg');
  });

  it('is independent of every snapshot and terminal-evidence array order', () => {
    const source = snapshot([row({ id: 'c' }), row({ id: 'b', quantity: 0 }), row({ id: 'a', quantity: 0 })]);
    source.lots = source.lots.slice(1);
    source.locations = source.locations.filter(({ type }) => type !== 'PANTRY');
    source.ingredientIds.push('PORK');
    const request = intent({ terminalEvidence: [
      { legacyItemId: 'b', state: 'DISCARDED', reason: 'Reviewed discard' },
      { legacyItemId: 'a', state: 'CONSUMED', reason: 'Reviewed consumption' },
    ] });
    const baseline = planInventoryAdoption(source, request);
    expect(planInventoryAdoption({
      ...source,
      legacyRows: [...source.legacyRows].reverse(),
      lots: [...source.lots].reverse(),
      locations: [...source.locations].reverse(),
      ingredientIds: [...source.ingredientIds].reverse(),
    }, { ...request, terminalEvidence: [...request.terminalEvidence].reverse() })).toEqual(baseline);
    expect(baseline.effects.map(({ legacyItemId }) => legacyItemId)).toEqual(['a', 'b', 'c']);
  });

  it('accepts deeply frozen inputs and returns fully detached, nonaliased result objects', () => {
    const source = snapshot([row({ id: 'a', quantity: 0 }), row({ id: 'b' })]);
    source.lots = source.lots.slice(0, 1);
    source.locations = source.locations.filter(({ type }) => type !== 'PANTRY');
    const request = intent({ terminalEvidence: [
      { legacyItemId: 'a', state: 'DISCARDED', reason: 'Reviewed' },
    ] });
    const before = structuredClone({ source, request });
    deepFreeze(source);
    deepFreeze(request);
    const result = planInventoryAdoption(source, request);
    const outputReferences = objectReferences(result);
    const inputReferences = new Set(objectReferences({ source, request }));
    expect(outputReferences.every((reference) => !inputReferences.has(reference))).toBe(true);
    expect(new Set(outputReferences).size).toBe(outputReferences.length);
    expect({ source, request }).toEqual(before);
    const freshResult = planInventoryAdoption(source, request);
    expect(objectReferences(freshResult).every((reference) => !outputReferences.includes(reference))).toBe(true);
    result.effects[0].terminalEvidence!.reason = 'changed';
    result.effects[0].projectionBefore.name = 'changed';
    result.missingSnapshots[0].rawName = 'changed';
    result.missingLocations[0].name = 'changed';
    expect({ source, request }).toEqual(before);
    expect(planInventoryAdoption(source, request)).toEqual(freshResult);
  });
});

describe('T09F adoption failure boundaries', () => {
  it.each([true, false])('requires explicit zero-stock terminal evidence (existing snapshot: %s)', (existing) => {
    expectCode(() => planInventoryAdoption(snapshot([row({ quantity: 0 })], existing), intent()), 'TERMINAL_EVIDENCE_REQUIRED');
  });

  it.each(['CONSUMED', 'DISCARDED'] as const)('records an explicit %s transition without changing legacy stock', (state) => {
    const source = snapshot([row({ quantity: 0 })]);
    const evidence = { legacyItemId: 'legacy-a', state, reason: 'Reviewed historical disposition' };
    const effect = planInventoryAdoption(source, intent({ terminalEvidence: [evidence] })).effects[0];
    expect(effect.before.state).toBe('ACTIVE');
    expect(effect.after).toMatchObject({ state, quantityMilli: 0, version: 2, legacyVersion: 7 });
    expect(effect.projectionAfter).toEqual(source.legacyRows[0]);
    expect(effect.terminalEvidence).toEqual(evidence);
  });

  it.each(['foreign', 'positive', 'duplicate'])('rejects %s terminal evidence', (kind) => {
    const source = snapshot([row({ quantity: kind === 'positive' ? 1 : 0 })]);
    const evidence = { legacyItemId: kind === 'foreign' ? 'other' : 'legacy-a', state: 'CONSUMED' as const, reason: 'Reviewed' };
    expectCode(() => planInventoryAdoption(source, intent({ terminalEvidence: kind === 'duplicate' ? [evidence, evidence] : [evidence] })),
      'INVALID_TERMINAL_EVIDENCE');
  });

  it.each(['', '   ', '\0', 'x'.repeat(1001)])('rejects invalid terminal reason %j', (reason) => {
    expectCode(() => planInventoryAdoption(snapshot([row({ quantity: 0 })]), intent({
      terminalEvidence: [{ legacyItemId: 'legacy-a', state: 'CONSUMED', reason }],
    })), 'INVALID_COMMAND');
  });

  it.each([
    { quantityMilli: 9999 }, { rawName: 'changed' }, { sourceId: 'orphan' }, { id: 'renamed' },
    { legacyVersion: 6 }, { version: 2 }, { createdAt: 'changed' }, { updatedAt: 'changed' },
    { legacyExpiryAt: '2026-09-20' }, { legacyExpiryKind: 'use_by' }, { legacyExpirySource: 'ocr' },
    { legacyOpenedAt: 'changed' }, { purchasedAt: '2026-09-01' },
    { purchasePrice: { currency: 'VND', amountMinor: 100, minorDigits: 0 } },
    { storageLocationId: 'missing' }, { sourceType: 'MANUAL' },
  ] satisfies Partial<InventoryLot>[])('rejects existing snapshot drift without refresh: %j', (patch) => {
    const source = snapshot();
    Object.assign(source.lots[0].lot, patch);
    const before = structuredClone(source);
    expectCode(() => planInventoryAdoption(source, intent()), 'DRIFT_DETECTED');
    expect(source).toEqual(before);
  });

  it.each(['rows', 'lots', 'locations'] as const)('rejects duplicate %s', (collection) => {
    const source = snapshot();
    if (collection === 'rows') source.legacyRows.push(source.legacyRows[0]);
    if (collection === 'lots') source.lots.push(source.lots[0]);
    if (collection === 'locations') source.locations.push(source.locations[0]);
    expectCode(() => planInventoryAdoption(source, intent()), 'DRIFT_DETECTED');
  });

  it('rejects a synthesized default ID collision instead of replacing a custom location', () => {
    const source = snapshot();
    source.locations[0].isDefault = false;
    expectCode(() => planInventoryAdoption(source, intent()), 'DRIFT_DETECTED');
  });

  it('rejects duplicate default buckets even when their location IDs differ', () => {
    const source = snapshot();
    source.locations.push({ ...source.locations[0], id: 'second-fridge' });
    expectCode(() => planInventoryAdoption(source, intent()), 'DRIFT_DETECTED');
  });

  it('rejects duplicate catalog IDs rather than silently collapsing the snapshot', () => {
    const source = snapshot();
    source.ingredientIds.push(source.ingredientIds[0]);
    expectCode(() => planInventoryAdoption(source, intent()), 'DRIFT_DETECTED');
  });

  it('rejects an orphan backfill instead of activating an apparently empty household', () => {
    const source = snapshot();
    source.legacyRows = [];
    expectCode(() => planInventoryAdoption(source, intent()), 'DRIFT_DETECTED');
  });

  it.each(['rows', 'lots', 'locations'] as const)('rejects foreign %s', (collection) => {
    const source = snapshot();
    if (collection === 'rows') source.legacyRows[0].household_id = 'foreign';
    if (collection === 'lots') source.lots[0].lot.householdId = 'foreign';
    if (collection === 'locations') source.locations[0].householdId = 'foreign';
    expectCode(() => planInventoryAdoption(source, intent()), 'HOUSEHOLD_MISMATCH');
  });

  it('rejects incomplete snapshots, stale revisions and unavailable canonical ingredients', () => {
    expectCode(() => planInventoryAdoption({ ...snapshot(), complete: false } as unknown as InventoryAdoptionSnapshot, intent()), 'INVALID_ADOPTION_SNAPSHOT');
    expectCode(() => planInventoryAdoption(snapshot(), intent({ expectedInventoryVersion: 11 })), 'STALE_SNAPSHOT');
    expectCode(() => planInventoryAdoption({ ...snapshot(), ingredientIds: [] }, intent()), 'INGREDIENT_NOT_FOUND');
  });

  it('preserves anonymous historical identity rather than fabricating a native name', () => {
    const effect = planInventoryAdoption(snapshot([row({ ingredient_id: null, name: '' })]), intent()).effects[0];
    expect(effect.after).toMatchObject({ ingredientId: null, rawName: '', sourceType: 'LEGACY_BACKFILL' });
  });

  it('refuses already active and mixed mapped households, including active empty households', () => {
    expectCode(() => planInventoryAdoption({ ...snapshot([]), activationCommandId: 'receipt' }, intent()), 'ADOPTION_ALREADY_ACTIVE');
    const source = snapshot();
    source.lots[0].legacyItemId = source.legacyRows[0].id;
    expectCode(() => planInventoryAdoption(source, intent()), 'ADOPTION_ALREADY_ACTIVE');
  });

  it.each([0.0001, 0.1 + 0.2, Number.MAX_SAFE_INTEGER])('rejects unrepresentable quantity %s without rounding', (quantity) => {
    expectCode(() => planInventoryAdoption(snapshot([row({ quantity })], false), intent()), 'UNREPRESENTABLE_QUANTITY');
  });

  it('accepts exactly 32 effects and rejects 33 rather than chunking the household', () => {
    const rows = Array.from({ length: MAX_INVENTORY_ADOPTION_EFFECTS }, (_, index) => row({ id: `row-${index}` }));
    expect(planInventoryAdoption(snapshot(rows, false), intent()).effects).toHaveLength(32);
    rows.push(row({ id: 'overflow' }));
    expectCode(() => planInventoryAdoption(snapshot(rows, false), intent()), 'ADOPTION_LIMIT_EXCEEDED');
  });

  it.each(['legacyRows', 'lots', 'locations', 'ingredientIds'] as const)('rejects an oversized %s snapshot', (collection) => {
    const source = snapshot();
    const oversized = Array.from({ length: MAX_INVENTORY_ADOPTION_SNAPSHOT_ROWS + 1 }, () => source[collection][0]);
    expectCode(() => planInventoryAdoption({ ...source, [collection]: oversized }, intent()), 'ADOPTION_LIMIT_EXCEEDED');
  });

  it.each([997, 998, 1000])('bounds derived locations after filling missing defaults from %s locations', (count) => {
    const source = snapshot([]);
    const template = source.locations[0];
    source.locations = Array.from({ length: count }, (_, index) => ({
      ...template, id: `custom-${index}`, sortOrder: index, isDefault: false,
    }));
    const before = structuredClone(source);
    if (count + 3 > MAX_INVENTORY_ADOPTION_SNAPSHOT_ROWS) {
      expectCode(() => planInventoryAdoption(source, intent()), 'ADOPTION_LIMIT_EXCEEDED');
    } else {
      const plan = planInventoryAdoption(source, intent());
      expect(plan.missingLocations).toHaveLength(3);
      expect(plan.activation).toEqual({ kind: 'ACTIVATE_HOUSEHOLD', emptyHousehold: true });
    }
    expect(source).toEqual(before);
  });

  it('accepts exactly 1000 locations when all default buckets already exist', () => {
    const source = snapshot([]);
    const template = source.locations[0];
    source.locations.push(...Array.from({ length: MAX_INVENTORY_ADOPTION_SNAPSHOT_ROWS - 3 }, (_, index) => ({
      ...template, id: `custom-${index}`, sortOrder: index, isDefault: false,
    })));
    expect(planInventoryAdoption(source, intent()).missingLocations).toEqual([]);
  });

  it('rejects derived lot overflow before checking an inconsistent source snapshot', () => {
    const source = snapshot();
    source.lots = Array.from({ length: MAX_INVENTORY_ADOPTION_SNAPSHOT_ROWS }, (_, index) => ({
      lot: legacyInventoryToLot(row({ id: `orphan-${index}` })), legacyItemId: null,
    }));
    expectCode(() => planInventoryAdoption(source, intent()), 'ADOPTION_LIMIT_EXCEEDED');
  });

  it.each(['2026-02-30T12:00:00Z', 'yesterday', '2026-09-11'])('rejects invalid planning time %s', (invalidNow) => {
    expectCode(() => planInventoryAdoption(snapshot(), intent({ now: invalidNow })), 'INVALID_COMMAND');
  });
});
