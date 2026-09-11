import { z } from 'zod';
import { CanonicalIngredientIdSchema } from './foundation';

// T10 observation evidence contract. Observations are durable evidence about
// stock, never stock itself: persistence must not mutate inventory_items or
// inventory_lots, and only an explicit reconciliation decision may compose
// existing T09 authority commands afterwards.
export const MAX_OBSERVATION_SOURCE_REF = 200;
export const MAX_OBSERVATION_RAW_NAME = 200;
export const MAX_OBSERVATION_NOTE = 1000;
export const MAX_OBSERVATIONS_PER_RECONCILIATION = 32;
export const MAX_OBSERVATION_SNAPSHOT_LOTS = 1000;

export const ObservationSourceType = z.enum(['MANUAL', 'SCAN', 'RECEIPT', 'SHOPPING', 'HEURISTIC']);
export type ObservationSourceType = z.infer<typeof ObservationSourceType>;

// Categorical evidence states only. There is deliberately no numeric
// confidence: no calibrated system exists that would give one meaning.
//   UNKNOWN   - presence not established; cannot carry a quantity claim
//   ESTIMATED - derived (heuristic expiry, estimated shelf life)
//   OBSERVED  - directly observed by the source, not yet actor-confirmed
//   CONFIRMED - explicitly confirmed by an actor
//   VERIFIED  - cross-checked against immutable T09 receipt/adoption evidence
export const ObservationEvidence = z.enum(['UNKNOWN', 'ESTIMATED', 'OBSERVED', 'CONFIRMED', 'VERIFIED']);
export type ObservationEvidence = z.infer<typeof ObservationEvidence>;

export const ObservationStatus = z.enum(['OPEN', 'RECONCILED', 'STALE']);
export type ObservationStatus = z.infer<typeof ObservationStatus>;

const Identity = z.string().min(1).refine((value) => value === value.trim() && !value.includes('\0'));
const BoundedText = (max: number) => z.string().max(max).refine((value) => value === value.trim() && !value.includes('\0'));
const RawName = BoundedText(MAX_OBSERVATION_RAW_NAME);
const CalendarDate = z.string().date();
const Instant = z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)));
const StorageBucket = z.enum(['fridge', 'freezer', 'pantry']);
const ObservedUnit = z.enum(['g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice']);
const CanonicalUnit = z.enum(['g', 'ml', 'piece', 'pack', 'bunch', 'slice']);

const ObservationClaim = z.object({
  quantity: z.number().finite().nonnegative().nullable().default(null),
  unit: ObservedUnit.nullable().default(null),
  quantityMilli: z.number().int().safe().nonnegative().nullable().default(null),
  canonicalUnit: CanonicalUnit.nullable().default(null),
  storage: StorageBucket.nullable().default(null),
  expiryDate: CalendarDate.nullable().default(null),
  expiryKind: z.enum(['KNOWN', 'BEST_BEFORE', 'USE_BY', 'ESTIMATED']).nullable().default(null),
  openedAt: Instant.nullable().default(null),
}).strict().superRefine((claim, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if ((claim.quantity === null) !== (claim.unit === null)) issue('unit', 'Quantity and unit must be recorded together');
  if ((claim.quantityMilli === null) !== (claim.canonicalUnit === null)) issue('canonicalUnit', 'Normalized quantity and canonical unit must be recorded together');
  if ((claim.expiryDate === null) !== (claim.expiryKind === null)) issue('expiryKind', 'Expiry date and kind must be recorded together');
  if (claim.quantity === null && claim.storage === null && claim.expiryDate === null && claim.openedAt === null) {
    issue('quantity', 'An observation requires at least one claim');
  }
  if (claim.quantity === 0 && claim.quantityMilli !== null && claim.quantityMilli !== 0) {
    issue('quantityMilli', 'Zero quantity claims must normalize to zero');
  }
});

export const InventoryObservationSchema = z.object({
  observationId: Identity,
  householdId: Identity,
  sourceType: ObservationSourceType,
  sourceRef: BoundedText(MAX_OBSERVATION_SOURCE_REF),
  fingerprint: z.string().min(1),
  observedAt: Instant,
  recordedAt: Instant,
  ingredientId: CanonicalIngredientIdSchema.nullable(),
  rawName: RawName.nullable(),
  lotId: Identity.nullable(),
  legacyItemId: Identity.nullable(),
  evidence: ObservationEvidence,
  note: z.string().max(MAX_OBSERVATION_NOTE).refine((value) => !value.includes('\0')).nullable(),
  authoritativeInventoryVersion: z.number().int().safe().positive(),
  status: ObservationStatus.default('OPEN'),
  version: z.number().int().safe().positive().default(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  claim: ObservationClaim,
}).strict().superRefine((observation, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (observation.ingredientId === null && observation.rawName === null
    && observation.lotId === null && observation.legacyItemId === null) {
    issue('ingredientId', 'An observation requires some subject identity');
  }
  if (observation.evidence === 'UNKNOWN' && observation.claim.quantity !== null) {
    issue('evidence', 'UNKNOWN evidence cannot carry a quantity claim');
  }
  if (observation.evidence === 'ESTIMATED' && observation.claim.expiryKind !== null
    && observation.claim.expiryKind !== 'ESTIMATED') {
    issue('expiryKind', 'ESTIMATED evidence may only claim estimated expiry');
  }
  if (observation.evidence !== 'ESTIMATED' && observation.claim.expiryKind === 'ESTIMATED') {
    issue('expiryKind', 'Non-estimated evidence cannot claim estimated expiry');
  }
});
export type InventoryObservation = z.infer<typeof InventoryObservationSchema>;

// Input is the external observation shape before persistence assigns identity.
export const InventoryObservationInputSchema = z.object({
  sourceType: ObservationSourceType,
  sourceRef: BoundedText(MAX_OBSERVATION_SOURCE_REF),
  observedAt: Instant,
  ingredientId: CanonicalIngredientIdSchema.nullable().default(null),
  rawName: RawName.nullable().default(null),
  lotId: Identity.nullable().default(null),
  legacyItemId: Identity.nullable().default(null),
  evidence: ObservationEvidence,
  note: z.string().max(MAX_OBSERVATION_NOTE).refine((value) => !value.includes('\0')).nullable().default(null),
  claim: ObservationClaim,
}).strict().superRefine((input, ctx) => {
  if (input.ingredientId === null && input.rawName === null && input.lotId === null && input.legacyItemId === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ingredientId'], message: 'An observation requires some subject identity' });
  }
});
export type InventoryObservationInput = z.infer<typeof InventoryObservationInputSchema>;

// Canonical semantic payload: same external evidence => same fingerprint.
// Timestamps of recording are deliberately excluded from identity.
export function observationFingerprint(input: InventoryObservationInput): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object') return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => [key, sort(entry)]),
    );
    return item;
  };
  return JSON.stringify(sort({
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
    ingredientId: input.ingredientId,
    rawName: input.rawName,
    lotId: input.lotId,
    legacyItemId: input.legacyItemId,
    evidence: input.evidence,
    note: input.note,
    claim: input.claim,
  }));
}

export function observationIdentity(householdId: string, sourceType: ObservationSourceType, sourceRef: string): string {
  // Deterministic identity for replay/idempotency; never timestamp-based.
  return `t10-observation:${householdId}:${sourceType}:${sourceRef}`;
}

export class ObservationError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'ObservationError';
  }
}
