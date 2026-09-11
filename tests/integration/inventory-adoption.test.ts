import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import { executeInventoryLotCommand } from '../../packages/db/src/inventory-lot-commands';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { inventoryRoutes } from '../../src/worker/routes/inventory';
import { recipeRoutes } from '../../src/worker/routes/recipes';
import { scanRoutes } from '../../src/worker/routes/scans';
import { weekRoutes } from '../../src/worker/routes/week';
import type { AuthContext, Env } from '../../src/worker/types';
import { signJwt } from '../../src/worker/utils/jwt';
import { SqliteD1 } from '../helpers/sqlite-d1';

const scope = { householdId: 'adopt-household', actorId: 'adopt-user' };
const secondHousehold = { householdId: 'other-household', actorId: 'other-user' };
const secret = 'test-only-inventory-adoption-secret';
const now = '2026-09-11T10:00:00Z';
const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
app.use('*', authMiddleware);
app.route('/', inventoryRoutes);
app.route('/', recipeRoutes);
app.route('/', scanRoutes);
app.route('/', weekRoutes);

let db: SqliteD1;
let token: string;

beforeEach(async () => {
  db = new SqliteD1();
  db.seed(`INSERT INTO users(id) VALUES ('adopt-user'), ('other-user');
    INSERT INTO households(id, name, created_by, created_at, updated_at) VALUES
      ('adopt-household', 'Adopt', 'adopt-user', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      ('other-household', 'Other', 'other-user', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
    INSERT INTO household_members(id, household_id, user_id, role) VALUES
      ('adopt-member', 'adopt-household', 'adopt-user', 'owner'),
      ('other-member', 'other-household', 'other-user', 'owner');
    INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit, category, storage,
      expiry_date, expiry_kind, expiry_source, created_at, updated_at, added_date, data_source)
    VALUES ('rice-row', 'adopt-household', 'RICE', 'Rice', 2, 'kg', 'grain', 'pantry',
      NULL, 'unknown', 'unknown', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', 'manual');`);
  token = await signJwt({ sub: scope.actorId, hid: scope.householdId, typ: 'access',
    exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
});
afterEach(() => db.close());

async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {},
  bearer = token) {
  const response = await app.fetch(new Request(`https://adopt.example${path}`, {
    method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { DB: db, ENVIRONMENT: 'test', JWT_SECRET: secret, WEEK_SCHEMA_MODE: 'legacy' });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

function facts() {
  return Object.fromEntries(['households', 'inventory_items', 'inventory_lots', 'inventory_commands',
    'inventory_events', 'inventory_adoption_receipts', 'storage_locations', 'scans', 'scan_items',
    'cooked_meals', 'shopping_runs', 'shopping_run_items', 'shopping_import_commands']
    .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY id`)]));
}

function lots() {
  return db.query<{ id: string; legacy_item_id: string | null; state: string; quantity_milli: number;
    canonical_unit: string; version: number; legacy_version: number; source_type: string }>(
    'SELECT id, legacy_item_id, state, quantity_milli, canonical_unit, version, legacy_version, source_type FROM inventory_lots ORDER BY id');
}

async function adopt(terminalEvidence?: unknown, bearer = token) {
  return request('POST', '/inventory/adopt', terminalEvidence ? { terminalEvidence } : {}, {}, bearer);
}

describe('T09F atomic adoption authority', () => {
  it('activates a backfilled household atomically with preserved identities', async () => {
    await backfillLegacyInventory(db, scope.householdId);
    const beforeRows = db.query('SELECT * FROM inventory_items ORDER BY id');
    const result = await adopt();
    expect(result.status).toBe(201);
    expect(result.json.adoption).toMatchObject({
      householdId: scope.householdId, emptyHousehold: false, mappedLotCount: 1, createdSnapshotCount: 0,
    });
    const mapped = lots();
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      id: 't08-legacy:rice-row', legacy_item_id: 'rice-row', state: 'ACTIVE',
      quantity_milli: 2000000, canonical_unit: 'g', legacy_version: 1,
    });
    // Display unit stays kg until a native command rewrites the projection.
    expect(db.query("SELECT quantity, unit FROM inventory_items WHERE household_id = ?", scope.householdId)[0])
      .toEqual({ quantity: 2, unit: 'kg' });
    expect(beforeRows).toEqual(db.query('SELECT * FROM inventory_items ORDER BY id'));
    expect(db.query('SELECT COUNT(*) AS n FROM inventory_adoption_receipts')[0].n).toBe(1);
    const adoptedVersion = db.query<{ inventory_version: number }>(
      'SELECT inventory_version FROM households WHERE id = ?', scope.householdId)[0];
    expect(adoptedVersion.inventory_version).toBeGreaterThan(1);
  });

  it('creates missing snapshots when a household adopts without prior backfill', async () => {
    // No backfill ran: adoption itself materializes locations and snapshots.
    const result = await adopt();
    expect(result.status).toBe(201);
    expect(result.json.adoption).toMatchObject({
      emptyHousehold: false, mappedLotCount: 1, createdSnapshotCount: 1, createdLocationCount: 3,
    });
    expect(lots()).toHaveLength(1);
    expect(db.query('SELECT COUNT(*) AS n FROM storage_locations WHERE household_id = ?', scope.householdId)[0].n).toBe(3);
  });

  it('adopts an empty household with durable explicit activation evidence', async () => {
    db.seed("DELETE FROM inventory_items WHERE id = 'rice-row'");
    const result = await adopt();
    expect(result.status).toBe(201);
    expect(result.json.adoption).toMatchObject({ emptyHousehold: true, mappedLotCount: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM inventory_adoption_receipts')[0].n).toBe(1);
    // Never-adopted empty households carry no receipt; the adopted one does,
    // and it keeps working through the native writer adapters.
    const add = await request('POST', '/inventory', { name: 'Eggs', quantity: 1, unit: 'piece',
      category: 'egg', storage: 'fridge', dataSource: 'manual' });
    expect(add.status).toBe(201);
    expect(lots()[0]).toMatchObject({ state: 'ACTIVE', quantity_milli: 1000, legacy_item_id: expect.any(String) });
  });

  it('requires explicit terminal evidence for historical zero rows', async () => {
    db.seed("UPDATE inventory_items SET quantity = 0 WHERE id = 'rice-row'");
    const missing = await adopt();
    expect(missing).toMatchObject({ status: 422, json: { code: 'TERMINAL_EVIDENCE_REQUIRED' } });
    expect(db.query('SELECT COUNT(*) AS n FROM inventory_adoption_receipts')[0].n).toBe(0);
    const withEvidence = await adopt([{ legacyItemId: 'rice-row', state: 'DISCARDED', reason: 'Threw away' }]);
    expect(withEvidence.status).toBe(201);
    expect(lots()[0]).toMatchObject({ state: 'DISCARDED', quantity_milli: 0, legacy_item_id: 'rice-row' });
    expect(withEvidence.json.adoption).toMatchObject({
      effects: [{ legacyItemId: 'rice-row', state: 'DISCARDED', terminalEvidence: { state: 'DISCARDED' } }],
    });
  });

  it('replays the same adoption receipt and conflicts on a changed payload', async () => {
    await backfillLegacyInventory(db, scope.householdId);
    const first = await adopt();
    expect(first.status).toBe(201);
    const replay = await adopt();
    expect(replay.status).toBe(200);
    expect(replay.json.idempotentReplay).toBe(true);
    expect(replay.json.adoption).toEqual(first.json.adoption);
    const changed = await adopt([{ legacyItemId: 'rice-row', state: 'CONSUMED', reason: 'Different' }]);
    expect(changed).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(db.query('SELECT COUNT(*) AS n FROM inventory_adoption_receipts')[0].n).toBe(1);
  });

  it('leaves no activation evidence when the batch loses a stale race', async () => {
    await backfillLegacyInventory(db, scope.householdId);
    // A concurrent legacy write between snapshot and batch invalidates the CAS.
    // Pause between the executor snapshot and the activation batch: the
    // injection must invalidate the CAS, not the pre-read snapshot.
    db.hooks.beforeBatch = async (statements) => {
      if (statements.some(({ sql }) => sql.includes('INTO inventory_adoption_receipts'))) {
        db.hooks = {};
        db.seed("UPDATE inventory_items SET quantity = 3 WHERE id = 'rice-row'");
      }
    };
    const result = await adopt();
    expect(result).toMatchObject({ status: 409, json: { code: 'CONFLICT' } });
    expect(db.query('SELECT COUNT(*) AS n FROM inventory_adoption_receipts')[0].n).toBe(0);
    // The failed activation leaves the backfill snapshot exactly as it was.
    expect(lots()).toHaveLength(1);
    expect(lots()[0]).toMatchObject({ legacy_item_id: null, source_type: 'LEGACY_BACKFILL' });
    expect(db.query("SELECT quantity FROM inventory_items WHERE id = 'rice-row'")[0]).toEqual({ quantity: 3 });
  });

  it('keeps adoption single-winner under concurrency', async () => {
    await backfillLegacyInventory(db, scope.householdId);
    const release = { resolve: () => {} };
    const gate = new Promise<void>((resolve) => { release.resolve = resolve; });
    let firstReached = false;
    db.hooks.beforeBatch = async (statements) => {
      if (!firstReached && statements.some(({ sql }) => sql.includes('inventory_adoption_receipts'))) {
        firstReached = true;
        await gate;
      }
    };
    const first = adopt();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await adopt();
    release.resolve();
    const firstResult = await first;
    const winners = [firstResult, second].filter((result) => result.status === 201);
    expect(winners).toHaveLength(1);
    expect(db.query('SELECT COUNT(*) AS n FROM inventory_adoption_receipts')[0].n).toBe(1);
    expect(lots().every((lot) => lot.legacy_item_id === 'rice-row')).toBe(true);
  });

  it('refuses a stale legacy batch after activation commits (G12)', async () => {
    await backfillLegacyInventory(db, scope.householdId);
    const reached = { resolve: () => {} };
    const gate = new Promise<void>((resolve) => { reached.resolve = resolve; });
    db.hooks.beforeBatch = async (statements) => {
      if (statements.some(({ sql }) => sql.includes('INTO inventory_items'))) {
        db.hooks = {};
        await gate;
      }
    };
    const legacyAdd = request('POST', '/inventory', { name: 'Late eggs', quantity: 1, unit: 'piece',
      category: 'egg', storage: 'fridge', dataSource: 'manual' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await adopt();
    reached.resolve();
    expect(await legacyAdd).toMatchObject({ status: 409, json: { code: 'INVENTORY_AUTHORITY_REQUIRED' } });
  });

  it('rejects adoption when the executor scope disagrees with membership', async () => {
    const foreignToken = await signJwt({ sub: 'other-user', hid: 'other-household', typ: 'access',
      exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
    // Route adoption is household-scoped by the verified token, never by caller ids.
    const own = await adopt(undefined, foreignToken);
    expect(own.status).toBe(201);
    // A direct executor call for a household the actor does not belong to is refused.
    await expect(executeInventoryAdoption(db, { householdId: scope.householdId, actorId: 'other-user' }, {}))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.query('SELECT COUNT(*) AS n FROM inventory_adoption_receipts WHERE household_id = ?',
      scope.householdId)[0].n).toBe(0);
  });

  it('refuses to re-backfill an adopted household', async () => {
    await backfillLegacyInventory(db, scope.householdId);
    await adopt();
    await expect(backfillLegacyInventory(db, scope.householdId)).rejects.toThrow('already adopted');
  });

  it('keeps adoption receipts immutable', () => {
    db.seed(`INSERT INTO inventory_adoption_receipts
      (id, household_id, actor_id, source_inventory_version, fingerprint, result_json, created_at)
      VALUES ('r1', 'adopt-household', 'adopt-user', 1, 'fp', '{}', '${now}')`);
    expect(() => db.seed("UPDATE inventory_adoption_receipts SET fingerprint = 'x' WHERE id = 'r1'")).toThrow();
    expect(() => db.seed("DELETE FROM inventory_adoption_receipts WHERE id = 'r1'")).toThrow();
    expect(() => db.seed(`INSERT INTO inventory_adoption_receipts
      (id, household_id, actor_id, source_inventory_version, fingerprint, result_json, created_at)
      VALUES ('r2', 'adopt-household', 'adopt-user', 1, 'fp', '{}', '${now}')`)).toThrow(/UNIQUE/);
  });
});

describe('T09F adopted-household writer adapters', () => {
  beforeEach(async () => {
    await backfillLegacyInventory(db, scope.householdId);
    await adopt();
  });

  it('creates stock through the lot authority with receipt-backed replay', async () => {
    const create = await request('POST', '/inventory', { id: 'new-eggs', name: 'Eggs', quantity: 6,
      unit: 'piece', category: 'egg', storage: 'fridge', dataSource: 'manual', expiryDate: '2026-09-20' });
    expect(create.status).toBe(201);
    expect(create.json.item).toMatchObject({ id: 'new-eggs', quantity: 6, unit: 'piece' });
    const created = lots().find((lot) => lot.id === 'new-eggs');
    expect(created).toMatchObject({ legacy_item_id: 'new-eggs', state: 'ACTIVE', quantity_milli: 6000 });
    expect(db.query("SELECT COUNT(*) AS n FROM inventory_commands WHERE command_type = 'CREATE'")[0].n).toBe(1);
    expect(db.query("SELECT event_type, command_id FROM inventory_events WHERE inventory_item_id = 'new-eggs'")[0])
      .toEqual({ event_type: 'ADD', command_id: expect.any(String) });

    const replay = await request('POST', '/inventory', { id: 'new-eggs', name: 'Eggs', quantity: 6,
      unit: 'piece', category: 'egg', storage: 'fridge', dataSource: 'manual', expiryDate: '2026-09-20' });
    expect(replay).toMatchObject({ status: 200, json: { idempotentReplay: true } });
    const conflict = await request('POST', '/inventory', { id: 'new-eggs', name: 'Eggs', quantity: 9,
      unit: 'piece', category: 'egg', storage: 'fridge', dataSource: 'manual', expiryDate: '2026-09-20' });
    expect(conflict).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(db.query("SELECT COUNT(*) AS n FROM inventory_commands WHERE command_type = 'CREATE'")[0].n).toBe(1);
  });

  it('edits quantity and storage as one atomic composed commit', async () => {
    await request('POST', '/inventory', { id: 'new-eggs', name: 'Eggs', quantity: 6, unit: 'piece',
      category: 'egg', storage: 'fridge', dataSource: 'manual' });
    const patch = await request('PATCH', '/inventory/new-eggs', { quantity: 3, storage: 'freezer', version: 1 });
    expect(patch.status).toBe(200);
    expect(patch.json.item).toMatchObject({ quantity: 3, storage: 'freezer' });
    const moved = lots().find((lot) => lot.id === 'new-eggs');
    expect(moved?.state).toBe('ACTIVE');
    expect(db.query("SELECT type FROM storage_locations s JOIN inventory_lots l ON l.storage_location_id = s.id WHERE l.id = 'new-eggs'")[0])
      .toEqual({ type: 'FREEZER' });
    const stale = await request('PATCH', '/inventory/new-eggs', { quantity: 5, version: 1 });
    expect(stale).toMatchObject({ status: 409, json: { code: 'CONFLICT' } });
  });

  it('discards full stock through the authority and replays response loss', async () => {
    await request('POST', '/inventory', { id: 'new-eggs', name: 'Eggs', quantity: 6, unit: 'piece',
      category: 'egg', storage: 'fridge', dataSource: 'manual' });
    const discard = await request('DELETE', '/inventory/new-eggs', undefined, { 'If-Match': '1' });
    expect(discard.status).toBe(200);
    expect(lots().find((lot) => lot.id === 'new-eggs')).toMatchObject({ state: 'DISCARDED', quantity_milli: 0 });
    expect(db.query("SELECT quantity, freshness FROM inventory_items WHERE id = 'new-eggs'")[0])
      .toEqual({ quantity: 0, freshness: 'out_of_stock' });
    const staleVersion = db.query("SELECT version FROM inventory_items WHERE id = 'new-eggs'")[0] as { version: number };
    expect(staleVersion.version).toBe(2);
    const replay = await request('DELETE', '/inventory/new-eggs', undefined, { 'If-Match': '2' });
    expect(replay).toMatchObject({ status: 200, json: { idempotentReplay: true } });
  });

  it('confirms scans into lots with the scan transition in one batch', async () => {
    db.seed(`INSERT INTO scans(id, user_id, household_id, status) VALUES ('adopt-scan', 'adopt-user', 'adopt-household', 'ready');
      INSERT INTO scan_items(id, scan_id, raw_name, canonical_id, estimated_quantity, unit, category, storage)
      VALUES ('adopt-scan-item', 'adopt-scan', 'Eggs', 'CHICKEN_EGG', 4, 'piece', 'egg', 'fridge');`);
    const confirm = await request('POST', '/scans/adopt-scan/confirm', {
      items: [{ id: 'adopt-scan-item', name: 'Eggs', quantity: 4, unit: 'piece' }],
    });
    expect(confirm.status).toBe(200);
    expect(confirm.json.confirmedItemIds).toEqual(['adopt-scan-item']);
    expect(db.query("SELECT status FROM scans WHERE id = 'adopt-scan'")[0]).toEqual({ status: 'confirmed' });
    // The reviewed scan merges into the existing authoritative row instead of
    // double-creating stock, exactly like the legacy confirmation behavior.
    expect(lots().find((lot) => lot.legacy_item_id !== null)).toMatchObject({
      state: 'ACTIVE', quantity_milli: 4000,
    });
    const before = facts();
    const replay = await request('POST', '/scans/adopt-scan/confirm', {
      items: [{ id: 'adopt-scan-item', name: 'Eggs', quantity: 4, unit: 'piece' }],
    });
    expect(replay).toMatchObject({ status: 200, json: { idempotentReplay: true } });
    expect(facts()).toEqual(before);
  });

  it('imports shopping stock into lots and completes the durable command', async () => {
    const generated = await request('POST', '/week/plans', { startDate: '2026-09-14', householdSize: 2,
      mealSlotsPreset: 'dinner_only', priorities: ['budget'], shoppingFrequency: 'once' });
    expect(generated.status).toBe(201);
    const planId = (generated.json.plan as { id: string }).id;
    const shopping = await request('GET', `/week/plans/${planId}/shopping`);
    expect(shopping.status).toBe(200);
    const item = (shopping.json.items as { ingredientId: string }[])[0];
    expect(item).toBeDefined();
    const beforeCommands = db.query<{ n: number }>('SELECT COUNT(*) AS n FROM inventory_commands')[0].n;
    const complete = await request('POST', `/week/plans/${planId}/shopping/complete`,
      { items: [{ ingredientId: item.ingredientId }] }, { 'Idempotency-Key': 'adopt-shopping-key' });
    expect(complete.status).toBe(200);
    expect(complete.json.success).toBe(true);
    const created = db.query(`SELECT id, source_type FROM inventory_lots WHERE source_type = 'SHOPPING'`);
    expect(created.length).toBeGreaterThan(0);
    expect(db.query('SELECT status FROM shopping_import_commands WHERE household_id = ?', scope.householdId)[0])
      .toEqual({ status: 'completed' });
    const replay = await request('POST', `/week/plans/${planId}/shopping/complete`,
      { items: [{ ingredientId: item.ingredientId }] }, { 'Idempotency-Key': 'adopt-shopping-key' });
    expect(replay).toMatchObject({ status: 200, json: { idempotentReplay: true } });
    const commandCount = db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM inventory_commands WHERE household_id = ?', scope.householdId)[0];
    expect(commandCount.n).toBeGreaterThan(beforeCommands);
  });

  it('cooks with FEFO-ordered multi-lot deductions and replays duplicate commands', async () => {
    await executeInventoryLotCommand(db, scope, 'cook-seed-a', {
      type: 'CREATE', lotId: 'eggs-old', ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 3,
      unit: 'piece', storageLocationId: (db.query("SELECT id FROM storage_locations WHERE type = 'FRIDGE'")[0] as { id: string }).id,
      sourceType: 'MANUAL', expiryAt: '2026-09-10', expiryKind: 'KNOWN',
    }, now);
    await executeInventoryLotCommand(db, scope, 'cook-seed-b', {
      type: 'CREATE', lotId: 'eggs-new', ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 5,
      unit: 'piece', storageLocationId: (db.query("SELECT id FROM storage_locations WHERE type = 'FRIDGE'")[0] as { id: string }).id,
      sourceType: 'MANUAL', expiryAt: '2026-09-25', expiryKind: 'KNOWN',
    }, now);
    const cook = await request('POST', '/recipes/gl-03/cook/complete', { servings: 2,
      deductions: [{ ingredientId: 'CHICKEN_EGG', quantityDeducted: 4, unit: 'piece' }] },
      { 'Idempotency-Key': 'adopt-cook-key' });
    expect(cook.status).toBe(200);
    expect(cook.json.success).toBe(true);
    const quantities = Object.fromEntries(lots().filter((lot) => lot.source_type !== 'LEGACY_BACKFILL')
      .map((lot) => [lot.id, lot.quantity_milli]));
    expect(quantities['eggs-old']).toBe(0);
    expect(quantities['eggs-new']).toBe(4000);
    expect(db.query("SELECT COUNT(*) AS n FROM cooked_meals")[0].n).toBe(1);
    const before = facts();
    const replay = await request('POST', '/recipes/gl-03/cook/complete', { servings: 2,
      deductions: [{ ingredientId: 'CHICKEN_EGG', quantityDeducted: 4, unit: 'piece' }] },
      { 'Idempotency-Key': 'adopt-cook-key' });
    expect(replay).toMatchObject({ status: 200, json: { idempotentReplay: true } });
    expect(facts()).toEqual(before);
  });

  it('rejects cross-tenant native commands after adoption', async () => {
    await backfillLegacyInventory(db, secondHousehold.householdId);
    await executeInventoryLotCommand(db, secondHousehold, 'other-seed', {
      type: 'CREATE', lotId: 'other-lot', ingredientId: 'RICE', rawName: 'Other rice', quantity: 1,
      unit: 'g', storageLocationId: (db.query("SELECT id FROM storage_locations WHERE household_id = 'other-household'")[0] as { id: string }).id,
      sourceType: 'MANUAL',
    }, now);
    // Foreign lot id inside adopt household's command scope.
    await expect(executeInventoryLotCommand(db, scope, 'foreign-use', {
      type: 'USE', lotId: 'other-lot', expectedVersion: 1, quantity: 1, unit: 'g',
    }, now)).rejects.toMatchObject({ code: 'LOT_NOT_FOUND' });
    // Foreign storage location.
    await expect(executeInventoryLotCommand(db, scope, 'foreign-create', {
      type: 'CREATE', lotId: 'foreign-created', ingredientId: 'RICE', rawName: 'Rice', quantity: 1,
      unit: 'g', storageLocationId: 'other-fridge-location', sourceType: 'MANUAL',
    }, now)).rejects.toMatchObject({ code: 'LOCATION_NOT_FOUND' });
  });

  it('refuses backfill-provenance commands before adoption evidence exists', async () => {
    // Fresh backfill without adoption: mapped provenance exists, receipt does not.
    const fresh = { householdId: 'fresh-household', actorId: scope.actorId };
    db.seed(`INSERT INTO households(id, name, created_by, created_at, updated_at)
      VALUES ('fresh-household', 'Fresh', 'adopt-user', '${now}', '${now}');
      INSERT INTO household_members(id, household_id, user_id, role)
      VALUES ('fresh-member', 'fresh-household', 'adopt-user', 'owner');
      INSERT INTO inventory_items(id, household_id, name, quantity, unit, storage)
      VALUES ('fresh-row', 'fresh-household', 'Rice', 1, 'kg', 'pantry')`);
    await backfillLegacyInventory(db, fresh.householdId);
    await expect(executeInventoryLotCommand(db, fresh, 'pre-adoption', {
      type: 'CREATE', lotId: 'no-evidence', ingredientId: 'RICE', rawName: 'Rice', quantity: 1,
      unit: 'g', storageLocationId: (db.query("SELECT id FROM storage_locations WHERE household_id = 'fresh-household'")[0] as { id: string }).id,
      sourceType: 'MANUAL',
    }, now)).rejects.toMatchObject({ code: 'ADOPTION_REQUIRED' });
  });
});
