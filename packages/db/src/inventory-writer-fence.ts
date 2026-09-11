import type { D1DatabaseBinding, D1PreparedStatement, D1Result } from './index';

export class InventoryWriterAuthorityError extends Error {
  readonly code = 'INVENTORY_AUTHORITY_REQUIRED';

  constructor() {
    super('Inventory lot authority is active; this writer requires an atomic lot adapter');
    this.name = 'InventoryWriterAuthorityError';
  }
}

export class InventoryWriterSnapshotError extends Error {
  readonly code = 'INVENTORY_CONFLICT';

  constructor() {
    super('Inventory changed while preparing this command; reload and retry');
    this.name = 'InventoryWriterSnapshotError';
  }
}

export async function readLegacyInventoryRevision(db: D1DatabaseBinding, householdId: string): Promise<number> {
  const row = await db.prepare('SELECT inventory_version FROM households WHERE id = ?').bind(householdId)
    .first<{ inventory_version: number }>();
  if (!row || !Number.isSafeInteger(row.inventory_version) || row.inventory_version < 1) {
    throw new InventoryWriterSnapshotError();
  }
  return row.inventory_version;
}

// Activation can race a preflight, so the check belongs inside the writer batch.
// An adopted household is authority-active even when it holds no mapped rows
// (empty adoption), so the receipt is part of the fail-closed predicate.
const ACTIVE_AUTHORITY = `(EXISTS (SELECT 1 FROM inventory_lots WHERE household_id = ?
    AND legacy_item_id IS NOT NULL)
  OR EXISTS (SELECT 1 FROM inventory_adoption_receipts WHERE household_id = ?))`;

export async function readInventoryAuthorityMode(db: D1DatabaseBinding,
  householdId: string): Promise<'native' | 'legacy'> {
  const row = await db.prepare(`SELECT ${ACTIVE_AUTHORITY} AS active`).bind(householdId, householdId)
    .first<{ active: number }>();
  return row?.active === 1 ? 'native' : 'legacy';
}

export async function runLegacyInventoryBatch<T = unknown>(db: D1DatabaseBinding,
  householdId: string, statements: D1PreparedStatement[], expectedInventoryVersion?: number,
  sourceFence?: { sql: string; bindings: unknown[] }): Promise<D1Result<T>[]> {
  if (expectedInventoryVersion !== undefined && (!Number.isSafeInteger(expectedInventoryVersion) || expectedInventoryVersion < 1)) {
    throw new InventoryWriterSnapshotError();
  }
  const fence = db.prepare(`INSERT INTO inventory_events
    (id, household_id, inventory_item_id, event_type, quantity_delta, unit)
    SELECT ?, ?, NULL, 'T09_WRITER_FENCE', 0, 'piece' WHERE ${ACTIVE_AUTHORITY}`)
    .bind(crypto.randomUUID(), householdId, householdId, householdId);
  const fences = [fence];
  if (expectedInventoryVersion !== undefined) fences.push(db.prepare(`INSERT INTO inventory_events
    (id, household_id, inventory_item_id, event_type, quantity_delta, unit)
    SELECT ?, ?, '', 'T09_SNAPSHOT_FENCE', 0, NULL WHERE NOT EXISTS
      (SELECT 1 FROM households WHERE id = ? AND inventory_version = ?)
      AND (${sourceFence?.sql ?? '1'})`)
    .bind(crypto.randomUUID(), householdId, householdId, expectedInventoryVersion, ...(sourceFence?.bindings ?? [])));
  try {
    const results = await db.batch<T>([...fences, ...statements]);
    if (results.some((result) => !result.success)) throw new Error('Inventory writer batch failed');
    return results.slice(fences.length);
  } catch (error) {
    // Classification only; this read cannot authorize a write after rollback.
    const row = await db.prepare(`SELECT ${ACTIVE_AUTHORITY} AS active`).bind(householdId, householdId)
      .first<{ active: number }>();
    if (row?.active === 1) throw new InventoryWriterAuthorityError();
    if (expectedInventoryVersion !== undefined
      && await readLegacyInventoryRevision(db, householdId) !== expectedInventoryVersion) {
      throw new InventoryWriterSnapshotError();
    }
    throw error;
  }
}
