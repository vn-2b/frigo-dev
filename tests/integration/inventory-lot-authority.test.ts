import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeInventoryLotCommand,
  type InventoryLotCommandExecution,
  type InventoryLotCommandScope,
} from '../../packages/db/src/inventory-lot-commands';
import { InventoryLotCommandSchema } from '../../packages/domain/src/inventory-lot-commands';
import { createBarrier, SqliteD1, type SqliteStatementEvent } from '../helpers/sqlite-d1';

const scope = { householdId: 't09d-a', actorId: 't09d-owner-a' };
const member = { ...scope, actorId: 't09d-member-a' };
const foreign = { householdId: 't09d-b', actorId: 't09d-owner-b' };
const now = '2026-09-10T10:00:00Z';
const later = '2026-09-11T12:00:00Z';
const databases: SqliteD1[] = [];
type Input = Record<string, unknown>;
type CommandType = 'CREATE' | 'USE' | 'DISCARD' | 'OPEN' | 'MOVE' | 'CORRECT';
const types: CommandType[] = ['CREATE', 'USE', 'DISCARD', 'OPEN', 'MOVE', 'CORRECT'];

function database(): SqliteD1 {
  const db = new SqliteD1();
  databases.push(db);
  db.seed(`INSERT INTO users(id) VALUES ('t09d-owner-a'), ('t09d-member-a'), ('t09d-owner-b');
    INSERT INTO households(id, name, created_by) VALUES
      ('t09d-a', 'Authority A', 't09d-owner-a'), ('t09d-b', 'Authority B', 't09d-owner-b');
    INSERT INTO household_members(id, household_id, user_id, role) VALUES
      ('t09d-membership-a', 't09d-a', 't09d-owner-a', 'owner'),
      ('t09d-membership-member', 't09d-a', 't09d-member-a', 'member'),
      ('t09d-membership-b', 't09d-b', 't09d-owner-b', 'owner');`);
  for (const household of [scope.householdId, foreign.householdId]) {
    for (const [index, type] of ['FRIDGE', 'FREEZER', 'PANTRY'].entries()) {
      db.execute(`INSERT INTO storage_locations
        (id, household_id, type, name, sort_order, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`, [`${household}-${type}`, household, type, type, index, now, now]);
    }
  }
  return db;
}

afterEach(() => {
  vi.useRealTimers();
  databases.splice(0).forEach((db) => db.close());
});

const create = (patch: Input = {}): Input => ({
  type: 'CREATE', lotId: 'lot-a', ingredientId: 'RICE', rawName: 'Rice', quantity: 5000,
  unit: 'g', storageLocationId: 't09d-a-FRIDGE', sourceType: 'MANUAL', ...patch,
});
const correct = (changes: Input, patch: Input = {}): Input => ({
  type: 'CORRECT', lotId: 'lot-a', expectedVersion: 1, changes, reason: 'Physical recount', ...patch,
});
function command(type: CommandType, patch: Input = {}): Input {
  if (type === 'CREATE') return create(patch);
  const identity = { type, lotId: 'lot-a', expectedVersion: 1 };
  if (type === 'USE' || type === 'DISCARD') return { ...identity, quantity: 2, unit: 'g', reason: 'Measured deduction', ...patch };
  if (type === 'OPEN') return { ...identity, openedAt: now, ...patch };
  if (type === 'MOVE') return { ...identity, storageLocationId: 't09d-a-FREEZER', ...patch };
  return correct({ quantity: 4000, rawName: 'Counted rice' }, patch);
}
const execute = (db: SqliteD1, key: string, input: unknown, owner = scope, timestamp = now) =>
  executeInventoryLotCommand(db, owner, key, input, timestamp);
const isWrite = (statements: readonly SqliteStatementEvent[]) =>
  statements.some(({ sql }) => /^INSERT INTO inventory_commands/.test(sql));

// Keep receipt/event JSON strings intact: semantic equality would hide rewritten evidence.
function stateBytes(db: SqliteD1): string {
  return JSON.stringify(Object.fromEntries([
    'households', 'household_members', 'storage_locations', 'inventory_lots',
    'inventory_items', 'inventory_commands', 'inventory_events',
  ].map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY id`)])));
}
function stockBytes(db: SqliteD1): string {
  return JSON.stringify(['households', 'inventory_lots', 'inventory_items', 'inventory_events']
    .map((table) => db.query(`SELECT * FROM ${table} ORDER BY id`)));
}
async function expectRejected(db: SqliteD1, key: string, input: unknown, code: string, owner = scope): Promise<void> {
  const before = stateBytes(db);
  await expect(execute(db, key, input, owner, later)).rejects.toMatchObject({ name: 'LotCommandError', code });
  expect(stateBytes(db)).toBe(before);
}

async function prepared(input: Input, setup: Input[] = [], initial: Input = {}): Promise<SqliteD1> {
  const db = database();
  if (input.type !== 'CREATE') {
    await execute(db, 'seed-a', create(initial));
    await execute(db, 'seed-b', create({ ...initial, lotId: 'lot-b' }));
  }
  for (const [index, entry] of setup.entries()) await execute(db, `setup-${index}`, entry);
  return db;
}

function expectEvidence(db: SqliteD1, execution: InventoryLotCommandExecution, input: Input,
  key: string, owner: InventoryLotCommandScope = scope): void {
  const { result } = execution;
  const parsed = InventoryLotCommandSchema.parse(input);
  const receipts = db.query<{
    id: string; household_id: string; actor_id: string; client_key: string; command_type: string;
    fingerprint: string; result_json: string; created_at: string;
  }>('SELECT * FROM inventory_commands WHERE household_id = ? AND client_key = ?', owner.householdId, key);
  expect(receipts).toHaveLength(1);
  const receipt = receipts[0];
  expect(receipt).toMatchObject({ id: result.commandId, household_id: owner.householdId,
    actor_id: owner.actorId, client_key: key, command_type: parsed.type, result_json: JSON.stringify(result) });
  expect(JSON.parse(receipt.fingerprint)).toEqual({ ...owner, command: parsed });
  const events = db.query<{
    household_id: string; inventory_item_id: string; command_id: string; event_type: string;
    quantity_delta: number; unit: string; reason: string | null; metadata: string; created_at: string;
  }>('SELECT * FROM inventory_events WHERE command_id = ? ORDER BY id', result.commandId);
  expect(events).toHaveLength(result.effects.length);
  for (const [index, effect] of result.effects.entries()) {
    expect(effect.changed).toBe(true);
    expect(effect.deltaMilli).toBe(effect.after.quantityMilli - (effect.before?.quantityMilli ?? 0));
    expect(events[index]).toMatchObject({ household_id: owner.householdId, inventory_item_id: result.lotId,
      command_id: result.commandId, event_type: parsed.type === 'CREATE' ? 'ADD' : parsed.type === 'DISCARD' ? 'DISCARD' : 'MANUAL_UPDATE',
      quantity_delta: effect.deltaMilli / 1000, unit: effect.after.canonicalUnit,
      reason: 'reason' in parsed ? parsed.reason ?? null : null, created_at: receipt.created_at });
    expect(JSON.parse(events[index].metadata)).toEqual({
      schemaVersion: 1, ...owner, commandId: result.commandId, commandType: parsed.type,
      before: effect.before, after: effect.after, deltaMilli: effect.deltaMilli,
      source: { type: effect.after.sourceType, id: effect.after.sourceId }, timestamp: receipt.created_at,
      clientKey: key, fingerprint: receipt.fingerprint,
      allocation: [{ lotId: result.lotId, deltaMilli: effect.deltaMilli, canonicalUnit: effect.after.canonicalUnit }],
    });
  }
  expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
}

interface FingerprintCase {
  name: string;
  original: Input;
  changed: Input;
  changedSetup?: Input[];
}
function fieldCases(prefix: string, original: Input, patches: Record<string, Input>): FingerprintCase[] {
  return Object.entries(patches).map(([name, patch]) => ({ name: `${prefix}.${name}`, original, changed: { ...original, ...patch } }));
}
const price = { currency: 'USD', amountMinor: 299, minorDigits: 2 };
const fullCreate = create({ expiryKind: 'KNOWN', expiryAt: '2026-09-15', purchasedAt: '2026-09-09',
  openedAt: now, purchasePrice: price, sourceId: 'manual-record-a' });
const fullChanges = {
  quantity: 4000, unit: 'g', rawName: 'Counted rice', ingredientId: 'RICE', expiryAt: '2026-09-15',
  estimatedExpiryAt: null, expiryKind: 'KNOWN', purchasedAt: '2026-09-09', openedAt: now, purchasePrice: price,
};
const fingerprints: FingerprintCase[] = [
  ...fieldCases('CREATE', fullCreate, {
    lotId: { lotId: 'lot-b' }, ingredientId: { ingredientId: 'CHICKEN_EGG' },
    'ingredientId.null': { ingredientId: null }, rawName: { rawName: ' Rice ' },
    quantity: { quantity: 5001 }, unit: { unit: 'kg' }, 'unit.dimension': { unit: 'ml' },
    storageLocationId: { storageLocationId: 't09d-a-PANTRY' }, expiryAt: { expiryAt: '2026-09-16' },
    expiryKind: { expiryKind: 'USE_BY' }, 'expiryKind.bestBefore': { expiryKind: 'BEST_BEFORE' },
    'expiryKind.unknown': { expiryKind: 'UNKNOWN', expiryAt: null },
    purchasedAt: { purchasedAt: '2026-09-08' }, 'purchasedAt.null': { purchasedAt: null },
    openedAt: { openedAt: later }, 'openedAt.null': { openedAt: null },
    'purchasePrice.null': { purchasePrice: null },
    'purchasePrice.currency': { purchasePrice: { ...price, currency: 'EUR' } },
    'purchasePrice.amountMinor': { purchasePrice: { ...price, amountMinor: 300 } },
    // A valid minorDigits change also requires the currency's matching scale.
    'purchasePrice.minorDigits': { purchasePrice: { ...price, currency: 'JPY', minorDigits: 0 } },
    sourceType: { sourceType: 'SCAN' }, 'sourceType.shopping': { sourceType: 'SHOPPING' },
    'sourceType.receipt': { sourceType: 'RECEIPT' }, sourceId: { sourceId: 'manual-record-b' },
    'sourceId.null': { sourceId: null },
  }),
  ...fieldCases('CREATE.estimated', create({ expiryKind: 'ESTIMATED', estimatedExpiryAt: '2026-09-15' }), {
    estimatedExpiryAt: { estimatedExpiryAt: '2026-09-16' },
    'estimatedExpiryAt.null': { estimatedExpiryAt: null, expiryKind: 'UNKNOWN' },
  }),
  ...(['USE', 'DISCARD'] as const).flatMap((type) => fieldCases(type, command(type), {
    quantity: { quantity: 3 }, unit: { unit: 'kg' }, reason: { reason: 'Different measured deduction' },
    'reason.omitted': { reason: undefined },
  })),
  ...fieldCases('OPEN', command('OPEN'), { openedAt: { openedAt: later } }),
  ...fieldCases('MOVE', command('MOVE'), { storageLocationId: { storageLocationId: 't09d-a-PANTRY' } }),
  ...Object.entries({
    quantity: { quantity: 3999 }, unit: { unit: 'kg' }, rawName: { rawName: 'Counted rice ' },
    ingredientId: { ingredientId: 'CHICKEN_EGG' }, 'ingredientId.null': { ingredientId: null },
    expiryAt: { expiryAt: '2026-09-16' }, expiryKind: { expiryKind: 'BEST_BEFORE' },
    'expiryAt.null': { expiryAt: null, expiryKind: 'UNKNOWN' },
    purchasedAt: { purchasedAt: '2026-09-08' }, 'purchasedAt.null': { purchasedAt: null },
    openedAt: { openedAt: later }, 'openedAt.null': { openedAt: null },
    'purchasePrice.null': { purchasePrice: null },
    'purchasePrice.currency': { purchasePrice: { ...price, currency: 'EUR' } },
    'purchasePrice.amountMinor': { purchasePrice: { ...price, amountMinor: 300 } },
    'purchasePrice.minorDigits': { purchasePrice: { ...price, currency: 'VND', minorDigits: 0 } },
  }).map(([name, changes]) => ({ name: `CORRECT.changes.${name}`, original: correct(fullChanges),
    changed: correct({ ...fullChanges, ...changes }) })),
  { name: 'CORRECT.changes.estimatedExpiryAt',
    original: correct({ expiryKind: 'ESTIMATED', estimatedExpiryAt: '2026-09-15' }),
    changed: correct({ expiryKind: 'ESTIMATED', estimatedExpiryAt: '2026-09-16' }) },
  { name: 'CORRECT.changes.estimatedExpiryAt.explicitNull', original: correct({ rawName: 'Counted rice' }),
    changed: correct({ rawName: 'Counted rice', estimatedExpiryAt: null }) },
  ...fieldCases('CORRECT', correct(fullChanges), {
    reason: { reason: 'Checked the original receipt' }, revive: { revive: true },
  }),
  { name: 'CORRECT.terminalState', original: correct({ quantity: 0 }, { terminalState: 'CONSUMED' }),
    changed: correct({ quantity: 0 }, { terminalState: 'DISCARDED' }) },
  ...types.filter((type) => type !== 'CREATE').flatMap((type) => [
    { name: `${type}.lotId`, original: command(type), changed: command(type, { lotId: 'lot-b' }) },
    { name: `${type}.expectedVersion`, original: command(type), changed: command(type, { expectedVersion: 2 }),
      changedSetup: [command('USE', { quantity: 1 })] },
  ]),
];

describe('T09D exhaustive validated intent fingerprints', () => {
  it.each(fingerprints)('conflicts on $name without rewriting any stock or evidence', async ({ original, changed, changedSetup }) => {
    const db = await prepared(original);
    const control = await prepared(changed, changedSetup);
    const first = await execute(db, 'intent', original);
    const alternative = await execute(control, 'intent', changed);
    expect(first.replayed).toBe(false);
    expect(alternative.replayed).toBe(false);
    expectEvidence(db, first, original, 'intent');
    expectEvidence(control, alternative, changed, 'intent');
    await expectRejected(db, 'intent', changed, 'IDEMPOTENCY_CONFLICT');
    await expectRejected(control, 'intent', original, 'IDEMPOTENCY_CONFLICT');
  });

  it.each(types.flatMap((first) => types.filter((second) => second !== first).map((second) => ({ first, second }))))(
    'distinguishes command type $first from $second', async ({ first, second }) => {
      const db = await prepared(command('USE'));
      const input = command(first, first === 'CREATE' ? { lotId: 'new-lot' } : {});
      await execute(db, 'typed-key', input);
      await expectRejected(db, 'typed-key', command(second, second === 'CREATE' ? { lotId: 'new-lot' } : {}), 'IDEMPOTENCY_CONFLICT');
    },
  );

  it.each(['USE', 'DISCARD', 'CORRECT'] as const)('retains %s input units even for equivalent canonical quantities', async (type) => {
    const db = await prepared(command(type));
    const original = type === 'CORRECT' ? correct({ quantity: 1000, unit: 'g' }) : command(type, { quantity: 1000, unit: 'g' });
    const changed = type === 'CORRECT' ? correct({ quantity: 1, unit: 'kg' }) : command(type, { quantity: 1, unit: 'kg' });
    await execute(db, 'units', original);
    await expectRejected(db, 'units', changed, 'IDEMPOTENCY_CONFLICT');
  });
});

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)]),
  );
  return value;
}
const replayCases = [
  ...types.map((type) => ({ name: type, input: type === 'CREATE' ? create({ ingredientId: undefined })
    : type === 'USE' || type === 'DISCARD' ? command(type, { reason: undefined }) : command(type), initial: {} })),
  { name: 'CREATE nested money', input: fullCreate, initial: {} },
  { name: 'CORRECT nested money', input: correct({ ...fullChanges, unit: undefined }), initial: {} },
  { name: 'OPEN receipt-only no-op', input: command('OPEN', { openedAt: later }), initial: { openedAt: now } },
  { name: 'MOVE receipt-only no-op', input: command('MOVE', { storageLocationId: 't09d-a-FRIDGE' }), initial: {} },
  { name: 'CORRECT receipt-only no-op', input: correct({ quantity: 5000 }), initial: {} },
];

describe('T09D exact logical replay authority', () => {
  it.each(replayCases)('replays $name across recursive ordering, explicit defaults, later stock and the server clock', async ({ name, input, initial }) => {
    const db = await prepared(input, [], initial);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    const originalStock = stockBytes(db);
    const first = await executeInventoryLotCommand(db, scope, 'replay', input);
    expect(first.replayed).toBe(false);
    expectEvidence(db, first, input, 'replay');
    if (name.includes('no-op')) {
      expect(first.result.effects).toEqual([]);
      expect(stockBytes(db)).toBe(originalStock);
    } else expect(first.result.effects).toHaveLength(1);
    const variants = [input, reverseKeys(input), InventoryLotCommandSchema.parse(input),
      reverseKeys(InventoryLotCommandSchema.parse(input)), JSON.parse(JSON.stringify(input))];
    vi.setSystemTime(new Date(later));
    let before = stateBytes(db);
    for (const variant of variants) {
      const replay = await executeInventoryLotCommand(db, scope, 'replay', variant);
      expect(replay).toEqual({ result: first.result, replayed: true });
      expect(JSON.stringify(replay.result)).toBe(JSON.stringify(first.result));
      expect(stateBytes(db)).toBe(before);
    }
    await execute(db, 'later-mutation', correct({ rawName: 'Changed after original receipt' },
      { expectedVersion: first.result.version }), scope, later);
    before = stateBytes(db);
    expect(await executeInventoryLotCommand(db, scope, 'replay', variants[3]))
      .toEqual({ result: first.result, replayed: true });
    expect(stateBytes(db)).toBe(before);
  });
});

async function race(db: SqliteD1, first: Input, second: Input, secondActor = scope) {
  const ready = createBarrier(2);
  const committed = createBarrier(2);
  let arrivals = 0;
  let commits = 0;
  let winnerBytes: string | undefined;
  db.hooks.beforeBatch = async (statements) => {
    if (!isWrite(statements)) return;
    const isFirst = ++arrivals === 1;
    await ready.wait();
    if (!isFirst) await committed.wait();
  };
  db.hooks.afterBatch = async (results) => {
    if (results[0]?.meta?.changes !== 1) return;
    commits += 1;
    winnerBytes = stateBytes(db);
    await committed.wait();
  };
  const results = await Promise.allSettled([
    execute(db, 'race-key', first), execute(db, 'race-key', second, secondActor, later),
  ]);
  db.hooks = {};
  expect(ready.arrivals).toBe(2);
  expect(committed.arrivals).toBe(2);
  expect(commits).toBe(1);
  expect(winnerBytes).toBeDefined();
  expect(stateBytes(db)).toBe(winnerBytes);
  return results;
}

const raceChanges: Record<CommandType, Input> = {
  CREATE: { rawName: 'Other rice' }, USE: { quantity: 3 }, DISCARD: { quantity: 3 },
  OPEN: { openedAt: later }, MOVE: { storageLocationId: 't09d-a-PANTRY' },
  CORRECT: { changes: { quantity: 3999, rawName: 'Counted rice' } },
};

describe('T09D controlled same-key concurrency', () => {
  it.each(types.flatMap((type) => [false, true].map((different) => ({ type, different }))))(
    '$type same-key racers preserve only the winner (changed payload=$different)', async ({ type, different }) => {
      const input = command(type);
      const changed = command(type, different ? raceChanges[type] : {});
      const db = await prepared(input);
      const commandsBefore = db.query('SELECT * FROM inventory_commands').length;
      const eventsBefore = db.query('SELECT * FROM inventory_events').length;
      const results = await race(db, input, changed);
      expect(results[0].status).toBe('fulfilled');
      if (results[0].status !== 'fulfilled') throw results[0].reason;
      const winner = results[0].value;
      expect(winner.replayed).toBe(false);
      expectEvidence(db, winner, input, 'race-key');
      if (different) expect(results[1]).toMatchObject({ status: 'rejected', reason: { name: 'LotCommandError', code: 'IDEMPOTENCY_CONFLICT' } });
      else expect(results[1]).toEqual({ status: 'fulfilled', value: { result: winner.result, replayed: true } });
      expect(db.query('SELECT * FROM inventory_commands')).toHaveLength(commandsBefore + 1);
      expect(db.query('SELECT * FROM inventory_events')).toHaveLength(eventsBefore + 1);
      await expectRejected(db, 'race-key', command(type, raceChanges[type]), 'IDEMPOTENCY_CONFLICT');
    },
  );

  it.each(types)('conflicts when two authorized actors race with identical %s payload and key', async (type) => {
    const input = command(type);
    const db = await prepared(input);
    const results = await race(db, input, input, member);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { name: 'LotCommandError', code: 'IDEMPOTENCY_CONFLICT' } });
    await expectRejected(db, 'race-key', input, 'IDEMPOTENCY_CONFLICT', member);
  });

  it.each(replayCases.filter(({ name }) => name.includes('no-op'))
    .flatMap((entry) => [false, true].map((different) => ({ ...entry, different }))))(
    '$name racers create one receipt and no event (changed payload=$different)', async ({ input, initial, different }) => {
      const db = await prepared(input, [], initial);
      const changed = different ? { ...input, ...raceChanges[input.type as CommandType],
        ...(input.type === 'OPEN' ? { openedAt: now } : {}) } : input;
      const before = stockBytes(db);
      const commandsBefore = db.query('SELECT * FROM inventory_commands').length;
      const results = await race(db, input, changed);
      expect(results[0].status).toBe('fulfilled');
      if (results[0].status !== 'fulfilled') throw results[0].reason;
      const winner = results[0].value;
      expect(winner.replayed).toBe(false);
      expect(winner.result.effects).toEqual([]);
      expectEvidence(db, winner, input, 'race-key');
      if (different) expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'IDEMPOTENCY_CONFLICT' } });
      else expect(results[1]).toEqual({ status: 'fulfilled', value: { result: winner.result, replayed: true } });
      expect(db.query('SELECT * FROM inventory_commands')).toHaveLength(commandsBefore + 1);
      expect(stockBytes(db)).toBe(before);
    },
  );
});

describe('T09D receipt tenancy and authorization', () => {
  it.each(types)('denies an authorized second actor replaying %s under the same key', async (type) => {
    const input = command(type);
    const db = await prepared(input);
    const first = await execute(db, 'actor-key', input);
    await expectRejected(db, 'actor-key', input, 'IDEMPOTENCY_CONFLICT', member);
    expectEvidence(db, first, input, 'actor-key');
    const before = stateBytes(db);
    expect(await execute(db, 'actor-key', input)).toEqual({ result: first.result, replayed: true });
    expect(stateBytes(db)).toBe(before);
  });

  it.each(types)('revoked membership denies %s replay without leaking or mutating its receipt', async (type) => {
    const input = command(type);
    const db = await prepared(input);
    const first = await execute(db, 'revoked-key', input);
    db.execute('DELETE FROM household_members WHERE household_id = ? AND user_id = ?', [scope.householdId, scope.actorId]);
    await expectRejected(db, 'revoked-key', input, 'FORBIDDEN');
    await expectRejected(db, 'revoked-key', command(type, raceChanges[type]), 'FORBIDDEN');
    expectEvidence(db, first, input, 'revoked-key');
  });

  it.each(types)('permits independent %s keys in two households without crossing evidence', async (type) => {
    const input = command(type);
    const other = command(type, { lotId: 'foreign-lot',
      ...(type === 'CREATE' ? { storageLocationId: 't09d-b-FRIDGE' }
        : type === 'MOVE' ? { storageLocationId: 't09d-b-FREEZER' } : {}) });
    const db = await prepared(input);
    if (type !== 'CREATE') await execute(db, 'seed-foreign', create({ lotId: 'foreign-lot', storageLocationId: 't09d-b-FRIDGE' }), foreign);
    const ready = createBarrier(2);
    db.hooks.beforeBatch = async (statements) => { if (isWrite(statements)) await ready.wait(); };
    const results = await Promise.all([execute(db, 'household-key', input), execute(db, 'household-key', other, foreign)]);
    db.hooks = {};
    expect(ready.arrivals).toBe(2);
    expect(results.map(({ replayed }) => replayed)).toEqual([false, false]);
    expect(results[0].result.commandId).not.toBe(results[1].result.commandId);
    expectEvidence(db, results[0], input, 'household-key');
    expectEvidence(db, results[1], other, 'household-key', foreign);
    const before = stateBytes(db);
    expect(await execute(db, 'household-key', input)).toEqual({ result: results[0].result, replayed: true });
    expect(await execute(db, 'household-key', other, foreign)).toEqual({ result: results[1].result, replayed: true });
    expect(stateBytes(db)).toBe(before);
    await expectRejected(db, 'household-key', input, 'FORBIDDEN', { ...scope, actorId: foreign.actorId });
  });
});

describe('T09D failures have no inventory, receipt or event authority', () => {
  it.each(types.flatMap((type) => ['receipt', 'projection', 'lot', 'event'].map((stage) => ({ type, stage }))))(
    '$type rolls back every earlier effect when its $stage write aborts', async ({ type, stage }) => {
      const input = command(type);
      const db = await prepared(input);
      const table = { receipt: 'inventory_commands', projection: 'inventory_items', lot: 'inventory_lots', event: 'inventory_events' }[stage]!;
      const operation = type === 'CREATE' || stage === 'receipt' || stage === 'event' ? 'INSERT' : 'UPDATE';
      db.seed(`CREATE TRIGGER t09d_abort BEFORE ${operation} ON ${table}
        ${stage === 'event' ? 'WHEN NEW.command_id IS NOT NULL' : ''}
        BEGIN SELECT RAISE(ABORT, 'Controlled authority failure'); END;`);
      await expectRejected(db, 'failed-key', input, 'PERSISTENCE_FAILED');
      db.seed('DROP TRIGGER t09d_abort');
      const retry = await execute(db, 'failed-key', input);
      expect(retry.replayed).toBe(false);
      expectEvidence(db, retry, input, 'failed-key');
    },
  );

  it.each(types)('%s cannot commit stock or a receipt when its event insert is suppressed', async (type) => {
    const input = command(type);
    const db = await prepared(input);
    db.seed(`CREATE TRIGGER t09d_ignore BEFORE INSERT ON inventory_events WHEN NEW.command_id IS NOT NULL
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expectRejected(db, 'suppressed-event', input, 'PERSISTENCE_FAILED');
  });

  it.each([
    { name: 'CREATE missing ingredient', input: create({ ingredientId: 'MISSING' }), code: 'INGREDIENT_NOT_FOUND' },
    { name: 'USE insufficient quantity', input: command('USE', { quantity: 5001 }), code: 'INSUFFICIENT_QUANTITY' },
    { name: 'DISCARD incompatible units', input: command('DISCARD', { unit: 'ml' }), code: 'INCOMPATIBLE_UNIT' },
    { name: 'OPEN stale version', input: command('OPEN', { expectedVersion: 2 }), code: 'STALE_VERSION' },
    { name: 'MOVE foreign destination', input: command('MOVE', { storageLocationId: 't09d-b-FREEZER' }), code: 'LOCATION_NOT_FOUND' },
    { name: 'CORRECT malformed evidence', input: correct({ expiryAt: '2026-09-15' }), code: 'INVALID_COMMAND' },
  ])('$name leaves all stock and evidence bytes unchanged', async ({ input, code }) => {
    const db = await prepared(input);
    await expectRejected(db, 'rejected-key', input, code);
    expect(db.query('SELECT * FROM inventory_commands WHERE client_key = ?', 'rejected-key')).toEqual([]);
  });
});

type StoredResult = InventoryLotCommandExecution['result'];
interface ReceiptCorruption {
  name: string;
  seed: (db: SqliteD1, commandId: string) => void;
}

function seedPastGuard(db: SqliteD1, trigger: string, seed: () => void): void {
  const definitions = db.query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", trigger);
  expect(definitions).toHaveLength(1);
  // Seed historical corruption, then restore immutability; normal inserts retain the 0025 guard.
  db.seed(`DROP TRIGGER ${trigger}`);
  try { seed(); } finally { db.seed(definitions[0].sql); }
}

function receiptColumn(name: string, assignment: string, values: unknown[]): ReceiptCorruption {
  return { name, seed: (db, commandId) => seedPastGuard(db, 'trg_inventory_commands_immutable_update', () => {
    expect(db.execute(`UPDATE inventory_commands SET ${assignment} WHERE id = ?`, [...values, commandId]).meta?.changes).toBe(1);
  }) };
}
function resultValue(name: string, replace: (result: StoredResult) => unknown): ReceiptCorruption {
  return { name: `result.${name}`, seed: (db, commandId) => {
    const row = db.query<{ result_json: string }>('SELECT result_json FROM inventory_commands WHERE id = ?', commandId)[0];
    receiptColumn(name, 'result_json = ?', [JSON.stringify(replace(JSON.parse(row.result_json)))])
      .seed(db, commandId);
  } };
}
function resultField(name: string, change: (result: StoredResult) => void): ReceiptCorruption {
  return resultValue(name, (result) => { change(result); return result; });
}
function eventColumn(name: string, assignment: string, values: unknown[]): ReceiptCorruption {
  return { name: `event.${name}`, seed: (db, commandId) => seedPastGuard(db, 'trg_inventory_events_command_update', () => {
    expect(db.execute(`UPDATE inventory_events SET ${assignment} WHERE command_id = ?`, [...values, commandId]).meta?.changes).toBe(1);
  }) };
}
function eventMetadataField(name: string, value: unknown): ReceiptCorruption {
  return { name: `event.metadata.${name}`, seed: (db, commandId) => {
    const row = db.query<{ metadata: string }>('SELECT metadata FROM inventory_events WHERE command_id = ?', commandId)[0];
    eventColumn(name, 'metadata = ?', [JSON.stringify({ ...JSON.parse(row.metadata), [name]: value })]).seed(db, commandId);
  } };
}

const receiptCorruptions: ReceiptCorruption[] = [
  resultValue('null', () => null),
  resultValue('emptyObject', () => ({})),
  resultValue('unknownPrivateField', (result) => ({ ...result, privateDiagnostic: 'private stored diagnostic' })),
  resultField('commandId', (result) => { result.commandId = 'unrelated-command'; }),
  resultField('lotId', (result) => { result.lotId = 'lot-b'; }),
  resultField('commandType', (result) => { result.commandType = 'DISCARD'; }),
  resultField('version.invalid', (result) => { result.version = 0; }),
  resultField('version.mismatched', (result) => { result.version += 1; }),
  resultField('before.missing', (result) => { result.effects[0].before = null; }),
  resultField('before.householdId', (result) => { result.effects[0].before!.householdId = foreign.householdId; }),
  resultField('before.version', (result) => { result.effects[0].before!.version += 1; }),
  resultField('after.householdId', (result) => { result.effects[0].after.householdId = foreign.householdId; }),
  resultField('after.id', (result) => { result.effects[0].after.id = 'lot-b'; }),
  resultField('after.version', (result) => { result.effects[0].after.version += 1; }),
  resultField('after.legacyVersion', (result) => { result.effects[0].after.legacyVersion! += 1; }),
  resultField('after.canonicalUnit', (result) => { result.effects[0].after.canonicalUnit = 'ml'; }),
  resultField('after.updatedAt', (result) => { result.effects[0].after.updatedAt = later; }),
  resultField('after.quantityMilli', (result) => { result.effects[0].after.quantityMilli += 1; }),
  resultField('deltaMilli', (result) => { result.effects[0].deltaMilli += 1; }),
  receiptColumn('receipt.actorId', 'actor_id = ?', [member.actorId]),
  receiptColumn('receipt.commandType', 'command_type = ?', ['DISCARD']),
  receiptColumn('receipt.createdAt', 'created_at = ?', [later]),
  { name: 'event.missing', seed: (db, commandId) => seedPastGuard(db, 'trg_inventory_events_command_delete', () => {
    expect(db.execute('DELETE FROM inventory_events WHERE command_id = ?', [commandId]).meta?.changes).toBe(1);
  }) },
  eventColumn('householdId', 'household_id = ?', [foreign.householdId]),
  eventColumn('inventoryItemId', 'inventory_item_id = ?', ['lot-b']),
  eventColumn('eventType', 'event_type = ?', ['DISCARD']),
  eventColumn('quantityDelta', 'quantity_delta = quantity_delta + 1', []),
  eventColumn('unit', 'unit = ?', ['ml']),
  eventColumn('reason', 'reason = ?', ['private mismatched reason']),
  eventColumn('createdAt', 'created_at = ?', [later]),
  eventColumn('metadata.null', 'metadata = ?', ['null']),
  eventColumn('metadata.emptyObject', 'metadata = ?', ['{}']),
  eventColumn('metadata.invalidJson', 'metadata = ?', ['{private malformed evidence']),
  eventMetadataField('actorId', member.actorId),
  eventMetadataField('commandId', 'unrelated-command'),
  eventMetadataField('clientKey', 'unrelated-key'),
  eventMetadataField('fingerprint', 'private mismatched fingerprint'),
  eventMetadataField('allocation', [{ lotId: 'lot-b', deltaMilli: -2000, canonicalUnit: 'g' }]),
];

function corruptRetainedReceipt(db: SqliteD1, corruption: ReceiptCorruption, commandId: string): string {
  const fingerprint = db.query('SELECT fingerprint FROM inventory_commands WHERE id = ?', commandId);
  corruption.seed(db, commandId);
  expect(db.query('SELECT fingerprint FROM inventory_commands WHERE id = ?', commandId)).toEqual(fingerprint);
  return stateBytes(db);
}
const corruptError = { name: 'LotCommandError', code: 'CORRUPT_RECEIPT', message: 'CORRUPT_RECEIPT' };

describe('T09D corrupted persisted receipt authority', () => {
  it.each(['USE', 'DISCARD'] as const)('rejects paired %s receipt/event corruption that contradicts original quantity intent', async (type) => {
    const input = command(type);
    const db = await prepared(input);
    const first = await execute(db, 'paired-corruption', input);
    resultField('pairedQuantity', (result) => {
      result.effects[0].after.quantityMilli -= 1000;
      result.effects[0].deltaMilli -= 1000;
    }).seed(db, first.result.commandId);
    const receipt = db.query<{ result_json: string }>('SELECT result_json FROM inventory_commands WHERE id = ?', first.result.commandId)[0];
    const effect = (JSON.parse(receipt.result_json) as StoredResult).effects[0];
    const event = db.query<{ metadata: string }>('SELECT metadata FROM inventory_events WHERE command_id = ?', first.result.commandId)[0];
    const metadata = JSON.parse(event.metadata);
    metadata.after = effect.after;
    metadata.deltaMilli = effect.deltaMilli;
    metadata.allocation[0].deltaMilli = effect.deltaMilli;
    eventColumn('pairedQuantity', 'quantity_delta = ?, metadata = ?', [effect.deltaMilli / 1000, JSON.stringify(metadata)])
      .seed(db, first.result.commandId);
    const corruptedBefore = stateBytes(db);
    await expect(execute(db, 'paired-corruption', input)).rejects.toMatchObject(corruptError);
    expect(stateBytes(db)).toBe(corruptedBefore);
  });

  it.each(receiptCorruptions)('initial replay sanitizes $name despite later real stock changes', async (corruption) => {
    const input = command('USE');
    const db = await prepared(input);
    const first = await execute(db, 'corrupt-key', input);
    await execute(db, 'later-stock-change', command('USE', { expectedVersion: 2 }), scope, later);
    const validBefore = stateBytes(db);
    expect(await execute(db, 'corrupt-key', input, scope, later)).toEqual({ result: first.result, replayed: true });
    expect(stateBytes(db)).toBe(validBefore);
    const corruptedBefore = corruptRetainedReceipt(db, corruption, first.result.commandId);
    await expect(execute(db, 'corrupt-key', input, scope, later)).rejects.toMatchObject(corruptError);
    expect(stateBytes(db)).toBe(corruptedBefore);
    expect(db.query('SELECT quantity_milli, version FROM inventory_lots WHERE id = ?', 'lot-a'))
      .toEqual([{ quantity_milli: 4_996_000, version: 3 }]);
  });

  it.each(receiptCorruptions)('write-collision recovery sanitizes $name without overwriting the competing receipt', async (corruption) => {
    const input = command('USE');
    const db = await prepared(input);
    let injected = false;
    let writeAttempts = 0;
    let receiptReads = 0;
    let corruptedBefore: string | undefined;
    db.hooks.beforeBatch = async (statements) => {
      if (statements.some(({ sql }) => sql.startsWith('SELECT fingerprint'))) receiptReads += 1;
      if (!isWrite(statements)) return;
      writeAttempts += 1;
      if (injected) return;
      injected = true;
      const winner = await execute(db, 'corrupt-key', input);
      expect(winner.replayed).toBe(false);
      corruptedBefore = corruptRetainedReceipt(db, corruption, winner.result.commandId);
    };
    await expect(execute(db, 'corrupt-key', input)).rejects.toMatchObject(corruptError);
    db.hooks = {};
    expect(writeAttempts).toBe(2);
    expect(receiptReads).toBe(3);
    expect(corruptedBefore).toBeDefined();
    expect(stateBytes(db)).toBe(corruptedBefore);
    expect(db.query('SELECT quantity_milli, version FROM inventory_lots WHERE id = ?', 'lot-a'))
      .toEqual([{ quantity_milli: 4_998_000, version: 2 }]);
  });

  it.each(receiptCorruptions)('response-loss recovery sanitizes $name without a second stock effect', async (corruption) => {
    const input = command('USE');
    const db = await prepared(input);
    let writing = false;
    let commits = 0;
    let receiptReads = 0;
    let corruptedBefore: string | undefined;
    db.hooks.beforeBatch = (statements) => {
      writing = isWrite(statements);
      if (statements.some(({ sql }) => sql.startsWith('SELECT fingerprint'))) receiptReads += 1;
    };
    db.hooks.afterBatch = () => {
      if (!writing) return;
      writing = false;
      commits += 1;
      const receipt = db.query<{ id: string }>('SELECT id FROM inventory_commands WHERE client_key = ?', 'corrupt-key');
      expect(receipt).toHaveLength(1);
      corruptedBefore = corruptRetainedReceipt(db, corruption, receipt[0].id);
      throw new Error('Private transport diagnostic after committed response loss');
    };
    await expect(execute(db, 'corrupt-key', input)).rejects.toMatchObject(corruptError);
    db.hooks = {};
    expect(commits).toBe(1);
    expect(receiptReads).toBe(2);
    expect(corruptedBefore).toBeDefined();
    expect(stateBytes(db)).toBe(corruptedBefore);
    expect(db.query('SELECT quantity_milli, version FROM inventory_lots WHERE id = ?', 'lot-a'))
      .toEqual([{ quantity_milli: 4_998_000, version: 2 }]);
  });
});
