import { afterEach, describe, expect, it } from 'vitest';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import { executeInventoryLotCommand } from '../../packages/db/src/inventory-lot-commands';
import { recordInventoryObservation } from '../../packages/db/src/inventory-observations';
import {
  confirmReconciliationDecision, planInventoryReconciliationForHousehold,
  type ReconciliationDecisionInput,
} from '../../packages/db/src/inventory-reconciliation';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import type { InventoryObservationInput } from '../../packages/domain/src/inventory-observations';
import type { ReconciliationProposal } from '../../packages/domain/src/inventory-reconciliation';
import { SqliteD1 } from '../helpers/sqlite-d1';

// T10 observation claim fence: for one observation at (OPEN, version N)
// exactly one semantic decision may transition it to (RECONCILED, N+1). The
// claim is proven inside the atomic batch (changes() guard), so a losing
// contender rolls back every T09 command, event, projection write, decision
// receipt and observation mutation, and receives a domain error.
const scope = { householdId: 'fence-a', actorId: 'fence-user' };
const now = '2026-09-11T10:00:00Z';
const later = '2026-09-11T11:00:00Z';
const databases: SqliteD1[] = [];

function database(): SqliteD1 {
  const db = new SqliteD1();
  databases.push(db);
  db.seed(`INSERT INTO users(id) VALUES ('fence-user');
    INSERT INTO households(id, name, created_by) VALUES ('fence-a', 'Fence', 'fence-user');
    INSERT INTO household_members(id, household_id, user_id, role) VALUES ('fence-m', 'fence-a', 'fence-user', 'owner');`);
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const location = (db: SqliteD1, type: string) =>
  (db.query(`SELECT id FROM storage_locations WHERE household_id = '${scope.householdId}' AND type = '${type}'`)[0] as { id: string }).id;

async function nativeLot(db: SqliteD1): Promise<string> {
  await executeInventoryAdoption(db, scope, {}, now);
  await executeInventoryLotCommand(db, scope, 'seed', {
    type: 'CREATE', lotId: 'eggs', ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 10, unit: 'piece',
    storageLocationId: location(db, 'FRIDGE'), sourceType: 'MANUAL', expiryAt: '2026-09-20', expiryKind: 'KNOWN',
  }, now);
  return 'eggs';
}
async function backfilledLot(db: SqliteD1): Promise<string> {
  db.seed(`INSERT INTO inventory_items (id, household_id, ingredient_id, name, quantity, unit, storage,
    expiry_date, opened_at, expiry_kind, expiry_source, version, created_at, updated_at)
    VALUES ('legacy-eggs', '${scope.householdId}', 'CHICKEN_EGG', 'Legacy eggs', 10, 'piece', 'fridge',
    '2026-09-20', NULL, 'use_by', 'user', 1, '2026-09-10T09:00:00Z', '2026-09-10T09:00:00Z')`);
  expect((await backfillLegacyInventory(db, scope.householdId)).parity.ok).toBe(true);
  await executeInventoryAdoption(db, scope, {}, now);
  return db.query("SELECT id FROM inventory_lots WHERE source_type = 'LEGACY_BACKFILL'")[0].id as string;
}

const emptyClaim = { quantity: null, unit: null, quantityMilli: null, canonicalUnit: null,
  storage: null, expiryDate: null, expiryKind: null, openedAt: null };
const quantityClaim = { quantity: 8, unit: 'piece', quantityMilli: 8_000, canonicalUnit: 'piece' };
const multiClaim = { ...quantityClaim, expiryDate: '2026-09-22', expiryKind: 'KNOWN', storage: 'freezer' };

async function observe(db: SqliteD1, lotId: string, claim: Record<string, unknown>) {
  const input = { sourceType: 'MANUAL', sourceRef: 'fence-count', observedAt: now, ingredientId: null, rawName: null,
    lotId, legacyItemId: null, evidence: 'OBSERVED', note: null, claim: { ...emptyClaim, ...claim } } as InventoryObservationInput;
  const { observation } = await recordInventoryObservation(db, scope, input, now);
  const [finding] = await planInventoryReconciliationForHousehold(db, scope.householdId, [observation]);
  return { observation, proposals: finding.proposals };
}

type Kind = 'DISMISS' | 'CORRECT';
function decisionFor(kind: Kind, key: string, observationId: string, proposals: ReconciliationProposal[]): ReconciliationDecisionInput {
  return kind === 'DISMISS'
    ? { decisionKey: key, observationId, expectedObservationVersion: 1, decisionType: 'DISMISS' }
    : { decisionKey: key, observationId, expectedObservationVersion: 1, decisionType: 'CORRECT', proposals };
}

// Pauses the contender immediately before its atomic batch (the one carrying
// the decision receipt), runs the winner to completion, then releases the
// contender against committed state. No timing, sleeps or scheduling luck.
function pauseAtDecisionBatch(db: SqliteD1, runWinner: () => Promise<unknown>) {
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

const facts = (db: SqliteD1) => ({
  decisions: db.query<{ decision_key: string; decision_type: string }>(
    'SELECT decision_key, decision_type FROM inventory_reconciliation_decisions ORDER BY decision_key'),
  observation: db.query<{ status: string; version: number }>("SELECT status, version FROM inventory_observations WHERE source_ref = 'fence-count'")[0],
  lots: db.query(`SELECT id, quantity_milli, version, storage_location_id, expiry_at FROM inventory_lots WHERE household_id = '${scope.householdId}' ORDER BY id`),
  items: db.query(`SELECT id, quantity, unit, storage, version FROM inventory_items WHERE household_id = '${scope.householdId}' ORDER BY id`),
  commands: db.query<{ client_key: string }>("SELECT client_key FROM inventory_commands WHERE client_key LIKE '%#%' ORDER BY client_key").map((row) => row.client_key),
  events: db.query<{ n: number }>(`SELECT count(*) AS n FROM inventory_events WHERE household_id = '${scope.householdId}' AND event_type LIKE 'T10_%'`)[0].n,
  commandEvents: db.query<{ n: number }>(`SELECT count(*) AS n FROM inventory_events e JOIN inventory_commands c ON c.id = e.command_id WHERE c.client_key LIKE '%#%'`)[0].n,
});

interface RaceCase { name: string; winner: Kind; loser: Kind }
const matrix: RaceCase[] = [
  { name: 'DISMISS vs DISMISS', winner: 'DISMISS', loser: 'DISMISS' },
  { name: 'DISMISS vs CORRECT', winner: 'DISMISS', loser: 'CORRECT' },
  { name: 'CORRECT vs DISMISS', winner: 'CORRECT', loser: 'DISMISS' },
  { name: 'CORRECT(key A) vs CORRECT(key B)', winner: 'CORRECT', loser: 'CORRECT' },
];

async function runRace(db: SqliteD1, lotId: string, claim: Record<string, unknown>, race: RaceCase) {
  const startLot = db.query<{ version: number }>('SELECT version FROM inventory_lots WHERE id = ?', lotId)[0].version;
  const { observation, proposals } = await observe(db, lotId, claim);
  const winnerInput = decisionFor(race.winner, 'key-A', observation.observationId, proposals);
  const loserInput = decisionFor(race.loser, 'key-B', observation.observationId, proposals);
  let winnerResult: Awaited<ReturnType<typeof confirmReconciliationDecision>> | undefined;
  const gate = pauseAtDecisionBatch(db, async () => {
    winnerResult = await confirmReconciliationDecision(db, scope, winnerInput, later);
  });
  const contender = confirmReconciliationDecision(db, scope, loserInput, later);
  await gate;
  // Exactly one contender succeeds; the loser gets the deterministic race error.
  await expect(contender).rejects.toMatchObject({ name: 'ObservationError', code: 'OBSERVATION_VERSION_CONFLICT' });
  expect(winnerResult?.replayed).toBe(false);
  const committed = facts(db);
  expect(committed.decisions).toEqual([{ decision_key: 'key-A', decision_type: race.winner }]);
  expect(committed.observation).toEqual({ status: 'RECONCILED', version: 2 });
  expect(committed.events).toBe(0); // no guard/fence rows survive
  const expectedCommands = race.winner === 'CORRECT'
    ? proposals.map((proposal) => `key-A#${proposal.type}`).sort() : [];
  expect(committed.commands).toEqual(expectedCommands);
  expect(committed.commandEvents).toBe(expectedCommands.length);
  const lot = committed.lots.find((row) => row.id === lotId)!;
  if (race.winner === 'CORRECT') {
    expect(lot.quantity_milli).toBe(8_000);
    expect(lot.version).toBe(startLot + proposals.length);
  } else {
    expect(lot.quantity_milli).toBe(10_000);
    expect(lot.version).toBe(startLot);
  }
  // Winner exact response-loss replay: same result, zero new mutation.
  const replay = await confirmReconciliationDecision(db, scope, winnerInput, '2026-09-11T12:00:00Z');
  expect(replay.replayed).toBe(true);
  expect(replay.decisionId).toBe(winnerResult!.decisionId);
  expect(facts(db)).toEqual(committed);
  // Winner key with altered semantics still conflicts.
  const altered: ReconciliationDecisionInput = race.winner === 'DISMISS'
    ? { ...winnerInput, decisionType: 'CORRECT', proposals }
    : { ...winnerInput, decisionType: 'DISMISS', proposals: undefined };
  await expect(confirmReconciliationDecision(db, scope, altered, later)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  // Loser exact retry after the race: still a deterministic failure, never a late commit.
  await expect(confirmReconciliationDecision(db, scope, loserInput, later)).rejects.toMatchObject({ code: 'OBSERVATION_NOT_OPEN' });
  // A fresh different key after reconciliation cannot mutate anything.
  await expect(confirmReconciliationDecision(db, scope, decisionFor(race.loser, 'key-C', observation.observationId, proposals), later))
    .rejects.toMatchObject({ code: 'OBSERVATION_NOT_OPEN' });
  expect(facts(db)).toEqual(committed);
  return committed;
}

describe('T10 observation claim fence — native lot', () => {
  for (const race of matrix) {
    it(`${race.name}: exactly one decision claims OPEN/v1 -> RECONCILED/v2`, async () => {
      const db = database();
      const lotId = await nativeLot(db);
      await runRace(db, lotId, quantityClaim, race);
    });
  }

  it('CORRECT + MOVE vs DISMISS: the merged multi-field winner commits once; the dismissal loses cleanly', async () => {
    const db = database();
    const lotId = await nativeLot(db);
    const committed = await runRace(db, lotId, multiClaim, { name: 'CORRECT+MOVE vs DISMISS', winner: 'CORRECT', loser: 'DISMISS' });
    expect(committed.commands).toEqual(['key-A#CORRECT', 'key-A#MOVE']);
    const lot = committed.lots.find((row) => row.id === lotId)!;
    expect(lot).toMatchObject({ quantity_milli: 8_000, version: 3, storage_location_id: location(db, 'FREEZER'), expiry_at: '2026-09-22' });
  });

  it('DISMISS vs CORRECT + MOVE: the losing multi-field correction leaves no command, event, lot or projection change', async () => {
    const db = database();
    const lotId = await nativeLot(db);
    const committed = await runRace(db, lotId, multiClaim, { name: 'DISMISS vs CORRECT+MOVE', winner: 'DISMISS', loser: 'CORRECT' });
    expect(committed.commands).toEqual([]);
    expect(committed.lots.find((row) => row.id === lotId)).toMatchObject({ quantity_milli: 10_000, version: 1, storage_location_id: location(db, 'FRIDGE'), expiry_at: '2026-09-20' });
  });
});

describe('T10 observation claim fence — backfilled synthetic lot', () => {
  it('CORRECT(key A) vs CORRECT(key B): native lot and legacy projection stay coherent, single winner', async () => {
    const db = database();
    const lotId = await backfilledLot(db);
    const committed = await runRace(db, lotId, quantityClaim, { name: 'backfilled CORRECT vs CORRECT', winner: 'CORRECT', loser: 'CORRECT' });
    expect(committed.items).toEqual([{ id: 'legacy-eggs', quantity: 8, unit: 'piece', storage: 'fridge', version: 2 }]);
  });

  it('CORRECT + MOVE vs DISMISS on a backfilled lot: projection reflects exactly one applied decision', async () => {
    const db = database();
    const lotId = await backfilledLot(db);
    const committed = await runRace(db, lotId, multiClaim, { name: 'backfilled CORRECT+MOVE vs DISMISS', winner: 'CORRECT', loser: 'DISMISS' });
    expect(committed.items).toEqual([{ id: 'legacy-eggs', quantity: 8, unit: 'piece', storage: 'freezer', version: 3 }]);
    expect(committed.lots.find((row) => row.id === lotId)).toMatchObject({ quantity_milli: 8_000, version: 4, storage_location_id: location(db, 'FREEZER') });
  });

  it('DISMISS vs DISMISS on a backfilled lot: no stock authority is touched by either side', async () => {
    const db = database();
    const lotId = await backfilledLot(db);
    const committed = await runRace(db, lotId, quantityClaim, { name: 'backfilled DISMISS vs DISMISS', winner: 'DISMISS', loser: 'DISMISS' });
    expect(committed.items).toEqual([{ id: 'legacy-eggs', quantity: 10, unit: 'piece', storage: 'fridge', version: 1 }]);
  });
});

describe('T10 observation claim fence — in-batch proof independent of the 0030 decision trigger', () => {
  // Without the receipt-insert trigger, only the changes() claim guard stands
  // between two DISMISS decisions and a double commit. This is the precise
  // pre-fix defect: the guarded UPDATE affecting zero rows was a silent success.
  it('DISMISS vs DISMISS with the decision guard trigger dropped still admits exactly one decision', async () => {
    const db = database();
    db.seed('DROP TRIGGER trg_inventory_reconciliation_decisions_observation_guard');
    const lotId = await nativeLot(db);
    await runRace(db, lotId, quantityClaim, { name: 'trigger-less DISMISS vs DISMISS', winner: 'DISMISS', loser: 'DISMISS' });
  });

  it('CORRECT vs CORRECT with the decision guard trigger dropped: loser rolls back its T09 command and events', async () => {
    const db = database();
    db.seed('DROP TRIGGER trg_inventory_reconciliation_decisions_observation_guard');
    const lotId = await nativeLot(db);
    // The loser's lot CAS would also fail here (winner bumped the lot); the
    // observation guard is what protects the DISMISS-shaped case above. Both
    // paths must end with a single decision and no orphan receipts.
    const committed = await runRace(db, lotId, quantityClaim, { name: 'trigger-less CORRECT vs CORRECT', winner: 'CORRECT', loser: 'CORRECT' });
    expect(committed.commands).toEqual(['key-A#CORRECT']);
  });

  it('same decision key racing itself: the loser replays the committed twin instead of failing', async () => {
    const db = database();
    const lotId = await nativeLot(db);
    const { observation, proposals } = await observe(db, lotId, quantityClaim);
    const input = decisionFor('CORRECT', 'same-key', observation.observationId, proposals);
    const gate = pauseAtDecisionBatch(db, () => confirmReconciliationDecision(db, scope, input, later));
    const contender = confirmReconciliationDecision(db, scope, input, later);
    await gate;
    const result = await contender;
    expect(result.replayed).toBe(true);
    expect(facts(db).decisions).toEqual([{ decision_key: 'same-key', decision_type: 'CORRECT' }]);
    expect(facts(db).commands).toEqual(['same-key#CORRECT']);
  });

  it('same decision key racing with altered semantics: the loser conflicts, the winner stands', async () => {
    const db = database();
    const lotId = await nativeLot(db);
    const { observation, proposals } = await observe(db, lotId, quantityClaim);
    const winner = decisionFor('DISMISS', 'same-key', observation.observationId, proposals);
    const loser = decisionFor('CORRECT', 'same-key', observation.observationId, proposals);
    const gate = pauseAtDecisionBatch(db, () => confirmReconciliationDecision(db, scope, winner, later));
    const contender = confirmReconciliationDecision(db, scope, loser, later);
    await gate;
    await expect(contender).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(facts(db).decisions).toEqual([{ decision_key: 'same-key', decision_type: 'DISMISS' }]);
    expect(facts(db).commands).toEqual([]);
  });
});
