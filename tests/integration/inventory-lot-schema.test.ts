import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import { SqliteD1 } from '../helpers/sqlite-d1';

const household = 'demo_household_01';
const migration = readFileSync('migrations/0024_inventory_lot_commands.sql', 'utf8');
const databases: SqliteD1[] = [];
const database = (migrate = true) => {
  const db = new SqliteD1({ migrate });
  databases.push(db);
  return db;
};
afterEach(() => databases.splice(0).forEach((db) => db.close()));

async function mapped(db: SqliteD1, owner = household, item = 'item_01') {
  await backfillLegacyInventory(db, owner);
  db.execute('UPDATE inventory_lots SET legacy_item_id = source_id WHERE source_id = ?', [item]);
  db.execute(`INSERT INTO inventory_commands
    (id, household_id, actor_id, client_key, fingerprint, command_type, result_json, created_at)
    VALUES ('command-a', ?, 'demo_user_01', 'key-a', 'fingerprint-a', 'CREATE', '{}', '2026-09-10T00:00:00Z')`, [owner]);
  db.execute(`INSERT INTO inventory_events
    (id, household_id, inventory_item_id, event_type, quantity_delta, unit, command_id)
    VALUES ('event-a', ?, ?, 'LOT_CREATE', 1, 'piece', 'command-a')`, [owner, item]);
}

function revision(db: SqliteD1, owner = household): number {
  return db.query<{ inventory_version: number }>('SELECT inventory_version FROM households WHERE id = ?', owner)[0].inventory_version;
}

describe('T09 additive schema and immutable command evidence', () => {
  it('upgrades populated T08 without altering historical rows or activating snapshots', async () => {
    const db = database(false);
    for (const file of readdirSync('migrations').filter((name) => /^\d+.*\.sql$/.test(name) && name < '0024').sort()) {
      db.seed(readFileSync(`migrations/${file}`, 'utf8'));
    }
    await backfillLegacyInventory(db, household);
    const items = db.query('SELECT * FROM inventory_items ORDER BY id');
    const lots = db.query('SELECT * FROM inventory_lots ORDER BY id');
    const events = db.query('SELECT * FROM inventory_events ORDER BY id');
    db.seed(migration);
    expect(db.query('SELECT * FROM inventory_items ORDER BY id')).toEqual(items);
    expect(db.query('SELECT * FROM inventory_lots ORDER BY id')).toEqual(lots.map((lot) => ({ ...lot, legacy_item_id: null })));
    expect(db.query('SELECT * FROM inventory_events ORDER BY id')).toEqual(events.map((event) => ({ ...event, command_id: null })));
    expect(db.query('SELECT * FROM inventory_commands')).toEqual([]);
    expect(revision(db)).toBe(1);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });

  it.each([
    "UPDATE inventory_commands SET fingerprint = 'changed'",
    'DELETE FROM inventory_commands',
    'INSERT OR REPLACE INTO inventory_commands SELECT * FROM inventory_commands',
    "UPDATE inventory_events SET metadata = '{}' WHERE id = 'event-a'",
    "UPDATE inventory_events SET command_id = NULL WHERE id = 'event-a'",
    "DELETE FROM inventory_events WHERE id = 'event-a'",
    "INSERT OR REPLACE INTO inventory_events SELECT * FROM inventory_events WHERE id = 'event-a'",
    "UPDATE inventory_lots SET legacy_item_id = NULL, version = version + 1 WHERE legacy_item_id IS NOT NULL",
    "UPDATE inventory_lots SET source_type = 'MANUAL', source_id = NULL, version = version + 1 WHERE legacy_item_id IS NOT NULL",
    'DELETE FROM inventory_lots WHERE legacy_item_id IS NOT NULL',
    'INSERT OR REPLACE INTO inventory_lots SELECT * FROM inventory_lots WHERE legacy_item_id IS NOT NULL',
    "DELETE FROM inventory_items WHERE id = 'item_01'",
    "INSERT OR REPLACE INTO inventory_items SELECT * FROM inventory_items WHERE id = 'item_01'",
  ])('rejects evidence/mapping rewrite: %s', async (sql) => {
    const db = database();
    await mapped(db);
    const before = db.query('SELECT * FROM inventory_lots ORDER BY id');
    expect(() => db.seed(sql)).toThrow();
    expect(db.query('SELECT * FROM inventory_lots ORDER BY id')).toEqual(before);
    expect(db.query('SELECT id FROM inventory_commands')).toEqual([{ id: 'command-a' }]);
    expect(db.query("SELECT command_id FROM inventory_events WHERE id = 'event-a'"))
      .toEqual([{ command_id: 'command-a' }]);
  });

  it.each([
    "state = 'CONSUMED', quantity_milli = 1",
    "state = 'DISCARDED', quantity_milli = 1",
    "state = 'ACTIVE', quantity_milli = 0",
    'quantity_milli = -1',
  ])('protects mapped live lifecycle: %s', async (change) => {
    const db = database();
    await mapped(db);
    expect(() => db.seed(`UPDATE inventory_lots SET ${change}, version = version + 1 WHERE legacy_item_id IS NOT NULL`)).toThrow();
  });

  it('requires a version increment and permits zero terminal state without deleting the lot', async () => {
    const db = database();
    await mapped(db);
    expect(() => db.seed("UPDATE inventory_lots SET quantity_milli = 1 WHERE legacy_item_id IS NOT NULL")).toThrow();
    db.seed("UPDATE inventory_lots SET quantity_milli = 0, state = 'DISCARDED', version = version + 1 WHERE legacy_item_id IS NOT NULL");
    expect(db.query('SELECT state, quantity_milli FROM inventory_lots WHERE legacy_item_id IS NOT NULL'))
      .toEqual([{ state: 'DISCARDED', quantity_milli: 0 }]);
  });

  it('denies both directions of projection ownership mismatch and cross-tenant command evidence', async () => {
    const db = database();
    db.seed(`INSERT INTO households(id, name, created_by) VALUES ('other', 'Other', 'demo_user_01');
      INSERT INTO inventory_items(id, household_id, name, quantity) VALUES ('other-item', 'other', 'Other', 1)`);
    await backfillLegacyInventory(db, household);
    expect(() => db.seed("UPDATE inventory_lots SET legacy_item_id = 'other-item' WHERE source_id = 'item_01'")).toThrow();
    await mapped(db);
    expect(() => db.seed("UPDATE inventory_items SET household_id = 'other' WHERE id = 'item_01'")).toThrow();
    expect(() => db.seed(`INSERT INTO inventory_events
      (id, household_id, inventory_item_id, event_type, quantity_delta, unit, command_id)
      VALUES ('foreign-event', 'other', 'other-item', 'LOT_USE', -1, 'piece', 'command-a')`)).toThrow();
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('blocks fresh and concurrent-style backfill after activation without partial new snapshots', async () => {
    const db = database();
    await mapped(db);
    db.seed(`INSERT INTO inventory_items(id, household_id, name, quantity)
      VALUES ('later-legacy-row', '${household}', 'Later', 1)`);
    const before = db.query('SELECT * FROM inventory_lots ORDER BY id');
    await expect(backfillLegacyInventory(db, household)).rejects.toThrow('Backfill cannot run after live lot activation');
    expect(db.query('SELECT * FROM inventory_lots ORDER BY id')).toEqual(before);
  });

  it('preserves historical event behavior and explicit household cascade', async () => {
    const db = database();
    db.seed("UPDATE inventory_events SET reason = 'historical fixture' WHERE id = (SELECT id FROM inventory_events LIMIT 1)");
    db.seed(`INSERT INTO households(id, name, created_by) VALUES ('isolated', 'Isolated', 'demo_user_01');
      INSERT INTO inventory_items(id, household_id, name, quantity) VALUES ('isolated-item', 'isolated', 'Egg', 1)`);
    await mapped(db, 'isolated', 'isolated-item');
    db.seed("DELETE FROM households WHERE id = 'isolated'");
    for (const table of ['inventory_lots', 'inventory_items', 'inventory_events', 'inventory_commands', 'storage_locations']) {
      expect(db.query(`SELECT id FROM ${table} WHERE household_id = 'isolated'`)).toEqual([]);
    }
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('fences all stock/location edits and both households of a historical ownership move', async () => {
    const db = database();
    await backfillLegacyInventory(db, household);
    for (const sql of [
      "UPDATE inventory_items SET name = name WHERE id = 'item_01'",
      "UPDATE inventory_lots SET raw_name = raw_name WHERE source_id = 'item_01'",
      `UPDATE storage_locations SET name = name WHERE id = 't08-location:${household}:FRIDGE'`,
    ]) {
      const before = revision(db);
      db.seed(sql);
      expect(revision(db)).toBe(before + 1);
    }
    db.seed("INSERT INTO households(id, name, created_by) VALUES ('other', 'Other', 'demo_user_01')");
    const oldRevision = revision(db);
    const newRevision = revision(db, 'other');
    db.seed("UPDATE inventory_items SET household_id = 'other' WHERE id = 'item_01'");
    expect(revision(db)).toBe(oldRevision + 1);
    expect(revision(db, 'other')).toBe(newRevision + 1);
  });

  it('fails closed on revision overflow and preserves top-level changes() under revision triggers', () => {
    const db = database();
    db.seed("UPDATE inventory_items SET name = name WHERE id = 'item_01'");
    expect(db.query('SELECT changes() AS changed')).toEqual([{ changed: 1 }]);
    db.seed(`UPDATE households SET inventory_version = 9007199254740991 WHERE id = '${household}'`);
    expect(() => db.seed("UPDATE inventory_items SET name = 'overflow' WHERE id = 'item_01'")).toThrow();
    expect(db.query("SELECT id FROM inventory_items WHERE name = 'overflow'")).toEqual([]);
  });

  it('indexes projection, receipt replay and command-event lookups', async () => {
    const db = database();
    await mapped(db);
    const plan = (sql: string) => db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).map((row) => row.detail).join('\n');
    expect(plan("SELECT * FROM inventory_lots WHERE legacy_item_id = 'item_01'"))
      .toContain('idx_inventory_lots_projection');
    expect(plan(`SELECT * FROM inventory_commands WHERE household_id = '${household}' AND client_key = 'key-a'`))
      .toContain('sqlite_autoindex_inventory_commands_2');
    expect(plan("SELECT * FROM inventory_events WHERE command_id = 'command-a'"))
      .toContain('idx_inventory_events_command_lot');
  });
});
