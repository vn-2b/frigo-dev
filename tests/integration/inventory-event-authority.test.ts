import { afterEach, describe, expect, it } from 'vitest';
import { executeInventoryLotCommand, type InventoryLotCommandResult } from '../../packages/db/src/inventory-lot-commands';
import type { InventoryLotCommand } from '../../packages/domain/src/inventory-lot-commands';
import { InventoryLotSchema, type InventoryLot } from '../../packages/domain/src/inventory-truth';
import { SqliteD1, SqliteStatement, type SqliteStatementEvent } from '../helpers/sqlite-d1';

const scope = { householdId: 'event-household', actorId: 'event-owner' };
const foreign = { householdId: 'event-foreign', actorId: 'event-foreign-owner' };
const now = '2026-09-10T10:00:00Z';
const mismatch = 'Inventory command event evidence mismatch';
const databases: SqliteD1[] = [];
type JsonObject = Record<string, unknown>;
type CommandType = InventoryLotCommand['type'];
type Statement = { sql: string; bindings: unknown[] };

const receiptColumns = ['id', 'household_id', 'actor_id', 'client_key', 'fingerprint', 'command_type', 'result_json', 'created_at'];
const eventColumns = ['id', 'household_id', 'inventory_item_id', 'event_type', 'quantity_delta', 'unit', 'reason', 'metadata', 'created_at', 'command_id'];
const isReceipt = (statement: Pick<Statement, 'sql'>) => /^INSERT INTO inventory_commands/.test(statement.sql);
const isEvent = (statement: Pick<Statement, 'sql'>) => /^INSERT INTO inventory_events/.test(statement.sql) && statement.sql.includes('command_id');
const execute = (db: SqliteD1, key: string, input: unknown, owner = scope) =>
  executeInventoryLotCommand(db, owner, key, input, now);
const create = (patch: JsonObject = {}) => ({
  type: 'CREATE', lotId: 'event-lot', ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 10,
  unit: 'piece', storageLocationId: 'event-fridge', sourceType: 'SCAN', sourceId: 'confirmed-scan',
  expiryKind: 'BEST_BEFORE', expiryAt: '2026-09-20', purchasedAt: '2026-09-09',
  purchasePrice: { currency: 'USD', amountMinor: 299, minorDigits: 2 }, ...patch,
});

async function database(): Promise<SqliteD1> {
  const db = new SqliteD1();
  databases.push(db);
  db.seed(`INSERT INTO users(id) VALUES ('event-owner'), ('event-member'), ('event-foreign-owner');
    INSERT INTO households(id, name, created_by) VALUES
      ('event-household', 'Event authority', 'event-owner'), ('event-foreign', 'Foreign authority', 'event-foreign-owner');
    INSERT INTO household_members(id, household_id, user_id, role) VALUES
      ('event-membership', 'event-household', 'event-owner', 'owner'),
      ('event-member-membership', 'event-household', 'event-member', 'member'),
      ('event-foreign-membership', 'event-foreign', 'event-foreign-owner', 'owner');`);
  for (const [id, household, type] of [
    ['event-fridge', scope.householdId, 'FRIDGE'], ['event-freezer', scope.householdId, 'FREEZER'],
    ['event-foreign-fridge', foreign.householdId, 'FRIDGE'],
  ]) {
    db.execute(`INSERT INTO storage_locations(id, household_id, type, name, sort_order, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 1, ?, ?)`, [id, household, type, type, now, now]);
  }
  await execute(db, 'seed', create());
  await execute(db, 'seed-other', create({ lotId: 'event-other-lot' }));
  await execute(db, 'seed-foreign', create({ lotId: 'event-foreign-lot', storageLocationId: 'event-foreign-fridge' }), foreign);
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function input(type: CommandType): JsonObject {
  if (type === 'CREATE') return create({ lotId: 'event-new-lot' });
  const identity = { type, lotId: 'event-lot', expectedVersion: 1 };
  if (type === 'USE' || type === 'DISCARD') return { ...identity, quantity: 2, unit: 'piece', reason: 'Measured deduction' };
  if (type === 'OPEN') return { ...identity, openedAt: now };
  if (type === 'MOVE') return { ...identity, storageLocationId: 'event-freezer' };
  return { ...identity, changes: { quantity: 12, rawName: 'Counted eggs' }, reason: 'Physical recount' };
}

function stateBytes(db: SqliteD1): string {
  return JSON.stringify(['households', 'household_members', 'storage_locations', 'inventory_items',
    'inventory_lots', 'inventory_commands', 'inventory_events'].map((table) => db.query(`SELECT * FROM ${table} ORDER BY id`)));
}

async function prepared(type: CommandType = 'USE') {
  const db = await database();
  let statements: Statement[] = [];
  const before = stateBytes(db);
  db.hooks.beforeBatch = (batch: readonly SqliteStatementEvent[]) => {
    if (!batch.some(isReceipt)) return;
    statements = batch.map(({ sql, bindings }) => ({ sql, bindings: [...bindings] }));
    throw new Error('Capture native batch before any writes');
  };
  await expect(execute(db, 'attempt', input(type))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
  db.hooks = {};
  expect(stateBytes(db)).toBe(before);
  expect(statements.filter(isEvent)).toHaveLength(1);
  const receipt = statements.find(isReceipt)!;
  const event = statements.find(isEvent)!;
  return { db, statements, receipt, event };
}

function field(statement: Statement, columns: string[], column: string): unknown {
  expect(columns).toContain(column);
  return statement.bindings[columns.indexOf(column)];
}
function setField(statement: Statement, columns: string[], column: string, value: unknown): void {
  expect(columns).toContain(column);
  statement.bindings[columns.indexOf(column)] = value;
}
function setPath(object: JsonObject, path: string, value: unknown, remove = false): void {
  const keys = path.split('.');
  let target = object;
  for (const key of keys.slice(0, -1)) target = target[key] as JsonObject;
  if (remove) delete target[keys.at(-1)!];
  else target[keys.at(-1)!] = value;
}
function changeJson(statement: Statement, columns: string[], column: string, path: string, value: unknown, remove = false): void {
  const object = JSON.parse(field(statement, columns, column) as string) as JsonObject;
  setPath(object, path, value, remove);
  setField(statement, columns, column, JSON.stringify(object));
}
async function rejectBatch(fixture: Awaited<ReturnType<typeof prepared>>): Promise<void> {
  const before = stateBytes(fixture.db);
  await expect(fixture.db.batch(fixture.statements.map(({ sql, bindings }) => fixture.db.prepare(sql).bind(...bindings))))
    .rejects.toThrow(mismatch);
  expect(stateBytes(fixture.db)).toBe(before);
  expect(fixture.db.query('PRAGMA foreign_key_check')).toEqual([]);
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)]));
  }
  return value;
}

function mirrorPoststate(fixture: Awaited<ReturnType<typeof prepared>>, changes: Partial<InventoryLot>): InventoryLotCommandResult {
  const result = JSON.parse(field(fixture.receipt, receiptColumns, 'result_json') as string) as InventoryLotCommandResult;
  const effect = result.effects[0];
  Object.assign(effect.after, changes);
  effect.deltaMilli = effect.after.quantityMilli - (effect.before?.quantityMilli ?? 0);
  expect(InventoryLotSchema.safeParse(effect.after).success).toBe(true);
  expect(effect.after.state === 'ACTIVE' ? effect.after.quantityMilli > 0 : effect.after.quantityMilli === 0).toBe(true);
  const metadata = JSON.parse(field(fixture.event, eventColumns, 'metadata') as string) as JsonObject;
  Object.assign(metadata, { before: effect.before, after: effect.after, deltaMilli: effect.deltaMilli,
    source: { type: effect.after.sourceType, id: effect.after.sourceId },
    allocation: [{ lotId: effect.after.id, deltaMilli: effect.deltaMilli, canonicalUnit: effect.after.canonicalUnit }] });
  setField(fixture.receipt, receiptColumns, 'result_json', JSON.stringify(result));
  setField(fixture.event, eventColumns, 'metadata', JSON.stringify(metadata));
  setField(fixture.event, eventColumns, 'quantity_delta', effect.deltaMilli / 1000);
  setField(fixture.event, eventColumns, 'unit', effect.after.canonicalUnit);
  return result;
}

describe('T09D SQL event authority and atomic injection rejection', () => {
  it.each<CommandType>(['CREATE', 'USE', 'DISCARD', 'OPEN', 'MOVE', 'CORRECT'])(
    'accepts native %s evidence with reordered and whitespace-formatted metadata', async (type) => {
      const fixture = await prepared(type);
      const metadata = JSON.parse(field(fixture.event, eventColumns, 'metadata') as string);
      setField(fixture.event, eventColumns, 'metadata', JSON.stringify(reverseKeys(metadata), null, 2));
      const results = await fixture.db.batch(fixture.statements.map(({ sql, bindings }) => fixture.db.prepare(sql).bind(...bindings)));
      expect(results.every(({ success }) => success)).toBe(true);
      const replay = await execute(fixture.db, 'attempt', input(type));
      expect(replay).toEqual({ result: JSON.parse(field(fixture.receipt, receiptColumns, 'result_json') as string), replayed: true });
      expect(fixture.db.query('SELECT * FROM inventory_events WHERE command_id = ?', replay.result.commandId)).toHaveLength(1);
      expect(fixture.db.query('PRAGMA foreign_key_check')).toEqual([]);
    },
  );

  it.each([
    ['household_id', foreign.householdId], ['inventory_item_id', 'event-other-lot'],
    ['inventory_item_id', 'event-foreign-lot'], ['inventory_item_id', 'missing-lot'], ['inventory_item_id', null],
    ['command_id', 'missing-command'], ['event_type', 'DISCARD'], ['quantity_delta', -3], ['quantity_delta', 2],
    ['quantity_delta', -2.0001], ['unit', 'g'], ['reason', 'Forged explanation'], ['reason', null],
    ['created_at', '2026-09-11T10:00:00Z'], ['quantity_delta', null], ['unit', null], ['event_type', null], ['created_at', null],
  ])('rejects an event column mismatch %s=%j and rolls back every preceding write', async (column, value) => {
    const fixture = await prepared();
    setField(fixture.event, eventColumns, column as string, value);
    await rejectBatch(fixture);
  });

  it.each(['OR IGNORE', 'OR REPLACE'])('does not let INSERT %s suppress an authority rejection', async (conflict) => {
    const fixture = await prepared();
    fixture.event.sql = fixture.event.sql.replace('INSERT INTO', `INSERT ${conflict} INTO`);
    setField(fixture.event, eventColumns, 'metadata', '{}');
    await rejectBatch(fixture);
  });

  it.each([null, '', '{', 'null', 'true', '7', '"metadata"', '[]', '{}'])(
    'rejects malformed or non-evidence metadata %j with the stable guard message', async (metadata) => {
      const fixture = await prepared();
      setField(fixture.event, eventColumns, 'metadata', metadata);
      await rejectBatch(fixture);
    },
  );

  it.each([
    ['schemaVersion', 2], ['schemaVersion', '1'], ['householdId', foreign.householdId], ['actorId', 'event-member'],
    ['commandId', 'another-command'], ['commandType', 'DISCARD'], ['clientKey', 'another-key'], ['fingerprint', '{}'],
    ['timestamp', '2026-09-11T10:00:00Z'], ['deltaMilli', -2001], ['deltaMilli', '-2000'],
    ['before', null], ['before.id', 'event-other-lot'], ['before.householdId', foreign.householdId],
    ['before.quantityMilli', 9999], ['before.version', 2], ['before.legacyVersion', 2],
    ['after.id', 'event-other-lot'], ['after.householdId', foreign.householdId], ['after.quantityMilli', 7999],
    ['after.canonicalUnit', 'g'], ['after.state', 'DISCARDED'], ['after.version', 3], ['after.legacyVersion', 3],
    ['after.rawName', 'Invented label'], ['after.ingredientId', 'RICE'], ['after.storageLocationId', 'event-freezer'],
    ['after.expiryKind', 'USE_BY'], ['after.expiryAt', '2026-09-21'], ['after.purchasedAt', '2026-09-08'],
    ['after.openedAt', now], ['after.purchasePrice.amountMinor', 300], ['after.purchasePrice.currency', 'EUR'],
    ['after.purchasePrice.minorDigits', 0], ['after.sourceType', 'MANUAL'], ['after.sourceId', 'another-scan'],
    ['after.createdAt', '2026-09-09T10:00:00Z'], ['after.updatedAt', '2026-09-11T10:00:00Z'],
    ['after.legacyExpiryAt', '2026-09-21'], ['after.legacyExpiryKind', 'use_by'], ['after.legacyExpirySource', 'user'],
    ['after.legacyOpenedAt', now], ['source.type', 'MANUAL'], ['source.id', 'another-scan'],
    ['allocation', []], ['allocation', {}], ['allocation.0.lotId', 'event-other-lot'],
    ['allocation.0.deltaMilli', -3000], ['allocation.0.canonicalUnit', 'g'], ['unexpected', true],
  ])('rejects metadata divergence at %s', async (path, value) => {
    const fixture = await prepared();
    changeJson(fixture.event, eventColumns, 'metadata', path as string, value);
    await rejectBatch(fixture);
  });

  it.each(['schemaVersion', 'actorId', 'before', 'after', 'deltaMilli', 'source.id', 'allocation', 'fingerprint', 'after.purchasePrice'])(
    'rejects missing metadata field %s', async (path) => {
      const fixture = await prepared();
      changeJson(fixture.event, eventColumns, 'metadata', path, undefined, true);
      await rejectBatch(fixture);
    },
  );

  it.each([
    ['actor_id', 'event-member'], ['household_id', foreign.householdId], ['client_key', 'another-key'],
    ['command_type', 'DISCARD'], ['created_at', '2026-09-11T10:00:00Z'],
    ['fingerprint', 'not-json'], ['fingerprint', 'null'], ['fingerprint', '[]'],
    ['result_json', 'null'], ['result_json', '[]'], ['result_json', '{}'],
  ])('rejects misbound or malformed receipt %s=%j', async (column, value) => {
    const fixture = await prepared();
    setField(fixture.receipt, receiptColumns, column, value);
    await rejectBatch(fixture);
  });

  it.each([
    ['householdId', foreign.householdId], ['actorId', 'event-member'], ['command', null],
    ['command.type', 'DISCARD'], ['command.lotId', 'event-other-lot'], ['command.expectedVersion', 2],
    ['command.reason', null], ['command.reason', 1], ['command.reason', 'Different reason'],
  ])('rejects fingerprint binding divergence at %s', async (path, value) => {
    const fixture = await prepared();
    changeJson(fixture.receipt, receiptColumns, 'fingerprint', path as string, value);
    await rejectBatch(fixture);
  });

  it.each([
    ['commandId', 'another-command'], ['commandType', 'DISCARD'], ['lotId', 'event-other-lot'],
    ['version', 3], ['version', '2'], ['version', 0], ['version', 9007199254740992],
    ['effects', []], ['effects', {}], ['effects.0', null], ['effects.0.changed', false], ['effects.0.changed', 1],
    ['effects.0.before', null], ['effects.0.before.id', 'event-other-lot'], ['effects.0.before.householdId', foreign.householdId],
    ['effects.0.before.canonicalUnit', 'g'], ['effects.0.before.quantityMilli', -1], ['effects.0.before.quantityMilli', 9999],
    ['effects.0.before.version', 0], ['effects.0.before.version', 2], ['effects.0.before.sourceType', 'MANUAL'],
    ['effects.0.before.sourceId', null], ['effects.0.after', null], ['effects.0.after.id', 'event-other-lot'],
    ['effects.0.after.householdId', foreign.householdId], ['effects.0.after.quantityMilli', -1],
    ['effects.0.after.quantityMilli', 8000.5], ['effects.0.after.quantityMilli', 9007199254740992],
    ['effects.0.after.version', 3], ['effects.0.after.updatedAt', '2026-09-11T10:00:00Z'],
    ['effects.0.after.sourceId', 12], ['effects.0.deltaMilli', -1999], ['effects.0.deltaMilli', '-2000'],
    ['effects.0.deltaMilli', -2000.5], ['effects.0.deltaMilli', -9007199254740992],
  ])('rejects corrupt result evidence at %s', async (path, value) => {
    const fixture = await prepared();
    changeJson(fixture.receipt, receiptColumns, 'result_json', path as string, value);
    await rejectBatch(fixture);
  });

  it.each([
    ['before.version', 2], ['before.quantityMilli', 10001], ['before.sourceId', 'another-scan'],
    ['before.canonicalUnit', 'g'], ['after.quantityMilli', 8001], ['after.version', 3],
    ['after.householdId', foreign.householdId], ['after.updatedAt', '2026-09-11T10:00:00Z'],
    ['after.sourceType', null], ['after.canonicalUnit', 'kg'], ['deltaMilli', -2001],
  ])('rejects invalid effect %s even when event columns and metadata mirror the corrupt receipt', async (path, value) => {
    const fixture = await prepared();
    changeJson(fixture.receipt, receiptColumns, 'result_json', `effects.0.${path}`, value);
    const result = JSON.parse(field(fixture.receipt, receiptColumns, 'result_json') as string) as { effects: JsonObject[] };
    const effect = result.effects[0];
    const after = effect.after as JsonObject;
    const metadata = JSON.parse(field(fixture.event, eventColumns, 'metadata') as string) as JsonObject;
    Object.assign(metadata, { before: effect.before, after, deltaMilli: effect.deltaMilli,
      source: { type: after.sourceType, id: after.sourceId },
      allocation: [{ lotId: after.id, deltaMilli: effect.deltaMilli, canonicalUnit: after.canonicalUnit }] });
    setField(fixture.event, eventColumns, 'metadata', JSON.stringify(metadata));
    setField(fixture.event, eventColumns, 'quantity_delta', (effect.deltaMilli as number) / 1000);
    setField(fixture.event, eventColumns, 'unit', after.canonicalUnit);
    await rejectBatch(fixture);
  });

  it.each(['', ' \t\n', null])('rejects a corrupt CORRECT reason %j even when event reason and fingerprint agree', async (reason) => {
    const fixture = await prepared('CORRECT');
    changeJson(fixture.receipt, receiptColumns, 'fingerprint', 'command.reason', reason);
    setField(fixture.event, eventColumns, 'reason', reason);
    changeJson(fixture.event, eventColumns, 'metadata', 'fingerprint', field(fixture.receipt, receiptColumns, 'fingerprint'));
    await rejectBatch(fixture);
  });

  it.each(['metadata', 'result_json', 'fingerprint'])(
    'rejects duplicate JSON keys in %s even when duplicate values agree', async (column) => {
      const fixture = await prepared();
      const statement = column === 'metadata' ? fixture.event : fixture.receipt;
      const columns = column === 'metadata' ? eventColumns : receiptColumns;
      const json = field(statement, columns, column) as string;
      const object = JSON.parse(json) as JsonObject;
      const key = Object.keys(object)[0];
      setField(statement, columns, column, `{${JSON.stringify(key)}:${JSON.stringify(object[key])},${json.slice(1)}`);
      await rejectBatch(fixture);
    },
  );

  it('rejects duplicate nested metadata keys and extra allocations', async () => {
    const fixture = await prepared();
    const original = field(fixture.event, eventColumns, 'metadata') as string;
    setField(fixture.event, eventColumns, 'metadata', original.replace('"amountMinor":299', '"amountMinor":299,"amountMinor":299'));
    await rejectBatch(fixture);
    const metadata = JSON.parse(original) as { allocation: unknown[] };
    metadata.allocation.push(metadata.allocation[0]);
    setField(fixture.event, eventColumns, 'metadata', JSON.stringify(metadata));
    await rejectBatch(fixture);
  });

  it.each<CommandType>(['OPEN', 'MOVE', 'CORRECT'])('cannot append an invented event to a committed %s no-op receipt', async (type) => {
    const db = await database();
    let expectedVersion = 1;
    if (type === 'OPEN') {
      await execute(db, 'open-first', input('OPEN'));
      expectedVersion = 2;
    }
    const noop = type === 'OPEN' ? { ...input(type), expectedVersion }
      : type === 'MOVE' ? { ...input(type), storageLocationId: 'event-fridge' }
        : { ...input(type), changes: { rawName: 'Eggs' } };
    const execution = await execute(db, 'noop', noop);
    expect(execution.result.effects).toEqual([]);
    const before = stateBytes(db);
    expect(() => db.execute(`INSERT INTO inventory_events
      (id, household_id, inventory_item_id, event_type, quantity_delta, unit, command_id, metadata, created_at)
      VALUES ('invented-noop', ?, 'event-lot', 'DISCARD', -9, 'piece', ?, '{}', ?)`,
    [scope.householdId, execution.result.commandId, now])).toThrow(mismatch);
    expect(stateBytes(db)).toBe(before);
    expect(await execute(db, 'noop', noop)).toEqual({ result: execution.result, replayed: true });
  });

  it('sanitizes an authority-trigger rejection at the executor boundary and permits a clean retry', async () => {
    const db = await database();
    const before = stateBytes(db);
    const batch = db.batch.bind(db);
    db.batch = async (statements) => batch(statements.map((statement) => {
      if (!(statement instanceof SqliteStatement) || !isEvent(statement)) return statement;
      const bindings = [...statement.bindings];
      bindings[eventColumns.indexOf('metadata')] = '{}';
      return db.prepare(statement.sql).bind(...bindings);
    }));
    await expect(execute(db, 'retry', input('USE'))).rejects.toMatchObject({
      name: 'LotCommandError', code: 'PERSISTENCE_FAILED', message: 'PERSISTENCE_FAILED',
    });
    expect(stateBytes(db)).toBe(before);
    db.batch = batch;
    const success = await execute(db, 'retry', input('USE'));
    expect(success.replayed).toBe(false);
    expect(success.result.effects[0].after.quantityMilli).toBe(8000);
    expect(await execute(db, 'retry', input('USE'))).toEqual({ result: success.result, replayed: true });
  });
});

describe('T09D matched receipt/event evidence versus committed poststate', () => {
  it('rolls back a coherent 7000/-3000 receipt and event for USE 2, then commits the unchanged 8000/-2000 result', async () => {
    const fixture = await prepared();
    const originalReceipt = [...fixture.receipt.bindings];
    const originalEvent = [...fixture.event.bindings];
    const originalResult = JSON.parse(field(fixture.receipt, receiptColumns, 'result_json') as string) as InventoryLotCommandResult;
    const fingerprint = field(fixture.receipt, receiptColumns, 'fingerprint');
    expect(originalResult.effects[0]).toMatchObject({ deltaMilli: -2000, after: { quantityMilli: 8000 } });
    expect(JSON.parse(fingerprint as string).command).toMatchObject({ type: 'USE', quantity: 2, unit: 'piece' });

    const forged = mirrorPoststate(fixture, { quantityMilli: 7000 });
    expect(forged.effects[0]).toMatchObject({ deltaMilli: -3000, after: { quantityMilli: 7000 } });
    expect(field(fixture.receipt, receiptColumns, 'fingerprint')).toBe(fingerprint);
    await rejectBatch(fixture);
    expect(fixture.db.query("SELECT quantity_milli, version FROM inventory_lots WHERE id = 'event-lot'"))
      .toEqual([{ quantity_milli: 10000, version: 1 }]);
    expect(fixture.db.query("SELECT quantity, version FROM inventory_items WHERE id = 'event-lot'"))
      .toEqual([{ quantity: 10, version: 1 }]);
    expect(fixture.db.query('SELECT id FROM inventory_commands WHERE id = ?', originalResult.commandId)).toEqual([]);
    expect(fixture.db.query('SELECT id FROM inventory_events WHERE command_id = ?', originalResult.commandId)).toEqual([]);

    fixture.receipt.bindings = originalReceipt;
    fixture.event.bindings = originalEvent;
    const results = await fixture.db.batch(fixture.statements.map(({ sql, bindings }) => fixture.db.prepare(sql).bind(...bindings)));
    expect(results.every(({ success }) => success)).toBe(true);
    const committed = stateBytes(fixture.db);
    expect(await execute(fixture.db, 'attempt', input('USE'))).toEqual({ result: originalResult, replayed: true });
    expect(stateBytes(fixture.db)).toBe(committed);
    expect(fixture.db.query("SELECT quantity_milli, version FROM inventory_lots WHERE id = 'event-lot'"))
      .toEqual([{ quantity_milli: 8000, version: 2 }]);
    expect(fixture.db.query("SELECT quantity, version FROM inventory_items WHERE id = 'event-lot'"))
      .toEqual([{ quantity: 8, version: 2 }]);
    expect(fixture.db.query('SELECT result_json FROM inventory_commands WHERE id = ?', originalResult.commandId))
      .toEqual([{ result_json: originalReceipt[receiptColumns.indexOf('result_json')] }]);
    expect(fixture.db.query('SELECT metadata, quantity_delta FROM inventory_events WHERE command_id = ?', originalResult.commandId))
      .toEqual([{ metadata: originalEvent[eventColumns.indexOf('metadata')], quantity_delta: -2 }]);
    expect(fixture.db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it.each<{ name: string; type: CommandType; after: Partial<InventoryLot> }>([
    { name: 'raw name', type: 'USE', after: { rawName: 'Invented eggs' } },
    { name: 'ingredient identity', type: 'USE', after: { ingredientId: 'RICE' } },
    { name: 'unknown ingredient', type: 'USE', after: { ingredientId: null } },
    { name: 'owned storage location', type: 'USE', after: { storageLocationId: 'event-freezer' } },
    { name: 'price amount', type: 'USE', after: { purchasePrice: { currency: 'USD', amountMinor: 399, minorDigits: 2 } } },
    { name: 'price currency', type: 'USE', after: { purchasePrice: { currency: 'EUR', amountMinor: 299, minorDigits: 2 } } },
    { name: 'price minor-unit scale', type: 'USE', after: { purchasePrice: { currency: 'JPY', amountMinor: 299, minorDigits: 0 } } },
    { name: 'unknown price', type: 'USE', after: { purchasePrice: null } },
    { name: 'consumed terminal state', type: 'USE', after: { state: 'CONSUMED', quantityMilli: 0 } },
    { name: 'discarded terminal state', type: 'DISCARD', after: { state: 'DISCARDED', quantityMilli: 0 } },
    { name: 'source type', type: 'CREATE', after: { sourceType: 'MANUAL' } },
    { name: 'source reference', type: 'CREATE', after: { sourceId: 'another-confirmed-scan' } },
    { name: 'canonical unit', type: 'CREATE', after: { canonicalUnit: 'g' } },
    { name: 'purchase date', type: 'USE', after: { purchasedAt: '2026-09-08' } },
    { name: 'opening timestamp', type: 'USE', after: { openedAt: now } },
    { name: 'expiry date', type: 'USE', after: { expiryAt: '2026-09-21' } },
    { name: 'expiry kind', type: 'USE', after: { expiryKind: 'USE_BY' } },
    { name: 'estimated expiry', type: 'USE', after: { expiryKind: 'ESTIMATED', expiryAt: null, estimatedExpiryAt: '2026-09-21' } },
    { name: 'creation timestamp', type: 'USE', after: { createdAt: '2026-09-09T10:00:00Z' } },
    { name: 'projection revision', type: 'USE', after: { legacyVersion: 3 } },
    { name: 'raw legacy expiry', type: 'USE', after: { legacyExpiryAt: '2026-09-21' } },
    { name: 'raw legacy expiry kind', type: 'USE', after: { legacyExpiryKind: 'use_by' } },
    { name: 'raw legacy expiry source', type: 'USE', after: { legacyExpirySource: 'user' } },
    { name: 'raw legacy opening evidence', type: 'USE', after: { legacyOpenedAt: now } },
  ])('rejects mirrored $name evidence despite a valid lot shape and matching event arithmetic', async ({ type, after }) => {
    const fixture = await prepared(type);
    const fingerprint = field(fixture.receipt, receiptColumns, 'fingerprint');
    mirrorPoststate(fixture, after);
    expect(field(fixture.receipt, receiptColumns, 'fingerprint')).toBe(fingerprint);
    await rejectBatch(fixture);
  });
});
