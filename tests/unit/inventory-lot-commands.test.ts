import { describe, expect, it } from 'vitest';
import {
  InventoryLotCommandSchema,
  LotCommandError,
  planSingleLotCommand,
  type InventoryLotCommand,
  type LotCommandContext,
} from '../../packages/domain/src/inventory-lot-commands';
import {
  defaultStorageLocations,
  InventoryLotSchema,
  legacyInventoryToLot,
  type InventoryLot,
} from '../../packages/domain/src/inventory-truth';

const householdId = 'household-a';
const timestamp = '2026-09-10T09:00:00Z';
const now = '2026-09-10T17:00:00+07:00';
const locations = defaultStorageLocations(householdId, timestamp, timestamp);
const context: LotCommandContext = {
  householdId, now, locations, ingredientIds: ['CHICKEN_EGG', 'RICE'],
};
const create = (patch: Record<string, unknown> = {}) => ({
  type: 'CREATE', lotId: 'lot-a', ingredientId: 'CHICKEN_EGG', rawName: 'Eggs',
  quantity: 10, unit: 'piece', storageLocationId: locations[0].id, sourceType: 'MANUAL', ...patch,
});
const lot = (patch: Partial<InventoryLot> = {}): InventoryLot => ({
  ...planSingleLotCommand(create(), null, { ...context, now: timestamp }).after, ...patch,
});
const correct = (changes: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({
  type: 'CORRECT', lotId: 'lot-a', expectedVersion: 1, changes, reason: 'Counted stock again', ...patch,
});
const mutableCommands = [
  { type: 'USE', quantity: 1, unit: 'piece' },
  { type: 'DISCARD', quantity: 1, unit: 'piece' },
  { type: 'OPEN', openedAt: now },
  { type: 'MOVE', storageLocationId: locations[1].id },
  { type: 'CORRECT', changes: { rawName: 'Fresh eggs' }, reason: 'Label corrected' },
].map((command) => ({ ...command, lotId: 'lot-a', expectedVersion: 1 }));

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrow(LotCommandError);
  expect(action).toThrow(expect.objectContaining({ code }));
}

describe('T09B CREATE contracts and exact quantities', () => {
  it('creates a live lot with explicit provenance, unknown facts and owned timestamps', () => {
    const command = create();
    const snapshot = structuredClone(command);
    const result = planSingleLotCommand(command, null, context);
    expect(result).toEqual({ before: null, after: {
      id: 'lot-a', householdId, ingredientId: 'CHICKEN_EGG', rawName: 'Eggs',
      quantityMilli: 10000, canonicalUnit: 'piece', storageLocationId: locations[0].id,
      state: 'ACTIVE', version: 1, createdAt: now, updatedAt: now,
      purchasedAt: null, openedAt: null, expiryAt: null, estimatedExpiryAt: null,
      expiryKind: 'UNKNOWN', purchasePrice: null, sourceType: 'MANUAL', sourceId: null,
      legacyExpiryAt: null, legacyExpiryKind: null, legacyExpirySource: null,
      legacyOpenedAt: null, legacyVersion: null,
    }, changed: true, deltaMilli: 10000 });
    expect(command).toEqual(snapshot);
    expect(InventoryLotSchema.safeParse(result.after).success).toBe(true);
  });

  it.each([
    [0.001, 'g', 1, 'g'], [0.000001, 'kg', 1, 'g'], [0.2, 'kg', 200000, 'g'],
    [0.001, 'ml', 1, 'ml'], [1.25, 'l', 1250000, 'ml'], [0.3, 'piece', 300, 'piece'],
    [1, 'pack', 1000, 'pack'], [1.5, 'bunch', 1500, 'bunch'], [0.5, 'slice', 500, 'slice'],
  ])('normalizes %s %s to exact canonical milli-units', (quantity, unit, quantityMilli, canonicalUnit) => {
    expect(planSingleLotCommand(create({ quantity, unit }), null, context).after)
      .toMatchObject({ quantityMilli, canonicalUnit, state: 'ACTIVE' });
  });

  it.each([0, -1, NaN, Infinity, -Infinity, '1', null])('rejects nonpositive/non-numeric quantity %s', (quantity) => {
    expectCode(() => planSingleLotCommand(create({ quantity }), null, context), 'INVALID_COMMAND');
  });

  it.each([0.0001, 0.1 + 0.2, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE])(
    'rejects unrepresentable quantity %s without silent rounding', (quantity) => {
      expectCode(() => planSingleLotCommand(create({ quantity }), null, context), 'UNREPRESENTABLE_QUANTITY');
    },
  );

  it.each(['pcs', 'oz', 'cup', '', 'KG'])('rejects unsupported unit %s', (unit) => {
    expectCode(() => planSingleLotCommand(create({ unit }), null, context), 'INVALID_COMMAND');
  });

  it.each([
    { ingredientId: null, rawName: '  Local greens  ' },
    { ingredientId: 'RICE', rawName: '' },
    { ingredientId: 'RICE', rawName: '   ' },
  ])('accepts canonical identity OR nonblank raw label %j', (identity) => {
    expect(planSingleLotCommand(create(identity), null, context).after).toMatchObject(identity);
  });

  it.each([
    { ingredientId: null, rawName: '' }, { ingredientId: null, rawName: ' \t\n ' },
    { ingredientId: '', rawName: 'Egg' }, { rawName: 'Egg\0' }, { lotId: ' lot-a ' },
  ])('rejects invalid new identity %j', (identity) => {
    expectCode(() => planSingleLotCommand(create(identity), null, context), 'INVALID_COMMAND');
  });

  it('rejects an unknown canonical ID even when a raw label exists', () => {
    expectCode(() => planSingleLotCommand(create({ ingredientId: 'UNKNOWN_FOOD' }), null, context), 'INGREDIENT_NOT_FOUND');
  });

  it.each(['SCAN', 'SHOPPING', 'RECEIPT'])('requires and preserves %s source evidence', (sourceType) => {
    expectCode(() => planSingleLotCommand(create({ sourceType }), null, context), 'INVALID_COMMAND');
    expect(planSingleLotCommand(create({ sourceType, sourceId: 'source-a' }), null, context).after)
      .toMatchObject({ sourceType, sourceId: 'source-a' });
  });

  it('cannot create legacy provenance or replace an existing lot', () => {
    expectCode(() => planSingleLotCommand(create({ sourceType: 'LEGACY_BACKFILL', sourceId: 'legacy-a' }), null, context), 'INVALID_COMMAND');
    expectCode(() => planSingleLotCommand(create(), lot(), context), 'LOT_EXISTS');
  });
});

describe('T09B lifecycle and version-fenced transitions', () => {
  it.each(['USE', 'DISCARD'])('%s decrements exact quantity and records a final terminal transition', (type) => {
    const before = lot({ canonicalUnit: 'g', quantityMilli: 1000000, version: 8 });
    const snapshot = structuredClone(before);
    const partial = planSingleLotCommand({ type, lotId: before.id, expectedVersion: 8, quantity: 0.25, unit: 'kg' }, before, context);
    expect(partial.before).toBe(before);
    expect(partial).toMatchObject({ changed: true, deltaMilli: -250000, after: {
      state: 'ACTIVE', quantityMilli: 750000, canonicalUnit: 'g', version: 9, updatedAt: now, createdAt: timestamp,
    } });
    const final = planSingleLotCommand({ type, lotId: before.id, expectedVersion: 9, quantity: 750, unit: 'g' }, partial.after, context);
    expect(final).toMatchObject({ changed: true, deltaMilli: -750000, after: {
      state: type === 'USE' ? 'CONSUMED' : 'DISCARDED', quantityMilli: 0, version: 10,
    } });
    expect(before).toEqual(snapshot);
  });

  it.each(['USE', 'DISCARD'])('%s refuses overdraw, zero, negative and sub-milli amounts', (type) => {
    const before = lot();
    for (const [quantity, code] of [[11, 'INSUFFICIENT_QUANTITY'], [0, 'INVALID_COMMAND'], [-1, 'INVALID_COMMAND'], [0.0001, 'UNREPRESENTABLE_QUANTITY']] as const) {
      expectCode(() => planSingleLotCommand({ type, lotId: before.id, expectedVersion: 1, quantity, unit: 'piece' }, before, context), code);
      expect(before).toEqual(lot());
    }
  });

  it('opens once, and repeated opening with a current version is the same lot with no effect', () => {
    const before = lot();
    const opened = planSingleLotCommand({ type: 'OPEN', lotId: before.id, expectedVersion: 1, openedAt: now }, before, context);
    expect(opened).toMatchObject({ before, changed: true, deltaMilli: 0, after: { openedAt: now, version: 2, updatedAt: now } });
    const repeated = planSingleLotCommand({ type: 'OPEN', lotId: before.id, expectedVersion: 2, openedAt: '2026-09-11T12:00:00Z' }, opened.after, context);
    expect(repeated).toEqual({ before: opened.after, after: opened.after, changed: false, deltaMilli: 0 });
    expect(repeated.after).toBe(opened.after);
    expectCode(() => planSingleLotCommand({ type: 'OPEN', lotId: before.id, expectedVersion: 1, openedAt: now }, opened.after, context), 'STALE_VERSION');
  });

  it('moves within the household and preserves quantity; moving to the same location is a no-op', () => {
    const before = lot();
    const moved = planSingleLotCommand({ type: 'MOVE', lotId: before.id, expectedVersion: 1, storageLocationId: locations[1].id }, before, context);
    expect(moved).toMatchObject({ changed: true, deltaMilli: 0, after: { storageLocationId: locations[1].id, version: 2, quantityMilli: 10000 } });
    const repeated = planSingleLotCommand({ type: 'MOVE', lotId: before.id, expectedVersion: 2, storageLocationId: locations[1].id }, moved.after, context);
    expect(repeated).toEqual({ before: moved.after, after: moved.after, changed: false, deltaMilli: 0 });
    expect(repeated.after).toBe(moved.after);
  });

  it.each(mutableCommands)('requires an existing matching lot and current version for $type', (command) => {
    expectCode(() => planSingleLotCommand(command, null, context), 'LOT_NOT_FOUND');
    expectCode(() => planSingleLotCommand({ ...command, lotId: 'other-lot' }, lot(), context), 'LOT_NOT_FOUND');
    expectCode(() => planSingleLotCommand(command, lot({ version: 2 }), context), 'STALE_VERSION');
    for (const expectedVersion of [undefined, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(() => planSingleLotCommand({ ...command, expectedVersion }, lot(), context), 'INVALID_COMMAND');
    }
  });

  it.each(mutableCommands.filter((command) => command.type !== 'CORRECT'))('denies $type for terminal lots and historical ACTIVE zero', (command) => {
    for (const state of ['CONSUMED', 'DISCARDED', 'ACTIVE'] as const) {
      expectCode(() => planSingleLotCommand(command, lot({ state, quantityMilli: 0 }), context), 'LOT_NOT_ACTIVE');
    }
  });

  it('does not overflow versions, but an unchanged effect can retain the maximum version', () => {
    const before = lot({ version: Number.MAX_SAFE_INTEGER, openedAt: timestamp });
    expectCode(() => planSingleLotCommand(correct({ quantity: 11 }, { expectedVersion: before.version }), before, context), 'VERSION_OVERFLOW');
    const noOp = planSingleLotCommand({ type: 'OPEN', lotId: before.id, expectedVersion: before.version, openedAt: now }, before, context);
    expect(noOp.after).toBe(before);
    expect(noOp.changed).toBe(false);
  });
});

describe('T09B bounded correction and explicit revival', () => {
  it('corrects only explicit fields and preserves immutable provenance and original facts', () => {
    const before = lot({
      sourceType: 'LEGACY_BACKFILL', sourceId: 'legacy-a', legacyVersion: 6,
      legacyExpiryAt: 'not-a-date', legacyExpiryKind: 'unknown', legacyExpirySource: 'unknown',
      legacyOpenedAt: 'unknown', createdAt: '2026-09-09 12:30:00', updatedAt: '2026-09-09 12:30:00',
    });
    const changes = {
      rawName: '  Gạo  ', ingredientId: 'RICE', quantity: 3,
      expiryKind: 'BEST_BEFORE', expiryAt: '2026-10-01', estimatedExpiryAt: null,
      purchasedAt: '2026-09-08', openedAt: '2026-09-09T20:15:00Z',
      purchasePrice: { currency: 'VND', amountMinor: 15000, minorDigits: 0 },
    };
    const command = correct(changes);
    const commandSnapshot = structuredClone(command);
    const beforeSnapshot = structuredClone(before);
    const result = planSingleLotCommand(command, before, context);
    const { quantity, ...metadata } = changes;
    expect(result).toMatchObject({ before, changed: true, deltaMilli: -7000, after: {
      ...before, ...metadata, quantityMilli: quantity * 1000, updatedAt: now, version: 2,
    } });
    expect(result.after).not.toHaveProperty('quantity');
    expect(before).toEqual(beforeSnapshot);
    expect(command).toEqual(commandSnapshot);
  });

  it('keeps omitted metadata and can explicitly clear nullable evidence as a coherent group', () => {
    const before = lot({ expiryKind: 'ESTIMATED', estimatedExpiryAt: '2026-10-01', purchasedAt: '2026-09-09', openedAt: timestamp,
      purchasePrice: { currency: 'USD', amountMinor: 299, minorDigits: 2 } });
    const nameOnly = planSingleLotCommand(correct({ rawName: 'New label' }), before, context);
    expect(nameOnly.after).toEqual({ ...before, rawName: 'New label', version: 2, updatedAt: now });
    const changes = { expiryKind: 'UNKNOWN', estimatedExpiryAt: null, purchasedAt: null, openedAt: null, purchasePrice: null };
    expect(planSingleLotCommand(correct(changes), before, context).after).toMatchObject(changes);
  });

  it.each(['CONSUMED', 'DISCARDED'])('requires an explicit zero and terminalState %s, and explicit revival', (terminalState) => {
    const before = lot();
    const stopped = planSingleLotCommand(correct({ quantity: 0 }, { terminalState }), before, context);
    expect(stopped).toMatchObject({ changed: true, deltaMilli: -10000, after: { state: terminalState, quantityMilli: 0, version: 2 } });
    expectCode(() => planSingleLotCommand(correct({ quantity: 2 }, { expectedVersion: 2 }), stopped.after, context), 'REVIVE_REQUIRED');
    const revived = planSingleLotCommand(correct({ quantity: 2 }, { expectedVersion: 2, revive: true }), stopped.after, context);
    expect(revived).toMatchObject({ changed: true, deltaMilli: 2000, after: { state: 'ACTIVE', quantityMilli: 2000, version: 3 } });
    const renamed = planSingleLotCommand(correct({ rawName: 'Archived label' }, { expectedVersion: 2 }), stopped.after, context);
    expect(renamed).toMatchObject({ changed: true, deltaMilli: 0, after: { state: terminalState, quantityMilli: 0, version: 3 } });
  });

  it.each([
    correct({ quantity: 0 }), correct({ quantity: 0 }, { terminalState: 'ACTIVE' }),
    correct({ quantity: 1 }, { terminalState: 'CONSUMED' }), correct({ rawName: 'Label' }, { terminalState: 'DISCARDED' }),
    correct({ rawName: 'Label' }, { revive: true }), correct({ quantity: 0 }, { revive: true, terminalState: 'DISCARDED' }),
    correct({ quantity: 1 }, { revive: 'true' }),
  ])('rejects ambiguous state intent %j', (command) => {
    expectCode(() => planSingleLotCommand(command, lot(), context), 'INVALID_COMMAND');
  });

  it('defaults revival false in the parsed public command type', () => {
    const parsed: InventoryLotCommand = InventoryLotCommandSchema.parse(correct({ quantity: 1 }));
    expect(parsed).toMatchObject({ type: 'CORRECT', revive: false });
  });

  it.each([undefined, '', ' \n\t ', 'Correction\0'])('requires a meaningful correction reason %s', (reason) => {
    expectCode(() => planSingleLotCommand(correct({ rawName: 'Eggs' }, { reason }), lot(), context), 'INVALID_COMMAND');
  });

  it.each([{}, { rawName: undefined }, { quantity: undefined }])('requires at least one explicit correction field %j', (changes) => {
    expectCode(() => planSingleLotCommand(correct(changes), lot(), context), 'INVALID_COMMAND');
  });

  it.each([
    [-1, 'INVALID_COMMAND'], [NaN, 'INVALID_COMMAND'], [Infinity, 'INVALID_COMMAND'],
    [null, 'INVALID_COMMAND'], ['1', 'INVALID_COMMAND'], [0.0001, 'UNREPRESENTABLE_QUANTITY'],
    [0.1 + 0.2, 'UNREPRESENTABLE_QUANTITY'], [Number.MAX_SAFE_INTEGER, 'UNREPRESENTABLE_QUANTITY'],
  ])('rejects invalid corrected quantity %s without changing the lot', (quantity, code) => {
    const before = lot();
    expectCode(() => planSingleLotCommand(correct({ quantity }), before, context), code as string);
    expect(before).toEqual(lot());
  });

  it.each([
    { sourceType: 'SCAN' }, { sourceId: 'replacement' }, { id: 'replacement' }, { householdId: 'household-b' },
    { version: 9 }, { createdAt: now }, { updatedAt: now }, { storageLocationId: locations[1].id },
    { legacyVersion: 9 }, { legacyExpiryAt: '2026-01-01' }, { legacyOpenedAt: now },
    { state: 'DISCARDED' }, { quantityMilli: 0 }, { canonicalUnit: 'g' }, { reason: 'nested' },
  ])('denies unrestricted PATCH fields in changes %j', (fields) => {
    expectCode(() => planSingleLotCommand(correct({ rawName: 'Label', ...fields }), lot(), context), 'INVALID_COMMAND');
  });

  it.each([
    { ingredientId: null, rawName: '' }, { ingredientId: null, rawName: ' \n ' }, { rawName: '\0' },
  ])('cannot correct identity into an anonymous or malformed live identity %j', (changes) => {
    expectCode(() => planSingleLotCommand(correct(changes), lot(), context), 'INVALID_COMMAND');
  });

  it('checks a corrected canonical identity against context and allows clearing it with a label', () => {
    expectCode(() => planSingleLotCommand(correct({ ingredientId: 'UNKNOWN_FOOD' }), lot(), context), 'INGREDIENT_NOT_FOUND');
    expect(planSingleLotCommand(correct({ ingredientId: null }), lot(), context).after.ingredientId).toBeNull();
    expectCode(() => planSingleLotCommand(correct({ ingredientId: null }), lot({ rawName: '' }), context), 'INVALID_COMMAND');
  });

  it('treats equal corrected facts and unit aliases as no effect without version or timestamp churn', () => {
    const before = lot({ canonicalUnit: 'g', quantityMilli: 1000000, purchasePrice: { currency: 'USD', amountMinor: 299, minorDigits: 2 } });
    for (const changes of [{ unit: 'kg' }, { quantity: 1, unit: 'kg' }, { rawName: 'Eggs' }, { purchasePrice: { ...before.purchasePrice } }]) {
      const result = planSingleLotCommand(correct(changes), before, context);
      expect(result).toEqual({ before, after: before, changed: false, deltaMilli: 0 });
      expect(result.after).toBe(before);
    }
  });

  it('preserves historical anonymous T08 identity until explicitly corrected', () => {
    const before = lot({ rawName: '', ingredientId: null, sourceType: 'LEGACY_BACKFILL', sourceId: 'legacy-a', legacyVersion: 1 });
    expect(InventoryLotSchema.safeParse(before).success).toBe(true);
    expect(planSingleLotCommand(correct({ quantity: 9 }), before, context).after).toMatchObject({ rawName: '', ingredientId: null, quantityMilli: 9000 });
    expectCode(() => planSingleLotCommand(correct({ rawName: '' }), before, context), 'INVALID_COMMAND');
    expect(planSingleLotCommand(correct({ rawName: 'Reviewed label' }), before, context).after.rawName).toBe('Reviewed label');
  });

  it('repairs historical ACTIVE zero through an explicit quantity correction without tightening T08', () => {
    const before = lot({ quantityMilli: 0 });
    expect(InventoryLotSchema.safeParse(before).success).toBe(true);
    expectCode(() => planSingleLotCommand(correct({ rawName: 'Label' }), before, context), 'INVALID_LOT_STATE');
    expect(planSingleLotCommand(correct({ quantity: 0 }, { terminalState: 'CONSUMED' }), before, context).after.state).toBe('CONSUMED');
  });
});

describe('T09B strictly compatible unit identity', () => {
  it.each([
    ['g', 'kg', 1, 1000000], ['ml', 'l', 0.5, 500000], ['piece', 'piece', 0.5, 500],
    ['pack', 'pack', 2, 2000], ['bunch', 'bunch', 3, 3000], ['slice', 'slice', 0.25, 250],
  ] as const)('allows exact correction from %s using %s', (canonicalUnit, unit, quantity, quantityMilli) => {
    const before = lot({ canonicalUnit });
    expect(planSingleLotCommand(correct({ quantity, unit }), before, context))
      .toMatchObject({ deltaMilli: quantityMilli - before.quantityMilli, after: { canonicalUnit, quantityMilli } });
  });

  it.each([
    ['piece', 'g'], ['g', 'piece'], ['g', 'ml'], ['ml', 'kg'], ['piece', 'pack'],
    ['pack', 'bunch'], ['bunch', 'slice'], ['slice', 'piece'],
  ] as const)('rejects reinterpretation of %s as %s for every quantity-changing command', (canonicalUnit, unit) => {
    const before = lot({ canonicalUnit });
    for (const command of [
      { type: 'USE', lotId: before.id, expectedVersion: 1, quantity: 1, unit },
      { type: 'DISCARD', lotId: before.id, expectedVersion: 1, quantity: 1, unit },
      correct({ quantity: 1, unit }), correct({ unit }),
    ]) expectCode(() => planSingleLotCommand(command, before, context), 'INCOMPATIBLE_UNIT');
  });

  it('defaults corrected quantity to the stored canonical unit, not the create input alias', () => {
    const before = planSingleLotCommand(create({ quantity: 2, unit: 'kg' }), null, context).after;
    expect(planSingleLotCommand(correct({ quantity: 300 }), before, context))
      .toMatchObject({ deltaMilli: -1700000, after: { quantityMilli: 300000, canonicalUnit: 'g' } });
  });
});

describe('T09B fail-closed ownership and boundary validation', () => {
  it.each([create(), ...mutableCommands])('refuses foreign or absent storage locations for $type', (command) => {
    const existing = command.type === 'CREATE' ? null : lot();
    expectCode(() => planSingleLotCommand(command, existing, { ...context, locations: [] }), 'LOCATION_NOT_FOUND');
    const foreign = defaultStorageLocations('household-b', timestamp, timestamp);
    expectCode(() => planSingleLotCommand(command, existing, { ...context, locations: [...locations, ...foreign] }), 'HOUSEHOLD_MISMATCH');
  });

  it.each(mutableCommands)('rejects foreign existing ownership for $type', (command) => {
    expectCode(() => planSingleLotCommand(command, lot({ householdId: 'household-b' }), context), 'HOUSEHOLD_MISMATCH');
    expectCode(() => planSingleLotCommand(command, lot(), { ...context, ingredientIds: [] }), 'INGREDIENT_NOT_FOUND');
  });

  it('checks the MOVE target independently of the existing owned location', () => {
    expectCode(() => planSingleLotCommand({ type: 'MOVE', lotId: 'lot-a', expectedVersion: 1, storageLocationId: 'foreign-location' }, lot(), context), 'LOCATION_NOT_FOUND');
  });

  it.each([
    { householdId: '' }, { locations: [locations[0], locations[0]] }, { ingredientIds: ['not-canonical'] },
    { locations: [{ ...locations[0], type: 'UNKNOWN' }] }, { locations: [{ ...locations[0], id: '' }] },
  ])('rejects invalid or ambiguous context %j', (patch) => {
    expectCode(() => planSingleLotCommand(create(), null, { ...context, ...patch } as LotCommandContext), 'INVALID_CONTEXT');
  });

  it.each([
    { quantityMilli: -1 }, { quantityMilli: 0.1 }, { canonicalUnit: 'kg' }, { version: 0 },
    { sourceType: 'SCAN', sourceId: null }, { expiryKind: 'USE_BY', expiryAt: null },
  ])('rejects malformed existing lot facts %j', (patch) => {
    expectCode(() => planSingleLotCommand(correct({ rawName: 'Label' }), { ...lot(), ...patch } as InventoryLot, context), 'INVALID_LOT');
  });

  it.each([create(), ...mutableCommands])('rejects caller-injected ownership/provenance/version fields for $type', (command) => {
    const existing = command.type === 'CREATE' ? null : lot();
    for (const fields of [{ householdId: 'household-b' }, { actorId: 'attacker' }, { version: 99 }, { updatedAt: now }]) {
      expectCode(() => planSingleLotCommand({ ...command, ...fields }, existing, context), 'INVALID_COMMAND');
    }
  });

  it.each(['USE', 'DISCARD'])('allows an optional meaningful %s reason but not whitespace or NUL', (type) => {
    const command = { type, lotId: 'lot-a', expectedVersion: 1, quantity: 1, unit: 'piece' };
    expect(planSingleLotCommand({ ...command, reason: 'Used for breakfast' }, lot(), context).changed).toBe(true);
    for (const reason of ['', '\t\n ', 'reason\0']) {
      expectCode(() => planSingleLotCommand({ ...command, reason }, lot(), context), 'INVALID_COMMAND');
    }
  });
});

describe('T09B unknown money and evidence-coherent expiry', () => {
  it.each([['VND', 0], ['JPY', 0], ['USD', 2], ['EUR', 2]] as const)('accepts %s integer minor units, including explicit zero', (currency, minorDigits) => {
    const purchasePrice = { currency, minorDigits, amountMinor: 0 };
    expect(planSingleLotCommand(create({ purchasePrice }), null, context).after.purchasePrice).toEqual(purchasePrice);
    expect(planSingleLotCommand(correct({ purchasePrice }), lot(), context)).toMatchObject({ changed: true, deltaMilli: 0, after: { purchasePrice } });
    expect(planSingleLotCommand(correct({ purchasePrice: null }), lot({ purchasePrice }), context).after.purchasePrice).toBeNull();
  });

  it.each([
    { currency: 'USD', amountMinor: 1.5, minorDigits: 2 }, { currency: 'USD', amountMinor: -1, minorDigits: 2 },
    { currency: 'USD', amountMinor: NaN, minorDigits: 2 }, { currency: 'USD', amountMinor: Infinity, minorDigits: 2 },
    { currency: 'USD', amountMinor: Number.MAX_SAFE_INTEGER + 1, minorDigits: 2 },
    { currency: 'VND', amountMinor: 0, minorDigits: 2 }, { currency: 'JPY', amountMinor: 0 },
    { currency: 'BTC', amountMinor: 0, minorDigits: 0 }, { currency: 'EUR', amountMinor: 1, minorDigits: 2, guessed: true },
  ])('rejects invalid money in CREATE and CORRECT %j', (purchasePrice) => {
    expectCode(() => planSingleLotCommand(create({ purchasePrice }), null, context), 'INVALID_COMMAND');
    expectCode(() => planSingleLotCommand(correct({ purchasePrice }), lot(), context), 'INVALID_COMMAND');
  });

  it.each([
    { expiryKind: 'UNKNOWN', expiryAt: null, estimatedExpiryAt: null },
    { expiryKind: 'KNOWN', expiryAt: '2026-10-01', estimatedExpiryAt: null },
    { expiryKind: 'BEST_BEFORE', expiryAt: '2026-10-01', estimatedExpiryAt: null },
    { expiryKind: 'USE_BY', expiryAt: '2026-10-01', estimatedExpiryAt: null },
    { expiryKind: 'ESTIMATED', expiryAt: null, estimatedExpiryAt: '2026-10-01' },
  ])('retains explicit expiry evidence without inferring safety %j', (evidence) => {
    expect(planSingleLotCommand(create(evidence), null, context).after).toMatchObject(evidence);
    expect(planSingleLotCommand(correct(evidence), lot(), context).after).toMatchObject(evidence);
  });

  it.each([
    { expiryKind: 'UNKNOWN', expiryAt: '2026-10-01' }, { expiryKind: 'UNKNOWN', estimatedExpiryAt: '2026-10-01' },
    { expiryKind: 'USE_BY' }, { expiryKind: 'BEST_BEFORE' }, { expiryKind: 'KNOWN' }, { expiryKind: 'ESTIMATED' },
    { expiryKind: 'USE_BY', expiryAt: '2026-10-01', estimatedExpiryAt: '2026-10-02' },
    { expiryKind: 'ESTIMATED', expiryAt: '2026-10-01', estimatedExpiryAt: '2026-10-02' },
  ])('rejects mismatched expiry evidence %j', (evidence) => {
    expectCode(() => planSingleLotCommand(create(evidence), null, context), 'INVALID_COMMAND');
    expectCode(() => planSingleLotCommand(correct(evidence), lot(), context), 'INVALID_COMMAND');
  });

  it('validates merged correction evidence rather than silently clearing an omitted old date', () => {
    const before = lot({ expiryKind: 'USE_BY', expiryAt: '2026-10-01' });
    expectCode(() => planSingleLotCommand(correct({ expiryKind: 'ESTIMATED', estimatedExpiryAt: '2026-10-02' }), before, context), 'INVALID_COMMAND');
    expect(planSingleLotCommand(correct({ expiryKind: 'ESTIMATED', expiryAt: null, estimatedExpiryAt: '2026-10-02' }), before, context).after)
      .toMatchObject({ expiryKind: 'ESTIMATED', expiryAt: null, estimatedExpiryAt: '2026-10-02' });
  });
});

describe('T09B strict live calendars without retroactive historical timestamp rejection', () => {
  it.each(['2026-02-30', '2025-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-9-10'])(
    'rejects invalid calendar date %s on every new date field', (date) => {
      const changes = [
        { purchasedAt: date }, { expiryAt: date, expiryKind: 'KNOWN' },
        { estimatedExpiryAt: date, expiryKind: 'ESTIMATED' },
      ];
      for (const fields of changes) {
        expectCode(() => planSingleLotCommand(create(fields), null, context), 'INVALID_COMMAND');
        expectCode(() => planSingleLotCommand(correct(fields), lot(), context), 'INVALID_COMMAND');
      }
    },
  );

  it.each([
    '2026-02-30T10:00:00Z', '2025-02-29T10:00:00Z', '1900-02-29T10:00:00Z',
    '2026-04-31T10:00:00+07:00', '2026-09-10T24:00:00Z', '2026-09-10T10:60:00Z',
    '2026-09-10T10:00:60Z', '2026-09-10T10:00:00+24:00', '2026-09-10T10:00:00+07:60',
    '2026-09-10T10:00:00', '2026-09-10 10:00:00', 'not-an-instant',
  ])('rejects invalid live instant %s in CREATE, OPEN, CORRECT and context', (openedAt) => {
    expectCode(() => planSingleLotCommand(create({ openedAt }), null, context), 'INVALID_COMMAND');
    expectCode(() => planSingleLotCommand({ type: 'OPEN', lotId: 'lot-a', expectedVersion: 1, openedAt }, lot(), context), 'INVALID_COMMAND');
    expectCode(() => planSingleLotCommand(correct({ openedAt }), lot(), context), 'INVALID_COMMAND');
    expectCode(() => planSingleLotCommand(create(), null, { ...context, now: openedAt }), 'INVALID_CONTEXT');
    expectCode(() => planSingleLotCommand(correct({ rawName: 'Eggs' }), lot(), { ...context, now: openedAt }), 'INVALID_CONTEXT');
  });

  it.each(['2000-02-29T23:59:59Z', '2024-02-29T00:00:00.123+07:00', '2026-09-10T10:00:00-04:30'])('accepts valid calendar instants and offsets %s', (openedAt) => {
    const result = planSingleLotCommand(create({ openedAt, purchasedAt: openedAt.slice(0, 10) }), null, { ...context, now: openedAt });
    expect(result.after).toMatchObject({ openedAt, createdAt: openedAt, updatedAt: openedAt, purchasedAt: openedAt.slice(0, 10) });
  });

  it('preserves historical SQLite timestamps and raw legacy evidence on mutation', () => {
    const before = legacyInventoryToLot({
      id: 'legacy-a', household_id: householdId, ingredient_id: 'CHICKEN_EGG', name: 'Eggs',
      quantity: 10, unit: 'piece', storage: 'fridge', version: 8,
      expiry_date: 'unknown date', expiry_kind: 'unknown', expiry_source: 'unknown', opened_at: 'unknown timestamp',
      created_at: '2026-09-09 10:00:00', updated_at: '2026-09-09 11:00:00',
    });
    const result = planSingleLotCommand({ type: 'USE', lotId: before.id, expectedVersion: 1, quantity: 1, unit: 'piece' }, before, context);
    expect(result.after).toMatchObject({ createdAt: before.createdAt, updatedAt: now, legacyOpenedAt: 'unknown timestamp',
      legacyExpiryAt: 'unknown date', sourceId: before.sourceId, sourceType: 'LEGACY_BACKFILL', legacyVersion: 8 });
  });

  it('rejects impossible opening dates in both existing facts and newly supplied commands', () => {
    const openedAt = '2026-02-30T10:00:00Z';
    const before = lot({ openedAt });
    expect(InventoryLotSchema.safeParse(before).success).toBe(false);
    expectCode(() => planSingleLotCommand(correct({ rawName: 'Reviewed eggs' }), before, context), 'INVALID_LOT');
    expectCode(() => planSingleLotCommand(correct({ openedAt }), lot(), context), 'INVALID_COMMAND');
  });
});
