import { z } from 'zod';
import { ObservationError, type InventoryObservation } from '../../domain/src/inventory-observations';
import {
  ReconciliationSnapshotSchema, planInventoryReconciliation,
  type ReconciliationFinding, type ReconciliationProposal, type ReconciliationSnapshot,
} from '../../domain/src/inventory-reconciliation';
import { InventoryLotSchema, StorageLocationSchema } from '../../domain/src/inventory-truth';
import {
  authorizedHousehold, composeInventoryLotCommands, sortedJson,
  type AnyLotCommandResult, type InventoryLotCommandScope, type LotCommandSpec,
} from './inventory-lot-commands';
import { parseObservationRow } from './inventory-observations';
import type { D1DatabaseBinding, D1PreparedStatement } from './index';

// T10E reconciliation decision authority. A confirmed decision composes
// EXISTING T09 lot-authority commands (CORRECT/MOVE) — it never issues SQL
// inventory updates and never creates a second ledger. Decision receipt, T09
// command receipts and the observation lifecycle commit in ONE atomic batch:
// an applied decision always implies the stock command committed.
export type ReconciliationDecisionType = 'CORRECT' | 'MOVE' | 'DISMISS';

export interface ReconciliationDecisionScope extends InventoryLotCommandScope {}
export interface ReconciliationDecisionInput {
  decisionKey: string;
  observationId: string;
  expectedObservationVersion: number;
  decisionType: ReconciliationDecisionType;
  proposals?: ReconciliationProposal[];
}
export interface ReconciliationDecisionExecution {
  decisionId: string;
  decisionType: ReconciliationDecisionType;
  observationId: string;
  observationVersion: number;
  executions: AnyLotCommandResult[];
  replayed: boolean;
}
export interface AppliedReconciliationDecision {
  id: string; household_id: string; observation_id: string; decision_key: string;
  fingerprint: string; decision_type: string; proposed_verdict: string; actor_id: string;
  expected_observation_version: number; command_id: string | null; result_json: string | null;
  created_at: string;
}

const Identity = z.string().min(1).refine((value) => value === value.trim() && !value.includes('\0'));
const Scope = z.object({ householdId: Identity, actorId: Identity }).strict();
const DecisionKey = Identity.refine((value) => value.length <= 160);
const ProposalSchema = z.union([
  z.object({ type: z.literal('CORRECT'), lotId: Identity, expectedVersion: z.number().int().safe().positive(),
    changes: z.record(z.string(), z.unknown()),
    // Only the actor's confirmation can declare how a zero-quantity
    // correction terminates a lot; the planner never fabricates it.
    terminalState: z.enum(['CONSUMED', 'DISCARDED']).optional() }).strict(),
  z.object({ type: z.literal('MOVE'), lotId: Identity, expectedVersion: z.number().int().safe().positive(),
    storageLocationId: Identity }).strict(),
]);
const DecisionInput = z.object({
  decisionKey: DecisionKey,
  observationId: Identity,
  expectedObservationVersion: z.number().int().safe().positive(),
  decisionType: z.enum(['CORRECT', 'MOVE', 'DISMISS']),
  proposals: z.array(ProposalSchema).max(2).optional(),
}).strict();

// Proposal-set invariant, independent of the planner: at most one CORRECT and
// one MOVE, on one lot at one expected version. Array size is never a proxy for
// command uniqueness; malformed caller input fails closed, never normalizes.
function assertProposalSetInvariant(proposals: z.infer<typeof ProposalSchema>[]): void {
  const corrects = proposals.filter((proposal) => proposal.type === 'CORRECT');
  const moves = proposals.filter((proposal) => proposal.type === 'MOVE');
  if (corrects.length > 1 || moves.length > 1) throw new ObservationError('INVALID_DECISION');
  if (proposals.length === 2 && (proposals[0].lotId !== proposals[1].lotId
    || proposals[0].expectedVersion !== proposals[1].expectedVersion)) {
    throw new ObservationError('INVALID_DECISION');
  }
  for (const correct of corrects) {
    if (Object.values(correct.changes).every((value) => value === undefined)) throw new ObservationError('INVALID_DECISION');
  }
}

export interface DecisionRow {
  id: string; household_id: string; observation_id: string; decision_key: string;
  fingerprint: string; decision_type: string; proposed_verdict: string; actor_id: string;
  expected_observation_version: number; command_id: string | null; result_json: string | null;
  created_at: string;
}

interface LotRow {
  id: string; householdId: string; ingredientId: string | null; rawName: string;
  quantityMilli: number; canonicalUnit: string; storageLocationId: string; state: string;
  purchasedAt: string | null; openedAt: string | null; expiryAt: string | null;
  estimatedExpiryAt: string | null; expiryKind: string; sourceType: string; sourceId: string | null;
  version: number; createdAt: string; updatedAt: string;
  currency: string | null; amountMinor: number | null; minorDigits: number | null;
  legacyItemId: string | null;
  legacyExpiryAt: string | null; legacyExpiryKind: string | null; legacyExpirySource: string | null;
  legacyOpenedAt: string | null; legacyVersion: number | null;
}
interface LocationRow {
  id: string; householdId: string; type: string; name: string; sortOrder: number;
  isDefault: number; createdAt: string; updatedAt: string;
}
interface ObservationRecord {
  id: string; household_id: string; source_type: string; source_ref: string; fingerprint: string;
  observed_at: string; recorded_at: string; ingredient_id: string | null; raw_name: string | null;
  lot_id: string | null; legacy_item_id: string | null; quantity: number | null; unit: string | null;
  quantity_milli: number | null; canonical_unit: string | null; storage: string | null;
  expiry_date: string | null; expiry_kind: string | null; opened_at: string | null;
  evidence: string; note: string | null; authoritative_inventory_version: number;
  status: string; version: number; created_at: string; updated_at: string;
}

const OBSERVATION_COLUMNS = `id, household_id, source_type, source_ref, fingerprint, observed_at,
  recorded_at, ingredient_id, raw_name, lot_id, legacy_item_id, quantity, unit, quantity_milli,
  canonical_unit, storage, expiry_date, expiry_kind, opened_at, evidence, note,
  authoritative_inventory_version, status, version, created_at, updated_at`;

function parseObservationRecord(row: ObservationRecord): InventoryObservation {
  return parseObservationRow(row);
}
export async function readReconciliationSnapshot(db: D1DatabaseBinding,
  householdId: string): Promise<ReconciliationSnapshot> {
  Identity.parse(householdId);
  const [version, lots, locations] = await Promise.all([
    db.prepare('SELECT inventory_version FROM households WHERE id = ?').bind(householdId)
      .first<{ inventory_version: number } | undefined>(),
    db.prepare(`SELECT id, household_id AS householdId, ingredient_id AS ingredientId,
      raw_name AS rawName, quantity_milli AS quantityMilli, canonical_unit AS canonicalUnit,
      storage_location_id AS storageLocationId, state, purchased_at AS purchasedAt,
      opened_at AS openedAt, expiry_at AS expiryAt, estimated_expiry_at AS estimatedExpiryAt,
      expiry_kind AS expiryKind, source_type AS sourceType, source_id AS sourceId, version,
      created_at AS createdAt, updated_at AS updatedAt, currency, amount_minor AS amountMinor,
      minor_digits AS minorDigits, legacy_item_id AS legacyItemId,
      legacy_expiry_at AS legacyExpiryAt,
      legacy_expiry_kind AS legacyExpiryKind, legacy_expiry_source AS legacyExpirySource,
      legacy_opened_at AS legacyOpenedAt, legacy_version AS legacyVersion
      FROM inventory_lots WHERE household_id = ? ORDER BY id LIMIT 1001`).bind(householdId).all<LotRow>(),
    db.prepare(`SELECT id, household_id AS householdId, type, name, sort_order AS sortOrder,
      is_default AS isDefault, created_at AS createdAt, updated_at AS updatedAt
      FROM storage_locations WHERE household_id = ? ORDER BY sort_order, id`)
      .bind(householdId).all<LocationRow>(),
  ]);
  if (!version || !Number.isSafeInteger(version.inventory_version) || version.inventory_version < 1) {
    throw new ObservationError('HOUSEHOLD_NOT_FOUND');
  }
  if (lots.results.length > 1000) throw new ObservationError('SNAPSHOT_TOO_LARGE');
  try {
    return ReconciliationSnapshotSchema.parse({
      inventoryVersion: version.inventory_version,
      lots: lots.results.map((row) => {
        const { currency, amountMinor, minorDigits, legacyItemId, ...lot } = row;
        return {
          lot: InventoryLotSchema.parse({
            ...lot, purchasePrice: currency === null && amountMinor === null && minorDigits === null
              ? null : { currency, amountMinor, minorDigits },
          }),
          legacyItemId,
        };
      }),
      locations: locations.results.map((row) => {
        if (row.isDefault !== 0 && row.isDefault !== 1) throw new Error('Invalid location');
        return StorageLocationSchema.parse({ ...row, isDefault: row.isDefault === 1 });
      }),
    });
  } catch (error) {
    if (error instanceof ObservationError) throw error;
    throw new ObservationError('CORRUPT_INVENTORY_SNAPSHOT');
  }
}

export async function planInventoryReconciliationForHousehold(db: D1DatabaseBinding,
  householdId: string, observations: InventoryObservation[]): Promise<ReconciliationFinding[]> {
  const snapshot = await readReconciliationSnapshot(db, householdId);
  return planInventoryReconciliation(snapshot, observations);
}

function decisionCommandSpecs(decisionKey: string, proposals: ReconciliationProposal[]): LotCommandSpec[] {
  const reason = `Reconciliation decision ${decisionKey}`;
  const correct = proposals.find((proposal) => proposal.type === 'CORRECT');
  const move = proposals.find((proposal) => proposal.type === 'MOVE');
  // Defense in depth: exactly the proposal-set invariant, so the derived client
  // keys <decisionKey>#CORRECT / <decisionKey>#MOVE are unique per decision.
  if (proposals.length !== (correct ? 1 : 0) + (move ? 1 : 0)) throw new ObservationError('INVALID_DECISION');
  const specs: LotCommandSpec[] = [];
  if (correct && correct.type === 'CORRECT') {
    const terminalState = (correct as { terminalState?: 'CONSUMED' | 'DISCARDED' }).terminalState;
    specs.push({
      clientKey: `${decisionKey}#CORRECT`,
      input: {
        type: 'CORRECT', lotId: correct.lotId, expectedVersion: correct.expectedVersion,
        changes: correct.changes, reason,
        ...(terminalState === undefined ? {} : { terminalState }),
      },
    });
  }
  if (move && move.type === 'MOVE') {
    specs.push({
      clientKey: `${decisionKey}#MOVE`,
      input: {
        type: 'MOVE', lotId: move.lotId, expectedVersion: move.expectedVersion,
        storageLocationId: move.storageLocationId,
      },
      // Same T09 composition semantics as the manual PATCH adapter: the first
      // command fences the confirmed expectedVersion; a following MOVE on the
      // same lot rides the version the composed CORRECT produced, all in one
      // atomic batch.
      ...(correct ? { useCurrentLotVersion: { lotId: move.lotId } } : {}),
    });
  }
  return specs;
}

// The terminal state is the actor's decision semantics, not planner output,
// so it is excluded from the confirmed-vs-fresh proposal equality check.
type ConfirmableProposal = ReconciliationProposal | {
  type: 'CORRECT'; lotId: string; expectedVersion: number; changes: Record<string, unknown>;
  terminalState?: 'CONSUMED' | 'DISCARDED';
};
function comparableProposal(proposal: ConfirmableProposal): unknown {
  if (proposal.type === 'CORRECT') {
    const { terminalState, ...rest } = proposal as ConfirmableProposal & Record<string, unknown>;
    void terminalState;
    return rest;
  }
  return proposal;
}

function actionableVerdicts(decisionType: ReconciliationDecisionType): ReconciliationFinding['verdict'][] {
  return decisionType === 'CORRECT' ? ['PROPOSE_CORRECTION', 'PROPOSE_EXPIRY_UPDATE']
    : decisionType === 'MOVE' ? ['PROPOSE_MOVE'] : ['NO_ACTION'];
}

function parseDecisionExecutions(resultJson: string): AnyLotCommandResult[] {
  try {
    const parsed = JSON.parse(resultJson) as { executions: AnyLotCommandResult[] };
    if (!Array.isArray(parsed.executions)) throw new Error('Invalid decision receipt');
    return parsed.executions;
  } catch {
    throw new ObservationError('CORRUPT_DECISION_RECEIPT');
  }
}

export async function confirmReconciliationDecision(db: D1DatabaseBinding,
  inputScope: ReconciliationDecisionScope, input: ReconciliationDecisionInput,
  now: string): Promise<ReconciliationDecisionExecution> {
  const scope = Scope.parse(inputScope);
  const decision = DecisionInput.parse(input);
  const proposals = decision.proposals ?? [];
  if ((decision.decisionType === 'DISMISS') !== (proposals.length === 0)) {
    throw new ObservationError('INVALID_DECISION');
  }
  assertProposalSetInvariant(proposals);
  // The declared decision type must match the proposal set it carries.
  if (decision.decisionType === 'MOVE' && proposals.some((proposal) => proposal.type === 'CORRECT')) {
    throw new ObservationError('INVALID_DECISION');
  }
  if (decision.decisionType === 'CORRECT' && !proposals.some((proposal) => proposal.type === 'CORRECT')) {
    throw new ObservationError('INVALID_DECISION');
  }
  // Session/actor-bound scope: the actor must belong to the household even for
  // evidence-only dismissals.
  const membership = await authorizedHousehold(db, scope).first<{ inventoryVersion: number }>();
  if (!membership) throw new ObservationError('FORBIDDEN');
  const observationRow = await db.prepare(`SELECT ${OBSERVATION_COLUMNS}
    FROM inventory_observations WHERE id = ? AND household_id = ?`)
    .bind(decision.observationId, scope.householdId).first<ObservationRecord>();
  if (!observationRow) throw new ObservationError('OBSERVATION_NOT_FOUND');
  const decisionFingerprint = sortedJson({
    householdId: scope.householdId, actorId: scope.actorId,
    observationId: decision.observationId,
    observationFingerprint: parseObservationRecord(observationRow).fingerprint,
    expectedObservationVersion: decision.expectedObservationVersion,
    decisionType: decision.decisionType,
    proposals,
  });
  const existing = await db.prepare(`SELECT id, household_id, observation_id, decision_key,
    fingerprint, decision_type, proposed_verdict, actor_id, expected_observation_version,
    command_id, result_json, created_at FROM inventory_reconciliation_decisions
    WHERE household_id = ? AND decision_key = ?`).bind(scope.householdId, decision.decisionKey)
    .first<DecisionRow>();
  if (existing) {
    // Response-loss replay: an identical retry replays the committed result
    // without any further mutation, regardless of the observation's current
    // lifecycle. An altered semantic decision under the same key conflicts.
    if (existing.fingerprint !== decisionFingerprint) throw new ObservationError('IDEMPOTENCY_CONFLICT');
    return {
      decisionId: existing.id, decisionType: existing.decision_type as ReconciliationDecisionType,
      observationId: existing.observation_id,
      observationVersion: existing.expected_observation_version + 1,
      executions: existing.result_json === null ? [] : parseDecisionExecutions(existing.result_json),
      replayed: true,
    };
  }
  const observation = parseObservationRecord(observationRow);
  if (observation.status !== 'OPEN') throw new ObservationError('OBSERVATION_NOT_OPEN');
  if (observation.version !== decision.expectedObservationVersion) {
    throw new ObservationError('OBSERVATION_VERSION_CONFLICT');
  }
  let finding: ReconciliationFinding | null = null;
  if (decision.decisionType !== 'DISMISS') {
    // Fresh-plan check: the confirmed proposals must still be exactly what the
    // deterministic planner derives from current authoritative stock. Any
    // drift (including a version bump from an unrelated stock change) fails
    // closed instead of overwriting silently.
    const snapshot = await readReconciliationSnapshot(db, scope.householdId);
    const findings = planInventoryReconciliation(snapshot, [observation]);
    finding = findings[0];
    if (!actionableVerdicts(decision.decisionType).includes(finding.verdict)) {
      throw new ObservationError(finding.verdict === 'STALE_OBSERVATION'
        ? 'OBSERVATION_STALE' : 'OBSERVATION_NOT_ACTIONABLE');
    }
    if (finding.proposals.length !== proposals.length
      || finding.proposals.some((proposal, index) =>
        sortedJson(comparableProposal(proposal)) !== sortedJson(comparableProposal(proposals[index])))) {
      throw new ObservationError('OBSERVATION_STALE');
    }
  }
  const composed = decision.decisionType === 'DISMISS'
    ? { prepared: [], statements: [] as D1PreparedStatement[] }
    : await composeInventoryLotCommands(db, scope, decisionCommandSpecs(decision.decisionKey, proposals), now);
  const replayedExecutions = composed.prepared.flatMap((prepared) =>
    prepared.kind === 'replay' ? [prepared.execution] : []);
  const applied = composed.prepared.flatMap((prepared) =>
    prepared.kind === 'prepared' ? [prepared.result] : []);
  if (decision.decisionType !== 'DISMISS' && applied.length !== proposals.length) {
    throw new ObservationError('RECONCILIATION_INCOMPLETE');
  }
  const resultJson = sortedJson({
    decisionType: decision.decisionType,
    executions: [...replayedExecutions, ...applied],
  });
  if (new TextEncoder().encode(resultJson).length > 262_144) {
    throw new ObservationError('DECISION_RECEIPT_TOO_LARGE');
  }
  const decisionId = `t10-decision:${scope.householdId}:${decision.decisionKey}`;
  const primaryCommandId = applied[0]?.commandId ?? null;
  const statements: D1PreparedStatement[] = [
    ...composed.statements,
    db.prepare(`INSERT INTO inventory_reconciliation_decisions (id, household_id, observation_id,
      decision_key, fingerprint, decision_type, proposed_verdict, actor_id,
      expected_observation_version, command_id, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      decisionId, scope.householdId, decision.observationId, decision.decisionKey,
      decisionFingerprint, decision.decisionType, finding?.verdict ?? 'NO_ACTION', scope.actorId,
      decision.expectedObservationVersion, primaryCommandId, resultJson, now,
    ),
    db.prepare(`UPDATE inventory_observations SET status = 'RECONCILED', version = version + 1,
      updated_at = ? WHERE id = ? AND household_id = ? AND status = 'OPEN' AND version = ?`)
      .bind(now, decision.observationId, scope.householdId, decision.expectedObservationVersion),
  ];
  // One atomic batch: if any T09 command or the decision/observation write
  // fails, the whole reconciliation rolls back and nothing is marked applied.
  await db.batch(statements);
  return {
    decisionId, decisionType: decision.decisionType, observationId: decision.observationId,
    observationVersion: decision.expectedObservationVersion + 1,
    executions: parseDecisionExecutions(resultJson), replayed: false,
  };
}

export async function readReconciliationDecisions(db: D1DatabaseBinding, householdId: string,
  options: { observationId?: string; limit?: number } = {}): Promise<DecisionRow[]> {
  Identity.parse(householdId);
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ObservationError('INVALID_LIMIT');
  const clause = options.observationId === undefined ? '' : ' AND observation_id = ?';
  const bindings = options.observationId === undefined ? [householdId] : [householdId, options.observationId];
  const result = await db.prepare(`SELECT id, household_id, observation_id, decision_key, fingerprint,
    decision_type, proposed_verdict, actor_id, expected_observation_version, command_id, result_json,
    created_at FROM inventory_reconciliation_decisions WHERE household_id = ?${clause}
    ORDER BY created_at DESC, id ASC LIMIT ?`).bind(...bindings, limit).all<DecisionRow>();
  return result.results;
}
