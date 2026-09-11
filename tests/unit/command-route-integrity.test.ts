import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ALL_RECIPES } from '@frigo/recipes';
import { inventoryRoutes } from '../../src/worker/routes/inventory';
import { recipeRoutes } from '../../src/worker/routes/recipes';
import { shoppingRoutes } from '../../src/worker/routes/shopping';
import type { AuthContext, Env } from '../../src/worker/types';

type D1Result = {
  success: boolean;
  meta: { changes: number };
  results?: unknown[];
};

class FakeStatement {
  params: unknown[] = [];

  constructor(
    readonly db: FakeDatabase,
    readonly sql: string
  ) {}

  bind(...params: unknown[]): FakeStatement {
    this.params = params;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (await this.db.first(this)) as T | null;
  }

  async all<T>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
    return (await this.db.all(this)) as { results: T[]; success: boolean; meta: Record<string, unknown> };
  }

  async run(): Promise<D1Result> {
    return this.db.run(this);
  }
}

abstract class FakeDatabase {
  readonly batches: FakeStatement[][] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  abstract first(statement: FakeStatement): Promise<unknown>;

  async all(_statement: FakeStatement): Promise<{ results: unknown[]; success: boolean; meta: object }> {
    return { results: [], success: true, meta: {} };
  }

  async run(_statement: FakeStatement): Promise<D1Result> {
    return { success: true, meta: { changes: 1 } };
  }

  abstract batch(statements: FakeStatement[]): Promise<D1Result[]>;
}

const guestAuth: AuthContext = {
  userId: 'guest_command_tests',
  householdId: 'hh_guest_command_tests',
  isGuest: true,
};

function createRouteApp(routes: typeof inventoryRoutes | typeof recipeRoutes | typeof shoppingRoutes) {
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  app.use('*', async (c, next) => {
    c.set('auth', guestAuth);
    await next();
  });
  app.route('/', routes);
  return app;
}

async function requestJson(
  app: ReturnType<typeof createRouteApp>,
  db: FakeDatabase,
  path: string,
  body: unknown,
  idempotencyKey: string,
  method: 'DELETE' | 'PATCH' | 'POST' = 'POST',
  extraHeaders: Record<string, string> = {}
) {
  const response = await app.request(
    path,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    },
    { DB: db as unknown as Env['DB'] }
  );
  return { response, json: await response.json() as Record<string, unknown> };
}

type InventoryRow = {
  id: string;
  household_id: string;
  ingredient_id: string | null;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  storage: string;
  expiry_date: string | null;
  added_date: string;
  freshness: string;
  data_source: string;
  version: number;
  updated_at: string;
};

class InventoryDatabase extends FakeDatabase {
  readonly events = new Map<string, { id: string; metadata: unknown }>();
  private pendingInventoryReads: Array<(row: InventoryRow) => void> = [];
  private barrierReleased = false;

  constructor(
    readonly row: InventoryRow,
    private readonly concurrentReadCount = 1
  ) {
    super();
  }

  async first(statement: FakeStatement): Promise<unknown> {
    if (statement.sql.includes('FROM inventory_items WHERE id = ? AND household_id = ?')) {
      const [id, householdId] = statement.params;
      if (id !== this.row.id || householdId !== this.row.household_id) return null;

      const snapshot = { ...this.row };
      if (this.concurrentReadCount > 1 && !this.barrierReleased) {
        return new Promise<InventoryRow>((resolve) => {
          this.pendingInventoryReads.push(resolve);
          if (this.pendingInventoryReads.length === this.concurrentReadCount) {
            this.barrierReleased = true;
            for (const release of this.pendingInventoryReads) release(snapshot);
            this.pendingInventoryReads = [];
          }
        });
      }
      return snapshot;
    }

    if (statement.sql.includes('FROM inventory_events')) {
      return this.events.get(String(statement.params[0])) || null;
    }

    return null;
  }

  async batch(statements: FakeStatement[]): Promise<D1Result[]> {
    this.batches.push(statements);
    const update = statements.find((statement) => statement.sql.includes('UPDATE inventory_items'));
    const fence = statements.find((statement) => statement.sql.includes("'T09_WRITER_FENCE'"));
    const event = statements.find((statement) =>
      statement !== fence && statement.sql.includes('INSERT INTO inventory_events')
    );
    if (!update || !event) throw new Error('Expected an inventory update and event in one batch');

    const expectedVersion = Number(update.params.at(-1));
    const changed = expectedVersion === this.row.version ? 1 : 0;
    if (changed === 1) {
      if (update.params.length === 3) {
        this.row.quantity = 0;
        this.row.freshness = 'out_of_stock';
      } else {
        this.row.name = String(update.params[0]);
        this.row.ingredient_id = update.params[1] === null ? null : String(update.params[1]);
        this.row.quantity = Number(update.params[2]);
        this.row.unit = String(update.params[3]);
        this.row.category = String(update.params[4]);
        this.row.storage = String(update.params[5]);
        this.row.expiry_date = update.params[6] === null ? null : String(update.params[6]);
        this.row.freshness = String(update.params[7]);
      }
      this.row.version += 1;
      this.events.set(String(event.params[0]), {
        id: String(event.params[0]),
        metadata: event.params[7] ?? null,
      });
    }

    return statements.map((statement) => ({
      success: true,
      meta: { changes: statement === fence ? 0 : statement === update || statement === event ? changed : 1 },
    }));
  }
}

function inventoryRow(): InventoryRow {
  return {
    id: 'item_command_test',
    household_id: guestAuth.householdId,
    ingredient_id: 'PORK_BELLY',
    name: 'Thịt ba chỉ',
    quantity: 500,
    unit: 'g',
    category: 'meat',
    storage: 'fridge',
    expiry_date: null,
    added_date: '2026-09-01T00:00:00.000Z',
    freshness: 'fresh',
    data_source: 'manual',
    version: 3,
    updated_at: '2026-09-01T00:00:00.000Z',
  };
}

describe('inventory command integrity', () => {
  it('requires a PATCH version instead of accepting blind writes', async () => {
    const app = createRouteApp(inventoryRoutes);
    const db = new InventoryDatabase(inventoryRow());

    const result = await requestJson(
      app,
      db,
      '/inventory/item_command_test',
      { quantity: 450 },
      'inventory-patch-version-required-001',
      'PATCH'
    );

    expect(result.response.status).toBe(428);
    expect(result.json).toMatchObject({ code: 'PRECONDITION_REQUIRED' });
    expect(db.batches).toHaveLength(0);
  });

  it('applies a retried PATCH exactly once and returns the durable replay', async () => {
    const app = createRouteApp(inventoryRoutes);
    const db = new InventoryDatabase(inventoryRow());
    const key = 'inventory-patch-replay-001';

    const first = await requestJson(app, db, '/inventory/item_command_test', { quantity: 450, version: 3 }, key, 'PATCH');
    const replay = await requestJson(app, db, '/inventory/item_command_test', { quantity: 450, version: 3 }, key, 'PATCH');

    expect(first.response.status).toBe(200);
    expect(replay.response.status).toBe(200);
    expect(replay.json).toMatchObject({
      success: true,
      idempotentReplay: true,
      item: { quantity: 450, version: 4 },
    });
    expect(db.batches).toHaveLength(1);
    expect(db.events.size).toBe(1);
    expect([...db.events.values()]).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^evt_update_/), metadata: expect.any(String) }),
    ]);
  });

  it('rejects reuse of a PATCH key with a different command payload', async () => {
    const app = createRouteApp(inventoryRoutes);
    const db = new InventoryDatabase(inventoryRow());
    const key = 'inventory-patch-conflict-001';

    const first = await requestJson(app, db, '/inventory/item_command_test', { quantity: 450, version: 3 }, key, 'PATCH');
    const conflict = await requestJson(app, db, '/inventory/item_command_test', { quantity: 400, version: 3 }, key, 'PATCH');

    expect(first.response.status).toBe(200);
    expect(conflict.response.status).toBe(409);
    expect(conflict.json).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(db.row.quantity).toBe(450);
    expect(db.batches).toHaveLength(1);
  });

  it('allows only one of two concurrent PATCH commands based on the same version', async () => {
    const app = createRouteApp(inventoryRoutes);
    const db = new InventoryDatabase(inventoryRow(), 2);

    const results = await Promise.all([
      requestJson(
        app,
        db,
        '/inventory/item_command_test',
        { quantity: 450, version: 3 },
        'inventory-concurrent-a-001',
        'PATCH'
      ),
      requestJson(
        app,
        db,
        '/inventory/item_command_test',
        { quantity: 400, version: 3 },
        'inventory-concurrent-b-001',
        'PATCH'
      ),
    ]);

    expect(results.map(({ response }) => response.status).sort()).toEqual([200, 409]);
    expect(results.find(({ response }) => response.status === 409)?.json).toMatchObject({ code: 'CONFLICT' });
    expect(db.row.version).toBe(4);
    expect([400, 450]).toContain(db.row.quantity);
    expect(db.events.size).toBe(1);
  });

  it('returns a replay when two concurrent PATCH requests use the same command key', async () => {
    const app = createRouteApp(inventoryRoutes);
    const db = new InventoryDatabase(inventoryRow(), 2);
    const key = 'inventory-concurrent-replay-001';

    const results = await Promise.all([
      requestJson(
        app,
        db,
        '/inventory/item_command_test',
        { quantity: 450, version: 3 },
        key,
        'PATCH'
      ),
      requestJson(
        app,
        db,
        '/inventory/item_command_test',
        { quantity: 450, version: 3 },
        key,
        'PATCH'
      ),
    ]);

    expect(results.map(({ response }) => response.status)).toEqual([200, 200]);
    expect(results.filter(({ json }) => json.idempotentReplay === true)).toHaveLength(1);
    expect(db.row.quantity).toBe(450);
    expect(db.row.version).toBe(4);
    expect(db.events.size).toBe(1);
  });

  it('requires If-Match for DELETE commands', async () => {
    const app = createRouteApp(inventoryRoutes);
    const db = new InventoryDatabase(inventoryRow());

    const result = await requestJson(
      app,
      db,
      '/inventory/item_command_test',
      {},
      'inventory-delete-if-match-required-001',
      'DELETE'
    );

    expect(result.response.status).toBe(428);
    expect(result.json).toMatchObject({ code: 'PRECONDITION_REQUIRED' });
    expect(db.batches).toHaveLength(0);
  });

  it('rejects a stale If-Match value for DELETE commands', async () => {
    const app = createRouteApp(inventoryRoutes);
    const db = new InventoryDatabase(inventoryRow());

    const result = await requestJson(
      app,
      db,
      '/inventory/item_command_test',
      {},
      'inventory-delete-stale-version-001',
      'DELETE',
      { 'If-Match': '2' }
    );

    expect(result.response.status).toBe(409);
    expect(result.json).toMatchObject({
      code: 'CONFLICT',
      expectedVersion: 3,
      receivedVersion: 2,
    });
    expect(db.batches).toHaveLength(0);
  });

  it('accepts weak If-Match and replays DELETE before stale version checks', async () => {
    const app = createRouteApp(inventoryRoutes);
    const db = new InventoryDatabase(inventoryRow());
    const key = 'inventory-delete-replay-001';

    const first = await requestJson(
      app,
      db,
      '/inventory/item_command_test',
      {},
      key,
      'DELETE',
      { 'If-Match': 'W/"3"' }
    );
    const replay = await requestJson(
      app,
      db,
      '/inventory/item_command_test',
      {},
      key,
      'DELETE',
      { 'If-Match': 'W/"3"' }
    );

    expect(first.response.status).toBe(200);
    expect(replay.response.status).toBe(200);
    expect(replay.json).toMatchObject({ success: true, idempotentReplay: true });
    expect(db.row.version).toBe(4);
    expect(db.row.quantity).toBe(0);
    expect(db.batches).toHaveLength(1);
  });
});

class ShoppingListDatabase extends FakeDatabase {
  constructor(
    private readonly command: 'delete' | 'patch',
    private readonly affectedRows: number
  ) {
    super();
  }

  async first(statement: FakeStatement): Promise<unknown> {
    if (statement.sql.includes('FROM shopping_items')) {
      return {
        id: 'shop_test_001',
        list_id: 'list_test',
        name: 'Cà chua',
        quantity: 2,
        unit: 'piece',
        is_checked: 0,
        source_recipe_id: null,
        created_at: '2026-09-01T00:00:00.000Z',
      };
    }
    return null;
  }

  async run(statement: FakeStatement): Promise<D1Result> {
    if (
      (this.command === 'patch' && statement.sql.includes('UPDATE shopping_items')) ||
      (this.command === 'delete' && statement.sql.includes('DELETE FROM shopping_items'))
    ) {
      return { success: true, meta: { changes: this.affectedRows } };
    }
    return { success: true, meta: { changes: 1 } };
  }

  async batch(): Promise<D1Result[]> {
    return [];
  }
}

describe('shopping-list command integrity', () => {
  it('does not report success when PATCH loses the affected-row guard', async () => {
    const app = createRouteApp(shoppingRoutes);
    const db = new ShoppingListDatabase('patch', 0);

    const result = await requestJson(
      app,
      db,
      '/shopping-list/items/shop_test_001',
      { quantity: 3 },
      'shopping-patch-affected-001',
      'PATCH'
    );

    expect(result.response.status).toBe(409);
    expect(result.json).toMatchObject({ code: 'CONFLICT' });
  });

  it('does not report success when DELETE loses the affected-row guard', async () => {
    const app = createRouteApp(shoppingRoutes);
    const db = new ShoppingListDatabase('delete', 0);

    const result = await requestJson(
      app,
      db,
      '/shopping-list/items/shop_test_001',
      {},
      'shopping-delete-affected-001',
      'DELETE'
    );

    expect(result.response.status).toBe(409);
    expect(result.json).toMatchObject({ code: 'CONFLICT' });
  });
});

type CookedMealRow = {
  id: string;
  recipe_id: string;
  servings_cooked: number;
  deductions_applied: string;
};

class CookingDatabase extends FakeDatabase {
  prior: CookedMealRow | null;
  stock = { id: 'item_cook_test', quantity: 1000, unit: 'g' };
  failBatchAfterCommit = false;

  constructor(prior: CookedMealRow | null = null) {
    super();
    this.prior = prior;
  }

  async first(statement: FakeStatement): Promise<unknown> {
    if (statement.sql.includes('FROM cooked_meals')) return this.prior;
    if (statement.sql.includes('FROM inventory_items')) return { ...this.stock };
    return null;
  }

  async batch(statements: FakeStatement[]): Promise<D1Result[]> {
    this.batches.push(statements);
    if (this.failBatchAfterCommit) {
      this.prior = {
        id: 'committed-by-concurrent-retry',
        recipe_id: 'vn-kho-01',
        servings_cooked: 2,
        deductions_applied: JSON.stringify([
          { ingredientId: 'PORK_BELLY', quantityDeducted: 250, unit: 'g' },
        ]),
      };
      throw new Error('simulated concurrent unique-key winner');
    }
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

const cookingRecipe = ALL_RECIPES.find((recipe) => recipe.id === 'vn-kho-01');
if (!cookingRecipe) throw new Error('Expected vn-kho-01 fixture recipe');

describe('cooking command integrity', () => {
  it('treats reordered deductions as the same idempotent command', async () => {
    const deductions = [
      { ingredientId: 'PORK_BELLY', quantityDeducted: 250, unit: 'g' },
      { ingredientId: 'CHICKEN_EGG', quantityDeducted: 2, unit: 'piece' },
    ];
    const db = new CookingDatabase({
      id: 'stored-cook-command',
      recipe_id: cookingRecipe.id,
      servings_cooked: 2,
      deductions_applied: JSON.stringify([...deductions].reverse()),
    });
    const app = createRouteApp(recipeRoutes);

    const replay = await requestJson(
      app,
      db,
      `/recipes/${cookingRecipe.id}/cook/complete`,
      { servings: 2, deductions },
      'cooking-reordered-replay-001'
    );

    expect(replay.response.status).toBe(200);
    expect(replay.json).toMatchObject({ success: true, idempotentReplay: true });
    expect(db.batches).toHaveLength(0);
  });

  it('rejects reuse of a cooking key with a different payload', async () => {
    const db = new CookingDatabase({
      id: 'stored-cook-command',
      recipe_id: cookingRecipe.id,
      servings_cooked: 2,
      deductions_applied: JSON.stringify([
        { ingredientId: 'PORK_BELLY', quantityDeducted: 250, unit: 'g' },
      ]),
    });
    const app = createRouteApp(recipeRoutes);

    const conflict = await requestJson(
      app,
      db,
      `/recipes/${cookingRecipe.id}/cook/complete`,
      {
        servings: 2,
        deductions: [{ ingredientId: 'PORK_BELLY', quantityDeducted: 300, unit: 'g' }],
      },
      'cooking-payload-conflict-001'
    );

    expect(conflict.response.status).toBe(409);
    expect(conflict.json).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(db.batches).toHaveLength(0);
  });

  it('aggregates duplicate deductions into one guarded inventory update', async () => {
    const db = new CookingDatabase();
    const app = createRouteApp(recipeRoutes);

    const result = await requestJson(
      app,
      db,
      `/recipes/${cookingRecipe.id}/cook/complete`,
      {
        servings: 2,
        deductions: [
          { ingredientId: 'PORK_BELLY', quantityDeducted: 100, unit: 'g' },
          { ingredientId: 'PORK_BELLY', quantityDeducted: 150, unit: 'g' },
        ],
      },
      'cooking-guarded-deduction-001'
    );

    expect(result.response.status).toBe(200);
    const inventoryUpdates = db.batches[0].filter((statement) =>
      statement.sql.includes('UPDATE inventory_items')
    );
    expect(inventoryUpdates).toHaveLength(1);
    expect(inventoryUpdates[0].sql).toContain('quantity >= ?');
    expect(inventoryUpdates[0].params[0]).toBe(250);
    expect(db.batches[0].some((statement) => statement.sql.includes('WHERE changes() = 0'))).toBe(true);
  });

  it('returns the durable replay when a concurrent request wins the cooking command race', async () => {
    const db = new CookingDatabase();
    db.failBatchAfterCommit = true;
    const app = createRouteApp(recipeRoutes);

    const replay = await requestJson(
      app,
      db,
      `/recipes/${cookingRecipe.id}/cook/complete`,
      {
        servings: 2,
        deductions: [{ ingredientId: 'PORK_BELLY', quantityDeducted: 250, unit: 'g' }],
      },
      'cooking-concurrent-replay-001'
    );

    expect(replay.response.status).toBe(200);
    expect(replay.json).toMatchObject({ success: true, idempotentReplay: true });
    expect(db.batches).toHaveLength(1);
  });
});
