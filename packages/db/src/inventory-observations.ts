import { z } from 'zod';
import {
  InventoryObservationInputSchema, InventoryObservationSchema, ObservationError,
  observationFingerprint, observationIdentity,
  MAX_OBSERVATIONS_PER_RECONCILIATION,
  type InventoryObservation, type InventoryObservationInput,
} from '../../domain/src/inventory-observations';
import { toLotQuantity } from '../../domain/src/inventory-truth';
import type { D1DatabaseBinding, D1PreparedStatement } from './index';
import { readLegacyInventoryRevision } from './inventory-writer-fence';

// T10C observation persistence. Evidence persistence only: nothing in this
// module writes inventory_items, inventory_lots or inventory_events. Stock
// changes happen exclusively through reconciliation decisions that compose
// existing T09 lot-authority commands.
export interface InventoryObservationScope { householdId: string; actorId: string }
export interface ObservationRecordExecution { observation: InventoryObservation; replayed: boolean }

const Identity = z.string().min(1).refine((value) => value === value.trim() && !value.includes('\0'));
const Scope = z.object({ householdId: Identity, actorId: Identity }).strict();
export const MAX_OBSERVATION_LIST_LIMIT = 100;

interface ObservationRow {
  id: string; household_id: string; source_type: string; source_ref: string; fingerprint: string;
  observed_at: string; recorded_at: string; ingredient_id: string | null; raw_name: string | null;
  lot_id: string | null; legacy_item_id: string | null; quantity: number | null; unit: string | null;
  quantity_milli: number | null; canonical_unit: string | null; storage: string | null;
  expiry_date: string | null; expiry_kind: string | null; opened_at: string | null;
  evidence: string; note: string | null; authoritative_inventory_version: number;
  status: string; version: number; created_at: string; updated_at: string;
}

function observationStatement(db: D1DatabaseBinding, householdId: string, sourceType: string, sourceRef: string) {
  return db.prepare(`SELECT id, household_id, source_type, source_ref, fingerprint, observed_at,
    recorded_at, ingredient_id, raw_name, lot_id, legacy_item_id, quantity, unit, quantity_milli,
    canonical_unit, storage, expiry_date, expiry_kind, opened_at, evidence, note,
    authoritative_inventory_version, status, version, created_at, updated_at
    FROM inventory_observations WHERE household_id = ? AND source_type = ? AND source_ref = ?`)
    .bind(householdId, sourceType, sourceRef);
}

export function parseObservationRow(row: ObservationRow): InventoryObservation {
  try {
    return InventoryObservationSchema.parse({
      observationId: row.id,
      householdId: row.household_id,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      fingerprint: row.fingerprint,
      observedAt: row.observed_at,
      recordedAt: row.recorded_at,
      ingredientId: row.ingredient_id,
      rawName: row.raw_name,
      lotId: row.lot_id,
      legacyItemId: row.legacy_item_id,
      evidence: row.evidence,
      note: row.note,
      authoritativeInventoryVersion: row.authoritative_inventory_version,
      status: row.status,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      claim: {
        quantity: row.quantity,
        unit: row.unit,
        quantityMilli: row.quantity_milli,
        canonicalUnit: row.canonical_unit,
        storage: row.storage,
        expiryDate: row.expiry_date,
        expiryKind: row.expiry_kind,
        openedAt: row.opened_at,
      },
    });
  } catch {
    throw new ObservationError('CORRUPT_OBSERVATION');
  }
}

export function observationInsertStatement(db: D1DatabaseBinding, observation: InventoryObservation): D1PreparedStatement {
  return db.prepare(`INSERT INTO inventory_observations (id, household_id, source_type, source_ref,
    fingerprint, observed_at, recorded_at, ingredient_id, raw_name, lot_id, legacy_item_id,
    quantity, unit, quantity_milli, canonical_unit, storage, expiry_date, expiry_kind, opened_at,
    evidence, note, authoritative_inventory_version, status, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      observation.observationId, observation.householdId, observation.sourceType, observation.sourceRef,
      observation.fingerprint, observation.observedAt, observation.recordedAt, observation.ingredientId,
      observation.rawName, observation.lotId, observation.legacyItemId, observation.claim.quantity,
      observation.claim.unit, observation.claim.quantityMilli, observation.claim.canonicalUnit,
      observation.claim.storage, observation.claim.expiryDate, observation.claim.expiryKind,
      observation.claim.openedAt, observation.evidence, observation.note,
      observation.authoritativeInventoryVersion, observation.status, observation.version,
      observation.createdAt, observation.updatedAt,
    );
}

// T13: the same evidence insert, admitted only while the caller's own
// precondition still holds. A guarded observation rides an existing atomic
// batch (for example a scan confirmation): if the guard no longer matches the
// insert writes nothing, exactly like the sibling draft writes, so a lost race
// or a replay can never leave evidence behind for a confirmation that did not
// commit. Still evidence-only: this writes inventory_observations and nothing
// else.
export function guardedObservationInsertStatement(db: D1DatabaseBinding,
  observation: InventoryObservation, guardSql: string, guardBindings: readonly unknown[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO inventory_observations (id, household_id, source_type, source_ref,
    fingerprint, observed_at, recorded_at, ingredient_id, raw_name, lot_id, legacy_item_id,
    quantity, unit, quantity_milli, canonical_unit, storage, expiry_date, expiry_kind, opened_at,
    evidence, note, authoritative_inventory_version, status, version, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${guardSql}`)
    .bind(
      observation.observationId, observation.householdId, observation.sourceType, observation.sourceRef,
      observation.fingerprint, observation.observedAt, observation.recordedAt, observation.ingredientId,
      observation.rawName, observation.lotId, observation.legacyItemId, observation.claim.quantity,
      observation.claim.unit, observation.claim.quantityMilli, observation.claim.canonicalUnit,
      observation.claim.storage, observation.claim.expiryDate, observation.claim.expiryKind,
      observation.claim.openedAt, observation.evidence, observation.note,
      observation.authoritativeInventoryVersion, observation.status, observation.version,
      observation.createdAt, observation.updatedAt,
      ...guardBindings,
    );
}

/**
 * T13: build (never persist) one canonical observation. Same validation,
 * normalization and identity rules as `recordInventoryObservation`; the caller
 * supplies the authoritative inventory version it already read inside its own
 * coherent snapshot and owns when the statement commits.
 */
export function buildInventoryObservation(inputScope: InventoryObservationScope,
  input: InventoryObservationInput, authoritativeInventoryVersion: number,
  now: string): InventoryObservation {
  const scope = Scope.parse(inputScope);
  const parsed = InventoryObservationInputSchema.safeParse(input);
  if (!parsed.success) throw new ObservationError('INVALID_OBSERVATION', parsed.error.message);
  const data = parsed.data;
  let claim = { ...data.claim };
  if (claim.quantity !== null && claim.unit !== null) {
    let normalized: ReturnType<typeof toLotQuantity>;
    try {
      normalized = toLotQuantity(claim.quantity, claim.unit);
    } catch {
      throw new ObservationError('UNREPRESENTABLE_QUANTITY');
    }
    claim = { ...claim, quantityMilli: normalized.quantityMilli, canonicalUnit: normalized.canonicalUnit };
  }
  return InventoryObservationSchema.parse({
    observationId: observationIdentity(scope.householdId, data.sourceType, data.sourceRef),
    householdId: scope.householdId,
    sourceType: data.sourceType,
    sourceRef: data.sourceRef,
    fingerprint: observationFingerprint({ ...data, claim }),
    observedAt: data.observedAt,
    recordedAt: now,
    ingredientId: data.ingredientId,
    rawName: data.rawName,
    lotId: data.lotId,
    legacyItemId: data.legacyItemId,
    evidence: data.evidence,
    note: data.note,
    authoritativeInventoryVersion,
    status: 'OPEN',
    version: 1,
    createdAt: now,
    updatedAt: now,
    claim,
  });
}

export async function recordInventoryObservation(db: D1DatabaseBinding, inputScope: InventoryObservationScope,
  input: InventoryObservationInput, now: string): Promise<ObservationRecordExecution> {
  const scope = Scope.parse(inputScope);
  const parsed = InventoryObservationInputSchema.safeParse(input);
  if (!parsed.success) throw new ObservationError('INVALID_OBSERVATION', parsed.error.message);
  const data = parsed.data;
  let claim = { ...data.claim };
  if (claim.quantity !== null && claim.unit !== null) {
    let normalized: ReturnType<typeof toLotQuantity>;
    try {
      normalized = toLotQuantity(claim.quantity, claim.unit);
    } catch {
      // Exact semantics only: an unprovable or sub-milli quantity never rounds.
      throw new ObservationError('UNREPRESENTABLE_QUANTITY');
    }
    claim = { ...claim, quantityMilli: normalized.quantityMilli, canonicalUnit: normalized.canonicalUnit };
  }
  const fingerprint = observationFingerprint({ ...data, claim });
  const observationId = observationIdentity(scope.householdId, data.sourceType, data.sourceRef);
  const read = async (): Promise<InventoryObservation | null> => {
    const row = await observationStatement(db, scope.householdId, data.sourceType, data.sourceRef)
      .first<ObservationRow>();
    return row ? parseObservationRow(row) : null;
  };
  const existing = await read();
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new ObservationError('IDEMPOTENCY_CONFLICT');
    return { observation: existing, replayed: true };
  }
  // The recorded authoritative version is read from the household, never
  // trusted from the caller, so later drift detection is provable.
  const authoritativeInventoryVersion = await readLegacyInventoryRevision(db, scope.householdId);
  const observation = InventoryObservationSchema.parse({
    observationId,
    householdId: scope.householdId,
    sourceType: data.sourceType,
    sourceRef: data.sourceRef,
    fingerprint,
    observedAt: data.observedAt,
    recordedAt: now,
    ingredientId: data.ingredientId,
    rawName: data.rawName,
    lotId: data.lotId,
    legacyItemId: data.legacyItemId,
    evidence: data.evidence,
    note: data.note,
    authoritativeInventoryVersion,
    status: 'OPEN',
    version: 1,
    createdAt: now,
    updatedAt: now,
    claim,
  });
  try {
    await db.batch([observationInsertStatement(db, observation)]);
  } catch (error) {
    // Concurrent first write: the unique identity decides replay vs conflict.
    const raced = await read().catch(() => null);
    if (raced && raced.fingerprint === fingerprint) return { observation: raced, replayed: true };
    if (raced) throw new ObservationError('IDEMPOTENCY_CONFLICT');
    throw error;
  }
  return { observation, replayed: false };
}

export async function readInventoryObservation(db: D1DatabaseBinding, householdId: string,
  observationId: string): Promise<InventoryObservation> {
  Identity.parse(householdId);
  Identity.parse(observationId);
  const row = await db.prepare(`SELECT id, household_id, source_type, source_ref, fingerprint,
    observed_at, recorded_at, ingredient_id, raw_name, lot_id, legacy_item_id, quantity, unit,
    quantity_milli, canonical_unit, storage, expiry_date, expiry_kind, opened_at, evidence, note,
    authoritative_inventory_version, status, version, created_at, updated_at
    FROM inventory_observations WHERE id = ? AND household_id = ?`).bind(observationId, householdId)
    .first<ObservationRow>();
  if (!row) throw new ObservationError('OBSERVATION_NOT_FOUND');
  return parseObservationRow(row);
}

export async function readInventoryObservations(db: D1DatabaseBinding, householdId: string,
  options: { status?: InventoryObservation['status']; limit?: number } = {}): Promise<InventoryObservation[]> {
  Identity.parse(householdId);
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OBSERVATION_LIST_LIMIT) {
    throw new ObservationError('INVALID_LIMIT');
  }
  if (options.status !== undefined && !['OPEN', 'RECONCILED', 'STALE'].includes(options.status)) {
    throw new ObservationError('INVALID_STATUS_FILTER');
  }
  const clause = options.status === undefined ? '' : ' AND status = ?';
  const bindings = options.status === undefined ? [householdId] : [householdId, options.status];
  const result = await db.prepare(`SELECT id, household_id, source_type, source_ref, fingerprint,
    observed_at, recorded_at, ingredient_id, raw_name, lot_id, legacy_item_id, quantity, unit,
    quantity_milli, canonical_unit, storage, expiry_date, expiry_kind, opened_at, evidence, note,
    authoritative_inventory_version, status, version, created_at, updated_at
    FROM inventory_observations WHERE household_id = ?${clause}
    ORDER BY recorded_at DESC, id ASC LIMIT ?`).bind(...bindings, limit).all<ObservationRow>();
  return result.results.map(parseObservationRow);
}

export { MAX_OBSERVATIONS_PER_RECONCILIATION };
