import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { SqliteD1 } from '../helpers/sqlite-d1';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import { executeInventoryFefoCommand, executeInventoryLotCommand } from '../../packages/db/src/inventory-lot-commands';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import { planInventoryReconciliationForHousehold, confirmReconciliationDecision } from '../../packages/db/src/inventory-reconciliation';
import { recordInventoryObservation } from '../../packages/db/src/inventory-observations';
import { readInventoryAuthority } from '../../packages/db/src/inventory-read-authority';
import { fetchHouseholdInventoryFromDb } from '../../src/worker/routes/inventory';
import { notificationRoutes } from '../../src/worker/routes/notifications';
import type { InventoryObservationInput } from '../../packages/domain/src/inventory-observations';

const now = '2026-09-12T10:00:00Z';
const later = '2026-09-12T11:00:00Z';
const scope = { householdId: '', actorId: '' };
let db: SqliteD1;
let caseId = 0;
const staleKv = { put: async () => {}, get: async () => [{ id: 'stale-kv-row', quantity: 999 }] };

async function setupHousehold(withLegacy = false) {
  const id = `t12-${++caseId}`;
  scope.householdId = `hh-${id}`;
  scope.actorId = `actor-${id}`;
  db = new SqliteD1();
  db.seed(`INSERT INTO users(id) VALUES ('${scope.actorId}')`);
  db.seed(`INSERT INTO households(id, name, created_by) VALUES ('${scope.householdId}', 'T12', '${scope.actorId}')`);
  db.seed(`INSERT INTO household_members(id, household_id, user_id, role)
    VALUES ('member-1', '${scope.householdId}', '${scope.actorId}', 'owner')`);
  db.seed(`INSERT INTO storage_locations(id, household_id, type, name, sort_order, is_default, created_at, updated_at)
    VALUES ('loc-fridge-${id}', '${scope.householdId}', 'FRIDGE', 'Fridge', 0, 1, '${now}', '${now}')`);
  if (withLegacy) {
    await backfillLegacyInventory(db, scope.householdId);
    await executeInventoryAdoption(db, scope, {}, now);
  }
}
const adoptEmpty = () => setupHousehold(false);
const adoptWith = async () => { await setupHousehold(true); };

const createLot = (lotId: string, patch: Record<string, unknown> = {}) =>
  executeInventoryLotCommand(db, scope, `create-${lotId}`, {
    type: 'CREATE', lotId, ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 10, unit: 'piece',
    storageLocationId: db.query<{ id: string }>("SELECT id FROM storage_locations WHERE household_id = ? AND type = 'FRIDGE'", scope.householdId)[0].id,
    sourceType: 'MANUAL', ...patch }, now);

const observeRecord = async (claim: Record<string, unknown>, sourceRef = 't12') => {
  const input: InventoryObservationInput = {
    sourceType: 'MANUAL', sourceRef, observedAt: later, ingredientId: 'CHICKEN_EGG', rawName: null,
    lotId: db.query<{ id: string }>('SELECT id FROM inventory_lots')[0]?.id ?? null, legacyItemId: null,
    evidence: 'OBSERVED', note: null,
    claim: { quantity: 7, unit: 'piece', quantityMilli: 7_000, canonicalUnit: 'piece',
      storage: null, expiryDate: null, expiryKind: null, openedAt: null, ...claim },
  };
  const recorded = await recordInventoryObservation(db, scope, input, later);
  return recorded;
};

const notificationApp = () => {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: { auth: { userId: string; householdId: string } } }>();
  app.use('*', async (c, next) => { c.set('auth', { userId: scope.actorId, householdId: scope.householdId }); await next(); });
  app.route('/', notificationRoutes);
  return app;
};

const funnel = () => fetchHouseholdInventoryFromDb(db, scope.householdId, staleKv, { strict: true, actorId: scope.actorId });

describe('T12 closed loop — observation → reconciliation → T09 authority → lots → T11 read', () => {
  it('E2E: before reconciliation the read still shows 10/fridge; accepted CORRECT+MOVE moves authority to 7/freezer exactly once; replay replays; altered key conflicts', async () => {
    await adoptWith();
    await createLot('eggs', { expiryAt: '2026-09-30', expiryKind: 'KNOWN' });
    const { observation: observationRecord } = await observeRecord({ quantity: 7, storage: 'freezer' });

    // Evidence only: the read is untouched by the observation.
    expect(await funnel()).toMatchObject([{ quantity: 10, storage: 'fridge' }]);

    const [finding] = await planInventoryReconciliationForHousehold(db, scope.householdId, [observationRecord]);
    expect(finding.proposals.map((p) => p.type)).toEqual(['CORRECT', 'MOVE']);
    const decision = { decisionKey: 'accept-7', observationId: observationRecord.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT' as const, proposals: finding.proposals };
    const confirmed = await confirmReconciliationDecision(db, scope, decision, later);
    expect(confirmed).toMatchObject({ replayed: false, decisionType: 'CORRECT', executions: [expect.anything(), expect.anything()] });
    expect(db.query<{ status: string }>("SELECT status FROM inventory_observations WHERE source_ref = 't12'")[0].status).toBe('RECONCILED');

    // T09 authority poststate...
    expect(db.query<{ quantity_milli: number; state: string; version: number }>(
      "SELECT quantity_milli, state, version FROM inventory_lots")[0])
      .toMatchObject({ quantity_milli: 7_000, state: 'ACTIVE', version: 3 }); // CORRECT + MOVE
    // ...exactly-once receipts/events/commands...
    expect(db.query<{ client_key: string }>("SELECT client_key FROM inventory_commands WHERE client_key LIKE '%#%' ORDER BY client_key")
      .map((r) => r.client_key))
      .toEqual(['accept-7#CORRECT', 'accept-7#MOVE']);
    expect(db.query('SELECT decision_key FROM inventory_reconciliation_decisions')).toHaveLength(1);
    // The two T09 commands each carry exactly one event; the decision receipt is single.
    expect(db.query<{ n: number }>(`SELECT count(*) AS n FROM inventory_events e
      JOIN inventory_commands c ON c.id = e.command_id WHERE c.client_key LIKE 'accept-7#%'`)[0].n).toBe(2);
    // ...and the T11 read reflects the exact poststate (never a hybrid).
    expect(await funnel()).toMatchObject([{ quantity: 7, storage: 'freezer', version: 3 }]);
    const authority = await readInventoryAuthority(db, scope);
    expect(authority.items[0]).toMatchObject({ quantity: 7, storage: 'freezer', version: 3 });
    // Compatibility projection is coherent (parity clean).
    const { assertProjectionParity } = await import('../../packages/db/src/inventory-read-authority');
    expect(await assertProjectionParity(db, scope)).toEqual([]);

    // Response-loss retry: exact replay.
    expect(await confirmReconciliationDecision(db, scope, decision, later))
      .toMatchObject({ replayed: true, decisionType: 'CORRECT' });
    expect(db.query<{ status: string }>("SELECT status FROM inventory_observations WHERE source_ref = 't12'")[0].status).toBe('RECONCILED');
    expect(db.query('SELECT decision_key FROM inventory_reconciliation_decisions')).toHaveLength(1);
    // Altered semantics on the same key: conflict.
    await expect(confirmReconciliationDecision(db, scope,
      { ...decision, proposals: [finding.proposals[0]] }, later))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('DISMISS: observation state changes, truth stays 10 — no stock command, no version bump, read stays 10', async () => {
    await adoptWith();
    await createLot('eggs');
    const { observation: dismissRecord } = await observeRecord({ quantity: 99 }, 'phantom-99');
    const decision = { decisionKey: 'dismiss-99', observationId: dismissRecord.observationId,
      expectedObservationVersion: 1, decisionType: 'DISMISS' as const };
    const confirmed = await confirmReconciliationDecision(db, scope, decision, later);
    expect(confirmed).toMatchObject({ replayed: false, decisionType: 'DISMISS', executions: [] });
    expect(db.query<{ status: string }>("SELECT status FROM inventory_observations WHERE source_ref = 'phantom-99'")[0].status).toBe('RECONCILED');
    // No T09 stock command for 99 (only the earlier CREATE remains), no stock
    // mutation of any kind.
    expect(db.query<{ client_key: string }>("SELECT client_key FROM inventory_commands WHERE client_key NOT LIKE 'create-%'")).toEqual([]);
    expect(db.query<{ quantity_milli: number; version: number }>('SELECT quantity_milli, version FROM inventory_lots')[0])
      .toMatchObject({ quantity_milli: 10_000, version: 1 });
    expect(await funnel()).toMatchObject([{ quantity: 10 }]);
  });

  it('Recipe context: authority 500 g beats a 5 kg tampered projection; after USE 200 g it sees 300 g', async () => {
    await adoptWith();
    await createLot('chicken', { ingredientId: 'GROUND_PORK', rawName: 'Chicken', quantity: 500, unit: 'g' });
    db.seed("UPDATE inventory_items SET quantity = 5, unit = 'kg' WHERE id = 'chicken'");
    // The recipe ingredient context is built from the shared funnel (READ_CONSUMER_MAP).
    expect((await funnel()).filter((item) => item.id === 'chicken'))
      .toMatchObject([{ id: 'chicken', quantity: 500, unit: 'g', quantityMilli: 500_000 }]);
    // T09 writers refuse to mutate while the projection drifts (fail closed);
    // the projection is repaired before the cook, never the authority.
    await expect(executeInventoryFefoCommand(db, scope, 'use-drifted', {
      type: 'USE', mode: 'FEFO', ingredientId: 'GROUND_PORK', quantity: 200, unit: 'g', reason: 'Curry' }, now))
      .rejects.toMatchObject({ code: 'DRIFT_DETECTED' });
    db.seed("UPDATE inventory_items SET quantity = 500, unit = 'g' WHERE id = 'chicken'");
    await executeInventoryFefoCommand(db, scope, 'use-200', {
      type: 'USE', mode: 'FEFO', ingredientId: 'GROUND_PORK', quantity: 200, unit: 'g', reason: 'Curry' }, now);
    expect((await funnel()).filter((item) => item.id === 'chicken'))
      .toMatchObject([{ id: 'chicken', quantity: 300, unit: 'g', quantityMilli: 300_000 }]);
    expect(db.query<{ quantity: number }>("SELECT quantity FROM inventory_items WHERE id = 'chicken'")[0].quantity)
      .toBe(300); // projection mirrors atomically, never leads
  });

  it('Weekly planner regeneration: after a T09 CORRECT the planner inventory read sees the NEW authority state (no stale KV/projection)', async () => {
    await adoptWith();
    await createLot('eggs');
    expect(await funnel()).toMatchObject([{ quantity: 10 }]);
    await executeInventoryLotCommand(db, scope, 'correct-3', {
      type: 'CORRECT', lotId: 'eggs', expectedVersion: 1, changes: { quantity: 3 }, reason: 'Counted' }, now);
    const plannerRead = await funnel();
    expect(plannerRead).toMatchObject([{ quantity: 3, version: 2 }]);
    expect(db.query<{ quantity: number }>("SELECT quantity FROM inventory_items WHERE id = 'eggs'")[0].quantity).toBe(3);
  });

  it('Shopping → authority → read: adopted import applies through T09 and is idempotent on retry (no double-add)', async () => {
    await adoptEmpty();
    await executeInventoryLotCommand(db, scope, 'buy-milk-1', {
      type: 'CREATE', lotId: 'milk-1', ingredientId: 'FRESH_MILK', rawName: 'Milk', quantity: 1, unit: 'l',
      storageLocationId: db.query<{ id: string }>("SELECT id FROM storage_locations WHERE type = 'FRIDGE'")[0].id,
      sourceType: 'SHOPPING', sourceId: 'shopping-list-1' }, now);
    // Exact retry of the same client key must not double-add purchased stock.
    expect(await executeInventoryLotCommand(db, scope, 'buy-milk-1', {
      type: 'CREATE', lotId: 'milk-1', ingredientId: 'FRESH_MILK', rawName: 'Milk', quantity: 1, unit: 'l',
      storageLocationId: db.query<{ id: string }>("SELECT id FROM storage_locations WHERE type = 'FRIDGE'")[0].id,
      sourceType: 'SHOPPING', sourceId: 'shopping-list-1' }, now)).toMatchObject({ replayed: true });
    expect(db.query('SELECT id FROM inventory_lots')).toHaveLength(1);
    expect(await funnel()).toMatchObject([{ quantity: 1000, unit: 'ml' }]);
  });

  it('Cook/FEFO loop: multi-lot consumption is atomic and the read shows the exact poststate', async () => {
    await adoptEmpty();
    await createLot('eggs-early', { expiryAt: '2026-09-14', expiryKind: 'KNOWN' });
    await createLot('eggs-late', { expiryAt: '2026-09-30', expiryKind: 'KNOWN' });
    await executeInventoryFefoCommand(db, scope, 'cook', {
      type: 'USE', mode: 'FEFO', ingredientId: 'CHICKEN_EGG', quantity: 14, unit: 'piece', reason: 'Baking' }, now);
    expect(db.query<{ id: string; state: string; quantity_milli: number }>('SELECT id, state, quantity_milli FROM inventory_lots ORDER BY id'))
      .toEqual([{ id: 'eggs-early', state: 'CONSUMED', quantity_milli: 0 }, { id: 'eggs-late', state: 'ACTIVE', quantity_milli: 6_000 }]);
    expect(await funnel()).toEqual([expect.objectContaining({ lotId: 'eggs-late', quantity: 6, version: 2 })]);
  });

  it('Notification loop: expiry reminders derive from authority — tampered projection cannot fabricate stock, terminal lots stay silent', async () => {
    await adoptWith();
    await createLot('eggs', { expiryAt: '2026-09-13', expiryKind: 'KNOWN' }); // expiring within 24h
    db.seed("UPDATE inventory_items SET quantity = 0 WHERE id = 'eggs'"); // projection claims empty
    const response = await notificationApp().request('/notifications', {}, { DB: db });
    expect(response.status).toBe(200);
    const { notifications } = await response.json() as { notifications: Array<{ title: string }> };
    // Authority (10 eggs, expiring tomorrow) drives the reminder despite the tampered projection.
    expect(notifications.some((n) => n.title.includes('Eggs'))).toBe(true);
    // A drifted projection also makes T09 writers refuse to mutate (fail closed)…
    await expect(executeInventoryLotCommand(db, scope, 'discard-drifted', {
      type: 'DISCARD', lotId: 'eggs', expectedVersion: 1, quantity: 10, unit: 'piece', reason: 'Spoiled' }, now))
      .rejects.toMatchObject({ code: 'DRIFT_DETECTED' });
    // …and after the projection is repaired the discard proceeds.
    db.seed("UPDATE inventory_items SET quantity = 10 WHERE id = 'eggs'");
    await executeInventoryLotCommand(db, scope, 'discard', {
      type: 'DISCARD', lotId: 'eggs', expectedVersion: 1, quantity: 10, unit: 'piece', reason: 'Spoiled' }, now);
    const after = await notificationApp().request('/notifications', {}, { DB: db });
    const { notifications: afterList } = await after.json() as { notifications: Array<{ title: string }> };
    expect(afterList.some((n) => n.title.includes('Eggs'))).toBe(false);
  });

  it('Reconciliation vs manual CORRECT race: exactly one winner via lot CAS; the read shows one coherent state', async () => {
    await adoptWith();
    await createLot('eggs');
    const { observation: observationRecord } = await observeRecord({ quantity: 7 });
    const [finding] = await planInventoryReconciliationForHousehold(db, scope.householdId, [observationRecord]);
    let during: Awaited<ReturnType<typeof readInventoryAuthority>> | undefined;
    let armed = true;
    const gate = new Promise<void>((release) => {
      db.hooks.beforeBatch = async (statements) => {
        if (!armed || !statements.some(({ sql }) => sql.includes('INSERT INTO inventory_reconciliation_decisions'))) return;
        armed = false;
        db.hooks = {};
        during = await readInventoryAuthority(db, scope);
        await executeInventoryLotCommand(db, scope, 'manual-9', {
          type: 'CORRECT', lotId: 'eggs', expectedVersion: 1, changes: { quantity: 9 }, reason: 'Manual wins' }, now);
        release();
      };
    });
    const loser = confirmReconciliationDecision(db, scope, {
      decisionKey: 'race-7', observationId: observationRecord.observationId, expectedObservationVersion: 1,
      decisionType: 'CORRECT', proposals: finding.proposals }, later);
    await gate;
    // The loser must classify to the explicit T09 CAS loss (household
    // inventory_version guard -> STALE_SNAPSHOT). A generic PERSISTENCE_FAILED
    // is not acceptable for this known race.
    await expect(loser).rejects.toMatchObject({ name: 'LotCommandError', code: 'STALE_SNAPSHOT' });
    // Nothing of the loser committed: no decision receipt, no losing commands
    // or events, observation still OPEN at v1 (re-plannable), projection intact.
    expect(db.query('SELECT decision_key FROM inventory_reconciliation_decisions')).toEqual([]);
    expect(db.query<{ client_key: string }>('SELECT client_key FROM inventory_commands ORDER BY client_key').map((r) => r.client_key))
      .toEqual(['create-eggs', 'manual-9']);
    expect(db.query<{ n: number }>("SELECT count(*) AS n FROM inventory_events e JOIN inventory_commands c ON c.id = e.command_id WHERE c.client_key LIKE 'race-7%'")[0].n).toBe(0);
    expect(db.query<{ status: string; version: number }>('SELECT status, version FROM inventory_observations')[0]).toEqual({ status: 'OPEN', version: 1 });
    const { assertProjectionParity } = await import('../../packages/db/src/inventory-read-authority');
    expect(await assertProjectionParity(db, scope)).toEqual([]);
    // Manual T09 CORRECT wins the lot CAS while the decision batch was paused.
    expect(db.query<{ quantity_milli: number; version: number }>('SELECT quantity_milli, version FROM inventory_lots')[0])
      .toMatchObject({ quantity_milli: 9_000, version: 2 });
    expect(during!.items[0]).toMatchObject({ quantity: 10, version: 1 });
    expect(db.query<{ quantity_milli: number; version: number }>('SELECT quantity_milli, version FROM inventory_lots')[0])
      .toMatchObject({ quantity_milli: 9_000, version: 2 });
    expect(await funnel()).toMatchObject([{ quantity: 9, version: 2 }]);
  });

  it('Projection drift matrix: quantity/unit/storage/expiry/version tampering never alters the authority read and parity reports each drift', async () => {
    await adoptWith();
    await createLot('eggs', { expiryAt: '2026-09-30', expiryKind: 'KNOWN' });
    const { assertProjectionParity } = await import('../../packages/db/src/inventory-read-authority');
    expect(await assertProjectionParity(db, scope)).toEqual([]);
    db.seed("UPDATE inventory_items SET quantity = 55 WHERE id = 'eggs'");
    expect((await assertProjectionParity(db, scope))[0]).toMatchObject({ code: 'QUANTITY_DRIFT' });
    db.seed("UPDATE inventory_items SET quantity = 10, unit = 'g' WHERE id = 'eggs'");
    expect((await assertProjectionParity(db, scope))[0]).toMatchObject({ code: 'UNIT_DRIFT' });
    db.seed("UPDATE inventory_items SET unit = 'piece', storage = 'freezer' WHERE id = 'eggs'");
    expect((await assertProjectionParity(db, scope))[0]).toMatchObject({ code: 'STORAGE_DRIFT' });
    db.seed("UPDATE inventory_items SET storage = 'fridge', expiry_date = '2026-09-14' WHERE id = 'eggs'");
    expect((await assertProjectionParity(db, scope))[0]).toMatchObject({ code: 'EXPIRY_DRIFT' });
    db.seed("UPDATE inventory_items SET expiry_date = NULL, version = 99 WHERE id = 'eggs'");
    expect((await assertProjectionParity(db, scope))[0]).toMatchObject({ code: 'VERSION_DRIFT' });
    // Every drift: the read stays authority-correct and the funnel never switches back to projection.
    expect(await funnel()).toMatchObject([{ quantity: 10, unit: 'piece', storage: 'fridge', expiryDate: '2026-09-30' }]);
  });
});
