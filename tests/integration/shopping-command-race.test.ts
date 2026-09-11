import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MealPlan } from '../../packages/domain/src';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { weekRoutes } from '../../src/worker/routes/week';
import type { AuthContext, Env, WeekSchemaMode } from '../../src/worker/types';
import { signJwt } from '../../src/worker/utils/jwt';
import { SqliteD1 } from '../helpers/sqlite-d1';

const userId = 'shopping-race-user';
const householdId = 'shopping-race-household';
const secret = 'test-only-shopping-command-race-secret';
const planId = 'shopping-race-plan';
const commandKey = 'shopping-race-command-key';
const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
app.use('*', authMiddleware);
app.route('/', weekRoutes);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('shopping first-claim races (real SQLite HTTP)', () => {
  let db: SqliteD1;
  let token: string;

  beforeEach(async () => {
    db = new SqliteD1();
    db.execute('INSERT INTO users (id, email) VALUES (?, ?)', [userId, 'shopping-race@example.invalid']);
    db.execute('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)',
      [householdId, 'Shopping race test', userId]);
    db.execute('INSERT INTO household_members (id, household_id, user_id, role) VALUES (?, ?, ?, ?)',
      ['shopping-race-member', householdId, userId, 'owner']);
    token = await signJwt({ sub: userId, hid: householdId, typ: 'access',
      exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
  });

  afterEach(() => db.close());

  async function request<T = Record<string, unknown>>(mode: WeekSchemaMode, path: string,
    body: unknown, key?: string) {
    const response = await app.fetch(new Request(`https://shopping-race.example${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}) },
      body: JSON.stringify(body),
    }), { DB: db, ENVIRONMENT: 'test', JWT_SECRET: secret, WEEK_SCHEMA_MODE: mode });
    return { status: response.status, json: await response.json() as T };
  }

  function facts() {
    return Object.fromEntries([
      'households', 'inventory_items', 'inventory_lots', 'inventory_events', 'inventory_commands',
      'shopping_import_commands', 'shopping_runs', 'shopping_run_items', 'meal_plans',
      'meal_plan_days', 'meal_plan_slots', 'meal_plan_days_v2', 'meal_plan_slots_v2',
      'meal_plan_shopping_items', 'meal_plan_shopping_items_v2',
    ].map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY id`)]));
  }

  describe.each<WeekSchemaMode>(['legacy', 'dual'])('%s Week compatibility', (mode) => {
    it('replays the completed winner when an expired prepared lease resumes', async () => {
      const created = await request<{ plan: MealPlan }>(mode, '/week/plans', {
        planId, startDate: '2026-09-07', householdSize: 2, mealSlotsPreset: 'dinner_only',
        priorities: ['use_fridge'], shoppingFrequency: 'once',
      });
      expect(created.status).toBe(201);
      const body = { items: [{ ingredientId: created.json.plan.shoppingItems[0].ingredientId }] };
      const path = `/week/plans/${planId}/shopping/complete`;
      const paused = deferred();
      const release = deferred();
      db.hooks.beforeBatch = async (statements) => {
        if (statements.some(({ sql }) => sql.includes('T09_SNAPSHOT_FENCE'))) {
          db.hooks = {};
          paused.resolve();
          await release.promise;
        }
      };
      const pending = request(mode, path, body, commandKey);
      try {
        await Promise.race([paused.promise, pending.then(() => { throw new Error('Lease contender missed barrier'); })]);
        db.execute("UPDATE shopping_import_commands SET updated_at = datetime('now', '-20 minutes') WHERE household_id = ?", [householdId]);
        const winner = await request(mode, path, body, commandKey);
        expect(winner.status).toBe(200);
        const committed = facts();
        release.resolve();
        const contender = await pending;
        expect(contender).toEqual({ status: 200, json: { ...winner.json, idempotentReplay: true } });
        expect(facts()).toEqual(committed);
      } finally {
        release.resolve();
        await pending;
      }
    });

    it('recovers a committed result after the final D1 batch response is lost', async () => {
      const created = await request<{ plan: MealPlan }>(mode, '/week/plans', {
        planId, startDate: '2026-09-07', householdSize: 2, mealSlotsPreset: 'dinner_only',
        priorities: ['use_fridge'], shoppingFrequency: 'once',
      });
      expect(created.status).toBe(201);
      const body = { items: [{ ingredientId: created.json.plan.shoppingItems[0].ingredientId }] };
      const path = `/week/plans/${planId}/shopping/complete`;
      let loseResponse = false;
      db.hooks = {
        beforeBatch: (statements) => { loseResponse = statements.some(({ sql }) => sql.includes('T09_SNAPSHOT_FENCE')); },
        afterBatch: () => {
          if (loseResponse) {
            db.hooks = {};
            throw new Error('Response lost after COMMIT');
          }
        },
      };
      const recovered = await request(mode, path, body, commandKey);
      expect(recovered).toMatchObject({ status: 200, json: { success: true, idempotentReplay: true, importedItemsCount: 1 } });
      const committed = facts();
      expect(db.query('SELECT * FROM inventory_items WHERE household_id = ?', householdId)).toHaveLength(1);
      expect(db.query('SELECT * FROM inventory_events WHERE household_id = ?', householdId)).toHaveLength(1);
      expect(await request(mode, path, body, commandKey)).toEqual(recovered);
      expect(facts()).toEqual(committed);
    });

    it.each([false, true])('checks the durable fingerprint after losing the first claim (same payload: %s)', async (samePayload) => {
      const created = await request<{ plan: MealPlan }>(mode, '/week/plans', {
        planId, startDate: '2026-09-07', householdSize: 2, mealSlotsPreset: 'dinner_only',
        priorities: ['use_fridge'], shoppingFrequency: 'once',
      });
      expect(created.status).toBe(201);
      const [winnerItem, otherItem] = created.json.plan.shoppingItems;
      expect(winnerItem).toBeDefined();
      expect(otherItem).toBeDefined();
      expect(winnerItem.ingredientId).not.toBe(otherItem.ingredientId);
      const winnerBody = { items: [{ ingredientId: winnerItem.ingredientId }] };
      const loserBody = samePayload ? winnerBody : { items: [{ ingredientId: otherItem.ingredientId }] };
      const path = `/week/plans/${planId}/shopping/complete`;
      const paused = deferred();
      const release = deferred();
      let emptyReadCount = 0;
      db.hooks = {
        afterStatement: async (event, result) => {
          if (event.method === 'first' && result === null
            && event.sql.includes('WHERE household_id = ? AND plan_id = ? AND client_key = ?')) {
            db.hooks = {};
            emptyReadCount += 1;
            paused.resolve();
            await release.promise;
          }
        },
      };

      const loserRequest = request(mode, path, loserBody, commandKey);
      try {
        await Promise.race([paused.promise, loserRequest.then(() => {
          throw new Error('Losing request did not pause after its empty command read');
        })]);
        const winner = await request(mode, path, winnerBody, commandKey);
        expect(winner.status).toBe(200);
        expect(winner.json).toMatchObject({ success: true, importedItemsCount: 1 });
        expect(winner.json.idempotentReplay).toBeUndefined();
        const committed = facts();
        release.resolve();
        const loser = await loserRequest;

        expect(emptyReadCount).toBe(1);
        expect(loser.status).toBe(samePayload ? 200 : 409);
        if (samePayload) {
          expect(loser.json).toEqual({ ...winner.json, idempotentReplay: true });
        } else {
          expect(loser.json).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
          expect(loser.json.idempotentReplay).toBeUndefined();
        }
        expect(facts()).toEqual(committed);
        expect(db.query('SELECT ingredient_id FROM inventory_items WHERE household_id = ?', householdId))
          .toEqual([{ ingredient_id: winnerItem.ingredientId }]);
        expect(db.query('SELECT status FROM shopping_import_commands WHERE household_id = ?', householdId))
          .toEqual([{ status: 'completed' }]);
        expect(db.query('SELECT status FROM shopping_runs WHERE household_id = ?', householdId))
          .toEqual([{ status: 'completed' }]);
        expect(db.query(`SELECT event_type FROM inventory_events WHERE household_id = ?`, householdId))
          .toEqual([{ event_type: 'SHOPPING_IMPORT' }]);

        const replay = await request(mode, path, winnerBody, commandKey);
        expect(replay.status).toBe(200);
        expect(replay.json).toEqual({ ...winner.json, idempotentReplay: true });
        expect(facts()).toEqual(committed);
      } finally {
        release.resolve();
        await loserRequest;
      }
    });
  });
});
