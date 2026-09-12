import { InventoryReadItemSchema, InventoryReadFreshnessError, computeReadFreshness, displayQuantity,
  type InventoryReadAuthorityResult, type InventoryReadItem,
  type InventoryReadQuery, type ProjectionParityDiagnostic } from '../../domain/src/inventory-read-authority';
import { toLotQuantity, type InventoryLot } from '../../domain/src/inventory-truth';
import type { D1DatabaseBinding } from './index';
import {
  exactLegacyQuantity, expiryProjection, readAdoptedLotSnapshot, authoritativeMapping,
  type MappedLotSnapshot,
} from './inventory-lot-commands';

// T11 read authority: the ONLY sanctioned way for product flows to ask what
// inventory currently exists. Built on the T09 coherent snapshot (one D1
// batch = one implicit transaction, zod-validated rows, bounded at 1000 lots)
// and the adoption gate. inventory_items is never a fallback: for adopted
// households it is checked for parity, never trusted. There is no dual-truth
// path — if authority exists but is inconsistent, reads fail closed.

export class InventoryReadAuthorityError extends Error {
  readonly code: 'READ_FORBIDDEN' | 'ADOPTION_REQUIRED' | 'LOT_NOT_FOUND' | 'READ_LIMIT_EXCEEDED'
    | 'INVALID_READ_QUERY' | 'CORRUPT_LOT_ROW' | 'MAPPING_CORRUPT' | 'PROJECTION_DRIFT';

  constructor(code: InventoryReadAuthorityError['code'], message: string = code) {
    super(message);
    this.name = 'InventoryReadAuthorityError';
    this.code = code;
  }
}

export const MAX_READ_AUTHORITY_LOTS = 1000; // justified bound reused from FEFO snapshots

const READ_STATE_QUANTITY = 'ACTIVE lots must carry positive stock; terminal lots zero';

function displayStorage(snapshot: MappedLotSnapshot, lot: InventoryLot): string {
  const location = snapshot.locations.find((entry) => entry.id === lot.storageLocationId);
  if (!location || location.householdId !== lot.householdId) {
    throw new InventoryReadAuthorityError('CORRUPT_LOT_ROW', `Lot ${lot.id} references a missing or foreign storage location`);
  }
  return location.type.toLowerCase();
}

function toReadItem(snapshot: MappedLotSnapshot, mapped: { lot: InventoryLot; legacyItemId: string | null },
  now: number): InventoryReadItem {
  const { lot, legacyItemId } = mapped;
  if (lot.state === 'ACTIVE' && lot.quantityMilli <= 0) {
    throw new InventoryReadAuthorityError('CORRUPT_LOT_ROW', `Lot ${lot.id}: ${READ_STATE_QUANTITY}`);
  }
  if (lot.state !== 'ACTIVE' && lot.quantityMilli !== 0) {
    throw new InventoryReadAuthorityError('CORRUPT_LOT_ROW', `Lot ${lot.id}: ${READ_STATE_QUANTITY}`);
  }
  // Mapping evidence: backfilled lots must match the retained adoption
  // witness; native lots must be self-identified. Forged or missing mapping
  // evidence fails closed instead of resolving through the projection.
  if (legacyItemId === null || !authoritativeMapping(lot, legacyItemId, snapshot.adoptedMappings)) {
    throw new InventoryReadAuthorityError('MAPPING_CORRUPT', `Lot ${lot.id} lacks authoritative mapping evidence`);
  }
  const expiry = expiryProjection(lot);
  const category = snapshot.ingredients.find((ingredient) => ingredient.id === lot.ingredientId)?.category ?? 'other';
  let freshness: InventoryReadItem['freshness'];
  try {
    freshness = computeReadFreshness(expiry.expiry_date, lot.state, now);
  } catch (error) {
    if (error instanceof InventoryReadFreshnessError) throw new InventoryReadAuthorityError('CORRUPT_LOT_ROW', `Lot ${lot.id}: ${error.message}`);
    throw error;
  }
  // Exact canonical display first (fails closed on lossy REAL projections),
  // then the retained legacy display alias when it round-trips exactly. The
  // projection row supplies only the *unit label*, never a quantity.
  const canonicalDisplay = exactLegacyQuantity(lot.quantityMilli, lot.canonicalUnit);
  const retainedUnit = snapshot.legacyRows.find((row) => row.id === legacyItemId)?.unit ?? null;
  const display = displayQuantity(lot.quantityMilli, lot.canonicalUnit, retainedUnit);
  return InventoryReadItemSchema.parse({
    lotId: lot.id, legacyItemId, householdId: lot.householdId, ingredientId: lot.ingredientId,
    name: lot.rawName, quantityMilli: lot.quantityMilli, canonicalUnit: lot.canonicalUnit,
    quantity: display.unit === lot.canonicalUnit ? canonicalDisplay : display.quantity, unit: display.unit,
    storageLocationId: lot.storageLocationId, storage: displayStorage(snapshot, lot),
    purchasedAt: lot.purchasedAt, openedAt: lot.openedAt, expiryAt: lot.expiryAt,
    estimatedExpiryAt: lot.estimatedExpiryAt, expiryKind: lot.expiryKind, state: lot.state,
    version: lot.version, legacyVersion: lot.legacyVersion, sourceType: lot.sourceType,
    sourceId: lot.sourceId, createdAt: lot.createdAt, updatedAt: lot.updatedAt,
    category, freshness,
  });
}

function validateSnapshot(snapshot: MappedLotSnapshot): void {
  // Duplicate authoritative mapping would make external identity ambiguous.
  const mappings = snapshot.lots.map(({ legacyItemId }) => legacyItemId).filter((id) => id !== null);
  if (new Set(mappings).size !== mappings.length) {
    throw new InventoryReadAuthorityError('MAPPING_CORRUPT', 'Duplicate authoritative legacy mapping');
  }
}

export async function readInventoryAuthority(db: D1DatabaseBinding,
  scope: { householdId: string; actorId: string }, query: InventoryReadQuery = {}
): Promise<InventoryReadAuthorityResult> {
  const now = query.now ?? Date.now();
  if (!Number.isFinite(now)) throw new InventoryReadAuthorityError('INVALID_READ_QUERY', 'now must be a finite epoch millisecond');
  const limit = query.limit ?? MAX_READ_AUTHORITY_LOTS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_AUTHORITY_LOTS) {
    throw new InventoryReadAuthorityError('INVALID_READ_QUERY', `limit must be 1..${MAX_READ_AUTHORITY_LOTS}`);
  }
  const snapshot = await readAdoptedLotSnapshot(db, scope);
  validateSnapshot(snapshot);
  const active = query.includeTerminal === true
    ? snapshot.lots : snapshot.lots.filter(({ lot }) => lot.state === 'ACTIVE');
  if (active.length > limit) throw new InventoryReadAuthorityError('READ_LIMIT_EXCEEDED',
    `Inventory view exceeds the read bound of ${limit} lots`);
  return {
    inventoryVersion: snapshot.inventoryVersion,
    items: active.map((mapped) => toReadItem(snapshot, mapped, now)),
  };
}

export async function readInventoryLot(db: D1DatabaseBinding,
  scope: { householdId: string; actorId: string },
  ref: { lotId?: string; legacyItemId?: string }): Promise<InventoryReadItem> {
  const lotId = ref.lotId, legacyItemId = ref.legacyItemId;
  if ((lotId === undefined) === (legacyItemId === undefined)) {
    throw new InventoryReadAuthorityError('INVALID_READ_QUERY', 'Resolve by exactly one of lotId or legacyItemId');
  }
  const { items } = await readInventoryAuthority(db, scope, { includeTerminal: true });
  const found = items.find((item) => (lotId !== undefined ? item.lotId === lotId : item.legacyItemId === legacyItemId));
  // Cross-tenant references are not-found, never an existence leak.
  if (!found) throw new InventoryReadAuthorityError('LOT_NOT_FOUND');
  return found;
}

export interface InventorySummary {
  inventoryVersion: number;
  activeCount: number;
  items: InventoryReadItem[];
}

export async function readInventorySummary(db: D1DatabaseBinding,
  scope: { householdId: string; actorId: string },
  filter: { ingredientIds?: string[] } = {}): Promise<InventorySummary> {
  const { inventoryVersion, items } = await readInventoryAuthority(db, scope);
  const ingredientIds = filter.ingredientIds;
  if (ingredientIds !== undefined) {
    if (!Array.isArray(ingredientIds) || ingredientIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
      throw new InventoryReadAuthorityError('INVALID_READ_QUERY', 'ingredientIds must be short strings');
    }
    const wanted = new Set(ingredientIds);
    const filtered = items.filter((item) => item.ingredientId !== null && wanted.has(item.ingredientId));
    // activeCount always describes the returned summary, never a hidden superset.
    return { inventoryVersion, activeCount: filtered.length, items: filtered };
  }
  return { inventoryVersion, activeCount: items.length, items };
}

// Bounded parity checker: adopted inventory may keep a compatibility
// projection, but it must mirror authority. Returns diagnostics; never
// repairs. Reads stay authoritative even while parity is violated.
export async function assertProjectionParity(db: D1DatabaseBinding,
  scope: { householdId: string; actorId: string }): Promise<ProjectionParityDiagnostic[]> {
  const snapshot = await readAdoptedLotSnapshot(db, scope);
  validateSnapshot(snapshot);
  const diagnostics: ProjectionParityDiagnostic[] = [];
  for (const mapped of snapshot.lots) {
    const { lot, legacyItemId } = mapped;
    const row = snapshot.legacyRows.find((entry) => entry.id === legacyItemId);
    if (!row) {
      diagnostics.push({ code: 'MISSING_PROJECTION', lotId: lot.id, legacyItemId, detail: 'No compatibility projection row' });
      continue;
    }
    if (!authoritativeMapping(lot, legacyItemId!, snapshot.adoptedMappings)) {
      diagnostics.push({ code: 'MAPPING_CORRUPT', lotId: lot.id, legacyItemId, detail: 'Mapping evidence mismatch' });
      continue;
    }
    if (lot.householdId !== scope.householdId || row.household_id !== scope.householdId) {
      diagnostics.push({ code: 'IDENTITY_DRIFT', lotId: lot.id, legacyItemId, detail: 'Cross-household identity' });
      continue;
    }
    let quantityMatches = false;
    try {
      const displayUnit = row.unit === 'kg' ? 'g' : row.unit === 'l' ? 'ml' : row.unit;
      quantityMatches = displayUnit === lot.canonicalUnit
        && exactLotQuantity(row.quantity, row.unit) === lot.quantityMilli;
    } catch { /* Invalid compatibility stock is drift, never a repair request. */ }
    if (!quantityMatches) {
      const unitMatches = (row.unit === 'kg' ? 'g' : row.unit === 'l' ? 'ml' : row.unit) === lot.canonicalUnit;
      diagnostics.push({ code: unitMatches ? 'QUANTITY_DRIFT' : 'UNIT_DRIFT', lotId: lot.id, legacyItemId,
        detail: `Projection ${row.quantity}${row.unit} vs lot ${lot.quantityMilli}milli/${lot.canonicalUnit}` });
      continue;
    }
    const location = snapshot.locations.find((entry) => entry.id === lot.storageLocationId);
    if (!location || location.householdId !== scope.householdId || location.type.toLowerCase() !== row.storage) {
      diagnostics.push({ code: 'STORAGE_DRIFT', lotId: lot.id, legacyItemId, detail: 'Projection storage diverges' });
      continue;
    }
    if (row.version !== lot.legacyVersion) {
      diagnostics.push({ code: 'VERSION_DRIFT', lotId: lot.id, legacyItemId,
        detail: `Projection version ${row.version} vs lot legacyVersion ${lot.legacyVersion}` });
      continue;
    }
    const expiry = expiryProjection(lot);
    const historicalUnknown = lot.expiryKind === 'UNKNOWN' && row.expiry_date === lot.legacyExpiryAt;
    if (row.expiry_date !== expiry.expiry_date && !historicalUnknown
      || row.expiry_kind !== expiry.expiry_kind || row.expiry_source !== expiry.expiry_source) {
      diagnostics.push({ code: 'EXPIRY_DRIFT', lotId: lot.id, legacyItemId, detail: 'Projection expiry diverges' });
      continue;
    }
    if ((row.opened_at ?? null) !== lot.openedAt) {
      diagnostics.push({ code: 'OPENED_DRIFT', lotId: lot.id, legacyItemId, detail: 'Projection opened state diverges' });
      continue;
    }
    if ((lot.state === 'ACTIVE' ? lot.quantityMilli <= 0 : lot.quantityMilli !== 0)) {
      diagnostics.push({ code: 'TERMINAL_STATE_DRIFT', lotId: lot.id, legacyItemId, detail: READ_STATE_QUANTITY });
    }
  }
  return diagnostics;
}

function exactLotQuantity(quantity: number, unit: string): number {
  // Same round-trip rule the projection writer uses; kg/l are display aliases.
  return toLotQuantity(quantity, unit).quantityMilli;
}
