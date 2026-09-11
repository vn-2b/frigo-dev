import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import { executeInventoryFefoCommand, executeInventoryLotCommand, readMappedLotSnapshot } from '../../packages/db/src/inventory-lot-commands';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { inventoryRoutes } from '../../src/worker/routes/inventory';
import type { AuthContext, Env } from '../../src/worker/types';
import { signJwt } from '../../src/worker/utils/jwt';
import { SqliteD1 } from '../helpers/sqlite-d1';

const scope = { householdId: 'backfill-home', actorId: '' };
const secret = 'test-only-backfilled-patch-secret-key';
const now = '2026-09-11T11:00:00Z';
const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
app.use('*', authMiddleware);
app.route('/', inventoryRoutes);
let db: SqliteD1;
let token: string;

beforeEach(async () => {
  scope.actorId = `backfill-user-${crypto.randomUUID()}`;
  db = new SqliteD1();
  db.seed(`INSERT INTO users(id) VALUES ('${scope.actorId}'), ('foreign-backfill-user');
    INSERT INTO households(id,name,created_by) VALUES
      ('backfill-home','Backfill','${scope.actorId}'), ('backfill-other','Other','foreign-backfill-user');
    INSERT INTO household_members(id,household_id,user_id,role) VALUES
      ('backfill-member','backfill-home','${scope.actorId}','owner'),
      ('backfill-other-member','backfill-other','foreign-backfill-user','owner');
    INSERT INTO inventory_items(id,household_id,ingredient_id,name,quantity,unit,category,storage)
      VALUES ('patch-rice','backfill-home','RICE','Rice',2000,'g','grain','pantry'),
      ('foreign-rice','backfill-other','RICE','Private rice',1000,'g','private','fridge');`);
  token = await signJwt({ sub: scope.actorId, hid: scope.householdId, typ: 'access',
    exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
});
afterEach(() => db.close());

async function adopt(preBackfill = false) {
  if (preBackfill) await backfillLegacyInventory(db, scope.householdId);
  const execution = await executeInventoryAdoption(db, scope, {}, now);
  expect(execution.result.effects[0]).toMatchObject({ lotId: 't08-legacy:patch-rice', legacyItemId: 'patch-rice',
    after: { id: 't08-legacy:patch-rice', householdId: scope.householdId, sourceType: 'LEGACY_BACKFILL',
      sourceId: 'patch-rice', version: 2, legacyVersion: 1 }, projectionAfter: { id: 'patch-rice', version: 1 } });
  expect(lot()).toMatchObject({ id: 't08-legacy:patch-rice', legacy_item_id: 'patch-rice' });
}

async function patch(body: Record<string, unknown>, key = 'backfilled-patch-key', id = 'patch-rice', bearer = token) {
  const response = await app.fetch(new Request(`https://backfill.example/inventory/${id}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json',
      'Idempotency-Key': key }, body: JSON.stringify(body),
  }), { DB: db, ENVIRONMENT: 'test', JWT_SECRET: secret });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

function row() { return db.query("SELECT * FROM inventory_items WHERE id = 'patch-rice'")[0]; }
function lot() { return db.query("SELECT * FROM inventory_lots WHERE id = 't08-legacy:patch-rice'")[0]; }
function facts() {
  return Object.fromEntries(['households', 'inventory_items', 'inventory_lots', 'storage_locations',
    'inventory_commands', 'inventory_events', 'inventory_adoption_receipts']
    .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY id`)]));
}

describe('T09 legitimate adopted backfilled PATCH', () => {
  it.each([false, true])('updates category through actual adoption (existing T08 snapshot: %s)', async (preBackfill) => {
    await adopt(preBackfill);
    const response = await patch({ version: 1, category: 'vegetable' });
    expect(response, JSON.stringify(response)).toMatchObject({ status: 200 });
    expect(row()).toMatchObject({ category: 'vegetable', quantity: 2000, version: 2 });
    expect(lot()).toMatchObject({ id: 't08-legacy:patch-rice', legacy_item_id: 'patch-rice',
      quantity_milli: 2000000, version: 3, legacy_version: 2 });
    const receipt = db.query('SELECT * FROM inventory_commands')[0];
    expect(JSON.parse(String(receipt.result_json))).toMatchObject({ lotId: 't08-legacy:patch-rice', version: 3 });
    expect(db.query('SELECT inventory_item_id, command_id FROM inventory_events WHERE household_id = ?', scope.householdId)).toEqual([
      { inventory_item_id: 'patch-rice', command_id: receipt.id },
    ]);
  });

  it.each([
    [{ quantity: 500 }, { quantity: 500, storage: 'pantry', category: 'grain', expiry_date: null }, 2],
    [{ storage: 'freezer' }, { quantity: 2000, storage: 'freezer', category: 'grain', expiry_date: null }, 3],
    [{ quantity: 500, category: 'vegetable', storage: 'freezer', expiryDate: '2026-09-30' },
      { quantity: 500, storage: 'freezer', category: 'vegetable', expiry_date: '2026-09-30' }, 3],
  ])('persists quantity/storage/combined intent %j atomically', async (changes, expected, version) => {
    await adopt();
    expect((await patch({ version: 1, ...changes })).status).toBe(200);
    expect(row()).toMatchObject({ ...expected, version });
    expect(lot()).toMatchObject({ quantity_milli: expected.quantity * 1000, version: version + 1,
      legacy_version: version, legacy_item_id: 'patch-rice', expiry_at: expected.expiry_date });
    expect(db.query('SELECT type FROM storage_locations WHERE id = ?', lot().storage_location_id)[0])
      .toEqual({ type: expected.storage.toUpperCase() });
    expect(db.query('SELECT COUNT(*) AS n FROM inventory_lots WHERE household_id = ?', scope.householdId)[0].n).toBe(1);
    expect(db.query('SELECT COUNT(*) AS n FROM inventory_items WHERE household_id = ?', scope.householdId)[0].n).toBe(1);
    const commands = db.query('SELECT * FROM inventory_commands WHERE household_id = ?', scope.householdId);
    expect(commands).toHaveLength(version - 1);
    for (const command of commands) {
      const result = JSON.parse(String(command.result_json));
      expect(result.effects).toHaveLength(1);
      expect(result.effects[0].after.id).toBe('t08-legacy:patch-rice');
      const event = db.query('SELECT * FROM inventory_events WHERE command_id = ?', command.id);
      expect(event).toHaveLength(1);
      expect(event[0]).toMatchObject({ inventory_item_id: 'patch-rice', household_id: scope.householdId });
      expect(JSON.parse(String(event[0].metadata)).after).toEqual(result.effects[0].after);
    }
  });

  const combined = { version: 1, quantity: 500, category: 'vegetable', storage: 'freezer', expiryDate: '2026-09-30' };

  it('replays a lost response, including after later legitimate stock changes', async () => {
    await adopt();
    const first = await patch(combined);
    expect(first.status).toBe(200);
    const committed = facts();
    expect(await patch(combined)).toEqual({ status: 200, json: { ...first.json, idempotentReplay: true } });
    expect(facts()).toEqual(committed);
    expect((await patch({ version: 3, quantity: 400, category: 'meat' }, 'backfill-later-key')).status).toBe(200);
    const later = facts();
    expect(await patch(combined)).toEqual({ status: 200, json: { ...first.json, idempotentReplay: true } });
    expect(facts()).toEqual(later);
  });

  it.each([['category', 'meat'], ['storage', 'pantry'], ['quantity', 501], ['version', 3]])(
    'rejects changed %s under a committed key', async (field, value) => {
      await adopt();
      expect((await patch(combined)).status).toBe(200);
      const committed = facts();
      expect(await patch({ ...combined, [String(field)]: value })).toMatchObject({ status: 409,
        json: { code: 'IDEMPOTENCY_CONFLICT' } });
      expect(facts()).toEqual(committed);
    });

  it('keeps distinct-key stale CAS strict', async () => {
    await adopt();
    expect((await patch(combined)).status).toBe(200);
    const committed = facts();
    expect(await patch(combined, 'backfill-distinct-key')).toMatchObject({ status: 409, json: { code: 'CONFLICT' } });
    expect(facts()).toEqual(committed);
  });

  it.each(['category', 'move', 'poststate'])('rolls back all mapped effects when %s fails', async (failure) => {
    await adopt();
    if (failure === 'category') db.seed(`CREATE TRIGGER fail_backfill_category BEFORE UPDATE OF category ON inventory_items
      WHEN NEW.id = 'patch-rice' AND NEW.category = 'vegetable' BEGIN SELECT RAISE(IGNORE); END;`);
    if (failure === 'move') db.seed(`CREATE TRIGGER fail_backfill_move BEFORE INSERT ON inventory_commands
      WHEN NEW.command_type = 'MOVE' BEGIN SELECT RAISE(ABORT, 'Injected MOVE failure'); END;`);
    if (failure === 'poststate') db.seed(`CREATE TRIGGER corrupt_backfill_category AFTER UPDATE ON inventory_items
      WHEN NEW.id = 'patch-rice' AND NEW.category = 'vegetable' BEGIN
      UPDATE inventory_items SET category = 'unexpected' WHERE id = NEW.id; END;`);
    const before = facts();
    expect((await patch(combined)).status).not.toBe(200);
    expect(facts()).toEqual(before);
  });

  it('recovers from a thrown response after the atomic batch committed', async () => {
    await adopt();
    db.hooks.beforeBatch = async (statements) => {
      if (statements.some(({ sql }) => sql.includes('INSERT INTO inventory_commands'))) {
        db.hooks.afterBatch = async () => { db.hooks = {}; throw new Error('Lost committed response'); };
      }
    };
    expect(await patch(combined)).toMatchObject({ status: 200, json: { idempotentReplay: true } });
    const committed = facts();
    expect(await patch(combined)).toMatchObject({ status: 200, json: { idempotentReplay: true } });
    expect(facts()).toEqual(committed);
  });

  it('preserves legacy kg display conversion without changing mapping identity', async () => {
    db.seed("UPDATE inventory_items SET unit = 'kg', quantity = 2 WHERE id = 'patch-rice'");
    await adopt();
    expect(row()).toMatchObject({ unit: 'kg', quantity: 2 });
    expect((await patch({ version: 1, quantity: 1.5 })).status).toBe(200);
    expect(row()).toMatchObject({ unit: 'g', quantity: 1500, version: 2 });
    expect(lot()).toMatchObject({ quantity_milli: 1500000, legacy_version: 2, version: 3, legacy_item_id: 'patch-rice' });
  });

  it('denies foreign actors and caller-selected foreign projection or native IDs', async () => {
    await adopt();
    await executeInventoryAdoption(db, { householdId: 'backfill-other', actorId: 'foreign-backfill-user' }, {}, now);
    expect((await patch(combined)).status).toBe(200);
    const foreignToken = await signJwt({ sub: 'foreign-backfill-user', hid: 'backfill-other', typ: 'access',
      exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
    const before = facts();
    for (const [id, bearer] of [['patch-rice', foreignToken], ['foreign-rice', token], ['t08-legacy:foreign-rice', token]]) {
      expect(await patch(combined, 'backfilled-patch-key', id, bearer)).toMatchObject({ status: 404, json: { code: 'NOT_FOUND' } });
    }
    await expect(executeInventoryLotCommand(db, { ...scope, actorId: 'foreign-backfill-user' }, 'foreign-lot-key',
      { type: 'CORRECT', lotId: 't08-legacy:patch-rice', expectedVersion: 4, changes: { quantity: 1 }, reason: 'Attack' }, now))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(facts()).toEqual(before);
  });

  it.each(['foreign-rice', 'missing-row', null])('rejects mapping tampering to %s at the database boundary', async (target) => {
    await adopt();
    const before = facts();
    await expect(db.prepare('UPDATE inventory_lots SET legacy_item_id = ?, version = version + 1 WHERE id = ?')
      .bind(target, 't08-legacy:patch-rice').run()).rejects.toThrow();
    expect(facts()).toEqual(before);
  });

  it.each([
    "ingredient_id = 'CHICKEN_EGG'", 'quantity = 1999', "storage = 'fridge'", "unit = 'ml'",
    'version = 2', "name = 'Wrong name'", "expiry_date = '2026-09-30'", "opened_at = '2026-09-01T00:00:00Z'",
  ])('rejects genuine projection drift: %s', async (assignment) => {
    await adopt();
    db.seed(`UPDATE inventory_items SET ${assignment} WHERE id = 'patch-rice'`);
    const before = facts();
    await expect(executeInventoryLotCommand(db, scope, 'drift-correction-key', { type: 'CORRECT',
      lotId: 't08-legacy:patch-rice', expectedVersion: 2, changes: { quantity: 500 }, reason: 'Must not repair' }, now))
      .rejects.toMatchObject({ code: 'DRIFT_DETECTED' });
    expect(facts()).toEqual(before);
  });

  it.each(['wrong-mapping', 'foreign-mapping', 'missing-row', 'invalid-state', 'invalid-ingredient'])('rejects stored corruption: %s', async (corruption) => {
    await adopt();
    db.seed('DROP TRIGGER trg_inventory_lots_live_update; PRAGMA foreign_keys = OFF;');
    if (corruption === 'wrong-mapping') {
      db.seed(`INSERT INTO inventory_items(id,household_id,ingredient_id,name,quantity,unit,category,storage)
        VALUES ('same-household-copy','backfill-home','RICE','Rice',2000,'g','grain','pantry');
        UPDATE inventory_lots SET legacy_item_id = 'same-household-copy' WHERE id = 't08-legacy:patch-rice'`);
    }
    if (corruption === 'foreign-mapping') db.seed("UPDATE inventory_lots SET legacy_item_id = 'foreign-rice' WHERE id = 't08-legacy:patch-rice'");
    if (corruption === 'missing-row') db.seed("DELETE FROM inventory_items WHERE id = 'patch-rice'");
    if (corruption === 'invalid-state') db.seed("UPDATE inventory_lots SET state = 'CONSUMED' WHERE id = 't08-legacy:patch-rice'");
    if (corruption === 'invalid-ingredient') db.seed("UPDATE inventory_lots SET ingredient_id = 'MISSING' WHERE id = 't08-legacy:patch-rice'; UPDATE inventory_items SET ingredient_id = 'MISSING' WHERE id = 'patch-rice'");
    const before = facts();
    await expect(executeInventoryLotCommand(db, scope, 'corrupt-correction-key', { type: 'CORRECT',
      lotId: 't08-legacy:patch-rice', expectedVersion: 2, changes: { quantity: 500 }, reason: 'Must not repair' }, now)).rejects.toThrow();
    expect(facts()).toEqual(before);
  });

  it.each(['missing-effect', 'wrong-lot', 'wrong-projection', 'wrong-household', 'wrong-source'])('requires exact adoption receipt evidence: %s', async (corruption) => {
    await adopt();
    db.seed('DROP TRIGGER trg_inventory_adoption_receipts_immutable_update;');
    const receipt = db.query('SELECT result_json FROM inventory_adoption_receipts WHERE household_id = ?', scope.householdId)[0];
    const result = JSON.parse(String(receipt.result_json));
    if (corruption === 'missing-effect') { result.effects = []; result.mappedLotCount = 0; }
    if (corruption === 'wrong-lot') result.effects[0].lotId = 'unrelated-lot';
    if (corruption === 'wrong-projection') result.effects[0].legacyItemId = 'foreign-rice';
    if (corruption === 'wrong-household') result.householdId = 'backfill-other';
    if (corruption === 'wrong-source') result.effects[0].after.sourceId = 'foreign-rice';
    await db.prepare('UPDATE inventory_adoption_receipts SET result_json = ? WHERE household_id = ?')
      .bind(JSON.stringify(result), scope.householdId).run();
    const before = facts();
    expect((await patch({ version: 1, category: 'vegetable' })).status).toBe(500);
    expect(facts()).toEqual(before);
  });

  it.each(['USE', 'DISCARD', 'OPEN', 'MOVE'] as const)('preserves mapped identity for shared v1 %s and replay', async (type) => {
    await adopt();
    const freezer = db.query<{ id: string }>("SELECT id FROM storage_locations WHERE household_id = 'backfill-home' AND type = 'FREEZER'")[0];
    const input = { type, lotId: 't08-legacy:patch-rice', expectedVersion: 2,
      ...(type === 'OPEN' ? { openedAt: now } : type === 'MOVE' ? { storageLocationId: freezer.id }
        : { quantity: 100, unit: 'g' }) };
    const first = await executeInventoryLotCommand(db, scope, 'shared-v1-key', input, now);
    const committed = facts();
    expect(await executeInventoryLotCommand(db, scope, 'shared-v1-key', input, now))
      .toEqual({ result: first.result, replayed: true });
    expect(lot()).toMatchObject({ id: 't08-legacy:patch-rice', legacy_item_id: 'patch-rice', version: 3, legacy_version: 2 });
    expect(facts()).toEqual(committed);
  });

  it('serves v2 FEFO on adopted backfilled stock through the same authoritative mapping', async () => {
    await adopt();
    const snapshot = await readMappedLotSnapshot(db, scope, 'RICE');
    const execution = await executeInventoryFefoCommand(db, scope, 'backfill-fefo-key', { type: 'USE', mode: 'FEFO',
      ingredientId: 'RICE', quantity: 100, unit: 'g', expectedInventoryVersion: snapshot.inventoryVersion }, now);
    expect(execution.result.effects[0]).toMatchObject({ legacyItemId: 'patch-rice',
      after: { id: 't08-legacy:patch-rice', quantityMilli: 1900000 } });
    expect(lot()).toMatchObject({ id: 't08-legacy:patch-rice', legacy_item_id: 'patch-rice',
      quantity_milli: 1900000, version: 3, legacy_version: 2 });
    expect(row()).toMatchObject({ id: 'patch-rice', quantity: 1900, version: 2 });
    expect(db.query('SELECT inventory_item_id FROM inventory_events WHERE household_id = ?', scope.householdId))
      .toEqual([{ inventory_item_id: 'patch-rice' }]);
  });
});
