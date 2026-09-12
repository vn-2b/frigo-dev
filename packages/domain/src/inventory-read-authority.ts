import { z } from 'zod';
import { CanonicalIngredientIdSchema } from './foundation';

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
