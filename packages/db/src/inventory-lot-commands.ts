import { z } from 'zod';
import type { D1DatabaseBinding, D1PreparedStatement, D1Result } from './index';
import {
  InventoryLotCommandSchema, LotCommandError, planSingleLotCommand,
  type InventoryLotCommand, type SingleLotCommandPlan,
} from '../../domain/src/inventory-lot-commands';
import {
  InventoryLotSchema, StorageLocationSchema, toLotQuantity,
  type InventoryLot, type LegacyInventoryRow, type StorageLocation,
} from '../../domain/src/inventory-truth';

const Identity = z.string().min(1).refine((value) => value === value.trim() && !value.includes('\0'));
const Scope = z.object({ householdId: Identity, actorId: Identity }).strict();
const ClientKey = Identity.refine((value) => value.length <= 200);
export interface InventoryLotCommandScope { householdId: string; actorId: string }
export interface InventoryLotCommandResult {
  commandId: string;
  commandType: InventoryLotCommand['type'];
  lotId: string;
  version: number;
  effects: SingleLotCommandPlan[];
}
export interface InventoryLotCommandExecution { result: InventoryLotCommandResult; replayed: boolean }

interface IngredientRow { id: string; category: string }
interface ProjectionRow extends LegacyInventoryRow { category: string; data_source: string; freshness: string }
interface MappedLot { lot: InventoryLot; legacyItemId: string | null }
interface MappedLotSnapshot {
  inventoryVersion: number;
  lots: MappedLot[];
  legacyRows: ProjectionRow[];
  locations: StorageLocation[];
  ingredients: IngredientRow[];
}
type LotRow = Omit<InventoryLot, 'purchasePrice'> & {
  legacyItemId: string | null; currency: string | null; amountMinor: number | null; minorDigits: number | null;
};
type LocationRow = Omit<StorageLocation, 'isDefault'> & { isDefault: number };
interface ReceiptRow { fingerprint: string; result_json: string }

const MEMBERSHIP = `EXISTS (SELECT 1 FROM household_members m JOIN users u ON u.id = m.user_id
  WHERE m.household_id = households.id AND u.id = ?)`;
function authorizedHousehold(db: D1DatabaseBinding, scope: InventoryLotCommandScope) {
  return db.prepare(`SELECT inventory_version AS inventoryVersion FROM households WHERE id = ? AND ${MEMBERSHIP}`)
    .bind(scope.householdId, scope.actorId);
}
function assertResults(results: D1Result[]): void {
  if (results.some((result) => !result.success)) throw new LotCommandError('PERSISTENCE_FAILED');
}
async function readBatch(db: D1DatabaseBinding, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    const results = await db.batch(statements);
    assertResults(results);
    return results;
  } catch {
    throw new LotCommandError('PERSISTENCE_FAILED');
  }
}
function readAuthorization(result: D1Result): number {
  const row = result.results[0] as { inventoryVersion: number } | undefined;
  if (!row) throw new LotCommandError('FORBIDDEN');
  if (!Number.isSafeInteger(row.inventoryVersion) || row.inventoryVersion < 1) throw new LotCommandError('DRIFT_DETECTED');
  return row.inventoryVersion;
}
function parseScope(input: InventoryLotCommandScope): InventoryLotCommandScope {
  const parsed = Scope.safeParse(input);
  if (!parsed.success) throw new LotCommandError('FORBIDDEN');
  return parsed.data;
}

// All planning inputs share one D1 transaction; no interleaved per-row reads.
export async function readMappedLotSnapshot(db: D1DatabaseBinding, input: InventoryLotCommandScope): Promise<MappedLotSnapshot> {
  const scope = parseScope(input);
  const results = await readBatch(db, [
    authorizedHousehold(db, scope),
    db.prepare(`SELECT id, household_id, ingredient_id, name, quantity, unit, storage, expiry_date,
      opened_at, expiry_kind, expiry_source, version, created_at, updated_at, category, data_source, freshness
      FROM inventory_items WHERE household_id = ? ORDER BY id`).bind(scope.householdId),
    db.prepare(`SELECT id, household_id AS householdId, ingredient_id AS ingredientId, raw_name AS rawName,
      quantity_milli AS quantityMilli, canonical_unit AS canonicalUnit, storage_location_id AS storageLocationId,
      state, purchased_at AS purchasedAt, opened_at AS openedAt, expiry_at AS expiryAt,
      estimated_expiry_at AS estimatedExpiryAt, expiry_kind AS expiryKind, source_type AS sourceType,
      source_id AS sourceId, version, created_at AS createdAt, updated_at AS updatedAt,
      currency, amount_minor AS amountMinor, minor_digits AS minorDigits, legacy_expiry_at AS legacyExpiryAt,
      legacy_expiry_kind AS legacyExpiryKind, legacy_expiry_source AS legacyExpirySource,
      legacy_opened_at AS legacyOpenedAt, legacy_version AS legacyVersion, legacy_item_id AS legacyItemId
      FROM inventory_lots WHERE household_id = ? ORDER BY id`).bind(scope.householdId),
    db.prepare(`SELECT id, household_id AS householdId, type, name, sort_order AS sortOrder,
      is_default AS isDefault, created_at AS createdAt, updated_at AS updatedAt
      FROM storage_locations WHERE household_id = ? ORDER BY sort_order, id`).bind(scope.householdId),
    db.prepare('SELECT id, category FROM ingredients ORDER BY id'),
  ]);
  const inventoryVersion = readAuthorization(results[0]);
  try {
    return {
      inventoryVersion,
      legacyRows: results[1].results as ProjectionRow[],
      lots: (results[2].results as LotRow[]).map((row) => {
        const { currency, amountMinor, minorDigits, legacyItemId, ...lot } = row;
        return { legacyItemId, lot: InventoryLotSchema.parse({
          ...lot, purchasePrice: currency === null && amountMinor === null && minorDigits === null
            ? null : { currency, amountMinor, minorDigits },
        }) };
      }),
      locations: (results[3].results as LocationRow[]).map((row) => {
        if (row.isDefault !== 0 && row.isDefault !== 1) throw new Error('Invalid location');
        return StorageLocationSchema.parse({ ...row, isDefault: row.isDefault === 1 });
      }),
      ingredients: results[4].results as IngredientRow[],
    };
  } catch {
    throw new LotCommandError('DRIFT_DETECTED');
  }
}

function sortedJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object') return Object.fromEntries(
      Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => [key, sort(entry)]),
    );
    return item;
  };
  return JSON.stringify(sort(value));
}

async function readReceipt(db: D1DatabaseBinding, scope: InventoryLotCommandScope, key: string): Promise<ReceiptRow | undefined> {
  const results = await readBatch(db, [
    authorizedHousehold(db, scope),
    db.prepare('SELECT fingerprint, result_json FROM inventory_commands WHERE household_id = ? AND client_key = ?')
      .bind(scope.householdId, key),
  ]);
  readAuthorization(results[0]);
  return results[1].results[0] as ReceiptRow | undefined;
}
function replay(receipt: ReceiptRow, fingerprint: string): InventoryLotCommandExecution {
  if (receipt.fingerprint !== fingerprint) throw new LotCommandError('IDEMPOTENCY_CONFLICT');
  return { result: JSON.parse(receipt.result_json) as InventoryLotCommandResult, replayed: true };
}

function exactLegacyQuantity(milli: number, unit: InventoryLot['canonicalUnit']): number {
  const quantity = milli / 1000;
  try {
    if (toLotQuantity(Math.abs(quantity), unit).quantityMilli === Math.abs(milli)) return quantity;
  } catch { /* Reject lossy REAL compatibility projections. */ }
  throw new LotCommandError('UNREPRESENTABLE_QUANTITY');
}
function expiryProjection(lot: InventoryLot) {
  return {
    expiry_date: lot.expiryAt ?? lot.estimatedExpiryAt,
    expiry_kind: lot.expiryKind === 'BEST_BEFORE' ? 'best_before' : lot.expiryKind === 'USE_BY' ? 'use_by'
      : lot.expiryKind === 'ESTIMATED' ? 'estimated' : 'unknown',
    // The legacy manual-evidence enum is "user", not "manual".
    expiry_source: lot.expiryKind === 'ESTIMATED' ? 'estimated'
      : lot.expiryKind === 'BEST_BEFORE' || lot.expiryKind === 'USE_BY' ? 'user' : 'unknown',
  };
}
function requireParity(mapped: MappedLot, snapshot: MappedLotSnapshot, householdId: string): ProjectionRow {
  const { lot, legacyItemId } = mapped;
  if (legacyItemId === null || lot.sourceType === 'LEGACY_BACKFILL') throw new LotCommandError('ADOPTION_REQUIRED');
  const row = snapshot.legacyRows.find((row) => row.id === legacyItemId);
  const location = snapshot.locations.find((location) => location.id === lot.storageLocationId);
  const expiry = expiryProjection(lot);
  const historicalUnknown = lot.expiryKind === 'UNKNOWN' && row?.expiry_date === lot.legacyExpiryAt;
  let quantityMatches = false;
  try {
    quantityMatches = row !== undefined && row.unit === lot.canonicalUnit
      && toLotQuantity(row.quantity, row.unit).quantityMilli === lot.quantityMilli;
  } catch { /* Invalid compatibility stock is drift, never a repair request. */ }
  if (!row || lot.id !== legacyItemId || lot.householdId !== householdId || row.household_id !== householdId
    || row.ingredient_id !== lot.ingredientId || row.name !== lot.rawName || !quantityMatches
    || location?.householdId !== householdId || location.type.toLowerCase() !== row.storage
    || !Number.isSafeInteger(row.version) || row.version < 1 || lot.legacyVersion !== row.version
    || (lot.state === 'ACTIVE' ? lot.quantityMilli <= 0 : lot.quantityMilli !== 0)
    || (lot.ingredientId !== null && !snapshot.ingredients.some((ingredient) => ingredient.id === lot.ingredientId))
    || (row.expiry_date !== expiry.expiry_date && !historicalUnknown)
    || row.expiry_kind !== expiry.expiry_kind || row.expiry_source !== expiry.expiry_source
    || (row.opened_at !== lot.openedAt && !(lot.openedAt === null && row.opened_at === lot.legacyOpenedAt))) {
    throw new LotCommandError('DRIFT_DETECTED');
  }
  return row;
}

// A zero-row CAS must abort the batch itself, not be discovered after commit.
function writeGuard(db: D1DatabaseBinding, scope: InventoryLotCommandScope,
  column: 'quantity_delta' | 'unit' | 'event_type' | 'inventory_item_id') {
  return db.prepare(`INSERT INTO inventory_events
    (id, household_id, inventory_item_id, event_type, quantity_delta, unit)
    SELECT ?, ?, ${column === 'inventory_item_id' ? 'NULL' : "''"}, ${column === 'event_type' ? 'NULL' : "'T09_GUARD'"},
      ${column === 'quantity_delta' ? 'NULL' : '0'}, ${column === 'unit' ? 'NULL' : "'piece'"}
    WHERE changes() <> 1`).bind(crypto.randomUUID(), scope.householdId);
}
function freshness(expiry: string | null, now: string): string {
  // Legacy computeFreshness thresholds, with the command's fixed clock.
  const hours = expiry === null ? Infinity : (Date.parse(expiry) - Date.parse(now)) / 3_600_000;
  return hours <= 24 ? 'expiring' : hours <= 72 ? 'use_soon' : 'fresh';
}
function projectionWrites(db: D1DatabaseBinding, plan: SingleLotCommandPlan, row: ProjectionRow | null,
  snapshot: MappedLotSnapshot, now: string): D1PreparedStatement {
  const { before, after } = plan;
  const unchangedExpiry = before !== null && before.expiryKind === after.expiryKind
    && before.expiryAt === after.expiryAt && before.estimatedExpiryAt === after.estimatedExpiryAt;
  const expiry = unchangedExpiry && row ? row : expiryProjection(after);
  const openedAt = before && row && before.openedAt === after.openedAt ? row.opened_at : after.openedAt;
  const category = snapshot.ingredients.find((ingredient) => ingredient.id === after.ingredientId)?.category ?? 'other';
  const storage = snapshot.locations.find((location) => location.id === after.storageLocationId)!.type.toLowerCase();
  const projectedFreshness = after.quantityMilli === 0 ? 'out_of_stock'
    : row && before && before.quantityMilli > 0 && unchangedExpiry ? row.freshness
      : freshness(expiry.expiry_date, now);
  const values = [after.ingredientId, after.rawName, exactLegacyQuantity(after.quantityMilli, after.canonicalUnit),
    after.canonicalUnit, category, storage, expiry.expiry_date, expiry.expiry_kind, expiry.expiry_source,
    openedAt, projectedFreshness, after.legacyVersion, after.updatedAt];
  if (row) return db.prepare(`UPDATE inventory_items SET ingredient_id = ?, name = ?, quantity = ?, unit = ?,
    category = ?, storage = ?, expiry_date = ?, expiry_kind = ?, expiry_source = ?, opened_at = ?, freshness = ?,
    version = ?, updated_at = ? WHERE id = ? AND household_id = ? AND version = ? RETURNING id, version`)
    .bind(...values, row.id, after.householdId, row.version);
  return db.prepare(`INSERT INTO inventory_items (ingredient_id, name, quantity, unit, category, storage,
    expiry_date, expiry_kind, expiry_source, opened_at, freshness, version, updated_at,
    id, household_id, created_at, added_date, data_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, version`)
    .bind(...values, after.id, after.householdId, after.createdAt, after.createdAt,
      after.sourceType === 'SCAN' || after.sourceType === 'RECEIPT' ? 'scan' : after.sourceType === 'SHOPPING' ? 'shopping' : 'manual');
}
function lotWrite(db: D1DatabaseBinding, plan: SingleLotCommandPlan): D1PreparedStatement {
  const { before, after: lot } = plan;
  const values = [lot.ingredientId, lot.rawName, lot.quantityMilli, lot.canonicalUnit, lot.storageLocationId, lot.state,
    lot.purchasedAt, lot.openedAt, lot.expiryAt, lot.estimatedExpiryAt, lot.expiryKind, lot.version, lot.updatedAt,
    lot.purchasePrice?.currency ?? null, lot.purchasePrice?.amountMinor ?? null, lot.purchasePrice?.minorDigits ?? null, lot.legacyVersion];
  if (before) return db.prepare(`UPDATE inventory_lots SET ingredient_id = ?, raw_name = ?, quantity_milli = ?,
    canonical_unit = ?, storage_location_id = ?, state = ?, purchased_at = ?, opened_at = ?, expiry_at = ?,
    estimated_expiry_at = ?, expiry_kind = ?, version = ?, updated_at = ?, currency = ?, amount_minor = ?, minor_digits = ?,
    legacy_version = ? WHERE id = ? AND household_id = ? AND version = ? AND legacy_item_id = ? RETURNING id, version`)
    .bind(...values, lot.id, lot.householdId, before.version, lot.id);
  return db.prepare(`INSERT INTO inventory_lots (ingredient_id, raw_name, quantity_milli, canonical_unit,
    storage_location_id, state, purchased_at, opened_at, expiry_at, estimated_expiry_at, expiry_kind, version,
    updated_at, currency, amount_minor, minor_digits, legacy_version, id, household_id, source_type, source_id,
    created_at, legacy_item_id, legacy_expiry_at, legacy_expiry_kind, legacy_expiry_source, legacy_opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, version`)
    .bind(...values, lot.id, lot.householdId, lot.sourceType, lot.sourceId, lot.createdAt, lot.id,
      lot.legacyExpiryAt, lot.legacyExpiryKind, lot.legacyExpirySource, lot.legacyOpenedAt);
}

// Internal phase-C boundary only; legacy writer integration precedes route exposure.
export async function executeInventoryLotCommand(db: D1DatabaseBinding, inputScope: InventoryLotCommandScope,
  clientKey: string, input: unknown, now = new Date().toISOString()): Promise<InventoryLotCommandExecution> {
  const scope = parseScope(inputScope);
  const authorization = await readBatch(db, [authorizedHousehold(db, scope)]);
  readAuthorization(authorization[0]);
  const key = ClientKey.safeParse(clientKey);
  const parsed = InventoryLotCommandSchema.safeParse(input);
  if (!key.success || !parsed.success) throw new LotCommandError('INVALID_COMMAND');
  const command = parsed.data;
  const fingerprint = sortedJson({ ...scope, command });
  const prior = await readReceipt(db, scope, key.data);
  if (prior) return replay(prior, fingerprint);
  try {
    const snapshot = await readMappedLotSnapshot(db, scope);
    const representedRows = new Set(snapshot.lots.map(({ legacyItemId }) => legacyItemId));
    if (snapshot.lots.some(({ lot, legacyItemId }) => legacyItemId === null || lot.sourceType === 'LEGACY_BACKFILL')
      || snapshot.legacyRows.some(({ id }) => !representedRows.has(id))) {
      throw new LotCommandError('ADOPTION_REQUIRED');
    }
    const mapped = snapshot.lots.find(({ lot }) => lot.id === command.lotId);
    const row = mapped && command.type !== 'CREATE' ? requireParity(mapped, snapshot, scope.householdId) : null;
    if (command.type === 'CREATE' && snapshot.legacyRows.some((row) => row.id === command.lotId)) throw new LotCommandError('LOT_EXISTS');
    const plan = planSingleLotCommand(command, mapped?.lot ?? null, {
      householdId: scope.householdId, now, locations: snapshot.locations, ingredientIds: snapshot.ingredients.map(({ id }) => id),
    });
    if (plan.changed) {
      if (row?.version === Number.MAX_SAFE_INTEGER) throw new LotCommandError('VERSION_OVERFLOW');
      plan.after = { ...plan.after, legacyVersion: row ? row.version + 1 : 1 };
      exactLegacyQuantity(plan.after.quantityMilli, plan.after.canonicalUnit);
      exactLegacyQuantity(plan.deltaMilli, plan.after.canonicalUnit);
    }
    const result: InventoryLotCommandResult = {
      commandId: crypto.randomUUID(), commandType: command.type, lotId: command.lotId,
      version: plan.after.version, effects: plan.changed ? [plan] : [],
    };
    const statements = [
      db.prepare(`INSERT INTO inventory_commands (id, household_id, actor_id, client_key, fingerprint, command_type, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(result.commandId, scope.householdId, scope.actorId, key.data,
        fingerprint, command.type, JSON.stringify(result), now),
      writeGuard(db, scope, 'inventory_item_id'),
      db.prepare(`UPDATE households SET inventory_version = inventory_version WHERE id = ? AND inventory_version = ? AND ${MEMBERSHIP}`)
        .bind(scope.householdId, snapshot.inventoryVersion, scope.actorId),
      writeGuard(db, scope, 'quantity_delta'),
    ];
    if (plan.changed) {
      statements.push(projectionWrites(db, plan, row, snapshot, now), writeGuard(db, scope, 'unit'),
        lotWrite(db, plan), writeGuard(db, scope, 'event_type'));
      const metadata = {
        schemaVersion: 1, householdId: scope.householdId, actorId: scope.actorId, commandId: result.commandId,
        commandType: command.type, before: plan.before, after: plan.after, deltaMilli: plan.deltaMilli,
        source: { type: plan.after.sourceType, id: plan.after.sourceId }, timestamp: now,
        clientKey: key.data, fingerprint,
        allocation: [{ lotId: plan.after.id, deltaMilli: plan.deltaMilli, canonicalUnit: plan.after.canonicalUnit }],
      };
      statements.push(db.prepare(`INSERT INTO inventory_events
        (id, household_id, inventory_item_id, event_type, quantity_delta, unit, reason, metadata, created_at, command_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), scope.householdId, plan.after.id,
        command.type === 'CREATE' ? 'ADD' : command.type === 'DISCARD' ? 'DISCARD' : 'MANUAL_UPDATE',
        exactLegacyQuantity(plan.deltaMilli, plan.after.canonicalUnit), plan.after.canonicalUnit,
        'reason' in command ? command.reason ?? null : null, JSON.stringify(metadata), now, result.commandId),
      writeGuard(db, scope, 'inventory_item_id'));
    }
    assertResults(await db.batch(statements));
    return { result, replayed: false };
  } catch (error) {
    const receipt = await readReceipt(db, scope, key.data);
    if (receipt) return replay(receipt, fingerprint);
    if (error instanceof LotCommandError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (/NOT NULL constraint failed: inventory_events\.quantity_delta/i.test(message)) throw new LotCommandError('STALE_SNAPSHOT');
    if (/NOT NULL constraint failed: inventory_events\.(unit|event_type)/i.test(message)) throw new LotCommandError('STALE_VERSION');
    throw new LotCommandError('PERSISTENCE_FAILED');
  }
}
