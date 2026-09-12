import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeInventoryLotCommand } from '../../packages/db/src/inventory-lot-commands';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import { assertProjectionParity } from '../../packages/db/src/inventory-read-authority';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { inventoryRoutes } from '../../src/worker/routes/inventory';
import { recipeRoutes } from '../../src/worker/routes/recipes';
import { weekRoutes } from '../../src/worker/routes/week';
import type { AuthContext, Env } from '../../src/worker/types';
import { signJwt } from '../../src/worker/utils/jwt';
import { SqliteD1 } from '../helpers/sqlite-d1';

// T12 route-level closed-loop proof: the REAL Hono route handlers
// (POST /week/plans/:id/shopping/complete, POST /recipes/:id/cook/complete,
// GET /inventory) drive the T09 adapters and the T11 read funnel. A stale KV
// is injected everywhere to prove adopted households never read or refresh it.
const scope = { householdId: 'loop-household', actorId: 'loop-user' };
const foreign = { householdId: 'other-household', actorId: 'other-user' };
const secret = 'test-only-closed-loop-route-secret';
const now = '2026-09-12T10:00:00Z';
const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
app.use('*', authMiddleware);
app.route('/', inventoryRoutes);
app.route('/', recipeRoutes);
app.route('/', weekRoutes);
let db: SqliteD1;
let token: string;
let foreignToken: string;
let kvWrites: string[];
const staleKv = () => ({
  get: async () => JSON.stringify([{ id: 'stale-kv-row', quantity: 999 }]),
  put: async (key: string) => { kvWrites.push(key); },
  delete: async () => {},
});

beforeEach(async () => {
  db = new SqliteD1();
  kvWrites = [];
  db.seed(`INSERT INTO users(id) VALUES ('loop-user'), ('other-user');
    INSERT INTO households(id,name,created_by) VALUES
      ('loop-household','Loop','loop-user'), ('other-household','Other','other-user');
    INSERT INTO household_members(id,household_id,user_id,role) VALUES
      ('loop-member','loop-household','loop-user','owner'),
      ('other-member','other-household','other-user','owner');`);
  token = await signJwt({ sub: scope.actorId, hid: scope.householdId, typ: 'access',
    exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
  foreignToken = await signJwt({ sub: foreign.actorId, hid: foreign.householdId, typ: 'access',
    exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
  // Explicit, receipted adoption (never implied by a read): both households are
  // adopted-but-empty until a test creates lots.
  for (const household of [scope, foreign]) {
    await backfillLegacyInventory(db, household.householdId);
    await executeInventoryAdoption(db, household, {}, now);
  }
});
afterEach(() => db.close());

async function createLot(lotId: string, patch: Record<string, unknown> = {}, household = scope) {
  const location = db.query<{ id: string }>('SELECT id FROM storage_locations WHERE household_id = ? AND type = ?', household.householdId, 'FRIDGE')[0];
  return executeInventoryLotCommand(db, household, `create-${lotId}`, {
    type: 'CREATE', lotId, ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 10, unit: 'piece',
    storageLocationId: location.id, sourceType: 'MANUAL', ...patch }, now);
}
async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, bearer = token) {
  const response = await app.fetch(new Request(`https://loop.example${path}`, {
    method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { DB: db, ENVIRONMENT: 'test', JWT_SECRET: secret, WEEK_SCHEMA_MODE: 'legacy', CACHE: staleKv() } as unknown as Env);
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
const facts = () => ({
  lots: db.query('SELECT id, quantity_milli, state, version FROM inventory_lots ORDER BY id'),
  commands: db.query<{ client_key: string }>('SELECT client_key FROM inventory_commands ORDER BY client_key').map((r) => r.client_key),
  events: db.query<{ n: number }>('SELECT count(*) AS n FROM inventory_events')[0].n,
  items: db.query("SELECT id, quantity, unit, storage, version FROM inventory_items WHERE household_id IN ('loop-household','other-household') ORDER BY id"),
  cooked: db.query('SELECT id FROM cooked_meals ORDER BY id'),
  imports: db.query('SELECT client_key, status FROM shopping_import_commands ORDER BY client_key'),
});
const readItems = async (bearer = token) => {
  const result = await request('GET', '/inventory', undefined, {}, bearer);
  expect(result.status).toBe(200);
  return result.json.items as Array<Record<string, unknown>>;
};

describe('T12 route-level closed loop — adopted shopping import', () => {
  async function planWithShopping() {
    const generated = await request('POST', '/week/plans', { startDate: '2026-09-14', householdSize: 2,
      mealSlotsPreset: 'dinner_only', priorities: ['budget'], shoppingFrequency: 'once' });
    expect(generated.status).toBe(201);
    const plan = generated.json.plan as { id: string };
    const shopping = await request('GET', `/week/plans/${plan.id}/shopping`);
    expect(shopping.status).toBe(200);
    const items = shopping.json.items as { ingredientId: string }[];
    expect(items.length).toBeGreaterThan(0);
    return { planId: plan.id, ingredientId: items[0].ingredientId };
  }

  it('request → adapter → T09 → lot → T11: creates stock once, replays exactly, conflicts on altered same key, never legacy batch or KV', async () => {
    const { planId, ingredientId } = await planWithShopping();
    const before = await readItems();
    expect(before).toEqual([]); // adopted-empty: [] not the stale KV
    const first = await request('POST', `/week/plans/${planId}/shopping/complete`,
      { items: [{ ingredientId }] }, { 'Idempotency-Key': 'loop-shopping-key-1' });
    expect(first).toMatchObject({ status: 200, json: { success: true } });
    const committed = facts();
    expect(committed.lots).toHaveLength(1);
    expect(committed.lots[0]).toMatchObject({ state: 'ACTIVE', version: 1 });
    expect(committed.imports).toEqual([{ client_key: expect.stringContaining('loop-shopping-key-1'), status: 'completed' }]);
    expect(db.query("SELECT * FROM inventory_events WHERE event_type = 'T09_WRITER_FENCE'")).toEqual([]); // no legacy batch attempted
    // T11 read reflects the lot; the stale KV was neither served nor refreshed.
    const after = await readItems();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ ingredientId, lotId: committed.lots[0].id, state: 'ACTIVE' });
    // Plan/rate-limit keys may be cached; authority inventory never is.
    expect(kvWrites.filter((key) => key.startsWith('inv_'))).toEqual([]);
    expect(await assertProjectionParity(db, scope)).toEqual([]);
    // Exact retry: replay, nothing duplicated.
    const retry = await request('POST', `/week/plans/${planId}/shopping/complete`,
      { items: [{ ingredientId }] }, { 'Idempotency-Key': 'loop-shopping-key-1' });
    expect(retry).toMatchObject({ status: 200, json: { success: true, idempotentReplay: true } });
    expect(facts()).toEqual(committed);
    // Altered payload under the same key: conflict, nothing changes.
    const altered = await request('POST', `/week/plans/${planId}/shopping/complete`,
      { items: [] }, { 'Idempotency-Key': 'loop-shopping-key-1' });
    expect([404, 409]).toContain(altered.status);
    if (altered.status === 409) expect(altered.json.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(facts()).toEqual(committed);
  });

  it('cross-tenant: household B cannot import against A\'s plan (not-found, no mutation)', async () => {
    const { planId, ingredientId } = await planWithShopping();
    const before = facts();
    const result = await request('POST', `/week/plans/${planId}/shopping/complete`,
      { items: [{ ingredientId }] }, { 'Idempotency-Key': 'foreign-shopping-key-1' }, foreignToken);
    expect(result).toMatchObject({ status: 404, json: { code: 'NOT_FOUND' } });
    expect(facts()).toEqual(before);
  });
});

describe('T12 route-level closed loop — adopted cook completion', () => {
  it('POST /recipes/:id/cook/complete resolves authority, FEFO-consumes through T09, writes the cooked receipt, rereads poststate, replays, rejects altered key', async () => {
    await createLot('eggs-early', { expiryAt: '2026-09-14', expiryKind: 'KNOWN' });
    await createLot('eggs-late', { expiryAt: '2026-09-30', expiryKind: 'KNOWN' });
    const body = { servings: 2, deductions: [{ ingredientId: 'CHICKEN_EGG', quantityDeducted: 14, unit: 'piece' }] };
    const first = await request('POST', '/recipes/gl-03/cook/complete', body, { 'Idempotency-Key': 'loop-cook-key-1' });
    expect(first).toMatchObject({ status: 200, json: { success: true } });
    // Exact poststate from the route response (T11 reread) and from authority.
    const returned = first.json.inventory as Array<Record<string, unknown>>;
    expect(returned.map((item) => [item.lotId, item.quantity, item.version])).toEqual([['eggs-late', 6, 2]]);
    const committed = facts();
    expect(committed.lots).toEqual([
      { id: 'eggs-early', quantity_milli: 0, state: 'CONSUMED', version: 2 },
      { id: 'eggs-late', quantity_milli: 6000, state: 'ACTIVE', version: 2 },
    ]);
    expect(committed.cooked).toHaveLength(1);
    expect(committed.commands.filter((key) => key.startsWith('cook:'))).toHaveLength(2);
    expect(await assertProjectionParity(db, scope)).toEqual([]);
    expect(kvWrites.filter((key) => key.startsWith('inv_'))).toEqual([]);
    // Response-loss retry: replay, no second consumption.
    const retry = await request('POST', '/recipes/gl-03/cook/complete', body, { 'Idempotency-Key': 'loop-cook-key-1' });
    expect(retry).toMatchObject({ status: 200, json: { success: true, idempotentReplay: true } });
    expect(facts()).toEqual(committed);
    // Same key, altered semantics: conflict.
    const altered = await request('POST', '/recipes/gl-03/cook/complete',
      { servings: 3, deductions: [{ ingredientId: 'CHICKEN_EGG', quantityDeducted: 1, unit: 'piece' }] },
      { 'Idempotency-Key': 'loop-cook-key-1' });
    expect(altered).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(facts()).toEqual(committed);
    // GET /inventory (T11) shows only the active lot.
    expect((await readItems()).map((item) => [item.lotId, item.quantity])).toEqual([['eggs-late', 6]]);
  });

  it('insufficient authority stock fails closed with a domain code and no partial consumption', async () => {
    await createLot('eggs', { quantity: 3 });
    const result = await request('POST', '/recipes/gl-03/cook/complete',
      { servings: 2, deductions: [{ ingredientId: 'CHICKEN_EGG', quantityDeducted: 14, unit: 'piece' }] },
      { 'Idempotency-Key': 'loop-cook-short-1' });
    expect(result).toMatchObject({ status: 409, json: { code: 'INSUFFICIENT_INVENTORY' } });
    expect(facts().lots).toEqual([{ id: 'eggs', quantity_milli: 3000, state: 'ACTIVE', version: 1 }]);
    expect(facts().cooked).toEqual([]);
  });

  it('cross-tenant: household B cooking cannot consume A\'s lots (fails on its own empty authority, A untouched)', async () => {
    await createLot('eggs');
    const before = facts();
    const result = await request('POST', '/recipes/gl-03/cook/complete',
      { servings: 2, deductions: [{ ingredientId: 'CHICKEN_EGG', quantityDeducted: 2, unit: 'piece' }] },
      { 'Idempotency-Key': 'foreign-cook-key-1' }, foreignToken);
    expect(result).toMatchObject({ status: 409, json: { code: 'INSUFFICIENT_INVENTORY' } });
    expect(facts().lots).toEqual(before.lots);
    expect(await readItems(foreignToken)).toEqual([]);
  });
});
