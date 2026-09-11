import { afterEach, describe, expect, it } from 'vitest';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import {
  executeInventoryFefoCommand, executeInventoryLotCommand, readMappedLotSnapshot,
} from '../../packages/db/src/inventory-lot-commands';
import { SqliteD1, type SqliteStatementEvent } from '../helpers/sqlite-d1';

const scope = { householdId: 'bf-fefo-home', actorId: 'bf-fefo-owner' };
const foreign = { householdId: 'bf-fefo-foreign', actorId: 'bf-fefo-foreign-owner' };
const now = '2026-09-11T13:00:00Z';
const databases: SqliteD1[] = [];

function database(): SqliteD1 {
  const db = new SqliteD1();
  databases.push(db);
  db.seed(`INSERT INTO users(id) VALUES ('bf-fefo-owner'), ('bf-fefo-foreign-owner');
    INSERT INTO households(id, name, created_by) VALUES
      ('bf-fefo-home', 'Backfill FEFO', 'bf-fefo-owner'), ('bf-fefo-foreign', 'Foreign', 'bf-fefo-foreign-owner');
    INSERT INTO household_members(id, household_id, user_id, role) VALUES
      ('bf-fefo-owner-member', 'bf-fefo-home', 'bf-fefo-owner', 'owner'),
      ('bf-fefo-foreign-member', 'bf-fefo-foreign', 'bf-fefo-foreign-owner', 'owner');`);
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

type Row = { id: string; quantity: number; unit?: string; expiry?: string; household?: string };

function seedItems(db: SqliteD1, rows: Row[], household = scope.householdId): void {
  db.seed(`INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit, category, storage,
    expiry_date, expiry_kind, expiry_source)
    VALUES ${rows.map(({ id, quantity, unit = 'g', expiry = null, household: rowHousehold = household }) =>
    `('${id}', '${rowHousehold}', 'RICE', 'Rice ${id}', ${quantity}, '${unit}', 'grain', 'pantry', ${expiry === null ? 'NULL' : `'${expiry}'`}, ${expiry === null ? "'unknown', 'unknown'" : "'use_by', 'user'"})`).join(', ')}`);
}

async function adopt(db: SqliteD1, owner = scope) {
  const execution = await executeInventoryAdoption(db, owner, {}, now);
  expect(execution.replayed).toBe(false);
  return execution;
}

const fefo = (quantity: number, patch: Record<string, unknown> = {}) =>
  ({ type: 'USE', mode: 'FEFO', ingredientId: 'RICE', quantity, unit: 'g', ...patch });
const run = (db: SqliteD1, key: string, input: unknown, owner = scope) =>
  executeInventoryFefoCommand(db, owner, key, input, now);
const inventoryVersion = async (db: SqliteD1, owner = scope) =>
  (await readMappedLotSnapshot(db, owner, 'RICE')).inventoryVersion;

function facts(db: SqliteD1): string {
  return JSON.stringify(['households', 'inventory_items', 'inventory_lots', 'storage_locations',
    'inventory_commands', 'inventory_events', 'inventory_adoption_receipts']
    .map((table) => db.query(`SELECT * FROM ${table} ORDER BY id`)));
}

const lotRow = (db: SqliteD1, id: string) =>
  db.query(`SELECT * FROM inventory_lots WHERE id = ?`, id)[0] as Record<string, unknown>;
const projectionRow = (db: SqliteD1, id: string) =>
  db.query(`SELECT * FROM inventory_items WHERE id = ?`, id)[0] as Record<string, unknown>;
const count = (db: SqliteD1, sql: string) => (db.query<{ n: number }>(sql)[0]).n;
const eventsFor = (db: SqliteD1, commandId: string) =>
  db.query<{ inventory_item_id: string; event_type: string; quantity_delta: number; unit: string }>(
    `SELECT inventory_item_id, event_type, quantity_delta, unit FROM inventory_events
      WHERE command_id = ? ORDER BY json_extract(metadata, '$.ordinal')`, commandId);

function expectNoMutation(db: SqliteD1, before: string): void {
  expect(facts(db)).toBe(before);
  expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
}

// Pauses the contender immediately before its atomic batch, runs the winner,
// then releases the contender against committed state.
function pauseAtWriteBarrier(db: SqliteD1, runWinner: () => Promise<unknown>,
  marker = 'INSERT INTO inventory_commands') {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let armed = true;
  db.hooks.beforeBatch = async (statements: readonly SqliteStatementEvent[]) => {
    if (!armed || !statements.some(({ sql }) => sql.includes(marker))) return;
    armed = false;
    db.hooks = {};
    await runWinner();
    release();
  };
  return { gate, release };
}

describe('T09 final FEFO v2 backfill compatibility', () => {
  it('allocates a single adopted backfilled lot and updates projection and lot coherently', async () => {
    const db = database();
    seedItems(db, [{ id: 'rice-a', quantity: 2, expiry: '2026-09-15' }]);
    await adopt(db);

    const execution = await run(db, 'single', fefo(0.5, { reason: 'Dinner' }));
    expect(execution.replayed).toBe(false);
    expect(execution.result).toMatchObject({ schemaVersion: 2, commandType: 'USE', mode: 'FEFO',
      ingredientId: 'RICE', quantityMilli: 500, canonicalUnit: 'g' });
    expect(execution.result.effects).toHaveLength(1);
    const effect = execution.result.effects[0];
    expect(effect).toMatchObject({ ordinal: 0, legacyItemId: 'rice-a', deltaMilli: -500,
      before: { id: 't08-legacy:rice-a', quantityMilli: 2000, version: 2, legacyVersion: 1 },
      after: { id: 't08-legacy:rice-a', quantityMilli: 1500, version: 3, legacyVersion: 2, state: 'ACTIVE' } });

    expect(lotRow(db, 't08-legacy:rice-a')).toMatchObject({ legacy_item_id: 'rice-a',
      quantity_milli: 1500, version: 3, legacy_version: 2, source_type: 'LEGACY_BACKFILL', source_id: 'rice-a' });
    expect(projectionRow(db, 'rice-a')).toMatchObject({ quantity: 1.5, unit: 'g', version: 2 });
    // Event authority references the legacy projection identity, not the native lot ID.
    expect(eventsFor(db, execution.result.commandId)).toEqual([
      { inventory_item_id: 'rice-a', event_type: 'MANUAL_UPDATE', quantity_delta: -0.5, unit: 'g' },
    ]);
    const receipt = db.query('SELECT result_json FROM inventory_commands WHERE id = ?', execution.result.commandId)[0];
    expect(JSON.parse(String(receipt.result_json)).effects[0].legacyItemId).toBe('rice-a');
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('allocates multiple adopted backfilled lots in deterministic FEFO order with per-effect mapping', async () => {
    const db = database();
    seedItems(db, [
      { id: 'rice-early', quantity: 1, expiry: '2026-09-15' },
      { id: 'rice-late', quantity: 1, expiry: '2026-09-20' },
      { id: 'rice-unknown', quantity: 0.5 },
    ]);
    await adopt(db);

    const execution = await run(db, 'multi', fefo(2.25));
    expect(execution.result.effects.map(({ ordinal, legacyItemId, before, after, deltaMilli }) =>
      ({ ordinal, legacyItemId, lot: before.id, remaining: after.quantityMilli, deltaMilli }))).toEqual([
      { ordinal: 0, legacyItemId: 'rice-early', lot: 't08-legacy:rice-early', remaining: 0, deltaMilli: -1000 },
      { ordinal: 1, legacyItemId: 'rice-late', lot: 't08-legacy:rice-late', remaining: 0, deltaMilli: -1000 },
      { ordinal: 2, legacyItemId: 'rice-unknown', lot: 't08-legacy:rice-unknown', remaining: 250, deltaMilli: -250 },
    ]);
    for (const { legacyItemId, lot, remaining } of [
      { legacyItemId: 'rice-early', lot: 't08-legacy:rice-early', remaining: 0 },
      { legacyItemId: 'rice-late', lot: 't08-legacy:rice-late', remaining: 0 },
      { legacyItemId: 'rice-unknown', lot: 't08-legacy:rice-unknown', remaining: 250 },
    ]) {
      expect(lotRow(db, lot)).toMatchObject({ legacy_item_id: legacyItemId, quantity_milli: remaining });
      expect(projectionRow(db, legacyItemId)).toMatchObject({ quantity: remaining / 1000 });
    }
    expect(eventsFor(db, execution.result.commandId).map(({ inventory_item_id }) => inventory_item_id))
      .toEqual(['rice-early', 'rice-late', 'rice-unknown']);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('mixes native equal-ID and synthetic adopted lots, including a legacy kg display row', async () => {
    const db = database();
    seedItems(db, [
      { id: 'rice-early', quantity: 1, expiry: '2026-09-15' },
      { id: 'rice-kg', quantity: 2, unit: 'kg', expiry: '2026-09-16' },
    ]);
    await adopt(db);
    const pantry = db.query<{ id: string }>(
      "SELECT id FROM storage_locations WHERE household_id = ? AND type = 'PANTRY' AND is_default = 1", scope.householdId)[0].id;
    await executeInventoryLotCommand(db, scope, 'create-native', {
      type: 'CREATE', lotId: 'native-rice', ingredientId: 'RICE', rawName: 'Native rice', quantity: 1,
      unit: 'g', storageLocationId: pantry, sourceType: 'MANUAL',
      expiryKind: 'USE_BY', expiryAt: '2026-09-18',
    }, now);

    // FEFO order follows expiry evidence only; the request is satisfied by the
    // two earliest lots and the native lot keeps its stock untouched.
    const execution = await run(db, 'mixed', fefo(3.5));
    expect(execution.result.effects.map(({ legacyItemId, before, deltaMilli }) =>
      ({ legacyItemId, lot: before.id, deltaMilli }))).toEqual([
      { legacyItemId: 'rice-early', lot: 't08-legacy:rice-early', deltaMilli: -1000 },
      { legacyItemId: 'rice-kg', lot: 't08-legacy:rice-kg', deltaMilli: -2500 },
    ]);
    expect(lotRow(db, 't08-legacy:rice-kg')).toMatchObject({ quantity_milli: 1997500, canonical_unit: 'g' });
    // The first native write canonicalizes the legacy kg display projection.
    expect(projectionRow(db, 'rice-kg')).toMatchObject({ quantity: 1997.5, unit: 'g' });
    expect(lotRow(db, 'native-rice')).toMatchObject({ quantity_milli: 1000, legacy_item_id: 'native-rice' });
    expect(projectionRow(db, 'native-rice')).toMatchObject({ quantity: 1, unit: 'g' });
    expect(eventsFor(db, execution.result.commandId).map(({ inventory_item_id }) => inventory_item_id))
      .toEqual(['rice-early', 'rice-kg']);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('depletes a backfilled lot terminally and partially with coherent versions', async () => {
    const db = database();
    seedItems(db, [
      { id: 'rice-terminal', quantity: 0.8, expiry: '2026-09-15' },
      { id: 'rice-partial', quantity: 2, expiry: '2026-09-20' },
    ]);
    await adopt(db);

    const execution = await run(db, 'deplete', fefo(1));
    expect(execution.result.effects.map(({ legacyItemId, after }) =>
      ({ legacyItemId, quantity: after.quantityMilli, state: after.state }))).toEqual([
      { legacyItemId: 'rice-terminal', quantity: 0, state: 'CONSUMED' },
      { legacyItemId: 'rice-partial', quantity: 1800, state: 'ACTIVE' },
    ]);
    expect(lotRow(db, 't08-legacy:rice-terminal')).toMatchObject({ state: 'CONSUMED', quantity_milli: 0, version: 3 });
    expect(projectionRow(db, 'rice-terminal')).toMatchObject({ quantity: 0, freshness: 'out_of_stock', version: 2 });
    expect(projectionRow(db, 'rice-partial')).toMatchObject({ quantity: 1.8, freshness: 'fresh', version: 2 });
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('preserves the adoption version offset across FEFO, manual PATCH, MOVE and later writes', async () => {
    const db = database();
    seedItems(db, [{ id: 'rice-v', quantity: 2, expiry: '2026-09-15' }]);
    await adopt(db);
    const freezer = db.query<{ id: string }>(
      "SELECT id FROM storage_locations WHERE household_id = ? AND type = 'FREEZER' AND is_default = 1", scope.householdId)[0].id;

    // First FEFO after adoption: lot 2->3, projection 1->2, offset preserved.
    const first = await run(db, 'version-1', fefo(0.5));
    expect(first.result.effects[0].after).toMatchObject({ version: 3, legacyVersion: 2 });
    // Manual PATCH (CORRECT) advances both identities in lockstep.
    await executeInventoryLotCommand(db, scope, 'version-correct', {
      type: 'CORRECT', lotId: 't08-legacy:rice-v', expectedVersion: 3, changes: { quantity: 1 }, reason: 'Recount',
    }, now);
    expect(lotRow(db, 't08-legacy:rice-v')).toMatchObject({ version: 4, legacy_version: 3, quantity_milli: 1000 });
    // MOVE keeps the mapping and offset; a later FEFO still binds both identities.
    await executeInventoryLotCommand(db, scope, 'version-move', {
      type: 'MOVE', lotId: 't08-legacy:rice-v', expectedVersion: 4, storageLocationId: freezer,
    }, now);
    const second = await run(db, 'version-2', fefo(0.25));
    expect(second.result.effects[0]).toMatchObject({ legacyItemId: 'rice-v',
      before: { version: 5, legacyVersion: 4 }, after: { version: 6, legacyVersion: 5, quantityMilli: 750 } });
    expect(projectionRow(db, 'rice-v')).toMatchObject({ quantity: 0.75, version: 5, storage: 'freezer' });

    // Receipt-backed replay of the first FEFO still returns its exact result after later writes.
    const replayed = await run(db, 'version-1', fefo(0.5));
    expect(replayed).toEqual({ result: first.result, replayed: true });
    expect(count(db, 'SELECT COUNT(*) AS n FROM inventory_commands')).toBe(4);
  });

  it('replays the exact receipt for the same key and request without duplicate evidence', async () => {
    const db = database();
    seedItems(db, [{ id: 'rice-replay', quantity: 2, expiry: '2026-09-15' }]);
    await adopt(db);

    const first = await run(db, 'replay-key', fefo(0.5, { reason: 'Dinner' }));
    const committed = facts(db);
    const replayed = await run(db, 'replay-key', fefo(0.5, { reason: 'Dinner' }));
    expect(replayed).toEqual({ result: first.result, replayed: true });
    expect(facts(db)).toEqual(committed);
  });

  it('rejects a changed intent or changed expected version under the same key', async () => {
    const db = database();
    seedItems(db, [{ id: 'rice-conflict', quantity: 2, expiry: '2026-09-15' }]);
    await adopt(db);
    const version = await inventoryVersion(db);
    await run(db, 'conflict-key', fefo(0.5, { expectedInventoryVersion: version }));

    const before = facts(db);
    await expect(run(db, 'conflict-key', fefo(0.4))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(run(db, 'conflict-key', fefo(0.5, { expectedInventoryVersion: version + 1 })))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expectNoMutation(db, before);
  });

  it('rejects a stale snapshot under a distinct key', async () => {
    const db = database();
    seedItems(db, [{ id: 'rice-stale', quantity: 2, expiry: '2026-09-15' }]);
    await adopt(db);
    const version = await inventoryVersion(db);
    await run(db, 'stale-first', fefo(0.5, { expectedInventoryVersion: version }));

    const before = facts(db);
    await expect(run(db, 'stale-second', fefo(0.5, { expectedInventoryVersion: version + 1 })))
      .rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expectNoMutation(db, before);
  });

  it('recovers a lost response after commit via receipt-backed replay', async () => {
    const db = database();
    seedItems(db, [{ id: 'rice-lost', quantity: 2, expiry: '2026-09-15' }]);
    await adopt(db);

    let armed = false;
    db.hooks.beforeBatch = async (statements) => {
      if (statements.some(({ sql }) => sql.includes('INSERT INTO inventory_commands'))) armed = true;
    };
    db.hooks.afterBatch = async () => {
      if (!armed) return;
      armed = false;
      db.hooks = {};
      throw new Error('Simulated response loss after commit');
    };
    const recovered = await run(db, 'lost-key', fefo(0.5));
    db.hooks = {};
    expect(recovered.replayed).toBe(true);
    expect(recovered.result.effects[0].after).toMatchObject({ quantityMilli: 1500, version: 3 });
    expect(lotRow(db, 't08-legacy:rice-lost')).toMatchObject({ quantity_milli: 1500, version: 3 });

    // A retry after the recovered response replays the same committed receipt once.
    const replayed = await run(db, 'lost-key', fefo(0.5));
    expect(replayed).toEqual(recovered);
    expect(count(db, `SELECT COUNT(*) AS n FROM inventory_commands WHERE household_id = '${scope.householdId}'`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS n FROM inventory_events WHERE household_id = '${scope.householdId}'`)).toBe(1);
    expect(eventsFor(db, recovered.result.commandId)).toHaveLength(1);
  });

  it('denies foreign actors and never allocates foreign household stock', async () => {
    const db = database();
    seedItems(db, [{ id: 'own-rice', quantity: 2, expiry: '2026-09-15' }]);
    seedItems(db, [{ id: 'foreign-rice', quantity: 5, expiry: '2026-09-14' }], foreign.householdId);
    await adopt(db);
    await adopt(db, foreign);

    const before = facts(db);
    await expect(run(db, 'foreign-actor', fefo(0.5), { householdId: scope.householdId, actorId: 'bf-fefo-stranger' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expectNoMutation(db, before);

    // Own-household FEFO orders only own stock even when foreign stock expires earlier.
    const execution = await run(db, 'own-only', fefo(0.5));
    expect(execution.result.effects.map(({ legacyItemId }) => legacyItemId)).toEqual(['own-rice']);
    expect(lotRow(db, 't08-legacy:foreign-rice')).toMatchObject({ quantity_milli: 5000, household_id: foreign.householdId });
    expect(projectionRow(db, 'foreign-rice')).toMatchObject({ quantity: 5, household_id: foreign.householdId });
  });

  it('fails closed on drift: wrong stock, tampered evidence, broken mapping offset, lost admission', async () => {
    const db = database();
    seedItems(db, [{ id: 'rice-drift', quantity: 2, expiry: '2026-09-15' }]);
    await adopt(db);

    const before = facts(db);
    await expect(run(db, 'drift-ingredient', { type: 'USE', mode: 'FEFO', ingredientId: 'CHICKEN_EGG',
      quantity: 1, unit: 'piece' })).rejects.toMatchObject({ code: 'INSUFFICIENT_INVENTORY' });
    await expect(run(db, 'drift-unit', { type: 'USE', mode: 'FEFO', ingredientId: 'RICE',
      quantity: 1, unit: 'piece' })).rejects.toMatchObject({ code: 'INSUFFICIENT_INVENTORY' });
    expectNoMutation(db, before);

    // Tampered adoption evidence is corrupt, never silently repaired.
    db.seed('DROP TRIGGER trg_inventory_adoption_receipts_immutable_update;');
    const receipt = db.query('SELECT result_json FROM inventory_adoption_receipts WHERE household_id = ?', scope.householdId)[0];
    const result = JSON.parse(String(receipt.result_json));
    result.effects[0].legacyItemId = 'foreign-rice';
    await db.prepare('UPDATE inventory_adoption_receipts SET result_json = ? WHERE household_id = ?')
      .bind(JSON.stringify(result), scope.householdId).run();
    await expect(run(db, 'drift-evidence', fefo(0.5))).rejects.toMatchObject({ code: 'CORRUPT_RECEIPT' });
    expect(lotRow(db, 't08-legacy:rice-drift')).toMatchObject({ quantity_milli: 2000, version: 2 });
    result.effects[0].legacyItemId = 'rice-drift';
    await db.prepare('UPDATE inventory_adoption_receipts SET result_json = ? WHERE household_id = ?')
      .bind(JSON.stringify(result), scope.householdId).run();

    // A lot version bump without its projection breaks the authoritative offset.
    db.seed('DROP TRIGGER trg_inventory_lots_live_update;');
    db.seed(`UPDATE inventory_lots SET version = version + 1 WHERE id = 't08-legacy:rice-drift'`);
    await expect(run(db, 'drift-offset', fefo(0.5))).rejects.toMatchObject({ code: 'DRIFT_DETECTED' });
    expect(lotRow(db, 't08-legacy:rice-drift')).toMatchObject({ quantity_milli: 2000 });

    // Deleting the adoption receipt removes admission evidence entirely.
    db.seed('DROP TRIGGER trg_inventory_adoption_receipts_immutable_delete;');
    db.seed(`DELETE FROM inventory_adoption_receipts WHERE household_id = '${scope.householdId}'`);
    await expect(run(db, 'drift-admission', fefo(0.5))).rejects.toMatchObject({ code: 'ADOPTION_REQUIRED' });
    expect(lotRow(db, 't08-legacy:rice-drift')).toMatchObject({ quantity_milli: 2000 });
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('keeps one authority outcome when backfilled FEFO races FEFO, CORRECT, DISCARD or MOVE', async () => {
    for (const kind of ['FEFO', 'CORRECT', 'DISCARD', 'MOVE'] as const) {
      const db = database();
      seedItems(db, [{ id: 'race-rice', quantity: 2, expiry: '2026-09-15' }]);
      await adopt(db);
      const lotId = 't08-legacy:race-rice';
      const freezer = db.query<{ id: string }>(
        "SELECT id FROM storage_locations WHERE household_id = ? AND type = 'FREEZER' AND is_default = 1", scope.householdId)[0].id;
      const winnerInput = kind === 'CORRECT'
        ? { type: 'CORRECT', lotId, expectedVersion: 2, changes: { quantity: 1 }, reason: 'Recount' }
        : kind === 'DISCARD'
          ? { type: 'DISCARD', lotId, expectedVersion: 2, quantity: 0.5, unit: 'g', reason: 'Spoiled' }
          : { type: 'MOVE', lotId, expectedVersion: 2, storageLocationId: freezer };
      const { gate } = pauseAtWriteBarrier(db, () => kind === 'FEFO'
        ? run(db, 'race-winner', fefo(0.5))
        : executeInventoryLotCommand(db, scope, 'race-winner', winnerInput, now));
      const contender = run(db, 'race-contender', fefo(0.5));
      await gate;
      await expect(contender).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
      expect(count(db, `SELECT COUNT(*) AS n FROM inventory_commands WHERE household_id = '${scope.householdId}'`)).toBe(1);
      expect(lotRow(db, lotId).quantity_milli)
        .toBe(kind === 'CORRECT' ? 1000 : kind === 'DISCARD' ? 1500 : kind === 'MOVE' ? 2000 : 1500);
      expect(db.query('SELECT * FROM inventory_lots WHERE quantity_milli < 0')).toEqual([]);
      expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
    }
  });

  it('resolves a multi-lot backfilled allocation race without overspend or partial effects', async () => {
    const db = database();
    seedItems(db, [
      { id: 'race-early', quantity: 1, expiry: '2026-09-15' },
      { id: 'race-late', quantity: 1, expiry: '2026-09-20' },
    ]);
    await adopt(db);

    const { gate } = pauseAtWriteBarrier(db, () => run(db, 'multi-winner', fefo(1.5)));
    const contender = run(db, 'multi-contender', fefo(1.5));
    await gate;
    await expect(contender).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(lotRow(db, 't08-legacy:race-early')).toMatchObject({ quantity_milli: 0, state: 'CONSUMED' });
    expect(lotRow(db, 't08-legacy:race-late')).toMatchObject({ quantity_milli: 500 });
    expect(count(db, `SELECT COUNT(*) AS n FROM inventory_commands WHERE household_id = '${scope.householdId}'`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS n FROM inventory_events WHERE household_id = '${scope.householdId}'`)).toBe(2);
    expect(count(db, 'SELECT COUNT(*) AS n FROM inventory_lots WHERE quantity_milli < 0')).toBe(0);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });
});
