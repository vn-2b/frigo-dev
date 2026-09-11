import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, unstable_splitSqlQuery } from 'wrangler';

let worker;
let directory;
const token = randomUUID();

async function batch(statements) {
  const response = await worker.fetch('http://localhost/', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-token': token },
    body: JSON.stringify({ statements: statements.map((statement) =>
      typeof statement === 'string' ? { sql: statement } : statement) }),
  });
  return { status: response.status, ...await response.json() };
}

async function post(pathname, body) {
  const response = await worker.fetch(`http://localhost/${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-token': token },
    body: JSON.stringify(body),
  });
  return { status: response.status, ...await response.json() };
}

const now = '2026-09-11T10:00:00Z';
const later = '2026-09-11T11:00:00Z';
const scope = { householdId: '', actorId: '' };
let fridgeId;

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'frigo-t10-d1-'));
  const config = path.join(directory, 'wrangler.json');
  writeFileSync(config, JSON.stringify({ name: 'frigo-t10-local-proof', compatibility_date: '2025-03-01' }));
  worker = await unstable_dev(path.resolve('tests/helpers/inventory-lot-d1-worker.ts'), {
    config, ip: '127.0.0.1', port: 0, inspectorPort: 0, local: true, persist: false,
    logLevel: 'error', vars: { TEST_TOKEN: token },
    experimental: {
      disableExperimentalWarning: true, disableDevRegistry: true, forceLocal: true, watch: false,
      d1Databases: [{ binding: 'DB', database_name: 't10-isolated-test', database_id: '00000000-0000-0000-0000-000000000030' }],
    },
  });
  for (const file of readdirSync('migrations').filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
    const result = await batch(unstable_splitSqlQuery(readFileSync(`migrations/${file}`, 'utf8')));
    expect(result, file).toMatchObject({ status: 200 });
  }
  const id = randomUUID();
  scope.householdId = `household-${id}`;
  scope.actorId = `actor-${id}`;
  expect(await batch([
    { sql: 'INSERT INTO users(id) VALUES (?)', values: [scope.actorId] },
    { sql: 'INSERT INTO households(id,name,created_by) VALUES (?, ?, ?)', values: [scope.householdId, 'T10 D1', scope.actorId] },
    { sql: "INSERT INTO household_members(id,household_id,user_id,role) VALUES (?, ?, ?, 'owner')",
      values: [`member-${id}`, scope.householdId, scope.actorId] },
  ])).toMatchObject({ status: 200 });
  expect(await post('adopt', { scope, now })).toMatchObject({ status: 200, replayed: false });
  fridgeId = (await batch([
    { sql: "SELECT id FROM storage_locations WHERE household_id = ? AND type = 'FRIDGE'", values: [scope.householdId] },
  ])).results[0].results[0].id;
  expect(await post('command', { scope, key: 'seed', now, input: {
    type: 'CREATE', lotId: `eggs-${id}`, ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 10,
    unit: 'piece', storageLocationId: fridgeId, sourceType: 'MANUAL',
  } })).toMatchObject({ status: 200, replayed: false });
  globalThis.t10LotId = `eggs-${id}`;
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const observe = (patch = {}) => post('observe', { scope, now, input: {
  sourceType: 'MANUAL', sourceRef: 'd1-count', observedAt: now,
  ingredientId: 'CHICKEN_EGG', rawName: null, lotId: globalThis.t10LotId, legacyItemId: null,
  evidence: 'OBSERVED', note: null,
  claim: { quantity: 8, unit: 'piece', quantityMilli: 8_000, canonicalUnit: 'piece',
    storage: null, expiryDate: null, expiryKind: null, openedAt: null },
  ...patch,
} });

const reconcile = (decisionKey, proposals) => post('reconcile', { scope, now: later, decision: {
  decisionKey, observationId: globalThis.t10ObservationId, expectedObservationVersion: 1,
  decisionType: proposals ? 'CORRECT' : 'DISMISS', ...(proposals ? { proposals } : {}),
} });

describe('T10 real local D1 observation/reconciliation semantics (no remote binding)', () => {
  it('records an observation and persists evidence with the real 0030 schema', async () => {
    const { observation, replayed } = await observe();
    globalThis.t10ObservationId = observation.observationId;
    expect(replayed).toBe(false);
    expect(observation.status).toBe('OPEN');
    expect(observation.claim.quantityMilli).toBe(8_000);
    const replay = await observe();
    expect(replay.replayed).toBe(true);
    const state = await batch(['SELECT status, version FROM inventory_observations']);
    expect(state.results[0].results).toEqual([{ status: 'OPEN', version: 1 }]);
  });

  it('applies a reconciliation decision through the T09 authority in one real atomic batch', async () => {
    const result = await reconcile('d1-dec-1', [
      { type: 'CORRECT', lotId: globalThis.t10LotId, expectedVersion: 1, changes: { quantity: 8, unit: 'piece' } },
    ]);
    expect(result.status, JSON.stringify(result).slice(0, 400)).toBe(200);
    expect(result.replayed).toBe(false);
    const state = await batch([
      `SELECT quantity_milli, version FROM inventory_lots WHERE id = '${globalThis.t10LotId}'`,
      'SELECT status, version FROM inventory_observations',
      'SELECT decision_key, command_id FROM inventory_reconciliation_decisions',
    ]);
    expect(state.results[0].results).toEqual([{ quantity_milli: 8_000, version: 2 }]);
    expect(state.results[1].results).toEqual([{ status: 'RECONCILED', version: 2 }]);
    expect(state.results[2].results[0].command_id).toEqual(result.executions[0].commandId);
  });

  it('replays response loss exactly and conflicts on altered semantics under real D1', async () => {
    const before = await batch(['SELECT id, quantity_milli, version FROM inventory_lots',
      'SELECT * FROM inventory_reconciliation_decisions']);
    const replay = await reconcile('d1-dec-1', [
      { type: 'CORRECT', lotId: globalThis.t10LotId, expectedVersion: 1, changes: { quantity: 8, unit: 'piece' } },
    ]);
    expect(replay.status).toBe(200);
    expect(replay.replayed).toBe(true);
    const after = await batch(['SELECT id, quantity_milli, version FROM inventory_lots',
      'SELECT * FROM inventory_reconciliation_decisions']);
    const rows = (state) => state.results.map((statement) => statement.results);
    expect(rows(after)).toEqual(rows(before));
    const altered = await reconcile('d1-dec-1', [
      { type: 'CORRECT', lotId: globalThis.t10LotId, expectedVersion: 1, changes: { quantity: 7, unit: 'piece' } },
    ]);
    expect(altered.status).toBe(409);
    expect(altered.error).toContain('IDEMPOTENCY_CONFLICT');
  });

  it('enforces the 0030 triggers under real D1: identity, lifecycle, guard and tenancy fail closed', async () => {
    const cases = [
      [`INSERT INTO inventory_observations (id, household_id, source_type, source_ref, fingerprint,
        observed_at, recorded_at, ingredient_id, evidence, authoritative_inventory_version, version,
        created_at, updated_at, quantity, unit, quantity_milli, canonical_unit)
        VALUES ('dup', '${scope.householdId}', 'MANUAL', 'd1-count', '{}', '${now}', '${now}',
        'CHICKEN_EGG', 'OBSERVED', 2, 1, '${now}', '${now}', 1, 'piece', 1000, 'piece')`, 'already exists'],
      [`UPDATE inventory_observations SET evidence = 'CONFIRMED'`, 'immutable'],
      [`DELETE FROM inventory_observations`, 'retained'],
      [`UPDATE inventory_observations SET status = 'RECONCILED', version = 2`, /Invalid observation/],
      [`INSERT INTO inventory_reconciliation_decisions (id, household_id, observation_id, decision_key,
        fingerprint, decision_type, proposed_verdict, actor_id, expected_observation_version, created_at)
        VALUES ('guard-1', '${scope.householdId}', '${globalThis.t10ObservationId}', 'guard-key-1', '{}',
        'DISMISS', 'NO_ACTION', '${scope.actorId}', 9, '${now}')`, 'not open at the expected version'],
    ];
    for (const [sql, expected] of cases) {
      const result = await batch([sql]);
      expect(result.status, sql).toBe(409);
      expect(result.error, sql).toMatch(expected);
    }
    // A decision receipt cannot link a command from another household.
    const observation = globalThis.t10ObservationId;
    const invalidLink = await batch([
      `INSERT INTO inventory_reconciliation_decisions (id, household_id, observation_id, decision_key,
        fingerprint, decision_type, proposed_verdict, actor_id, expected_observation_version,
        command_id, result_json, created_at)
        SELECT 'guard-2', '${scope.householdId}', '${observation}', 'guard-key-2', '{}', 'CORRECT',
        'PROPOSE_CORRECTION', '${scope.actorId}', 1, 'no-such-command', '{"x":1}', '${now}'`,
    ]);
    expect(invalidLink.status).toBe(409);
  });

  it('refuses a foreign-household lot reference at the real FK/trigger boundary', async () => {
    const foreign = { householdId: `foreign-${randomUUID()}`, actorId: `foreign-actor-${randomUUID()}` };
    const foreignId = foreign.householdId;
    const foreignActor = foreign.actorId;
    expect(await batch([
      { sql: 'INSERT INTO users(id) VALUES (?)', values: [foreignActor] },
      { sql: 'INSERT INTO households(id,name,created_by) VALUES (?, ?, ?)', values: [foreignId, 'Foreign', foreignActor] },
      { sql: "INSERT INTO household_members(id,household_id,user_id,role) VALUES (?, ?, ?, 'owner')",
        values: [`member-${foreignId}`, foreignId, foreignActor] },
    ])).toMatchObject({ status: 200 });
    const result = await batch([
      `INSERT INTO inventory_observations (id, household_id, source_type, source_ref, fingerprint,
        observed_at, recorded_at, ingredient_id, evidence, authoritative_inventory_version, version,
        created_at, updated_at, quantity, unit, quantity_milli, canonical_unit, lot_id)
        VALUES ('foreign-ref', '${scope.householdId}', 'MANUAL', 'cross', '{}', '${now}', '${now}',
        'CHICKEN_EGG', 'OBSERVED', 2, 1, '${now}', '${now}', 1, 'piece', 1000, 'piece',
        '${globalThis.t10LotId}')`,
    ]);
    expect(result.status).toBe(200);
    const cleanup = await batch([`DELETE FROM inventory_observations WHERE id = 'foreign-ref'`]);
    expect(cleanup.status).toBe(409);
    // The referenced lot DOES belong to the same household, so the insert was
    // valid; a true cross-household reference must abort.
    const crossResult = await batch([
      `INSERT INTO inventory_observations (id, household_id, source_type, source_ref, fingerprint,
        observed_at, recorded_at, ingredient_id, evidence, authoritative_inventory_version, version,
        created_at, updated_at, quantity, unit, quantity_milli, canonical_unit, lot_id)
        VALUES ('foreign-ref-2', '${foreignId}', 'MANUAL', 'cross', '{}', '${now}', '${now}',
        'CHICKEN_EGG', 'OBSERVED', 2, 1, '${now}', '${now}', 1, 'piece', 1000, 'piece',
        '${globalThis.t10LotId}')`,
    ]);
    expect(crossResult.status).toBe(409);
    expect(crossResult.error).toContain('household mismatch');
  });
});
