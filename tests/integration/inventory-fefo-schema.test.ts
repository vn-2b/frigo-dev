import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { executeInventoryFefoCommand, executeInventoryLotCommand } from '../../packages/db/src/inventory-lot-commands';
import { SqliteD1, type SqliteStatementEvent } from '../helpers/sqlite-d1';

const scope = { householdId: 'fefo-schema-household', actorId: 'fefo-schema-owner' };
const now = '2026-09-11T12:00:00Z';
const commandMismatch = 'Inventory FEFO command evidence mismatch';
const eventMismatch = 'Inventory FEFO command event evidence mismatch';
const databases: SqliteD1[] = [];

type JsonObject = Record<string, unknown>;
type Statement = { sql: string; bindings: unknown[] };

const receiptColumns = ['id', 'household_id', 'actor_id', 'client_key', 'fingerprint', 'command_type', 'result_json', 'created_at'];
const eventColumns = ['id', 'household_id', 'inventory_item_id', 'event_type', 'quantity_delta', 'unit', 'reason', 'metadata', 'created_at', 'command_id'];
const isReceipt = (statement: Pick<Statement, 'sql'>) => statement.sql.includes('INSERT INTO inventory_commands');
const isEvent = (statement: Pick<Statement, 'sql'>) => /^\s*INSERT\s+INTO inventory_events/i.test(statement.sql)
  && statement.sql.includes('command_id');

function seedFixture(db: SqliteD1): void {
  db.seed(`INSERT INTO users(id) VALUES ('fefo-schema-owner');
    INSERT INTO households(id, name, created_by) VALUES ('fefo-schema-household', 'FEFO schema', 'fefo-schema-owner');
    INSERT INTO household_members(id, household_id, user_id, role)
      VALUES ('fefo-schema-member', 'fefo-schema-household', 'fefo-schema-owner', 'owner');
    INSERT INTO storage_locations(id, household_id, type, name, sort_order, is_default, created_at, updated_at)
      VALUES ('fefo-schema-fridge', 'fefo-schema-household', 'FRIDGE', 'Fridge', 0, 1, '${now}', '${now}');`);
}
function database(migrate = true): SqliteD1 {
  const db = new SqliteD1({ migrate });
  databases.push(db);
  seedFixture(db);
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const create = (db: SqliteD1, id: string, quantity: number, patch: JsonObject = {}) => executeInventoryLotCommand(db, scope,
  `create-${id}`, {
    type: 'CREATE', lotId: id, ingredientId: 'RICE', rawName: `Rice ${id}`, quantity, unit: 'g',
    storageLocationId: 'fefo-schema-fridge', sourceType: 'MANUAL', ...patch,
  }, now);
const use = (db: SqliteD1, key: string, quantity = 0.3) => executeInventoryFefoCommand(db, scope, key,
  { type: 'USE', mode: 'FEFO', ingredientId: 'RICE', quantity, unit: 'g', reason: 'Schema proof' }, now);

function state(db: SqliteD1): string {
  return JSON.stringify(['users', 'households', 'household_members', 'storage_locations', 'inventory_items', 'inventory_lots', 'inventory_commands', 'inventory_events']
    .map((table) => db.query(`SELECT * FROM ${table} ORDER BY id`)));
}
function field(statement: Statement, columns: readonly string[], name: string): unknown {
  return statement.bindings[columns.indexOf(name)];
}
function setField(statement: Statement, columns: readonly string[], name: string, value: unknown): void {
  statement.bindings[columns.indexOf(name)] = value;
}
function jsonField(statement: Statement, columns: readonly string[], name: string): JsonObject {
  return JSON.parse(field(statement, columns, name) as string) as JsonObject;
}
function setJson(statement: Statement, columns: readonly string[], name: string, value: JsonObject): void {
  setField(statement, columns, name, JSON.stringify(value));
}
function at(object: JsonObject, path: string): { target: JsonObject; key: string } {
  const keys = path.split('.');
  let target = object;
  for (const key of keys.slice(0, -1)) target = target[key] as JsonObject;
  return { target, key: keys.at(-1)! };
}
function setPath(object: JsonObject, path: string, value: unknown): void {
  const { target, key } = at(object, path);
  target[key] = value;
}
function deletePath(object: JsonObject, path: string): void {
  const { target, key } = at(object, path);
  delete target[key];
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as JsonObject).reverse().map(([key, entry]) => [key, reverseKeys(entry)]));
  }
  return value;
}

interface Captured { db: SqliteD1; statements: Statement[]; }
async function captured(): Promise<Captured> {
  const db = database();
  await create(db, 'rice-early', 0.1, { expiryKind: 'USE_BY', expiryAt: '2026-09-12' });
  await create(db, 'rice-later', 0.5, { expiryKind: 'USE_BY', expiryAt: '2026-09-13' });
  const before = state(db);
  let statements: Statement[] = [];
  db.hooks.beforeBatch = (batch: readonly SqliteStatementEvent[]) => {
    if (!batch.some(isReceipt)) return;
    statements = batch.map(({ sql, bindings }) => ({ sql, bindings: [...bindings] }));
    throw new Error('Capture FEFO write before transaction');
  };
  await expect(use(db, 'captured')).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
  db.hooks = {};
  expect(state(db)).toBe(before);
  expect(statements.filter(isReceipt)).toHaveLength(1);
  expect(statements.filter(isEvent)).toHaveLength(2);
  return { db, statements };
}
function clone(fixture: Captured): Statement[] {
  return fixture.statements.map(({ sql, bindings }) => ({ sql, bindings: [...bindings] }));
}
async function rejected(db: SqliteD1, statements: Statement[], message: string | RegExp): Promise<void> {
  const before = state(db);
  await expect(db.batch(statements.map(({ sql, bindings }) => db.prepare(sql).bind(...bindings)))).rejects.toThrow(message);
  expect(state(db)).toBe(before);
  expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
}
function receipt(statements: Statement[]): Statement {
  return statements.find(isReceipt)!;
}
function events(statements: Statement[]): Statement[] {
  return statements.filter(isEvent);
}
function alterResult(statements: Statement[], mutate: (result: JsonObject) => void): void {
  const target = receipt(statements);
  const result = jsonField(target, receiptColumns, 'result_json');
  mutate(result);
  setJson(target, receiptColumns, 'result_json', result);
}
function alterFingerprint(statements: Statement[], mutate: (fingerprint: JsonObject) => void): void {
  const target = receipt(statements);
  const fingerprint = jsonField(target, receiptColumns, 'fingerprint');
  mutate(fingerprint);
  setJson(target, receiptColumns, 'fingerprint', fingerprint);
}
function plan(db: SqliteD1, sql: string): string {
  return db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).map(({ detail }) => detail).join('\n');
}

const receiptAttacks: Array<{ name: string; mutate: (statements: Statement[]) => void }> = [
  { name: 'missing v2 header key', mutate: (s) => alterResult(s, (r) => deletePath(r, 'mode')) },
  { name: 'missing v2 ingredient key', mutate: (s) => alterResult(s, (r) => deletePath(r, 'ingredientId')) },
  { name: 'missing v2 quantity key', mutate: (s) => alterResult(s, (r) => deletePath(r, 'quantityMilli')) },
  { name: 'extra v2 header key', mutate: (s) => alterResult(s, (r) => setPath(r, 'metadata', {})) },
  { name: 'wrong v2 mode', mutate: (s) => alterResult(s, (r) => setPath(r, 'mode', 'LOT')) },
  { name: 'wrong v2 ingredient', mutate: (s) => alterResult(s, (r) => setPath(r, 'ingredientId', 'CHICKEN_EGG')) },
  { name: 'wrong v2 quantity', mutate: (s) => alterResult(s, (r) => setPath(r, 'quantityMilli', 1)) },
  { name: 'missing fingerprint command key', mutate: (s) => alterFingerprint(s, (f) => deletePath(f, 'command.mode')) },
  { name: 'missing fingerprint ingredient key', mutate: (s) => alterFingerprint(s, (f) => deletePath(f, 'command.ingredientId')) },
  { name: 'missing fingerprint quantity key', mutate: (s) => alterFingerprint(s, (f) => deletePath(f, 'command.quantityMilli')) },
  { name: 'extra fingerprint root key', mutate: (s) => alterFingerprint(s, (f) => setPath(f, 'unexpected', true)) },
  { name: 'extra fingerprint command key', mutate: (s) => alterFingerprint(s, (f) => setPath(f, 'command.unexpected', true)) },
  { name: 'wrong fingerprint mode', mutate: (s) => alterFingerprint(s, (f) => setPath(f, 'command.mode', 'LOT')) },
  { name: 'wrong fingerprint ingredient', mutate: (s) => alterFingerprint(s, (f) => setPath(f, 'command.ingredientId', 'CHICKEN_EGG')) },
  { name: 'wrong fingerprint quantity', mutate: (s) => alterFingerprint(s, (f) => setPath(f, 'command.quantityMilli', 1)) },
  { name: 'empty effects', mutate: (s) => alterResult(s, (r) => setPath(r, 'effects', [])) },
  { name: 'thirty-three effects', mutate: (s) => alterResult(s, (r) => {
    const effect = (r.effects as JsonObject[])[0];
    setPath(r, 'effects', Array.from({ length: 33 }, (_, ordinal) => ({ ...effect, ordinal, legacyItemId: `extra-${ordinal}` })));
  }) },
  { name: 'duplicated lot and legacy projection', mutate: (s) => alterResult(s, (r) => {
    const effects = r.effects as JsonObject[];
    effects[1] = { ...effects[1], legacyItemId: effects[0].legacyItemId, after: effects[0].after };
  }) },
  { name: 'reordered effects', mutate: (s) => alterResult(s, (r) => setPath(r, 'effects', [...(r.effects as JsonObject[])].reverse())) },
  { name: 'wrong effect ordinal', mutate: (s) => alterResult(s, (r) => setPath((r.effects as JsonObject[])[1], 'ordinal', 0)) },
  { name: 'wrong effect delta', mutate: (s) => alterResult(s, (r) => setPath((r.effects as JsonObject[])[1], 'deltaMilli', -1)) },
  { name: 'wrong before version', mutate: (s) => alterResult(s, (r) => setPath((r.effects as JsonObject[])[0], 'before.version', 99)) },
  { name: 'wrong after quantity', mutate: (s) => alterResult(s, (r) => setPath((r.effects as JsonObject[])[1], 'after.quantityMilli', 299)) },
  { name: 'wrong after version', mutate: (s) => alterResult(s, (r) => setPath((r.effects as JsonObject[])[0], 'after.version', 99)) },
  { name: 'wrong after state', mutate: (s) => alterResult(s, (r) => setPath((r.effects as JsonObject[])[0], 'after.state', 'ACTIVE')) },
  { name: 'wrong after raw name', mutate: (s) => alterResult(s, (r) => setPath((r.effects as JsonObject[])[0], 'after.rawName', 'Forged rice')) },
  { name: 'wrong legacy item id', mutate: (s) => alterResult(s, (r) => setPath((r.effects as JsonObject[])[0], 'legacyItemId', 'not-a-lot')) },
  { name: 'wrong before snapshot', mutate: (s) => alterResult(s, (r) => setPath((r.effects as JsonObject[])[0], 'before.quantityMilli', 999)) },
  { name: 'unexpected money evidence', mutate: (s) => alterResult(s, (r) => setPath((r.effects as JsonObject[])[0], 'after.purchasePrice', { currency: 'USD', amountMinor: 1, minorDigits: 2 })) },
  { name: 'unexpected after metadata', mutate: (s) => alterResult(s, (r) => setPath((r.effects as JsonObject[])[0], 'after.metadata', {})) },
];

describe('T09E SQLite FEFO authority guards', () => {
  it('rolls back a reordered and renumbered receipt/event pair that contradicts the intended allocation order', async () => {
    const fixture = await captured();
    const statements = clone(fixture);
    alterResult(statements, (result) => {
      result.effects = (result.effects as JsonObject[]).reverse().map((effect, ordinal) => ({ ...effect, ordinal }));
    });
    for (const event of events(statements)) {
      const metadata = jsonField(event, eventColumns, 'metadata');
      metadata.ordinal = 1 - Number(metadata.ordinal);
      setJson(event, eventColumns, 'metadata', metadata);
    }
    await rejected(fixture.db, statements, 'NOT NULL constraint failed: inventory_events.inventory_item_id');
    await fixture.db.batch(clone(fixture).map(({ sql, bindings }) => fixture.db.prepare(sql).bind(...bindings)));
    await expect(use(fixture.db, 'captured')).resolves.toMatchObject({ replayed: true });
  });

  it('accepts the captured authority batch when JSON object keys are reordered', async () => {
    const fixture = await captured();
    const statements = clone(fixture);
    const receiptStatement = receipt(statements);
    for (const statement of [receipt(statements), ...events(statements)]) {
      const columns = isReceipt(statement) ? receiptColumns : eventColumns;
      for (const name of isReceipt(statement) ? ['fingerprint', 'result_json'] : ['metadata']) {
        setField(statement, columns, name, JSON.stringify(reverseKeys(jsonField(statement, columns, name))));
      }
    }
    const reorderedFingerprint = field(receiptStatement, receiptColumns, 'fingerprint');
    for (const event of events(statements)) {
      const metadata = jsonField(event, eventColumns, 'metadata');
      setPath(metadata, 'fingerprint', reorderedFingerprint);
      setJson(event, eventColumns, 'metadata', metadata);
    }
    await expect(fixture.db.batch(statements.map(({ sql, bindings }) => fixture.db.prepare(sql).bind(...bindings)))).resolves.toHaveLength(statements.length);
    expect(fixture.db.query("SELECT id FROM inventory_commands WHERE client_key = 'captured'")).toHaveLength(1);
    expect(fixture.db.query("SELECT quantity_milli FROM inventory_lots WHERE id = 'rice-later'"))
      .toEqual([{ quantity_milli: 300 }]);
  });

  it.each(receiptAttacks)('rejects $name at direct receipt insertion before any mutation', async ({ mutate }) => {
    const fixture = await captured();
    const statements = clone(fixture);
    mutate(statements);
    await rejected(fixture.db, [receipt(statements)], commandMismatch);
  });

  it.each(receiptAttacks)('rejects $name with the complete malicious batch before any mutation', async ({ mutate }) => {
    const fixture = await captured();
    const statements = clone(fixture);
    mutate(statements);
    await rejected(fixture.db, statements, /Inventory FEFO command(?: event)? evidence mismatch/);
  });

  it.each([
    ['null', null],
    ['v1', 1],
    ['unknown integer', 3],
    ['wrong string', '2'],
  ])('rejects a new v2-shaped receipt with schemaVersion %s', async (_name, schemaVersion) => {
    const fixture = await captured();
    const statements = clone(fixture);
    alterResult(statements, (result) => setPath(result, 'schemaVersion', schemaVersion));
    await rejected(fixture.db, [receipt(statements)], commandMismatch);
  });

  it.each(['malformed result JSON', 'duplicate result JSON key', 'malformed fingerprint JSON', 'duplicate fingerprint JSON key'])
  ('rejects %s without a SQL NULL fail-open', async (kind) => {
    const fixture = await captured();
    const statements = clone(fixture);
    const target = receipt(statements);
    if (kind === 'malformed result JSON') setField(target, receiptColumns, 'result_json', '{');
    if (kind === 'duplicate result JSON key') {
      setField(target, receiptColumns, 'result_json', (field(target, receiptColumns, 'result_json') as string).replace('"mode":"FEFO"', '"mode":"FEFO","mode":"FEFO"'));
    }
    if (kind === 'malformed fingerprint JSON') setField(target, receiptColumns, 'fingerprint', '{');
    if (kind === 'duplicate fingerprint JSON key') {
      setField(target, receiptColumns, 'fingerprint', (field(target, receiptColumns, 'fingerprint') as string).replace('"actorId":"fefo-schema-owner"', '"actorId":"fefo-schema-owner","actorId":"fefo-schema-owner"'));
    }
    await rejected(fixture.db, statements, /Inventory FEFO command evidence mismatch|malformed JSON/);
  });

  it.each(['missing metadata', 'extra metadata', 'malformed metadata', 'duplicate metadata key'])
  ('rejects effect[1] %s and rolls back the whole batch', async (kind) => {
    const fixture = await captured();
    const statements = clone(fixture);
    const event = events(statements)[1];
    const metadata = field(event, eventColumns, 'metadata') as string;
    if (kind === 'missing metadata') setField(event, eventColumns, 'metadata', '{}');
    if (kind === 'extra metadata') setField(event, eventColumns, 'metadata', metadata.replace(/}$/, ',"unexpected":true}'));
    if (kind === 'malformed metadata') setField(event, eventColumns, 'metadata', '{');
    if (kind === 'duplicate metadata key') setField(event, eventColumns, 'metadata', metadata.replace('"mode":"FEFO"', '"mode":"FEFO","mode":"FEFO"'));
    await rejected(fixture.db, statements, /Inventory FEFO command event evidence mismatch|malformed JSON/);
  });

  it('rejects paired receipt and event evidence that disagrees with the written second-lot poststate', async () => {
    const fixture = await captured();
    const statements = clone(fixture);
    alterResult(statements, (result) => {
      const effects = result.effects as JsonObject[];
      setPath(result, 'quantityMilli', 600);
      setPath(effects[1], 'deltaMilli', -500);
      setPath(effects[1], 'after.quantityMilli', 0);
      setPath(effects[1], 'after.state', 'CONSUMED');
    });
    alterFingerprint(statements, (fingerprint) => setPath(fingerprint, 'command.quantityMilli', 600));
    const forgedFingerprint = field(receipt(statements), receiptColumns, 'fingerprint');
    for (const event of events(statements)) {
      const metadata = jsonField(event, eventColumns, 'metadata');
      setPath(metadata, 'fingerprint', forgedFingerprint);
      setJson(event, eventColumns, 'metadata', metadata);
    }
    const secondEvent = events(statements)[1];
    const metadata = jsonField(secondEvent, eventColumns, 'metadata');
    setPath(metadata, 'deltaMilli', -500);
    setPath(metadata, 'after.quantityMilli', 0);
    setPath(metadata, 'after.state', 'CONSUMED');
    setPath((metadata.allocation as JsonObject[])[0], 'deltaMilli', -500);
    setJson(secondEvent, eventColumns, 'metadata', metadata);
    setField(secondEvent, eventColumns, 'quantity_delta', -0.5);
    await rejected(fixture.db, statements, eventMismatch);
  });

  it('retains v1 rows byte-for-byte across the populated 0027 upgrade, replays v1, and accepts new FEFO', async () => {
    const db = new SqliteD1({ migrate: false });
    databases.push(db);
    for (const file of readdirSync('migrations').filter((name) => /^\d+.*\.sql$/.test(name) && name <= '0026_inventory_event_poststate.sql').sort()) {
      db.seed(readFileSync(`migrations/${file}`, 'utf8'));
    }
    seedFixture(db);
    await create(db, 'v1-rice-early', 0.1, { expiryKind: 'USE_BY', expiryAt: '2026-09-12' });
    await create(db, 'v1-rice-later', 0.5, { expiryKind: 'USE_BY', expiryAt: '2026-09-13' });
    const old = await executeInventoryLotCommand(db, scope, 'v1-use', {
      type: 'USE', lotId: 'v1-rice-early', expectedVersion: 1, quantity: 0.01, unit: 'g', reason: 'v1 proof',
    }, now);
    const tables = ['households', 'household_members', 'storage_locations', 'inventory_items', 'inventory_lots', 'inventory_commands', 'inventory_events'];
    const bytes = () => JSON.stringify(tables.map((table) => db.query(`SELECT * FROM ${table} ORDER BY id`)));
    const before = bytes();
    db.seed(readFileSync('migrations/0027_inventory_fefo_authority.sql', 'utf8'));
    expect(bytes()).toBe(before);
    await expect(executeInventoryLotCommand(db, scope, 'v1-use', {
      type: 'USE', lotId: 'v1-rice-early', expectedVersion: 1, quantity: 0.01, unit: 'g', reason: 'v1 proof',
    }, now)).resolves.toMatchObject({ replayed: true, result: old.result });
    await expect(create(db, 'v1-native-after-upgrade', 0.01, {
      expiryKind: 'USE_BY', expiryAt: '2026-10-01',
    })).resolves.toMatchObject({ replayed: false, result: { commandType: 'CREATE', effects: [{ changed: true }] } });
    const next = await use(db, 'v2-after-upgrade', 0.2);
    expect(next.replayed).toBe(false);
    expect(next.result.schemaVersion).toBe(2);
    expect(next.result.effects.map((effect) => effect.ordinal)).toEqual([0, 1]);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });

  it('uses indexed bounded reads for FEFO lots/items, ingredient identity, and receipt events', () => {
    const db = database();
    expect(plan(db, `SELECT id FROM inventory_items WHERE household_id = '${scope.householdId}' ORDER BY id LIMIT 1001`))
      .toContain('idx_inventory_items_household');
    expect(plan(db, `SELECT id FROM inventory_lots WHERE household_id = '${scope.householdId}' ORDER BY id LIMIT 1001`))
      .toContain('idx_inventory_lots_household_location');
    expect(plan(db, "SELECT id, category FROM ingredients WHERE id = 'RICE'"))
      .toContain('sqlite_autoindex_ingredients_1');
    expect(plan(db, "SELECT id FROM inventory_events WHERE command_id = 'captured' ORDER BY id LIMIT 33"))
      .toContain('idx_inventory_events_command_lot');
  });
});
