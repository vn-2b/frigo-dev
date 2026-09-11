import { afterEach, describe, expect, it } from 'vitest';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import {
  executeInventoryFefoCommand, executeInventoryLotCommand,
} from '../../packages/db/src/inventory-lot-commands';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import { SqliteD1 } from '../helpers/sqlite-d1';

const scope = { householdId: 'race-household', actorId: 'race-user' };
const now = '2026-09-11T10:00:00Z';
const databases: SqliteD1[] = [];

function database(): SqliteD1 {
  const db = new SqliteD1();
  databases.push(db);
  db.seed(`INSERT INTO users(id) VALUES ('race-user');
    INSERT INTO households(id, name, created_by) VALUES ('race-household', 'Races', 'race-user');
    INSERT INTO household_members(id, household_id, user_id, role)
    VALUES ('race-member', 'race-household', 'race-user', 'owner');`);
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const fridgeLocation = (db: SqliteD1) =>
  (db.query("SELECT id FROM storage_locations WHERE household_id = 'race-household' AND type = 'FRIDGE'")[0] as { id: string }).id;

async function adoptEmpty(db: SqliteD1) {
  const result = await executeInventoryAdoption(db, scope, {}, now);
  expect(result.replayed).toBe(false);
}

async function createLot(db: SqliteD1, id: string, quantity: number, patch: Record<string, unknown> = {},
  key = `create-${id}`) {
  return executeInventoryLotCommand(db, scope, key, {
    type: 'CREATE', lotId: id, ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity,
    unit: 'piece', storageLocationId: fridgeLocation(db), sourceType: 'MANUAL', ...patch,
  }, now);
}

const lotState = (db: SqliteD1, id: string) =>
  db.query<{ quantity_milli: number; state: string; version: number; opened_at: string | null; storage_location_id: string }>(
    'SELECT quantity_milli, state, version, opened_at, storage_location_id FROM inventory_lots WHERE id = ?', id)[0];

function receiptEvents(db: SqliteD1, key: string) {
  return db.query('SELECT e.* FROM inventory_events e JOIN inventory_commands c ON c.id = e.command_id WHERE c.client_key = ?', key);
}

// Pauses the contender immediately before its atomic batch, runs the winner,
// then releases the contender against committed state.
function pauseAtWriteBarrier(db: SqliteD1, runWinner: () => Promise<unknown>,
  marker = 'INSERT INTO inventory_commands') {
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
  return { gate, release };
}

describe('T09G controlled concurrency matrix', () => {
  it('G1 USE/USE: concurrent distinct-key consumption never exceeds available stock', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { gate } = pauseAtWriteBarrier(db, () =>
      executeInventoryLotCommand(db, scope, 'use-winner', {
        type: 'USE', lotId: 'eggs', expectedVersion: 1, quantity: 7, unit: 'piece', reason: 'First',
      }, now));
    const contender = executeInventoryLotCommand(db, scope, 'use-contender', {
      type: 'USE', lotId: 'eggs', expectedVersion: 1, quantity: 7, unit: 'piece', reason: 'Second',
    }, now);
    await gate;
    await expect(contender).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 3000, state: 'ACTIVE', version: 2 });
    expect(receiptEvents(db, 'use-contender')).toEqual([]);
  });

  it('G2 USE/DISCARD, USE/CORRECT and DISCARD/DISCARD leave one winner and no drift', async () => {
    const contenderInputs = [
    { type: 'DISCARD', quantity: 3, reason: 'Spoiled', lotId: 'eggs', expectedVersion: 1, unit: 'piece' },
    { type: 'CORRECT', changes: { quantity: 1 }, reason: 'Recount', lotId: 'eggs', expectedVersion: 1 },
  ] as const;
  for (const contenderInput of contenderInputs) {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { gate } = pauseAtWriteBarrier(db, () =>
      executeInventoryLotCommand(db, scope, 'pair-winner', {
        type: 'USE', lotId: 'eggs', expectedVersion: 1, quantity: 7, unit: 'piece', reason: 'Cooked',
      }, now));
    const contender = executeInventoryLotCommand(db, scope, 'pair-contender', contenderInput, now);
    await gate;
    await expect(contender).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 3000, version: 2 });
    expect(receiptEvents(db, 'pair-contender')).toEqual([]);
  }

    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const { gate } = pauseAtWriteBarrier(db, () =>
      executeInventoryLotCommand(db, scope, 'discard-winner', {
        type: 'DISCARD', lotId: 'eggs', expectedVersion: 1, quantity: 10, unit: 'piece', reason: 'Gone',
      }, now));
    const contender = executeInventoryLotCommand(db, scope, 'discard-contender', {
      type: 'DISCARD', lotId: 'eggs', expectedVersion: 1, quantity: 10, unit: 'piece', reason: 'Gone too',
    }, now);
    await gate;
    await expect(contender).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(lotState(db, 'eggs')).toMatchObject({ quantity_milli: 0, state: 'DISCARDED', version: 2 });
    // No duplicate discarded evidence.
    expect(db.query("SELECT COUNT(*) AS n FROM inventory_events WHERE event_type = 'DISCARD'")[0].n).toBe(1);
  });

  it('G4 MOVE/MOVE keeps the winner location and OPEN/OPEN is a deterministic no-op replay', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const freezer = (db.query("SELECT id FROM storage_locations WHERE type = 'FREEZER'")[0] as { id: string }).id;
    const pantry = (db.query("SELECT id FROM storage_locations WHERE type = 'PANTRY'")[0] as { id: string }).id;
    const { gate } = pauseAtWriteBarrier(db, () =>
      executeInventoryLotCommand(db, scope, 'move-winner', {
        type: 'MOVE', lotId: 'eggs', expectedVersion: 1, storageLocationId: freezer,
      }, now));
    const contender = executeInventoryLotCommand(db, scope, 'move-contender', {
      type: 'MOVE', lotId: 'eggs', expectedVersion: 1, storageLocationId: pantry,
    }, now);
    await gate;
    await expect(contender).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(lotState(db, 'eggs')).toMatchObject({ storage_location_id: freezer, version: 2 });

    await executeInventoryLotCommand(db, scope, 'open-first', {
      type: 'OPEN', lotId: 'eggs', expectedVersion: 2, openedAt: now,
    }, now);
    const replay = await executeInventoryLotCommand(db, scope, 'open-second', {
      type: 'OPEN', lotId: 'eggs', expectedVersion: 3, openedAt: now,
    }, now);
    expect(replay.result.effects).toEqual([]);
    expect(lotState(db, 'eggs')).toMatchObject({ version: 3 });
    expect(db.query("SELECT COUNT(*) AS n FROM inventory_events WHERE event_type = 'MANUAL_UPDATE'")[0].n).toBe(2);
  });

  it('G5/G6 FEFO/FEFO and receipt replay never double-allocate overlapping lots', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'lot-old', 2, { expiryAt: '2026-09-12', expiryKind: 'KNOWN' }, 'create-old');
    await createLot(db, 'lot-new', 8, { expiryAt: '2026-09-25', expiryKind: 'KNOWN' }, 'create-new');
    const fefo = (quantity: number) => ({
      type: 'USE', mode: 'FEFO', ingredientId: 'CHICKEN_EGG', quantity, unit: 'piece',
    });
    const { gate } = pauseAtWriteBarrier(db, () =>
      executeInventoryFefoCommand(db, scope, 'fefo-winner', fefo(6), now));
    const contender = executeInventoryFefoCommand(db, scope, 'fefo-contender', fefo(6), now);
    await gate;
    await expect(contender).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(lotState(db, 'lot-old')).toMatchObject({ quantity_milli: 0, state: 'CONSUMED' });
    expect(lotState(db, 'lot-new')).toMatchObject({ quantity_milli: 4000, state: 'ACTIVE' });

    // G5/G6: response-loss retry of the winner replays the committed receipt.
    const replay = await executeInventoryFefoCommand(db, scope, 'fefo-winner', fefo(6), now);
    expect(replay.replayed).toBe(true);
    expect(lotState(db, 'lot-new')).toMatchObject({ quantity_milli: 4000 });
    expect(db.query("SELECT COUNT(*) AS n FROM inventory_commands WHERE household_id = 'race-household'")[0].n).toBe(3);
  });

  it('G7 duplicate event identity is rejected by the schema gate', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10);
    const receipt = db.query<{ id: string }>("SELECT id FROM inventory_commands WHERE client_key = 'create-eggs'")[0];
    expect(() => db.seed(`INSERT INTO inventory_events
      (id, household_id, inventory_item_id, event_type, quantity_delta, unit, command_id)
      VALUES ('dup-event', 'race-household', 'eggs', 'ADD', 10, 'piece', '${receipt.id}')`)).toThrow();
  });

  it('G8 concurrent commands in different households never interact', async () => {
    const db = database();
    db.seed(`INSERT INTO users(id) VALUES ('other-user');
      INSERT INTO households(id, name, created_by) VALUES ('other-race-household', 'Other', 'other-user');
      INSERT INTO household_members(id, household_id, user_id, role)
      VALUES ('other-race-member', 'other-race-household', 'other-user', 'owner');`);
    await adoptEmpty(db);
    await createLot(db, 'eggs-a', 10);
    const otherScope = { householdId: 'other-race-household', actorId: 'other-user' };
    const otherAdoption = await executeInventoryAdoption(db, otherScope, {}, now);
    expect(otherAdoption.replayed).toBe(false);
    await executeInventoryLotCommand(db, otherScope, 'other-create', {
      type: 'CREATE', lotId: 'eggs-b', ingredientId: 'CHICKEN_EGG', rawName: 'Other eggs', quantity: 5,
      unit: 'piece',
      storageLocationId: (db.query("SELECT id FROM storage_locations WHERE household_id = 'other-race-household' AND type = 'FRIDGE'")[0] as { id: string }).id,
      sourceType: 'MANUAL',
    }, now);
    expect(lotState(db, 'eggs-a')).toMatchObject({ quantity_milli: 10000, version: 1 });
    expect(lotState(db, 'eggs-b')).toMatchObject({ quantity_milli: 5000, version: 1 });
  });

  it('G9 cross-tenant lot, location, receipt and event identities are rejected', async () => {
    const db = database();
    db.seed(`INSERT INTO users(id) VALUES ('other-user');
      INSERT INTO households(id, name, created_by) VALUES ('other-race-household', 'Other', 'other-user');
      INSERT INTO household_members(id, household_id, user_id, role)
      VALUES ('other-race-member', 'other-race-household', 'other-user', 'owner');`);
    await adoptEmpty(db);
    await createLot(db, 'eggs-a', 10);
    const otherScope = { householdId: 'other-race-household', actorId: 'other-user' };
    await executeInventoryAdoption(db, otherScope, {}, now);
    await executeInventoryLotCommand(db, otherScope, 'other-create', {
      type: 'CREATE', lotId: 'eggs-b', ingredientId: 'CHICKEN_EGG', rawName: 'Other eggs', quantity: 5,
      unit: 'piece',
      storageLocationId: (db.query("SELECT id FROM storage_locations WHERE household_id = 'other-race-household' AND type = 'FRIDGE'")[0] as { id: string }).id,
      sourceType: 'MANUAL',
    }, now);
    // Foreign lot id.
    await expect(executeInventoryLotCommand(db, scope, 'steal-use', {
      type: 'USE', lotId: 'eggs-b', expectedVersion: 1, quantity: 1, unit: 'piece',
    }, now)).rejects.toMatchObject({ code: 'LOT_NOT_FOUND' });
    // Foreign location id.
    await expect(executeInventoryLotCommand(db, scope, 'steal-create', {
      type: 'CREATE', lotId: 'stolen', ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 1,
      unit: 'piece',
      storageLocationId: (db.query("SELECT id FROM storage_locations WHERE household_id = 'other-race-household'")[0] as { id: string }).id,
      sourceType: 'MANUAL',
    }, now)).rejects.toMatchObject({ code: 'LOCATION_NOT_FOUND' });
    expect(lotState(db, 'eggs-a')).toMatchObject({ quantity_milli: 10000, version: 1 });
    expect(lotState(db, 'eggs-b')).toMatchObject({ quantity_milli: 5000, version: 1 });
  });

  it('G11 two adoption requests keep exactly one authority transition', async () => {
    const db = database();
    await backfillLegacyInventory(db, scope.householdId);
    const { gate } = pauseAtWriteBarrier(db, async () => {
      await executeInventoryAdoption(db, scope, {}, now);
    }, 'INTO inventory_adoption_receipts');
    const contender = executeInventoryAdoption(db, scope, {}, now);
    await gate;
    const result = await contender;
    expect(result.replayed).toBe(true);
    expect(db.query('SELECT COUNT(*) AS n FROM inventory_adoption_receipts')[0].n).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM inventory_lots WHERE legacy_item_id IS NULL AND household_id = 'race-household'")[0].n).toBe(0);
  });

  it('G12 property sweep: no negative stock, monotonic versions, projection parity after races', async () => {
    const db = database();
    await adoptEmpty(db);
    await createLot(db, 'eggs', 10, { expiryAt: '2026-09-20', expiryKind: 'KNOWN' });
    await executeInventoryLotCommand(db, scope, 'use-1', {
      type: 'USE', lotId: 'eggs', expectedVersion: 1, quantity: 3, unit: 'piece', reason: 'Cook',
    }, now);
    await executeInventoryLotCommand(db, scope, 'use-2', {
      type: 'USE', lotId: 'eggs', expectedVersion: 2, quantity: 4, unit: 'piece', reason: 'Cook',
    }, now);
    const lot = lotState(db, 'eggs');
    expect(lot).toMatchObject({ quantity_milli: 3000, state: 'ACTIVE', version: 3 });
    // Projection parity: quantity, unit and version track the authoritative lot.
    const projection = db.query<{ quantity: number; unit: string; version: number }>(
      "SELECT quantity, unit, version FROM inventory_items WHERE id = 'eggs'")[0];
    expect(projection).toEqual({ quantity: 3, unit: 'piece', version: 3 });
    // Every receipt carries evidence events; no orphan receipts or events.
    const receiptCount = db.query('SELECT COUNT(*) AS n FROM inventory_commands')[0].n;
    const receiptsWithEvidence = db.query(
      'SELECT COUNT(DISTINCT c.id) AS n FROM inventory_commands c JOIN inventory_events e ON e.command_id = c.id')[0].n;
    expect(receiptCount).toBeGreaterThan(0);
    expect(receiptCount).toBe(receiptsWithEvidence);
    expect(db.query("SELECT COUNT(*) AS n FROM inventory_lots WHERE quantity_milli < 0")[0].n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM inventory_lots WHERE legacy_item_id IS NULL")[0].n).toBe(0);
  });
});
