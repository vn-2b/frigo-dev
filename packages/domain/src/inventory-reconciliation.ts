import { z } from 'zod';
import {
  InventoryObservationSchema, MAX_OBSERVATIONS_PER_RECONCILIATION, MAX_OBSERVATION_SNAPSHOT_LOTS,
  ObservationError, type InventoryObservation,
} from './inventory-observations';
import { InventoryLotSchema, StorageLocationSchema, type InventoryLot, type StorageLocation } from './inventory-truth';

// T10D pure deterministic reconciliation planner. Input is an authoritative
// lot snapshot plus observations; output classifies each observation and, when
// justified, carries the exact T09 commands a confirmed decision would compose.
// The planner never mutates anything and never invents certainty: no name-only
// matching, no contextual unit conversions into mass/volume, no
// estimated-over-confirmed expiry.
export const ReconciliationVerdict = z.enum([
  'MATCH', 'NO_ACTION', 'STALE_OBSERVATION', 'AMBIGUOUS', 'CONFLICT',
  'PROPOSE_CORRECTION', 'PROPOSE_MOVE', 'PROPOSE_EXPIRY_UPDATE', 'UNSUPPORTED',
]);
export type ReconciliationVerdict = z.infer<typeof ReconciliationVerdict>;

export const MAX_RECONCILIATION_PROPOSALS_PER_FINDING = 2;

const CorrectProposal = z.object({
  type: z.literal('CORRECT'),
  lotId: z.string().min(1),
  expectedVersion: z.number().int().safe().positive(),
  changes: z.object({
    quantity: z.number().finite().nonnegative().optional(),
    unit: z.enum(['g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice']).optional(),
    expiryAt: z.string().date().nullable().optional(),
    estimatedExpiryAt: z.string().date().nullable().optional(),
    expiryKind: z.enum(['KNOWN', 'BEST_BEFORE', 'USE_BY', 'ESTIMATED']).optional(),
    openedAt: z.string().datetime({ offset: true }).nullable().optional(),
  }).strict().refine((changes) => Object.values(changes).some((value) => value !== undefined), 'Empty correction'),
}).strict();
const MoveProposal = z.object({
  type: z.literal('MOVE'),
  lotId: z.string().min(1),
  expectedVersion: z.number().int().safe().positive(),
  storageLocationId: z.string().min(1),
}).strict();
const FindingProposal = z.union([CorrectProposal, MoveProposal]);
export type ReconciliationProposal = z.infer<typeof FindingProposal>;

export const ReconciliationFindingSchema = z.object({
  observationId: z.string().min(1),
  verdict: ReconciliationVerdict,
  reasons: z.array(z.string().min(1)).max(8),
  matchedLotId: z.string().min(1).nullable(),
  // Exact T09 command inputs a confirmed decision would compose (at most one
  // CORRECT and one MOVE on the same lot version, applied as one batch).
  proposals: z.array(FindingProposal).max(MAX_RECONCILIATION_PROPOSALS_PER_FINDING),
}).strict();
export type ReconciliationFinding = z.infer<typeof ReconciliationFindingSchema>;

export const ReconciliationSnapshotSchema = z.object({
  inventoryVersion: z.number().int().safe().positive(),
  // Authoritative lots paired with their retained legacy projection identity
  // (null for native lots) — the T09 mapped-lot shape, not name-derived.
  lots: z.array(z.object({
    lot: InventoryLotSchema,
    legacyItemId: z.string().min(1).nullable(),
  }).strict()).max(MAX_OBSERVATION_SNAPSHOT_LOTS),
  locations: z.array(StorageLocationSchema).max(MAX_OBSERVATION_SNAPSHOT_LOTS),
}).strict();
export type ReconciliationSnapshot = z.infer<typeof ReconciliationSnapshotSchema>;

const KNOWN_EXPIRY_KINDS = new Set(['KNOWN', 'BEST_BEFORE', 'USE_BY']);

interface Step {
  verdict: ReconciliationVerdict | null;
  proposal: ReconciliationProposal | null;
  reason: string | null;
}

function storageTypeOf(locationId: string, locations: StorageLocation[]): 'fridge' | 'freezer' | 'pantry' | null {
  const location = locations.find((entry) => entry.id === locationId);
  return location ? location.type.toLowerCase() as 'fridge' | 'freezer' | 'pantry' : null;
}

function resolveCandidate(observation: InventoryObservation, snapshot: ReconciliationSnapshot): {
  lot: InventoryLot | null; verdict: ReconciliationVerdict | null; reasons: string[];
} {
  // 1. Explicit native lot identity — highest authority.
  if (observation.lotId !== null) {
    const entry = snapshot.lots.find((candidate) => candidate.lot.id === observation.lotId
      && candidate.lot.householdId === observation.householdId);
    if (!entry) return { lot: null, verdict: 'STALE_OBSERVATION', reasons: ['REFERENCED_LOT_NOT_FOUND'] };
    return { lot: entry.lot, verdict: null, reasons: [] };
  }
  // 2. Explicit retained legacy mapping — via the projection identity only.
  if (observation.legacyItemId !== null) {
    const entry = snapshot.lots.find((candidate) => candidate.legacyItemId === observation.legacyItemId
      && candidate.lot.householdId === observation.householdId);
    if (!entry) return { lot: null, verdict: 'STALE_OBSERVATION', reasons: ['REFERENCED_PROJECTION_NOT_FOUND'] };
    return { lot: entry.lot, verdict: null, reasons: [] };
  }
  // 3. Explicit canonical ingredient identity with bounded compatible
  //    candidates. Name-only matching is never allowed.
  if (observation.ingredientId !== null) {
    const compatible = snapshot.lots.filter((candidate) =>
      candidate.lot.householdId === observation.householdId
      && candidate.lot.ingredientId === observation.ingredientId
      && candidate.lot.state === 'ACTIVE');
    if (compatible.length === 0) return { lot: null, verdict: 'UNSUPPORTED', reasons: ['NO_MATCHING_LOT'] };
    if (observation.claim.canonicalUnit !== null) {
      const unitCompatible = compatible.filter((candidate) => candidate.lot.canonicalUnit === observation.claim.canonicalUnit);
      if (unitCompatible.length === 0) return { lot: null, verdict: 'UNSUPPORTED', reasons: ['INCOMPATIBLE_UNIT'] };
      if (unitCompatible.length > 1) return { lot: null, verdict: 'AMBIGUOUS', reasons: ['MULTIPLE_UNIT_CANDIDATES'] };
      return { lot: unitCompatible[0].lot, verdict: null, reasons: [] };
    }
    if (compatible.length > 1) return { lot: null, verdict: 'AMBIGUOUS', reasons: ['MULTIPLE_CANDIDATES'] };
    return { lot: compatible[0].lot, verdict: null, reasons: [] };
  }
  return { lot: null, verdict: 'UNSUPPORTED', reasons: ['IDENTITY_UNKNOWN'] };
}

function quantityStep(observation: InventoryObservation, lot: InventoryLot): Step {
  const claim = observation.claim;
  if (claim.quantityMilli === null || claim.canonicalUnit === null) {
    return { verdict: null, proposal: null, reason: null };
  }
  if (claim.canonicalUnit !== lot.canonicalUnit) {
    return { verdict: 'UNSUPPORTED', proposal: null, reason: 'INCOMPATIBLE_UNIT' };
  }
  if (claim.quantityMilli === lot.quantityMilli) return { verdict: null, proposal: null, reason: null };
  // Evidence gate: only OBSERVED/CONFIRMED/VERIFIED quantity may propose a
  // correction; an ESTIMATED quantity records the contradiction but never
  // becomes an automatic fix. UNKNOWN cannot reach here (schema forbids it).
  if (observation.evidence === 'ESTIMATED') {
    return { verdict: 'CONFLICT', proposal: null, reason: 'ESTIMATED_QUANTITY_CONFLICT' };
  }
  return {
    verdict: 'PROPOSE_CORRECTION',
    proposal: {
      type: 'CORRECT', lotId: lot.id, expectedVersion: lot.version,
      changes: { quantity: claim.quantity ?? undefined, unit: claim.unit ?? undefined },
    },
    reason: 'QUANTITY_MISMATCH',
  };
}

function storageStep(observation: InventoryObservation, lot: InventoryLot, snapshot: ReconciliationSnapshot): Step {
  if (observation.claim.storage === null) return { verdict: null, proposal: null, reason: null };
  const actual = storageTypeOf(lot.storageLocationId, snapshot.locations);
  if (actual === null) return { verdict: 'CONFLICT', proposal: null, reason: 'LOCATION_UNRESOLVABLE' };
  if (actual === observation.claim.storage) return { verdict: null, proposal: null, reason: null };
  if (observation.evidence === 'ESTIMATED' || observation.evidence === 'UNKNOWN') {
    return { verdict: 'CONFLICT', proposal: null, reason: 'ESTIMATED_STORAGE_CONFLICT' };
  }
  const target = snapshot.locations.find((entry) =>
    entry.householdId === observation.householdId
    && entry.type.toLowerCase() === observation.claim.storage
    && entry.isDefault);
  if (!target) return { verdict: 'CONFLICT', proposal: null, reason: 'TARGET_LOCATION_UNRESOLVABLE' };
  return {
    verdict: 'PROPOSE_MOVE',
    proposal: { type: 'MOVE', lotId: lot.id, expectedVersion: lot.version, storageLocationId: target.id },
    reason: 'STORAGE_MISMATCH',
  };
}

function expiryStep(observation: InventoryObservation, lot: InventoryLot): Step {
  const claim = observation.claim;
  if (claim.expiryDate === null || claim.expiryKind === null) return { verdict: null, proposal: null, reason: null };
  const claimIsEstimated = claim.expiryKind === 'ESTIMATED';
  const lotConfirmed = lot.expiryAt !== null && lot.expiryKind !== null && KNOWN_EXPIRY_KINDS.has(lot.expiryKind);
  const lotEstimated = lot.estimatedExpiryAt !== null;
  if (claimIsEstimated) {
    if (lotConfirmed) {
      // Confirmed authority wins; the contradiction is surfaced, never applied.
      return claim.expiryDate === lot.expiryAt
        ? { verdict: null, proposal: null, reason: null }
        : { verdict: 'CONFLICT', proposal: null, reason: 'ESTIMATED_EXPIRY_VS_CONFIRMED' };
    }
    if (lotEstimated) {
      return claim.expiryDate === lot.estimatedExpiryAt
        ? { verdict: null, proposal: null, reason: null }
        : { verdict: 'CONFLICT', proposal: null, reason: 'ESTIMATED_EXPIRY_MISMATCH' };
    }
    // An estimate cannot create expiry authority from absence.
    return { verdict: 'NO_ACTION', proposal: null, reason: 'ESTIMATED_EXPIRY_NO_AUTHORITY' };
  }
  if (lotConfirmed) {
    if (observation.evidence === 'ESTIMATED' || observation.evidence === 'UNKNOWN') {
      // Confirmed authority wins; the contradiction is surfaced, never applied.
      return { verdict: 'CONFLICT', proposal: null, reason: 'ESTIMATED_EXPIRY_VS_CONFIRMED' };
    }
    // Direct observed/confirmed evidence may propose replacing the stored
    // expiry, but only through an explicitly confirmed decision.
    return claim.expiryDate === lot.expiryAt
      ? { verdict: null, proposal: null, reason: null }
      : {
          verdict: 'PROPOSE_EXPIRY_UPDATE',
          proposal: {
            type: 'CORRECT', lotId: lot.id, expectedVersion: lot.version,
            changes: { expiryAt: claim.expiryDate, expiryKind: claim.expiryKind },
          },
          reason: 'EXPIRY_MISMATCH',
        };
  }
  if (lotEstimated && claim.expiryDate === lot.estimatedExpiryAt) {
    // Same date currently held as an estimate: a confirmed/observed claim
    // upgrades the evidence class, which is a justified correction.
    return {
      verdict: 'PROPOSE_EXPIRY_UPDATE',
      proposal: {
        type: 'CORRECT', lotId: lot.id, expectedVersion: lot.version,
        changes: { expiryAt: claim.expiryDate, expiryKind: claim.expiryKind },
      },
      reason: 'EXPIRY_EVIDENCE_UPGRADE',
    };
  }
  if (observation.evidence === 'ESTIMATED' || observation.evidence === 'UNKNOWN') {
    return { verdict: 'CONFLICT', proposal: null, reason: 'EXPIRY_CONFLICT' };
  }
  return {
    verdict: 'PROPOSE_EXPIRY_UPDATE',
    proposal: {
      type: 'CORRECT', lotId: lot.id, expectedVersion: lot.version,
      changes: { expiryAt: claim.expiryDate, expiryKind: claim.expiryKind },
    },
    reason: 'EXPIRY_MISMATCH',
  };
}

function openedStep(observation: InventoryObservation, lot: InventoryLot): Step {
  if (observation.claim.openedAt === null) return { verdict: null, proposal: null, reason: null };
  if (lot.openedAt === observation.claim.openedAt) return { verdict: null, proposal: null, reason: null };
  if (observation.evidence === 'ESTIMATED' || observation.evidence === 'UNKNOWN') {
    return { verdict: 'CONFLICT', proposal: null, reason: 'ESTIMATED_OPENED_CONFLICT' };
  }
  return {
    verdict: 'PROPOSE_CORRECTION',
    proposal: {
      type: 'CORRECT', lotId: lot.id, expectedVersion: lot.version,
      changes: { openedAt: observation.claim.openedAt },
    },
    reason: 'OPENED_MISMATCH',
  };
}

function evaluateOne(observation: InventoryObservation, snapshot: ReconciliationSnapshot): ReconciliationFinding {
  const base = { observationId: observation.observationId, matchedLotId: null as string | null };
  if (observation.status !== 'OPEN') {
    return { ...base, verdict: 'NO_ACTION', reasons: ['OBSERVATION_NOT_OPEN'], proposals: [] };
  }
  if (observation.authoritativeInventoryVersion !== snapshot.inventoryVersion) {
    return { ...base, verdict: 'STALE_OBSERVATION', reasons: ['INVENTORY_VERSION_DRIFT'], proposals: [] };
  }
  const resolution = resolveCandidate(observation, snapshot);
  if (resolution.verdict !== null) {
    return { ...base, verdict: resolution.verdict, reasons: resolution.reasons, proposals: [] };
  }
  const lot = resolution.lot!;
  if (lot.state !== 'ACTIVE') {
    return { ...base, verdict: 'STALE_OBSERVATION', reasons: ['REFERENCED_LOT_TERMINAL'], proposals: [] };
  }
  const steps = {
    quantity: quantityStep(observation, lot),
    storage: storageStep(observation, lot, snapshot),
    expiry: expiryStep(observation, lot),
    opened: openedStep(observation, lot),
  };
  const reasons = Object.values(steps).map((step) => step.reason).filter((reason) => reason !== null);
  const hardUnsupported = Object.values(steps).find((step) => step.verdict === 'UNSUPPORTED');
  if (hardUnsupported) {
    return { ...base, verdict: 'UNSUPPORTED', reasons, matchedLotId: lot.id, proposals: [] };
  }
  const conflicts = Object.values(steps).filter((step) => step.verdict === 'CONFLICT');
  if (conflicts.length > 0) {
    return { ...base, verdict: 'CONFLICT', reasons, matchedLotId: lot.id, proposals: [] };
  }
  const proposals = Object.values(steps)
    .filter((step) => step.proposal !== null)
    .map((step) => step.proposal!);
  if (proposals.length === 0) {
    return { ...base, verdict: 'MATCH', reasons, matchedLotId: lot.id, proposals: [] };
  }
  // All proposals must act on the same lot version to compose atomically.
  if (!proposals.every((proposal) => proposal.expectedVersion === lot.version)) {
    return { ...base, verdict: 'CONFLICT', reasons: [...reasons, 'PROPOSAL_VERSION_CONFLICT'], matchedLotId: lot.id, proposals: [] };
  }
  const verdict = proposals.some((proposal) => proposal.type === 'CORRECT')
    ? proposals.some((proposal) => proposal.type === 'CORRECT'
      && proposal.changes.expiryAt !== undefined
      && proposal.changes.quantity === undefined && proposal.changes.openedAt === undefined)
      ? 'PROPOSE_EXPIRY_UPDATE' : 'PROPOSE_CORRECTION'
    : 'PROPOSE_MOVE';
  return { ...base, verdict, reasons, matchedLotId: lot.id, proposals };
}

export function planInventoryReconciliation(snapshot: ReconciliationSnapshot,
  observations: InventoryObservation[]): ReconciliationFinding[] {
  if (observations.length > MAX_OBSERVATIONS_PER_RECONCILIATION) {
    throw new ObservationError('OBSERVATION_BATCH_TOO_LARGE');
  }
  ReconciliationSnapshotSchema.parse(snapshot);
  for (const observation of observations) InventoryObservationSchema.parse(observation);
  return observations.map((observation) => evaluateOne(observation, snapshot));
}
