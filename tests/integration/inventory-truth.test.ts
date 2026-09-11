import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backfillLegacyInventory,
  InventoryTruthBackfillError,
  readInventoryTruthSnapshot,
} from '../../packages/db/src/inventory-truth';
import {
  checkLegacyLotParity,
  projectInventoryLots,
} from '../../packages/domain/src/inventory-truth';
import { createBarrier, SqliteD1 } from '../helpers/sqlite-d1';

const HOUSEHOLD = 'demo_household_01';
const OTHER = 't08-other';
const migration = readFileSync('migrations/0023_inventory_truth_foundation.sql', 'utf8');

describe('T08 inventory truth persistence and legacy backfill', () => {
  const databases: SqliteD1[] = [];
  const database = (migrate = true) => {
    const db = new SqliteD1({ migrate });
    databases.push(db);
    return db;
  };
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  it('replays all 27 migrations on a fresh database with no automatic lot cutover', () => {
    const db = database();
    expect(db.migrations).toHaveLength(27);
    expect(db.migrations.at(-1)).toBe('0027_inventory_fefo_authority.sql');
    expect(db.query('SELECT * FROM inventory_lots')).toEqual([]);
    expect(db.query('SELECT * FROM storage_locations')).toEqual([]);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });

  it('upgrades a populated 0022 database without changing legacy rows or event history', async () => {
    const db = database(false);
    for (const file of readdirSync('migrations').filter((file) => /^\d+.*\.sql$/.test(file) && file < '0023').sort()) {
      db.seed(readFileSync(`migrations/${file}`, 'utf8'));
    }
    const inventory = db.query('SELECT * FROM inventory_items ORDER BY id');
    const events = db.query('SELECT * FROM inventory_events ORDER BY id');
    const ingredients = db.query('SELECT * FROM ingredients ORDER BY id');
    db.seed(migration);
    const result = await backfillLegacyInventory(db, HOUSEHOLD);
    expect(result).toMatchObject({ insertedLotCount: 8, skippedLotCount: 0, parity: { ok: true, issues: [] } });
    expect(db.query('SELECT * FROM inventory_items ORDER BY id')).toEqual(inventory);
    expect(db.query('SELECT * FROM inventory_events ORDER BY id')).toEqual(events);
    expect(db.query('SELECT * FROM ingredients ORDER BY id')).toEqual(ingredients);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('creates defaults and one deterministic synthetic lot per row, then retries without changing facts', async () => {
    const db = database();
    await backfillLegacyInventory(db, HOUSEHOLD);
    const before = await readInventoryTruthSnapshot(db, HOUSEHOLD);
    expect(before.locations.map((location) => [location.type, location.isDefault])).toEqual([
      ['FRIDGE', true], ['FREEZER', true], ['PANTRY', true],
    ]);
    expect(before.lots).toHaveLength(before.legacyRows.length);
    for (const row of before.legacyRows) {
      const lot = before.lots.find((lot) => lot.sourceId === row.id)!;
      expect(lot).toMatchObject({
        householdId: row.household_id, ingredientId: row.ingredient_id,
        rawName: row.name, sourceType: 'LEGACY_BACKFILL', version: 1,
        purchasedAt: null, purchasePrice: null, expiryAt: null, expiryKind: 'UNKNOWN',
        legacyExpiryAt: row.expiry_date,
      });
      expect(before.locations.find((location) => location.id === lot.storageLocationId)?.type.toLowerCase()).toBe(row.storage);
    }
    expect(await backfillLegacyInventory(db, HOUSEHOLD)).toMatchObject({
      insertedLotCount: 0, skippedLotCount: 8, parity: { ok: true },
    });
    expect(await readInventoryTruthSnapshot(db, HOUSEHOLD)).toEqual(before);
  });

  it('preserves unknown ingredient, zero quantity, invalid raw expiry and opening without invented facts', async () => {
    const db = database();
    db.seed(`UPDATE inventory_items SET ingredient_id = NULL, quantity = 0,
      expiry_date = 'not-a-date', opened_at = 'unknown opening' WHERE id = 'item_01'`);
    await backfillLegacyInventory(db, HOUSEHOLD);
    const { lots } = await readInventoryTruthSnapshot(db, HOUSEHOLD);
    expect(lots.find((lot) => lot.sourceId === 'item_01')).toMatchObject({
      ingredientId: null, quantityMilli: 0, state: 'ACTIVE', expiryKind: 'UNKNOWN',
      expiryAt: null, estimatedExpiryAt: null, openedAt: null, purchasedAt: null, purchasePrice: null,
      legacyExpiryAt: 'not-a-date', legacyOpenedAt: 'unknown opening',
    });
  });

  it.each([
    ['estimated', 'user', 'ESTIMATED'],
    ['use_by', 'estimated', 'ESTIMATED'],
    ['best_before', 'user', 'BEST_BEFORE'],
    ['use_by', 'ocr', 'USE_BY'],
    ['unknown', 'unknown', 'UNKNOWN'],
    ['best_before', 'unknown', 'UNKNOWN'],
  ])('preserves %s/%s expiry as %s without upgrading authority', async (kind, source, expected) => {
    const db = database();
    db.execute(`UPDATE inventory_items SET expiry_date = '2026-09-15', expiry_kind = ?, expiry_source = ? WHERE id = 'item_01'`, [kind, source]);
    await backfillLegacyInventory(db, HOUSEHOLD);
    const { lots } = await readInventoryTruthSnapshot(db, HOUSEHOLD);
    const lot = lots.find((lot) => lot.sourceId === 'item_01')!;
    expect(lot.expiryKind).toBe(expected);
    expect(lot.legacyExpiryAt).toBe('2026-09-15');
    expect(lot.expiryAt).toBe(['BEST_BEFORE', 'USE_BY'].includes(expected) ? '2026-09-15' : null);
    expect(lot.estimatedExpiryAt).toBe(expected === 'ESTIMATED' ? '2026-09-15' : null);
  });

  it('backfills kg/l exactly and proves 10 + 6 eggs compatibility projection', async () => {
    const db = database();
    db.seed(`UPDATE inventory_items SET quantity = 10 WHERE id = 'item_01';
      UPDATE inventory_items SET quantity = 0.4, unit = 'kg' WHERE id = 'item_02';
      UPDATE inventory_items SET quantity = 0.2, unit = 'l' WHERE id = 'item_07';
      INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit, storage)
        VALUES ('eggs-second', '${HOUSEHOLD}', 'CHICKEN_EGG', 'Eggs', 6, 'piece', 'fridge')`);
    expect((await backfillLegacyInventory(db, HOUSEHOLD)).parity.ok).toBe(true);
    const { lots } = await readInventoryTruthSnapshot(db, HOUSEHOLD);
    expect(lots.find((lot) => lot.sourceId === 'item_02')).toMatchObject({ quantityMilli: 400000, canonicalUnit: 'g' });
    expect(lots.find((lot) => lot.sourceId === 'item_07')).toMatchObject({ quantityMilli: 200000, canonicalUnit: 'ml' });
    expect(projectInventoryLots(HOUSEHOLD, lots).find((entry) => entry.ingredientId === 'CHICKEN_EGG'))
      .toMatchObject({ totalAvailableQuantity: 16, lotCount: 2 });
  });

  it.each([
    ['negative', -1, 'piece'], ['sub-milli', 0.0001, 'piece'],
    ['floating drift', 0.1 + 0.2, 'piece'], ['overflow', Number.MAX_SAFE_INTEGER, 'kg'],
    ['invalid unit', 1, 'oz'],
  ])('rejects %s before any household backfill writes', async (_label, quantity, unit) => {
    const db = database();
    db.execute('UPDATE inventory_items SET quantity = ?, unit = ? WHERE id = ?', [quantity, unit, 'item_01']);
    await expect(backfillLegacyInventory(db, HOUSEHOLD)).rejects.toBeInstanceOf(InventoryTruthBackfillError);
    expect(db.query('SELECT * FROM inventory_lots')).toEqual([]);
    expect(db.query('SELECT * FROM storage_locations')).toEqual([]);
    expect(db.query('SELECT quantity, unit FROM inventory_items WHERE id = ?', 'item_01')).toEqual([{ quantity, unit }]);
  });

  it.each([false, true])('rolls back all inserts if source changes before batch (version changed: %s)', async (changeVersion) => {
    const db = database();
    db.hooks.beforeBatch = (statements) => {
      if (statements.some((statement) => statement.sql.startsWith('INSERT INTO inventory_lots'))) {
        db.hooks.beforeBatch = undefined;
        db.seed(`UPDATE inventory_items SET quantity = 7${changeVersion ? ', version = version + 1' : ''} WHERE id = 'item_08'`);
      }
    };
    await expect(backfillLegacyInventory(db, HOUSEHOLD)).rejects.toThrow();
    expect(db.query('SELECT * FROM inventory_lots')).toEqual([]);
    expect(db.query('SELECT * FROM storage_locations')).toEqual([]);
  });

  it('deduplicates concurrent insert-only backfills', async () => {
    const db = database();
    const barrier = createBarrier(2);
    db.hooks.beforeBatch = async (statements) => {
      if (statements.some((statement) => statement.sql.startsWith('INSERT INTO inventory_lots'))) await barrier.wait();
    };
    const results = await Promise.all([backfillLegacyInventory(db, HOUSEHOLD), backfillLegacyInventory(db, HOUSEHOLD)]);
    expect(results.map((result) => result.insertedLotCount).sort()).toEqual([0, 8]);
    expect(results.every((result) => result.parity.ok)).toBe(true);
    expect(db.query('SELECT * FROM inventory_lots')).toHaveLength(8);
  });

  it('reports drift rather than overwriting a previous snapshot on retry; legacy delete remains legal', async () => {
    const db = database();
    await backfillLegacyInventory(db, HOUSEHOLD);
    const original = db.query('SELECT * FROM inventory_lots ORDER BY id');
    db.seed("UPDATE inventory_items SET quantity = 2, version = version + 1 WHERE id = 'item_01'");
    expect(await backfillLegacyInventory(db, HOUSEHOLD)).toMatchObject({ insertedLotCount: 0, parity: { ok: false } });
    expect(db.query('SELECT * FROM inventory_lots ORDER BY id')).toEqual(original);
    db.seed("DELETE FROM inventory_items WHERE id = 'item_01'");
    const snapshot = await readInventoryTruthSnapshot(db, HOUSEHOLD);
    expect(checkLegacyLotParity(HOUSEHOLD, snapshot.legacyRows, snapshot.lots, snapshot.locations).ok).toBe(false);
    expect(db.query("SELECT * FROM inventory_events WHERE inventory_item_id = 'item_01'")).toHaveLength(1);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('supports custom locations and existing customized default IDs without duplicate buckets', async () => {
    const db = database();
    db.seed(`INSERT INTO storage_locations VALUES ('custom-fridge', '${HOUSEHOLD}', 'FRIDGE', 'Kitchen Fridge', 0, 1, '2026-09-01', '2026-09-01');
      INSERT INTO storage_locations VALUES ('second-freezer', '${HOUSEHOLD}', 'FREEZER', 'Second Freezer', 4, 0, '2026-09-01', '2026-09-01')`);
    expect((await backfillLegacyInventory(db, HOUSEHOLD)).parity.ok).toBe(true);
    const snapshot = await readInventoryTruthSnapshot(db, HOUSEHOLD);
    expect(snapshot.locations).toHaveLength(4);
    expect(snapshot.lots.find((lot) => lot.sourceId === 'item_01')?.storageLocationId).toBe('custom-fridge');
    expect(() => db.seed(`INSERT INTO storage_locations VALUES ('duplicate', '${HOUSEHOLD}', 'FRIDGE', 'Duplicate', 0, 1, 'x', 'x')`)).toThrow();
  });

  it('does not block existing guest household transfer SQL or silently transfer foundation evidence', async () => {
    const db = database();
    db.seed(`INSERT INTO households(id, name, created_by) VALUES ('${OTHER}', 'Other', 'demo_user_01')`);
    await backfillLegacyInventory(db, HOUSEHOLD);
    db.execute('UPDATE OR IGNORE inventory_items SET household_id = ? WHERE household_id = ?', [OTHER, HOUSEHOLD]);
    db.execute('UPDATE OR IGNORE inventory_events SET household_id = ? WHERE household_id = ?', [OTHER, HOUSEHOLD]);
    expect(db.query('SELECT id FROM inventory_items WHERE household_id = ?', OTHER)).toHaveLength(8);
    expect(db.query('SELECT id FROM inventory_events WHERE household_id = ?', OTHER)).toHaveLength(5);
    expect((await readInventoryTruthSnapshot(db, HOUSEHOLD)).lots).toHaveLength(8);
    const target = await backfillLegacyInventory(db, OTHER);
    expect(target).toMatchObject({ insertedLotCount: 0, parity: { ok: false } });
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('does not invent a consumed state for contradictory legacy freshness', async () => {
    const db = database();
    db.seed("UPDATE inventory_items SET quantity = 5, freshness = 'out_of_stock' WHERE id = 'item_01'");
    expect((await backfillLegacyInventory(db, HOUSEHOLD)).parity.ok).toBe(true);
    const snapshot = await readInventoryTruthSnapshot(db, HOUSEHOLD);
    expect(snapshot.lots.find((lot) => lot.sourceId === 'item_01')).toMatchObject({ quantityMilli: 5000, state: 'ACTIVE' });
  });

  it('isolates reads/backfill and rejects cross-household location binding', async () => {
    const db = database();
    db.seed(`INSERT INTO households(id, name, created_by) VALUES ('${OTHER}', 'Other', 'demo_user_01')`);
    await backfillLegacyInventory(db, HOUSEHOLD);
    expect(await readInventoryTruthSnapshot(db, OTHER)).toEqual({ legacyRows: [], lots: [], locations: [] });
    await backfillLegacyInventory(db, OTHER);
    const other = await readInventoryTruthSnapshot(db, OTHER);
    expect(other.locations).toHaveLength(3);
    expect(() => db.execute("UPDATE inventory_lots SET storage_location_id = ? WHERE source_id = 'item_01'", [other.locations[0].id])).toThrow();
    expect(() => db.execute("UPDATE inventory_lots SET household_id = ? WHERE source_id = 'item_01'", [OTHER])).toThrow();
    await expect(backfillLegacyInventory(db, 'no-such-household')).rejects.toThrow('not found');
  });

  it.each([
    'quantity_milli = -1', 'quantity_milli = 0.5', 'quantity_milli = 9007199254740992',
    "canonical_unit = 'kg'", "ingredient_id = 'NOT_AN_INGREDIENT'", "household_id = 'missing'",
    "storage_location_id = 'missing'", "state = 'LOST'", 'version = 0', 'version = 1.5',
    "source_type = 'INVENTED'", 'source_id = NULL', "source_id = ''",
    "expiry_kind = 'KNOWN'", "expiry_at = '2026-09-15'",
    "expiry_kind = 'ESTIMATED', expiry_at = '2026-09-15', estimated_expiry_at = '2026-09-15'",
    "expiry_kind = 'KNOWN', expiry_at = '2026-02-30'",
    "currency = 'JPY', amount_minor = 238, minor_digits = 2",
    "currency = 'VND', amount_minor = 238, minor_digits = 2",
    "currency = 'USD', amount_minor = 4.99, minor_digits = 2",
    "currency = 'FAKE', amount_minor = 499, minor_digits = 2",
    "currency = 'USD'", 'amount_minor = 0',
  ])('enforces raw SQL lot invariants: %s', async (change) => {
    const db = database();
    await backfillLegacyInventory(db, HOUSEHOLD);
    expect(() => db.seed(`UPDATE inventory_lots SET ${change} WHERE source_id = 'item_01'`)).toThrow();
  });

  it.each([['JPY', 238, 0], ['VND', 20000, 0], ['USD', 499, 2], ['EUR', 0, 2]])(
    'persists explicit %s minor-unit money without filling unknown prices', async (currency, amountMinor, minorDigits) => {
      const db = database();
      await backfillLegacyInventory(db, HOUSEHOLD);
      db.execute("UPDATE inventory_lots SET currency = ?, amount_minor = ?, minor_digits = ? WHERE source_id = 'item_01'", [currency, amountMinor, minorDigits]);
      const snapshot = await readInventoryTruthSnapshot(db, HOUSEHOLD);
      expect(snapshot.lots.find((lot) => lot.sourceId === 'item_01')?.purchasePrice).toEqual({ currency, amountMinor, minorDigits });
      expect(snapshot.lots.find((lot) => lot.sourceId === 'item_02')?.purchasePrice).toBeNull();
    },
  );

  it('rejects duplicate synthetic source identity even with another lot ID', async () => {
    const db = database();
    await backfillLegacyInventory(db, HOUSEHOLD);
    expect(() => db.seed("UPDATE inventory_lots SET source_id = 'item_01' WHERE source_id = 'item_02'")).toThrow();
  });

  it('rejects orphaning a location, but household cascade deletes only its own foundation', async () => {
    const db = database();
    db.seed(`INSERT INTO households(id, name, created_by) VALUES ('${OTHER}', 'Other', 'demo_user_01');
      INSERT INTO inventory_items(id, household_id, ingredient_id, name) VALUES ('other-item', '${OTHER}', 'CHICKEN_EGG', 'Egg')`);
    await backfillLegacyInventory(db, HOUSEHOLD);
    await backfillLegacyInventory(db, OTHER);
    expect(() => db.seed(`DELETE FROM storage_locations WHERE household_id = '${OTHER}' AND type = 'FRIDGE'`)).toThrow();
    db.seed(`DELETE FROM households WHERE id = '${OTHER}'`);
    expect(await readInventoryTruthSnapshot(db, OTHER)).toEqual({ legacyRows: [], lots: [], locations: [] });
    expect((await readInventoryTruthSnapshot(db, HOUSEHOLD)).lots).toHaveLength(8);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('uses indexes for actual household, provenance and FK lookup patterns', async () => {
    const db = database();
    await backfillLegacyInventory(db, HOUSEHOLD);
    const plan = (sql: string) => db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).map((row) => row.detail).join('\n');
    expect(plan(`SELECT * FROM inventory_lots WHERE household_id = '${HOUSEHOLD}'`)).toContain('idx_inventory_lots_household_location');
    expect(plan("SELECT * FROM inventory_lots WHERE source_type = 'LEGACY_BACKFILL' AND source_id = 'item_01'"))
      .toContain('idx_inventory_lots_legacy_source');
    expect(plan("SELECT * FROM inventory_lots WHERE ingredient_id = 'CHICKEN_EGG'"))
      .toContain('idx_inventory_lots_ingredient');
    expect(plan(`SELECT * FROM storage_locations WHERE household_id = '${HOUSEHOLD}' AND is_default = 1`))
      .toContain('idx_storage_locations_default');
  });
});
