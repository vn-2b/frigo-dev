import { z } from 'zod';
import { CanonicalIngredientIdSchema } from './foundation';
import { toLotQuantity } from './inventory-truth';

// Same identity contract as inventory lots: non-empty, trimmed, no NULs.
const Identity = z.string().min(1).refine((value) => value === value.trim() && !value.includes('\0'));

// T11 canonical read model: what every Frigo product flow sees when it asks
// "what inventory currently exists". Derived only from inventory_lots plus
// validated authority metadata (retained legacy mapping, storage locations,
// ingredient registry, household inventory version). The compatibility
// projection (inventory_items) never decides content here.

export const InventoryReadState = z.enum(['ACTIVE', 'CONSUMED', 'DISCARDED']);
export type InventoryReadState = z.infer<typeof InventoryReadState>;

export const InventoryReadItemSchema = z.object({
  // Authoritative identity.
  lotId: Identity,
  // Retained mapping evidence: the legacy projection id this lot feeds
  // (backfilled lots carry the legacy id; native lots carry their own id as
  // written by the T09 authority). Never inferred by equal-ID assumption.
  legacyItemId: Identity.nullable(),
  householdId: Identity,
  ingredientId: CanonicalIngredientIdSchema.nullable(),
  name: z.string(),
  // Exact authority quantity plus its display projection.
  quantityMilli: z.number().int().safe().nonnegative(),
  canonicalUnit: z.enum(['g', 'ml', 'piece', 'pack', 'bunch', 'slice']),
  quantity: z.number(),
  unit: z.string(),
  storageLocationId: Identity,
  storage: z.string(),
  purchasedAt: z.string().nullable(),
  openedAt: z.string().nullable(),
  // UNKNOWN != ZERO, ESTIMATED != CONFIRMED are preserved explicitly.
  expiryAt: z.string().nullable(),
  estimatedExpiryAt: z.string().nullable(),
  expiryKind: z.enum(['KNOWN', 'BEST_BEFORE', 'USE_BY', 'ESTIMATED', 'UNKNOWN']),
  state: InventoryReadState,
  version: z.number().int().safe().positive(),
  legacyVersion: z.number().int().safe().positive().nullable(),
  sourceType: z.enum(['LEGACY_BACKFILL', 'MANUAL', 'SCAN', 'SHOPPING', 'RECEIPT']),
  sourceId: Identity.nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  // Display/compatibility derivations (never authority inputs).
  category: z.string(),
  freshness: z.enum(['fresh', 'use_soon', 'expiring', 'out_of_stock']),
}).strict();

export type InventoryReadItem = z.infer<typeof InventoryReadItemSchema>;

export interface InventoryReadQuery {
  // Current-inventory views exclude terminal stock by default; historical
  // views may include CONSUMED/DISCARDED lots deliberately.
  includeTerminal?: boolean;
  limit?: number;
  // Epoch milliseconds used for freshness derivation; defaults to Date.now().
  now?: number;
}

export interface InventoryReadAuthorityResult {
  // Snapshot freshness evidence at read time (household optimistic version).
  inventoryVersion: number;
  items: InventoryReadItem[];
}

export interface ProjectionParityDiagnostic {
  code: 'MISSING_PROJECTION' | 'QUANTITY_DRIFT' | 'UNIT_DRIFT' | 'STORAGE_DRIFT'
    | 'VERSION_DRIFT' | 'EXPIRY_DRIFT' | 'OPENED_DRIFT' | 'IDENTITY_DRIFT'
    | 'MAPPING_CORRUPT' | 'TERMINAL_STATE_DRIFT';
  lotId: string;
  legacyItemId: string | null;
  detail: string;
}

export class InventoryReadFreshnessError extends Error {
  readonly code = 'CORRUPT_LOT_ROW' as const;
  constructor(message: string) { super(message); this.name = 'InventoryReadFreshnessError'; }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

// Deterministic freshness derivation over authority expiry fields. Invalid or
// impossible authoritative dates fail closed instead of decaying to "fresh"
// (Date.parse -> NaN would make every comparison false). `now` is injectable
// for tests; legacy thresholds (24h expiring, 72h use_soon) are unchanged.
export function computeReadFreshness(expiry: string | null, state: InventoryReadState,
  now: number = Date.now()): InventoryReadItem['freshness'] {
  if (state !== 'ACTIVE') return 'out_of_stock';
  if (expiry === null) return 'fresh';
  if (typeof expiry !== 'string' || !isCalendarDate(expiry)) {
    throw new InventoryReadFreshnessError(`Invalid authoritative expiry date: ${String(expiry)}`);
  }
  if (!Number.isFinite(now)) throw new InventoryReadFreshnessError('Invalid clock for freshness derivation');
  const parsed = Date.parse(expiry);
  if (!Number.isFinite(parsed)) throw new InventoryReadFreshnessError(`Unparseable authoritative expiry date: ${expiry}`);
  const hours = (parsed - now) / 3_600_000;
  return hours <= 24 ? 'expiring' : hours <= 72 ? 'use_soon' : 'fresh';
}

// Display/API compatibility for retained legacy display units. Authority is
// always (quantityMilli, canonicalUnit); presentation may use the exact
// mass/volume alias the legacy projection recorded (kg<->g, l<->ml) IF the
// alias belongs to the same semantic family AND round-trips exactly. Count and
// contextual units (piece/pack/bunch/slice) never convert. Anything unprovable
// falls back to canonical presentation — never to the projection's quantity.
const DISPLAY_ALIASES: Record<string, InventoryReadItem['canonicalUnit']> = { kg: 'g', l: 'ml' };
export function displayQuantity(quantityMilli: number, canonicalUnit: InventoryReadItem['canonicalUnit'],
  retainedDisplayUnit: string | null): { quantity: number; unit: string } {
  const canonical = { quantity: quantityMilli / 1000, unit: canonicalUnit };
  if (retainedDisplayUnit === null || retainedDisplayUnit === canonicalUnit) return canonical;
  if (DISPLAY_ALIASES[retainedDisplayUnit] !== canonicalUnit) return canonical;
  // kg/l are exactly 1000x the canonical unit, so the alias quantity is
  // quantityMilli / 1_000_000. Prove the round trip with the same exact
  // conversion the T09 projection writer uses before presenting it.
  const quantity = quantityMilli / 1_000_000;
  try {
    if (!Number.isFinite(quantity) || toLotQuantity(quantity, retainedDisplayUnit).quantityMilli !== quantityMilli) return canonical;
  } catch {
    return canonical;
  }
  return { quantity, unit: retainedDisplayUnit };
}
