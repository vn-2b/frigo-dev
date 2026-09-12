import { Hono } from 'hono';
import { InventoryWriterAuthorityError, InventoryWriterSnapshotError, readInventoryAuthorityMode, readLegacyInventoryRevision, runLegacyInventoryBatch } from '../../../packages/db/src/inventory-writer-fence';
import { composeInventoryLotCommands, readAdoptedLotSnapshot, type LotCommandSpec } from '../../../packages/db/src/inventory-lot-commands';
import { LotCommandError } from '../../../packages/domain/src/inventory-lot-commands';
import { inventoryAuthorityFailure } from '../utils/inventory-authority';
import { z } from 'zod';
import { Env, AuthContext, WeekSchemaMode } from '../types';
import {
  generateWeeklyMealPlan,
  swapMealInPlan,
  getSwapAlternatives,
  MealPlan,
  MealPlanSetupInput,
  MealSlotItem,
  areUnitsCompatible,
  convertUnit,
  StandardUnit,
} from '@frigo/domain';
import { ALL_RECIPES } from '@frigo/recipes';
import { tenancyGuard } from '../middleware/tenancy';
import { rateLimiter } from '../middleware/rate-limit';
import { fetchHouseholdInventoryFromDb } from './inventory';
import { selectPlanShoppingItems } from '../utils/week-shopping';

export const weekRoutes = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

class WeekDatabaseError extends Error {
  readonly code = 'DATABASE_UNAVAILABLE';
  constructor(message = 'Week database unavailable') {
    super(message);
    this.name = 'WeekDatabaseError';
  }
}

class ShoppingImportUnitError extends Error {
  readonly code = 'UNIT_MISMATCH';
  constructor() {
    super('Shopping item unit is incompatible with existing inventory');
    this.name = 'ShoppingImportUnitError';
  }
}

class WeekPlanConflictError extends Error {
  readonly code = 'CONFLICT';
  constructor() {
    super('Meal plan id belongs to another household');
    this.name = 'WeekPlanConflictError';
  }
}

const WEEK_DAY_NAMES_VI = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const WEEK_DAY_TYPES = new Set(['cooking', 'eat_out', 'away', 'leftover', 'flexible']);

export function resolveWeekSchemaMode(value: unknown): WeekSchemaMode {
  if (value === undefined || value === null || value === '' || value === 'legacy') return 'legacy';
  if (value === 'dual') return 'dual';
  throw new WeekDatabaseError('Unsupported WEEK_SCHEMA_MODE');
}

async function assertWeekV2Capability(db: any): Promise<void> {
  const capability = (await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM pragma_table_info('meal_plan_days_v2')
          WHERE name IN ('id', 'plan_id', 'date', 'day_of_week', 'day_type')) AS day_columns,
         (SELECT COUNT(*) FROM pragma_table_info('meal_plan_slots_v2')
          WHERE name IN ('id', 'day_id', 'plan_id', 'slot_type', 'status', 'recipe_id', 'servings',
                         'source', 'is_locked', 'leftover_source_id', 'notes', 'snapshot_json')) AS slot_columns,
         (SELECT COUNT(*) FROM pragma_table_info('meal_plan_shopping_items_v2')
          WHERE name IN ('id', 'plan_id', 'ingredient_id', 'name', 'category', 'required_quantity',
                         'inventory_quantity', 'missing_quantity', 'purchase_quantity', 'quantity', 'unit',
                         'estimated_price_min', 'estimated_price_max', 'checked', 'cannot_buy', 'snapshot_json'))
           AS shopping_columns`
    )
    .first()) as { day_columns?: number; slot_columns?: number; shopping_columns?: number } | null;

  if (
    Number(capability?.day_columns) !== 5 ||
    Number(capability?.slot_columns) !== 12 ||
    Number(capability?.shopping_columns) !== 16
  ) {
    throw new WeekDatabaseError('Week v2 schema capability is unavailable');
  }
}

type StoredMealPlanSnapshot = {
  version: 1;
  plan: MealPlan;
};

export function serializeMealPlanSnapshot(plan: MealPlan): string {
  const snapshot: StoredMealPlanSnapshot = { version: 1, plan };
  return JSON.stringify(snapshot);
}

export function parseMealPlanSnapshot(raw: unknown, planRow: any): MealPlan | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<StoredMealPlanSnapshot>;
    const plan = parsed?.version === 1 ? parsed.plan : undefined;
    if (
      !plan ||
      typeof plan !== 'object' ||
      plan.id !== planRow.id ||
      plan.householdId !== planRow.household_id ||
      !Array.isArray(plan.days) ||
      !Array.isArray(plan.shoppingItems)
    ) {
      return null;
    }
    return plan as MealPlan;
  } catch {
    return null;
  }
}

function parseJsonRecord(raw: unknown): Record<string, any> | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeWeekDayOfWeek(value: unknown, date: string): number {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 7) return numeric;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    const names: Record<string, number> = {
      sunday: 7,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
      'chủ nhật': 7,
      'chu nhat': 7,
      'thứ 2': 1,
      'thu 2': 1,
      'thứ 3': 2,
      'thu 3': 2,
      'thứ 4': 3,
      'thu 4': 3,
      'thứ 5': 4,
      'thu 5': 4,
      'thứ 6': 5,
      'thu 6': 5,
      'thứ 7': 6,
      'thu 7': 6,
    };
    if (names[normalized]) return names[normalized];
  }

  const parsedDate = new Date(`${date}T00:00:00Z`);
  const jsDay = parsedDate.getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

function normalizeWeekDayType(value: unknown): MealPlan['days'][number]['dayType'] {
  return typeof value === 'string' && WEEK_DAY_TYPES.has(value)
    ? (value as MealPlan['days'][number]['dayType'])
    : 'cooking';
}

function deriveBudgetStatus(target: number | null, min: number, max: number): MealPlan['budget']['status'] {
  if (target === null || !Number.isFinite(target)) return 'UNDER';
  if (min > target) return 'OVER';
  if (max <= target) return 'UNDER';
  return 'NEAR';
}

// Enforce multi-tenancy on all week planner routes
weekRoutes.use('/week*', tenancyGuard);

// Week commands and reads are backed by relational state. Never return a
// fabricated plan/preferences response when the D1 binding is unavailable.
weekRoutes.use('/week*', async (c, next) => {
  if (!c.env.DB) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }
  await next();
});

weekRoutes.onError((err, c) => {
  if (err instanceof WeekDatabaseError) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }
  throw err;
});

const WeekSwapSchema = z.object({
  recipeId: z.string().trim().min(1).max(160).optional(),
});
const WeekPlanCreateSchema = z.object({
  planId: z.string().trim().regex(/^[A-Za-z0-9._:-]{8,200}$/).optional(),
  commandId: z.string().trim().regex(/^[A-Za-z0-9._:-]{8,200}$/).optional(),
  idempotencyKey: z.string().trim().regex(/^[A-Za-z0-9._:-]{8,200}$/).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  householdSize: z.coerce.number().int().positive().max(20).default(2),
  mealSlotsPreset: z.enum(['dinner_only', 'working_people', 'all']).default('dinner_only'),
  selectedSlots: z
    .object({
      weekday: z.array(z.enum(['breakfast', 'lunch', 'dinner'])).max(3),
      weekend: z.array(z.enum(['breakfast', 'lunch', 'dinner'])).max(3),
    })
    .optional(),
  budgetTargetVnd: z.coerce.number().nonnegative().nullable().default(null),
  schedule: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        dayType: z.enum(['cooking', 'eat_out', 'away', 'leftover', 'flexible']),
      })
    )
    .max(14)
    .optional(),
  priorities: z
    .array(
      z.enum([
        'use_fridge',
        'budget',
        'quick',
        'variety',
        'more_veggies',
        'high_protein',
        'low_oil',
        'less_shopping',
        'meal_prep',
        'new_recipes',
      ])
    )
    .max(10)
    .default(['use_fridge']),
  shoppingFrequency: z.enum(['once', 'twice', 'three_plus', 'flexible']).default('once'),
  dietaryRestrictions: z.array(z.string().min(1).max(80)).max(20).optional(),
  dislikedIngredients: z.array(z.string().min(1).max(80)).max(50).optional(),
  preferredCuisines: z
    .array(z.enum(['vietnamese', 'korean', 'japanese', 'chinese', 'thai', 'italian']))
    .max(20)
    .optional(),
});
const WeekMealPatchSchema = z
  .object({
    status: z.enum(['PLANNED', 'FLEXIBLE', 'EATING_OUT', 'SKIPPED', 'LEFTOVER', 'COOKED']).optional(),
    notes: z.string().max(500).nullable().optional(),
    servings: z.coerce.number().int().positive().max(100).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Cần ít nhất một trường để cập nhật');
const WeekShoppingPatchSchema = z
  .object({ checked: z.boolean().optional(), cannotBuy: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, 'Cần ít nhất một trường để cập nhật');
const WeekShoppingCompleteSchema = z.object({
  commandId: z.string().trim().regex(/^[A-Za-z0-9._:-]{8,200}$/).optional(),
  idempotencyKey: z.string().trim().regex(/^[A-Za-z0-9._:-]{8,200}$/).optional(),
  items: z
    .array(z.object({ ingredientId: z.string().trim().min(1).max(100) }).passthrough())
    .max(100)
    .optional(),
});
const WeekPreferencesSchema = z.object({
  mealSlotsPreset: z.enum(['dinner_only', 'working_people', 'all']).optional(),
  budgetTargetVnd: z.coerce.number().nonnegative().nullable().optional(),
  shoppingFrequency: z.enum(['once', 'twice', 'three_plus', 'flexible']).optional(),
  priorities: z.array(z.string().min(1).max(40)).max(10).optional(),
  autoWeeklyPlanEnabled: z.boolean().optional(),
}).refine((body) => Object.keys(body).length > 0, 'Cần ít nhất một trường để cập nhật');

// Expensive operations get their own tight budget: plan generation runs the
// recipe engine + a large D1 batch; swap runs it again. 20/min per user.
weekRoutes.use(
  '/week/plans/:id/generate',
  rateLimiter({ maxRequests: 20, windowSeconds: 60, prefix: 'rl_gen' })
);
weekRoutes.use(
  '/week/plans/:id/meals/:mealId/swap',
  rateLimiter({ maxRequests: 20, windowSeconds: 60, prefix: 'rl_swap' })
);
// General week mutations (create plan, patch meals, shopping complete)
weekRoutes.use(
  '/week*',
  async (c, next) => (c.req.method === 'GET' ? next() : rateLimiter({ maxRequests: 60, windowSeconds: 60, prefix: 'rl_week_w' })(c, next))
);

function assertBatchSucceeded(results: any[] | undefined): void {
  if (results?.some((result) => result && result.success === false)) {
    throw new Error('D1 batch reported an unsuccessful statement');
  }
}

function resolveWeekCommandKey(c: any, body: { commandId?: string; idempotencyKey?: string }): string | null {
  const headerKey = c.req.header('Idempotency-Key')?.trim();
  const bodyKey = (body.commandId || body.idempotencyKey)?.trim();
  if (headerKey && bodyKey && headerKey !== bodyKey) return null;
  const key = headerKey || bodyKey;
  if (!key) return null;
  return /^[A-Za-z0-9._:-]{8,200}$/.test(key) ? key : null;
}

// Helper to save full relational meal plan into D1
export async function persistPlanRelational(
  db: any,
  plan: MealPlan,
  householdId: string,
  userId: string,
  schemaMode: WeekSchemaMode = 'legacy'
): Promise<void> {
  if (!db) throw new Error('Database service unavailable');
  if (schemaMode === 'dual') await assertWeekV2Capability(db);

  const existingPlan = (await db
    .prepare('SELECT household_id FROM meal_plans WHERE id = ? LIMIT 1')
    .bind(plan.id)
    .first()) as { household_id: string } | null;
  if (existingPlan && existingPlan.household_id !== householdId) {
    throw new WeekPlanConflictError();
  }

  // Build lifecycle cleanup and the complete snapshot in one D1 transaction.
  const oldPlans = await db
    .prepare("SELECT id FROM meal_plans WHERE household_id = ? AND id != ? AND status != 'ARCHIVED'")
    .bind(householdId, plan.id)
    .all();
  const oldIds: string[] = (oldPlans?.results || []).map((row: any) => row.id);
  const statements: any[] = [];

  if (oldIds.length > 0) {
    const placeholders = oldIds.map(() => '?').join(',');
    statements.push(
      db.prepare(`DELETE FROM meal_plan_shopping_items WHERE plan_id IN (${placeholders})`).bind(...oldIds),
      db.prepare(`DELETE FROM meal_plan_slots WHERE plan_id IN (${placeholders})`).bind(...oldIds),
      db.prepare(`DELETE FROM meal_plan_days WHERE plan_id IN (${placeholders})`).bind(...oldIds),
      db.prepare(`UPDATE meal_plans SET status = 'ARCHIVED', updated_at = datetime('now') WHERE id IN (${placeholders})`).bind(...oldIds)
    );
    if (schemaMode === 'dual') {
      statements.push(
        db.prepare(`DELETE FROM meal_plan_shopping_items_v2 WHERE plan_id IN (${placeholders})`).bind(...oldIds),
        db.prepare(`DELETE FROM meal_plan_slots_v2 WHERE plan_id IN (${placeholders})`).bind(...oldIds),
        db.prepare(`DELETE FROM meal_plan_days_v2 WHERE plan_id IN (${placeholders})`).bind(...oldIds)
      );
    }
  }

  // Rewrite the child snapshot atomically so removed slots/items cannot linger
  // after a swap or a regenerated plan. The batch rolls back all deletes if a
  // subsequent insert fails.
  statements.push(
    db.prepare('DELETE FROM meal_plan_shopping_items WHERE plan_id = ?').bind(plan.id),
    db.prepare('DELETE FROM meal_plan_slots WHERE plan_id = ?').bind(plan.id),
    db.prepare('DELETE FROM meal_plan_days WHERE plan_id = ?').bind(plan.id)
  );
  if (schemaMode === 'dual') {
    statements.push(
      db.prepare('DELETE FROM meal_plan_shopping_items_v2 WHERE plan_id = ?').bind(plan.id),
      db.prepare('DELETE FROM meal_plan_slots_v2 WHERE plan_id = ?').bind(plan.id),
      db.prepare('DELETE FROM meal_plan_days_v2 WHERE plan_id = ?').bind(plan.id)
    );
  }

  statements.push(
    db
      .prepare('INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)')
      .bind(householdId, 'Tủ lạnh gia đình', userId),
      db
        .prepare(
          `INSERT INTO meal_plans (id, household_id, start_date, end_date, status, budget_target, budget_min, budget_max, currency, shopping_frequency, fridge_utilization, waste_risk, ai_explanation, snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           household_id = excluded.household_id,
           start_date = excluded.start_date,
           end_date = excluded.end_date,
           status = excluded.status,
           budget_target = excluded.budget_target,
           budget_min = excluded.budget_min,
           budget_max = excluded.budget_max,
           currency = excluded.currency,
           shopping_frequency = excluded.shopping_frequency,
           fridge_utilization = excluded.fridge_utilization,
           waste_risk = excluded.waste_risk,
           ai_explanation = excluded.ai_explanation,
           snapshot_json = excluded.snapshot_json,
           updated_at = datetime('now')`
      )
      .bind(
        plan.id,
        householdId,
        plan.startDate,
        plan.endDate,
        plan.status,
        plan.budget.targetVnd ?? null,
        plan.budget.estimatedMinVnd,
        plan.budget.estimatedMaxVnd,
        'VND',
        plan.shoppingFrequency,
        plan.utilization.utilizationPercent,
        plan.wasteRisk.level,
        plan.aiExplanation || null,
        serializeMealPlanSnapshot(plan)
      )
  );

  for (const day of plan.days) {
    statements.push(
      db
        .prepare(
          `INSERT INTO meal_plan_days (id, plan_id, day_of_week, date, day_type)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             plan_id = excluded.plan_id,
             day_of_week = excluded.day_of_week,
             date = excluded.date,
             day_type = excluded.day_type`
        )
        .bind(day.id, plan.id, day.dayOfWeek, day.date, day.dayType)
    );
    if (schemaMode === 'dual') {
      statements.push(
        db
          .prepare(
            `INSERT INTO meal_plan_days_v2
             (id, plan_id, date, day_of_week, day_type)
             VALUES (?, ?, ?, ?, ?)`
          )
          .bind(day.id, plan.id, day.date, day.dayOfWeek, day.dayType)
      );
    }

    for (const slot of day.slots) {
      statements.push(
        db
          .prepare(
          `INSERT INTO meal_plan_slots (id, day_id, plan_id, slot_type, recipe_id, servings, status, notes, snapshot_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               day_id = excluded.day_id,
               plan_id = excluded.plan_id,
               slot_type = excluded.slot_type,
               recipe_id = excluded.recipe_id,
               servings = excluded.servings,
               status = excluded.status,
               notes = excluded.notes,
               snapshot_json = excluded.snapshot_json,
               updated_at = datetime('now')`
          )
          .bind(
            slot.id,
            day.id,
            plan.id,
            slot.slotType,
            slot.recipe?.id || null,
            slot.servings,
            slot.status,
            slot.notes || null,
            JSON.stringify(slot)
          )
      );
      if (schemaMode === 'dual') {
        statements.push(
          db
            .prepare(
              `INSERT INTO meal_plan_slots_v2
               (id, day_id, plan_id, slot_type, status, recipe_id, servings,
                source, is_locked, leftover_source_id, notes, snapshot_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              slot.id,
              day.id,
              plan.id,
              slot.slotType,
              slot.status,
              slot.recipe?.id || null,
              slot.servings,
              slot.source,
              slot.isLocked ? 1 : 0,
              slot.leftoverSourceSlotId || null,
              slot.notes || null,
              JSON.stringify(slot)
            )
        );
      }
    }
  }

  for (const item of plan.shoppingItems) {
    statements.push(
      db
        .prepare(
          `INSERT INTO meal_plan_shopping_items (id, plan_id, ingredient_id, name, quantity, unit, checked, cannot_buy, snapshot_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             plan_id = excluded.plan_id,
             ingredient_id = excluded.ingredient_id,
             name = excluded.name,
             quantity = excluded.quantity,
             unit = excluded.unit,
             checked = excluded.checked,
             cannot_buy = excluded.cannot_buy,
             snapshot_json = excluded.snapshot_json,
             updated_at = datetime('now')`
        )
        .bind(
          `shop_${plan.id}_${item.ingredientId}`,
          plan.id,
          item.ingredientId,
          item.name,
          item.recommendedPurchaseQuantity || item.missingQuantity || 1,
          item.unit,
          item.checked ? 1 : 0,
          item.cannotBuy ? 1 : 0,
          JSON.stringify(item)
        )
    );
    if (schemaMode === 'dual') {
      statements.push(
        db
          .prepare(
            `INSERT INTO meal_plan_shopping_items_v2
             (id, plan_id, ingredient_id, name, category, required_quantity,
              inventory_quantity, missing_quantity, purchase_quantity, quantity,
              unit, estimated_price_min, estimated_price_max, checked, cannot_buy,
              snapshot_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            `shop_${plan.id}_${item.ingredientId}`,
            plan.id,
            item.ingredientId,
            item.name,
            item.category,
            item.requiredQuantity,
            item.existingInventoryQuantity,
            item.missingQuantity,
            item.recommendedPurchaseQuantity,
            item.recommendedPurchaseQuantity,
            item.unit,
            item.estimatedPriceMin,
            item.estimatedPriceMax,
            item.checked ? 1 : 0,
            item.cannotBuy ? 1 : 0,
            JSON.stringify(item)
          )
      );
    }
  }

  // Re-check immediately before the batch; migration 0011 also aborts the
  // whole transaction if a raced upsert tries to change household ownership.
  const ownerBeforeCommit = (await db
    .prepare('SELECT household_id FROM meal_plans WHERE id = ? LIMIT 1')
    .bind(plan.id)
    .first()) as { household_id: string } | null;
  if (ownerBeforeCommit && ownerBeforeCommit.household_id !== householdId) {
    throw new WeekPlanConflictError();
  }

  const results = await db.batch(statements);
  assertBatchSucceeded(results);
}

async function publishPlanCache(c: any, plan: MealPlan): Promise<void> {
  if (!c.env.CACHE) return;
  try {
    await c.env.CACHE.put(`plan_active_${plan.householdId}`, JSON.stringify(plan), { expirationTtl: 604800 });
    await c.env.CACHE.put(`plan_${plan.id}`, JSON.stringify(plan), { expirationTtl: 604800 });
  } catch {
    // KV is a rebuildable cache; a D1 commit remains authoritative.
  }
}

async function commitPlan(c: any, plan: MealPlan, householdId: string, userId: string): Promise<void> {
  const schemaMode = resolveWeekSchemaMode(c.env.WEEK_SCHEMA_MODE);
  await persistPlanRelational(c.env.DB, plan, householdId, userId, schemaMode);
  await publishPlanCache(c, plan);
}

async function fetchWeekInventory(db: any, householdId: string, kv: any, actorId?: string): Promise<any[]> {
  try {
    return await fetchHouseholdInventoryFromDb(db, householdId, kv, { strict: true, actorId });
  } catch (err) {
    throw new WeekDatabaseError(err instanceof Error ? err.message : 'Failed fetching inventory');
  }
}

type ShoppingCommandClaim =
  | { kind: 'claimed'; commandId: string; lockToken: string }
  | { kind: 'replay'; payload: Record<string, unknown> }
  | { kind: 'in_progress' }
  | { kind: 'conflict' };

function resolveShoppingCommandKey(c: any, body: any, planId: string): string | null {
  const headerKey = c.req.header('Idempotency-Key');
  const bodyKey =
    body && typeof body.commandId === 'string'
      ? body.commandId
      : body && typeof body.idempotencyKey === 'string'
      ? body.idempotencyKey
      : undefined;
  const normalizedHeader = headerKey?.trim();
  const normalizedBody = bodyKey?.trim();
  if (normalizedHeader && normalizedBody && normalizedHeader !== normalizedBody) return null;
  const raw = normalizedHeader ?? normalizedBody;

  // Keep existing clients working while giving new clients a stable key. The
  // legacy key intentionally permits only one completion per plan.
  if (!raw) return `legacy:${planId}`;
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(raw)) return null;
  return raw;
}

export async function stableCommandId(householdId: string, planId: string, clientKey: string): Promise<string> {
  // Keep the durable identifier bounded and avoid delimiter collisions between
  // user-controlled idempotency keys and route identifiers.
  const input = `${householdId.length}:${householdId}|${planId.length}:${planId}|${clientKey.length}:${clientKey}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `shopcmd_${hex}`;
}

function shoppingRequestFingerprint(planId: string, items: Array<{ ingredientId: string; recommendedPurchaseQuantity?: number; missingQuantity?: number; unit: string }>): string {
  const normalized = items
    .map((item) => ({
      ingredientId: item.ingredientId.trim().toUpperCase(),
      quantity: Number(item.recommendedPurchaseQuantity || item.missingQuantity || 1),
      unit: item.unit,
    }))
    .sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
  return JSON.stringify({ planId, items: normalized });
}

async function claimShoppingCommand(
  db: any,
  householdId: string,
  planId: string,
  clientKey: string,
  requestFingerprint: string
): Promise<ShoppingCommandClaim> {
  const commandId = await stableCommandId(householdId, planId, clientKey);
  const lockToken = crypto.randomUUID();
  let row = (await db
    .prepare(
      `SELECT id, status, request_fingerprint, response_json, lock_token
       FROM shopping_import_commands
       WHERE household_id = ? AND plan_id = ? AND client_key = ?
       LIMIT 1`
    )
    .bind(householdId, planId, clientKey)
    .first()) as any;

  if (row && row.request_fingerprint !== requestFingerprint) return { kind: 'conflict' };

  if (!row) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO shopping_import_commands
         (id, household_id, plan_id, client_key, request_fingerprint, status, lock_token)
         VALUES (?, ?, ?, ?, ?, 'processing', ?)`
      )
      .bind(commandId, householdId, planId, clientKey, requestFingerprint, lockToken)
      .run();
    row = (await db
      .prepare(
        `SELECT id, status, request_fingerprint, response_json, lock_token
         FROM shopping_import_commands WHERE id = ? LIMIT 1`
      )
      .bind(commandId)
      .first()) as any;
  } else if (row.status === 'failed') {
    // Failed commands can be retried with the same key; a successful command
    // remains immutable and is handled by the replay branch above.
    await db
      .prepare(
        `UPDATE shopping_import_commands
         SET status = 'processing', lock_token = ?, error_code = NULL,
             response_json = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'failed'`
      )
      .bind(lockToken, row.id)
      .run();
    row = (await db
      .prepare(
        `SELECT id, status, request_fingerprint, response_json, lock_token
         FROM shopping_import_commands WHERE id = ? LIMIT 1`
      )
      .bind(row.id)
      .first()) as any;
  } else if (row.status === 'processing' && row.lock_token !== lockToken) {
    // A crashed worker can leave a command locked. Allow takeover only after
    // a conservative lease interval; active duplicate requests get 409.
    await db
      .prepare(
        `UPDATE shopping_import_commands
         SET lock_token = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'processing'
           AND updated_at < datetime('now', '-15 minutes')`
      )
      .bind(lockToken, row.id)
      .run();
    row = (await db
      .prepare(
        `SELECT id, status, request_fingerprint, response_json, lock_token
         FROM shopping_import_commands WHERE id = ? LIMIT 1`
      )
      .bind(row.id)
      .first()) as any;
  }

  if (!row) throw new Error('Shopping command ledger row was not created');
  if (row.request_fingerprint !== requestFingerprint) return { kind: 'conflict' };
  if (row.status === 'completed') {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.response_json || '{}');
    } catch {
      throw new Error('Shopping command has invalid stored response');
    }
    return { kind: 'replay', payload };
  }
  if (row.status !== 'processing' || row.lock_token !== lockToken) return { kind: 'in_progress' };
  return { kind: 'claimed', commandId: row.id, lockToken };
}

async function markShoppingCommandFailed(db: any, commandId: string, lockToken: string): Promise<void> {
  await db
    .prepare(
      `UPDATE shopping_import_commands
       SET status = 'failed', error_code = 'DATABASE_ERROR', updated_at = datetime('now')
       WHERE id = ? AND status = 'processing' AND lock_token = ?`
    )
    .bind(commandId, lockToken)
    .run();
}

function shoppingLeaseExistsSql(): string {
  return `EXISTS (
    SELECT 1
    FROM shopping_import_commands
    WHERE id = ?
      AND household_id = ?
      AND plan_id = ?
      AND status = 'processing'
      AND lock_token = ?
  )`;
}

async function readShoppingCommand(db: any, commandId: string, householdId: string): Promise<any | null> {
  return (await db
    .prepare(
      `SELECT id, status, request_fingerprint, response_json, lock_token
       FROM shopping_import_commands
       WHERE id = ? AND household_id = ?
       LIMIT 1`
    )
    .bind(commandId, householdId)
    .first()) as any;
}

// Helper to reconstruct the authoritative plan snapshot from D1.
async function getMealPlan(c: any, planId: string, householdId: string): Promise<MealPlan | null> {
  const db = c.env.DB;
  if (!db) throw new WeekDatabaseError();

  try {
    // D1 is authoritative. KV is populated only after a successful write and
    // is never allowed to resurrect a deleted or partially persisted plan.
    const planRow = (await db
      .prepare('SELECT * FROM meal_plans WHERE id = ? AND household_id = ?')
      .bind(planId, householdId)
      .first()) as any;

    if (!planRow) return null;

    // New writes persist the exact domain response. Returning this snapshot
    // avoids recalculating inventory-dependent fields after the stock changes.
    const storedPlan = parseMealPlanSnapshot(planRow.snapshot_json, planRow);
    if (storedPlan) {
      if (c.env.CACHE) {
        await c.env.CACHE.put(`plan_${planId}`, JSON.stringify(storedPlan), { expirationTtl: 604800 }).catch(() => {});
      }
      return storedPlan;
    }

    const daysRes = await db
      .prepare('SELECT * FROM meal_plan_days WHERE plan_id = ? ORDER BY date ASC')
      .bind(planId)
      .all();

    const slotsRes = await db
      .prepare('SELECT * FROM meal_plan_slots WHERE plan_id = ?')
      .bind(planId)
      .all();

    const shoppingRes = await db
      .prepare('SELECT * FROM meal_plan_shopping_items WHERE plan_id = ?')
      .bind(planId)
      .all();

    const days = (daysRes.results || []).map((d: any) => {
      const dayOfWeek = normalizeWeekDayOfWeek(d.day_of_week, d.date);
      const dayType = normalizeWeekDayType(d.day_type);
      const slots = (slotsRes.results || [])
        .filter((s: any) => s.day_id === d.id)
        .map((s: any) => {
          const storedSlot = parseJsonRecord(s.snapshot_json);
          const recipe = storedSlot?.recipe || ALL_RECIPES.find((r) => r.id === s.recipe_id || r.slug === s.recipe_id);
          const availability = Number(storedSlot?.availabilityPercent);
          const incrementalCost = Number(storedSlot?.incrementalCostVnd);
          const slotIngredients = Array.isArray(storedSlot?.ingredients) ? storedSlot.ingredients : [];
          const badges = Array.isArray(storedSlot?.badges) ? storedSlot.badges : [];
          const rescued = Array.isArray(storedSlot?.rescuedExpiringIngredients)
            ? storedSlot.rescuedExpiringIngredients
            : [];

          return {
            id: typeof storedSlot?.id === 'string' ? storedSlot.id : s.id,
            dayId: typeof storedSlot?.dayId === 'string' ? storedSlot.dayId : d.id,
            planId: typeof storedSlot?.planId === 'string' ? storedSlot.planId : planRow.id,
            slotType: storedSlot?.slotType || s.slot_type,
            status: storedSlot?.status || s.status,
            date: typeof storedSlot?.date === 'string' ? storedSlot.date : d.date,
            dayOfWeek: normalizeWeekDayOfWeek(storedSlot?.dayOfWeek, d.date) || dayOfWeek,
            servings: Number.isFinite(Number(storedSlot?.servings)) ? Number(storedSlot?.servings) : Number(s.servings || 2),
            notes: typeof storedSlot?.notes === 'string' ? storedSlot.notes : s.notes || undefined,
            recipe,
            source: storedSlot?.source === 'USER' ? 'USER' : 'AUTO',
            isLocked: storedSlot?.isLocked === true,
            leftoverSourceSlotId:
              typeof storedSlot?.leftoverSourceSlotId === 'string' ? storedSlot.leftoverSourceSlotId : undefined,
            isLeftover: storedSlot?.isLeftover === true,
            availabilityPercent: Number.isFinite(availability) ? Math.min(100, Math.max(0, availability)) : 0,
            incrementalCostVnd: Number.isFinite(incrementalCost) ? Math.max(0, incrementalCost) : 0,
            rescuedExpiringIngredients: rescued.filter((value: unknown): value is string => typeof value === 'string'),
            badges: badges.filter((value: unknown): value is string => typeof value === 'string'),
            ingredients: slotIngredients,
          } as MealSlotItem;
        });

        return {
        id: d.id,
        planId: planRow.id,
        date: d.date,
        dayOfWeek,
        dayNameVi: WEEK_DAY_NAMES_VI[dayOfWeek === 7 ? 0 : dayOfWeek] || `Thứ ${dayOfWeek}`,
        dayType,
        slots,
      };
    });

    const shoppingItems = (shoppingRes.results || []).map((it: any) => {
      const storedItem = parseJsonRecord(it.snapshot_json);
      const quantity = Number(it.quantity);
      const fallbackQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
      const numberOrFallback = (value: unknown, fallback: number): number => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
      };

      return {
        id: typeof storedItem?.id === 'string' ? storedItem.id : it.id,
        ingredientId:
          typeof storedItem?.ingredientId === 'string' ? storedItem.ingredientId : it.ingredient_id || '',
        name: typeof storedItem?.name === 'string' ? storedItem.name : it.name,
        missingQuantity: numberOrFallback(storedItem?.missingQuantity, fallbackQuantity),
        requiredQuantity: numberOrFallback(storedItem?.requiredQuantity, fallbackQuantity),
        existingInventoryQuantity: numberOrFallback(storedItem?.existingInventoryQuantity, 0),
        recommendedPurchaseQuantity: numberOrFallback(storedItem?.recommendedPurchaseQuantity, fallbackQuantity),
        unit: storedItem?.unit || it.unit,
        estimatedPriceMin: numberOrFallback(storedItem?.estimatedPriceMin, 0),
        estimatedPriceMax: numberOrFallback(storedItem?.estimatedPriceMax, 0),
        checked: typeof storedItem?.checked === 'boolean' ? storedItem.checked : Boolean(it.checked),
        cannotBuy: typeof storedItem?.cannotBuy === 'boolean' ? storedItem.cannotBuy : Boolean(it.cannot_buy),
        category: storedItem?.category || 'other',
        sourceRecipes: Array.isArray(storedItem?.sourceRecipes) ? storedItem.sourceRecipes : [],
      };
    });

    const targetVnd = planRow.budget_target === null || planRow.budget_target === undefined
      ? null
      : Number(planRow.budget_target);
    const estimatedMinVnd = Number.isFinite(Number(planRow.budget_min)) ? Number(planRow.budget_min) : 0;
    const estimatedMaxVnd = Number.isFinite(Number(planRow.budget_max)) ? Number(planRow.budget_max) : estimatedMinVnd;
    const wasteRiskLevel = String(planRow.waste_risk || 'LOW').toUpperCase();
    const wasteRisk = wasteRiskLevel === 'HIGH' ? 'HIGH' : wasteRiskLevel === 'MEDIUM' ? 'MEDIUM' : 'LOW';

    const plan: MealPlan = {
      id: planRow.id,
      householdId: planRow.household_id,
      startDate: planRow.start_date,
      endDate: planRow.end_date,
      status: planRow.status,
      shoppingFrequency: planRow.shopping_frequency,
      priorities: ['use_fridge'],
      budget: {
        targetVnd: Number.isFinite(targetVnd) ? targetVnd : null,
        estimatedMinVnd,
        estimatedMaxVnd,
        status: deriveBudgetStatus(Number.isFinite(targetVnd) ? targetVnd : null, estimatedMinVnd, estimatedMaxVnd),
        displayText: `~${estimatedMinVnd.toLocaleString('vi-VN')} - ${estimatedMaxVnd.toLocaleString('vi-VN')}đ`,
      },
      utilization: {
        utilizationPercent: Number.isFinite(Number(planRow.fridge_utilization)) ? Number(planRow.fridge_utilization) : 0,
        plannedItemsCount: 0,
        totalUsableItemsCount: 0,
        highPriorityUsedCount: 0,
      },
      wasteRisk: {
        level: wasteRisk,
        expiringItemsCount: 0,
        rescuedItemsCount: 0,
        displayText: wasteRisk === 'HIGH' ? 'Nguy cơ cao' : wasteRisk === 'MEDIUM' ? 'Nguy cơ trung bình' : 'Nguy cơ thấp',
      },
      days,
      shoppingItems,
      createdAt: planRow.created_at || new Date().toISOString(),
      updatedAt: planRow.updated_at || new Date().toISOString(),
      aiExplanation: typeof planRow.ai_explanation === 'string' ? planRow.ai_explanation : undefined,
    };

    // Populate KV cache for future non-authoritative reads after D1 succeeds.
    if (c.env.CACHE) {
      await c.env.CACHE.put(`plan_${planId}`, JSON.stringify(plan), { expirationTtl: 604800 }).catch(() => {});
    }

    return plan;
  } catch (err) {
    console.error('Failed reading relational meal plan from D1:', err);
    throw new WeekDatabaseError('Failed reading relational meal plan');
  }
}

// 1. GET /week/current - Get current active plan
weekRoutes.get('/week/current', async (c) => {
  const auth = c.get('auth');
  const householdId = auth.householdId;

  // D1 is authoritative; KV is refreshed only after a successful command.
  const db = c.env.DB;
  if (db) {
    try {
      const latest = (await db
        .prepare('SELECT id FROM meal_plans WHERE household_id = ? AND status != ? ORDER BY created_at DESC LIMIT 1')
        .bind(householdId, 'ARCHIVED')
        .first()) as { id: string } | null;

      if (latest) {
        const plan = await getMealPlan(c, latest.id, householdId);
        if (plan) {
          if (c.env.CACHE) {
            await c.env.CACHE.put(`plan_active_${householdId}`, JSON.stringify(plan), { expirationTtl: 604800 }).catch(() => {});
          }
          return c.json({ plan });
        }
      }
    } catch (err) {
      console.error('Failed querying current meal plan:', err);
      throw new WeekDatabaseError('Failed querying current meal plan');
    }
  }

  return c.json({ plan: null });
});

// 2. POST /week/plans - Generate a new weekly plan
weekRoutes.post('/week/plans', async (c) => {
  const auth = c.get('auth');
  const householdId = auth.householdId;
  const rawBody = await c.req.json().catch(() => ({}));
  const parsedBody = WeekPlanCreateSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return c.json(
      { error: parsedBody.error.errors[0]?.message || 'Dữ liệu thực đơn không hợp lệ', code: 'VALIDATION_ERROR' },
      400
    );
  }
  const body = parsedBody.data;
  const commandKey = resolveWeekCommandKey(c, body);
  if ((c.req.header('Idempotency-Key') || body.commandId || body.idempotencyKey) && !commandKey) {
    return c.json({ error: 'Idempotency-Key không hợp lệ hoặc không khớp', code: 'IDEMPOTENCY_CONFLICT' }, 409);
  }
  const requestedPlanId = body.planId || (commandKey ? `plan_${commandKey}` : undefined);

  // A client-generated plan id turns a lost response/offline replay into a
  // read of the already committed plan instead of generating a second one.
  if (requestedPlanId) {
    const existing = (await c.env.DB
      .prepare('SELECT household_id FROM meal_plans WHERE id = ? LIMIT 1')
      .bind(requestedPlanId)
      .first()) as { household_id: string } | null;
    if (existing && existing.household_id !== householdId) {
      return c.json({ error: 'Mã thực đơn đã thuộc hộ gia đình khác', code: 'CONFLICT' }, 409);
    }
    if (existing) {
      const committed = await getMealPlan(c, requestedPlanId, householdId);
      if (committed) return c.json({ plan: committed });
    }
  }

  const input: MealPlanSetupInput = {
    ...body,
    householdId: householdId,
    startDate: body.startDate || new Date().toISOString().split('T')[0],
    planId: requestedPlanId,
  };

  // Fetch REAL current inventory for household from D1
  let inventory: any[];
  try {
    inventory = await fetchWeekInventory(c.env.DB, householdId, c.env.CACHE, auth?.userId);
  } catch (err) {
    console.error('Failed loading inventory for weekly plan:', err);
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  // Generate plan
  const plan = generateWeeklyMealPlan(input, inventory, ALL_RECIPES);

  // Commit to D1 before publishing a cache entry. KV is never the source of
  // truth and a failed persistence must not look like a successful command.
  try {
    await commitPlan(c, plan, householdId, auth.userId);
  } catch (err) {
    console.error('Failed creating weekly meal plan:', err);
    if (err instanceof WeekPlanConflictError) {
      return c.json({ error: 'Mã thực đơn đã thuộc hộ gia đình khác', code: 'CONFLICT' }, 409);
    }
    return c.json({ error: 'Không thể lưu thực đơn tuần', code: 'DATABASE_ERROR' }, 503);
  }

  return c.json({ plan }, 201);
});

// 3. GET /week/plans/:id - Get plan by ID with Tenancy Check
weekRoutes.get('/week/plans/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const plan = await getMealPlan(c, id, auth.householdId);

  if (!plan) {
    return c.json({ error: 'Thực đơn tuần không tồn tại hoặc bạn không có quyền xem', code: 'NOT_FOUND' }, 404);
  }

  // SEC-05 FIX: Tenancy check
  if (plan.householdId !== auth.householdId) {
    return c.json({ error: 'Forbidden: Bạn không có quyền truy cập thực đơn của gia đình khác', code: 'FORBIDDEN' }, 403);
  }

  return c.json({ plan });
});

// 4. POST /week/plans/:id/generate - Regenerate plan
weekRoutes.post('/week/plans/:id/generate', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const existing = await getMealPlan(c, id, auth.householdId);

  if (!existing || existing.householdId !== auth.householdId) {
    return c.json({ error: 'Thực đơn không tồn tại hoặc bạn không có quyền thao tác', code: 'NOT_FOUND' }, 404);
  }

  let inventory: any[];
  try {
    inventory = await fetchWeekInventory(c.env.DB, auth.householdId, c.env.CACHE, auth.userId);
  } catch (err) {
    console.error('Failed loading inventory for weekly regeneration:', err);
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  const newPlan = generateWeeklyMealPlan(
    {
      householdId: existing.householdId,
      startDate: existing.startDate,
      householdSize: existing.days[0]?.slots[0]?.servings || 2,
      mealSlotsPreset: 'dinner_only',
      budgetTargetVnd: existing.budget.targetVnd,
      priorities: existing.priorities,
      shoppingFrequency: existing.shoppingFrequency,
    },
    inventory,
    ALL_RECIPES
  );

  try {
    await commitPlan(c, newPlan, auth.householdId, auth.userId);
  } catch (err) {
    console.error('Failed regenerating weekly meal plan:', err);
    return c.json({ error: 'Không thể lưu thực đơn tuần mới', code: 'DATABASE_ERROR' }, 503);
  }

  return c.json({ plan: newPlan });
});

// 5. POST /week/plans/:id/meals/:mealId/swap - Get alternatives or perform swap
weekRoutes.post('/week/plans/:id/meals/:mealId/swap', async (c) => {
  const auth = c.get('auth');
  const planId = c.req.param('id');
  const mealId = c.req.param('mealId');
  const plan = await getMealPlan(c, planId, auth.householdId);

  if (!plan || plan.householdId !== auth.householdId) {
    return c.json({ error: 'Thực đơn không tồn tại', code: 'NOT_FOUND' }, 404);
  }

  let targetSlot: MealSlotItem | undefined;
  for (const day of plan.days) {
    const found = day.slots.find((s) => s.id === mealId);
    if (found) {
      targetSlot = found;
      break;
    }
  }

  if (!targetSlot) {
    return c.json({ error: 'Bữa ăn không tồn tại trong thực đơn', code: 'NOT_FOUND' }, 404);
  }

  const rawBody = await c.req.json().catch(() => ({}));
  const parsedBody = WeekSwapSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return c.json(
      { error: parsedBody.error.errors[0]?.message || 'Dữ liệu đổi món không hợp lệ', code: 'VALIDATION_ERROR' },
      400
    );
  }
  const body = parsedBody.data;
  const recipeId = body.recipeId;

  // If no recipeId provided, return swap alternatives list
  if (!recipeId) {
    let inventory: any[];
    try {
      inventory = await fetchWeekInventory(c.env.DB, auth.householdId, c.env.CACHE, auth.userId);
    } catch (err) {
      console.error('Failed loading inventory for meal alternatives:', err);
      return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
    }
    const alternatives = getSwapAlternatives(targetSlot, inventory);
    return c.json({ alternatives });
  }

  // Execute swap
  const newRecipe = ALL_RECIPES.find((r) => r.id === recipeId || r.slug === recipeId);
  if (!newRecipe) {
    return c.json({ error: 'Công thức nấu ăn không tồn tại', code: 'NOT_FOUND' }, 404);
  }

  let inventory: any[];
  try {
    inventory = await fetchWeekInventory(c.env.DB, auth.householdId, c.env.CACHE, auth.userId);
  } catch (err) {
    console.error('Failed loading inventory for meal swap:', err);
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }
  const updatedPlan = swapMealInPlan(plan, mealId, newRecipe, inventory);

  try {
    await commitPlan(c, updatedPlan, auth.householdId, auth.userId);
  } catch (err) {
    console.error('Failed swapping weekly meal:', err);
    return c.json({ error: 'Không thể lưu thay đổi món ăn', code: 'DATABASE_ERROR' }, 503);
  }

  return c.json({ plan: updatedPlan });
});

// 6. PATCH /week/plans/:id/meals/:mealId - Update meal slot
weekRoutes.patch('/week/plans/:id/meals/:mealId', async (c) => {
  const auth = c.get('auth');
  const planId = c.req.param('id');
  const mealId = c.req.param('mealId');
  const plan = await getMealPlan(c, planId, auth.householdId);

  if (!plan || plan.householdId !== auth.householdId) {
    return c.json({ error: 'Thực đơn không tồn tại', code: 'NOT_FOUND' }, 404);
  }

  const rawBody = await c.req.json().catch(() => ({}));
  const parsedBody = WeekMealPatchSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return c.json(
      { error: parsedBody.error.errors[0]?.message || 'Dữ liệu cập nhật bữa ăn không hợp lệ', code: 'VALIDATION_ERROR' },
      400
    );
  }
  const body = parsedBody.data;

  const targetSlot = plan.days.flatMap((day) => day.slots).find((slot) => slot.id === mealId);
  if (!targetSlot) {
    return c.json({ error: 'Bữa ăn không tồn tại trong thực đơn', code: 'NOT_FOUND' }, 404);
  }

  if (body.status) targetSlot.status = body.status;
  if (body.notes !== undefined) targetSlot.notes = body.notes ?? undefined;
  if (body.servings !== undefined) targetSlot.servings = body.servings;
  targetSlot.source = 'USER';

  plan.updatedAt = new Date().toISOString();

  try {
    await commitPlan(c, plan, auth.householdId, auth.userId);
  } catch (err) {
    console.error('Failed updating weekly meal:', err);
    return c.json({ error: 'Không thể lưu thay đổi bữa ăn', code: 'DATABASE_ERROR' }, 503);
  }

  return c.json({ plan });
});

// 7. GET /week/plans/:id/shopping - Get shopping items
weekRoutes.get('/week/plans/:id/shopping', async (c) => {
  const auth = c.get('auth');
  const planId = c.req.param('id');
  const plan = await getMealPlan(c, planId, auth.householdId);

  if (!plan || plan.householdId !== auth.householdId) {
    return c.json({ error: 'Thực đơn không tồn tại', code: 'NOT_FOUND' }, 404);
  }

  return c.json({
    planId,
    items: plan.shoppingItems,
    budget: plan.budget,
    totalCount: plan.shoppingItems.length,
    checkedCount: plan.shoppingItems.filter((i) => i.checked).length,
  });
});

// 8. PATCH /week/plans/:id/shopping/items/:itemId - Toggle checked / cannotBuy
weekRoutes.patch('/week/plans/:id/shopping/items/:itemId', async (c) => {
  const auth = c.get('auth');
  const planId = c.req.param('id');
  const itemId = c.req.param('itemId');
  const plan = await getMealPlan(c, planId, auth.householdId);

  if (!plan || plan.householdId !== auth.householdId) {
    return c.json({ error: 'Thực đơn không tồn tại', code: 'NOT_FOUND' }, 404);
  }

  const rawBody = await c.req.json().catch(() => ({}));
  const parsedBody = WeekShoppingPatchSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return c.json(
      { error: parsedBody.error.errors[0]?.message || 'Dữ liệu mặt hàng không hợp lệ', code: 'VALIDATION_ERROR' },
      400
    );
  }
  const body = parsedBody.data;
  const item = plan.shoppingItems.find((i) => i.ingredientId === itemId || (i as any).id === itemId);

  if (!item) {
    return c.json({ error: 'Mặt hàng không tồn tại trong thực đơn', code: 'NOT_FOUND' }, 404);
  }

  if (body.checked !== undefined) item.checked = Boolean(body.checked);
  if (body.cannotBuy !== undefined) item.cannotBuy = Boolean(body.cannotBuy);

  try {
    await commitPlan(c, plan, auth.householdId, auth.userId);
  } catch (err) {
    console.error('Failed updating weekly shopping item:', err);
    return c.json({ error: 'Không thể lưu danh sách mua hàng', code: 'DATABASE_ERROR' }, 503);
  }

  return c.json({ item });
});

// 9. POST /week/plans/:id/shopping/complete - Complete shopping & import to inventory with D1 batch
weekRoutes.post('/week/plans/:id/shopping/complete', async (c) => {
  const auth = c.get('auth');
  const planId = c.req.param('id');
  const plan = await getMealPlan(c, planId, auth.householdId);

  // Never accept client-supplied shopping items without an existing plan in
  // this household; otherwise an arbitrary POST can import inventory.
  if (!plan || plan.householdId !== auth.householdId) {
    return c.json({ error: 'Thực đơn không tồn tại', code: 'NOT_FOUND' }, 404);
  }

  const rawBody = await c.req.json().catch(() => ({}));
  const parsedBody = WeekShoppingCompleteSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return c.json(
      { error: parsedBody.error.errors[0]?.message || 'Dữ liệu nhập hàng không hợp lệ', code: 'VALIDATION_ERROR' },
      400
    );
  }
  const body = parsedBody.data;
  const selection = selectPlanShoppingItems(plan.shoppingItems, body.items);
  if (!selection.ok && selection.reason === 'invalid_shape') {
    return c.json({ error: 'Danh sách mặt hàng không hợp lệ', code: 'VALIDATION_ERROR' }, 400);
  }
  if (!selection.ok && selection.reason === 'invalid_plan') {
    return c.json({ error: 'Dữ liệu danh sách mua của thực đơn bị hỏng', code: 'DATA_INTEGRITY_ERROR' }, 503);
  }
  if (!selection.ok) {
    return c.json(
      { error: 'Mặt hàng không thuộc danh sách mua của thực đơn này', code: 'NOT_FOUND' },
      404
    );
  }
  const canonicalItemsToImport = selection.items;
  if (canonicalItemsToImport.length === 0) {
    return c.json({ error: 'Không tìm thấy thực đơn hoặc mặt hàng để nhập', code: 'NOT_FOUND' }, 404);
  }

  const db = c.env.DB;
  const kv = c.env.CACHE;
  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  const clientKey = resolveShoppingCommandKey(c, body, planId);
  if (!clientKey) {
    return c.json({ error: 'Idempotency-Key không hợp lệ', code: 'VALIDATION_ERROR' }, 400);
  }
  const requestFingerprint = shoppingRequestFingerprint(planId, canonicalItemsToImport);

  let claim: ShoppingCommandClaim;
  try {
    claim = await claimShoppingCommand(
      db,
      auth.householdId,
      planId,
      clientKey,
      requestFingerprint
    );
  } catch (err) {
    console.error('Failed claiming shopping import command:', err);
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  if (claim.kind === 'conflict') {
    return c.json(
      { error: 'Idempotency-Key đã được dùng cho dữ liệu khác', code: 'IDEMPOTENCY_CONFLICT' },
      409
    );
  }
  if (claim.kind === 'in_progress') {
    return c.json(
      { error: 'Yêu cầu nhập hàng đang được xử lý', code: 'COMMAND_IN_PROGRESS' },
      409
    );
  }
  if (claim.kind === 'replay') {
    return c.json({ ...claim.payload, idempotentReplay: true });
  }

  const leaseSql = shoppingLeaseExistsSql();

  // Adopted households import through the lot authority; the lease-guarded
  // run/import bookkeeping stays in the same atomic batch, completion last.
  if (await readInventoryAuthorityMode(db, auth.householdId) === 'native') {
    return completeAdoptedShoppingImport(c, db, kv, auth, {
      planId, claim, clientKey, canonicalItemsToImport, leaseSql,
    });
  }

  try {
    const batchStatements: any[] = [];
    const requiredStatementIndexes: number[] = [];
    const pushStatement = (statement: any, required = false): void => {
      const index = batchStatements.length;
      batchStatements.push(statement);
      if (required) requiredStatementIndexes.push(index);
    };

    pushStatement(
      db
        .prepare('INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)')
        .bind(auth.householdId, 'Tủ lạnh gia đình', auth.userId)
    );
    pushStatement(
      db
        .prepare(
          `INSERT OR IGNORE INTO shopping_runs (id, plan_id, household_id, status, started_at)
           SELECT ?, ?, ?, 'in_progress', datetime('now')
           WHERE ${leaseSql}`
        )
        .bind(
          `run_${claim.commandId}`,
          planId,
          auth.householdId,
          claim.commandId,
          auth.householdId,
          planId,
          claim.lockToken
        )
    );

    // Fetch all matching rows in one query. A failed read aborts the command
    // rather than silently creating duplicate stock.
    const inventoryRevision = await readLegacyInventoryRevision(db, auth.householdId);
    const seenNames = canonicalItemsToImport.map((item) => item.name.trim().toLowerCase());
    const namePlaceholders = seenNames.map(() => 'LOWER(?)').join(',');
    const ingredientPlaceholders = canonicalItemsToImport.map(() => '?').join(',');
    const existingResult = await db
      .prepare(
        `SELECT id, quantity, unit, ingredient_id, LOWER(name) as lname
         FROM inventory_items
         WHERE household_id = ?
           AND (ingredient_id IN (${ingredientPlaceholders}) OR LOWER(name) IN (${namePlaceholders}))`
      )
      .bind(
        auth.householdId,
        ...canonicalItemsToImport.map((item) => item.ingredientId),
        ...seenNames
      )
      .all();
    const existingRows: any[] = existingResult?.results || [];
    for (const item of canonicalItemsToImport) {
      const qty = Number(item.recommendedPurchaseQuantity || item.missingQuantity || 1);
      const name = item.name.trim();
      const itemUnit = item.unit as StandardUnit;
      const matchingRows = existingRows.filter((row) => {
        const sameIngredient =
          row.ingredient_id === item.ingredientId ||
          (!row.ingredient_id && row.lname === name.toLowerCase());
        return sameIngredient;
      });
      const existing = matchingRows.find((row) => areUnitsCompatible(row.unit as StandardUnit, itemUnit));
      if (matchingRows.length > 0 && !existing) throw new ShoppingImportUnitError();

      let itemId: string;
      let eventQuantity = qty;
      let eventUnit = itemUnit;
      if (existing) {
        itemId = existing.id;
        const quantityInExistingUnit = convertUnit(qty, itemUnit, existing.unit as StandardUnit);
        eventQuantity = quantityInExistingUnit;
        eventUnit = existing.unit as StandardUnit;
        pushStatement(
          db
            .prepare(
              `UPDATE inventory_items
               SET quantity = quantity + ?, freshness = 'fresh', version = version + 1, updated_at = datetime('now')
               WHERE id = ? AND household_id = ? AND ${leaseSql}`
            )
            .bind(
              quantityInExistingUnit,
              itemId,
              auth.householdId,
              claim.commandId,
              auth.householdId,
              planId,
              claim.lockToken
            ),
          true
        );
      } else {
        // A genuinely new ingredient row is fine; an existing row with the
        // same ingredient but an incompatible unit is rejected above rather
        // than silently mixing pieces, grams, bunches, or packages.
        itemId = `item_shop_${claim.commandId}_${item.ingredientId}`;
        pushStatement(
          db
            .prepare(
              `INSERT INTO inventory_items
               (id, household_id, ingredient_id, name, quantity, unit, category, storage, freshness, data_source)
               SELECT ?, ?, ?, ?, ?, ?, ?, 'fridge', 'fresh', 'shopping'
               WHERE ${leaseSql}`
            )
            .bind(
              itemId,
              auth.householdId,
              item.ingredientId,
              name,
              qty,
              itemUnit,
              item.category || 'other',
              claim.commandId,
              auth.householdId,
              planId,
              claim.lockToken
            ),
          true
        );
      }

      const eventId = `evt_shop_${claim.commandId}_${item.ingredientId}`;
      pushStatement(
        db
          .prepare(
            `INSERT OR IGNORE INTO shopping_run_items
             (id, run_id, ingredient_id, name, category, quantity, unit, is_checked, cannot_buy)
             SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?
             WHERE ${leaseSql}`
          )
          .bind(
            `runitem_${claim.commandId}_${item.ingredientId}`,
            `run_${claim.commandId}`,
            item.ingredientId,
            name,
            item.category || 'other',
            qty,
            itemUnit,
            item.cannotBuy ? 1 : 0,
            claim.commandId,
            auth.householdId,
            planId,
            claim.lockToken
          ),
        true
      );
      pushStatement(
        db
          .prepare(
            `INSERT INTO inventory_events
             (id, household_id, inventory_item_id, event_type, quantity_delta, unit, reason, metadata)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?
             WHERE ${leaseSql}`
          )
          .bind(
            eventId,
            auth.householdId,
            itemId,
            'SHOPPING_IMPORT',
            eventQuantity,
            eventUnit,
            'Nhập từ đi chợ thực đơn tuần',
            JSON.stringify({ planId, commandId: claim.commandId, clientKey }),
            claim.commandId,
            auth.householdId,
            planId,
            claim.lockToken
          ),
        true
      );
    }

    const response = {
      success: true,
      importedItemsCount: canonicalItemsToImport.length,
      message: `Đã nhập thành công ${canonicalItemsToImport.length} nguyên liệu vào tủ lạnh!`,
    };
    pushStatement(
      db
        .prepare(
          `UPDATE shopping_runs
           SET status = 'completed', completed_at = datetime('now')
           WHERE id = ? AND plan_id = ? AND household_id = ? AND ${leaseSql}`
        )
        .bind(
          `run_${claim.commandId}`,
          planId,
          auth.householdId,
          claim.commandId,
          auth.householdId,
          planId,
          claim.lockToken
        ),
      true
    );
    pushStatement(
      db
        .prepare(
          `UPDATE shopping_import_commands
           SET status = 'completed', imported_items_count = ?, response_json = ?,
               completed_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ? AND household_id = ? AND plan_id = ?
             AND status = 'processing' AND lock_token = ?`
        )
        .bind(
          response.importedItemsCount,
          JSON.stringify(response),
          claim.commandId,
          auth.householdId,
          planId,
          claim.lockToken
        ),
      true
    );

    const results = await runLegacyInventoryBatch(db, auth.householdId, batchStatements, inventoryRevision,
      { sql: leaseSql, bindings: [claim.commandId, auth.householdId, planId, claim.lockToken] });
    assertBatchSucceeded(results);
    const commandStatementIndex = requiredStatementIndexes[requiredStatementIndexes.length - 1];
    const missingRequiredRow = requiredStatementIndexes
      .filter((index) => index !== commandStatementIndex)
      .some((index) => (results?.[index] as any)?.meta?.changes !== 1);
    if (missingRequiredRow) {
      const durableCommand = await readShoppingCommand(db, claim.commandId, auth.householdId);
      if (durableCommand?.status === 'completed' && durableCommand.response_json) {
        try {
          const payload = JSON.parse(durableCommand.response_json) as Record<string, unknown>;
          return c.json({ ...payload, idempotentReplay: true });
        } catch {
          return c.json(
            { error: 'Kết quả nhập hàng đã lưu bị hỏng', code: 'DATA_INTEGRITY_ERROR' },
            503
          );
        }
      }
      throw new Error('Shopping import batch did not affect every required row');
    }
    const commandResult = results?.[commandStatementIndex] as any;
    if (commandResult?.meta?.changes !== 1) {
      // The lease was fenced while this worker was building its batch. The
      // guarded statements above must all be no-ops; never report a phantom
      // success from a stale worker.
      const currentCommand = await readShoppingCommand(db, claim.commandId, auth.householdId);
      if (currentCommand?.status === 'completed' && currentCommand.response_json) {
        try {
          const payload = JSON.parse(currentCommand.response_json) as Record<string, unknown>;
          return c.json({ ...payload, idempotentReplay: true });
        } catch {
          return c.json(
            { error: 'Kết quả nhập hàng đã lưu bị hỏng', code: 'DATA_INTEGRITY_ERROR' },
            503
          );
        }
      }
      return c.json(
        {
          error: currentCommand?.status === 'processing'
            ? 'Yêu cầu nhập hàng đã được chuyển cho worker khác'
            : 'Lease của yêu cầu nhập hàng đã hết hạn, vui lòng thử lại',
          code: currentCommand?.status === 'processing' ? 'COMMAND_IN_PROGRESS' : 'COMMAND_FENCED',
        },
        409
      );
    }
    const durableCommand = await readShoppingCommand(db, claim.commandId, auth.householdId);
    if (durableCommand?.status !== 'completed' || !durableCommand.response_json) {
      return c.json(
        { error: 'Ledger nhập hàng không ghi nhận trạng thái completed', code: 'DATA_INTEGRITY_ERROR' },
        503
      );
    }
    const runId = `run_${claim.commandId}`;
    const runItems = (await db
      .prepare('SELECT COUNT(*) as count FROM shopping_run_items WHERE run_id = ?')
      .bind(runId)
      .first()) as { count?: number } | null;
    const importedEvents = (await db
      .prepare(
        `SELECT COUNT(*) as count
         FROM inventory_events
         WHERE household_id = ? AND event_type = 'SHOPPING_IMPORT'
           AND id GLOB 'evt_shop_' || ? || '_*'`
      )
      .bind(auth.householdId, claim.commandId)
      .first()) as { count?: number } | null;
    if (
      Number(runItems?.count) !== canonicalItemsToImport.length ||
      Number(importedEvents?.count) !== canonicalItemsToImport.length
    ) {
      return c.json(
        { error: 'Dữ liệu import không khớp ledger và event', code: 'DATA_INTEGRITY_ERROR' },
        503
      );
    }
    if (kv) await kv.delete(`inv_${auth.householdId}`).catch(() => {});
    return c.json(response);
  } catch (err) {
    try {
      const durable = await readShoppingCommand(db, claim.commandId, auth.householdId);
      if (durable?.status === 'completed') {
        if (durable.request_fingerprint !== requestFingerprint) {
          return c.json({ error: 'Idempotency-Key đã được dùng cho dữ liệu khác', code: 'IDEMPOTENCY_CONFLICT' }, 409);
        }
        let payload: Record<string, unknown> | null;
        try { payload = JSON.parse(durable.response_json || 'null') as Record<string, unknown> | null; }
        catch { return c.json({ error: 'Kết quả nhập hàng đã lưu bị hỏng', code: 'DATA_INTEGRITY_ERROR' }, 503); }
        if (!payload || payload.success !== true || !Number.isSafeInteger(payload.importedItemsCount)) {
          return c.json({ error: 'Kết quả nhập hàng đã lưu bị hỏng', code: 'DATA_INTEGRITY_ERROR' }, 503);
        }
        return c.json({ ...payload, idempotentReplay: true });
      }
    } catch {
      // Preserve the original failure if durable recovery cannot be read.
    }
    await markShoppingCommandFailed(db, claim.commandId, claim.lockToken).catch(() => {});
    if (err instanceof InventoryWriterAuthorityError || err instanceof InventoryWriterSnapshotError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    console.error('Failed saving shopping import to DB:', err);
    if (err instanceof ShoppingImportUnitError) {
      return c.json(
        { error: 'Đơn vị mặt hàng không tương thích với nguyên liệu hiện có', code: 'UNIT_MISMATCH' },
        422
      );
    }
    return c.json({ error: 'Lỗi nhập hàng vào tủ lạnh', code: 'DATABASE_ERROR' }, 500);
  }
});

// 10. GET /week/preferences
weekRoutes.get('/week/preferences', async (c) => {
  const auth = c.get('auth');
  const householdId = auth.householdId;
  const db = c.env.DB;

  try {
    const pref = (await db
      .prepare(
        `SELECT meal_slots_preset as mealSlotsPreset, budget_target_vnd as budgetTargetVnd, shopping_frequency as shoppingFrequency, priorities, auto_weekly_plan_enabled as autoWeeklyPlanEnabled
         FROM weekly_planner_preferences
         WHERE household_id = ?`
      )
      .bind(householdId)
      .first()) as any;

    if (pref) {
      let priorities = pref.priorities;
      try {
        priorities = typeof priorities === 'string' ? JSON.parse(priorities) : priorities;
      } catch {
        priorities = ['use_fridge'];
      }
      return c.json({
        preferences: {
          ...pref,
          priorities,
          autoWeeklyPlanEnabled: Boolean(pref.autoWeeklyPlanEnabled),
        },
      });
    }
  } catch (err) {
    console.error('Failed querying weekly preferences:', err);
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  return c.json({
    preferences: {
      mealSlotsPreset: 'dinner_only',
      budgetTargetVnd: 750000,
      shoppingFrequency: 'once',
      priorities: ['use_fridge', 'budget'],
      autoWeeklyPlanEnabled: false,
    },
  });
});

// 11. PATCH /week/preferences
weekRoutes.patch('/week/preferences', async (c) => {
  const auth = c.get('auth');
  const householdId = auth.householdId;
  const rawBody = await c.req.json().catch(() => ({}));
  const parsedBody = WeekPreferencesSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return c.json(
      { error: parsedBody.error.errors[0]?.message || 'Dữ liệu tùy chọn không hợp lệ', code: 'VALIDATION_ERROR' },
      400
    );
  }
  const body = parsedBody.data;
  const db = c.env.DB;

  try {
    const current = (await db
      .prepare(
        `SELECT meal_slots_preset as mealSlotsPreset, budget_target_vnd as budgetTargetVnd,
                shopping_frequency as shoppingFrequency, priorities,
                auto_weekly_plan_enabled as autoWeeklyPlanEnabled
         FROM weekly_planner_preferences WHERE household_id = ?`
      )
      .bind(householdId)
      .first()) as any;
    const merged = {
      mealSlotsPreset: body.mealSlotsPreset ?? current?.mealSlotsPreset ?? 'dinner_only',
      budgetTargetVnd: body.budgetTargetVnd !== undefined ? body.budgetTargetVnd : (current?.budgetTargetVnd ?? null),
      shoppingFrequency: body.shoppingFrequency ?? current?.shoppingFrequency ?? 'once',
      priorities: body.priorities ?? (typeof current?.priorities === 'string' ? JSON.parse(current.priorities) : current?.priorities) ?? ['use_fridge'],
      autoWeeklyPlanEnabled: body.autoWeeklyPlanEnabled ?? Boolean(current?.autoWeeklyPlanEnabled),
    };
    const result = await db
      .prepare(
        `INSERT INTO weekly_planner_preferences (id, household_id, meal_slots_preset, budget_target_vnd, shopping_frequency, priorities, auto_weekly_plan_enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(household_id) DO UPDATE SET
           meal_slots_preset = excluded.meal_slots_preset,
           budget_target_vnd = excluded.budget_target_vnd,
           shopping_frequency = excluded.shopping_frequency,
           priorities = excluded.priorities,
           auto_weekly_plan_enabled = excluded.auto_weekly_plan_enabled,
           updated_at = datetime('now')`
      )
      .bind(
        `pref_${householdId}`,
        householdId,
        merged.mealSlotsPreset,
        merged.budgetTargetVnd,
        merged.shoppingFrequency,
        JSON.stringify(merged.priorities),
        merged.autoWeeklyPlanEnabled ? 1 : 0
      )
      .run();
    if (result && result.success === false) throw new Error('D1 preference update failed');
    return c.json({ success: true, preferences: merged });
  } catch (err) {
    console.error('Failed saving weekly preferences to D1:', err);
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }
});

// Adopted-household shopping import: canonical lot commands for the stock
// effects plus the lease-guarded run/import bookkeeping in one atomic batch,
// with the durable command completion kept last.
async function completeAdoptedShoppingImport(c: any, db: any, kv: any, auth: AuthContext, plan: {
  planId: string;
  claim: { commandId: string; lockToken: string };
  clientKey: string;
  canonicalItemsToImport: Array<{
    ingredientId: string; name: string; unit: StandardUnit; category?: string;
    recommendedPurchaseQuantity?: number; missingQuantity?: number; cannotBuy?: boolean;
  }>;
  leaseSql: string;
}) {
  const scope = { householdId: auth.householdId, actorId: auth.userId };
  const leaseSql = plan.leaseSql;
  const leaseBindings = [plan.claim.commandId, auth.householdId, plan.planId, plan.claim.lockToken];
  try {
    const snapshot = await readAdoptedLotSnapshot(db, scope);
    const now = new Date().toISOString();
    const specs: LotCommandSpec[] = [];
    for (const item of plan.canonicalItemsToImport) {
      const qty = Number(item.recommendedPurchaseQuantity || item.missingQuantity || 1);
      const name = item.name.trim();
      const itemUnit = item.unit;
      const matchingRows = snapshot.legacyRows.filter((row) =>
        row.ingredient_id === item.ingredientId
        || (!row.ingredient_id && row.name.toLowerCase() === name.toLowerCase()));
      const existing = matchingRows.find((row) => {
        try {
          return areUnitsCompatible(row.unit as StandardUnit, itemUnit);
        } catch {
          return false;
        }
      });
      if (matchingRows.length > 0 && !existing) throw new ShoppingImportUnitError();
      if (existing) {
        const mapped = snapshot.lots.find((entry) => entry.legacyItemId === existing.id);
        if (!mapped) throw new LotCommandError('ADOPTION_REQUIRED');
        specs.push({
          clientKey: `shop-import:${plan.claim.commandId}:${item.ingredientId}:correct`,
          input: {
            type: 'CORRECT', lotId: mapped.lot.id, expectedVersion: mapped.lot.version,
            changes: { quantity: Number(existing.quantity) + convertUnit(qty, itemUnit, existing.unit as StandardUnit), unit: existing.unit },
            reason: 'Nhập từ đi chợ thực đơn tuần',
            revive: mapped.lot.state !== 'ACTIVE',
          },
        });
      } else {
        const location = snapshot.locations.find((entry) => entry.isDefault && entry.type === 'FRIDGE');
        if (!location) throw new LotCommandError('DRIFT_DETECTED');
        specs.push({
          clientKey: `shop-import:${plan.claim.commandId}:${item.ingredientId}:create`,
          input: {
            type: 'CREATE', lotId: `item_shop_${plan.claim.commandId}_${item.ingredientId}`,
            ingredientId: item.ingredientId, rawName: name, quantity: qty, unit: itemUnit,
            storageLocationId: location.id, expiryAt: null, estimatedExpiryAt: null,
            expiryKind: 'UNKNOWN', purchasedAt: null, openedAt: null, purchasePrice: null,
            sourceType: 'SHOPPING', sourceId: plan.claim.commandId,
          },
        });
      }
    }
    const composed = await composeInventoryLotCommands(db, scope, specs, now);

    const batchStatements: any[] = [
      db.prepare('INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)')
        .bind(auth.householdId, 'Tủ lạnh gia đình', auth.userId),
      db.prepare(`INSERT OR IGNORE INTO shopping_runs (id, plan_id, household_id, status, started_at)
        SELECT ?, ?, ?, 'in_progress', datetime('now') WHERE ${leaseSql}`)
        .bind(`run_${plan.claim.commandId}`, plan.planId, auth.householdId, ...leaseBindings),
    ];
    for (const item of plan.canonicalItemsToImport) {
      const name = item.name.trim();
      const qty = Number(item.recommendedPurchaseQuantity || item.missingQuantity || 1);
      batchStatements.push(
        db.prepare(`INSERT OR IGNORE INTO shopping_run_items
          (id, run_id, ingredient_id, name, category, quantity, unit, is_checked, cannot_buy)
          SELECT ?, ?, ?, ?, ?, ?, ?, 1, ? WHERE ${leaseSql}`)
          .bind(`runitem_${plan.claim.commandId}_${item.ingredientId}`, `run_${plan.claim.commandId}`,
            item.ingredientId, name, item.category || 'other', qty, item.unit,
            item.cannotBuy ? 1 : 0, ...leaseBindings)
      );
    }
    const response = {
      success: true,
      importedItemsCount: plan.canonicalItemsToImport.length,
      message: `Đã nhập thành công ${plan.canonicalItemsToImport.length} nguyên liệu vào tủ lạnh!`,
    };
    batchStatements.push(
      db.prepare(`UPDATE shopping_runs SET status = 'completed', completed_at = datetime('now')
        WHERE id = ? AND plan_id = ? AND household_id = ? AND ${leaseSql}`)
        .bind(`run_${plan.claim.commandId}`, plan.planId, auth.householdId, ...leaseBindings),
      db.prepare(`UPDATE shopping_import_commands SET status = 'completed', imported_items_count = ?,
        response_json = ?, completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND household_id = ? AND plan_id = ? AND status = 'processing' AND lock_token = ?`)
        .bind(response.importedItemsCount, JSON.stringify(response), plan.claim.commandId,
          auth.householdId, plan.planId, plan.claim.lockToken),
    );
    const results = await db.batch([...composed.statements, ...batchStatements]);
    const commandResult = results[results.length - 1] as any;
    const runResult = results[results.length - 2] as any;
    if (commandResult?.meta?.changes !== 1 || runResult?.meta?.changes !== 1) {
      // The lease was fenced while this worker was building its batch; the
      // durable command row is the only truthful completion evidence.
      const durableCommand = await readShoppingCommand(db, plan.claim.commandId, auth.householdId);
      if (durableCommand?.status === 'completed' && durableCommand.response_json) {
        try {
          const payload = JSON.parse(durableCommand.response_json) as Record<string, unknown>;
          return c.json({ ...payload, idempotentReplay: true });
        } catch {
          return c.json({ error: 'Kết quả nhập hàng đã lưu bị hỏng', code: 'DATA_INTEGRITY_ERROR' }, 503);
        }
      }
      throw new Error('Adopted shopping import batch did not complete its lease');
    }
    if (kv) await kv.delete(`inv_${auth.householdId}`).catch(() => {});
    return c.json(response);
  } catch (error: any) {
    if (error instanceof ShoppingImportUnitError) {
      return c.json({ error: 'Không thể quy đổi đơn vị nguyên liệu nhập hàng', code: 'UNIT_MISMATCH' }, 422);
    }
    if (error instanceof LotCommandError) {
      const failure = inventoryAuthorityFailure(error);
      return c.json({ error: error.message, code: failure.code }, failure.status);
    }
    console.error('Adopted shopping import failed:', error);
    return c.json({ error: 'Không thể nhập hàng vào tủ lạnh', code: 'DATABASE_ERROR' }, 500);
  }
}
