import { afterEach, describe, expect, it } from 'vitest';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import {
  executeInventoryFefoCommand, executeInventoryLotCommand,
} from '../../packages/db/src/inventory-lot-commands';
import { recordInventoryObservation } from '../../packages/db/src/inventory-observations';
import {
  confirmReconciliationDecision, planInventoryReconciliationForHousehold,
  type ReconciliationDecisionInput,
} from '../../packages/db/src/inventory-reconciliation';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import { InventoryObservationSchema, type InventoryObservationInput } from '../../packages/domain/src/inventory-observations';
import {
  planInventoryReconciliation, type ReconciliationProposal, type ReconciliationSnapshot,
} from '../../packages/domain/src/inventory-reconciliation';
import { InventoryLotSchema } from '../../packages/domain/src/inventory-truth';
import { SqliteD1 } from '../helpers/sqlite-d1';

// T10 multi-field reconciliation composition: one matched lot yields at most
// ONE merged CORRECT plus at most ONE MOVE, and the decision boundary enforces
// the same invariant independently of the planner.
const now = '2026-09-11T10:00:00Z';
const later = '2026-09-11T11:00:00Z';

// ---------- pure planner ----------
const baseLot = InventoryLotSchema.parse({
  id: 'lot-1', householdId: 'h-1', ingredientId: 'CHICKEN_EGG', rawName: 'Eggs',
  quantityMilli: 2_000_000, canonicalUnit: 'g', storageLocationId: 'loc-fridge',
  state: 'ACTIVE', purchasedAt: null, openedAt: null, expiryAt: '2026-09-20',
  estimatedExpiryAt: null, expiryKind: 'KNOWN', sourceType: 'MANUAL', sourceId: null,
  version: 3, createdAt: now, updatedAt: now, purchasePrice: null,
  legacyExpiryAt: null, legacyExpiryKind: null, legacyExpirySource: null,
  legacyOpenedAt: null, legacyVersion: null,
});
const snapshot: ReconciliationSnapshot = {
  inventoryVersion: 7,
  lots: [{ lot: baseLot, legacyItemId: null }],
  locations: [
    { id: 'loc-fridge', householdId: 'h-1', type: 'FRIDGE', name: 'Fridge', sortOrder: 0, isDefault: true, createdAt: now, updatedAt: now },
    { id: 'loc-freezer', householdId: 'h-1', type: 'FREEZER', name: 'Freezer', sortOrder: 1, isDefault: true, createdAt: now, updatedAt: now },
  ],
};
const emptyClaim = { quantity: null, unit: null, quantityMilli: null, canonicalUnit: null,
  storage: null, expiryDate: null, expiryKind: null, openedAt: null };
const pureObservation = (claim: Record<string, unknown>) => InventoryObservationSchema.parse({
  observationId: 'o-1', householdId: 'h-1', sourceType: 'MANUAL', sourceRef: 'r-1', fingerprint: '{}',
  observedAt: now, recordedAt: now, ingredientId: 'CHICKEN_EGG', rawName: null, lotId: 'lot-1', legacyItemId: null,
  evidence: 'OBSERVED', note: null, authoritativeInventoryVersion: 7, status: 'OPEN', version: 1,
  createdAt: now, updatedAt: now, claim: { ...emptyClaim, ...claim },
});
const Q = { quantity: 1.5, unit: 'kg', quantityMilli: 1_500_000, canonicalUnit: 'g' };
const E = { expiryDate: '2026-09-22', expiryKind: 'KNOWN' };
const O = { openedAt: '2026-09-11T09:00:00Z' };
const S = { storage: 'freezer' };
const expectedCorrect = (changes: Record<string, unknown>) =>
  ({ type: 'CORRECT', lotId: 'lot-1', expectedVersion: 3, changes });
const expectedMove = { type: 'MOVE', lotId: 'lot-1', expectedVersion: 3, storageLocationId: 'loc-freezer' };
const invariant = (proposals: ReconciliationProposal[]) => {
  expect(proposals.filter((p) => p.type === 'CORRECT').length).toBeLessThanOrEqual(1);
  expect(proposals.filter((p) => p.type === 'MOVE').length).toBeLessThanOrEqual(1);
  expect(proposals.length).toBeLessThanOrEqual(2);
  for (const proposal of proposals) {
    expect(proposal.lotId).toBe('lot-1');
    expect(proposal.expectedVersion).toBe(3);
  }
};

describe('planner multi-field composition (pure)', () => {
  const matrix: [string, Record<string, unknown>, string, Record<string, unknown>, boolean][] = [
    ['quantity + expiry', { ...Q, ...E }, 'PROPOSE_CORRECTION', { quantity: 1.5, unit: 'kg', expiryAt: '2026-09-22', expiryKind: 'KNOWN' }, false],
    ['quantity + openedAt', { ...Q, ...O }, 'PROPOSE_CORRECTION', { quantity: 1.5, unit: 'kg', openedAt: O.openedAt }, false],
    ['expiry + openedAt', { ...E, ...O }, 'PROPOSE_CORRECTION', { expiryAt: '2026-09-22', expiryKind: 'KNOWN', openedAt: O.openedAt }, false],
    ['quantity + expiry + openedAt', { ...Q, ...E, ...O }, 'PROPOSE_CORRECTION', { quantity: 1.5, unit: 'kg', expiryAt: '2026-09-22', expiryKind: 'KNOWN', openedAt: O.openedAt }, false],
    ['quantity + storage', { ...Q, ...S }, 'PROPOSE_CORRECTION', { quantity: 1.5, unit: 'kg' }, true],
    ['expiry + storage', { ...E, ...S }, 'PROPOSE_CORRECTION', { expiryAt: '2026-09-22', expiryKind: 'KNOWN' }, true],
    ['quantity + expiry + storage', { ...Q, ...E, ...S }, 'PROPOSE_CORRECTION', { quantity: 1.5, unit: 'kg', expiryAt: '2026-09-22', expiryKind: 'KNOWN' }, true],
    ['quantity + expiry + openedAt + storage', { ...Q, ...E, ...O, ...S }, 'PROPOSE_CORRECTION', { quantity: 1.5, unit: 'kg', expiryAt: '2026-09-22', expiryKind: 'KNOWN', openedAt: O.openedAt }, true],
  ];
  for (const [name, claim, verdict, changes, withMove] of matrix) {
    it(`${name} → exactly one merged CORRECT${withMove ? ' + one MOVE' : ''}`, () => {
      const [finding] = planInventoryReconciliation(snapshot, [pureObservation(claim)]);
      expect(finding.verdict).toBe(verdict);
      invariant(finding.proposals);
      expect(finding.proposals).toEqual(withMove ? [expectedCorrect(changes), expectedMove] : [expectedCorrect(changes)]);
    });
  }

  it('single-dimension verdicts are preserved', () => {
    expect(planInventoryReconciliation(snapshot, [pureObservation(Q)])[0]).toMatchObject({ verdict: 'PROPOSE_CORRECTION', proposals: [expectedCorrect({ quantity: 1.5, unit: 'kg' })] });
    expect(planInventoryReconciliation(snapshot, [pureObservation(E)])[0]).toMatchObject({ verdict: 'PROPOSE_EXPIRY_UPDATE', proposals: [expectedCorrect({ expiryAt: '2026-09-22', expiryKind: 'KNOWN' })] });
    expect(planInventoryReconciliation(snapshot, [pureObservation(O)])[0]).toMatchObject({ verdict: 'PROPOSE_CORRECTION', proposals: [expectedCorrect({ openedAt: O.openedAt })] });
    expect(planInventoryReconciliation(snapshot, [pureObservation(S)])[0]).toMatchObject({ verdict: 'PROPOSE_MOVE', proposals: [expectedMove] });
  });

  it('never fabricates a terminal state for a merged zero-quantity correction', () => {
    const [finding] = planInventoryReconciliation(snapshot, [pureObservation({
      quantity: 0, unit: 'g', quantityMilli: 0, canonicalUnit: 'g', ...E,
    })]);
    expect(finding.verdict).toBe('PROPOSE_CORRECTION');
    expect(finding.proposals).toEqual([expectedCorrect({ quantity: 0, unit: 'g', expiryAt: '2026-09-22', expiryKind: 'KNOWN' })]);
    expect('terminalState' in finding.proposals[0]).toBe(false);
  });

  it('a claim already matching every dimension composes to MATCH with zero proposals', () => {
    const [finding] = planInventoryReconciliation(snapshot, [pureObservation({
      quantity: 2, unit: 'kg', quantityMilli: 2_000_000, canonicalUnit: 'g',
      expiryDate: '2026-09-20', expiryKind: 'KNOWN', storage: 'fridge',
    })]);
    expect(finding).toMatchObject({ verdict: 'MATCH', proposals: [] });
  });
});

// ---------- db / decision boundary ----------
const scope = { householdId: 't10c-a', actorId: 't10c-user-a' };
const databases: SqliteD1[] = [];
function database(): SqliteD1 {
  const db = new SqliteD1();
  databases.push(db);
  db.seed(`INSERT INTO users(id) VALUES ('t10c-user-a');
    INSERT INTO households(id, name, created_by) VALUES ('t10c-a', 'A', 't10c-user-a');
    INSERT INTO household_members(id, household_id, user_id, role) VALUES ('m-a', 't10c-a', 't10c-user-a', 'owner');`);
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const location = (db: SqliteD1, type: string) =>
  (db.query(`SELECT id FROM storage_locations WHERE household_id = '${scope.householdId}' AND type = '${type}'`)[0] as { id: string }).id;
const lotRow = (db: SqliteD1, id: string) =>
  db.query<{ quantity_milli: number; version: number; state: string; expiry_at: string | null; opened_at: string | null; storage_location_id: string }>(
    'SELECT quantity_milli, version, state, expiry_at, opened_at, storage_location_id FROM inventory_lots WHERE id = ?', id)[0];
const facts = (db: SqliteD1) => Object.fromEntries(['inventory_lots', 'inventory_items', 'inventory_commands', 'inventory_events',
  'inventory_observations', 'inventory_reconciliation_decisions']
  .map((table) => [table, db.query(`SELECT * FROM ${table} WHERE household_id = '${scope.householdId}' ORDER BY id`)]));
const eventsFor = (db: SqliteD1, key: string) =>
  db.query('SELECT e.id FROM inventory_events e JOIN inventory_commands c ON c.id = e.command_id WHERE c.client_key = ?', key);

async function nativeFixture(db: SqliteD1) {
  await executeInventoryAdoption(db, scope, {}, now);
  await executeInventoryLotCommand(db, scope, 'seed', {
    type: 'CREATE', lotId: 'eggs', ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 10, unit: 'piece',
    storageLocationId: location(db, 'FRIDGE'), sourceType: 'MANUAL', expiryAt: '2026-09-20', expiryKind: 'KNOWN',
  }, now);
  return 'eggs';
}
async function backfilledFixture(db: SqliteD1) {
  db.seed(`INSERT INTO inventory_items (id, household_id, ingredient_id, name, quantity, unit, storage,
    expiry_date, opened_at, expiry_kind, expiry_source, version, created_at, updated_at)
    VALUES ('legacy-eggs', '${scope.householdId}', 'CHICKEN_EGG', 'Legacy eggs', 10, 'piece', 'fridge',
    '2026-09-20', NULL, 'use_by', 'user', 1, '2026-09-10T09:00:00Z', '2026-09-10T09:00:00Z')`);
  const backfill = await backfillLegacyInventory(db, scope.householdId);
  expect(backfill.parity.ok).toBe(true);
  await executeInventoryAdoption(db, scope, {}, now);
  const id = db.query("SELECT id FROM inventory_lots WHERE source_type = 'LEGACY_BACKFILL'")[0].id as string;
  expect(db.query('SELECT legacy_item_id FROM inventory_lots WHERE id = ?', id)[0].legacy_item_id).toBe('legacy-eggs');
  return id;
}
const multiClaim = { quantity: 8, unit: 'piece', quantityMilli: 8_000, canonicalUnit: 'piece',
  expiryDate: '2026-09-22', expiryKind: 'KNOWN', openedAt: '2026-09-11T09:00:00Z', storage: 'freezer' };
async function observe(db: SqliteD1, lotId: string, claim: Record<string, unknown>, sourceRef = 'multi') {
  const input = { sourceType: 'MANUAL', sourceRef, observedAt: now, ingredientId: null, rawName: null,
    lotId, legacyItemId: null, evidence: 'OBSERVED', note: null, claim: { ...emptyClaim, ...claim } } as InventoryObservationInput;
  return (await recordInventoryObservation(db, scope, input, now)).observation;
}
const decision = (observationId: string, proposals: ReconciliationProposal[], decisionKey = 'dec-multi',
  decisionType: ReconciliationDecisionInput['decisionType'] = 'CORRECT'): ReconciliationDecisionInput =>
  ({ decisionKey, observationId, expectedObservationVersion: 1, decisionType, proposals });

describe('decision boundary proposal-set invariant', () => {
  it('rejects two CORRECT, two MOVE, cross-lot pairs, mismatched versions, split CORRECTs and type/proposal mismatches', async () => {
    const db = database();
    const lotId = await nativeFixture(db);
    const observation = await observe(db, lotId, multiClaim);
    const [finding] = await planInventoryReconciliationForHousehold(db, scope.householdId, [observation]);
    expect(finding.proposals).toHaveLength(2);
    const correct = finding.proposals[0] as Extract<ReconciliationProposal, { type: 'CORRECT' }>;
    const move = finding.proposals[1] as Extract<ReconciliationProposal, { type: 'MOVE' }>;
    const before = facts(db);
    const bad: ReconciliationProposal[][] = [
      [correct, { ...correct, changes: { openedAt: multiClaim.openedAt } }],
      [move, move],
      [correct, { ...move, lotId: 'other-lot' }],
      [correct, { ...move, expectedVersion: 2 }],
      [{ ...correct, changes: { quantity: 8, unit: 'piece' } }, { ...correct, changes: { expiryAt: '2026-09-22', expiryKind: 'KNOWN' } }],
    ];
    for (const proposals of bad) {
      await expect(confirmReconciliationDecision(db, scope, decision(observation.observationId, proposals), later))
        .rejects.toMatchObject({ name: 'ObservationError', code: 'INVALID_DECISION' });
    }
    await expect(confirmReconciliationDecision(db, scope, decision(observation.observationId, [correct, move], 'k', 'MOVE'), later))
      .rejects.toMatchObject({ code: 'INVALID_DECISION' });
    await expect(confirmReconciliationDecision(db, scope, decision(observation.observationId, [move], 'k', 'CORRECT'), later))
      .rejects.toMatchObject({ code: 'INVALID_DECISION' });
    // Split-but-valid-per-item proposals that do not equal the fresh plan fail as stale, never apply.
    await expect(confirmReconciliationDecision(db, scope, decision(observation.observationId,
      [{ ...correct, changes: { quantity: 8, unit: 'piece' } }]), later)).rejects.toMatchObject({ code: 'OBSERVATION_STALE' });
    expect(facts(db)).toEqual(before);
  });
});

describe('merged multi-field decision execution', () => {
  for (const [name, fixture] of [['native equal-ID lot', nativeFixture], ['backfilled synthetic lot', backfilledFixture]] as const) {
    it(`${name}: one T09 CORRECT + one MOVE commit atomically, replay exactly, conflict on altered semantics`, async () => {
      const db = database();
      const lotId = await fixture(db);
      const startVersion = lotRow(db, lotId).version;
      const observation = await observe(db, lotId, multiClaim);
      const [finding] = await planInventoryReconciliationForHousehold(db, scope.householdId, [observation]);
      expect(finding.verdict).toBe('PROPOSE_CORRECTION');
      expect(finding.proposals).toEqual([
        { type: 'CORRECT', lotId, expectedVersion: startVersion,
          changes: { quantity: 8, unit: 'piece', expiryAt: '2026-09-22', expiryKind: 'KNOWN', openedAt: multiClaim.openedAt } },
        { type: 'MOVE', lotId, expectedVersion: startVersion, storageLocationId: location(db, 'FREEZER') },
      ]);
      const input = decision(observation.observationId, finding.proposals);
      const result = await confirmReconciliationDecision(db, scope, input, later);
      expect(result.replayed).toBe(false);
      expect(result.executions).toHaveLength(2);
      // ONE CORRECT command applied every field at once; the MOVE rode the next version.
      expect(lotRow(db, lotId)).toMatchObject({ quantity_milli: 8_000, version: startVersion + 2, expiry_at: '2026-09-22',
        opened_at: multiClaim.openedAt, storage_location_id: location(db, 'FREEZER'), state: 'ACTIVE' });
      const commands = db.query<{ client_key: string; command_type: string }>(
        "SELECT client_key, command_type FROM inventory_commands WHERE client_key LIKE 'dec-multi#%' ORDER BY client_key");
      expect(commands).toEqual([{ client_key: 'dec-multi#CORRECT', command_type: 'CORRECT' }, { client_key: 'dec-multi#MOVE', command_type: 'MOVE' }]);
      expect(eventsFor(db, 'dec-multi#CORRECT')).toHaveLength(1);
      expect(eventsFor(db, 'dec-multi#MOVE')).toHaveLength(1);
      expect(db.query("SELECT status, version FROM inventory_observations WHERE source_ref = 'multi'")[0])
        .toMatchObject({ status: 'RECONCILED', version: 2 });
      if (name.startsWith('backfilled')) {
        // Projection stays coherent with the native authority (no equal-ID assumption).
        expect(db.query("SELECT quantity, unit, storage FROM inventory_items WHERE id = 'legacy-eggs'")[0])
          .toMatchObject({ quantity: 8, unit: 'piece', storage: 'freezer' });
      }
      // Response loss: exact retry replays, nothing changes.
      const committed = facts(db);
      const replay = await confirmReconciliationDecision(db, scope, input, '2026-09-11T12:00:00Z');
      expect(replay.replayed).toBe(true);
      expect(replay.executions).toHaveLength(2);
      expect(facts(db)).toEqual(committed);
      // Altered semantics under the same key conflict for every field.
      const correct = finding.proposals[0] as Extract<ReconciliationProposal, { type: 'CORRECT' }>;
      const move = finding.proposals[1] as Extract<ReconciliationProposal, { type: 'MOVE' }>;
      const altered: ReconciliationProposal[][] = [
        [{ ...correct, changes: { ...correct.changes, quantity: 7 } }, move],
        [{ ...correct, changes: { ...correct.changes, expiryAt: '2026-09-23' } }, move],
        [{ ...correct, changes: { ...correct.changes, openedAt: '2026-09-11T08:00:00Z' } }, move],
        [correct, { ...move, storageLocationId: location(db, 'PANTRY') }],
      ];
      for (const proposals of altered) {
        await expect(confirmReconciliationDecision(db, scope, decision(observation.observationId, proposals), later))
          .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      }
      expect(facts(db)).toEqual(committed);
      // A new decision key must obey the current observation state.
      await expect(confirmReconciliationDecision(db, scope, decision(observation.observationId, finding.proposals, 'dec-again'), later))
        .rejects.toMatchObject({ code: 'OBSERVATION_NOT_OPEN' });
    });
  }

  it('merged CORRECT without MOVE is one atomic T09 command against one expectedVersion', async () => {
    const db = database();
    const lotId = await nativeFixture(db);
    const { storage, ...noStorage } = multiClaim;
    void storage;
    const observation = await observe(db, lotId, noStorage);
    const [finding] = await planInventoryReconciliationForHousehold(db, scope.householdId, [observation]);
    expect(finding.proposals).toHaveLength(1);
    await confirmReconciliationDecision(db, scope, decision(observation.observationId, finding.proposals), later);
    expect(lotRow(db, lotId)).toMatchObject({ quantity_milli: 8_000, version: 2, expiry_at: '2026-09-22', opened_at: multiClaim.openedAt });
    expect(db.query("SELECT count(*) AS n FROM inventory_commands WHERE client_key LIKE 'dec-multi#%'")[0]).toMatchObject({ n: 1 });
  });

  it('merged zero-quantity correction requires an explicit actor terminal state', async () => {
    const db = database();
    const lotId = await nativeFixture(db);
    const observation = await observe(db, lotId, { quantity: 0, unit: 'piece', quantityMilli: 0, canonicalUnit: 'piece', expiryDate: '2026-09-22', expiryKind: 'KNOWN' });
    const [finding] = await planInventoryReconciliationForHousehold(db, scope.householdId, [observation]);
    expect(finding.proposals).toEqual([{ type: 'CORRECT', lotId, expectedVersion: 1,
      changes: { quantity: 0, unit: 'piece', expiryAt: '2026-09-22', expiryKind: 'KNOWN' } }]);
    const before = facts(db);
    // Without terminalState the T09 command contract refuses; nothing is applied.
    await expect(confirmReconciliationDecision(db, scope, decision(observation.observationId, finding.proposals), later)).rejects.toThrow();
    expect(facts(db)).toEqual(before);
    const explicit = [{ ...finding.proposals[0], terminalState: 'DISCARDED' } as unknown as ReconciliationProposal];
    await confirmReconciliationDecision(db, scope, decision(observation.observationId, explicit), later);
    expect(lotRow(db, lotId)).toMatchObject({ quantity_milli: 0, state: 'DISCARDED', version: 2, expiry_at: '2026-09-22' });
  });
});

describe('multi-field reconciliation concurrency', () => {
  function pauseAtWriteBarrier(db: SqliteD1, runWinner: () => Promise<unknown>) {
    let armed = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    db.hooks.beforeBatch = async (statements) => {
      if (!armed || !statements.some(({ sql }) => sql.includes('INSERT INTO inventory_reconciliation_decisions'))) return;
      armed = false;
      db.hooks = {};
      await runWinner();
      release();
    };
    return gate;
  }
  const winners = {
    CORRECT: (db: SqliteD1) => executeInventoryLotCommand(db, scope, 'winner', {
      type: 'CORRECT', lotId: 'eggs', expectedVersion: 1, changes: { quantity: 9 }, reason: 'Recount' }, later),
    MOVE: (db: SqliteD1) => executeInventoryLotCommand(db, scope, 'winner', {
      type: 'MOVE', lotId: 'eggs', expectedVersion: 1, storageLocationId: location(db, 'PANTRY') }, later),
    FEFO: (db: SqliteD1) => executeInventoryFefoCommand(db, scope, 'winner', {
      type: 'USE', mode: 'FEFO', ingredientId: 'CHICKEN_EGG', quantity: 4, unit: 'piece', reason: 'Cooked' }, later),
  } as const;
  for (const [name, winner] of Object.entries(winners)) {
    it(`multi-field reconcile vs ${name}: one winner, no partial correction, no duplicate receipt`, async () => {
      const db = database();
      const lotId = await nativeFixture(db);
      const observation = await observe(db, lotId, multiClaim);
      const [finding] = await planInventoryReconciliationForHousehold(db, scope.householdId, [observation]);
      const gate = pauseAtWriteBarrier(db, () => winner(db));
      const contender = confirmReconciliationDecision(db, scope, decision(observation.observationId, finding.proposals), later);
      await gate;
      await expect(contender).rejects.toThrow();
      const row = lotRow(db, lotId);
      expect(row.version).toBe(2);
      expect(row.expiry_at).toBe('2026-09-20');
      expect(row.opened_at).toBeNull();
      if (name === 'CORRECT') expect(row.quantity_milli).toBe(9_000);
      if (name === 'FEFO') expect(row.quantity_milli).toBe(6_000);
      if (name === 'MOVE') expect(row.storage_location_id).toBe(location(db, 'PANTRY'));
      expect(db.query("SELECT count(*) AS n FROM inventory_commands WHERE client_key LIKE 'dec-multi#%'")[0]).toMatchObject({ n: 0 });
      expect(db.query("SELECT count(*) AS n FROM inventory_reconciliation_decisions")[0]).toMatchObject({ n: 0 });
      expect(db.query("SELECT status FROM inventory_observations WHERE source_ref = 'multi'")[0]).toMatchObject({ status: 'OPEN' });
    });
  }
});
