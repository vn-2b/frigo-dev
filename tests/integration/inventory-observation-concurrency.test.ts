import { afterEach, describe, expect, it } from 'vitest';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import { confirmReconciliationDecision } from '../../packages/db/src/inventory-reconciliation';
import {
  executeInventoryFefoCommand, executeInventoryLotCommand,
} from '../../packages/db/src/inventory-lot-commands';
import { recordInventoryObservation } from '../../packages/db/src/inventory-observations';
import type { ReconciliationDecisionInput } from '../../packages/db/src/inventory-reconciliation';
import { SqliteD1 } from '../helpers/sqlite-d1';

const scope = { householdId: 't10-race', actorId: 't10-race-user' };
const now = '2026-09-11T10:00:00Z';
const later = '2026-09-11T11:00:00Z';
const databases: SqliteD1[] = [];

function database(): SqliteD1 {
  const db = new SqliteD1();
  databases.push(db);
  db.seed(`INSERT INTO users(id) VALUES ('t10-race-user');
    INSERT INTO households(id, name, created_by) VALUES ('t10-race', 'Races', 't10-race-user');
    INSERT INTO household_members(id, household_id, user_id, role)
    VALUES ('t10-race-member', 't10-race', 't10-race-user', 'owner');`);
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const fridgeLocation = (db: SqliteD1) =>
  (db.query("SELECT id FROM storage_locations WHERE household_id = 't10-race' AND type = 'FRIDGE'")[0] as { id: string }).id;
const freezerLocation = (db: SqliteD1) =>
  (db.query("SELECT id FROM storage_locations WHERE household_id = 't10-race' AND type = 'FREEZER'")[0] as { id: string }).id;

const lotState = (db: SqliteD1, id: string) =>
  db.query<{ quantity_milli: number; state: string; version: number; storage_location_id: string }>(
    'SELECT quantity_milli, state, version, storage_location_id FROM inventory_lots WHERE id = ?', id)[0];

function receiptEvents(db: SqliteD1, key: string) {
  return db.query('SELECT e.* FROM inventory_events e JOIN inventory_commands c ON c.id = e.command_id WHERE c.client_key = ?', key);
}

async function setup(db: SqliteD1, quantity = 10) {
  await executeInventoryAdoption(db, scope, {}, now);
  await executeInventoryLotCommand(db, scope, 'seed-create', {
    type: 'CREATE', lotId: 'eggs', ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity,
    unit: 'piece', storageLocationId: fridgeLocation(db), sourceType: 'MANUAL',
  }, now);
  const { observation } = await recordInventoryObservation(db, scope, {
    sourceType: 'MANUAL', sourceRef: 'race-count', observedAt: now,
    ingredientId: 'CHICKEN_EGG', rawName: null, lotId: 'eggs', legacyItemId: null,
    evidence: 'OBSERVED', note: null,
    claim: { quantity: 8, unit: 'piece', quantityMilli: 8_000, canonicalUnit: 'piece',
      storage: null, expiryDate: null, expiryKind: null, openedAt: null },
  }, now);
  return observation;
}

const decisionInput = (observationId: string, decisionKey: string): ReconciliationDecisionInput => ({
  decisionKey, observationId, expectedObservationVersion: 1, decisionType: 'CORRECT',
  proposals: [{ type: 'CORRECT', lotId: 'eggs', expectedVersion: 1,
    changes: { quantity: 8, unit: 'piece' } }],
});

// Pauses the contender immediately before its atomic batch, runs the winner to
// completion, then releases the contender against committed state.
function pauseAtWriteBarrier(db: SqliteD1, runWinner: () => Promise<unknown>, marker: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let armed = true;
  db.hooks.beforeBatch = async (statements) => {
    if (!armed || !statements.some(({ sql }) => sql.includes(marker))) return;
    armed = false;
    db.hooks = {};
    await runWinner();
    release();
  };
  return { gate };
}

describe('T10F controlled reconciliation concurrency matrix', () => {
  it('F1 reconcile/reconcile same observation, same key: one winner, contender replays the committed twin, no duplicates', async () => {
    const db = database();
    const observation = await setup(db);
    const { gate } = pauseAtWriteBarrier(db,
      () => confirmReconciliationDecision(db, scope, decisionInput(observation.observationId, 'race-a'), later),
      'INSERT INTO inventory_reconciliation_decisions');
    const contender = confirmReconciliationDecision(db, scope, decisionInput(observation.observationId, 'race-a'), later);
    await gate;
    // Same key + same fingerprint: the loser's batch rolls back and it returns
    // the winner's committed receipt (response-loss semantics), never a duplicate.
    await expect(contender).resolves.toMatchObject({ replayed: true });
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 8_000, version: 2 });
    expect(db.query('SELECT count(*) AS n FROM inventory_reconciliation_decisions')[0]).toMatchObject({ n: 1 });
    expect(receiptEvents(db, 'race-a#CORRECT')).toHaveLength(1);
    // The committed decision is an exact idempotent retry afterwards.
    const replay = await confirmReconciliationDecision(db, scope, decisionInput(observation.observationId, 'race-a'), later);
    expect(replay.replayed).toBe(true);
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 8_000, version: 2 });
  });

  it('F2 reconcile/reconcile different decisions on one observation: exactly one applies', async () => {
    const db = database();
    const observation = await setup(db);
    const { gate } = pauseAtWriteBarrier(db,
      () => confirmReconciliationDecision(db, scope, decisionInput(observation.observationId, 'race-first'), later),
      'INSERT INTO inventory_reconciliation_decisions');
    const contender = confirmReconciliationDecision(db, scope, decisionInput(observation.observationId, 'race-second'), later);
    await gate;
    await expect(contender).rejects.toThrow();
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 8_000, version: 2 });
    expect(db.query('SELECT count(*) AS n FROM inventory_reconciliation_decisions')[0]).toMatchObject({ n: 1 });
    expect(db.query("SELECT status FROM inventory_observations WHERE source_ref = 'race-count'")[0])
      .toMatchObject({ status: 'RECONCILED' });
  });

  it('F3 reconcile/FEFO USE: one authority outcome, no overspend, no silent overwrite', async () => {
    const db = database();
    const observation = await setup(db, 10);
    const { gate } = pauseAtWriteBarrier(db,
      () => executeInventoryFefoCommand(db, scope, 'race-fefo', {
        type: 'USE', mode: 'FEFO', ingredientId: 'CHICKEN_EGG', quantity: 4, unit: 'piece', reason: 'Cooked',
      }, later),
      'INSERT INTO inventory_commands');
    const contender = confirmReconciliationDecision(db, scope, decisionInput(observation.observationId, 'race-fefo-dec'), later);
    await gate;
    await expect(contender).rejects.toThrow();
    // FEFO consumed 4 pieces once; the reconciliation rolled back entirely.
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 6_000, version: 2 });
    expect(db.query('SELECT count(*) AS n FROM inventory_reconciliation_decisions')[0]).toMatchObject({ n: 0 });
    expect(db.query("SELECT status FROM inventory_observations WHERE source_ref = 'race-count'")[0])
      .toMatchObject({ status: 'OPEN' });
    expect(receiptEvents(db, 'race-fefo-dec#CORRECT')).toEqual([]);
  });

  it('F4 reconcile/CORRECT and F5 reconcile/MOVE contenders fail closed against committed winners', async () => {
    for (const winner of ['CORRECT', 'MOVE'] as const) {
      const db = database();
      const observation = await setup(db);
      const { gate } = pauseAtWriteBarrier(db, () => winner === 'CORRECT'
        ? executeInventoryLotCommand(db, scope, 'race-winner', {
            type: 'CORRECT', lotId: 'eggs', expectedVersion: 1, changes: { quantity: 9 }, reason: 'Recount',
          }, later)
        : executeInventoryLotCommand(db, scope, 'race-winner', {
            type: 'MOVE', lotId: 'eggs', expectedVersion: 1, storageLocationId: freezerLocation(db),
          }, later),
      'INSERT INTO inventory_commands');
      const contender = confirmReconciliationDecision(db, scope, decisionInput(observation.observationId, 'race-pair'), later);
      await gate;
      await expect(contender).rejects.toThrow();
      expect(lotState(db, 'eggs').version).toBe(2);
      expect(db.query('SELECT count(*) AS n FROM inventory_reconciliation_decisions')[0]).toMatchObject({ n: 0 });
      if (winner === 'CORRECT') expect(lotState(db, 'eggs').quantity_milli).toBe(9_000);
      else expect(lotState(db, 'eggs').storage_location_id).toBe(freezerLocation(db));
      expect(receiptEvents(db, 'race-pair#CORRECT')).toEqual([]);
    }
  });
});
