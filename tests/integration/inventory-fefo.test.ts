import { afterEach, describe, expect, it } from 'vitest';
import {
  executeInventoryFefoCommand, executeInventoryLotCommand,
  type InventoryFefoCommandExecution,
} from '../../packages/db/src/inventory-lot-commands';
import { SqliteD1, type SqliteStatementEvent } from '../helpers/sqlite-d1';

const scope = { householdId: 'fefo-household', actorId: 'fefo-owner' };
const secondActor = { householdId: 'fefo-household', actorId: 'fefo-member' };
const foreign = { householdId: 'fefo-foreign', actorId: 'fefo-foreign-owner' };
const now = '2026-09-11T10:00:00Z';
const databases: SqliteD1[] = [];

type Json = Record<string, unknown>;

function database(): SqliteD1 {
  const db = new SqliteD1();
  databases.push(db);
  db.seed(`INSERT INTO users(id) VALUES ('fefo-owner'), ('fefo-member'), ('fefo-foreign-owner');
    INSERT INTO households(id, name, created_by) VALUES
      ('fefo-household', 'FEFO', 'fefo-owner'), ('fefo-foreign', 'Foreign', 'fefo-foreign-owner');
    INSERT INTO household_members(id, household_id, user_id, role) VALUES
      ('fefo-owner-member', 'fefo-household', 'fefo-owner', 'owner'),
      ('fefo-member-member', 'fefo-household', 'fefo-member', 'member'),
      ('fefo-foreign-member', 'fefo-foreign', 'fefo-foreign-owner', 'owner');`);
  for (const [household, location] of [['fefo-household', 'fefo-fridge'], ['fefo-foreign', 'fefo-foreign-fridge']]) {
    db.execute(`INSERT INTO storage_locations(id, household_id, type, name, sort_order, is_default, created_at, updated_at)
      VALUES (?, ?, 'FRIDGE', 'Fridge', 0, 1, ?, ?)`, [location, household, now, now]);
  }
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const fefo = (quantity: number, patch: Json = {}) => ({
  type: 'USE', mode: 'FEFO', ingredientId: 'RICE', quantity, unit: 'g', ...patch,
});
const nativeCreate = (id: string, quantity: number, patch: Json = {}) => ({
  type: 'CREATE', lotId: id, ingredientId: 'RICE', rawName: `Rice ${id}`, quantity, unit: 'g',
  storageLocationId: 'fefo-fridge', sourceType: 'MANUAL', ...patch,
});
const run = (db: SqliteD1, key: string, input: unknown, owner = scope) =>
  executeInventoryFefoCommand(db, owner, key, input, now);
const create = (db: SqliteD1, id: string, quantity: number, patch: Json = {}, owner = scope) =>
  executeInventoryLotCommand(db, owner, `create-${id}`, {
    ...nativeCreate(id, quantity, patch),
    storageLocationId: owner.householdId === foreign.householdId ? 'fefo-foreign-fridge' : 'fefo-fridge',
  }, now);

function facts(db: SqliteD1): string {
  return JSON.stringify(['households', 'inventory_lots', 'inventory_items', 'inventory_commands', 'inventory_events']
    .map((table) => db.query(`SELECT * FROM ${table} ORDER BY id`)));
}
function quantities(db: SqliteD1): Record<string, number> {
  return Object.fromEntries(db.query<{ id: string; quantity_milli: number }>(
    "SELECT id, quantity_milli FROM inventory_lots WHERE household_id = 'fefo-household' ORDER BY id",
  ).map(({ id, quantity_milli }) => [id, quantity_milli]));
}
function receiptCount(db: SqliteD1, key: string): number {
  return db.query('SELECT * FROM inventory_commands WHERE household_id = ? AND client_key = ?', scope.householdId, key).length;
}
const receiptWrite = (statements: readonly SqliteStatementEvent[]) =>
  statements.some(({ sql }) => /^INSERT INTO inventory_commands/.test(sql));

async function expectFefoFailure(db: SqliteD1, input: unknown, code: string, key = 'failed'): Promise<void> {
  const before = facts(db);
  await expect(run(db, key, input)).rejects.toMatchObject({ name: 'LotCommandError', code });
  expect(facts(db)).toBe(before);
}

async function seedOrdering(db: SqliteD1): Promise<void> {
  await create(db, 'known-later', 1, { expiryKind: 'USE_BY', expiryAt: '2026-09-20', purchasedAt: '2026-09-01' });
  await create(db, 'known-early', 1, { expiryKind: 'BEST_BEFORE', expiryAt: '2026-09-15', purchasedAt: '2026-09-10' });
  await create(db, 'estimated-earlier', 1, { expiryKind: 'ESTIMATED', estimatedExpiryAt: '2026-09-10' });
  await create(db, 'unknown-old', 1, { purchasedAt: '2026-09-01' });
  await create(db, 'unknown-new', 1, { purchasedAt: '2026-09-02' });
  await create(db, 'tie-b', 1, { purchasedAt: '2026-09-03' });
  await create(db, 'tie-a', 1, { purchasedAt: '2026-09-03' });
}

describe('T09E multi-effect FEFO authority', () => {
  it('allocates exact and partial quantities over deterministic known, estimated, unknown and tie expiry evidence', async () => {
    const db = database();
    await seedOrdering(db);

    const execution = await run(db, 'ordered', fefo(4, { reason: 'Dinner' }));
    expect(execution).toMatchObject({ replayed: false, result: {
      schemaVersion: 2, commandType: 'USE', mode: 'FEFO', ingredientId: 'RICE', quantityMilli: 4000, canonicalUnit: 'g',
    } });
    expect(execution.result.effects.map(({ ordinal, legacyItemId, before, after, deltaMilli }) =>
      ({ ordinal, legacyItemId, before: before.id, after: after.quantityMilli, deltaMilli }))).toEqual([
      { ordinal: 0, legacyItemId: 'estimated-earlier', before: 'estimated-earlier', after: 0, deltaMilli: -1000 },
      { ordinal: 1, legacyItemId: 'known-early', before: 'known-early', after: 0, deltaMilli: -1000 },
      { ordinal: 2, legacyItemId: 'known-later', before: 'known-later', after: 0, deltaMilli: -1000 },
      { ordinal: 3, legacyItemId: 'unknown-old', before: 'unknown-old', after: 0, deltaMilli: -1000 },
    ]);
    expect(quantities(db)).toMatchObject({ 'estimated-earlier': 0, 'known-early': 0, 'known-later': 0, 'unknown-old': 0, 'unknown-new': 1000 });
    expect(db.query("SELECT * FROM inventory_events WHERE command_id = ?", execution.result.commandId)).toHaveLength(4);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);

    const partial = await run(db, 'partial', fefo(1.5));
    expect(partial.result.effects.map(({ before, after, deltaMilli }) => [before.id, after.quantityMilli, deltaMilli]))
      .toEqual([['unknown-new', 0, -1000], ['tie-a', 500, -500]]);
    expect(quantities(db)).toMatchObject({ 'unknown-new': 0, 'tie-a': 500, 'tie-b': 1000 });
  });

  it('excludes terminal, foreign ingredient, foreign-household and incompatible-unit stock', async () => {
    const db = database();
    await create(db, 'active', 2, { expiryKind: 'USE_BY', expiryAt: '2026-09-12' });
    await create(db, 'spent', 2, { expiryKind: 'USE_BY', expiryAt: '2026-09-01' });
    await executeInventoryLotCommand(db, scope, 'consume-spent', { type: 'USE', lotId: 'spent', expectedVersion: 1, quantity: 2, unit: 'g' }, now);
    await create(db, 'egg', 2, { ingredientId: 'CHICKEN_EGG', unit: 'piece' });
    await create(db, 'foreign-rice', 2, {}, foreign);

    const execution = await run(db, 'only-active', fefo(2));
    expect(execution.result.effects).toHaveLength(1);
    expect(execution.result.effects[0]).toMatchObject({ legacyItemId: 'active', deltaMilli: -2000 });
    expect(quantities(db)).toMatchObject({ active: 0, spent: 0, egg: 2000 });
    expect(db.query("SELECT quantity_milli FROM inventory_lots WHERE id = 'foreign-rice'"))
      .toEqual([{ quantity_milli: 2000 }]);
  });

  it('rejects insufficiency, unsupported contextual units and non-representable precision without mutation', async () => {
    const db = database();
    await create(db, 'rice', 1);
    await expectFefoFailure(db, fefo(2), 'INSUFFICIENT_INVENTORY');
    await expectFefoFailure(db, { ...fefo(1), unit: 'pack' }, 'UNSUPPORTED_FEFO_UNIT');
    await expectFefoFailure(db, fefo(0.0001), 'UNREPRESENTABLE_QUANTITY');
    await expectFefoFailure(db, { ...fefo(1), unit: 'kg', quantity: Number.MAX_SAFE_INTEGER }, 'UNREPRESENTABLE_QUANTITY');
  });

  it('persists exact lot/projection/event parity and replays the complete receipt after later mutations', async () => {
    const db = database();
    await create(db, 'first', 2, { expiryKind: 'USE_BY', expiryAt: '2026-09-01' });
    await create(db, 'second', 3, { expiryKind: 'USE_BY', expiryAt: '2026-09-02' });
    const input = fefo(4, { reason: 'Recipe' });
    const first = await run(db, 'replay', input);
    expect(first.result.effects.map(({ legacyItemId, deltaMilli }) => [legacyItemId, deltaMilli]))
      .toEqual([['first', -2000], ['second', -2000]]);
    expect(db.query<{ quantity: number; unit: string; version: number }>("SELECT quantity, unit, version FROM inventory_items WHERE id = 'second'"))
      .toEqual([{ quantity: 1, unit: 'g', version: 2 }]);

    await executeInventoryLotCommand(db, scope, 'later-correct', {
      type: 'CORRECT', lotId: 'second', expectedVersion: 2, changes: { quantity: 2 }, reason: 'Counted',
    }, '2026-09-11T11:00:00Z');
    const replay = await run(db, 'replay', input);
    expect(replay).toEqual({ result: first.result, replayed: true });
    expect(receiptCount(db, 'replay')).toBe(1);
    expect(db.query('SELECT * FROM inventory_events WHERE command_id = ?', first.result.commandId)).toHaveLength(2);
  });

  it('rejects changed payloads and changed actors for an occupied idempotency key', async () => {
    const db = database();
    await create(db, 'rice', 5);
    await run(db, 'occupied', fefo(2));
    await expect(run(db, 'occupied', fefo(1))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(run(db, 'occupied', fefo(2), secondActor)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(receiptCount(db, 'occupied')).toBe(1);
  });

  it.each([1, 2, 3])('writes exactly %i ordered effects when that many lots are required', async (effectCount) => {
    const db = database();
    for (let index = 0; index < effectCount; index += 1) {
      await create(db, `effect-${index}`, 1, { expiryKind: 'USE_BY', expiryAt: `2026-09-0${index + 1}` });
    }
    const execution = await run(db, `effects-${effectCount}`, fefo(effectCount));
    expect(execution.result.effects.map(({ ordinal, legacyItemId, deltaMilli }) => [ordinal, legacyItemId, deltaMilli]))
      .toEqual(Array.from({ length: effectCount }, (_, index) => [index, `effect-${index}`, -1000]));
    expect(db.query('SELECT * FROM inventory_events WHERE command_id = ?', execution.result.commandId)).toHaveLength(effectCount);
  });

  it('rejects blank/oversized reasons and oversized client keys before any persistence', async () => {
    const db = database();
    await create(db, 'rice', 1);
    await expectFefoFailure(db, fefo(1, { reason: '  ' }), 'INVALID_COMMAND');
    await expectFefoFailure(db, fefo(1, { reason: 'x'.repeat(1001) }), 'INVALID_COMMAND');
    const before = facts(db);
    await expect(run(db, 'k'.repeat(201), fefo(1))).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
    expect(facts(db)).toBe(before);
  });

  it.each([
    ['second lot write', "CREATE TRIGGER fefo_fail BEFORE UPDATE ON inventory_lots WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'late lot failure'); END"],
    ['second event write', "CREATE TRIGGER fefo_fail BEFORE INSERT ON inventory_events WHEN NEW.inventory_item_id = 'second' BEGIN SELECT RAISE(ABORT, 'late event failure'); END"],
  ])('rolls back all FEFO effects when a %s fails', async (_name, trigger) => {
    const db = database();
    await create(db, 'first', 2, { expiryKind: 'USE_BY', expiryAt: '2026-09-01' });
    await create(db, 'second', 2, { expiryKind: 'USE_BY', expiryAt: '2026-09-02' });
    const before = facts(db);
    db.seed(trigger);
    await expect(run(db, 'late-failure', fefo(3))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    expect(facts(db)).toBe(before);
    db.seed('DROP TRIGGER fefo_fail');
    await expect(run(db, 'control', fefo(3))).resolves.toMatchObject({ replayed: false });
  });

  it('rejects corrupt retained v2 receipt and event evidence while retaining valid receipts as controls', async () => {
    const db = database();
    await create(db, 'first', 1, { expiryKind: 'USE_BY', expiryAt: '2026-09-01' });
    await create(db, 'second', 1, { expiryKind: 'USE_BY', expiryAt: '2026-09-02' });
    const input = fefo(2);
    await run(db, 'corrupt', input);
    const receipt = db.query<{ id: string; result_json: string }>("SELECT id, result_json FROM inventory_commands WHERE client_key = 'corrupt'")[0];
    const result = JSON.parse(receipt.result_json) as Json;
    ((result.effects as Json[])[1].before as Json).quantityMilli = 99_999;
    db.seed(`DROP TRIGGER trg_inventory_commands_fefo_authority_insert;
      DROP TRIGGER trg_inventory_commands_immutable_update;`);
    db.execute('UPDATE inventory_commands SET result_json = ? WHERE id = ?', [JSON.stringify(result), receipt.id]);
    await expect(run(db, 'corrupt', input)).rejects.toMatchObject({ code: 'CORRUPT_RECEIPT' });

    await create(db, 'control', 1);
    await run(db, 'valid-control', fefo(1));
    await expect(run(db, 'valid-control', fefo(1))).resolves.toMatchObject({ replayed: true });
  });

  it('rejects a v1 fingerprint on a v2 receipt before payload comparison, but preserves genuine v1 key conflicts', async () => {
    const db = database();
    await create(db, 'rice', 5);
    const singleInput = { type: 'USE', lotId: 'rice', expectedVersion: 1, quantity: 1, unit: 'g' };
    await executeInventoryLotCommand(db, scope, 'single', singleInput, now);
    const input = fefo(1);
    await run(db, 'multi', input);
    await expect(run(db, 'single', input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(run(db, 'multi', input)).resolves.toMatchObject({ replayed: true });
    db.seed('DROP TRIGGER trg_inventory_commands_immutable_update');
    db.execute(`UPDATE inventory_commands SET fingerprint =
      (SELECT fingerprint FROM inventory_commands WHERE client_key = 'single') WHERE client_key = 'multi'`);
    const before = facts(db);
    await expect(run(db, 'multi', input)).rejects.toMatchObject({ code: 'CORRUPT_RECEIPT' });
    expect(facts(db)).toBe(before);
    await expect(executeInventoryLotCommand(db, scope, 'single', singleInput, now)).resolves.toMatchObject({ replayed: true });
  });

  it.each([
    ['wrong event metadata', (db: SqliteD1, commandId: string) => {
      db.seed('DROP TRIGGER trg_inventory_events_command_update');
      db.execute("UPDATE inventory_events SET metadata = '{}' WHERE command_id = ?", [commandId]);
    }],
    ['missing event', (db: SqliteD1, commandId: string) => {
      db.seed('DROP TRIGGER trg_inventory_events_command_delete');
      db.execute('DELETE FROM inventory_events WHERE id = (SELECT id FROM inventory_events WHERE command_id = ? LIMIT 1)', [commandId]);
    }],
    ['extra event', (db: SqliteD1, commandId: string) => {
      db.seed('DROP TRIGGER trg_inventory_events_command_fefo_authority_insert');
      db.execute(`INSERT INTO inventory_events
        (id, household_id, inventory_item_id, event_type, quantity_delta, unit, reason, metadata, created_at, command_id)
        VALUES ('extra-retained-event', 'fefo-household', 'third', 'MANUAL_UPDATE', 0, 'g', NULL, '{}', ?, ?)`, [now, commandId]);
    }],
  ])('rejects a retained receipt with %s', async (_name, corrupt) => {
    const db = database();
    await create(db, 'first', 1, { expiryKind: 'USE_BY', expiryAt: '2026-09-01' });
    await create(db, 'second', 1, { expiryKind: 'USE_BY', expiryAt: '2026-09-02' });
    await create(db, 'third', 1, { expiryKind: 'USE_BY', expiryAt: '2026-09-03' });
    const input = fefo(2);
    const execution = await run(db, 'event-corrupt', input);
    corrupt(db, execution.result.commandId);
    const beforeReplay = facts(db);
    await expect(run(db, 'event-corrupt', input)).rejects.toMatchObject({ code: 'CORRUPT_RECEIPT' });
    expect(facts(db)).toBe(beforeReplay);
  });

  it.each([
    ['effect[1] after quantity', (_db: SqliteD1, result: Json) => { ((result.effects as Json[])[1].after as Json).quantityMilli = 999; }],
    ['effect[1] delta', (_db: SqliteD1, result: Json) => { (result.effects as Json[])[1].deltaMilli = -999; }],
    ['effect[1] version', (_db: SqliteD1, result: Json) => { ((result.effects as Json[])[1].after as Json).version = 99; }],
    ['effect[1] legacy item ID', (_db: SqliteD1, result: Json) => { (result.effects as Json[])[1].legacyItemId = 'first'; }],
    ['duplicate effect', (_db: SqliteD1, result: Json) => { (result.effects as Json[])[1] = (result.effects as Json[])[0]; }],
    ['out-of-order effects', (_db: SqliteD1, result: Json) => { (result.effects as Json[]).reverse(); }],
    ['wrong effect count', (_db: SqliteD1, result: Json) => { (result.effects as Json[]).pop(); }],
    ['malformed receipt JSON', (db: SqliteD1, _result: Json, commandId: string) => {
      db.seed('PRAGMA ignore_check_constraints = ON');
      db.execute('UPDATE inventory_commands SET result_json = ? WHERE id = ?', ['{', commandId]);
      db.seed('PRAGMA ignore_check_constraints = OFF');
    }],
    ['duplicate receipt JSON key', (db: SqliteD1, _result: Json, commandId: string) => {
      const original = db.query<{ result_json: string }>('SELECT result_json FROM inventory_commands WHERE id = ?', commandId)[0].result_json;
      db.execute('UPDATE inventory_commands SET result_json = ? WHERE id = ?', [original.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'), commandId]);
    }],
    ['malformed fingerprint JSON', (db: SqliteD1, _result: Json, commandId: string) => {
      db.seed('PRAGMA ignore_check_constraints = ON');
      db.execute('UPDATE inventory_commands SET fingerprint = ? WHERE id = ?', ['{', commandId]);
      db.seed('PRAGMA ignore_check_constraints = OFF');
    }],
  ])('rejects %s without replay side effects', async (_name, corrupt) => {
    const db = database();
    await create(db, 'first', 1, { expiryKind: 'USE_BY', expiryAt: '2026-09-01' });
    await create(db, 'second', 1, { expiryKind: 'USE_BY', expiryAt: '2026-09-02' });
    const input = fefo(2);
    const execution = await run(db, 'receipt-matrix', input);
    await expect(run(db, 'receipt-matrix', input)).resolves.toMatchObject({ replayed: true });
    const row = db.query<{ result_json: string }>('SELECT result_json FROM inventory_commands WHERE id = ?', execution.result.commandId)[0];
    db.seed('DROP TRIGGER trg_inventory_commands_immutable_update; DROP TRIGGER trg_inventory_commands_fefo_authority_insert;');
    const result = JSON.parse(row.result_json) as Json;
    corrupt(db, result, execution.result.commandId);
    if (_name !== 'malformed receipt JSON' && _name !== 'duplicate receipt JSON key' && _name !== 'malformed fingerprint JSON') {
      db.execute('UPDATE inventory_commands SET result_json = ? WHERE id = ?', [JSON.stringify(result), execution.result.commandId]);
    }
    const beforeReplay = facts(db);
    await expect(run(db, 'receipt-matrix', input)).rejects.toMatchObject({ code: 'CORRUPT_RECEIPT' });
    expect(facts(db)).toBe(beforeReplay);
  });

  it.each([32, 33])('enforces the %i-effect boundary before partial writes', async (count) => {
    const db = database();
    for (let index = 0; index < count; index += 1) {
      await create(db, `bound-${String(index).padStart(2, '0')}`, 1);
    }
    const before = facts(db);
    if (count === 32) {
      const result = await run(db, 'bound', fefo(32));
      expect(result.result.effects).toHaveLength(32);
    } else {
      await expect(run(db, 'bound', fefo(33))).rejects.toMatchObject({ code: 'FEFO_LIMIT_EXCEEDED' });
      expect(facts(db)).toBe(before);
    }
  }, 20_000);

  it('permits a 1,000-lot FEFO snapshot and rejects the 1,001st lot before allocation', async () => {
    const db = database();
    for (let index = 0; index < 1000; index += 1) await create(db, `snapshot-${index}`, 1);
    await expect(run(db, 'snapshot-1000', fefo(1))).resolves.toMatchObject({ replayed: false });
    await create(db, 'snapshot-overflow', 1);
    const before = facts(db);
    await expect(run(db, 'snapshot-1001', fefo(1))).rejects.toMatchObject({ code: 'FEFO_LIMIT_EXCEEDED' });
    expect(facts(db)).toBe(before);
  }, 60_000);

  it.each([
    ['FEFO', async (db: SqliteD1) => run(db, 'winner-fefo', fefo(1))],
    ['CORRECT', async (db: SqliteD1) => executeInventoryLotCommand(db, scope, 'winner-correct', {
      type: 'CORRECT', lotId: 'rice', expectedVersion: 1, changes: { quantity: 4 }, reason: 'Counted',
    }, now)],
    ['DISCARD', async (db: SqliteD1) => executeInventoryLotCommand(db, scope, 'winner-discard', {
      type: 'DISCARD', lotId: 'rice', expectedVersion: 1, quantity: 1, unit: 'g', reason: 'Spoiled',
    }, now)],
  ])('fences a FEFO contender after a competing %s winner commits at the frozen write barrier', async (_kind, commitWinner) => {
    const db = database();
    await create(db, 'rice', 5);
    let winnerCommitted = false;
    db.hooks.beforeBatch = async (statements) => {
      if (!receiptWrite(statements)) return;
      db.hooks = {};
      await commitWinner(db);
      winnerCommitted = true;
    };
    await expect(run(db, 'contender', fefo(2))).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(winnerCommitted).toBe(true);
    expect(quantities(db)).toEqual({ rice: 4000 });
    expect(receiptCount(db, 'contender')).toBe(0);
    expect(db.query("SELECT * FROM inventory_commands WHERE household_id = 'fefo-household'")).toHaveLength(2);
    expect(db.query("SELECT * FROM inventory_events WHERE household_id = 'fefo-household'")).toHaveLength(2);
  });

  it('returns the one committed receipt to an identical same-key FEFO contender and rejects a changed payload', async () => {
    const identical = database();
    await create(identical, 'rice', 5);
    let winner: InventoryFefoCommandExecution | undefined;
    identical.hooks.beforeBatch = async (statements) => {
      if (!receiptWrite(statements)) return;
      identical.hooks = {};
      winner = await run(identical, 'same-key', fefo(2));
    };
    const replay = await run(identical, 'same-key', fefo(2));
    expect(winner).toBeDefined();
    expect(replay).toEqual({ result: winner!.result, replayed: true });
    expect(receiptCount(identical, 'same-key')).toBe(1);
    expect(quantities(identical)).toEqual({ rice: 3000 });

    const changed = database();
    await create(changed, 'rice', 5);
    changed.hooks.beforeBatch = async (statements) => {
      if (!receiptWrite(statements)) return;
      changed.hooks = {};
      await run(changed, 'same-key', fefo(1));
    };
    await expect(run(changed, 'same-key', fefo(2))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(receiptCount(changed, 'same-key')).toBe(1);
    expect(quantities(changed)).toEqual({ rice: 4000 });
  });

  it('does not reallocate around a newly-created earlier lot or a revoked membership at the write barrier', async () => {
    const phantom = database();
    await create(phantom, 'later', 5, { expiryKind: 'USE_BY', expiryAt: '2026-09-20' });
    phantom.hooks.beforeBatch = async (statements) => {
      if (!receiptWrite(statements)) return;
      phantom.hooks = {};
      await create(phantom, 'earlier', 1, { expiryKind: 'USE_BY', expiryAt: '2026-09-01' });
    };
    await expect(run(phantom, 'phantom-contender', fefo(2))).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(quantities(phantom)).toEqual({ earlier: 1000, later: 5000 });
    expect(receiptCount(phantom, 'phantom-contender')).toBe(0);

    const revoked = database();
    await create(revoked, 'rice', 5);
    const before = facts(revoked);
    revoked.hooks.beforeBatch = (statements) => {
      if (!receiptWrite(statements)) return;
      revoked.hooks = {};
      revoked.seed("DELETE FROM household_members WHERE id = 'fefo-owner-member'");
    };
    await expect(run(revoked, 'revoked-contender', fefo(2))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(receiptCount(revoked, 'revoked-contender')).toBe(0);
    expect(quantities(revoked)).toEqual({ rice: 5000 });
    expect(facts(revoked)).toBe(before);
    expect(revoked.query("SELECT * FROM household_members WHERE id = 'fefo-owner-member'")).toEqual([]);
  });

});
