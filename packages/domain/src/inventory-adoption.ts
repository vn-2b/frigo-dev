import { z } from 'zod';
import { CanonicalIngredientIdSchema } from './foundation';
import { LotCommandError } from './inventory-lot-commands';
import {
  InventoryLotSchema, StorageLocationSchema, checkLegacyLotParity, defaultStorageLocations,
  legacyInventoryToLot, type InventoryLot, type StorageLocation,
} from './inventory-truth';

export const MAX_INVENTORY_ADOPTION_EFFECTS = 32;
export const MAX_INVENTORY_ADOPTION_SNAPSHOT_ROWS = 1000;

const Identity = InventoryLotSchema.innerType().shape.id;
const Version = z.number().int().safe().positive();
const Timestamp = z.string().datetime({ offset: true }).refine((value) =>
  z.string().date().safeParse(value.slice(0, 10)).success && Number.isFinite(Date.parse(value)));
const TerminalEvidenceSchema = z.object({
  legacyItemId: Identity,
  state: z.enum(['CONSUMED', 'DISCARDED']),
  reason: z.string().max(1000).refine((value) => value.trim().length > 0 && !value.includes('\0')),
}).strict();

export const InventoryAdoptionProjectionSchema = z.object({
  id: Identity, household_id: Identity, ingredient_id: CanonicalIngredientIdSchema.nullable(),
  name: z.string(), quantity: z.number().finite().nonnegative(),
  unit: z.enum(['g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice']),
  storage: z.enum(['fridge', 'freezer', 'pantry']),
  expiry_date: z.string().nullable(), opened_at: z.string().nullable(),
  expiry_kind: z.string(), expiry_source: z.string(), version: Version,
  category: z.string(), data_source: z.string(), freshness: z.string(),
  added_date: z.string().min(1), created_at: z.string().min(1), updated_at: z.string().min(1),
}).strict();
export type InventoryAdoptionProjection = z.infer<typeof InventoryAdoptionProjectionSchema>;

const InventoryAdoptionSnapshotSchema = z.object({
  // Executor-owned completeness assertion, not caller authorization.
  complete: z.literal(true),
  householdId: Identity, inventoryVersion: Version,
  householdCreatedAt: z.string().min(1), householdUpdatedAt: z.string().min(1),
  activationCommandId: Identity.nullable(),
  legacyRows: z.array(InventoryAdoptionProjectionSchema).max(MAX_INVENTORY_ADOPTION_SNAPSHOT_ROWS),
  lots: z.array(z.object({ lot: InventoryLotSchema, legacyItemId: Identity.nullable() }).strict())
    .max(MAX_INVENTORY_ADOPTION_SNAPSHOT_ROWS),
  locations: z.array(StorageLocationSchema).max(MAX_INVENTORY_ADOPTION_SNAPSHOT_ROWS),
  ingredientIds: z.array(CanonicalIngredientIdSchema).max(MAX_INVENTORY_ADOPTION_SNAPSHOT_ROWS),
}).strict();
export type InventoryAdoptionSnapshot = z.infer<typeof InventoryAdoptionSnapshotSchema>;

const InventoryAdoptionIntentSchema = z.object({
  expectedInventoryVersion: Version,
  now: Timestamp,
  terminalEvidence: z.array(TerminalEvidenceSchema).max(MAX_INVENTORY_ADOPTION_EFFECTS),
}).strict();
export type InventoryAdoptionIntent = z.infer<typeof InventoryAdoptionIntentSchema>;

export interface InventoryAdoptionEffect {
  ordinal: number;
  lotId: string;
  legacyItemId: string;
  snapshotMissing: boolean;
  before: InventoryLot;
  after: InventoryLot;
  projectionBefore: InventoryAdoptionProjection;
  projectionAfter: InventoryAdoptionProjection;
  deltaMilli: 0;
  terminalEvidence: z.infer<typeof TerminalEvidenceSchema> | null;
}

export interface InventoryAdoptionPlan {
  householdId: string;
  expectedInventoryVersion: number;
  now: string;
  missingLocations: StorageLocation[];
  missingSnapshots: InventoryLot[];
  effects: InventoryAdoptionEffect[];
  activation: { kind: 'ACTIVATE_HOUSEHOLD'; emptyHousehold: boolean };
}

function fail(code: string, detail?: string): never {
  throw new LotCommandError(code, detail ?? code);
}

// Preparation only: authorization and whole-snapshot fences belong to the future executor.
export function planInventoryAdoption(
  inputSnapshot: InventoryAdoptionSnapshot,
  inputIntent: InventoryAdoptionIntent,
): InventoryAdoptionPlan {
  const parsedSnapshot = InventoryAdoptionSnapshotSchema.safeParse(inputSnapshot);
  if (!parsedSnapshot.success) {
    if (parsedSnapshot.error.issues.some((issue) => issue.code === 'too_big' && issue.type === 'array')) {
      fail('ADOPTION_LIMIT_EXCEEDED');
    }
    fail('INVALID_ADOPTION_SNAPSHOT');
  }
  const parsedIntent = InventoryAdoptionIntentSchema.safeParse(inputIntent);
  if (!parsedIntent.success) fail('INVALID_COMMAND');
  const snapshot = parsedSnapshot.data;
  const intent = parsedIntent.data;
  if (intent.expectedInventoryVersion !== snapshot.inventoryVersion) fail('STALE_SNAPSHOT');
  if (snapshot.legacyRows.some((row) => row.household_id !== snapshot.householdId)
    || snapshot.lots.some(({ lot }) => lot.householdId !== snapshot.householdId)
    || snapshot.locations.some((location) => location.householdId !== snapshot.householdId)) {
    fail('HOUSEHOLD_MISMATCH');
  }
  if (snapshot.activationCommandId !== null || snapshot.lots.some(({ legacyItemId }) => legacyItemId !== null)) {
    fail('ADOPTION_ALREADY_ACTIVE');
  }
  if (snapshot.legacyRows.length > MAX_INVENTORY_ADOPTION_EFFECTS) fail('ADOPTION_LIMIT_EXCEEDED');
  if (snapshot.lots.some(({ lot }) => lot.sourceType !== 'LEGACY_BACKFILL')) fail('DRIFT_DETECTED');
  const ingredientIds = new Set(snapshot.ingredientIds);
  if (ingredientIds.size !== snapshot.ingredientIds.length) fail('DRIFT_DETECTED');
  if (snapshot.legacyRows.some((row) => row.ingredient_id !== null && !ingredientIds.has(row.ingredient_id))) {
    fail('INGREDIENT_NOT_FOUND');
  }

  const missingLocations = defaultStorageLocations(snapshot.householdId,
    snapshot.householdCreatedAt, snapshot.householdUpdatedAt)
    .filter((location) => !snapshot.locations.some((existing) => existing.type === location.type && existing.isDefault));
  const locations = [...snapshot.locations, ...missingLocations];
  if (locations.length > MAX_INVENTORY_ADOPTION_SNAPSHOT_ROWS) fail('ADOPTION_LIMIT_EXCEEDED');
  const existingLots = snapshot.lots.map(({ lot }) => lot);
  const rows = [...snapshot.legacyRows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const missingSnapshots: InventoryLot[] = [];
  for (const row of rows) {
    if (existingLots.some((lot) => lot.sourceId === row.id)) continue;
    let lot: InventoryLot;
    try {
      lot = legacyInventoryToLot(row);
    } catch {
      fail('UNREPRESENTABLE_QUANTITY');
    }
    lot.storageLocationId = locations.find((location) => location.isDefault
      && location.type.toLowerCase() === row.storage)!.id;
    missingSnapshots.push(lot);
  }
  const lots = [...existingLots, ...missingSnapshots];
  if (lots.length > MAX_INVENTORY_ADOPTION_SNAPSHOT_ROWS) fail('ADOPTION_LIMIT_EXCEEDED');
  const parity = checkLegacyLotParity(snapshot.householdId, rows, lots, locations);
  if (!parity.ok) fail('DRIFT_DETECTED', parity.issues.map(({ code }) => code).join(', '));

  const terminalEvidence = new Map<string, z.infer<typeof TerminalEvidenceSchema>>();
  for (const evidence of intent.terminalEvidence) {
    if (terminalEvidence.has(evidence.legacyItemId)
      || !rows.some((row) => row.id === evidence.legacyItemId && row.quantity === 0)) {
      fail('INVALID_TERMINAL_EVIDENCE');
    }
    terminalEvidence.set(evidence.legacyItemId, evidence);
  }
  const effects = rows.map((row, ordinal): InventoryAdoptionEffect => {
    const before = lots.find((lot) => lot.sourceId === row.id)!;
    const evidence = terminalEvidence.get(row.id) ?? null;
    if (before.quantityMilli === 0 && evidence === null) fail('TERMINAL_EVIDENCE_REQUIRED');
    const after = InventoryLotSchema.parse({
      ...before, state: evidence?.state ?? before.state, version: before.version + 1, updatedAt: intent.now,
    });
    return {
      ordinal, lotId: before.id, legacyItemId: row.id,
      snapshotMissing: missingSnapshots.some((lot) => lot.id === before.id),
      before: structuredClone(before), after,
      projectionBefore: structuredClone(row), projectionAfter: structuredClone(row),
      deltaMilli: 0, terminalEvidence: evidence,
    };
  });
  return {
    householdId: snapshot.householdId, expectedInventoryVersion: snapshot.inventoryVersion, now: intent.now,
    missingLocations, missingSnapshots, effects,
    activation: { kind: 'ACTIVATE_HOUSEHOLD', emptyHousehold: rows.length === 0 },
  };
}
