import { Hono } from 'hono';
import { InventoryWriterAuthorityError, runLegacyInventoryBatch } from '../../../packages/db/src/inventory-writer-fence';
import { Env, AuthContext } from '../types';
import { ALL_RECIPES, rankRecipes, evaluateRecipeMatch, CuisineType } from '@frigo/recipes';
import { areUnitsCompatible, convertUnit, findCanonicalIngredient, StandardUnit } from '@frigo/domain';
import { SQL } from '@frigo/db';
import { fetchHouseholdInventoryFromDb } from './inventory';
import { tenancyGuard } from '../middleware/tenancy';
import { CookingCompleteSchema } from '../validation/schemas';

export const recipeRoutes = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

type StockAllocation = {
  itemId: string;
  currentQuantity: number;
  expectedVersion: number;
  unit: StandardUnit;
  quantity: number;
};

type CookingLot = {
  id: string;
  quantity: number;
  unit: StandardUnit;
  version?: number | null;
};

export type CookingLotAllocationResult = {
  availableQuantity: number;
  remainingQuantity: number;
  allocations: StockAllocation[];
};

/**
 * Allocate one deduction over FIFO inventory lots without crossing unit
 * families. Quantities in each allocation stay in that lot's storage unit so
 * the projection and audit event remain lossless.
 */
export function allocateCookingLots(
  lots: CookingLot[],
  requestedQuantity: number,
  requestedUnit: StandardUnit,
  alreadyAllocated: Map<string, number>
): CookingLotAllocationResult {
  let availableQuantity = 0;
  let remainingQuantity = Math.max(0, requestedQuantity);
  const allocations: StockAllocation[] = [];

  for (const lot of lots) {
    if (!areUnitsCompatible(requestedUnit, lot.unit)) continue;
    const previouslyAllocated = Math.max(0, Number(alreadyAllocated.get(lot.id) || 0));
    const remainingLotQuantity = Math.max(0, Number(lot.quantity) - previouslyAllocated);
    if (!Number.isFinite(remainingLotQuantity)) continue;

    const availableInRequestedUnit = convertUnit(remainingLotQuantity, lot.unit, requestedUnit);
    if (!Number.isFinite(availableInRequestedUnit) || availableInRequestedUnit <= 0) continue;
    availableQuantity += availableInRequestedUnit;

    if (remainingQuantity <= Number.EPSILON) continue;
    const takeInRequestedUnit = Math.min(remainingQuantity, availableInRequestedUnit);
    const takeInStorageUnit = convertUnit(takeInRequestedUnit, requestedUnit, lot.unit);
    if (!Number.isFinite(takeInStorageUnit) || takeInStorageUnit <= 0) continue;

    allocations.push({
      itemId: lot.id,
      currentQuantity: Number(lot.quantity),
      expectedVersion: Number.isInteger(Number(lot.version)) ? Number(lot.version) : 1,
      unit: lot.unit,
      quantity: takeInStorageUnit,
    });
    remainingQuantity = Math.max(0, remainingQuantity - takeInRequestedUnit);
  }

  return {
    availableQuantity,
    remainingQuantity,
    allocations,
  };
}

function assertBatchSucceeded(results: any[] | undefined): void {
  if (results?.some((result) => result && result.success === false)) {
    throw new Error('D1 batch reported an unsuccessful statement');
  }
}

async function stableCookingCommandId(householdId: string, idempotencyKey: string): Promise<string> {
  const input = new TextEncoder().encode(`${householdId}:${idempotencyKey}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `cook_${hex.slice(0, 48)}`;
}

function cookingRequestFingerprint(
  recipeId: string,
  servings: number,
  deductions: Array<{
    ingredientId: string;
    name?: string;
    quantityDeducted: number;
    unit: StandardUnit;
  }>
): string {
  // Deduction order is not semantically meaningful, but every quantity/unit
  // is. Sorting makes retries compare equivalent requests deterministically.
  const normalized = deductions
    .map((item) => ({
      ingredientId: item.ingredientId,
      name: item.name || '',
      quantityDeducted: item.quantityDeducted,
      unit: item.unit,
    }))
    .sort((a, b) =>
      `${a.ingredientId}:${a.name}:${a.unit}:${a.quantityDeducted}`.localeCompare(
        `${b.ingredientId}:${b.name}:${b.unit}:${b.quantityDeducted}`
      )
    );
  return JSON.stringify({ recipeId, servings, deductions: normalized });
}

function resolveCookingDeductionUnits(
  recipe: { ingredients: Array<{ ingredientId: string; name: string; unit: StandardUnit }> },
  deductions: Array<{
    ingredientId: string;
    name?: string;
    quantityDeducted: number;
    unit?: StandardUnit;
  }>
): Array<{ ingredientId: string; name?: string; quantityDeducted: number; unit: StandardUnit }> {
  return deductions.map((deduction) => {
    if (deduction.unit) return deduction as { ingredientId: string; name?: string; quantityDeducted: number; unit: StandardUnit };
    const recipeIngredient = recipe.ingredients.find(
      (ingredient) =>
        ingredient.ingredientId === deduction.ingredientId ||
        ingredient.name.trim().toLocaleLowerCase() === (deduction.name || '').trim().toLocaleLowerCase()
    );
    if (!recipeIngredient) {
      throw new Error(`Missing unit for cooking deduction ${deduction.ingredientId}`);
    }
    return { ...deduction, unit: recipeIngredient.unit };
  });
}

function storedCookingFingerprint(row: {
  recipe_id?: string;
  servings_cooked?: number;
  deductions_applied?: string | null;
}): string | null {
  try {
    const deductions = JSON.parse(row.deductions_applied || '[]');
    if (!Array.isArray(deductions)) return null;
    return cookingRequestFingerprint(
      String(row.recipe_id || ''),
      Number(row.servings_cooked || 0),
      deductions as Array<{
        ingredientId: string;
        name?: string;
        quantityDeducted: number;
        unit: StandardUnit;
      }>
    );
  } catch {
    return null;
  }
}

// GET /api/v1/recipes
recipeRoutes.get('/recipes', (c) => {
  const cuisine = c.req.query('cuisine') as CuisineType | undefined;
  const category = c.req.query('category');
  const region = c.req.query('region');
  const search = c.req.query('q')?.toLowerCase();

  let list = ALL_RECIPES;
  if (cuisine) {
    list = list.filter((r) => r.cuisine === cuisine);
  }
  if (category) {
    list = list.filter((r) => r.category === category);
  }
  if (region) {
    list = list.filter((r) => r.region === region || r.region === 'toan_quoc');
  }
  if (search) {
    list = list.filter(
      (r) =>
        r.title.toLowerCase().includes(search) ||
        r.description.toLowerCase().includes(search) ||
        (r.tags && r.tags.some((t) => t.toLowerCase().includes(search))) ||
        r.ingredients.some((i) => i.name.toLowerCase().includes(search))
    );
  }

  return c.json({ recipes: list });
});

// GET /api/v1/recipes/:id
recipeRoutes.get('/recipes/:id', async (c) => {
  const idOrSlug = c.req.param('id');
  const auth = c.get('auth');
  const recipe = ALL_RECIPES.find((r) => r.id === idOrSlug || r.slug === idOrSlug);

  if (!recipe) {
    return c.json({ error: 'Recipe not found' }, 404);
  }

  const inventory = await fetchHouseholdInventoryFromDb(c.env.DB, auth.householdId, c.env.CACHE);
  const evaluation = evaluateRecipeMatch(recipe, { inventory });

  return c.json({
    recipe,
    match: evaluation,
  });
});

// GET /api/v1/recommendations
recipeRoutes.get('/recommendations', async (c) => {
  const auth = c.get('auth');
  const noBuy = c.req.query('noBuy') === 'true';
  const cuisineQuery = c.req.query('cuisine');
  const categoryQuery = c.req.query('category');
  const regionQuery = c.req.query('region');
  const maxTime = c.req.query('maxTime') ? Number(c.req.query('maxTime')) : undefined;

  const preferredCuisines = cuisineQuery ? (cuisineQuery.split(',') as CuisineType[]) : undefined;

  const inventory = await fetchHouseholdInventoryFromDb(c.env.DB, auth.householdId, c.env.CACHE);

  let targetRecipes = ALL_RECIPES;
  if (categoryQuery) {
    targetRecipes = targetRecipes.filter((r) => r.category === categoryQuery);
  }
  if (regionQuery) {
    targetRecipes = targetRecipes.filter((r) => r.region === regionQuery || r.region === 'toan_quoc');
  }

  const ranked = rankRecipes(targetRecipes, {
    inventory,
    preferredCuisines,
    maxCookTimeMinutes: maxTime,
    onlyNoBuyNeeded: noBuy,
  });

  return c.json({
    total: ranked.length,
    noBuyFilterActive: noBuy,
    recommendations: ranked,
  });
});

// POST /api/v1/recipes/:id/cook/start
recipeRoutes.post('/recipes/:id/cook/start', (c) => {
  const recipeId = c.req.param('id');
  const recipe = ALL_RECIPES.find((r) => r.id === recipeId || r.slug === recipeId);

  if (!recipe) {
    return c.json({ error: 'Recipe not found' }, 404);
  }

  return c.json({
    success: true,
    cookingSessionId: `cook_${Date.now()}`,
    recipeId: recipe.id,
    stepsCount: recipe.steps.length,
    startedAt: new Date().toISOString(),
  });
});

// POST /api/v1/recipes/:id/cook/complete
recipeRoutes.post('/recipes/:id/cook/complete', tenancyGuard, async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const kv = c.env.CACHE;
  const recipeId = c.req.param('id');
  const rawBody = await c.req.json().catch(() => ({}));
  const parseResult = CookingCompleteSchema.safeParse(rawBody);
  if (!parseResult.success) {
    return c.json(
      {
        error: parseResult.error.errors[0]?.message || 'Dữ liệu hoàn tất nấu không hợp lệ',
        code: 'VALIDATION_ERROR',
      },
      400
    );
  }

  const { deductions: rawDeductions, servings, commandId: bodyCommandId } = parseResult.data;
  const recipe = ALL_RECIPES.find((r) => r.id === recipeId || r.slug === recipeId);
  if (!recipe) {
    return c.json({ error: 'Recipe not found', code: 'NOT_FOUND' }, 404);
  }
  if (!db) {
    // Cooking is a durable mutation; never claim success when there is no
    // authoritative persistence layer available.
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  let deductions: Array<{
    ingredientId: string;
    name?: string;
    quantityDeducted: number;
    unit: StandardUnit;
  }>;
  try {
    deductions = resolveCookingDeductionUnits(recipe, rawDeductions);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Thiếu đơn vị nguyên liệu', code: 'UNIT_MISMATCH' },
      422
    );
  }

  const headerIdempotencyKey = c.req.header('Idempotency-Key')?.trim();
  const bodyIdempotencyKey = bodyCommandId?.trim();
  if (headerIdempotencyKey && bodyIdempotencyKey && headerIdempotencyKey !== bodyIdempotencyKey) {
    return c.json(
      { error: 'Idempotency-Key trong header và commandId không khớp', code: 'IDEMPOTENCY_CONFLICT' },
      409
    );
  }
  const idempotencyKey = (headerIdempotencyKey || bodyIdempotencyKey)?.trim();
  if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 200)) {
    return c.json(
      { error: 'Idempotency-Key phải dài từ 8 đến 200 ký tự', code: 'VALIDATION_ERROR' },
      400
    );
  }
  const cookId = idempotencyKey
    ? await stableCookingCommandId(auth.householdId, idempotencyKey)
    : `cook_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const requestFingerprint = cookingRequestFingerprint(recipe.id, servings, deductions);

  const currentInventory = async () =>
    fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true });
  const allocations = new Map<string, StockAllocation>();

  try {
    // A replay with the same command key returns the original durable result
    // without applying inventory events a second time.
    const prior = await db
      .prepare(
        'SELECT id, recipe_id, servings_cooked, deductions_applied FROM cooked_meals WHERE id = ? AND household_id = ? LIMIT 1'
      )
      .bind(cookId, auth.householdId)
      .first<{
        id: string;
        recipe_id: string;
        servings_cooked: number;
        deductions_applied: string | null;
      }>();
    if (prior) {
      if (storedCookingFingerprint(prior) !== requestFingerprint) {
        return c.json(
          {
            error: 'Idempotency-Key đã được dùng cho một lệnh nấu khác',
            code: 'IDEMPOTENCY_CONFLICT',
          },
          409
        );
      }
      const inventory = await currentInventory();
      return c.json({
        success: true,
        idempotentReplay: true,
        cookId,
        message: `Đã hoàn tất nấu món ${recipe.title} và tự động cập nhật lại tủ lạnh!`,
        recipeId: recipe.id,
        deductionsApplied: deductions,
        remainingInventoryCount: inventory.length,
        inventory,
      });
    }

    for (const deduction of deductions) {
      if (deduction.quantityDeducted === 0) continue;

      const lookupName = (deduction.name || deduction.ingredientId).trim();
      const canonical = findCanonicalIngredient(lookupName);
      const lookupId = canonical?.id || (deduction.ingredientId === 'OTHER' ? null : deduction.ingredientId);
      const lotStatement = db
        .prepare(
          `SELECT id, quantity, unit, version
           FROM inventory_items
           WHERE household_id = ?
             AND ((? IS NOT NULL AND ingredient_id = ?) OR LOWER(name) = LOWER(?))
             AND quantity > 0
           ORDER BY updated_at ASC, id ASC`
        )
        .bind(auth.householdId, lookupId, lookupId, lookupName);
      const lotResult = await lotStatement.all<{ id: string; quantity: number; unit: string; version?: number | null }>();
      const lots = [...(lotResult.results || [])] as CookingLot[];
      // A small compatibility fallback keeps lightweight test/local D1 mocks
      // working while production D1 uses the multi-lot query above.
      if (lots.length === 0) {
        const single = await lotStatement.first<{ id: string; quantity: number; unit: string; version?: number | null }>();
        if (single) lots.push(single as CookingLot);
      }

      const priorAllocations = new Map(
        Array.from(allocations.values()).map((allocation) => [allocation.itemId, allocation.quantity])
      );
      const allocationResult = allocateCookingLots(
        lots,
        deduction.quantityDeducted,
        deduction.unit,
        priorAllocations
      );
      if (lots.length > 0 && !lots.some((lot) => areUnitsCompatible(deduction.unit, lot.unit))) {
        return c.json(
          {
            error: `Không thể quy đổi đơn vị ${deduction.unit} cho ${lookupName}`,
            code: 'UNIT_MISMATCH',
          },
          422
        );
      }
      if (allocationResult.remainingQuantity > Number.EPSILON) {
        return c.json(
          {
            error: allocationResult.availableQuantity > 0
              ? `Số lượng ${lookupName} trong tủ không đủ để hoàn tất món ăn`
              : `Không tìm thấy nguyên liệu để trừ: ${lookupName}`,
            code: 'INSUFFICIENT_INVENTORY',
            available: allocationResult.availableQuantity,
            requested: deduction.quantityDeducted,
            unit: deduction.unit,
          },
          409
        );
      }

      for (const allocation of allocationResult.allocations) {
        const existing = allocations.get(allocation.itemId);
        allocations.set(allocation.itemId, {
          itemId: allocation.itemId,
          currentQuantity: allocation.currentQuantity,
          expectedVersion: allocation.expectedVersion,
          unit: allocation.unit,
          quantity: (existing?.quantity || 0) + allocation.quantity,
        });
      }
    }

    const batchStatements: any[] = [
      db
        .prepare('INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)')
        .bind(auth.householdId, 'Tủ lạnh gia đình', auth.userId),
      db
        .prepare(
          `INSERT OR IGNORE INTO recipes (id, slug, title, cuisine, cook_time_minutes, servings, difficulty)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(recipe.id, recipe.slug, recipe.title, recipe.cuisine, recipe.cookTimeMinutes, recipe.servings, recipe.difficulty),
      db
        .prepare(
          `INSERT INTO cooked_meals (id, household_id, user_id, recipe_id, servings_cooked, deductions_applied)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(cookId, auth.householdId, auth.userId, recipe.id, servings, JSON.stringify(deductions)),
    ];

    for (const allocation of allocations.values()) {
      // Apply the deduction atomically against the quantity observed above. A
      // failed guard aborts the whole D1 batch, so no cooked meal/event can be
      // committed when another command consumed the stock first.
      batchStatements.push(
        db
          .prepare(
            `UPDATE inventory_items
             SET quantity = quantity - ?,
                 freshness = CASE WHEN quantity - ? <= 0 THEN 'out_of_stock' ELSE freshness END,
                 version = version + 1,
                 updated_at = datetime('now')
             WHERE id = ? AND household_id = ? AND quantity >= ? AND version = ?`
          )
          .bind(
            allocation.quantity,
            allocation.quantity,
            allocation.itemId,
            auth.householdId,
            allocation.quantity,
            allocation.expectedVersion
          )
      );
      batchStatements.push(
        db
          .prepare(
            `INSERT INTO inventory_events
               (id, household_id, inventory_item_id, event_type, quantity_delta, unit, reason, metadata)
             SELECT ?, NULL, NULL, 'COOK_GUARD', 0, ?, 'guard', NULL
             WHERE changes() = 0`
          )
          .bind(`cook_guard_${cookId}_${allocation.itemId}`, allocation.unit)
      );
      batchStatements.push(
        db.prepare(SQL.INSERT_INVENTORY_EVENT).bind(
          `evt_${cookId}_${allocation.itemId}`,
          auth.householdId,
          allocation.itemId,
          'COOK',
          -allocation.quantity,
          allocation.unit,
          `Nấu món ${recipe.title}`,
          JSON.stringify({ recipeId: recipe.id, cookId })
        )
      );
    }

    const batchResults = await runLegacyInventoryBatch(db, auth.householdId, batchStatements);
    assertBatchSucceeded(batchResults);
    if (kv) await kv.delete(`inv_${auth.householdId}`).catch(() => {});

    const updatedInventory = await currentInventory();
    return c.json({
      success: true,
      cookId,
      message: `Đã hoàn tất nấu món ${recipe.title} và tự động cập nhật lại tủ lạnh!`,
      recipeId: recipe.id,
      deductionsApplied: deductions,
      remainingInventoryCount: updatedInventory.length,
      inventory: updatedInventory,
    });
  } catch (err: any) {
    // A concurrent request may have committed the same idempotent command just
    // before this request hit the INSERT. Re-read and return that result.
    if (idempotencyKey) {
      try {
        const prior = await db
          .prepare(
            'SELECT id, recipe_id, servings_cooked, deductions_applied FROM cooked_meals WHERE id = ? AND household_id = ? LIMIT 1'
          )
          .bind(cookId, auth.householdId)
          .first<{
            id: string;
            recipe_id: string;
            servings_cooked: number;
            deductions_applied: string | null;
          }>();
        if (prior) {
          if (storedCookingFingerprint(prior) !== requestFingerprint) {
            return c.json(
              {
                error: 'Idempotency-Key đã được dùng cho một lệnh nấu khác',
                code: 'IDEMPOTENCY_CONFLICT',
              },
              409
            );
          }
          const inventory = await currentInventory();
          return c.json({
            success: true,
            idempotentReplay: true,
            cookId,
            message: `Đã hoàn tất nấu món ${recipe.title} và tự động cập nhật lại tủ lạnh!`,
            recipeId: recipe.id,
            deductionsApplied: deductions,
            remainingInventoryCount: inventory.length,
            inventory,
          });
        }
      } catch {
        // Fall through to the durable error response below.
      }
    }
    if (allocations.size > 0) {
      try {
        const latestInventory = await currentInventory();
        const concurrencyConflict = Array.from(allocations.values()).some((allocation) => {
          const latest = latestInventory.find((item: any) => item.id === allocation.itemId);
          return (
            !latest ||
            Number(latest.quantity) < allocation.quantity ||
            Number(latest.version) !== allocation.expectedVersion
          );
        });
        if (concurrencyConflict) {
          return c.json(
            {
              error: 'Tồn kho vừa thay đổi, vui lòng kiểm tra lại lượng nguyên liệu trước khi hoàn tất món ăn',
              code: 'CONFLICT',
            },
            409
          );
        }
      } catch {
        // Preserve the original database failure when the conflict probe also
        // cannot reach D1; an unavailable read is not evidence of low stock.
      }
    }
    if (err instanceof InventoryWriterAuthorityError) return c.json({ error: err.message, code: err.code }, 409);
    console.error('D1 complete cooking transaction failed:', err);
    return c.json({ error: 'Lỗi hoàn tất nấu món trong cơ sở dữ liệu', code: 'DATABASE_ERROR' }, 500);
  }
});
