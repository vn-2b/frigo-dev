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
