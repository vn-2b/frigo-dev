import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, unstable_splitSqlQuery } from 'wrangler';

// T11 real workerd/D1 proof of the inventory read authority. Every case runs
// against actual local D1 (isolated database, fresh 0001..0030 chain), not
// the SqliteD1 test adapter.
let worker;
let directory;
const token = randomUUID();
const now = '2026-09-12T10:00:00Z';

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

// Each case gets its own household (isolated tenant) on the shared D1. Lot ids
// are a global primary key, so every lot id is suffixed per household.
const scopes = new Map();
const lotId = (scope, base) => `${base}-${scopes.get(scope)}`;
async function household(label) {
  const id = randomUUID();
  const scope = { householdId: `hh-${label}-${id}`, actorId: `actor-${label}-${id}` };
  scopes.set(scope, id.slice(0, 8));
  expect(await batch([
    { sql: 'INSERT INTO users(id) VALUES (?)', values: [scope.actorId] },
    { sql: 'INSERT INTO households(id,name,created_by) VALUES (?, ?, ?)', values: [scope.householdId, `T11 ${label}`, scope.actorId] },
    { sql: "INSERT INTO household_members(id,household_id,user_id,role) VALUES (?, ?, ?, 'owner')",
      values: [`member-${id}`, scope.householdId, scope.actorId] },
  ])).toMatchObject({ status: 200 });
  return scope;
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
async function adopt(scope) {
  const result = await post('adopt', { scope, now });
  expect(result).toMatchObject({ status: 200 });
  return result;
}
async function fridge(scope) {
  return (await batch([{ sql: "SELECT id FROM storage_locations WHERE household_id = ? AND type = 'FRIDGE'",
    values: [scope.householdId] }])).results[0].results[0].id;
}
async function createLot(scope, base, patch = {}) {
  const id = lotId(scope, base);
  const result = await post('command', { scope, key: `create-${id}`, now, input: {
    type: 'CREATE', lotId: id, ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 10, unit: 'piece',
    storageLocationId: await fridge(scope), sourceType: 'MANUAL', ...patch,
  } });
  expect(result, JSON.stringify(result)).toMatchObject({ status: 200, replayed: false });
  return id;
}
const read = (scope, extra = {}) => post('read', { scope, ...extra });

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'frigo-t11-d1-'));
  const config = path.join(directory, 'wrangler.json');
  writeFileSync(config, JSON.stringify({ name: 'frigo-t11-local-proof', compatibility_date: '2025-03-01' }));
  worker = await unstable_dev(path.resolve('tests/helpers/inventory-lot-d1-worker.ts'), {
    config, ip: '127.0.0.1', port: 0, inspectorPort: 0, local: true, persist: false,
    logLevel: 'error', vars: { TEST_TOKEN: token },
    experimental: {
      disableExperimentalWarning: true, disableDevRegistry: true, forceLocal: true, watch: false,
      d1Databases: [{ binding: 'DB', database_name: 't11-isolated-test', database_id: '00000000-0000-0000-0000-000000000031' }],
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

describe('T11 real local D1 read authority', () => {
  it('A. adopted native read: lot-derived data, native mode, no legacy/KV fallback', async () => {
    const scope = await household('native');
    await adopt(scope);
    const eggs = await createLot(scope, 'eggs', { expiryAt: '2026-09-30', expiryKind: 'KNOWN' });
    const result = await read(scope, { query: { now: Date.parse(now) }, lot: { lotId: eggs }, summary: { ingredientIds: ['CHICKEN_EGG'] } });
    expect(result).toMatchObject({ status: 200, mode: 'native' });
    expect(result.authority.items).toHaveLength(1);
    expect(result.authority.items[0]).toMatchObject({
      lotId: eggs, legacyItemId: eggs, quantity: 10, unit: 'piece', quantityMilli: 10_000, canonicalUnit: 'piece',
      storage: 'fridge', state: 'ACTIVE', expiryAt: '2026-09-30', estimatedExpiryAt: null, expiryKind: 'KNOWN',
      freshness: 'fresh', sourceType: 'MANUAL', version: 1,
    });
    expect(result.parity).toEqual([]);
    expect(result.lot).toMatchObject({ lotId: eggs, quantity: 10 });
    expect(result.summary).toMatchObject({ activeCount: 1 });
    const funnel = await post('funnel', { scope });
    expect(funnel.status).toBe(200);
    expect(funnel.items.map((item) => [item.id, item.lotId, item.quantity, item.unit])).toEqual([[eggs, eggs, 10, 'piece']]);
    expect(funnel.kvWrites).toEqual([]); // stale KV neither served nor refreshed
  });

  it('B. adopted but empty household: valid receipt, zero lots -> native mode, [] — never legacy rows, never KV, never auto-adoption', async () => {
    const scope = await household('empty');
    const adoption = await adopt(scope);
    expect(adoption.result).toMatchObject({ emptyHousehold: true, mappedLotCount: 0 });
    const receipts = (await batch([{ sql: 'SELECT count(*) AS n FROM inventory_adoption_receipts WHERE household_id = ?', values: [scope.householdId] }])).results[0].results[0].n;
    expect(receipts).toBe(1);
    const result = await read(scope);
    expect(result).toMatchObject({ status: 200, mode: 'native' });
    expect(result.authority.items).toEqual([]);
    expect(result.parity).toEqual([]);
    const funnel = await post('funnel', { scope });
    expect(funnel).toMatchObject({ status: 200, items: [], kvWrites: [] });
    // No auto-adoption or lot creation as a side effect of reading.
    const after = await batch([
      { sql: 'SELECT count(*) AS n FROM inventory_adoption_receipts WHERE household_id = ?', values: [scope.householdId] },
      { sql: 'SELECT count(*) AS n FROM inventory_lots WHERE household_id = ?', values: [scope.householdId] },
      { sql: 'SELECT count(*) AS n FROM inventory_items WHERE household_id = ?', values: [scope.householdId] },
    ]);
    expect(after.results.map((statement) => statement.results[0].n)).toEqual([1, 0, 0]);
  });

  it('B2. adopted household whose only lot became terminal: current view [], historical view shows the DISCARDED lot', async () => {
    const scope = await household('terminal');
    await adopt(scope);
    const eggs = await createLot(scope, 'eggs');
    expect(await post('command', { scope, key: 'discard', now, input: {
      type: 'DISCARD', lotId: eggs, expectedVersion: 1, quantity: 10, unit: 'piece', reason: 'Spoiled' } })).toMatchObject({ status: 200 });
    const current = await read(scope);
    expect(current).toMatchObject({ status: 200, mode: 'native' });
    expect(current.authority.items).toEqual([]);
    const history = await read(scope, { query: { includeTerminal: true } });
    expect(history.authority.items[0]).toMatchObject({ lotId: eggs, state: 'DISCARDED', quantity: 0, quantityMilli: 0, version: 2, freshness: 'out_of_stock' });
    expect((await post('funnel', { scope })).items).toEqual([]);
  });

  it('C. synthetic LEGACY_BACKFILL mapping: lot id differs from projection id; kg alias presents exactly; no equal-ID assumption', async () => {
    const scope = await household('backfill');
    const rice = await legacyRow(scope, 'rice-row');
    const milk = await legacyRow(scope, 'milk-row', { ingredient_id: 'FRESH_MILK', name: 'Milk', quantity: 1.5, unit: 'l', storage: 'fridge' });
    await adopt(scope);
    const eggs = await createLot(scope, 'eggs-native');
    const result = await read(scope, { lot: { legacyItemId: rice } });
    expect(result).toMatchObject({ status: 200, mode: 'native' });
    const view = Object.fromEntries(result.authority.items.map((item) =>
      [item.lotId, [item.legacyItemId, item.quantity, item.unit, item.quantityMilli, item.canonicalUnit, item.sourceType]]));
    expect(view).toEqual({
      [eggs]: [eggs, 10, 'piece', 10_000, 'piece', 'MANUAL'],
      [`t08-legacy:${milk}`]: [milk, 1.5, 'l', 1_500_000, 'ml', 'LEGACY_BACKFILL'],
      [`t08-legacy:${rice}`]: [rice, 2, 'kg', 2_000_000, 'g', 'LEGACY_BACKFILL'],
    });
    expect(result.lot).toMatchObject({ lotId: `t08-legacy:${rice}`, legacyItemId: rice, quantity: 2, unit: 'kg' });
    expect(result.parity).toEqual([]);
    // API identity: backfilled rows keep the legacy id, native lots their own id.
    const funnel = await post('funnel', { scope });
    expect(funnel.items.map((item) => [item.id, item.lotId]).sort()).toEqual([
      [eggs, eggs], [milk, `t08-legacy:${milk}`], [rice, `t08-legacy:${rice}`]].sort());
  });

  it('D. projection drift: lot 8, projection corrupted to 100 -> authority reads 8, parity reports QUANTITY_DRIFT, funnel serves 8', async () => {
    const scope = await household('drift');
    await adopt(scope);
    const eggs = await createLot(scope, 'eggs', { quantity: 8 });
    expect(await batch([{ sql: 'UPDATE inventory_items SET quantity = 100 WHERE id = ? AND household_id = ?', values: [eggs, scope.householdId] }])).toMatchObject({ status: 200 });
    const result = await read(scope);
    expect(result.authority.items[0]).toMatchObject({ quantity: 8, quantityMilli: 8_000 });
    expect(result.parity).toEqual([{ code: 'QUANTITY_DRIFT', lotId: eggs, legacyItemId: eggs,
      detail: 'Projection 100piece vs lot 8000milli/piece' }]);
    expect((await post('funnel', { scope })).items[0]).toMatchObject({ id: eggs, quantity: 8 });
    // Storage drift is detected too; authority storage is unchanged.
    expect(await batch([{ sql: "UPDATE inventory_items SET quantity = 8, storage = 'freezer' WHERE id = ? AND household_id = ?", values: [eggs, scope.householdId] }])).toMatchObject({ status: 200 });
    const storage = await read(scope);
    expect(storage.authority.items[0].storage).toBe('fridge');
    expect(storage.parity).toEqual([{ code: 'STORAGE_DRIFT', lotId: eggs, legacyItemId: eggs, detail: 'Projection storage diverges' }]);
  });

  it('E. READ vs CORRECT on real D1: paused writer -> coherent before snapshot, then coherent after', async () => {
    const scope = await household('race-correct');
    await adopt(scope);
    const eggs = await createLot(scope, 'eggs');
    const race = await post('read-race', { writer: { scope, key: 'correct', now, input: {
      type: 'CORRECT', lotId: eggs, expectedVersion: 1, changes: { quantity: 7 }, reason: 'Counted' } } });
    expect(race.status).toBe(200);
    expect(race.writer.execution).toMatchObject({ replayed: false });
    expect(race.during.items[0]).toMatchObject({ quantity: 10, version: 1 });
    expect(race.after.items[0]).toMatchObject({ quantity: 7, version: 2 });
    expect(race.during.inventoryVersion).toBeLessThan(race.after.inventoryVersion);
  });

  it('E2. READ vs MOVE on real D1: original location/version before, new after, never mixed', async () => {
    const scope = await household('race-move');
    await adopt(scope);
    const eggs = await createLot(scope, 'eggs');
    const freezer = (await batch([{ sql: "SELECT id FROM storage_locations WHERE household_id = ? AND type = 'FREEZER'", values: [scope.householdId] }])).results[0].results[0].id;
    const race = await post('read-race', { writer: { scope, key: 'move', now, input: {
      type: 'MOVE', lotId: eggs, expectedVersion: 1, storageLocationId: freezer } } });
    expect(race.writer.execution).toMatchObject({ replayed: false });
    expect(race.during.items[0]).toMatchObject({ storage: 'fridge', version: 1 });
    expect(race.after.items[0]).toMatchObject({ storage: 'freezer', storageLocationId: freezer, version: 2, quantity: 10 });
  });

  it('E3. READ vs DISCARD on real D1: ACTIVE before, excluded from current after, DISCARDED/0 in history', async () => {
    const scope = await household('race-discard');
    await adopt(scope);
    const eggs = await createLot(scope, 'eggs');
    const race = await post('read-race', { writer: { scope, key: 'discard', now, input: {
      type: 'DISCARD', lotId: eggs, expectedVersion: 1, quantity: 10, unit: 'piece', reason: 'Spoiled' } }, query: { includeTerminal: true } });
    expect(race.writer.execution).toMatchObject({ replayed: false });
    expect(race.during.items[0]).toMatchObject({ state: 'ACTIVE', quantity: 10, version: 1 });
    expect(race.after.items[0]).toMatchObject({ state: 'DISCARDED', quantity: 0, version: 2 });
    expect((await read(scope)).authority.items).toEqual([]);
  });

  it('E4. READ vs FEFO on real D1: multi-lot consumption is coherent before OR after, never a cross-lot hybrid', async () => {
    const scope = await household('race-fefo');
    await adopt(scope);
    const early = await createLot(scope, 'eggs-early', { expiryAt: '2026-09-14', expiryKind: 'KNOWN' });
    const late = await createLot(scope, 'eggs-late', { expiryAt: '2026-09-30', expiryKind: 'KNOWN' });
    const race = await post('read-race', { writer: { scope, key: 'fefo', now, input: {
      type: 'USE', mode: 'FEFO', ingredientId: 'CHICKEN_EGG', quantity: 14, unit: 'piece', reason: 'Baking' } }, query: { includeTerminal: true } });
    expect(race.status).toBe(200);
    expect(race.writer.execution, JSON.stringify(race.writer)).toBeDefined();
    const byLot = (snapshot) => Object.fromEntries(snapshot.items.map((item) => [item.lotId, [item.quantity, item.version, item.state]]));
    expect(byLot(race.during)).toEqual({ [early]: [10, 1, 'ACTIVE'], [late]: [10, 1, 'ACTIVE'] });
    expect(byLot(race.after)).toEqual({ [early]: [0, 2, 'CONSUMED'], [late]: [6, 2, 'ACTIVE'] });
  });

  it('F. tenancy on real D1: a foreign household cannot resolve another household lot or legacy id', async () => {
    const a = await household('tenant-a');
    const b = await household('tenant-b');
    const aRice = await legacyRow(a, 'a-rice');
    await adopt(a);
    await adopt(b);
    const aEggs = await createLot(a, 'a-eggs');
    const viaLot = await read(b, { lot: { lotId: aEggs } });
    expect(viaLot.status).toBe(409);
    expect(viaLot.error).toBe('LOT_NOT_FOUND');
    const viaLegacy = await read(b, { lot: { legacyItemId: aRice } });
    expect(viaLegacy.error).toBe('LOT_NOT_FOUND');
    expect((await read(b)).authority.items).toEqual([]);
  });

  it('G. non-adopted household: mode legacy; authority read is refused (ADOPTION_REQUIRED); funnel serves the legacy compatibility read', async () => {
    const scope = await household('legacy');
    const legacyOnly = await legacyRow(scope, 'legacy-only');
    const result = await read(scope);
    expect(result).toMatchObject({ status: 409, error: 'ADOPTION_REQUIRED' });
    const funnel = await post('funnel', { scope });
    expect(funnel.status).toBe(200);
    expect(funnel.items).toHaveLength(1);
    expect(funnel.items[0]).toMatchObject({ id: legacyOnly, quantity: 2, unit: 'kg' });
    expect(funnel.items[0].lotId).toBeUndefined();
  });
});
