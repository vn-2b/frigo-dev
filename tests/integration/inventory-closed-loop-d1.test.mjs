import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, unstable_splitSqlQuery } from 'wrangler';

// T12 real workerd/D1 closed-loop proof: observation -> reconciliation -> T09
// command authority -> inventory_lots -> T11 read authority -> product funnel.
// Runs on actual local D1 (isolated database, fresh 0001..0030 chain).
let worker;
let directory;
const token = randomUUID();
const now = '2026-09-12T10:00:00Z';
const later = '2026-09-12T11:00:00Z';

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

const scopes = new Map();
const lotId = (scope, base) => `${base}-${scopes.get(scope)}`;
async function household(label, { legacy = [] } = {}) {
  const id = randomUUID();
  const scope = { householdId: `hh-${label}-${id}`, actorId: `actor-${label}-${id}` };
  scopes.set(scope, id.slice(0, 8));
  expect(await batch([
    { sql: 'INSERT INTO users(id) VALUES (?)', values: [scope.actorId] },
    { sql: 'INSERT INTO households(id,name,created_by) VALUES (?, ?, ?)', values: [scope.householdId, `T12 ${label}`, scope.actorId] },
    { sql: "INSERT INTO household_members(id,household_id,user_id,role) VALUES (?, ?, ?, 'owner')",
      values: [`member-${id}`, scope.householdId, scope.actorId] },
  ])).toMatchObject({ status: 200 });
  // Legacy rows must precede the explicit adoption so their mapping is receipted.
  for (const base of legacy) await legacyRow(scope, base);
  expect(await post('adopt', { scope, now })).toMatchObject({ status: 200 });
  return scope;
}
async function location(scope, type = 'FRIDGE') {
  return (await batch([{ sql: 'SELECT id FROM storage_locations WHERE household_id = ? AND type = ?',
    values: [scope.householdId, type] }])).results[0].results[0].id;
}
async function createLot(scope, base, patch = {}) {
  const id = lotId(scope, base);
  const result = await post('command', { scope, key: `create-${id}`, now, input: {
    type: 'CREATE', lotId: id, ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 10, unit: 'piece',
    storageLocationId: await location(scope), sourceType: 'MANUAL', ...patch,
  } });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 200, replayed: false });
  return id;
}
async function legacyRow(scope, base, patch = {}) {
  const id = lotId(scope, base);
  const row = { ingredient_id: 'RICE', name: 'Rice', quantity: 2, unit: 'kg', storage: 'pantry', ...patch };
  expect(await batch([{ sql: `INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit, category,
    storage, expiry_date, expiry_kind, expiry_source, created_at, updated_at, added_date, data_source)
    VALUES (?, ?, ?, ?, ?, ?, 'grain', ?, NULL, 'unknown', 'unknown', ?, ?, ?, 'manual')`,
  values: [id, scope.householdId, row.ingredient_id, row.name, row.quantity, row.unit, row.storage,
    '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z'] }])).toMatchObject({ status: 200 });
  return id;
}
const read = (scope, extra = {}) => post('read', { scope, ...extra });
const observe = (scope, lot, claim, sourceRef = 't12') => post('observe', { scope, now: later, input: {
  sourceType: 'MANUAL', sourceRef, observedAt: later, ingredientId: 'CHICKEN_EGG', rawName: null,
  lotId: lot, legacyItemId: null, evidence: 'OBSERVED', note: null,
  claim: { quantity: 7, unit: 'piece', quantityMilli: 7_000, canonicalUnit: 'piece',
    storage: null, expiryDate: null, expiryKind: null, openedAt: null, ...claim },
} });
const counts = async (scope) => {
  const result = await batch([
    { sql: "SELECT count(*) AS n FROM inventory_commands WHERE household_id = ? AND client_key NOT LIKE 'create-%'", values: [scope.householdId] },
    { sql: 'SELECT count(*) AS n FROM inventory_reconciliation_decisions WHERE household_id = ?', values: [scope.householdId] },
    { sql: "SELECT count(*) AS n FROM inventory_events e JOIN inventory_commands c ON c.id = e.command_id WHERE c.household_id = ? AND c.client_key NOT LIKE 'create-%'", values: [scope.householdId] },
    { sql: 'SELECT status, version FROM inventory_observations WHERE household_id = ?', values: [scope.householdId] },
  ]);
  const [commands, decisions, events, observations] = result.results.map((statement) => statement.results);
  return { commands: commands[0].n, decisions: decisions[0].n, events: events[0].n, observations };
};

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'frigo-t12-d1-'));
  const config = path.join(directory, 'wrangler.json');
  writeFileSync(config, JSON.stringify({ name: 'frigo-t12-local-proof', compatibility_date: '2025-03-01' }));
  worker = await unstable_dev(path.resolve('tests/helpers/inventory-lot-d1-worker.ts'), {
    config, ip: '127.0.0.1', port: 0, inspectorPort: 0, local: true, persist: false,
    logLevel: 'error', vars: { TEST_TOKEN: token },
    experimental: {
      disableExperimentalWarning: true, disableDevRegistry: true, forceLocal: true, watch: false,
      d1Databases: [{ binding: 'DB', database_name: 't12-isolated-test', database_id: '00000000-0000-0000-0000-000000000032' }],
    },
  });
  for (const file of readdirSync('migrations').filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
    const result = await batch(unstable_splitSqlQuery(readFileSync(`migrations/${file}`, 'utf8')));
    expect(result, file).toMatchObject({ status: 200 });
  }
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('T12 real local D1 closed loop', () => {
  it('A. observation → accepted CORRECT+MOVE → T09 → lots → T11: 10/fridge before, 7/freezer after, exactly once, replay, altered-key conflict', async () => {
    const scope = await household('accept');
    const eggs = await createLot(scope, 'eggs');
    const freezer = await location(scope, 'FREEZER');
    const observed = await observe(scope, eggs, { quantity: 7, storage: 'freezer' });
    expect(observed).toMatchObject({ status: 200 });
    // Evidence only: authority read unchanged.
    expect((await read(scope)).authority.items[0]).toMatchObject({ quantity: 10, storage: 'fridge', version: 1 });
    const plan = await post('plan', { householdId: scope.householdId, observation: observed.observation });
    expect(plan.status).toBe(200);
    const [finding] = plan.findings;
    expect(finding.proposals.map((p) => p.type)).toEqual(['CORRECT', 'MOVE']);
    const decision = { decisionKey: 'accept-7', observationId: observed.observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT', proposals: finding.proposals };
    const confirmed = await post('reconcile', { scope, decision, now: later });
    expect(confirmed).toMatchObject({ status: 200, replayed: false, decisionType: 'CORRECT' });
    // Authority poststate, exactly once.
    const after = await read(scope);
    expect(after.authority.items[0]).toMatchObject({ quantity: 7, quantityMilli: 7_000, storage: 'freezer', storageLocationId: freezer, version: 3 });
    expect(after.parity).toEqual([]);
    expect(await counts(scope)).toEqual({ commands: 2, decisions: 1, events: 2, observations: [{ status: 'RECONCILED', version: 2 }] });
    expect((await post('funnel', { scope })).items[0]).toMatchObject({ id: eggs, quantity: 7, storage: 'freezer' });
    // Exact retry: replay, no duplicates.
    expect(await post('reconcile', { scope, decision, now: later })).toMatchObject({ status: 200, replayed: true });
    expect(await counts(scope)).toMatchObject({ commands: 2, decisions: 1, events: 2 });
    // Altered semantics on the same key: conflict.
    const altered = await post('reconcile', { scope, now: later, decision: { ...decision, proposals: [finding.proposals[0]] } });
    expect(altered).toMatchObject({ status: 409, error: 'IDEMPOTENCY_CONFLICT' });
    expect(await counts(scope)).toMatchObject({ commands: 2, decisions: 1, events: 2 });
  });

  it('B. DISMISS: observation reconciled, lot stays 10, no stock command, read stays 10', async () => {
    const scope = await household('dismiss');
    const eggs = await createLot(scope, 'eggs');
    const observed = await observe(scope, eggs, { quantity: 99, quantityMilli: 99_000 }, 'phantom-99');
    const decision = { decisionKey: 'dismiss-99', observationId: observed.observation.observationId,
      expectedObservationVersion: 1, decisionType: 'DISMISS' };
    expect(await post('reconcile', { scope, decision, now: later })).toMatchObject({ status: 200, replayed: false, decisionType: 'DISMISS', executions: [] });
    expect(await counts(scope)).toEqual({ commands: 0, decisions: 1, events: 0, observations: [{ status: 'RECONCILED', version: 2 }] });
    expect((await read(scope)).authority.items[0]).toMatchObject({ quantity: 10, version: 1 });
    expect((await post('funnel', { scope })).items[0]).toMatchObject({ quantity: 10 });
  });

  it('C. read → USE 200 g → read: 500 g then 300 g, no stale KV/projection influence', async () => {
    const scope = await household('use');
    const pork = await createLot(scope, 'pork', { ingredientId: 'GROUND_PORK', rawName: 'Pork', quantity: 500, unit: 'g' });
    expect((await read(scope)).authority.items[0]).toMatchObject({ lotId: pork, quantity: 500, unit: 'g', quantityMilli: 500_000 });
    expect(await post('command', { scope, key: 'use-200', now, input: {
      type: 'USE', mode: 'FEFO', ingredientId: 'GROUND_PORK', quantity: 200, unit: 'g', reason: 'Curry' } })).toMatchObject({ status: 200, replayed: false });
    expect((await read(scope)).authority.items[0]).toMatchObject({ quantity: 300, quantityMilli: 300_000, version: 2 });
    const funnel = await post('funnel', { scope });
    expect(funnel.items[0]).toMatchObject({ id: pork, quantity: 300 });
    expect(funnel.kvWrites).toEqual([]);
  });

  it('D. FEFO across two lots: A=0 CONSUMED, B=6 ACTIVE; current read sees only B, history proves A', async () => {
    const scope = await household('fefo');
    const early = await createLot(scope, 'eggs-early', { expiryAt: '2026-09-14', expiryKind: 'KNOWN' });
    const late = await createLot(scope, 'eggs-late', { expiryAt: '2026-09-30', expiryKind: 'KNOWN' });
    expect(await post('command', { scope, key: 'cook-14', now, input: {
      type: 'USE', mode: 'FEFO', ingredientId: 'CHICKEN_EGG', quantity: 14, unit: 'piece', reason: 'Baking' } })).toMatchObject({ status: 200 });
    const current = await read(scope);
    expect(current.authority.items.map((item) => [item.lotId, item.quantity, item.state])).toEqual([[late, 6, 'ACTIVE']]);
    const history = await read(scope, { query: { includeTerminal: true } });
    expect(Object.fromEntries(history.authority.items.map((item) => [item.lotId, [item.quantity, item.state, item.version]])))
      .toEqual({ [early]: [0, 'CONSUMED', 2], [late]: [6, 'ACTIVE', 2] });
  });

  it('E. projection drift: authority 8, projection 100 → read 8, QUANTITY_DRIFT, funnel 8', async () => {
    const scope = await household('drift');
    const eggs = await createLot(scope, 'eggs', { quantity: 8 });
    expect(await batch([{ sql: 'UPDATE inventory_items SET quantity = 100 WHERE id = ? AND household_id = ?', values: [eggs, scope.householdId] }])).toMatchObject({ status: 200 });
    const result = await read(scope);
    expect(result.authority.items[0]).toMatchObject({ quantity: 8, quantityMilli: 8_000 });
    expect(result.parity).toEqual([{ code: 'QUANTITY_DRIFT', lotId: eggs, legacyItemId: eggs, detail: 'Projection 100piece vs lot 8000milli/piece' }]);
    expect((await post('funnel', { scope })).items[0]).toMatchObject({ id: eggs, quantity: 8 });
  });

  it('F. response-loss retry of a durable mutation replays without duplicate lot/event/receipt', async () => {
    const scope = await household('retry');
    const input = { type: 'CREATE', lotId: lotId(scope, 'milk'), ingredientId: 'FRESH_MILK', rawName: 'Milk', quantity: 1, unit: 'l',
      storageLocationId: await location(scope), sourceType: 'SHOPPING', sourceId: 'shopping-run-1' };
    expect(await post('command', { scope, key: 'buy-milk', now, input })).toMatchObject({ status: 200, replayed: false });
    expect(await post('command', { scope, key: 'buy-milk', now, input })).toMatchObject({ status: 200, replayed: true });
    const facts = await batch([
      { sql: 'SELECT count(*) AS n FROM inventory_lots WHERE household_id = ?', values: [scope.householdId] },
      { sql: 'SELECT count(*) AS n FROM inventory_commands WHERE household_id = ?', values: [scope.householdId] },
      { sql: 'SELECT count(*) AS n FROM inventory_events WHERE household_id = ?', values: [scope.householdId] },
    ]);
    expect(facts.results.map((statement) => statement.results[0].n)).toEqual([1, 1, 1]);
    expect((await read(scope)).authority.items[0]).toMatchObject({ quantity: 1000, unit: 'ml', quantityMilli: 1_000_000 });
    // Same key, altered payload: conflict without a second lot.
    const altered = await post('command', { scope, key: 'buy-milk', now, input: { ...input, quantity: 2 } });
    expect(altered).toMatchObject({ status: 409, error: 'IDEMPOTENCY_CONFLICT' });
  });

  it('G. cross-tenant: B cannot read, reconcile, mutate or legacy-resolve A (not-found / tenancy-safe)', async () => {
    const a = await household('tenant-a', { legacy: ['a-rice'] });
    const b = await household('tenant-b');
    const aRice = lotId(a, 'a-rice');
    const aEggs = await createLot(a, 'a-eggs');
    const observed = await observe(a, aEggs, { quantity: 7 }, 'a-count');
    expect(observed.status).toBe(200);
    // read A lot / resolve A legacy mapping
    expect(await read(b, { lot: { lotId: aEggs } })).toMatchObject({ status: 409, error: 'LOT_NOT_FOUND' });
    expect(await read(b, { lot: { legacyItemId: aRice } })).toMatchObject({ status: 409, error: 'LOT_NOT_FOUND' });
    // reconcile A observation
    const plan = await post('plan', { householdId: a.householdId, observation: observed.observation });
    const decision = { decisionKey: 'b-steals', observationId: observed.observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT', proposals: plan.findings[0].proposals };
    expect(await post('reconcile', { scope: b, decision, now: later })).toMatchObject({ status: 409, error: 'OBSERVATION_NOT_FOUND' });
    // mutate A lot
    for (const [key, input] of [
      ['b-correct', { type: 'CORRECT', lotId: aEggs, expectedVersion: 1, changes: { quantity: 1 }, reason: 'B' }],
      ['b-move', { type: 'MOVE', lotId: aEggs, expectedVersion: 1, storageLocationId: await location(b) }],
      ['b-discard', { type: 'DISCARD', lotId: aEggs, expectedVersion: 1, quantity: 10, unit: 'piece', reason: 'B' }],
    ]) {
      const attempt = await post('command', { scope: b, key, now, input });
      expect(attempt.status, key).toBe(409);
      expect(attempt.error, key).toMatch(/^(LOT_NOT_FOUND|ADOPTION_REQUIRED|INVALID_COMMAND|STALE_SNAPSHOT)$/);
    }
    // A untouched; B still empty; A observation still OPEN.
    expect((await read(a)).authority.items.find((item) => item.lotId === aEggs)).toMatchObject({ quantity: 10, version: 1 });
    expect((await read(b)).authority.items).toEqual([]);
    expect(await counts(a)).toMatchObject({ commands: 0, decisions: 0, observations: [{ status: 'OPEN', version: 1 }] });
  });

  it('H. reconciliation vs manual CORRECT on real D1: manual wins (9 v2), loser is explicit STALE_SNAPSHOT, nothing of the loser committed', async () => {
    const scope = await household('race');
    const eggs = await createLot(scope, 'eggs');
    const observed = await observe(scope, eggs, { quantity: 7 }, 'race-count');
    const plan = await post('plan', { householdId: scope.householdId, observation: observed.observation });
    const decision = { decisionKey: 'race-7', observationId: observed.observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT', proposals: plan.findings[0].proposals };
    const race = await post('reconcile-vs-manual', { scope, now: later, decision, manual: { scope, key: 'manual-9', now, input: {
      type: 'CORRECT', lotId: eggs, expectedVersion: 1, changes: { quantity: 9 }, reason: 'Manual wins' } } });
    expect(race.status).toBe(200);
    expect(race.winner.execution).toMatchObject({ replayed: false });
    expect(race.loser).toMatchObject({ name: 'LotCommandError', code: 'STALE_SNAPSHOT' });
    expect((await read(scope)).authority.items[0]).toMatchObject({ quantity: 9, version: 2 });
    expect(await counts(scope)).toEqual({ commands: 1, decisions: 0, events: 1, observations: [{ status: 'OPEN', version: 1 }] });
    expect((await read(scope)).parity).toEqual([]);
  });
});
