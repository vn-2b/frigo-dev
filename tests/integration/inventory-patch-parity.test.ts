import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import { executeInventoryLotCommand } from '../../packages/db/src/inventory-lot-commands';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { inventoryRoutes } from '../../src/worker/routes/inventory';
import type { AuthContext, Env } from '../../src/worker/types';
import { signJwt } from '../../src/worker/utils/jwt';
import { SqliteD1 } from '../helpers/sqlite-d1';

const scope = { householdId: 'patch-home', actorId: 'patch-user' };
const secret = 'test-only-inventory-patch-parity-secret';
const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
app.use('*', authMiddleware);
app.route('/', inventoryRoutes);
let db: SqliteD1;
let token: string;
let foreignToken: string;

beforeEach(async () => {
  scope.actorId = `patch-user-${crypto.randomUUID()}`;
  db = new SqliteD1();
  db.seed(`INSERT INTO users(id) VALUES ('${scope.actorId}'), ('patch-foreign');
    INSERT INTO households(id,name,created_by) VALUES
      ('patch-home','Patch','${scope.actorId}'), ('patch-other','Other','patch-foreign');
    INSERT INTO household_members(id,household_id,user_id,role) VALUES
      ('patch-member','patch-home','${scope.actorId}','owner'),
      ('patch-other-member','patch-other','patch-foreign','owner');`);
  await executeInventoryAdoption(db, scope, {});
  await executeInventoryAdoption(db, { householdId: 'patch-other', actorId: 'patch-foreign' }, {});
  const location = db.query<{ id: string }>("SELECT id FROM storage_locations WHERE household_id = 'patch-home' AND type = 'PANTRY'")[0];
  await executeInventoryLotCommand(db, scope, 'patch-seed-key', { type: 'CREATE', lotId: 'patch-rice',
    ingredientId: 'RICE', rawName: 'Rice', quantity: 2000, unit: 'g', storageLocationId: location.id,
    sourceType: 'MANUAL' }, new Date().toISOString());
  const exp = Math.floor(Date.now() / 1000) + 3600;
  token = await signJwt({ sub: scope.actorId, hid: scope.householdId, typ: 'access', exp }, secret);
  foreignToken = await signJwt({ sub: 'patch-foreign', hid: 'patch-other', typ: 'access', exp }, secret);
});
afterEach(() => db.close());

async function patch(body: Record<string, unknown>, key = 'patch-semantic-key', bearer = token) {
  const response = await app.fetch(new Request('https://patch.example/inventory/patch-rice', {
    method: 'PATCH', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json',
      'Idempotency-Key': key }, body: JSON.stringify(body),
  }), { DB: db, ENVIRONMENT: 'test', JWT_SECRET: secret });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

function facts() {
  return Object.fromEntries(['households', 'inventory_items', 'inventory_lots', 'storage_locations',
    'inventory_commands', 'inventory_events', 'inventory_adoption_receipts']
    .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY id`)]));
}
function row() { return db.query("SELECT * FROM inventory_items WHERE id = 'patch-rice'")[0]; }
function lot() { return db.query("SELECT * FROM inventory_lots WHERE legacy_item_id = 'patch-rice'")[0]; }

describe('T09 adopted PATCH semantic parity', () => {
  it('rejects changed storage under a committed key', async () => {
    const body = { version: 1, quantity: 3, storage: 'freezer' };
    expect((await patch(body)).status).toBe(200);
    const committed = facts();
    expect(await patch(body)).toMatchObject({ status: 200, json: { idempotentReplay: true } });
    expect(await patch({ ...body, storage: 'pantry' })).toMatchObject({ status: 409,
      json: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(facts()).toEqual(committed);
  });

  it('persists a category-only change with coherent projection and lot versions', async () => {
    expect((await patch({ version: 1, category: 'vegetable' })).status).toBe(200);
    expect(row()).toMatchObject({ category: 'vegetable', version: 2 });
    expect(lot()).toMatchObject({ quantity_milli: 2000000, legacy_version: 2, version: 2 });
  });

  const combined = { version: 1, quantity: 500, category: 'vegetable', storage: 'freezer', expiryDate: '2026-09-30' };

  it('atomically commits all fields and replays the original result after later writes', async () => {
    const response = await patch(combined);
    expect(response.status).toBe(200);
    expect(row()).toMatchObject({ quantity: 500, unit: 'g', category: 'vegetable', storage: 'freezer',
      expiry_date: '2026-09-30', version: 3 });
    expect(lot()).toMatchObject({ quantity_milli: 500000, expiry_at: '2026-09-30', version: 3, legacy_version: 3 });
    expect(db.query('SELECT type FROM storage_locations WHERE id = ?', lot().storage_location_id)[0]).toEqual({ type: 'FREEZER' });
    expect(db.query('SELECT command_type FROM inventory_commands ORDER BY command_type')).toEqual([
      { command_type: 'CORRECT' }, { command_type: 'CREATE' }, { command_type: 'MOVE' },
    ]);
    expect(db.query('SELECT COUNT(*) AS n FROM inventory_events WHERE command_id IS NOT NULL')[0].n).toBe(3);
    const committed = facts();
    expect(await patch(combined)).toEqual({ status: 200, json: { ...response.json, idempotentReplay: true } });
    expect(facts()).toEqual(committed);
    expect((await patch({ version: 3, category: 'meat', quantity: 400 }, 'patch-next-key')).status).toBe(200);
    const later = facts();
    expect(await patch(combined)).toEqual({ status: 200, json: { ...response.json, idempotentReplay: true } });
    expect(facts()).toEqual(later);
  });

  it.each([
    ['quantity', 501], ['category', 'meat'], ['storage', 'pantry'], ['expiryDate', null], ['version', 2],
    ['name', 'New name'], ['unit', 'kg'],
  ])('rejects changed %s under the same key without mutation', async (field, value) => {
    expect((await patch(combined)).status).toBe(200);
    const committed = facts();
    expect(await patch({ ...combined, [field as string]: value })).toMatchObject({ status: 409,
      json: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(facts()).toEqual(committed);
  });

  it.each(['name', 'quantity', 'unit', 'category', 'storage', 'expiryDate'])('compares presence of %s in both directions', async (field) => {
    const values: Record<string, unknown> = { name: 'Rice', quantity: 2000, unit: 'g', category: 'grain', storage: 'pantry', expiryDate: null };
    const body = { version: 1, ...values };
    expect((await patch(body)).status).toBe(200);
    const absent: Record<string, unknown> = { ...body };
    delete absent[field];
    const committed = facts();
    expect(await patch(absent)).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(facts()).toEqual(committed);
    const next = { ...absent, version: row().version };
    expect((await patch(next, 'patch-presence-key')).status).toBe(200);
    const second = facts();
    expect(await patch({ ...next, [field]: values[field] }, 'patch-presence-key'))
      .toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(facts()).toEqual(second);
  });

  it('moves on a storage-only PATCH and replays its complete receipt pair', async () => {
    const body = { version: 1, storage: 'freezer' };
    const result = await patch(body);
    expect(result.status).toBe(200);
    expect(row()).toMatchObject({ quantity: 2000, category: 'grain', storage: 'freezer', version: 3 });
    expect(lot()).toMatchObject({ quantity_milli: 2000000, version: 3, legacy_version: 3 });
    const committed = facts();
    expect(await patch(body)).toEqual({ status: 200, json: { ...result.json, idempotentReplay: true } });
    expect(facts()).toEqual(committed);
  });

  it('preserves strict stale CAS for a distinct key and household isolation on replay', async () => {
    expect((await patch(combined)).status).toBe(200);
    const committed = facts();
    expect(await patch(combined, 'patch-distinct-key')).toMatchObject({ status: 409, json: { code: 'CONFLICT' } });
    expect(await patch(combined, 'patch-semantic-key', foreignToken)).toMatchObject({ status: 404, json: { code: 'NOT_FOUND' } });
    expect(facts()).toEqual(committed);
  });

  it('retains normalized name/unit edits and all 200 characters of valid key identity', async () => {
    const body = { version: '1', name: '  Custom rice  ', quantity: '1.5', unit: 'kg', category: '  custom  ' };
    const key = 'k'.repeat(200);
    const result = await patch(body, key);
    expect(result.status).toBe(200);
    expect(row()).toMatchObject({ name: 'Custom rice', quantity: 1500, unit: 'g', category: 'custom', version: 2 });
    const committed = facts();
    expect(await patch({ ...body, version: 1, name: 'Custom rice', quantity: 1.5, category: 'custom' }, key))
      .toEqual({ status: 200, json: { ...result.json, idempotentReplay: true } });
    expect(facts()).toEqual(committed);
  });

  it.each(['category', 'move', 'poststate'])('rolls back the entire combined PATCH on %s failure', async (failure) => {
    if (failure === 'category') db.seed(`CREATE TRIGGER fail_patch_category BEFORE UPDATE OF category ON inventory_items
      WHEN NEW.id = 'patch-rice' AND NEW.category = 'vegetable' BEGIN SELECT RAISE(IGNORE); END;`);
    if (failure === 'move') db.seed(`CREATE TRIGGER fail_patch_move BEFORE INSERT ON inventory_commands
      WHEN NEW.command_type = 'MOVE' BEGIN SELECT RAISE(ABORT, 'Injected MOVE failure'); END;`);
    if (failure === 'poststate') db.seed(`CREATE TRIGGER corrupt_patch_metadata AFTER UPDATE ON inventory_items
      WHEN NEW.id = 'patch-rice' AND NEW.category = 'vegetable' BEGIN
      UPDATE inventory_items SET category = 'unexpected' WHERE id = NEW.id; END;`);
    const before = facts();
    expect((await patch(combined)).status).not.toBe(200);
    expect(facts()).toEqual(before);
  });

  it.each([false, true])('fences controlled same-key races (changed intent: %s)', async (changed) => {
    let reached!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((done) => { reached = done; });
    const held = new Promise<void>((done) => { release = done; });
    db.hooks.beforeBatch = async (statements) => {
      if (statements.some(({ sql }) => sql.includes('INSERT INTO inventory_commands'))) {
        db.hooks = {};
        reached();
        await held;
      }
    };
    const contender = patch(changed ? { ...combined, storage: 'pantry' } : combined);
    await Promise.race([arrived, contender.then(() => { throw new Error('Missing write barrier'); })]);
    const winner = await patch(combined);
    expect(winner.status).toBe(200);
    const committed = facts();
    release();
    expect(await contender).toMatchObject(changed
      ? { status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } }
      : { status: 200, json: { idempotentReplay: true, item: winner.json.item } });
    expect(facts()).toEqual(committed);
  });

  it('recovers a lost committed batch response from receipt evidence', async () => {
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
});
