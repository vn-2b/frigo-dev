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

async function requestCommand(pathname, body) {
  const response = await worker.fetch(`http://localhost/${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-token': token },
    body: JSON.stringify(body),
  });
  return { status: response.status, ...await response.json() };
}

async function raceFixture(type) {
  const id = randomUUID();
  const scope = { householdId: `household-${id}`, actorId: `actor-${id}` };
  const now = '2026-09-10T10:00:00Z';
  expect(await batch([
    { sql: 'INSERT INTO users(id) VALUES (?)', values: [scope.actorId] },
    { sql: 'INSERT INTO households(id,name,created_by) VALUES (?, ?, ?)', values: [scope.householdId, 'Private D1 race', scope.actorId] },
    { sql: "INSERT INTO household_members(id,household_id,user_id,role) VALUES (?, ?, ?, 'owner')",
      values: [`member-${id}`, scope.householdId, scope.actorId] },
    ...['FRIDGE', 'PANTRY'].map((storage) => ({
      sql: `INSERT INTO storage_locations(id,household_id,type,name,sort_order,is_default,created_at,updated_at)
        VALUES (?, ?, ?, ?, 0, 0, ?, ?)`, values: [`${storage}-${id}`, scope.householdId, storage, storage, now, now],
    })),
  ])).toMatchObject({ status: 200 });
  const create = { type: 'CREATE', lotId: `lot-${id}`, rawName: 'D1 race eggs', ingredientId: 'CHICKEN_EGG',
    quantity: 10, unit: 'piece', storageLocationId: `FRIDGE-${id}`, sourceType: 'MANUAL',
    ...(type === 'OPEN_NOOP' ? { openedAt: now } : {}) };
  if (type !== 'CREATE') expect(await requestCommand('command', { scope, key: 'seed', input: create, now }))
    .toMatchObject({ status: 200, replayed: false });
  const common = { lotId: create.lotId, expectedVersion: 1 };
  const input = type === 'CREATE' ? create
    : type === 'OPEN' || type === 'OPEN_NOOP' ? { ...common, type: 'OPEN', openedAt: now }
      : type === 'MOVE' ? { ...common, type, storageLocationId: `PANTRY-${id}` }
        : type === 'CORRECT' ? { ...common, type, changes: { quantity: 8 }, reason: 'Counted' }
          : { ...common, type, quantity: 7, unit: 'piece' };
  const changed = type === 'CREATE' ? { ...input, rawName: 'Different label' }
    : type === 'OPEN' || type === 'OPEN_NOOP' ? { ...input, openedAt: '2026-09-10T11:00:00Z' }
      : type === 'MOVE' ? { ...input, storageLocationId: `FRIDGE-${id}` }
        : type === 'CORRECT' ? { ...input, reason: 'Different evidence' }
          : { ...input, quantity: 6 };
  const facts = async () => {
    const result = await batch(['households', 'inventory_lots', 'inventory_items', 'inventory_commands', 'inventory_events']
      .map((table) => ({ sql: `SELECT * FROM ${table} WHERE ${table === 'households' ? 'id' : 'household_id'} = ? ORDER BY id`,
        values: [scope.householdId] })));
    expect(result.status).toBe(200);
    return result.results.map((entry) => entry.results);
  };
  return { scope, input, changed, now, facts };
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'frigo-t09-d1-'));
  const config = path.join(directory, 'wrangler.json');
  writeFileSync(config, JSON.stringify({ name: 'frigo-t09-local-proof', compatibility_date: '2025-03-01' }));
  worker = await unstable_dev(path.resolve('tests/helpers/inventory-lot-d1-worker.ts'), {
    config, ip: '127.0.0.1', port: 0, inspectorPort: 0, local: true, persist: false,
    logLevel: 'error', vars: { TEST_TOKEN: token },
    experimental: {
      disableExperimentalWarning: true, disableDevRegistry: true, forceLocal: true, watch: false,
      d1Databases: [{ binding: 'DB', database_name: 't09-isolated-test', database_id: '00000000-0000-0000-0000-000000000024' }],
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

describe('T09 real local D1 batch semantics (no remote binding)', () => {
  it('replays the full schema with D1-supported foreign-key and quick checks', async () => {
    const result = await batch(['PRAGMA foreign_key_check', 'PRAGMA quick_check', 'SELECT count(*) AS total FROM inventory_commands']);
    expect(result, result.error).toMatchObject({ status: 200 });
    expect(result.results[0].results).toEqual([]);
    expect(result.results[1].results).toEqual([{ quick_check: 'ok' }]);
    expect(result.results[2].results).toEqual([{ total: 0 }]);
  });

  it('returns the exact CAS row and keeps changes() tied to the top-level write despite revision triggers', async () => {
    const result = await batch([
      "UPDATE inventory_items SET quantity = 10, version = version + 1 WHERE id = 'item_01' AND version = 1 RETURNING id, quantity, version",
      'SELECT changes() AS changed',
      "SELECT inventory_version FROM households WHERE id = 'demo_household_01'",
    ]);
    expect(result).toMatchObject({ status: 200 });
    expect(result.results[0].results).toEqual([{ id: 'item_01', quantity: 10, version: 2 }]);
    expect(result.results[1].results).toEqual([{ changed: 1 }]);
    expect(result.results[2].results).toEqual([{ inventory_version: 2 }]);
  });

  it('rolls back receipt, earlier stock, revision and events when a later CAS guard fails', async () => {
    const before = await batch([
      "SELECT id, quantity, version FROM inventory_items WHERE id IN ('item_01', 'item_02') ORDER BY id",
      "SELECT inventory_version FROM households WHERE id = 'demo_household_01'",
      'SELECT count(*) AS total FROM inventory_events',
    ]);
    const result = await batch([
      `INSERT INTO inventory_commands(id,household_id,actor_id,client_key,fingerprint,command_type,result_json,created_at)
       VALUES ('rollback-proof','demo_household_01','demo_user_01','rollback-key','payload','USE','{}','2026-09-10T00:00:00Z')`,
      "UPDATE inventory_items SET quantity = quantity - 1, version = version + 1 WHERE id = 'item_01'",
      "UPDATE inventory_items SET quantity = quantity - 1, version = version + 1 WHERE id = 'item_02' AND version = -1",
      `INSERT INTO inventory_events(id,household_id,inventory_item_id,event_type,quantity_delta,unit)
       SELECT 'invalid-guard',NULL,NULL,'LOT_GUARD',0,'piece' WHERE changes() <> 1`,
    ]);
    expect(result.status).toBe(409);
    expect(result.error).toContain('NOT NULL');
    const after = await batch([
      "SELECT id, quantity, version FROM inventory_items WHERE id IN ('item_01', 'item_02') ORDER BY id",
      "SELECT inventory_version FROM households WHERE id = 'demo_household_01'",
      'SELECT count(*) AS total FROM inventory_events',
      'SELECT id FROM inventory_commands',
    ]);
    expect(after.status).toBe(200);
    expect(after.results.slice(0, 3).map((entry) => entry.results))
      .toEqual(before.results.map((entry) => entry.results));
    expect(after.results[3].results).toEqual([]);
  });

  it('executes the actual command repository and replays the exact result on D1', async () => {
    expect(await batch([
      "INSERT INTO users(id) VALUES ('runtime-user')",
      "INSERT INTO households(id,name,created_by) VALUES ('runtime-household','Runtime household','runtime-user')",
      "INSERT INTO household_members(id,household_id,user_id,role) VALUES ('runtime-member','runtime-household','runtime-user','owner')",
      `INSERT INTO storage_locations(id,household_id,type,name,sort_order,is_default,created_at,updated_at)
       VALUES ('runtime-fridge','runtime-household','FRIDGE','Local fridge',0,1,'2026-09-10','2026-09-10')`,
    ])).toMatchObject({ status: 200 });
    const command = async (key, input) => {
      const response = await worker.fetch('http://localhost/command', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-token': token },
        body: JSON.stringify({ scope: { householdId: 'runtime-household', actorId: 'runtime-user' },
          key, input, now: '2026-09-10T10:00:00Z' }),
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      return result;
    };
    await command('runtime-create', { type: 'CREATE', lotId: 'runtime-lot', rawName: 'Local eggs',
      ingredientId: 'CHICKEN_EGG', quantity: 10, unit: 'piece', storageLocationId: 'runtime-fridge', sourceType: 'MANUAL' });
    const intent = { type: 'USE', lotId: 'runtime-lot', expectedVersion: 1, quantity: 10, unit: 'piece' };
    const used = await command('runtime-use', intent);
    const retry = await command('runtime-use', intent);
    expect(retry).toEqual({ result: used.result, replayed: true });
    expect(used.result.effects[0].after).toMatchObject({ quantityMilli: 0, state: 'CONSUMED', version: 2, legacyVersion: 2 });
    const rows = await batch([
      "SELECT quantity, freshness, version FROM inventory_items WHERE id = 'runtime-lot'",
      "SELECT count(*) AS total FROM inventory_events WHERE inventory_item_id = 'runtime-lot'",
    ]);
    expect(rows.results[0].results).toEqual([{ quantity: 0, freshness: 'out_of_stock', version: 2 }]);
    expect(rows.results[1].results).toEqual([{ total: 2 }]);
  });
});

describe('T09D real D1 controlled receipt and event authority', () => {
  it('rejects mutually matching receipt/event quantities that contradict the persisted lot', async () => {
    const { scope, input, now, facts } = await raceFixture('USE');
    const executed = await requestCommand('command', { scope, input: { ...input, quantity: 2 }, key: 'actual-use', now });
    expect(executed).toMatchObject({ status: 200 });
    const before = await facts();
    const receipt = before[3].find((row) => row.id === executed.result.commandId);
    const event = before[4].find((row) => row.command_id === receipt.id);
    const id = randomUUID();
    const result = JSON.parse(receipt.result_json);
    result.commandId = id;
    result.effects[0].after.quantityMilli = 7000;
    result.effects[0].deltaMilli = -3000;
    const metadata = { ...JSON.parse(event.metadata), commandId: id, clientKey: 'forged-poststate',
      after: result.effects[0].after, deltaMilli: -3000,
      allocation: [{ lotId: input.lotId, deltaMilli: -3000, canonicalUnit: 'piece' }] };
    const rejected = await batch([
      { sql: `INSERT INTO inventory_commands
        (id, household_id, actor_id, client_key, fingerprint, command_type, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, 'USE', ?, ?)`,
      values: [id, scope.householdId, scope.actorId, 'forged-poststate', receipt.fingerprint, JSON.stringify(result), now] },
      { sql: `INSERT INTO inventory_events
        (id, household_id, inventory_item_id, command_id, event_type, quantity_delta, unit, metadata, created_at)
        VALUES (?, ?, ?, ?, 'MANUAL_UPDATE', -3, 'piece', ?, ?)`,
      values: [randomUUID(), scope.householdId, input.lotId, id, JSON.stringify(metadata), now] },
    ]);
    expect(rejected.status).toBe(409);
    expect(rejected.error).toContain('Inventory command event evidence mismatch');
    expect(await facts()).toEqual(before);
    expect(before[1][0]).toMatchObject({ quantity_milli: 8000, version: 2 });
  });

  it.each(['CREATE', 'USE', 'DISCARD', 'OPEN', 'MOVE', 'CORRECT', 'OPEN_NOOP'].flatMap((type) =>
    [false, true].map((different) => [type, different])))('%s same-key race, changed intent=%s', async (type, different) => {
    const { scope, input, changed, now, facts } = await raceFixture(type);
    const winner = { scope, input, key: 'race', now };
    const contender = { ...winner, input: different ? changed : input, now: '2026-09-11T10:00:00Z' };
    const race = await requestCommand('race', { winner, contender });
    expect(race).toMatchObject({ status: 200, arrivals: 1, winner: { execution: { replayed: false } } });
    const committed = race.winner.execution;
    if (different) expect(race.contender).toEqual({ error: 'IDEMPOTENCY_CONFLICT' });
    else expect(race.contender).toEqual({ execution: { result: committed.result, replayed: true } });
    const beforeRetry = await facts();
    const [, lots, items, receipts, events] = beforeRetry;
    expect(lots).toHaveLength(1);
    expect(items).toHaveLength(1);
    const receipt = receipts.find((row) => row.client_key === 'race');
    expect(JSON.parse(receipt.result_json)).toEqual(committed.result);
    expect(receipts).toHaveLength(type === 'CREATE' ? 1 : 2);
    expect(events).toHaveLength((type === 'CREATE' ? 0 : 1) + committed.result.effects.length);
    for (const effect of committed.result.effects) {
      const event = events.find((row) => row.command_id === receipt.id);
      expect(JSON.parse(event.metadata)).toMatchObject({ commandId: receipt.id, fingerprint: receipt.fingerprint,
        actorId: scope.actorId, before: effect.before, after: effect.after, deltaMilli: effect.deltaMilli });
      expect(event.quantity_delta).toBe(effect.deltaMilli / 1000);
      expect(lots[0]).toMatchObject({ quantity_milli: effect.after.quantityMilli, version: effect.after.version });
      expect(items[0]).toMatchObject({ quantity: effect.after.quantityMilli / 1000, version: effect.after.legacyVersion });
    }
    const retry = await requestCommand('command', contender);
    expect(retry).toEqual(different ? { status: 409, error: 'IDEMPOTENCY_CONFLICT' }
      : { status: 200, result: committed.result, replayed: true });
    expect(await facts()).toEqual(beforeRetry);
  });

  it('rolls back a real command receipt, projection, lot and revision on a late event failure', async () => {
    const { scope, input, now, facts } = await raceFixture('USE');
    const before = await facts();
    expect(await batch([`CREATE TRIGGER t09_d1_event_failure BEFORE INSERT ON inventory_events
      WHEN NEW.command_id IS NOT NULL AND NEW.household_id = '${scope.householdId}'
      BEGIN SELECT RAISE(ABORT, 'Controlled local D1 event failure'); END;`])).toMatchObject({ status: 200 });
    expect(await requestCommand('command', { scope, input, key: 'late-failure', now }))
      .toEqual({ status: 409, error: 'PERSISTENCE_FAILED' });
    expect(await facts()).toEqual(before);
    expect(await batch(['DROP TRIGGER t09_d1_event_failure', 'PRAGMA foreign_key_check']))
      .toMatchObject({ status: 200, results: [{ success: true }, { success: true, results: [] }] });
  });

  it.each(['no-op', 'unrelated-lot', 'metadata', 'delta', 'reason'])('rejects %s event evidence on real D1', async (kind) => {
    const { scope, input, now, facts } = await raceFixture(kind === 'no-op' ? 'OPEN_NOOP' : 'USE');
    if (kind === 'unrelated-lot') {
      const seed = (await facts())[1][0];
      expect(await requestCommand('command', { scope, key: 'other-lot', now,
        input: { type: 'CREATE', lotId: 'other-' + input.lotId, rawName: 'Other eggs', quantity: 1,
          unit: 'piece', storageLocationId: seed.storage_location_id, sourceType: 'MANUAL' } }))
        .toMatchObject({ status: 200 });
    }
    const executed = await requestCommand('command', { scope, input, key: 'event-proof', now });
    expect(executed).toMatchObject({ status: 200 });
    const before = await facts();
    const receipt = before[3].find((row) => row.id === executed.result.commandId);
    const event = kind === 'no-op' ? before[4][0] : before[4].find((row) => row.command_id === receipt.id);
    const metadata = { ...JSON.parse(event.metadata), commandId: receipt.id, commandType: receipt.command_type,
      clientKey: receipt.client_key, fingerprint: receipt.fingerprint };
    if (kind === 'no-op') {
      metadata.before = metadata.after;
      metadata.deltaMilli = 0;
      metadata.allocation[0].deltaMilli = 0;
    }
    if (kind === 'metadata') metadata.actorId = 'forged-actor';
    const attempted = await batch([{
      sql: `INSERT INTO inventory_events
        (id, household_id, inventory_item_id, command_id, event_type, quantity_delta, unit, reason, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [randomUUID(), scope.householdId, kind === 'unrelated-lot' ? 'other-' + input.lotId : input.lotId,
        receipt.id, kind === 'no-op' ? 'MANUAL_UPDATE' : event.event_type,
        kind === 'no-op' ? 0 : kind === 'delta' ? -9 : event.quantity_delta, event.unit,
        kind === 'reason' ? 'Forged reason' : event.reason, JSON.stringify(metadata), event.created_at],
    }]);
    expect(attempted.status).toBe(409);
    expect(attempted.error).toContain('Inventory command event evidence mismatch');
    expect(await facts()).toEqual(before);
  });
});
