import { afterEach, describe, expect, it } from 'vitest';
import {
  executeInventoryLotCommand, readMappedLotSnapshot,
  type InventoryLotCommandExecution, type InventoryLotCommandScope,
} from '../../packages/db/src/inventory-lot-commands';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import { InventoryLotCommandSchema, LotCommandError } from '../../packages/domain/src/inventory-lot-commands';
import { toLotQuantity } from '../../packages/domain/src/inventory-truth';
import { createBarrier, SqliteD1, type SqliteStatementEvent } from '../helpers/sqlite-d1';

const scope = { householdId: 't09-a', actorId: 't09-user-a' };
const foreign = { householdId: 't09-b', actorId: 't09-user-b' };
const now = '2026-09-10T10:00:00Z';
const later = '2026-09-11T10:00:00Z';
const databases: SqliteD1[] = [];
function database(): SqliteD1 {
  const db = new SqliteD1();
  databases.push(db);
  db.seed(`INSERT INTO users(id) VALUES ('t09-user-a'), ('t09-user-b'), ('t09-user-member'), ('t09-outsider');
    INSERT INTO households(id, name, created_by) VALUES ('t09-a', 'A', 't09-user-a'), ('t09-b', 'B', 't09-user-b');
    INSERT INTO household_members(id, household_id, user_id, role) VALUES
      ('t09-member-a', 't09-a', 't09-user-a', 'owner'), ('t09-member-b', 't09-b', 't09-user-b', 'owner'),
      ('t09-member-second', 't09-a', 't09-user-member', 'member');`);
  for (const household of [scope.householdId, foreign.householdId]) {
    for (const [index, type] of ['FRIDGE', 'FREEZER', 'PANTRY'].entries()) {
      db.execute(`INSERT INTO storage_locations(id, household_id, type, name, sort_order, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`, [`${household}-${type}`, household, type, type, index, now, now]);
    }
  }
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const create = (patch: Record<string, unknown> = {}) => ({
  type: 'CREATE', lotId: 'lot-a', ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 10,
  unit: 'piece', storageLocationId: 't09-a-FRIDGE', sourceType: 'MANUAL', ...patch,
});
const use = (patch: Record<string, unknown> = {}) => ({
  type: 'USE', lotId: 'lot-a', expectedVersion: 1, quantity: 2, unit: 'piece', ...patch,
});
const correct = (changes: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({
  type: 'CORRECT', lotId: 'lot-a', expectedVersion: 1, changes, reason: 'Counted again', ...patch,
});
const execute = (db: SqliteD1, key: string, input: unknown, timestamp = now, owner = scope) =>
  executeInventoryLotCommand(db, owner, key, input, timestamp);
const isWrite = (statements: readonly SqliteStatementEvent[]) => statements.some(({ sql }) => /^INSERT INTO inventory_commands/.test(sql));
function facts(db: SqliteD1) {
  return Object.fromEntries(['households', 'inventory_lots', 'inventory_items', 'inventory_commands', 'inventory_events']
    .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY id`)]));
}
async function expectFailure(db: SqliteD1, input: unknown, code: string, key = 'failed'): Promise<void> {
  const before = facts(db);
  await expect(execute(db, key, input)).rejects.toMatchObject({ name: 'LotCommandError', code });
  expect(facts(db)).toEqual(before);
}
async function expectCommitted(db: SqliteD1, execution: InventoryLotCommandExecution, key: string) {
  const { result } = execution;
  expect(execution.replayed).toBe(false);
  expect(result.effects).toHaveLength(1);
  const effect = result.effects[0];
  const snapshot = await readMappedLotSnapshot(db, scope);
  const mapped = snapshot.lots.find(({ lot }) => lot.id === result.lotId)!;
  const row = snapshot.legacyRows.find((row) => row.id === result.lotId)!;
  expect(mapped).toEqual({ lot: effect.after, legacyItemId: result.lotId });
  expect(row).toMatchObject({ household_id: scope.householdId, name: effect.after.rawName,
    ingredient_id: effect.after.ingredientId, unit: effect.after.canonicalUnit, version: effect.after.legacyVersion,
    opened_at: effect.after.openedAt, updated_at: effect.after.updatedAt });
  expect(toLotQuantity(row.quantity, row.unit)).toEqual({ quantityMilli: effect.after.quantityMilli, canonicalUnit: effect.after.canonicalUnit });
  expect(row.storage).toBe(snapshot.locations.find(({ id }) => id === effect.after.storageLocationId)!.type.toLowerCase());
  const events = db.query<{ metadata: string; quantity_delta: number; unit: string; inventory_item_id: string }>(
    'SELECT * FROM inventory_events WHERE command_id = ?', result.commandId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ quantity_delta: effect.deltaMilli / 1000, unit: effect.after.canonicalUnit, inventory_item_id: result.lotId });
  const receipt = db.query<{ result_json: string; fingerprint: string }>('SELECT * FROM inventory_commands WHERE id = ?', result.commandId)[0];
  expect(JSON.parse(receipt.result_json)).toEqual(result);
  expect(JSON.parse(events[0].metadata)).toEqual({
    schemaVersion: 1, householdId: scope.householdId, actorId: scope.actorId, commandId: result.commandId,
    commandType: result.commandType, before: effect.before, after: effect.after, deltaMilli: effect.deltaMilli,
    source: { type: effect.after.sourceType, id: effect.after.sourceId }, timestamp: effect.after.updatedAt,
    clientKey: key, fingerprint: receipt.fingerprint,
    allocation: [{ lotId: result.lotId, deltaMilli: effect.deltaMilli, canonicalUnit: effect.after.canonicalUnit }],
  });
  expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
}

describe('T09C atomic native single-lot effects', () => {
  it.each([false, true])('rejects mixed unrepresented legacy stock before native activation (existing native=%s)', async (existing) => {
    const db = database();
    if (existing) await execute(db, 'native-first', create());
    db.execute(`INSERT INTO inventory_items(id,household_id,name,quantity,unit)
      VALUES ('unrepresented',?,'Older eggs',1,'piece')`, [scope.householdId]);
    await expectFailure(db, existing ? use() : create(), 'ADOPTION_REQUIRED');
  });

  it('commits CREATE, USE, DISCARD, OPEN, MOVE and CORRECT with exact result/event/projection parity', async () => {
    const db = database();
    const inputs = [create(), use(), use({ type: 'DISCARD', expectedVersion: 2, quantity: 1 }),
      { type: 'OPEN', lotId: 'lot-a', expectedVersion: 3, openedAt: now },
      { type: 'MOVE', lotId: 'lot-a', expectedVersion: 4, storageLocationId: 't09-a-FREEZER' },
      correct({ quantity: 9, rawName: 'Counted eggs', purchasedAt: '2026-09-09',
        purchasePrice: { currency: 'USD', amountMinor: 299, minorDigits: 2 } }, { expectedVersion: 5 }),
    ];
    for (const [index, input] of inputs.entries()) {
      const result = await execute(db, `command-${index}`, input);
      await expectCommitted(db, result, `command-${index}`);
      expect(result.result.effects[0].after.version).toBe(index + 1);
      expect(result.result.effects[0].after.legacyVersion).toBe(index + 1);
    }
    expect(db.query('SELECT source_type, source_id, legacy_expiry_at, legacy_expiry_kind, legacy_expiry_source, legacy_opened_at FROM inventory_lots'))
      .toEqual([{ source_type: 'MANUAL', source_id: null, legacy_expiry_at: null, legacy_expiry_kind: null,
        legacy_expiry_source: null, legacy_opened_at: null }]);
    expect(db.query("SELECT category, data_source FROM inventory_items WHERE id = 'lot-a'"))
      .toEqual([{ category: 'egg', data_source: 'manual' }]);
  });

  it.each([
    ['UNKNOWN', null, null, 'unknown', 'unknown'], ['KNOWN', '2026-09-15', null, 'unknown', 'unknown'],
    ['BEST_BEFORE', '2026-09-15', null, 'best_before', 'user'], ['USE_BY', '2026-09-15', null, 'use_by', 'user'],
    ['ESTIMATED', null, '2026-09-15', 'estimated', 'estimated'],
  ])('preserves %s certainty through CREATE and USE', async (expiryKind, expiryAt, estimatedExpiryAt, kind, source) => {
    const db = database();
    await expectCommitted(db, await execute(db, 'create', create({ expiryKind, expiryAt, estimatedExpiryAt })), 'create');
    await expectCommitted(db, await execute(db, 'use', use()), 'use');
    expect(db.query("SELECT expiry_date, expiry_kind, expiry_source FROM inventory_items WHERE id = 'lot-a'"))
      .toEqual([{ expiry_date: expiryAt ?? estimatedExpiryAt, expiry_kind: kind, expiry_source: source }]);
  });

  it.each([['MANUAL', null, 'manual'], ['SCAN', 'scan-a', 'scan'], ['RECEIPT', 'receipt-a', 'scan'], ['SHOPPING', 'shopping-a', 'shopping']])(
    'keeps explicit %s provenance and never fabricates price', async (sourceType, sourceId, dataSource) => {
      const db = database();
      const result = await execute(db, 'create', create({ sourceType, sourceId, ingredientId: null, rawName: 'Unmapped label' }));
      await expectCommitted(db, result, 'create');
      expect(result.result.effects[0].after).toMatchObject({ sourceType, sourceId, purchasePrice: null, purchasedAt: null });
      expect(db.query("SELECT category, data_source FROM inventory_items WHERE id = 'lot-a'"))
        .toEqual([{ category: 'other', data_source: dataSource }]);
    },
  );

  it.each([[0.001, 'g', 1, 'g'], [0.2, 'kg', 200000, 'g'], [1.25, 'l', 1250000, 'ml'],
    [0.3, 'piece', 300, 'piece'], [1, 'pack', 1000, 'pack'], [1.5, 'bunch', 1500, 'bunch'], [0.5, 'slice', 500, 'slice']])(
    'stores canonical and legacy quantities exactly for %s %s', async (quantity, unit, quantityMilli, canonicalUnit) => {
      const db = database();
      const result = await execute(db, 'create', create({ quantity, unit }));
      await expectCommitted(db, result, 'create');
      expect(result.result.effects[0].after).toMatchObject({ quantityMilli, canonicalUnit });
    },
  );

  it.each(['USE', 'DISCARD'])('retains zero %s terminal history and permits only explicit correction revival', async (type) => {
    const db = database();
    await execute(db, 'create', create());
    const terminal = await execute(db, 'terminal', use({ type, quantity: 10 }));
    await expectCommitted(db, terminal, 'terminal');
    expect(terminal.result.effects[0].after).toMatchObject({ quantityMilli: 0, state: type === 'USE' ? 'CONSUMED' : 'DISCARDED' });
    expect(db.query("SELECT freshness FROM inventory_items WHERE id = 'lot-a'"))
      .toEqual([{ freshness: 'out_of_stock' }]);
    await expectFailure(db, use({ expectedVersion: 2 }), 'LOT_NOT_ACTIVE');
    await expectFailure(db, correct({ quantity: 1 }, { expectedVersion: 2 }), 'REVIVE_REQUIRED');
    const revived = await execute(db, 'revive', correct({ quantity: 1 }, { expectedVersion: 2, revive: true }));
    await expectCommitted(db, revived, 'revive');
    expect(revived.result.effects[0].after).toMatchObject({ state: 'ACTIVE', quantityMilli: 1000, version: 3 });
    expect(db.query("SELECT freshness FROM inventory_items WHERE id = 'lot-a'"))
      .toEqual([{ freshness: 'fresh' }]);
  });

  it('records an explicit terminal correction with negative event delta', async () => {
    const db = database();
    await execute(db, 'create', create());
    const result = await execute(db, 'zero', correct({ quantity: 0 }, { terminalState: 'DISCARDED' }));
    await expectCommitted(db, result, 'zero');
    expect(result.result.effects[0]).toMatchObject({ deltaMilli: -10000, after: { state: 'DISCARDED', quantityMilli: 0 } });
    expect(db.query("SELECT freshness FROM inventory_items WHERE id = 'lot-a'"))
      .toEqual([{ freshness: 'out_of_stock' }]);
  });

  it.each([
    use(),
    use({ type: 'DISCARD' }),
    { type: 'OPEN', lotId: 'lot-a', expectedVersion: 1, openedAt: now },
    { type: 'MOVE', lotId: 'lot-a', expectedVersion: 1, storageLocationId: 't09-a-FREEZER' },
    correct({ rawName: 'Reviewed eggs' }),
  ])('preserves legacy freshness on a nonterminal unchanged-expiry command: $type', async (command) => {
    const db = database();
    await execute(db, 'create', create({ expiryKind: 'BEST_BEFORE', expiryAt: '2026-09-13' }));
    const before = db.query("SELECT freshness FROM inventory_items WHERE id = 'lot-a'");
    await execute(db, 'change', command, '2026-09-20T00:00:00Z');
    expect(db.query("SELECT freshness FROM inventory_items WHERE id = 'lot-a'")).toEqual(before);
  });

  it('persists deterministic OPEN, MOVE and CORRECT no-op receipts without effect/version/event writes', async () => {
    const db = database();
    await execute(db, 'create', create({ openedAt: now }));
    const snapshot = await readMappedLotSnapshot(db, scope);
    const events = db.query('SELECT * FROM inventory_events');
    const inputs = [{ type: 'OPEN', lotId: 'lot-a', expectedVersion: 1, openedAt: later },
      { type: 'MOVE', lotId: 'lot-a', expectedVersion: 1, storageLocationId: 't09-a-FRIDGE' }, correct({ quantity: 10 })];
    for (const [index, input] of inputs.entries()) {
      const result = await execute(db, `noop-${index}`, input, later);
      expect(result.result).toMatchObject({ version: 1, effects: [] });
      expect(await execute(db, `noop-${index}`, input, '2026-09-20T00:00:00Z')).toEqual({ result: result.result, replayed: true });
    }
    expect(await readMappedLotSnapshot(db, scope)).toEqual(snapshot);
    expect(db.query('SELECT * FROM inventory_events')).toEqual(events);
    expect(db.query("SELECT * FROM inventory_commands WHERE household_id = 't09-a'")).toHaveLength(4);
  });

  it('preserves raw historical unknown expiry/opened evidence until explicitly corrected', async () => {
    const db = database();
    await execute(db, 'create', create());
    db.seed(`UPDATE inventory_lots SET legacy_expiry_at = 'old raw date', legacy_expiry_kind = 'unknown',
      legacy_expiry_source = 'unknown', legacy_opened_at = 'old raw opened', version = version + 1 WHERE id = 'lot-a';
      UPDATE inventory_items SET expiry_date = 'old raw date', opened_at = 'old raw opened' WHERE id = 'lot-a';`);
    const raw = db.query('SELECT legacy_expiry_at, legacy_expiry_kind, legacy_expiry_source, legacy_opened_at FROM inventory_lots');
    await execute(db, 'use', use({ expectedVersion: 2 }));
    expect(db.query("SELECT expiry_date, opened_at, expiry_kind, expiry_source FROM inventory_items WHERE id = 'lot-a'"))
      .toEqual([{ expiry_date: 'old raw date', opened_at: 'old raw opened', expiry_kind: 'unknown', expiry_source: 'unknown' }]);
    await execute(db, 'correct', correct({ expiryAt: '2026-09-12', expiryKind: 'KNOWN', openedAt: now }, { expectedVersion: 3 }));
    expect(db.query("SELECT expiry_date, opened_at, expiry_kind, expiry_source FROM inventory_items WHERE id = 'lot-a'"))
      .toEqual([{ expiry_date: '2026-09-12', opened_at: now, expiry_kind: 'unknown', expiry_source: 'unknown' }]);
    expect(db.query('SELECT legacy_expiry_at, legacy_expiry_kind, legacy_expiry_source, legacy_opened_at FROM inventory_lots')).toEqual(raw);
  });
});

describe('T09C validation, access and drift rejection', () => {
  it.each([
    [create({ quantity: 0 }), 'INVALID_COMMAND'], [create({ quantity: 0.0001 }), 'UNREPRESENTABLE_QUANTITY'],
    [create({ sourceType: 'SCAN' }), 'INVALID_COMMAND'], [create({ sourceId: ' ' }), 'INVALID_COMMAND'],
    [create({ ingredientId: null, rawName: ' \t\n' }), 'INVALID_COMMAND'], [create({ ingredientId: 'MISSING' }), 'INGREDIENT_NOT_FOUND'],
    [create({ storageLocationId: 't09-b-FRIDGE' }), 'LOCATION_NOT_FOUND'], [create({ storageLocationId: 'missing' }), 'LOCATION_NOT_FOUND'],
    [create({ expiryAt: '2026-02-30', expiryKind: 'KNOWN' }), 'INVALID_COMMAND'],
    [create({ expiryKind: 'BEST_BEFORE' }), 'INVALID_COMMAND'],
    [create({ purchasePrice: { currency: 'USD', amountMinor: 1, minorDigits: 0 } }), 'INVALID_COMMAND'],
    [create({ openedAt: '2026-02-30T00:00:00Z' }), 'INVALID_COMMAND'],
    [create({ householdId: 't09-b' }), 'INVALID_COMMAND'], [create({ actorId: 't09-user-b' }), 'INVALID_COMMAND'],
  ])('rejects invalid CREATE without success effects %#', async (command, code) => {
    await expectFailure(database(), command, code);
  });

  it.each([
    [use({ expectedVersion: 2 }), 'STALE_VERSION'], [use({ quantity: 11 }), 'INSUFFICIENT_QUANTITY'],
    [use({ quantity: 0.0001 }), 'UNREPRESENTABLE_QUANTITY'], [use({ unit: 'g' }), 'INCOMPATIBLE_UNIT'],
    [use({ lotId: 'missing' }), 'LOT_NOT_FOUND'], [correct({ quantity: 0 }), 'INVALID_COMMAND'],
    [correct({ quantity: 5 }, { reason: ' ' }), 'INVALID_COMMAND'], [correct({ ingredientId: 'MISSING' }), 'INGREDIENT_NOT_FOUND'],
    [{ type: 'MOVE', lotId: 'lot-a', expectedVersion: 1, storageLocationId: 't09-b-FRIDGE' }, 'LOCATION_NOT_FOUND'],
    [correct({ sourceId: 'spoof' }), 'INVALID_COMMAND'], [correct({ sourceType: 'SCAN' }), 'INVALID_COMMAND'],
  ])('rejects invalid mutation without success effects %#', async (command, code) => {
    const db = database();
    await execute(db, 'create', create());
    await expectFailure(db, command, code);
  });

  it.each(['', ' ', 'x'.repeat(201), 'bad\0key'])('rejects invalid client key %j', async (key) => {
    await expectFailure(database(), create(), 'INVALID_COMMAND', key);
  });

  it('rejects a milli-exact domain result when the legacy number would lose one milli-unit', async () => {
    const db = database();
    await execute(db, 'create', create({ quantity: 9007199254740.99, unit: 'g' }));
    // 9007199254740990 - 1 fits the lot integer, but division by 1000 loses precision.
    await expectFailure(db, use({ quantity: 0.001, unit: 'g' }), 'UNREPRESENTABLE_QUANTITY');
  });

  it.each([
    { householdId: 't09-a', actorId: 't09-outsider' }, { householdId: 't09-a', actorId: 'missing-user' },
    { householdId: 't09-a', actorId: 't09-user-b' }, { householdId: 't09-b', actorId: 't09-user-a' },
    { householdId: 'missing-household', actorId: 't09-user-a' },
  ])('authorizes real membership before malformed input or replay for %j', async (owner) => {
    const db = database();
    await execute(db, 'create', create());
    const before = facts(db);
    await expect(execute(db, 'create', create(), now, owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(execute(db, '', { malformed: true }, now, owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(readMappedLotSnapshot(db, owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(facts(db)).toEqual(before);
  });

  it('permits real members but binds receipts to the original actor', async () => {
    const db = database();
    await execute(db, 'create', create());
    const member = { ...scope, actorId: 't09-user-member' };
    await expect(execute(db, 'create', create(), now, member)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await execute(db, 'use-member', use(), now, member);
    expect(db.query("SELECT actor_id FROM inventory_commands WHERE client_key = 'use-member'"))
      .toEqual([{ actor_id: member.actorId }]);
  });

  it('does not expose or mutate a foreign lot and keeps household client-key namespaces independent', async () => {
    const db = database();
    await execute(db, 'create', create());
    await execute(db, 'create', create({ lotId: 'lot-b', storageLocationId: 't09-b-FRIDGE' }), now, foreign);
    const before = facts(db);
    await expect(execute(db, 'foreign-use', use({ lotId: 'lot-b' }))).rejects.toMatchObject({ code: 'LOT_NOT_FOUND' });
    expect(facts(db)).toEqual(before);
    const snapshot = await readMappedLotSnapshot(db, scope);
    expect(snapshot.lots.map(({ lot }) => lot.id)).toEqual(['lot-a']);
    expect(snapshot.legacyRows.map(({ id }) => id)).toEqual(['lot-a']);
    expect(snapshot.locations.every(({ householdId }) => householdId === scope.householdId)).toBe(true);
  });

  it('does not replace a foreign global ID or leak its existing record on CREATE conflict', async () => {
    const db = database();
    await execute(db, 'create-foreign', create({ storageLocationId: 't09-b-FRIDGE', rawName: 'Private foreign label' }), now, foreign);
    await expectFailure(db, create(), 'PERSISTENCE_FAILED');
  });

  it('requires explicit adoption of a T08 snapshot and never refreshes/backfills implicitly', async () => {
    const db = database();
    db.seed(`INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit)
      VALUES ('old-item', 't09-a', 'CHICKEN_EGG', 'Old eggs', 10, 'piece');`);
    await backfillLegacyInventory(db, scope.householdId);
    await expectFailure(db, use({ lotId: 't08-legacy:old-item' }), 'ADOPTION_REQUIRED');
    await expectFailure(db, use({ lotId: 'old-item' }), 'ADOPTION_REQUIRED');
    await expectFailure(db, create({ lotId: 'old-item' }), 'ADOPTION_REQUIRED');
  });

  it.each([
    "name = 'Drift'", "ingredient_id = 'RICE'", 'quantity = 9', 'quantity = 10.0001',
    "unit = 'pack'", "unit = 'kg', quantity = 0.01", "storage = 'freezer'", 'version = 2',
    "opened_at = '2026-09-10T00:00:00Z'", "expiry_date = '2026-09-12'",
    "expiry_date = '2026-09-12', expiry_kind = 'use_by', expiry_source = 'user'",
  ])('refuses pre-existing projection drift without repair: %s', async (change) => {
    const db = database();
    await execute(db, 'create', create());
    db.seed(`UPDATE inventory_items SET ${change} WHERE id = 'lot-a'`);
    await expectFailure(db, use(), 'DRIFT_DETECTED');
  });

  it('rejects projection revision overflow instead of committing an unsafe version', async () => {
    const db = database();
    await execute(db, 'create', create());
    db.seed(`UPDATE inventory_items SET version = 9007199254740991 WHERE id = 'lot-a';
      UPDATE inventory_lots SET legacy_version = 9007199254740991, version = version + 1 WHERE id = 'lot-a';`);
    await expectFailure(db, use({ expectedVersion: 2 }), 'VERSION_OVERFLOW');
  });
});

describe('T09C exact idempotency and failure rollback', () => {
  it('returns the stored exact logical result after later mutations and ignores the server retry time', async () => {
    const db = database();
    const created = await execute(db, 'create', create());
    const used = await execute(db, 'use', use());
    await execute(db, 'use-again', use({ expectedVersion: 2 }), later);
    const before = facts(db);
    expect(await execute(db, 'create', create(), later)).toEqual({ result: created.result, replayed: true });
    expect(await execute(db, 'use', use(), later)).toEqual({ result: used.result, replayed: true });
    expect(facts(db)).toEqual(before);
  });

  it('normalizes object ordering/defaults while retaining every validated intent field', async () => {
    const db = database();
    const result = await execute(db, 'create', create());
    const normalized = InventoryLotCommandSchema.parse(create());
    const reversed = Object.fromEntries(Object.entries(normalized).reverse());
    expect(await execute(db, 'create', reversed)).toEqual({ result: result.result, replayed: true });
    const receipt = db.query<{ fingerprint: string }>("SELECT fingerprint FROM inventory_commands WHERE client_key = 'create'")[0];
    expect(JSON.parse(receipt.fingerprint)).toEqual({ ...scope, command: normalized });
  });

  it.each([
    { lotId: 'other-lot' }, { ingredientId: 'RICE' }, { rawName: ' Eggs ' }, { quantity: 11 }, { unit: 'pack' },
    { storageLocationId: 't09-a-PANTRY' }, { expiryKind: 'KNOWN', expiryAt: '2026-09-15' },
    { expiryKind: 'BEST_BEFORE', expiryAt: '2026-09-15' }, { expiryKind: 'ESTIMATED', estimatedExpiryAt: '2026-09-15' },
    { purchasedAt: '2026-09-09' }, { openedAt: now }, { purchasePrice: { currency: 'USD', amountMinor: 299, minorDigits: 2 } },
    { sourceType: 'SCAN', sourceId: 'scan-a' }, { sourceId: 'manual-reference' },
  ])('fingerprints every CREATE field: %j', async (patch) => {
    const db = database();
    await execute(db, 'create', create());
    await expectFailure(db, create(patch), 'IDEMPOTENCY_CONFLICT', 'create');
  });

  it.each([{ type: 'DISCARD' }, { lotId: 'other' }, { expectedVersion: 2 }, { quantity: 3 }, { unit: 'pack' }, { reason: 'Different reason' }])(
    'fingerprints every decrement field: %j', async (patch) => {
      const db = database();
      await execute(db, 'create', create());
      await execute(db, 'use', use());
      await expectFailure(db, use(patch), 'IDEMPOTENCY_CONFLICT', 'use');
    },
  );

  it.each([
    [{ quantity: 8 }, {}], [{ unit: 'piece', rawName: 'Fixed' }, {}], [{ rawName: 'Other' }, {}],
    [{ rawName: 'Fixed', ingredientId: null }, {}], [{ rawName: 'Fixed', purchasedAt: '2026-09-01' }, {}],
    [{ rawName: 'Fixed', openedAt: now }, {}], [{ rawName: 'Fixed', expiryKind: 'KNOWN', expiryAt: '2026-09-15' }, {}],
    [{ rawName: 'Fixed', expiryKind: 'ESTIMATED', estimatedExpiryAt: '2026-09-15' }, {}],
    [{ rawName: 'Fixed', purchasePrice: { currency: 'USD', amountMinor: 300, minorDigits: 2 } }, {}],
    [{ rawName: 'Fixed' }, { reason: 'Other explanation' }], [{ quantity: 1 }, { revive: true }],
    [{ quantity: 0 }, { terminalState: 'CONSUMED' }],
  ])('fingerprints bounded correction intent %#', async (changes, patch) => {
    const db = database();
    await execute(db, 'create', create());
    await execute(db, 'correct', correct({ rawName: 'Fixed' }));
    await expectFailure(db, correct(changes, patch), 'IDEMPOTENCY_CONFLICT', 'correct');
  });

  it('fingerprints OPEN timestamps and MOVE target even when the second intent would be a no-op', async () => {
    const db = database();
    await execute(db, 'create', create());
    const open = { type: 'OPEN', lotId: 'lot-a', expectedVersion: 1, openedAt: now };
    await execute(db, 'open', open);
    await expectFailure(db, { ...open, openedAt: later }, 'IDEMPOTENCY_CONFLICT', 'open');
    const move = { type: 'MOVE', lotId: 'lot-a', expectedVersion: 2, storageLocationId: 't09-a-PANTRY' };
    await execute(db, 'move', move);
    await expectFailure(db, { ...move, storageLocationId: 't09-a-FREEZER' }, 'IDEMPOTENCY_CONFLICT', 'move');
  });

  it.each(['inventory_items', 'inventory_lots', 'inventory_events'])('rolls back receipt and all earlier writes on late %s failure', async (table) => {
    const db = database();
    await execute(db, 'create', create());
    db.seed(`CREATE TRIGGER t09_fail BEFORE ${table === 'inventory_events' ? 'INSERT' : 'UPDATE'} ON ${table}
      ${table === 'inventory_events' ? 'WHEN NEW.command_id IS NOT NULL' : ''}
      BEGIN SELECT RAISE(ABORT, 'controlled private failure detail'); END;`);
    await expectFailure(db, use(), 'PERSISTENCE_FAILED');
  });

  it.each(['inventory_items', 'inventory_lots'])('rolls back CREATE if %s insertion fails', async (table) => {
    const db = database();
    db.seed(`CREATE TRIGGER t09_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'controlled failure'); END;`);
    await expectFailure(db, create(), 'PERSISTENCE_FAILED');
  });

  it.each(['inventory_items', 'inventory_lots'])('aborts a zero-row %s CAS inside the batch', async (table) => {
    const db = database();
    await execute(db, 'create', create());
    db.seed(`CREATE TRIGGER t09_ignore BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END;`);
    await expectFailure(db, use(), 'STALE_VERSION');
  });

  it('rolls back all effects when an event insert is suppressed rather than thrown', async () => {
    const db = database();
    await execute(db, 'create', create());
    db.seed(`CREATE TRIGGER t09_ignore BEFORE INSERT ON inventory_events WHEN NEW.command_id IS NOT NULL
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expectFailure(db, use(), 'PERSISTENCE_FAILED');
  });

  it.each([false, true])('never reports success without a durable receipt (no-op=%s)', async (noop) => {
    const db = database();
    await execute(db, 'create', create({ openedAt: now }));
    db.seed(`CREATE TRIGGER t09_ignore BEFORE INSERT ON inventory_commands
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expectFailure(db, noop
      ? { type: 'OPEN', lotId: 'lot-a', expectedVersion: 1, openedAt: later }
      : use(), 'PERSISTENCE_FAILED');
  });

  it('does not classify unexpected transport/storage failure as stale or successful', async () => {
    const db = database();
    await execute(db, 'create', create());
    db.hooks.beforeBatch = (statements) => { if (isWrite(statements)) throw new Error('private storage error'); };
    await expectFailure(db, use(), 'PERSISTENCE_FAILED');
  });

  it('sanitizes read-side database errors before returning them', async () => {
    const db = database();
    db.hooks.beforeBatch = () => { throw new Error('Private database detail'); };
    await expect(execute(db, 'create', create())).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED', message: 'PERSISTENCE_FAILED' });
    await expect(readMappedLotSnapshot(db, scope)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED', message: 'PERSISTENCE_FAILED' });
  });

  it('replays a committed receipt when the response is lost', async () => {
    const db = database();
    let writing = false;
    db.hooks.beforeBatch = (statements) => { writing = isWrite(statements); };
    db.hooks.afterBatch = () => {
      if (writing) { db.hooks = {}; throw new Error('Response lost after commit'); }
    };
    const recovered = await execute(db, 'create', create());
    expect(recovered.replayed).toBe(true);
    const before = facts(db);
    expect(await execute(db, 'create', create(), later)).toEqual(recovered);
    expect(facts(db)).toEqual(before);
  });

  it('returns committed versions without rereading a lot changed before the response is delivered', async () => {
    const db = database();
    await execute(db, 'create', create());
    let writing = false;
    db.hooks.beforeBatch = (statements) => { writing = isWrite(statements); };
    db.hooks.afterBatch = async () => {
      if (writing) { db.hooks = {}; await execute(db, 'next-use', use({ expectedVersion: 2 }), later); }
    };
    const result = await execute(db, 'use', use());
    expect(result.result.effects[0].after).toMatchObject({ quantityMilli: 8000, version: 2, legacyVersion: 2 });
    expect(db.query("SELECT quantity_milli, version FROM inventory_lots WHERE id = 'lot-a'"))
      .toEqual([{ quantity_milli: 6000, version: 3 }]);
    expect(await execute(db, 'use', use())).toEqual({ result: result.result, replayed: true });
  });

  it('does not allow command event updates or deletion after success', async () => {
    const db = database();
    const result = await execute(db, 'create', create());
    const before = facts(db);
    expect(() => db.execute("UPDATE inventory_events SET metadata = '{}' WHERE command_id = ?", [result.result.commandId])).toThrow();
    expect(() => db.execute('DELETE FROM inventory_events WHERE command_id = ?', [result.result.commandId])).toThrow();
    expect(facts(db)).toEqual(before);
  });
});

describe('T09C controlled SQLite concurrency', () => {
  it.each(['CREATE', 'USE'])('replays %s committed between the receipt miss and planning snapshot', async (type) => {
    const db = database();
    if (type === 'USE') await execute(db, 'create', create());
    const input = type === 'CREATE' ? create() : use();
    let winner: InventoryLotCommandExecution | undefined;
    db.hooks.beforeBatch = async (statements) => {
      if (!statements.some(({ sql }) => sql.includes('FROM inventory_items WHERE household_id'))) return;
      db.hooks = {};
      winner = await execute(db, 'race', input);
    };
    const result = await execute(db, 'race', input, later);
    expect(winner).toBeDefined();
    expect(result).toEqual({ result: winner!.result, replayed: true });
  });

  it('returns a fingerprint conflict, not stale preflight, when a changed intent wins between reads', async () => {
    const db = database();
    await execute(db, 'create', create());
    db.hooks.beforeBatch = async (statements) => {
      if (!statements.some(({ sql }) => sql.includes('FROM inventory_items WHERE household_id'))) return;
      db.hooks = {};
      await execute(db, 'race', use({ quantity: 3 }));
    };
    await expect(execute(db, 'race', use())).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(db.query("SELECT quantity_milli, version FROM inventory_lots WHERE id = 'lot-a'"))
      .toEqual([{ quantity_milli: 7000, version: 2 }]);
  });

  it.each([false, true])('uses plain conflict INSERT for CREATE races (same key=%s)', async (sameKey) => {
    const db = database();
    const barrier = createBarrier(2);
    db.hooks.beforeBatch = async (statements) => { if (isWrite(statements)) await barrier.wait(); };
    const results = await Promise.allSettled([execute(db, 'create-a', create()), execute(db, sameKey ? 'create-a' : 'create-b', create())]);
    expect(barrier.arrivals).toBe(2);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(sameKey ? 2 : 1);
    if (sameKey) {
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      expect(fulfilled[0].value.result).toEqual(fulfilled[1].value.result);
    } else expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(db.query('SELECT * FROM inventory_lots')).toHaveLength(1);
    expect(db.query("SELECT * FROM inventory_events WHERE household_id = 't09-a'")).toHaveLength(1);
    expect(db.query("SELECT * FROM inventory_commands WHERE household_id = 't09-a'")).toHaveLength(1);
  });

  it.each([
    ['USE/USE', use()], ['USE/DISCARD', use({ type: 'DISCARD' })], ['USE/CORRECT', correct({ quantity: 12 })],
  ])('allows only one versioned writer for %s with different keys', async (_name, second) => {
    const db = database();
    await execute(db, 'create', create());
    const barrier = createBarrier(2);
    db.hooks.beforeBatch = async (statements) => { if (isWrite(statements)) await barrier.wait(); };
    const results = await Promise.allSettled([execute(db, 'race-a', use()), execute(db, 'race-b', second)]);
    expect(barrier.arrivals).toBe(2);
    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({ code: 'STALE_SNAPSHOT' });
    await expectCommitted(db, successes[0].value, successes[0].value.result.commandId ===
      db.query<{ id: string }>("SELECT id FROM inventory_commands WHERE client_key = 'race-a'")[0]?.id ? 'race-a' : 'race-b');
    expect(db.query("SELECT * FROM inventory_commands WHERE household_id = 't09-a'")).toHaveLength(2);
    expect(db.query("SELECT * FROM inventory_events WHERE household_id = 't09-a'")).toHaveLength(2);
  });

  it.each([false, true])('handles controlled same-key races (different payload=%s)', async (different) => {
    const db = database();
    await execute(db, 'create', create());
    const barrier = createBarrier(2);
    db.hooks.beforeBatch = async (statements) => { if (isWrite(statements)) await barrier.wait(); };
    const results = await Promise.allSettled([execute(db, 'race', use()), execute(db, 'race', use({ quantity: different ? 3 : 2 }))]);
    expect(barrier.arrivals).toBe(2);
    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    expect(successes).toHaveLength(different ? 1 : 2);
    if (different) expect(failures[0].reason).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    else {
      expect(failures).toHaveLength(0);
      expect(successes[0].value.result).toEqual(successes[1].value.result);
      expect(successes.map(({ value }) => value.replayed).sort()).toEqual([false, true]);
    }
    expect(db.query("SELECT * FROM inventory_commands WHERE household_id = 't09-a'")).toHaveLength(2);
    expect(db.query("SELECT * FROM inventory_events WHERE household_id = 't09-a'")).toHaveLength(2);
  });

  it.each(['membership', 'location', 'phantom'])('fences %s changes after the planning snapshot', async (kind) => {
    const db = database();
    await execute(db, 'create', create());
    let afterInterference: ReturnType<typeof facts> | undefined;
    db.hooks.beforeBatch = (statements) => {
      if (!isWrite(statements)) return;
      db.hooks = {};
      if (kind === 'membership') db.seed("DELETE FROM household_members WHERE id = 't09-member-a'");
      if (kind === 'location') db.seed("UPDATE storage_locations SET type = 'PANTRY', is_default = 0 WHERE id = 't09-a-FRIDGE'");
      if (kind === 'phantom') db.seed(`INSERT INTO inventory_items(id, household_id, name, quantity, unit)
        VALUES ('phantom', 't09-a', 'Concurrent stock', 1, 'piece')`);
      afterInterference = facts(db);
    };
    await expect(execute(db, 'use', use())).rejects.toMatchObject({ code: kind === 'membership' ? 'FORBIDDEN' : 'STALE_SNAPSHOT' });
    expect(afterInterference).toBeDefined();
    expect(facts(db)).toEqual(afterInterference);
  });

  it('checks membership again before returning an existing receipt', async () => {
    const db = database();
    await execute(db, 'create', create());
    db.hooks.beforeBatch = (statements) => {
      if (!statements.some(({ sql }) => sql.startsWith('SELECT fingerprint'))) return;
      db.hooks = {};
      db.seed("DELETE FROM household_members WHERE id = 't09-member-a'");
    };
    await expect(execute(db, 'create', create())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('fences authorization for receipt-only no-ops inside the write batch', async () => {
    const db = database();
    await execute(db, 'create', create({ openedAt: now }));
    const before = facts(db);
    db.hooks.beforeBatch = (statements) => {
      if (!isWrite(statements)) return;
      db.hooks = {};
      db.seed("DELETE FROM household_members WHERE id = 't09-member-a'");
    };
    await expect(execute(db, 'open', { type: 'OPEN', lotId: 'lot-a', expectedVersion: 1, openedAt: later }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(facts(db)).toEqual(before);
  });

  it('does not allow a spoofed structural scope with extra ownership fields', async () => {
    const db = database();
    const forged: InventoryLotCommandScope & { userId: string } = { ...scope, userId: 't09-user-b' };
    await expect(executeInventoryLotCommand(db, forged, 'create', create(), now)).rejects.toBeInstanceOf(LotCommandError);
    expect(db.query('SELECT * FROM inventory_lots')).toEqual([]);
  });
});
