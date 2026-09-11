import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeInventoryLotCommand } from '../../packages/db/src/inventory-lot-commands';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import { runLegacyInventoryBatch } from '../../packages/db/src/inventory-writer-fence';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { inventoryRoutes } from '../../src/worker/routes/inventory';
import { recipeRoutes } from '../../src/worker/routes/recipes';
import { scanRoutes } from '../../src/worker/routes/scans';
import { weekRoutes } from '../../src/worker/routes/week';
import type { AuthContext, Env } from '../../src/worker/types';
import { signJwt } from '../../src/worker/utils/jwt';
import { SqliteD1 } from '../helpers/sqlite-d1';

const scope = { householdId: 'fence-household', actorId: 'fence-user' };
const secret = 'test-only-inventory-writer-fence-secret';
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
  db.seed(`INSERT INTO users(id) VALUES ('fence-user'), ('foreign-user');
    INSERT INTO households(id,name,created_by) VALUES
      ('fence-household','Fence test','fence-user'), ('foreign-household','Foreign','foreign-user');
    INSERT INTO household_members(id,household_id,user_id,role) VALUES
      ('fence-member','fence-household','fence-user','owner'),
      ('foreign-member','foreign-household','foreign-user','owner');`);
  token = await signJwt({ sub: scope.actorId, hid: scope.householdId, typ: 'access',
    exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
  await backfillLegacyInventory(db, scope.householdId);
});
afterEach(() => db.close());

async function native(householdId = scope.householdId, actorId = scope.actorId) {
  if (householdId !== scope.householdId) await backfillLegacyInventory(db, householdId);
  const location = db.query<{ id: string }>('SELECT id FROM storage_locations WHERE household_id = ? AND type = ?', householdId, 'FRIDGE')[0];
  return executeInventoryLotCommand(db, { householdId, actorId }, `native-${householdId}`, {
    type: 'CREATE', lotId: `native-${householdId}`, ingredientId: 'CHICKEN_EGG', rawName: 'Eggs',
    quantity: 10, unit: 'piece', storageLocationId: location.id, sourceType: 'MANUAL',
  }, now);
}
async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.fetch(new Request(`https://fence.example${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { DB: db, ENVIRONMENT: 'test', JWT_SECRET: secret, WEEK_SCHEMA_MODE: 'legacy' });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
function facts() {
  return Object.fromEntries(['households', 'inventory_items', 'inventory_lots', 'inventory_commands',
    'inventory_events', 'storage_locations', 'scans', 'scan_items', 'cooked_meals', 'shopping_runs', 'shopping_run_items']
    .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY id`)]));
}
const manualBody = { id: 'new-manual', ingredientId: 'CHICKEN_EGG', name: 'Eggs', quantity: 1,
  unit: 'piece', category: 'egg', storage: 'fridge', dataSource: 'manual' };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('T09F legacy writer activation fences', () => {
  it.each(['create', 'edit', 'discard'] as const)('refuses manual %s without changing native authority', async (operation) => {
    await native();
    const before = facts();
    const result = operation === 'create' ? await request('POST', '/inventory', manualBody)
      : operation === 'edit' ? await request('PATCH', '/inventory/native-fence-household', { quantity: 4, version: 1 })
        : await request('DELETE', '/inventory/native-fence-household', undefined, { 'If-Match': '1' });
    expect(result).toMatchObject({ status: 409, json: { code: 'INVENTORY_AUTHORITY_REQUIRED' } });
    expect(facts()).toEqual(before);
  });

  it('rolls back reviewed scan values and confirmation with refused stock writes', async () => {
    await native();
    db.seed(`INSERT INTO scans(id,user_id,household_id,status) VALUES ('fence-scan','fence-user','fence-household','ready');
      INSERT INTO scan_items(id,scan_id,raw_name,canonical_id,estimated_quantity,unit,category,storage)
      VALUES ('fence-scan-item','fence-scan','Eggs','CHICKEN_EGG',2,'piece','egg','fridge');`);
    const before = facts();
    const result = await request('POST', '/scans/fence-scan/confirm', {
      items: [{ id: 'fence-scan-item', name: 'Reviewed eggs', quantity: 3, unit: 'piece' }],
    });
    expect(result).toMatchObject({ status: 409, json: { code: 'INVENTORY_AUTHORITY_REQUIRED' } });
    expect(facts()).toEqual(before);
  });

  it.each([{ deductions: [] }, { deductions: [{ ingredientId: 'CHICKEN_EGG', quantityDeducted: 2, unit: 'piece' }] }])(
    'does not complete cooking outside authority, including no-effect cooking ($deductions)', async ({ deductions }) => {
      await native();
      const before = facts();
      const result = await request('POST', '/recipes/gl-03/cook/complete', { servings: 2, deductions },
        { 'Idempotency-Key': 'fence-cooking-key' });
      expect(result).toMatchObject({ status: 409, json: { code: 'INVENTORY_AUTHORITY_REQUIRED' } });
      expect(facts()).toEqual(before);
    });

  it('does not import shopping stock or completion rows; retains a retryable failed lease', async () => {
    await native();
    const generated = await request('POST', '/week/plans', { startDate: '2026-09-14', householdSize: 2,
      mealSlotsPreset: 'dinner_only', priorities: ['budget'], shoppingFrequency: 'once' });
    expect(generated.status).toBe(201);
    const plan = generated.json.plan as { id: string };
    const shopping = await request('GET', `/week/plans/${plan.id}/shopping`);
    expect(shopping.status).toBe(200);
    const item = (shopping.json.items as { ingredientId: string }[])[0];
    expect(item).toBeDefined();
    const before = facts();
    const result = await request('POST', `/week/plans/${plan.id}/shopping/complete`,
      { items: [{ ingredientId: item.ingredientId }] }, { 'Idempotency-Key': 'fence-shopping-key' });
    expect(result).toMatchObject({ status: 409, json: { code: 'INVENTORY_AUTHORITY_REQUIRED' } });
    expect(facts()).toEqual(before);
    expect(db.query('SELECT status FROM shopping_import_commands WHERE household_id = ?', scope.householdId))
      .toEqual([{ status: 'failed' }]);
  });

  it('allows legacy stock in another household while native authority exists elsewhere', async () => {
    await native('foreign-household', 'foreign-user');
    const result = await request('POST', '/inventory', manualBody);
    expect(result.status).toBe(201);
    expect(db.query('SELECT quantity FROM inventory_items WHERE id = ?', 'new-manual')).toEqual([{ quantity: 1 }]);
    expect(db.query("SELECT * FROM inventory_events WHERE event_type = 'T09_WRITER_FENCE'")).toEqual([]);
  });

  it('known-winner native activation fences an already prepared legacy batch', async () => {
    const reached = deferred();
    const release = deferred();
    db.hooks.beforeBatch = async (statements) => {
      if (statements.some(({ sql }) => sql.includes('T09_WRITER_FENCE'))) {
        reached.resolve();
        await release.promise;
      }
    };
    const legacy = request('POST', '/inventory', manualBody);
    await reached.promise;
    await native();
    const winner = facts();
    release.resolve();
    expect(await legacy).toMatchObject({ status: 409, json: { code: 'INVENTORY_AUTHORITY_REQUIRED' } });
    expect(facts()).toEqual(winner);
  });

  it('known-winner legacy insertion invalidates a prepared first native command', async () => {
    const reached = deferred();
    const release = deferred();
    db.hooks.beforeBatch = async (statements) => {
      if (statements.some(({ sql }) => sql.startsWith('INSERT INTO inventory_commands'))) {
        reached.resolve();
        await release.promise;
      }
    };
    const pending = native();
    const failure = expect(pending).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    await reached.promise;
    expect((await request('POST', '/inventory', manualBody)).status).toBe(201);
    const winner = facts();
    release.resolve();
    await failure;
    expect(facts()).toEqual(winner);
  });

  it('retains atomic rollback for an ordinary legacy batch failure', async () => {
    const before = facts();
    await expect(runLegacyInventoryBatch(db, scope.householdId, [
      db.prepare("INSERT INTO inventory_items(id,household_id,name,quantity,unit) VALUES ('late-test',?,'Eggs',1,'piece')").bind(scope.householdId),
      db.prepare('INSERT INTO inventory_events(id,household_id,inventory_item_id,event_type,quantity_delta,unit) VALUES (?, ?, NULL, ?, 0, ?)')
        .bind('late-failure', scope.householdId, 'ADD', 'piece'),
    ])).rejects.toThrow();
    expect(facts()).toEqual(before);
  });

  it('rejects stale scan preparation after a metadata/unit edit without confirming drafts', async () => {
    expect((await request('POST', '/inventory', manualBody)).status).toBe(201);
    db.seed(`INSERT INTO scans(id,user_id,household_id,status) VALUES ('stale-scan','fence-user','fence-household','ready');
      INSERT INTO scan_items(id,scan_id,raw_name,canonical_id,estimated_quantity,unit,category,storage)
      VALUES ('stale-scan-item','stale-scan','Eggs','CHICKEN_EGG',2,'piece','egg','fridge');`);
    const reached = deferred();
    const release = deferred();
    db.hooks.beforeBatch = async (statements) => {
      if (statements.some(({ sql }) => sql.includes('T09_SNAPSHOT_FENCE'))) {
        reached.resolve();
        await release.promise;
      }
    };
    const scan = request('POST', '/scans/stale-scan/confirm', {
      items: [{ id: 'stale-scan-item', name: 'Reviewed eggs', quantity: 3, unit: 'piece' }],
    });
    await reached.promise;
    db.execute("UPDATE inventory_items SET unit = 'pack', category = 'other', version = version + 1 WHERE id = 'new-manual'");
    const winner = facts();
    release.resolve();
    expect(await scan).toMatchObject({ status: 409, json: { code: 'INVENTORY_CONFLICT' } });
    expect(facts()).toEqual(winner);
  });

  it('rejects stale shopping preparation after a new stock phantom without completing import', async () => {
    const generated = await request('POST', '/week/plans', { startDate: '2026-09-14', householdSize: 2,
      mealSlotsPreset: 'dinner_only', priorities: ['budget'], shoppingFrequency: 'once' });
    expect(generated.status).toBe(201);
    const plan = generated.json.plan as { id: string };
    const shopping = await request('GET', `/week/plans/${plan.id}/shopping`);
    const item = (shopping.json.items as { ingredientId: string }[])[0];
    const reached = deferred();
    const release = deferred();
    db.hooks.beforeBatch = async (statements) => {
      if (statements.some(({ sql }) => sql.includes('T09_SNAPSHOT_FENCE'))) {
        reached.resolve();
        await release.promise;
      }
    };
    const pending = request('POST', `/week/plans/${plan.id}/shopping/complete`,
      { items: [{ ingredientId: item.ingredientId }] }, { 'Idempotency-Key': 'stale-shopping-key' });
    await reached.promise;
    expect((await request('POST', '/inventory', manualBody)).status).toBe(201);
    const winner = facts();
    release.resolve();
    expect(await pending).toMatchObject({ status: 409, json: { code: 'INVENTORY_CONFLICT' } });
    expect(facts()).toEqual(winner);
    expect(db.query('SELECT status FROM shopping_import_commands WHERE household_id = ?', scope.householdId))
      .toEqual([{ status: 'failed' }]);
  });
});
