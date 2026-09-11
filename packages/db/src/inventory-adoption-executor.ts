import { z } from 'zod';
import {
  InventoryAdoptionProjectionSchema, MAX_INVENTORY_ADOPTION_EFFECTS,
  planInventoryAdoption,
  type InventoryAdoptionEffect, type InventoryAdoptionSnapshot,
} from '../../domain/src/inventory-adoption';
import { InventoryLotSchema } from '../../domain/src/inventory-truth';
import { LotCommandError } from '../../domain/src/inventory-lot-commands';
import type { InventoryLotCommandScope } from './inventory-lot-commands';
import { authorizedHousehold, expiryProjection, MEMBERSHIP, readMappedLotSnapshot } from './inventory-lot-commands';
import type { D1DatabaseBinding, D1PreparedStatement, D1Result } from './index';

// schemaVersion 3: receipt-backed adoption/compatibility authority. v1/v2
// native receipts and events are unchanged; adoption never rewrites them.
export interface InventoryAdoptionCommandResult {
  schemaVersion: 3;
  commandType: 'ADOPT';
  householdId: string;
  actorId: string;
  sourceInventoryVersion: number;
  emptyHousehold: boolean;
  createdLocationCount: number;
  createdSnapshotCount: number;
  mappedLotCount: number;
  effects: InventoryAdoptionEffect[];
}
export interface InventoryAdoptionCommandExecution { result: InventoryAdoptionCommandResult; replayed: boolean }

const Identity = z.string().min(1).refine((value) => value === value.trim() && !value.includes('\0'));
const Version = z.number().int().safe().positive();
const Scope = z.object({ householdId: Identity, actorId: Identity }).strict();
const TerminalEvidenceInput = z.object({
  legacyItemId: Identity,
  state: z.enum(['CONSUMED', 'DISCARDED']),
  reason: z.string().max(1000).refine((value) => value.trim().length > 0 && !value.includes('\0')),
}).strict();
export interface InventoryAdoptionRequest {
  expectedInventoryVersion?: number;
  terminalEvidence?: z.input<typeof TerminalEvidenceInput>[];
}

const AdoptionReceiptResult = z.object({
  schemaVersion: z.literal(3),
  commandType: z.literal('ADOPT'),
  householdId: Identity,
  actorId: Identity,
  sourceInventoryVersion: Version,
  emptyHousehold: z.boolean(),
  createdLocationCount: z.number().int().nonnegative(),
  createdSnapshotCount: z.number().int().nonnegative(),
  mappedLotCount: z.number().int().nonnegative(),
  effects: z.array(z.object({
    ordinal: z.number().int().nonnegative(),
    lotId: Identity,
    legacyItemId: Identity,
    snapshotMissing: z.boolean(),
    before: InventoryLotSchema,
    after: InventoryLotSchema,
    projectionBefore: InventoryAdoptionProjectionSchema,
    projectionAfter: InventoryAdoptionProjectionSchema,
    deltaMilli: z.literal(0),
    terminalEvidence: z.object({ legacyItemId: Identity, state: z.enum(['CONSUMED', 'DISCARDED']),
      reason: z.string() }).strict().nullable(),
  }).strict()),
}).strict();

interface AdoptionReceiptRow {
  id: string; household_id: string; actor_id: string; source_inventory_version: number;
  fingerprint: string; result_json: string; created_at: string;
}

const MAX_ADOPTION_RECEIPT_BYTES = 262144;

function sortedAdoptionJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object') return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, sort(entry)]),
    );
    return item;
  };
  return JSON.stringify(sort(value));
}

function assertResults(results: D1Result[]): void {
  if (results.some((result) => !result.success)) throw new LotCommandError('PERSISTENCE_FAILED');
}

// A zero-row CAS must abort the batch itself; guards mirror the native executor.
function adoptionGuard(db: D1DatabaseBinding, householdId: string, column: 'quantity_delta' | 'inventory_item_id'): D1PreparedStatement {
  return db.prepare(`INSERT INTO inventory_events
    (id, household_id, inventory_item_id, event_type, quantity_delta, unit)
    SELECT ?, ?, ${column === 'inventory_item_id' ? 'NULL' : "''"}, 'T09_ADOPTION_GUARD',
      ${column === 'quantity_delta' ? 'NULL' : '0'}, 'piece'
    WHERE changes() <> 1`).bind(crypto.randomUUID(), householdId);
}

async function readAdoptionReceipt(db: D1DatabaseBinding, scope: InventoryLotCommandScope): Promise<AdoptionReceiptRow | undefined> {
  const results = await db.batch([
    authorizedHousehold(db, scope),
    db.prepare(`SELECT id, household_id, actor_id, source_inventory_version, fingerprint, result_json, created_at
      FROM inventory_adoption_receipts WHERE household_id = ?`).bind(scope.householdId),
  ]);
  assertResults(results);
  const row = results[0].results[0] as { inventoryVersion: number } | undefined;
  if (!row) throw new LotCommandError('FORBIDDEN');
  return results[1].results[0] as AdoptionReceiptRow | undefined;
}

function adoptionFingerprint(scope: InventoryLotCommandScope,
  terminalEvidence: z.infer<typeof TerminalEvidenceInput>[]): string {
  // Intent-only: now and the moving inventory version are excluded so a
  // response-loss retry replays the receipt instead of conflicting.
  return sortedAdoptionJson({ householdId: scope.householdId, terminalEvidence });
}

function validateReceipt(receipt: AdoptionReceiptRow, scope: InventoryLotCommandScope,
  fingerprint: string): InventoryAdoptionCommandResult {
  if (receipt.household_id !== scope.householdId) throw new LotCommandError('ADOPTION_ALREADY_ACTIVE');
  let result: InventoryAdoptionCommandResult;
  try {
    result = AdoptionReceiptResult.parse(JSON.parse(receipt.result_json));
  } catch {
    throw new LotCommandError('CORRUPT_RECEIPT');
  }
  // Adoption is a household-scoped transition: any current member may replay
  // it, but the intent fingerprint must match byte for byte.
  if (receipt.fingerprint !== fingerprint || result.householdId !== scope.householdId) {
    throw new LotCommandError('IDEMPOTENCY_CONFLICT');
  }
  return result;
}

const LEGACY_COLUMNS = [
  'id', 'household_id', 'ingredient_id', 'name', 'quantity', 'unit', 'storage',
  'expiry_date', 'opened_at', 'expiry_kind', 'expiry_source', 'version', 'created_at', 'updated_at',
] as const;

// Native commands require the canonical expiry projection to reproduce the
// legacy row's evidence. Rows adoption cannot represent would otherwise adopt
// into a household no native writer can serve; fail closed before activation.
function assertProjectionCompatibility(effects: InventoryAdoptionEffect[]): void {
  for (const effect of effects) {
    const { before: lot, projectionBefore: row } = effect;
    const expiry = expiryProjection(lot);
    const historicalUnknown = lot.expiryKind === 'UNKNOWN' && row.expiry_date === lot.legacyExpiryAt;
    if ((row.expiry_date !== expiry.expiry_date && !historicalUnknown)
      || row.expiry_kind !== expiry.expiry_kind || row.expiry_source !== expiry.expiry_source) {
      throw new LotCommandError('DRIFT_DETECTED');
    }
  }
}

function poststateFence(db: D1DatabaseBinding, householdId: string, receiptId: string,
  result: InventoryAdoptionCommandResult, resultJson: string): D1PreparedStatement {
  const lotFields: Record<string, string> = {
    'after.version': 'version', 'after.state': 'state', 'after.quantityMilli': 'quantity_milli',
    'after.canonicalUnit': 'canonical_unit', 'after.storageLocationId': 'storage_location_id',
    'after.ingredientId': 'ingredient_id', 'after.rawName': 'raw_name', 'after.expiryAt': 'expiry_at',
    'after.estimatedExpiryAt': 'estimated_expiry_at', 'after.expiryKind': 'expiry_kind',
    'after.legacyVersion': 'legacy_version', 'after.updatedAt': 'updated_at',
    'after.legacyExpiryAt': 'legacy_expiry_at', 'after.legacyExpiryKind': 'legacy_expiry_kind',
    'after.legacyExpirySource': 'legacy_expiry_source', 'after.legacyOpenedAt': 'legacy_opened_at',
  };
  const lotMatches = Object.entries(lotFields).map(([path, column]) =>
    `json_extract(e.value, '$.${path}') IS l.${column}`).join(' AND ');
  const projectionFields: Record<string, string> = {
    'projectionAfter.version': 'version', 'projectionAfter.quantity': 'quantity',
    'projectionAfter.unit': 'unit', 'projectionAfter.name': 'name',
    'projectionAfter.ingredient_id': 'ingredient_id', 'projectionAfter.storage': 'storage',
    'projectionAfter.expiry_date': 'expiry_date', 'projectionAfter.opened_at': 'opened_at',
    'projectionAfter.expiry_kind': 'expiry_kind', 'projectionAfter.expiry_source': 'expiry_source',
    'projectionAfter.created_at': 'created_at', 'projectionAfter.updated_at': 'updated_at',
  };
  const projectionMatches = Object.entries(projectionFields).map(([path, column]) =>
    `json_extract(e.value, '$.${path}') IS i.${column}`).join(' AND ');
  return db.prepare(`UPDATE households SET inventory_version = inventory_version WHERE id = ?
    AND EXISTS (SELECT 1 FROM inventory_adoption_receipts WHERE household_id = households.id AND id = ?)
    AND NOT EXISTS (SELECT 1 FROM inventory_lots WHERE household_id = households.id AND legacy_item_id IS NULL)
    AND (SELECT count(*) FROM inventory_lots WHERE household_id = households.id) = ?
    AND (SELECT count(*) FROM inventory_items WHERE household_id = households.id) = ?
    AND (SELECT count(*) FROM json_each(?, '$.effects') e
      JOIN inventory_lots l ON l.id = json_extract(e.value, '$.after.id') AND l.household_id = households.id
      JOIN inventory_items i ON i.id = l.legacy_item_id AND i.household_id = households.id
      WHERE l.legacy_item_id = json_extract(e.value, '$.legacyItemId')
        AND (${lotMatches})
        AND (${projectionMatches})
    ) = ?`).bind(householdId, receiptId, result.effects.length, result.effects.length,
    resultJson, result.effects.length);
}

export async function executeInventoryAdoption(db: D1DatabaseBinding, inputScope: InventoryLotCommandScope,
  request: InventoryAdoptionRequest, now = new Date().toISOString()): Promise<InventoryAdoptionCommandExecution> {
  const parsedScope = Scope.safeParse(inputScope);
  if (!parsedScope.success) throw new LotCommandError('FORBIDDEN');
  const scope = parsedScope.data;
  const evidence = z.array(TerminalEvidenceInput).max(MAX_INVENTORY_ADOPTION_EFFECTS)
    .safeParse(request.terminalEvidence ?? []);
  if (!evidence.success) throw new LotCommandError('INVALID_TERMINAL_EVIDENCE');

  // The executor owns snapshot completeness; caller payloads never authorize.
  const snapshot = await readMappedLotSnapshot(db, scope, undefined, true);
  const adoptionSnapshot: InventoryAdoptionSnapshot = {
    complete: true,
    householdId: scope.householdId,
    inventoryVersion: snapshot.inventoryVersion,
    householdCreatedAt: snapshot.householdCreatedAt,
    householdUpdatedAt: snapshot.householdUpdatedAt,
    activationCommandId: snapshot.activationCommandId,
    legacyRows: snapshot.legacyRows as unknown as InventoryAdoptionSnapshot['legacyRows'],
    lots: snapshot.lots,
    locations: snapshot.locations,
    ingredientIds: snapshot.ingredients.map(({ id }) => id),
  };
  const fingerprint = adoptionFingerprint(scope, evidence.data);
  const existing = await readAdoptionReceipt(db, scope);
  if (existing) {
    return { result: validateReceipt(existing, scope, fingerprint), replayed: true };
  }
  if (request.expectedInventoryVersion !== undefined
    && request.expectedInventoryVersion !== snapshot.inventoryVersion) {
    throw new LotCommandError('STALE_SNAPSHOT');
  }

  const plan = planInventoryAdoption(adoptionSnapshot, {
    expectedInventoryVersion: snapshot.inventoryVersion, now, terminalEvidence: evidence.data,
  });
  assertProjectionCompatibility(plan.effects);
  const result: InventoryAdoptionCommandResult = {
    schemaVersion: 3, commandType: 'ADOPT', householdId: scope.householdId, actorId: scope.actorId,
    sourceInventoryVersion: snapshot.inventoryVersion, emptyHousehold: plan.activation.emptyHousehold,
    createdLocationCount: plan.missingLocations.length, createdSnapshotCount: plan.missingSnapshots.length,
    mappedLotCount: plan.effects.length, effects: plan.effects,
  };
  const resultJson = JSON.stringify(result);
  if (new TextEncoder().encode(resultJson).length > MAX_ADOPTION_RECEIPT_BYTES) {
    throw new LotCommandError('ADOPTION_LIMIT_EXCEEDED');
  }
  const receiptId = crypto.randomUUID();

  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE households SET inventory_version = inventory_version + 1
      WHERE id = ? AND inventory_version = ? AND ${MEMBERSHIP}`)
      .bind(scope.householdId, snapshot.inventoryVersion, scope.actorId),
    adoptionGuard(db, scope.householdId, 'quantity_delta'),
    db.prepare(`INSERT INTO inventory_adoption_receipts
      (id, household_id, actor_id, source_inventory_version, fingerprint, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(receiptId, scope.householdId, scope.actorId, snapshot.inventoryVersion, fingerprint, resultJson, now),
    adoptionGuard(db, scope.householdId, 'inventory_item_id'),
  ];

  // Missing default locations first; missing snapshots must exist before the
  // first live mapping because 0024 blocks backfill inserts after activation.
  for (const location of plan.missingLocations) {
    statements.push(db.prepare(`INSERT INTO storage_locations
      (id, household_id, type, name, sort_order, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(household_id, type) WHERE is_default = 1 DO NOTHING`)
      .bind(location.id, scope.householdId, location.type, location.name, location.sortOrder,
        location.createdAt, location.updatedAt),
      adoptionGuard(db, scope.householdId, 'quantity_delta'));
  }
  for (const lot of plan.missingSnapshots) {
    const row = snapshot.legacyRows.find((candidate) => candidate.id === lot.sourceId)!;
    const sourceGuard = `CASE WHEN EXISTS (SELECT 1 FROM inventory_items WHERE ${LEGACY_COLUMNS.map((column) => `${column} IS ?`).join(' AND ')}) THEN ? ELSE NULL END`;
    statements.push(db.prepare(`INSERT INTO inventory_lots
      (id, household_id, ingredient_id, raw_name, quantity_milli, canonical_unit, storage_location_id,
       state, purchased_at, opened_at, expiry_at, estimated_expiry_at, expiry_kind, source_type, source_id,
       version, created_at, updated_at, currency, amount_minor, minor_digits,
       legacy_expiry_at, legacy_expiry_kind, legacy_expiry_source, legacy_opened_at, legacy_version)
      VALUES (?, ?, ?, ?, ${sourceGuard}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) WHERE source_type = 'LEGACY_BACKFILL' DO NOTHING`).bind(
      lot.id, scope.householdId, lot.ingredientId, lot.rawName,
      ...LEGACY_COLUMNS.map((column) => row[column as keyof typeof row]), lot.quantityMilli,
      lot.canonicalUnit, lot.storageLocationId, lot.state, lot.purchasedAt, lot.openedAt,
      lot.expiryAt, lot.estimatedExpiryAt, lot.expiryKind, lot.sourceType, lot.sourceId,
      lot.version, lot.createdAt, lot.updatedAt, null, null, null,
      lot.legacyExpiryAt, lot.legacyExpiryKind, lot.legacyExpirySource, lot.legacyOpenedAt, lot.legacyVersion,
    ), adoptionGuard(db, scope.householdId, 'quantity_delta'));
  }
  // One atomic transition: mapping, terminal evidence and lot versions commit
  // with the receipt, or none of them do.
  for (const effect of plan.effects) {
    statements.push(db.prepare(`UPDATE inventory_lots
      SET legacy_item_id = ?, state = ?, version = ?, updated_at = ?
      WHERE id = ? AND household_id = ? AND version = ? AND legacy_item_id IS NULL`)
      .bind(effect.legacyItemId, effect.after.state, effect.after.version, effect.after.updatedAt,
        effect.lotId, scope.householdId, effect.before.version),
      adoptionGuard(db, scope.householdId, 'quantity_delta'));
  }
  statements.push(poststateFence(db, scope.householdId, receiptId, result, resultJson),
    adoptionGuard(db, scope.householdId, 'quantity_delta'));

  try {
    assertResults(await db.batch(statements));
    return { result, replayed: false };
  } catch (error) {
    const receipt = await readAdoptionReceipt(db, scope);
    if (receipt) {
      return { result: validateReceipt(receipt, scope, fingerprint), replayed: true };
    }
    if (error instanceof LotCommandError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (/NOT NULL constraint failed: inventory_events\.quantity_delta/i.test(message)) throw new LotCommandError('STALE_SNAPSHOT');
    throw new LotCommandError('PERSISTENCE_FAILED');
  }
}
