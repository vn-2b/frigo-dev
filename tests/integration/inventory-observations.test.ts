import { afterEach, describe, expect, it } from 'vitest';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import {
  confirmReconciliationDecision, planInventoryReconciliationForHousehold,
  readReconciliationDecisions, readReconciliationSnapshot,
} from '../../packages/db/src/inventory-reconciliation';
import {
  MAX_OBSERVATION_LIST_LIMIT, readInventoryObservation, readInventoryObservations,
  recordInventoryObservation,
} from '../../packages/db/src/inventory-observations';
import { executeInventoryLotCommand } from '../../packages/db/src/inventory-lot-commands';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import type { InventoryObservationInput } from '../../packages/domain/src/inventory-observations';
import type { ReconciliationDecisionInput } from '../../packages/db/src/inventory-reconciliation';
import { SqliteD1 } from '../helpers/sqlite-d1';

const scope = { householdId: 't10-a', actorId: 't10-user-a' };
const foreign = { householdId: 't10-b', actorId: 't10-user-b' };
const now = '2026-09-11T10:00:00Z';
const later = '2026-09-11T11:00:00Z';
const databases: SqliteD1[] = [];

function database(): SqliteD1 {
  const db = new SqliteD1();
  databases.push(db);
  db.seed(`INSERT INTO users(id) VALUES ('t10-user-a'), ('t10-user-b');
    INSERT INTO households(id, name, created_by) VALUES ('t10-a', 'A', 't10-user-a'), ('t10-b', 'B', 't10-user-b');
    INSERT INTO household_members(id, household_id, user_id, role) VALUES
      ('member-a', 't10-a', 't10-user-a', 'owner'), ('member-b', 't10-b', 't10-user-b', 'owner');`);
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const fridgeLocation = (db: SqliteD1, household = scope.householdId) =>
  (db.query(`SELECT id FROM storage_locations WHERE household_id = '${household}' AND type = 'FRIDGE'`)[0] as { id: string }).id;

async function adoptEmpty(db: SqliteD1, owner = scope) {
  const result = await executeInventoryAdoption(db, owner, {}, now);
  expect(result.replayed).toBe(false);
}

async function createLot(db: SqliteD1, id: string, quantity: number,
  patch: Record<string, unknown> = {}, owner = scope) {
  return executeInventoryLotCommand(db, owner, `create-${id}`, {
    type: 'CREATE', lotId: id, ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity,
    unit: 'piece', storageLocationId: fridgeLocation(db, owner.householdId), sourceType: 'MANUAL', ...patch,
  }, now);
}

const lotState = (db: SqliteD1, id: string) =>
  db.query<{ quantity_milli: number; state: string; version: number }>(
    'SELECT quantity_milli, state, version FROM inventory_lots WHERE id = ?', id)[0];

const observationInput = (patch: Record<string, unknown> = {}): InventoryObservationInput => ({
  sourceType: 'MANUAL',
  sourceRef: 'count-1',
  observedAt: now,
  ingredientId: 'CHICKEN_EGG' as string | null,
  rawName: null,
  lotId: null as string | null,
  legacyItemId: null as string | null,
  evidence: 'OBSERVED',
  note: null,
  claim: { quantity: 10, unit: 'piece', quantityMilli: 10_000, canonicalUnit: 'piece',
    storage: null, expiryDate: null, expiryKind: null, openedAt: null },
  ...patch,
} as InventoryObservationInput);

function facts(db: SqliteD1) {
  return Object.fromEntries(['inventory_observations', 'inventory_reconciliation_decisions',
    'inventory_commands', 'inventory_events', 'inventory_lots']
    .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY id`)]));
}

describe('observation persistence (T10C)', () => {
  it('persists an observation with the household-authoritative inventory version', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { observation, replayed } = await recordInventoryObservation(db, scope, observationInput(), now);
    expect(replayed).toBe(false);
    expect(observation.observationId).toBe('t10-observation:t10-a:MANUAL:count-1');
    const snapshot = await readReconciliationSnapshot(db, scope.householdId);
    expect(observation.authoritativeInventoryVersion).toBe(snapshot.inventoryVersion);
    expect(observation.authoritativeInventoryVersion).toBeGreaterThanOrEqual(2);
    expect(observation.status).toBe('OPEN');
    expect(observation.version).toBe(1);
    expect(observation.claim.quantityMilli).toBe(10_000);
  });

  it('replays the same external evidence idempotently without duplicates', async () => {
    const db = database();
    await adoptEmpty(db);
    await recordInventoryObservation(db, scope, observationInput(), now);
    const retry = await recordInventoryObservation(db, scope, observationInput(), later);
    expect(retry.replayed).toBe(true);
    expect(retry.observation.observationId).toBe('t10-observation:t10-a:MANUAL:count-1');
    expect(db.query('SELECT count(*) AS n FROM inventory_observations')[0]).toMatchObject({ n: 1 });
  });

  it('rejects the same identity key with altered semantics as IDEMPOTENCY_CONFLICT', async () => {
    const db = database();
    await adoptEmpty(db);
    await recordInventoryObservation(db, scope, observationInput(), now);
    await expect(recordInventoryObservation(db, scope, observationInput({
      claim: { quantity: 8, unit: 'piece', quantityMilli: 8_000, canonicalUnit: 'piece',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }), later)).rejects.toMatchObject({ name: 'ObservationError', code: 'IDEMPOTENCY_CONFLICT' });
    expect(db.query('SELECT count(*) AS n FROM inventory_observations')[0]).toMatchObject({ n: 1 });
  });

  it('rejects unrepresentable quantities instead of rounding (exact semantics only)', async () => {
    const db = database();
    await adoptEmpty(db);
    await expect(recordInventoryObservation(db, scope, observationInput({
      claim: { quantity: 2.0000005, unit: 'kg', quantityMilli: null, canonicalUnit: null,
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }), now)).rejects.toMatchObject({ name: 'ObservationError', code: 'UNREPRESENTABLE_QUANTITY' });
    expect(db.query('SELECT count(*) AS n FROM inventory_observations')[0]).toMatchObject({ n: 0 });
  });

  it('reads observations household-scoped and bounded', async () => {
    const db = database();
    await adoptEmpty(db);
    for (const index of [1, 2, 3]) {
      await recordInventoryObservation(db, scope, observationInput({ sourceRef: `count-${index}` }), now);
    }
    await recordInventoryObservation(db, foreign, observationInput({ sourceRef: 'count-1' }), now);
    expect((await readInventoryObservations(db, scope.householdId)).length).toBe(3);
    expect((await readInventoryObservations(db, scope.householdId, { status: 'OPEN', limit: 2 })).length).toBe(2);
    await expect(readInventoryObservations(db, scope.householdId, { limit: MAX_OBSERVATION_LIST_LIMIT + 1 }))
      .rejects.toMatchObject({ code: 'INVALID_LIMIT' });
    await expect(readInventoryObservation(db, foreign.householdId, 't10-observation:t10-a:MANUAL:count-1'))
      .rejects.toMatchObject({ code: 'OBSERVATION_NOT_FOUND' });
  });

  it('fail-closed: durable evidence updates are blocked, and a guard-dropped corruption still reads CORRUPT_OBSERVATION', async () => {
    const db = database();
    await adoptEmpty(db);
    await recordInventoryObservation(db, scope, observationInput(), now);
    expect(() => db.seed("UPDATE inventory_observations SET recorded_at = 'not-a-timestamp' WHERE source_ref = 'count-1'"))
      .toThrow(/immutable/);
    db.seed('DROP TRIGGER trg_inventory_observations_immutable_update');
    db.seed("UPDATE inventory_observations SET recorded_at = 'not-a-timestamp' WHERE source_ref = 'count-1'");
    await expect(readInventoryObservation(db, scope.householdId, 't10-observation:t10-a:MANUAL:count-1'))
      .rejects.toMatchObject({ code: 'CORRUPT_OBSERVATION' });
  });

  it('fail-closed: SQL-level corruption of evidence or lifecycle is impossible', async () => {
    const db = database();
    await adoptEmpty(db);
    await recordInventoryObservation(db, scope, observationInput(), now);
    expect(() => db.seed("UPDATE inventory_observations SET claim_quantity = 'x' WHERE 1=1")).toThrow();
    expect(() => db.seed("UPDATE inventory_observations SET evidence = 'CONFIRMED' WHERE 1=1")).toThrow(/immutable/);
    expect(() => db.seed("UPDATE inventory_observations SET status = 'OPEN', version = 1 WHERE 1=1")).toThrow();
    expect(() => db.seed("DELETE FROM inventory_observations")).toThrow(/retained/);
    expect(() => db.seed(`INSERT INTO inventory_observations (id, household_id, source_type, source_ref,
      fingerprint, observed_at, recorded_at, ingredient_id, evidence, authoritative_inventory_version,
      version, created_at, updated_at, quantity, unit, quantity_milli, canonical_unit)
      VALUES ('dup', '${scope.householdId}', 'MANUAL', 'count-1', '{}', '${now}', '${now}',
      'CHICKEN_EGG', 'OBSERVED', 2, 1, '${now}', '${now}', 1, 'piece', 1000, 'piece')`)).toThrow(/already exists/);
    expect(() => db.seed(`INSERT INTO inventory_observations (id, household_id, source_type, source_ref,
      fingerprint, observed_at, recorded_at, ingredient_id, evidence, authoritative_inventory_version,
      version, created_at, updated_at, quantity, unit, quantity_milli, canonical_unit)
      VALUES ('bad-unit', '${scope.householdId}', 'MANUAL', 'unit-x', '{}', '${now}', '${now}',
      'CHICKEN_EGG', 'OBSERVED', 2, 1, '${now}', '${now}', 1, 'bushel', 1000, 'piece')`)).toThrow();
  });

  it('fail-closed: an observation cannot reference a foreign-household lot or projection', async () => {
    const db = database();
    await adoptEmpty(db);
    await adoptEmpty(db, foreign);
    await createLot(db, 'foreign-eggs', 10, {}, foreign);
    await expect(recordInventoryObservation(db, scope, observationInput({ lotId: 'foreign-eggs' }), now))
      .rejects.toThrow(/household mismatch/);
    await expect(recordInventoryObservation(db, scope, observationInput({ legacyItemId: 'foreign-item' }), now))
      .rejects.toThrow();
    expect(db.query("SELECT count(*) AS n FROM inventory_observations WHERE household_id = 't10-a'")[0])
      .toMatchObject({ n: 0 });
  });
});

describe('reconciliation planning through the db layer (T10D)', () => {
  it('classifies MATCH, PROPOSE_CORRECTION and PROPOSE_MOVE from live snapshots', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const record = async (input: InventoryObservationInput) =>
      (await recordInventoryObservation(db, scope, input, now)).observation;
    const [match] = await planInventoryReconciliationForHousehold(db, scope.householdId,
      [await record(observationInput({ sourceRef: 'm1' }))]);
    expect(match.verdict).toBe('MATCH');
    const [correction] = await planInventoryReconciliationForHousehold(db, scope.householdId,
      [await record(observationInput({ sourceRef: 'm2',
        claim: { quantity: 8, unit: 'piece', quantityMilli: 8_000, canonicalUnit: 'piece',
          storage: null, expiryDate: null, expiryKind: null, openedAt: null } }))]);
    expect(correction.verdict).toBe('PROPOSE_CORRECTION');
    const [move] = await planInventoryReconciliationForHousehold(db, scope.householdId,
      [await record(observationInput({ sourceRef: 'm3',
        claim: { quantity: null, unit: null, quantityMilli: null, canonicalUnit: null,
          storage: 'freezer', expiryDate: null, expiryKind: null, openedAt: null } }))]);
    expect(move.verdict).toBe('PROPOSE_MOVE');
    expect(move.proposals[0]).toMatchObject({ type: 'MOVE', lotId: 'eggs', expectedVersion: 1 });
  });
});

describe('reconciliation decision authority (T10E)', () => {
  it('confirms a CORRECT proposal through the T09 lot authority in one atomic batch', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { observation } = await recordInventoryObservation(db, scope, observationInput({
      sourceRef: 'count-8',
      claim: { quantity: 8, unit: 'piece', quantityMilli: 8_000, canonicalUnit: 'piece',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }), now);
    const confirmation = await confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-1', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT',
      proposals: [{ type: 'CORRECT', lotId: 'eggs', expectedVersion: 1,
        changes: { quantity: 8, unit: 'piece' } }],
    }, later);
    expect(confirmation.replayed).toBe(false);
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 8_000, version: 2 });
    expect(db.query("SELECT status, version FROM inventory_observations WHERE source_ref = 'count-8'")[0])
      .toMatchObject({ status: 'RECONCILED', version: 2 });
    const [decision] = await readReconciliationDecisions(db, scope.householdId);
    expect(decision).toMatchObject({ decision_key: 'dec-1', decision_type: 'CORRECT', command_id: confirmation.executions[0].commandId });
    // The applied stock change went through the T09 receipt/event ledger.
    expect(db.query("SELECT count(*) AS n FROM inventory_events")[0].n).toBeGreaterThan(0);
    const command = db.query("SELECT command_type, household_id, actor_id FROM inventory_commands WHERE client_key = 'dec-1#CORRECT'")[0];
    expect(command).toMatchObject({ command_type: 'CORRECT', household_id: scope.householdId, actor_id: scope.actorId });
  });

  it('confirms a MOVE proposal through the T09 lot authority', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { observation } = await recordInventoryObservation(db, scope, observationInput({
      sourceRef: 'moved',
      claim: { quantity: null, unit: null, quantityMilli: null, canonicalUnit: null,
        storage: 'freezer', expiryDate: null, expiryKind: null, openedAt: null },
    }), now);
    await confirmReconciliationDecision(db, scope, {
      decisionKey: 'move-1', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'MOVE',
      proposals: [{ type: 'MOVE', lotId: 'eggs', expectedVersion: 1,
        storageLocationId: (db.query("SELECT id FROM storage_locations WHERE type = 'FREEZER' AND household_id = 't10-a'")[0] as { id: string }).id }],
    }, later);
    expect(db.query("SELECT storage_location_id FROM inventory_lots WHERE id = 'eggs'")[0].storage_location_id)
      .toBe((db.query("SELECT id FROM storage_locations WHERE type = 'FREEZER' AND household_id = 't10-a'")[0] as { id: string }).id);
  });

  it('recovers response loss: an exact retry replays the committed decision with no duplicate mutation', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { observation } = await recordInventoryObservation(db, scope, observationInput({
      sourceRef: 'lost',
      claim: { quantity: 6, unit: 'piece', quantityMilli: 6_000, canonicalUnit: 'piece',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }), now);
    const input: ReconciliationDecisionInput = {
      decisionKey: 'dec-lost', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT',
      proposals: [{ type: 'CORRECT', lotId: 'eggs', expectedVersion: 1,
        changes: { quantity: 6, unit: 'piece' } }],
    };
    await confirmReconciliationDecision(db, scope, input, later);
    const afterFirst = facts(db);
    const retry = await confirmReconciliationDecision(db, scope, input, '2026-09-11T12:00:00Z');
    expect(retry.replayed).toBe(true);
    expect(facts(db)).toEqual(afterFirst);
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 6_000, version: 2 });
    expect(db.query("SELECT count(*) AS n FROM inventory_reconciliation_decisions")[0]).toMatchObject({ n: 1 });
  });

  it('rejects an altered semantic decision under the same idempotency key', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { observation } = await recordInventoryObservation(db, scope, observationInput({
      sourceRef: 'altered',
      claim: { quantity: 6, unit: 'piece', quantityMilli: 6_000, canonicalUnit: 'piece',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }), now);
    await confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-alt', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT',
      proposals: [{ type: 'CORRECT', lotId: 'eggs', expectedVersion: 1,
        changes: { quantity: 6, unit: 'piece' } }],
    }, later);
    await expect(confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-alt', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT',
      proposals: [{ type: 'CORRECT', lotId: 'eggs', expectedVersion: 1,
        changes: { quantity: 7, unit: 'piece' } }],
    }, later)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 6_000, version: 2 });
  });

  it('fails closed with OBSERVATION_STALE when stock changed after the observation', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { observation } = await recordInventoryObservation(db, scope, observationInput({
      sourceRef: 'stale',
      claim: { quantity: 8, unit: 'piece', quantityMilli: 8_000, canonicalUnit: 'piece',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }), now);
    // A legitimate T09 command changes stock after the observation exists.
    await executeInventoryLotCommand(db, scope, 'later-cook', {
      type: 'USE', lotId: 'eggs', expectedVersion: 1, quantity: 3, unit: 'piece', reason: 'Cooked',
    }, later);
    const before = facts(db);
    await expect(confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-stale', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT',
      proposals: [{ type: 'CORRECT', lotId: 'eggs', expectedVersion: 1,
        changes: { quantity: 8, unit: 'piece' } }],
    }, later)).rejects.toMatchObject({ code: 'OBSERVATION_STALE' });
    expect(facts(db)).toEqual(before);
  });

  it('rolls back completely when the batch fails after composition (no partial state, no duplicate events)', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { observation } = await recordInventoryObservation(db, scope, observationInput({
      sourceRef: 'rollback',
      claim: { quantity: 8, unit: 'piece', quantityMilli: 8_000, canonicalUnit: 'piece',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }), now);
    const before = facts(db);
    db.hooks.beforeBatch = (statements) => {
      if (!statements.some(({ sql }) => sql.includes('INSERT INTO inventory_reconciliation_decisions'))) return;
      throw new Error('simulated D1 failure');
    };
    await expect(confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-fail', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT',
      proposals: [{ type: 'CORRECT', lotId: 'eggs', expectedVersion: 1,
        changes: { quantity: 8, unit: 'piece' } }],
    }, later)).rejects.toThrow('simulated D1 failure');
    db.hooks = {};
    expect(facts(db)).toEqual(before);
    // A clean retry still works after the failed batch.
    await confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-fail', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT',
      proposals: [{ type: 'CORRECT', lotId: 'eggs', expectedVersion: 1,
        changes: { quantity: 8, unit: 'piece' } }],
    }, later);
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 8_000, version: 2 });
  });

  it('fails closed on T09 CAS abort when a contender wins the lot first', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { observation } = await recordInventoryObservation(db, scope, observationInput({
      sourceRef: 'cas',
      claim: { quantity: 8, unit: 'piece', quantityMilli: 8_000, canonicalUnit: 'piece',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }), now);
    const before = facts(db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    db.hooks.beforeBatch = async () => {
      db.hooks = {};
      // Winner commits a legitimate T09 CORRECT while the decision batch is paused.
      await executeInventoryLotCommand(db, scope, 'winner-correct', {
        type: 'CORRECT', lotId: 'eggs', expectedVersion: 1, changes: { quantity: 9 }, reason: 'Recount',
      }, later);
      release();
    };
    await expect(confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-cas', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT',
      proposals: [{ type: 'CORRECT', lotId: 'eggs', expectedVersion: 1,
        changes: { quantity: 8, unit: 'piece' } }],
    }, later)).rejects.toThrow();
    await gate;
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 9_000, version: 2 });
    // Nothing from the failed reconciliation batch survived.
    expect(db.query("SELECT count(*) AS n FROM inventory_reconciliation_decisions")[0]).toMatchObject({ n: 0 });
    expect(db.query("SELECT status, version FROM inventory_observations WHERE source_ref = 'cas'")[0])
      .toMatchObject({ status: 'OPEN', version: 1 });
    void before;
  });

  it('dismisses an observation without any stock mutation', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { observation } = await recordInventoryObservation(db, scope, observationInput({
      sourceRef: 'dismiss',
    }), now);
    const before = facts(db);
    await confirmReconciliationDecision(db, scope, {
      decisionKey: 'dismiss-1', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'DISMISS',
    }, later);
    const after = facts(db);
    expect(after.inventory_lots).toEqual(before.inventory_lots);
    expect(after.inventory_commands).toEqual(before.inventory_commands);
    expect(db.query("SELECT status FROM inventory_observations WHERE source_ref = 'dismiss'")[0])
      .toMatchObject({ status: 'RECONCILED' });
  });

  it('enforces tenancy: a foreign actor cannot confirm, and cannot mutate a foreign lot', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { observation } = await recordInventoryObservation(db, scope, observationInput({
      sourceRef: 'tenancy',
      claim: { quantity: 8, unit: 'piece', quantityMilli: 8_000, canonicalUnit: 'piece',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }), now);
    // A foreign household member cannot even observe the existence of the row.
    await expect(confirmReconciliationDecision(db, foreign, {
      decisionKey: 'dec-foreign', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT',
      proposals: [{ type: 'CORRECT', lotId: 'eggs', expectedVersion: 1,
        changes: { quantity: 8, unit: 'piece' } }],
    }, later)).rejects.toMatchObject({ code: 'OBSERVATION_NOT_FOUND' });
    // A foreign-observation decision with tampered proposals referencing the
    // foreign lot fails closed on the T09 authority.
    await adoptEmpty(db, foreign);
    const { observation: foreignObservation } = await recordInventoryObservation(db, foreign,
      observationInput({ sourceRef: 'foreign-own' }), now);
    await expect(confirmReconciliationDecision(db, foreign, {
      decisionKey: 'dec-foreign-lot', observationId: foreignObservation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT',
      proposals: [{ type: 'CORRECT', lotId: 'eggs', expectedVersion: 1,
        changes: { quantity: 1, unit: 'piece' } }],
    }, later)).rejects.toMatchObject({ name: 'ObservationError', code: 'OBSERVATION_NOT_ACTIONABLE' });
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 10_000, version: 1 });
    expect(db.query("SELECT count(*) AS n FROM inventory_reconciliation_decisions")[0]).toMatchObject({ n: 0 });
  });

  it('works against backfilled synthetic lots through adopted mappings', async () => {
    const db = database();
    db.seed(`INSERT INTO inventory_items (id, household_id, ingredient_id, name, quantity, unit, storage,
      expiry_date, opened_at, expiry_kind, expiry_source, version, created_at, updated_at)
      VALUES ('legacy-item-1', 't10-a', 'CHICKEN_EGG', 'Backfill eggs', 4, 'piece', 'fridge',
      NULL, NULL, 'unknown', 'unknown', 1, '2026-09-10T09:00:00Z', '2026-09-10T09:00:00Z')`);
    const backfill = await backfillLegacyInventory(db, scope.householdId);
    expect(backfill.insertedLotCount).toBe(1);
    expect(backfill.parity.ok).toBe(true);
    await adoptEmpty(db);
    const syntheticLotId = db.query("SELECT id FROM inventory_lots WHERE source_type = 'LEGACY_BACKFILL'")[0].id as string;
    const mapped = db.query("SELECT legacy_item_id FROM inventory_lots WHERE id = ?", syntheticLotId)[0];
    expect(mapped.legacy_item_id).toBe('legacy-item-1');
    const { observation } = await recordInventoryObservation(db, scope, observationInput({
      sourceRef: 'synthetic', legacyItemId: 'legacy-item-1', ingredientId: null,
      claim: { quantity: 3, unit: 'piece', quantityMilli: 3_000, canonicalUnit: 'piece',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }), now);
    const [finding] = await planInventoryReconciliationForHousehold(db, scope.householdId, [observation]);
    expect(finding.verdict).toBe('PROPOSE_CORRECTION');
    expect(finding.matchedLotId).toBe(syntheticLotId);
    await confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-synthetic', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT',
      proposals: finding.proposals,
    }, later);
    // Backfill set version 1, adoption bumped it to 2, the reconciliation CORRECT made 3.
    expect(lotState(db, syntheticLotId)).toMatchObject({ quantity_milli: 3_000, version: 3 });
  });

  it('works against native equal-ID lots', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'equal-id', 10);
    const { observation } = await recordInventoryObservation(db, scope, observationInput({
      sourceRef: 'native', lotId: 'equal-id', ingredientId: null,
      claim: { quantity: 10, unit: 'piece', quantityMilli: 10_000, canonicalUnit: 'piece',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    }), now);
    const [finding] = await planInventoryReconciliationForHousehold(db, scope.householdId, [observation]);
    expect(finding.verdict).toBe('MATCH');
    await confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-native', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'DISMISS',
    }, later);
    expect(lotState(db, 'equal-id')).toMatchObject({ quantity_milli: 10_000, version: 1 });
  });

  it('fails closed: missing observation, invalid decision shapes and wrong observation version', async () => {
    const db = database();
    await adoptEmpty(db);
    await expect(confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-missing', observationId: 'nope',
      expectedObservationVersion: 1, decisionType: 'DISMISS',
    }, later)).rejects.toMatchObject({ code: 'OBSERVATION_NOT_FOUND' });
    await createLot(db, 'eggs', 10);
    const { observation } = await recordInventoryObservation(db, scope, observationInput({ sourceRef: 'v' }), now);
    await expect(confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-version', observationId: observation.observationId,
      expectedObservationVersion: 5, decisionType: 'DISMISS',
    }, later)).rejects.toMatchObject({ code: 'OBSERVATION_VERSION_CONFLICT' });
    await expect(confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-shape', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'DISMISS',
      proposals: [{ type: 'MOVE', lotId: 'eggs', expectedVersion: 1, storageLocationId: 'loc' }],
    }, later)).rejects.toMatchObject({ name: 'ObservationError', code: 'INVALID_DECISION' });
    await expect(confirmReconciliationDecision(db, scope, {
      decisionKey: 'dec-match', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT',
      proposals: [{ type: 'CORRECT', lotId: 'eggs', expectedVersion: 1,
        changes: { quantity: 10, unit: 'piece' } }],
    }, later)).rejects.toMatchObject({ code: 'OBSERVATION_NOT_ACTIONABLE' });
  });

  it('keeps the snapshot reader bounded and household-scoped', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const snapshot = await readReconciliationSnapshot(db, scope.householdId);
    expect(snapshot.lots).toHaveLength(1);
    expect(snapshot.lots[0].lot.id).toBe('eggs');
    await adoptEmpty(db, foreign);
    await createLot(db, 'foreign', 4, {}, foreign);
    const again = await readReconciliationSnapshot(db, scope.householdId);
    expect(again.lots).toHaveLength(1);
  });
});
