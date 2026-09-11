import { z } from 'zod';
import type { D1DatabaseBinding, D1Result } from './index';
import {
  InventoryLotSchema,
  StorageLocationSchema,
  checkLegacyLotParity,
  defaultStorageLocations,
  legacyInventoryToLot,
  type InventoryLot,
  type LegacyInventoryRow,
  type StorageLocation,
} from '../../domain/src/inventory-truth';

const HouseholdId = z.string().min(1).refine((id) => id === id.trim() && !id.includes('\0'));
const LEGACY_COLUMNS = [
  'id', 'household_id', 'ingredient_id', 'name', 'quantity', 'unit', 'storage',
  'expiry_date', 'opened_at', 'expiry_kind', 'expiry_source', 'version', 'created_at', 'updated_at',
] as const;
const LEGACY_SELECT = `SELECT ${LEGACY_COLUMNS.join(', ')} FROM inventory_items WHERE household_id = ? ORDER BY id`;
const LOCATION_SELECT = `SELECT id, household_id AS householdId, type, name, sort_order AS sortOrder,
  is_default AS isDefault, created_at AS createdAt, updated_at AS updatedAt
  FROM storage_locations WHERE household_id = ? ORDER BY sort_order, id`;
const LOT_SELECT = `SELECT id, household_id AS householdId, ingredient_id AS ingredientId,
  raw_name AS rawName, quantity_milli AS quantityMilli, canonical_unit AS canonicalUnit,
  storage_location_id AS storageLocationId, state, purchased_at AS purchasedAt, opened_at AS openedAt,
  expiry_at AS expiryAt, estimated_expiry_at AS estimatedExpiryAt, expiry_kind AS expiryKind,
  source_type AS sourceType, source_id AS sourceId, version, created_at AS createdAt, updated_at AS updatedAt,
  currency, amount_minor AS amountMinor, minor_digits AS minorDigits,
  legacy_expiry_at AS legacyExpiryAt, legacy_expiry_kind AS legacyExpiryKind,
  legacy_expiry_source AS legacyExpirySource, legacy_opened_at AS legacyOpenedAt, legacy_version AS legacyVersion
  FROM inventory_lots WHERE household_id = ? ORDER BY id`;

type LocationRow = Omit<StorageLocation, 'isDefault'> & { isDefault: number };
type LotRow = Omit<InventoryLot, 'purchasePrice'> & {
  currency: string | null;
  amountMinor: number | null;
  minorDigits: number | null;
};

function assertResults(results: D1Result[]): void {
  if (results.some((result) => !result.success)) throw new Error('Inventory truth database operation failed');
}

function decodeLocation(row: LocationRow): StorageLocation {
  if (row.isDefault !== 0 && row.isDefault !== 1) throw new Error('Invalid location default flag');
  return StorageLocationSchema.parse({ ...row, isDefault: row.isDefault === 1 });
}

function decodeLot(row: LotRow): InventoryLot {
  const { currency, amountMinor, minorDigits, ...lot } = row;
  return InventoryLotSchema.parse({
    ...lot,
    purchasePrice: currency === null && amountMinor === null && minorDigits === null
      ? null : { currency, amountMinor, minorDigits },
  });
}

// Internal tooling only: callers must already have authority over this household.
export async function readInventoryTruthSnapshot(db: D1DatabaseBinding, householdId: string) {
  const household = HouseholdId.parse(householdId);
  const results = await db.batch([
    db.prepare(LEGACY_SELECT).bind(household),
    db.prepare(LOT_SELECT).bind(household),
    db.prepare(LOCATION_SELECT).bind(household),
  ]);
  assertResults(results);
  return {
    legacyRows: results[0].results as LegacyInventoryRow[],
    lots: (results[1].results as LotRow[]).map(decodeLot),
    locations: (results[2].results as LocationRow[]).map(decodeLocation),
  };
}

export class InventoryTruthBackfillError extends Error {
  constructor(readonly issues: { legacyItemId: string; detail: string }[]) {
    super(`Legacy backfill preflight failed: ${issues.map((issue) => `${issue.legacyItemId}: ${issue.detail}`).join('; ')}`);
    this.name = 'InventoryTruthBackfillError';
  }
}

export async function backfillLegacyInventory(db: D1DatabaseBinding, householdId: string) {
  const household = HouseholdId.parse(householdId);
  const adopted = await db.prepare('SELECT id FROM inventory_adoption_receipts WHERE household_id = ?')
    .bind(household).first<{ id: string }>();
  // An adopted household owns its lot truth; re-running insert-only backfill
  // would create unmapped snapshots no writer could adopt afterwards.
  if (adopted) throw new Error('Inventory truth household is already adopted');
  const source = await db.batch([
    db.prepare('SELECT id, created_at, updated_at FROM households WHERE id = ?').bind(household),
    db.prepare(LEGACY_SELECT).bind(household),
    db.prepare(LOCATION_SELECT).bind(household),
  ]);
  assertResults(source);
  const owner = source[0].results[0] as { id: string; created_at: string; updated_at: string } | undefined;
  if (!owner) throw new Error('Inventory truth household not found');
  const rows = source[1].results as LegacyInventoryRow[];
  const existingLocations = (source[2].results as LocationRow[]).map(decodeLocation);
  const locations = defaultStorageLocations(household, owner.created_at, owner.updated_at).map(
    (location) => existingLocations.find((existing) => existing.type === location.type && existing.isDefault) ?? location,
  );
  const lots: InventoryLot[] = [];
  const issues: { legacyItemId: string; detail: string }[] = [];
  for (const row of rows) {
    try {
      const lot = legacyInventoryToLot(row);
      lot.storageLocationId = locations.find((location) => location.type.toLowerCase() === row.storage)!.id;
      lots.push(lot);
    } catch (error) {
      issues.push({ legacyItemId: row.id, detail: error instanceof Error ? error.message : 'Invalid legacy row' });
    }
  }
  if (issues.length) throw new InventoryTruthBackfillError(issues);

  const statements = locations.map((location) => db.prepare(`INSERT INTO storage_locations
    (id, household_id, type, name, sort_order, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(household_id, type) WHERE is_default = 1 DO NOTHING`).bind(
    location.id, household, location.type, location.name, location.sortOrder, location.createdAt, location.updatedAt,
  ));
  lots.forEach((lot, index) => {
    const row = rows[index];
    // A stale/missing source makes NOT NULL fail inside the batch, rolling back every insert.
    const sourceGuard = `CASE WHEN EXISTS (SELECT 1 FROM inventory_items WHERE ${LEGACY_COLUMNS.map((column) => `${column} IS ?`).join(' AND ')}) THEN ? ELSE NULL END`;
    statements.push(db.prepare(`INSERT INTO inventory_lots
      (id, household_id, ingredient_id, raw_name, quantity_milli, canonical_unit, storage_location_id,
       state, purchased_at, opened_at, expiry_at, estimated_expiry_at, expiry_kind, source_type, source_id,
       version, created_at, updated_at, currency, amount_minor, minor_digits,
       legacy_expiry_at, legacy_expiry_kind, legacy_expiry_source, legacy_opened_at, legacy_version)
      VALUES (?, ?, ?, ?, ${sourceGuard}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) WHERE source_type = 'LEGACY_BACKFILL' DO NOTHING`).bind(
      lot.id, lot.householdId, lot.ingredientId, lot.rawName,
      ...LEGACY_COLUMNS.map((column) => row[column]), lot.quantityMilli,
      lot.canonicalUnit, lot.storageLocationId, lot.state, lot.purchasedAt, lot.openedAt,
      lot.expiryAt, lot.estimatedExpiryAt, lot.expiryKind, lot.sourceType, lot.sourceId,
      lot.version, lot.createdAt, lot.updatedAt, null, null, null,
      lot.legacyExpiryAt, lot.legacyExpiryKind, lot.legacyExpirySource, lot.legacyOpenedAt, lot.legacyVersion,
    ));
  });
  const results = await db.batch(statements);
  assertResults(results);
  const insertedLotCount = results.slice(locations.length).reduce((count, result) => count + Number(result.meta.changes), 0);
  const snapshot = await readInventoryTruthSnapshot(db, household);
  return {
    insertedLotCount,
    skippedLotCount: lots.length - insertedLotCount,
    parity: checkLegacyLotParity(household, snapshot.legacyRows, snapshot.lots, snapshot.locations),
  };
}
