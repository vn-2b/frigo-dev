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
import {
  MAX_FEFO_EFFECTS, MAX_FEFO_RECEIPT_BYTES, MAX_FEFO_SNAPSHOT_LOTS,
  compareFefoLots, parseInventoryFefoCommand, planInventoryFefo,
  type InventoryFefoCommand,
} from '../../domain/src/inventory-fefo';

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
export interface StoredLotCommandReceipt {
  command: InventoryLotCommand;
  execution: InventoryLotCommandExecution;
}

interface IngredientRow { id: string; category: string }
interface ProjectionRow extends LegacyInventoryRow {
  added_date: string; category: string; data_source: string; freshness: string;
}
interface MappedLot { lot: InventoryLot; legacyItemId: string | null }
interface MappedLotSnapshot {
  inventoryVersion: number;
  activationCommandId: string | null;
  householdCreatedAt: string;
  householdUpdatedAt: string;
  lots: MappedLot[];
  legacyRows: ProjectionRow[];
  locations: StorageLocation[];
  ingredients: IngredientRow[];
}
type LotRow = Omit<InventoryLot, 'purchasePrice'> & {
  legacyItemId: string | null; currency: string | null; amountMinor: number | null; minorDigits: number | null;
};
type LocationRow = Omit<StorageLocation, 'isDefault'> & { isDefault: number };
interface ReceiptEventRow {
  household_id: string; inventory_item_id: string; command_id: string; event_type: string;
  quantity_delta: number; unit: string; reason: string | null; metadata: string; created_at: string;
}
interface ReceiptRow {
  id: string; household_id: string; actor_id: string; client_key: string;
  command_type: string; created_at: string; fingerprint: string; result_json: string;
  events: ReceiptEventRow[];
}
const ReceiptResult = z.object({
  commandId: Identity,
  commandType: z.enum(['CREATE', 'USE', 'DISCARD', 'OPEN', 'MOVE', 'CORRECT']),
  lotId: Identity,
  version: z.number().int().safe().positive(),
  effects: z.array(z.object({
    before: InventoryLotSchema.nullable(), after: InventoryLotSchema,
    changed: z.literal(true), deltaMilli: z.number().int().safe(),
  }).strict()).max(1),
}).strict();

export const MEMBERSHIP = `EXISTS (SELECT 1 FROM household_members m JOIN users u ON u.id = m.user_id
  WHERE m.household_id = households.id AND u.id = ?)`;
export function authorizedHousehold(db: D1DatabaseBinding, scope: InventoryLotCommandScope) {
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
  } catch (error) {
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
export async function readMappedLotSnapshot(db: D1DatabaseBinding, input: InventoryLotCommandScope,
  fefoIngredientId?: string, bounded = false): Promise<MappedLotSnapshot> {
  const scope = parseScope(input);
  const bound = fefoIngredientId !== undefined || bounded ? ` LIMIT ${MAX_FEFO_SNAPSHOT_LOTS + 1}` : '';
  const results = await readBatch(db, [
    db.prepare(`SELECT inventory_version AS inventoryVersion, created_at AS createdAt, updated_at AS updatedAt
      FROM households WHERE id = ? AND ${MEMBERSHIP}`).bind(scope.householdId, scope.actorId),
    db.prepare(`SELECT id FROM inventory_adoption_receipts WHERE household_id = ?`).bind(scope.householdId),
    db.prepare(`SELECT id, household_id, ingredient_id, name, quantity, unit, storage, expiry_date,
      opened_at, expiry_kind, expiry_source, version, created_at, updated_at, added_date, category,
      data_source, freshness FROM inventory_items WHERE household_id = ? ORDER BY id${bound}`).bind(scope.householdId),
    db.prepare(`SELECT id, household_id AS householdId, ingredient_id AS ingredientId, raw_name AS rawName,
      quantity_milli AS quantityMilli, canonical_unit AS canonicalUnit, storage_location_id AS storageLocationId,
      state, purchased_at AS purchasedAt, opened_at AS openedAt, expiry_at AS expiryAt,
      estimated_expiry_at AS estimatedExpiryAt, expiry_kind AS expiryKind, source_type AS sourceType,
      source_id AS sourceId, version, created_at AS createdAt, updated_at AS updatedAt,
      currency, amount_minor AS amountMinor, minor_digits AS minorDigits, legacy_expiry_at AS legacyExpiryAt,
      legacy_expiry_kind AS legacyExpiryKind, legacy_expiry_source AS legacyExpirySource,
      legacy_opened_at AS legacyOpenedAt, legacy_version AS legacyVersion, legacy_item_id AS legacyItemId
      FROM inventory_lots WHERE household_id = ? ORDER BY id${bound}`).bind(scope.householdId),
    db.prepare(`SELECT id, household_id AS householdId, type, name, sort_order AS sortOrder,
      is_default AS isDefault, created_at AS createdAt, updated_at AS updatedAt
      FROM storage_locations WHERE household_id = ? ORDER BY sort_order, id${bound}`).bind(scope.householdId),
    fefoIngredientId === undefined ? db.prepare('SELECT id, category FROM ingredients ORDER BY id')
      : db.prepare('SELECT id, category FROM ingredients WHERE id = ?').bind(fefoIngredientId),
  ]);
  const authorization = results[0].results[0] as
    { inventoryVersion: number; createdAt: string; updatedAt: string } | undefined;
  if (!authorization) throw new LotCommandError('FORBIDDEN');
  const inventoryVersion = readAuthorization(results[0]);
  if ((fefoIngredientId !== undefined || bounded)
    && results.slice(2, 5).some(({ results: rows }) => rows.length > MAX_FEFO_SNAPSHOT_LOTS)) {
    throw new LotCommandError('FEFO_LIMIT_EXCEEDED');
  }
  try {
    return {
      inventoryVersion,
      activationCommandId: (results[1].results[0] as { id: string } | undefined)?.id ?? null,
      householdCreatedAt: authorization.createdAt,
      householdUpdatedAt: authorization.updatedAt,
      legacyRows: results[2].results as ProjectionRow[],
      lots: (results[3].results as LotRow[]).map((row) => {
        const { currency, amountMinor, minorDigits, legacyItemId, ...lot } = row;
        return { legacyItemId, lot: InventoryLotSchema.parse({
          ...lot, purchasePrice: currency === null && amountMinor === null && minorDigits === null
            ? null : { currency, amountMinor, minorDigits },
        }) };
      }),
      locations: (results[4].results as LocationRow[]).map((row) => {
        if (row.isDefault !== 0 && row.isDefault !== 1) throw new Error('Invalid location');
        return StorageLocationSchema.parse({ ...row, isDefault: row.isDefault === 1 });
      }),
      ingredients: results[5].results as IngredientRow[],
    };
  } catch (error) {
    if (error instanceof LotCommandError) throw error;
    throw new LotCommandError('DRIFT_DETECTED');
  }
}

export function sortedJson(value: unknown): string {
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

function boundedAuthorityJson(column: string, maxBytes = MAX_FEFO_RECEIPT_BYTES): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${maxBytes}
    THEN CASE WHEN json_valid(${column}) = 1 THEN CASE WHEN NOT EXISTS (
      SELECT fullkey FROM json_tree(${column}) GROUP BY fullkey HAVING count(*) > 1
    ) THEN ${column} ELSE '' END ELSE '' END ELSE '' END`;
}
async function readReceipt(db: D1DatabaseBinding, scope: InventoryLotCommandScope, key: string,
  bounded = false): Promise<ReceiptRow | undefined> {
  const receiptJson = bounded
    ? `${boundedAuthorityJson('result_json')} AS result_json`
    : 'result_json';
  const metadata = bounded
    ? `${boundedAuthorityJson('e.metadata')} AS metadata`
    : 'e.metadata';
  const storedFingerprint = bounded
    ? `${boundedAuthorityJson('fingerprint', 16384)} AS fingerprint` : 'fingerprint';
  const results = await readBatch(db, [
    authorizedHousehold(db, scope),
    db.prepare(`SELECT ${storedFingerprint}, ${receiptJson}, id, household_id, actor_id, client_key, command_type, created_at
      FROM inventory_commands WHERE household_id = ? AND client_key = ?`)
      .bind(scope.householdId, key),
    db.prepare(`SELECT e.household_id, e.inventory_item_id, e.command_id, e.event_type, e.quantity_delta,
      e.unit, e.reason, ${metadata}, e.created_at FROM inventory_events e
      JOIN inventory_commands c ON c.id = e.command_id WHERE c.household_id = ? AND c.client_key = ? ORDER BY e.id${bounded ? ` LIMIT ${MAX_FEFO_EFFECTS + 1}` : ''}`)
      .bind(scope.householdId, key),
  ]);
  readAuthorization(results[0]);
  const row = results[1].results[0] as Omit<ReceiptRow, 'events'> | undefined;
  return row ? { ...row, events: results[2].results as ReceiptEventRow[] } : undefined;
}
function eventMetadata(scope: InventoryLotCommandScope, key: string, fingerprint: string,
  result: InventoryLotCommandResult, plan: SingleLotCommandPlan, now: string) {
  return {
    schemaVersion: 1, householdId: scope.householdId, actorId: scope.actorId, commandId: result.commandId,
    commandType: result.commandType, before: plan.before, after: plan.after, deltaMilli: plan.deltaMilli,
    source: { type: plan.after.sourceType, id: plan.after.sourceId }, timestamp: now,
    clientKey: key, fingerprint,
    allocation: [{ lotId: plan.after.id, deltaMilli: plan.deltaMilli, canonicalUnit: plan.after.canonicalUnit }],
  };
}
function legacyEventType(command: InventoryLotCommand): string {
  return command.type === 'CREATE' ? 'ADD' : command.type === 'DISCARD' ? 'DISCARD' : 'MANUAL_UPDATE';
}
function replay(receipt: ReceiptRow, fingerprint: string, scope: InventoryLotCommandScope,
  key: string, command: InventoryLotCommand): InventoryLotCommandExecution {
  if (receipt.fingerprint !== fingerprint) throw new LotCommandError('IDEMPOTENCY_CONFLICT');
  try {
    const result = ReceiptResult.parse(JSON.parse(receipt.result_json));
    const valid = (condition: boolean) => { if (!condition) throw new Error('Invalid receipt evidence'); };
    valid(receipt.household_id === scope.householdId && receipt.actor_id === scope.actorId
      && receipt.client_key === key && receipt.command_type === command.type
      && result.commandType === command.type && result.commandId === receipt.id && result.lotId === command.lotId);
    valid(receipt.events.length === result.effects.length);
    if (result.effects.length === 0) {
      valid(command.type !== 'CREATE' && command.type !== 'USE' && command.type !== 'DISCARD'
        && result.version === command.expectedVersion);
    }
    for (const plan of result.effects) {
      const { before, after, deltaMilli } = plan;
      valid(after.id === result.lotId && after.householdId === scope.householdId && after.version === result.version
        && after.updatedAt === receipt.created_at
        && (after.state === 'ACTIVE' ? after.quantityMilli > 0 : after.quantityMilli === 0)
        && deltaMilli === after.quantityMilli - (before?.quantityMilli ?? 0));
      if (command.type === 'CREATE') {
        valid(before === null && after.version === 1 && after.legacyVersion === 1 && after.createdAt === receipt.created_at);
        const quantity = toLotQuantity(command.quantity, command.unit);
        valid(after.quantityMilli === quantity.quantityMilli && after.canonicalUnit === quantity.canonicalUnit);
        const declared = ['ingredientId', 'rawName', 'storageLocationId', 'expiryAt', 'estimatedExpiryAt', 'expiryKind',
          'purchasedAt', 'openedAt', 'purchasePrice', 'sourceType', 'sourceId'] as const;
        valid(declared.every((field) => sortedJson(after[field]) === sortedJson(command[field])));
      } else {
        valid(before !== null);
        if (before === null) throw new Error('Missing prior lot');
        valid(before.id === after.id && before.householdId === scope.householdId && before.version === command.expectedVersion
          && after.version === before.version + 1 && before.legacyVersion !== null && after.legacyVersion === before.legacyVersion + 1);
        const preserved = ['canonicalUnit', 'sourceType', 'sourceId', 'createdAt', 'legacyExpiryAt',
          'legacyExpiryKind', 'legacyExpirySource', 'legacyOpenedAt'] as const;
        valid(preserved.every((field) => before[field] === after[field]));
        if (command.type === 'USE' || command.type === 'DISCARD') {
          const quantity = toLotQuantity(command.quantity, command.unit);
          valid(quantity.canonicalUnit === after.canonicalUnit && deltaMilli === -quantity.quantityMilli
            && (after.quantityMilli > 0 || after.state === (command.type === 'USE' ? 'CONSUMED' : 'DISCARDED')));
        }
        if (command.type === 'OPEN') valid(before.openedAt === null && after.openedAt === command.openedAt && deltaMilli === 0);
        if (command.type === 'MOVE') valid(after.storageLocationId === command.storageLocationId && deltaMilli === 0);
        if (command.type === 'CORRECT') {
          const { quantity, unit, ...changes } = command.changes;
          valid(Object.entries(changes).every(([field, value]) => value === undefined
            || sortedJson(after[field as keyof InventoryLot]) === sortedJson(value)));
          if (quantity !== undefined) {
            const corrected = toLotQuantity(quantity, unit ?? before.canonicalUnit);
            valid(after.quantityMilli === corrected.quantityMilli && after.canonicalUnit === corrected.canonicalUnit
              && (after.quantityMilli > 0 || after.state === command.terminalState));
          } else valid(deltaMilli === 0);
        }
      }
      const event = receipt.events[0];
      valid(event.household_id === scope.householdId && event.command_id === receipt.id && event.inventory_item_id === after.id
        && event.event_type === legacyEventType(command) && event.quantity_delta === exactLegacyQuantity(deltaMilli, after.canonicalUnit)
        && event.unit === after.canonicalUnit && event.created_at === receipt.created_at
        && event.reason === ('reason' in command ? command.reason ?? null : null)
        && sortedJson(JSON.parse(event.metadata)) === sortedJson(eventMetadata(scope, key, fingerprint, result, plan, receipt.created_at)));
    }
    return { result, replayed: true };
  } catch {
    throw new LotCommandError('CORRUPT_RECEIPT');
  }
}

function exactLegacyQuantity(milli: number, unit: InventoryLot['canonicalUnit']): number {
  const quantity = milli / 1000;
  try {
    if (toLotQuantity(Math.abs(quantity), unit).quantityMilli === Math.abs(milli)) return quantity;
  } catch { /* Reject lossy REAL compatibility projections. */ }
  throw new LotCommandError('UNREPRESENTABLE_QUANTITY');
}
export function expiryProjection(lot: InventoryLot) {
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
  // Mapped LEGACY_BACKFILL provenance is legitimate after receipt-backed adoption;
  // the executor admission check owns that evidence, not this row comparison.
  if (legacyItemId === null) throw new LotCommandError('ADOPTION_REQUIRED');
  const row = snapshot.legacyRows.find((row) => row.id === legacyItemId);
  const location = snapshot.locations.find((location) => location.id === lot.storageLocationId);
  const expiry = expiryProjection(lot);
  const historicalUnknown = lot.expiryKind === 'UNKNOWN' && row?.expiry_date === lot.legacyExpiryAt;
  // Adopted households keep legacy kg/l display units; only those exact
  // aliases reconcile to the lot's canonical unit. Anything else is drift.
  let quantityMatches = false;
  try {
    const displayUnit = row?.unit === 'kg' ? 'g' : row?.unit === 'l' ? 'ml' : row?.unit;
    quantityMatches = row !== undefined && displayUnit === lot.canonicalUnit
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

export type PreparedLotCommand =
  | { kind: 'replay'; clientKey: string; command: InventoryLotCommand; fingerprint: string;
      execution: InventoryLotCommandExecution }
  | { kind: 'prepared'; clientKey: string; command: InventoryLotCommand; fingerprint: string;
      result: InventoryLotCommandResult; statements: D1PreparedStatement[] };

// Adoption evidence: every legacy row must be mapped, and backfill provenance
// requires receipt-backed activation before native commands may run.
function assertAdoptionAdmission(snapshot: MappedLotSnapshot): void {
  const representedRows = new Set(snapshot.lots.map(({ legacyItemId }) => legacyItemId));
  if (snapshot.lots.some(({ legacyItemId }) => legacyItemId === null)
    || snapshot.legacyRows.some(({ id }) => !representedRows.has(id))) {
    throw new LotCommandError('ADOPTION_REQUIRED');
  }
  if (snapshot.activationCommandId === null
    && snapshot.lots.some(({ lot }) => lot.sourceType === 'LEGACY_BACKFILL')) {
    throw new LotCommandError('ADOPTION_REQUIRED');
  }
}

function requireParsableLotCommand(clientKey: string, input: unknown): void {
  if (!ClientKey.safeParse(clientKey).success || !InventoryLotCommandSchema.safeParse(input).success) {
    throw new LotCommandError('INVALID_COMMAND');
  }
}

// Plans one canonical command against the given snapshot without executing.
export async function prepareInventoryLotCommand(db: D1DatabaseBinding, scope: InventoryLotCommandScope,
  clientKey: string, input: unknown, now: string, snapshot: MappedLotSnapshot,
  skipHouseholdVersionCas = false): Promise<PreparedLotCommand> {
  const key = ClientKey.safeParse(clientKey);
  const parsed = InventoryLotCommandSchema.safeParse(input);
  if (!key.success || !parsed.success) throw new LotCommandError('INVALID_COMMAND');
  const command = parsed.data;
  const fingerprint = sortedJson({ ...scope, command });
  const prior = await readReceipt(db, scope, key.data);
  if (prior) {
    return { kind: 'replay', clientKey: key.data, command, fingerprint, execution: replay(prior, fingerprint, scope, key.data, command) };
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
  ];
  if (!skipHouseholdVersionCas) {
    statements.push(
      db.prepare(`UPDATE households SET inventory_version = inventory_version WHERE id = ? AND inventory_version = ? AND ${MEMBERSHIP}`)
        .bind(scope.householdId, snapshot.inventoryVersion, scope.actorId),
      writeGuard(db, scope, 'quantity_delta'),
    );
  }
  if (plan.changed) {
    statements.push(projectionWrites(db, plan, row, snapshot, now), writeGuard(db, scope, 'unit'),
      lotWrite(db, plan), writeGuard(db, scope, 'event_type'));
    const metadata = eventMetadata(scope, key.data, fingerprint, result, plan, now);
    statements.push(db.prepare(`INSERT INTO inventory_events
      (id, household_id, inventory_item_id, event_type, quantity_delta, unit, reason, metadata, created_at, command_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), scope.householdId, plan.after.id,
      legacyEventType(command),
      exactLegacyQuantity(plan.deltaMilli, plan.after.canonicalUnit), plan.after.canonicalUnit,
      'reason' in command ? command.reason ?? null : null, JSON.stringify(metadata), now, result.commandId),
    writeGuard(db, scope, 'inventory_item_id'));
  }
  return { kind: 'prepared', clientKey: key.data, command, fingerprint, result, statements };
}

// Adapter retry boundary: replays the committed receipt stored under this key.
// The stored fingerprint carries the original canonical command, so a retry
// after response loss returns the committed result without re-deriving state.
export async function replayLotCommandReceipt(db: D1DatabaseBinding, scope: InventoryLotCommandScope,
  clientKey: string): Promise<InventoryLotCommandExecution | undefined> {
  return (await readLotCommandReceipt(db, scope, clientKey))?.execution;
}

// Adapters that retain a legacy request contract may need the original command
// to verify an idempotency-key retry before a stale legacy version is rejected.
export async function readLotCommandReceipt(db: D1DatabaseBinding, scope: InventoryLotCommandScope,
  clientKey: string): Promise<StoredLotCommandReceipt | undefined> {
  const key = ClientKey.safeParse(clientKey);
  if (!key.success) return undefined;
  const receipt = await readReceipt(db, scope, key.data);
  if (!receipt) return undefined;
  const stored = InventoryLotCommandSchema.safeParse(
    (JSON.parse(receipt.fingerprint) as { command?: unknown }).command);
  if (!stored.success) throw new LotCommandError('CORRUPT_RECEIPT');
  return { command: stored.data, execution: replay(receipt, receipt.fingerprint, scope, key.data, stored.data) };
}

// Adapter boundary: one authoritative read plus the adoption evidence check,
// so route adapters cannot plan native commands against incomplete mappings.
export async function readAdoptedLotSnapshot(db: D1DatabaseBinding,
  inputScope: InventoryLotCommandScope): Promise<MappedLotSnapshot> {
  const scope = parseScope(inputScope);
  const snapshot = await readMappedLotSnapshot(db, scope, undefined, true);
  assertAdoptionAdmission(snapshot);
  return snapshot;
}

export function classifyLotCommandBatchFailure(error: unknown): LotCommandError {
  if (error instanceof LotCommandError) return error;
  const message = error instanceof Error ? error.message : '';
  if (/NOT NULL constraint failed: inventory_events\.quantity_delta/i.test(message)) return new LotCommandError('STALE_SNAPSHOT');
  if (/NOT NULL constraint failed: inventory_events\.(unit|event_type)/i.test(message)) return new LotCommandError('STALE_VERSION');
  return new LotCommandError('PERSISTENCE_FAILED');
}

// After a failed batch: replay committed twins, or classify the failure.
export async function recoverLotCommandFailure(db: D1DatabaseBinding, scope: InventoryLotCommandScope,
  clientKey: string, input: unknown, fingerprint: string, error: unknown): Promise<InventoryLotCommandExecution> {
  const key = ClientKey.safeParse(clientKey);
  const parsed = InventoryLotCommandSchema.safeParse(input);
  if (key.success && parsed.success) {
    const receipt = await readReceipt(db, scope, key.data);
    if (receipt) return replay(receipt, fingerprint, scope, key.data, parsed.data);
  }
  throw classifyLotCommandBatchFailure(error);
}

export async function executeInventoryLotCommand(db: D1DatabaseBinding, inputScope: InventoryLotCommandScope,
  clientKey: string, input: unknown, now = new Date().toISOString()): Promise<InventoryLotCommandExecution> {
  const scope = parseScope(inputScope);
  readAuthorization((await readBatch(db, [authorizedHousehold(db, scope)]))[0]);
  // Preserve INVALID_COMMAND precedence over snapshot reads and admission.
  requireParsableLotCommand(clientKey, input);
  const snapshot = await readMappedLotSnapshot(db, scope);
  assertAdoptionAdmission(snapshot);
  const prepared = await prepareInventoryLotCommand(db, scope, clientKey, input, now, snapshot);
  if (prepared.kind === 'replay') return prepared.execution;
  try {
    assertResults(await db.batch(prepared.statements));
    return { result: prepared.result, replayed: false };
  } catch (error) {
    return recoverLotCommandFailure(db, scope, clientKey, input, prepared.fingerprint, error);
  }
}

export type InventoryFefoCommandResult = z.infer<typeof FefoReceiptResult>;
export interface InventoryFefoCommandExecution { result: InventoryFefoCommandResult; replayed: boolean }
type FefoPlan = InventoryFefoCommandResult['effects'][number];
const FefoEffect = z.object({
  ordinal: z.number().int().nonnegative().max(MAX_FEFO_EFFECTS - 1),
  legacyItemId: Identity,
  before: InventoryLotSchema,
  after: InventoryLotSchema,
  changed: z.literal(true),
  deltaMilli: z.number().int().safe().negative(),
}).strict();
const FefoReceiptResult = z.object({
  schemaVersion: z.literal(2), commandId: Identity, commandType: z.literal('USE'), mode: z.literal('FEFO'),
  ingredientId: Identity, quantityMilli: z.number().int().safe().positive(),
  canonicalUnit: z.enum(['g', 'ml', 'piece']),
  effects: z.array(FefoEffect).min(1).max(MAX_FEFO_EFFECTS),
}).strict();
const StoredFingerprint = Scope.extend({
  command: z.union([InventoryLotCommandSchema, z.object({
    type: z.literal('USE'), mode: z.literal('FEFO'), ingredientId: Identity.refine((value) => value.length <= 200),
    quantityMilli: z.number().int().safe().positive(), canonicalUnit: z.enum(['g', 'ml', 'piece']),
    reason: z.string().max(1000).refine((value) => value.trim().length > 0 && !value.includes('\0')).optional(),
    expectedInventoryVersion: z.number().int().safe().positive().optional(),
  }).strict()]),
}).strict();

function fefoEventMetadata(scope: InventoryLotCommandScope, key: string, fingerprint: string,
  result: InventoryFefoCommandResult, effect: FefoPlan, now: string) {
  return {
    ...eventMetadata(scope, key, fingerprint, {
      commandId: result.commandId, commandType: 'USE', lotId: effect.after.id,
      version: effect.after.version, effects: [effect],
    }, effect, now),
    schemaVersion: 2, mode: 'FEFO', ordinal: effect.ordinal, effectCount: result.effects.length,
  };
}

function replayFefo(receipt: ReceiptRow, fingerprint: string, scope: InventoryLotCommandScope,
  key: string, command: InventoryFefoCommand): InventoryFefoCommandExecution {
  try {
    const retained = StoredFingerprint.parse(JSON.parse(receipt.fingerprint));
    if (retained.householdId !== receipt.household_id || retained.actorId !== receipt.actor_id
      || retained.command.type !== receipt.command_type) throw new Error('Misbound fingerprint');
    const storedResult = JSON.parse(receipt.result_json);
    if ('mode' in retained.command && retained.command.mode === 'FEFO') {
      FefoReceiptResult.parse(storedResult);
    } else {
      ReceiptResult.parse(storedResult);
    }
  } catch {
    throw new LotCommandError('CORRUPT_RECEIPT');
  }
  if (receipt.fingerprint !== fingerprint) throw new LotCommandError('IDEMPOTENCY_CONFLICT');
  try {
    const result = FefoReceiptResult.parse(JSON.parse(receipt.result_json));
    const valid = (condition: boolean) => { if (!condition) throw new Error('Invalid FEFO evidence'); };
    valid(receipt.household_id === scope.householdId && receipt.actor_id === scope.actorId
      && receipt.client_key === key && receipt.command_type === 'USE' && result.commandId === receipt.id
      && result.ingredientId === command.ingredientId && result.canonicalUnit === command.canonicalUnit
      && result.quantityMilli === command.quantityMilli && result.effects.length === receipt.events.length);
    const seen = new Set<string>();
    let remaining = command.quantityMilli;
    for (const [ordinal, effect] of result.effects.entries()) {
      const { before, after, deltaMilli } = effect;
      valid(effect.ordinal === ordinal && !seen.has(after.id) && effect.legacyItemId === after.id
        && before.id === after.id && before.householdId === scope.householdId
        && before.ingredientId === command.ingredientId && before.canonicalUnit === command.canonicalUnit
        && before.state === 'ACTIVE' && before.quantityMilli > 0
        && before.legacyVersion !== null && Number.isSafeInteger(before.legacyVersion + 1)
        && Number.isSafeInteger(before.version + 1) && remaining > 0
        && deltaMilli === -Math.min(remaining, before.quantityMilli));
      if (ordinal > 0) valid(compareFefoLots(result.effects[ordinal - 1].before, before) < 0);
      seen.add(after.id);
      const quantityMilli = before.quantityMilli + deltaMilli;
      valid(sortedJson(after) === sortedJson({
        ...before, quantityMilli, state: quantityMilli === 0 ? 'CONSUMED' : 'ACTIVE',
        version: before.version + 1, legacyVersion: before.legacyVersion! + 1, updatedAt: receipt.created_at,
      }));
      const events = receipt.events.filter((event) => event.inventory_item_id === effect.legacyItemId);
      valid(events.length === 1);
      const event = events[0];
      valid(event.household_id === scope.householdId && event.command_id === receipt.id
        && event.event_type === 'MANUAL_UPDATE' && event.unit === command.canonicalUnit
        && event.quantity_delta === exactLegacyQuantity(deltaMilli, command.canonicalUnit)
        && event.reason === (command.reason ?? null) && event.created_at === receipt.created_at
        && sortedJson(JSON.parse(event.metadata)) === sortedJson(fefoEventMetadata(scope, key, fingerprint, result, effect, receipt.created_at)));
      remaining += deltaMilli;
    }
    valid(remaining === 0);
    return { result, replayed: true };
  } catch {
    throw new LotCommandError('CORRUPT_RECEIPT');
  }
}

function fefoCompletionFence(db: D1DatabaseBinding, scope: InventoryLotCommandScope, result: InventoryFefoCommandResult) {
  const fields: Record<string, string> = {
    id: 'id', householdId: 'household_id', ingredientId: 'ingredient_id', rawName: 'raw_name',
    quantityMilli: 'quantity_milli', canonicalUnit: 'canonical_unit', storageLocationId: 'storage_location_id',
    state: 'state', purchasedAt: 'purchased_at', openedAt: 'opened_at', expiryAt: 'expiry_at',
    estimatedExpiryAt: 'estimated_expiry_at', expiryKind: 'expiry_kind', sourceType: 'source_type', sourceId: 'source_id',
    version: 'version', legacyVersion: 'legacy_version', createdAt: 'created_at', updatedAt: 'updated_at',
    'purchasePrice.currency': 'currency', 'purchasePrice.amountMinor': 'amount_minor', 'purchasePrice.minorDigits': 'minor_digits',
    legacyExpiryAt: 'legacy_expiry_at', legacyExpiryKind: 'legacy_expiry_kind', legacyExpirySource: 'legacy_expiry_source',
    legacyOpenedAt: 'legacy_opened_at',
  };
  const matches = Object.entries(fields).map(([field, column]) =>
    `json_extract(e.value, '$.after.${field}') IS l.${column}`).join(' AND ');
  return db.prepare(`UPDATE households SET inventory_version = inventory_version WHERE id = ?
    AND EXISTS (SELECT 1 FROM inventory_commands c WHERE c.id = ? AND c.household_id = households.id
      AND NOT EXISTS (SELECT fullkey, type, atom FROM json_tree(c.result_json)
        EXCEPT SELECT fullkey, type, atom FROM json_tree(?))
      AND NOT EXISTS (SELECT fullkey, type, atom FROM json_tree(?)
        EXCEPT SELECT fullkey, type, atom FROM json_tree(c.result_json)))
    AND (SELECT count(*) FROM inventory_events WHERE command_id = ?) = ?
    AND (SELECT count(*) FROM json_each(?, '$.effects') e
      JOIN inventory_lots l ON l.id = json_extract(e.value, '$.after.id') AND l.household_id = households.id
      JOIN inventory_items i ON i.id = l.legacy_item_id AND i.household_id = l.household_id
      JOIN storage_locations s ON s.id = l.storage_location_id AND s.household_id = l.household_id
      JOIN inventory_events v ON v.command_id = ? AND v.inventory_item_id = i.id
      WHERE ${matches} AND i.id = json_extract(e.value, '$.legacyItemId')
        AND i.quantity = l.quantity_milli / 1000.0 AND i.unit = l.canonical_unit
        AND i.version = l.legacy_version AND i.name = l.raw_name AND i.ingredient_id IS l.ingredient_id
        AND i.storage = lower(s.type) AND (l.quantity_milli > 0 OR i.freshness = 'out_of_stock')) = ?`)
    .bind(scope.householdId, result.commandId, JSON.stringify(result), JSON.stringify(result),
      result.commandId, result.effects.length, JSON.stringify(result), result.commandId, result.effects.length);
}

// One batch owns the logical allocation; no single-lot executor is called here.
export type PreparedFefoCommand =
  | { kind: 'replay'; clientKey: string; command: InventoryFefoCommand; fingerprint: string;
      execution: InventoryFefoCommandExecution }
  | { kind: 'prepared'; clientKey: string; command: InventoryFefoCommand; fingerprint: string;
      result: InventoryFefoCommandResult; statements: D1PreparedStatement[] };

// Plans one canonical FEFO allocation against the given snapshot without executing.
export async function prepareInventoryFefoCommand(db: D1DatabaseBinding, scope: InventoryLotCommandScope,
  clientKey: string, input: unknown, now: string, snapshot: MappedLotSnapshot,
  skipHouseholdVersionCas = false): Promise<PreparedFefoCommand> {
  const key = ClientKey.safeParse(clientKey);
  if (!key.success) throw new LotCommandError('INVALID_COMMAND');
  const command = parseInventoryFefoCommand(input);
  const fingerprint = sortedJson({ ...scope, command });
  const prior = await readReceipt(db, scope, key.data, true);
  if (prior) {
    return { kind: 'replay', clientKey: key.data, command, fingerprint, execution: replayFefo(prior, fingerprint, scope, key.data, command) };
  }
  if (command.expectedInventoryVersion !== undefined && command.expectedInventoryVersion !== snapshot.inventoryVersion) {
    throw new LotCommandError('STALE_SNAPSHOT');
  }
  const plans = planInventoryFefo(command, snapshot.lots.map(({ lot }) => lot), {
    householdId: scope.householdId, now, locations: snapshot.locations, ingredientIds: snapshot.ingredients.map(({ id }) => id),
  });
  const rows: ProjectionRow[] = [];
  const effects = plans.map((plan, ordinal): FefoPlan => {
    const mapped = snapshot.lots.find(({ lot }) => lot.id === plan.after.id)!;
    const row = requireParity(mapped, snapshot, scope.householdId);
    if (row.version === Number.MAX_SAFE_INTEGER) throw new LotCommandError('VERSION_OVERFLOW');
    rows.push(row);
    const after = { ...plan.after, legacyVersion: row.version + 1 };
    exactLegacyQuantity(after.quantityMilli, after.canonicalUnit);
    exactLegacyQuantity(plan.deltaMilli, after.canonicalUnit);
    return { ...plan, before: plan.before!, after, changed: true, ordinal, legacyItemId: row.id };
  });
  const result = FefoReceiptResult.parse({
    schemaVersion: 2, commandId: crypto.randomUUID(), commandType: 'USE', mode: 'FEFO',
    ingredientId: command.ingredientId, quantityMilli: command.quantityMilli, canonicalUnit: command.canonicalUnit, effects,
  });
  const resultJson = JSON.stringify(result);
  if (new TextEncoder().encode(resultJson).length > MAX_FEFO_RECEIPT_BYTES) throw new LotCommandError('FEFO_LIMIT_EXCEEDED');
  const statements = [
    db.prepare(`INSERT INTO inventory_commands (id, household_id, actor_id, client_key, fingerprint, command_type, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(result.commandId, scope.householdId, scope.actorId, key.data,
      fingerprint, 'USE', resultJson, now),
    writeGuard(db, scope, 'inventory_item_id'),
  ];
  if (!skipHouseholdVersionCas) {
    statements.unshift(
      db.prepare(`UPDATE households SET inventory_version = inventory_version WHERE id = ? AND inventory_version = ? AND ${MEMBERSHIP}`)
        .bind(scope.householdId, snapshot.inventoryVersion, scope.actorId),
      writeGuard(db, scope, 'quantity_delta'),
    );
  }
  for (const effect of effects) {
    statements.push(projectionWrites(db, effect, rows[effect.ordinal], snapshot, now), writeGuard(db, scope, 'unit'),
      lotWrite(db, effect), writeGuard(db, scope, 'event_type'));
  }
  for (const effect of effects) {
    const metadata = JSON.stringify(fefoEventMetadata(scope, key.data, fingerprint, result, effect, now));
    if (new TextEncoder().encode(metadata).length > MAX_FEFO_RECEIPT_BYTES) throw new LotCommandError('FEFO_LIMIT_EXCEEDED');
    statements.push(db.prepare(`INSERT INTO inventory_events
      (id, household_id, inventory_item_id, event_type, quantity_delta, unit, reason, metadata, created_at, command_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), scope.householdId, effect.legacyItemId,
      'MANUAL_UPDATE', exactLegacyQuantity(effect.deltaMilli, effect.after.canonicalUnit), effect.after.canonicalUnit,
      command.reason ?? null, metadata, now, result.commandId), writeGuard(db, scope, 'inventory_item_id'));
  }
  statements.push(fefoCompletionFence(db, scope, result), writeGuard(db, scope, 'inventory_item_id'));
  return { kind: 'prepared', clientKey: key.data, command, fingerprint, result, statements };
}

export async function recoverFefoCommandFailure(db: D1DatabaseBinding, scope: InventoryLotCommandScope,
  clientKey: string, input: unknown, fingerprint: string, error: unknown): Promise<InventoryFefoCommandExecution> {
  const key = ClientKey.safeParse(clientKey);
  if (key.success) {
    // Replay evidence is authoritative: its conflicts (FORBIDDEN membership,
    // changed payload, corruption) propagate instead of masking the failure.
    const command = parseInventoryFefoCommand(input);
    const receipt = await readReceipt(db, scope, key.data, true);
    if (receipt) return replayFefo(receipt, fingerprint, scope, key.data, command);
  }
  throw classifyLotCommandBatchFailure(error);
}

// One batch owns the logical allocation; no single-lot executor is called here.
export async function executeInventoryFefoCommand(db: D1DatabaseBinding, inputScope: InventoryLotCommandScope,
  clientKey: string, input: unknown, now = new Date().toISOString()): Promise<InventoryFefoCommandExecution> {
  const scope = parseScope(inputScope);
  readAuthorization((await readBatch(db, [authorizedHousehold(db, scope)]))[0]);
  const snapshot = await readMappedLotSnapshot(db, scope, parseInventoryFefoCommand(input).ingredientId);
  assertAdoptionAdmission(snapshot);
  const prepared = await prepareInventoryFefoCommand(db, scope, clientKey, input, now, snapshot);
  if (prepared.kind === 'replay') return prepared.execution;
  try {
    assertResults(await db.batch(prepared.statements));
    return { result: prepared.result, replayed: false };
  } catch (error) {
    return recoverFefoCommandFailure(db, scope, clientKey, input, prepared.fingerprint, error);
  }
}

// ---------------------------------------------------------------------------
// Composed route adapters: several canonical commands share one snapshot and
// one atomic batch, with route-specific statements appended by the caller.
// ---------------------------------------------------------------------------

export interface LotCommandSpec {
  clientKey: string;
  input: unknown;
  // Multi-command intents (edit+move) plan against the shared snapshot: the
  // composition injects the current advanced lot version as expectedVersion.
  useCurrentLotVersion?: { lotId: string };
}
export type PreparedAnyLotCommand = PreparedLotCommand | PreparedFefoCommand;
export type AnyLotCommandResult = InventoryLotCommandResult | InventoryFefoCommandResult;
export interface ComposedLotCommands {
  snapshot: MappedLotSnapshot;
  prepared: PreparedAnyLotCommand[];
  statements: D1PreparedStatement[];
}

function advanceSnapshotWithResult(snapshot: MappedLotSnapshot, result: AnyLotCommandResult, now: string): void {
  for (const effect of result.effects) {
    const after = effect.after;
    const before = effect.before;
    const mapped = snapshot.lots.find((entry) => entry.lot.id === after.id);
    if (mapped) mapped.lot = after;
    const row = snapshot.legacyRows.find((candidate) => candidate.id === after.id);
    const location = snapshot.locations.find((candidate) => candidate.id === after.storageLocationId);
    const storage = location?.type === 'FRIDGE' ? 'fridge' as const
      : location?.type === 'FREEZER' ? 'freezer' as const
        : location?.type === 'PANTRY' ? 'pantry' as const : undefined;
    if (!storage) throw new LotCommandError('DRIFT_DETECTED');
    const unchangedExpiry = before !== null && before.expiryKind === after.expiryKind
      && before.expiryAt === after.expiryAt && before.estimatedExpiryAt === after.estimatedExpiryAt;
    const expiry = unchangedExpiry && row ? {
      expiry_date: row.expiry_date, expiry_kind: row.expiry_kind, expiry_source: row.expiry_source,
    } : expiryProjection(after);
    const projectedFreshness = after.quantityMilli === 0 ? 'out_of_stock'
      : row && before && before.quantityMilli > 0 && unchangedExpiry ? row.freshness
        : freshness(expiry.expiry_date, now);
    const openedAt = before && row && before.openedAt === after.openedAt ? row.opened_at : after.openedAt;
    const category = snapshot.ingredients.find((ingredient) => ingredient.id === after.ingredientId)?.category ?? 'other';
    if (row) {
      row.ingredient_id = after.ingredientId;
      row.name = after.rawName;
      row.quantity = exactLegacyQuantity(after.quantityMilli, after.canonicalUnit);
      row.unit = after.canonicalUnit;
      row.category = category;
      row.storage = storage;
      row.expiry_date = expiry.expiry_date;
      row.expiry_kind = expiry.expiry_kind;
      row.expiry_source = expiry.expiry_source;
      row.opened_at = openedAt;
      row.freshness = projectedFreshness;
      row.version = after.legacyVersion!;
      row.updated_at = after.updatedAt;
    } else {
      // Mirrors the CREATE projection insert, including its canonical category.
      snapshot.legacyRows.push({
        id: after.id, household_id: after.householdId, ingredient_id: after.ingredientId, name: after.rawName,
        quantity: exactLegacyQuantity(after.quantityMilli, after.canonicalUnit), unit: after.canonicalUnit,
        category, storage, expiry_date: expiry.expiry_date, opened_at: after.openedAt,
        expiry_kind: expiry.expiry_kind, expiry_source: expiry.expiry_source, version: after.legacyVersion!,
        created_at: after.createdAt, updated_at: after.updatedAt, added_date: after.createdAt,
        data_source: after.sourceType === 'SCAN' || after.sourceType === 'RECEIPT' ? 'scan'
          : after.sourceType === 'SHOPPING' ? 'shopping' : 'manual',
        freshness: projectedFreshness,
      });
    }
  }
}

function isFefoInput(input: unknown): boolean {
  return typeof input === 'object' && input !== null && (input as { mode?: unknown }).mode === 'FEFO';
}

// Plans several canonical commands against one shared, evolving snapshot.
// Replayed specs contribute no statements; the caller appends its own route
// statements and executes one atomic batch.
export async function composeInventoryLotCommands(db: D1DatabaseBinding, scope: InventoryLotCommandScope,
  specs: LotCommandSpec[], now: string): Promise<ComposedLotCommands> {
  const snapshot = await readMappedLotSnapshot(db, scope, undefined, true);
  assertAdoptionAdmission(snapshot);
  const statements: D1PreparedStatement[] = [];
  const prepared: PreparedAnyLotCommand[] = [];
  let householdCasPlaced = false;
  for (const spec of specs) {
    let input = spec.input;
    if (spec.useCurrentLotVersion && !isFefoInput(input)) {
      const parsed = InventoryLotCommandSchema.safeParse(input);
      if (!parsed.success) throw new LotCommandError('INVALID_COMMAND');
      if (!('expectedVersion' in parsed.data) || parsed.data.lotId !== spec.useCurrentLotVersion.lotId) {
        throw new LotCommandError('INVALID_COMMAND');
      }
      const current = snapshot.lots.find((entry) => entry.lot.id === spec.useCurrentLotVersion!.lotId);
      if (!current) throw new LotCommandError('LOT_EXISTS');
      input = { ...parsed.data, expectedVersion: current.lot.version };
    }
    // One shared stock snapshot: the first executed command fences the whole
    // composed batch; later commands ride it with per-lot CAS only.
    const result = isFefoInput(input)
      ? await prepareInventoryFefoCommand(db, scope, spec.clientKey, input, now, snapshot, householdCasPlaced)
      : await prepareInventoryLotCommand(db, scope, spec.clientKey, input, now, snapshot,
          householdCasPlaced);
    prepared.push(result);
    if (result.kind === 'prepared') {
      statements.push(...result.statements);
      householdCasPlaced = true;
      advanceSnapshotWithResult(snapshot, result.result, now);
    }
  }
  return { snapshot, prepared, statements };
}

// After a composed batch failed: replay committed twins, or classify. Every
// prepared spec must recover for the composition to be usable.
export async function recoverComposedLotCommands(db: D1DatabaseBinding, scope: InventoryLotCommandScope,
  composed: ComposedLotCommands, error: unknown): Promise<(InventoryLotCommandExecution | InventoryFefoCommandExecution)[]> {
  const executions: (InventoryLotCommandExecution | InventoryFefoCommandExecution)[] = [];
  for (const prepared of composed.prepared) {
    if (prepared.kind === 'replay') {
      executions.push(prepared.execution);
      continue;
    }
    const receipt = await readReceipt(db, scope, prepared.clientKey);
    if (!receipt) throw classifyLotCommandBatchFailure(error);
    executions.push('mode' in prepared.command
      ? replayFefo(receipt, prepared.fingerprint, scope, prepared.clientKey, prepared.command)
      : replay(receipt, prepared.fingerprint, scope, prepared.clientKey, prepared.command));
  }
  return executions;
}
