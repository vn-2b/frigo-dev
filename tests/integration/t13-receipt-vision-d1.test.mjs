import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, unstable_splitSqlQuery } from 'wrangler';

// T13 real workerd/D1 proof. Everything here runs against the real migrations
// (0001-0031), the real CHECK constraints and triggers, and the REAL scan
// confirm / inventory truth Hono handlers — not a reimplementation.

let worker;
let directory;
const token = randomUUID();
const now = '2026-09-11T10:00:00Z';
const scope = { householdId: '', actorId: '' };
const foreign = { householdId: '', actorId: '' };

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

const query = async (sql, values = []) => (await batch([{ sql, values }])).results[0].results;

async function seedHousehold(target, label) {
  const id = randomUUID();
  target.householdId = `household-${id}`;
  target.actorId = `actor-${id}`;
  expect(await batch([
    { sql: 'INSERT INTO users(id) VALUES (?)', values: [target.actorId] },
    { sql: 'INSERT INTO households(id,name,created_by) VALUES (?, ?, ?)', values: [target.householdId, label, target.actorId] },
    { sql: "INSERT INTO household_members(id,household_id,user_id,role) VALUES (?, ?, ?, 'owner')",
      values: [`member-${id}`, target.householdId, target.actorId] },
  ])).toMatchObject({ status: 200 });
  expect(await post('adopt', { scope: target, now })).toMatchObject({ status: 200 });
}

async function seedScan(options) {
  const owner = options.scope ?? scope;
  await batch([
    { sql: `INSERT INTO scans (id, user_id, household_id, status, scan_type, merchant_name, purchase_date)
        VALUES (?, ?, ?, 'ready', ?, ?, ?)`,
      values: [options.scanId, owner.actorId, owner.householdId, options.scanType,
        options.merchant ?? null, options.purchaseDate ?? null] },
    ...options.lines.map((line) => ({
      sql: `INSERT INTO scan_items (id, scan_id, raw_name, canonical_id, estimated_quantity, unit,
        confidence, category, storage, unit_price_vnd, total_price_vnd,
        ocr_raw_name, ocr_quantity, ocr_unit, ocr_confidence)
        VALUES (?, ?, ?, NULL, ?, ?, 0.9, 'other', 'fridge', ?, ?, ?, ?, ?, ?)`,
      values: [line.id, options.scanId, line.rawName, line.quantity, line.unit,
        line.unitPriceVnd ?? null, line.totalPriceVnd ?? null,
        line.rawName, line.quantity, line.unit, line.confidence ?? null],
    })),
  ]);
}

const confirm = (scanId, items, owner = scope) =>
  post('scan-confirm', { scope: owner, scanId, items });

const lotsOf = (householdId) => query(
  `SELECT id, source_type, source_id, purchased_at, currency, amount_minor, minor_digits,
     expiry_at, estimated_expiry_at, expiry_kind, quantity_milli, raw_name
   FROM inventory_lots WHERE household_id = ? ORDER BY id`, [householdId]);

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'frigo-t13-d1-'));
  const config = path.join(directory, 'wrangler.json');
  writeFileSync(config, JSON.stringify({ name: 'frigo-t13-local-proof', compatibility_date: '2025-03-01' }));
  worker = await unstable_dev(path.resolve('tests/helpers/inventory-lot-d1-worker.ts'), {
    config, ip: '127.0.0.1', port: 0, inspectorPort: 0, local: true, persist: false,
    logLevel: 'error', vars: { TEST_TOKEN: token },
    experimental: {
      disableExperimentalWarning: true, disableDevRegistry: true, forceLocal: true, watch: false,
      d1Databases: [{ binding: 'DB', database_name: 't13-isolated-test', database_id: '00000000-0000-0000-0000-000000000031' }],
    },
  });
  // Fresh 0001 -> 0031 replay on real D1.
  for (const file of readdirSync('migrations').filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
    const result = await batch(unstable_splitSqlQuery(readFileSync(`migrations/${file}`, 'utf8')));
    expect(result, file).toMatchObject({ status: 200 });
  }
  await seedHousehold(scope, 'T13 D1');
  await seedHousehold(foreign, 'T13 D1 foreign');
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('T13 real local D1 receipt/vision truth (no remote binding)', () => {
  it('1. receipt confirmation creates a RECEIPT lot readable through T11 authority', async () => {
    await seedScan({ scanId: 'd1-receipt-1', scanType: 'receipt',
      lines: [{ id: 'd1-line-1', rawName: 'Ca chua', quantity: 3, unit: 'piece' }] });
    const result = await confirm('d1-receipt-1', [
      { id: 'd1-line-1', rawName: 'Ca chua', estimatedQuantity: 3, unit: 'piece' },
    ]);
    expect(result).toMatchObject({ status: 200 });
    expect(result.body.success).toBe(true);

    const lot = (await lotsOf(scope.householdId)).find((entry) => entry.raw_name === 'Ca chua');
    expect(lot.source_type).toBe('RECEIPT');
    expect(lot.source_id).toBe('d1-receipt-1');

    const read = await post('read', { scope, lot: { lotId: lot.id } });
    expect(read.status).toBe(200);
    expect(read.lot).toMatchObject({ lotId: lot.id, sourceType: 'RECEIPT' });
  });

  it('2. receipt purchase facts are persisted exactly by the real schema', async () => {
    await seedScan({ scanId: 'd1-receipt-2', scanType: 'receipt', purchaseDate: '2026-09-10',
      merchant: 'WinMart',
      lines: [{ id: 'd1-line-2', rawName: 'Thit heo', quantity: 2, unit: 'kg', totalPriceVnd: 85000 }] });
    expect(await confirm('d1-receipt-2', [
      { id: 'd1-line-2', rawName: 'Thit heo', estimatedQuantity: 2, unit: 'kg' },
    ])).toMatchObject({ status: 200 });

    const lot = (await lotsOf(scope.householdId)).find((entry) => entry.raw_name === 'Thit heo');
    expect(lot.purchased_at).toBe('2026-09-10');
    expect(lot.currency).toBe('VND');
    expect(lot.amount_minor).toBe(85000);
    expect(lot.minor_digits).toBe(0);
  });

  it('3. missing purchase facts stay NULL rather than fabricated', async () => {
    await seedScan({ scanId: 'd1-receipt-3', scanType: 'receipt',
      lines: [{ id: 'd1-line-3', rawName: 'Hanh tay', quantity: 2, unit: 'piece' }] });
    expect(await confirm('d1-receipt-3', [
      { id: 'd1-line-3', rawName: 'Hanh tay', estimatedQuantity: 2, unit: 'piece' },
    ])).toMatchObject({ status: 200 });

    const lot = (await lotsOf(scope.householdId)).find((entry) => entry.raw_name === 'Hanh tay');
    expect(lot.purchased_at).toBeNull();
    expect(lot.amount_minor).toBeNull();
    expect(lot.currency).toBeNull();
  });

  it('4. estimated vs known expiry are distinguished under the real 0023 CHECK', async () => {
    await seedScan({ scanId: 'd1-receipt-4', scanType: 'receipt',
      lines: [
        { id: 'd1-line-4a', rawName: 'Sua tuoi', quantity: 1, unit: 'l' },
        { id: 'd1-line-4b', rawName: 'Sua chua', quantity: 4, unit: 'piece' },
      ] });
    expect(await confirm('d1-receipt-4', [
      // No date supplied: default shelf life is an estimate.
      { id: 'd1-line-4a', rawName: 'Sua tuoi', estimatedQuantity: 1, unit: 'l' },
      // Explicit date: a dated fact.
      { id: 'd1-line-4b', rawName: 'Sua chua', estimatedQuantity: 4, unit: 'piece', expiryDate: '2026-09-30' },
    ])).toMatchObject({ status: 200 });

    const lots = await lotsOf(scope.householdId);
    const estimated = lots.find((entry) => entry.raw_name === 'Sua tuoi');
    expect(estimated.expiry_kind).toBe('ESTIMATED');
    expect(estimated.expiry_at).toBeNull();
    expect(estimated.estimated_expiry_at).not.toBeNull();

    const known = lots.find((entry) => entry.raw_name === 'Sua chua');
    expect(known.expiry_kind).toBe('KNOWN');
    expect(known.expiry_at).toBe('2026-09-30');
    expect(known.estimated_expiry_at).toBeNull();
  });

  it('5. raw OCR evidence survives a correction in the real 0031 columns', async () => {
    await seedScan({ scanId: 'd1-receipt-5', scanType: 'receipt',
      lines: [{ id: 'd1-line-5', rawName: 'Thit ga', quantity: 2, unit: 'kg' }] });
    expect(await confirm('d1-receipt-5', [
      { id: 'd1-line-5', rawName: 'Thit ga', estimatedQuantity: 1.2, unit: 'kg' },
    ])).toMatchObject({ status: 200 });

    const [line] = await query(
      'SELECT estimated_quantity, ocr_quantity, ocr_raw_name, review_state FROM scan_items WHERE id = ?',
      ['d1-line-5']);
    expect(line.estimated_quantity).toBe(1.2);
    expect(line.ocr_quantity).toBe(2);
    expect(line.review_state).toBe('CONFIRMED');
  });

  it('6. observation evidence reaches reconciliation and an authoritative result', async () => {
    await seedScan({ scanId: 'd1-fridge-6', scanType: 'fridge',
      lines: [{ id: 'd1-line-6', rawName: 'Ca rot', quantity: 5, unit: 'piece' }] });
    expect(await confirm('d1-fridge-6', [
      { id: 'd1-line-6', rawName: 'Ca rot', estimatedQuantity: 5, unit: 'piece' },
    ])).toMatchObject({ status: 200 });

    const [observation] = await query(
      'SELECT id, source_type, source_ref, status, version FROM inventory_observations WHERE source_ref = ?',
      ['d1-fridge-6:d1-line-6']);
    expect(observation.source_type).toBe('SCAN');
    expect(observation.status).toBe('OPEN');

    // The additive UX route lists it with the deterministic planner verdict.
    const list = await post('observations-route', { scope, path: '/inventory/observations' });
    expect(list.status).toBe(200);
    const listed = list.body.observations.find((entry) => entry.observationId === observation.id);
    expect(listed).toBeTruthy();
    expect(listed.dataSource).toBe('scan');

    // Decide it through the real route; the T10 executor composes T09.
    const decision = await post('observations-route', {
      scope, method: 'POST',
      path: `/inventory/observations/${observation.id}/decision`,
      payload: {
        decisionKey: `d1-dismiss-${observation.id}`, observationId: observation.id,
        expectedObservationVersion: observation.version, decisionType: 'DISMISS',
      },
    });
    expect(decision.status).toBe(201);
    expect((await query('SELECT status FROM inventory_observations WHERE id = ?', [observation.id]))[0].status)
      .toBe('RECONCILED');
  });

  it('7. confirmation replay after response loss duplicates neither stock nor evidence', async () => {
    await seedScan({ scanId: 'd1-receipt-7', scanType: 'receipt',
      lines: [{ id: 'd1-line-7', rawName: 'Khoai tay', quantity: 4, unit: 'piece' }] });
    const items = [{ id: 'd1-line-7', rawName: 'Khoai tay', estimatedQuantity: 4, unit: 'piece' }];

    expect(await confirm('d1-receipt-7', items)).toMatchObject({ status: 200 });
    const afterFirst = (await lotsOf(scope.householdId)).filter((entry) => entry.raw_name === 'Khoai tay');
    expect(afterFirst).toHaveLength(1);

    const replay = await confirm('d1-receipt-7', items);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);

    expect((await lotsOf(scope.householdId)).filter((entry) => entry.raw_name === 'Khoai tay'))
      .toEqual(afterFirst);
    expect(await query('SELECT id FROM inventory_observations WHERE source_ref = ?', ['d1-receipt-7:d1-line-7']))
      .toHaveLength(1);
  });

  it('8. a concurrent second confirmation loses without duplicating stock', async () => {
    await seedScan({ scanId: 'd1-receipt-8', scanType: 'receipt',
      lines: [{ id: 'd1-line-8', rawName: 'Bap cai', quantity: 2, unit: 'piece' }] });
    const items = [{ id: 'd1-line-8', rawName: 'Bap cai', estimatedQuantity: 2, unit: 'piece' }];

    const [first, second] = await Promise.all([
      confirm('d1-receipt-8', items),
      confirm('d1-receipt-8', items),
    ]);
    // Both requests are answered; exactly one mutation exists.
    expect([first.status, second.status]).toEqual([200, 200]);
    const created = (await lotsOf(scope.householdId)).filter((entry) => entry.raw_name === 'Bap cai');
    expect(created).toHaveLength(1);
    expect(created[0].quantity_milli).toBe(2000);
    expect(await query('SELECT id FROM inventory_observations WHERE source_ref = ?', ['d1-receipt-8:d1-line-8']))
      .toHaveLength(1);
  });

  it('9. cross-tenant lot/observation access is refused by the real handlers', async () => {
    const lots = await lotsOf(scope.householdId);
    const lot = lots[0];
    const foreignLotRead = await post('observations-route', {
      scope: foreign, path: `/inventory/lots/${lot.id}`,
    });
    expect(foreignLotRead.status).toBe(404);

    const foreignList = await post('observations-route', { scope: foreign, path: '/inventory/observations' });
    expect(foreignList.status).toBe(200);
    expect(foreignList.body.observations).toEqual([]);

    // A's data is untouched by B's attempts.
    expect((await lotsOf(foreign.householdId)).length).toBe(0);
  });

  it('10. a MOVE/CORRECT is visible in the very next T11 authority read', async () => {
    await seedScan({ scanId: 'd1-receipt-10', scanType: 'receipt',
      lines: [{ id: 'd1-line-10', rawName: 'Dau phu', quantity: 2, unit: 'piece' }] });
    expect(await confirm('d1-receipt-10', [
      { id: 'd1-line-10', rawName: 'Dau phu', estimatedQuantity: 2, unit: 'piece' },
    ])).toMatchObject({ status: 200 });

    const lot = (await lotsOf(scope.householdId)).find((entry) => entry.raw_name === 'Dau phu');
    const pantry = (await query(
      "SELECT id FROM storage_locations WHERE household_id = ? AND type = 'PANTRY' AND is_default = 1",
      [scope.householdId]))[0];

    const before = await post('read', { scope, lot: { lotId: lot.id } });
    const moved = await post('command', {
      scope, key: `d1-move-${lot.id}`, now,
      input: { type: 'MOVE', lotId: lot.id, expectedVersion: before.lot.version, storageLocationId: pantry.id },
    });
    expect(moved.status).toBe(200);

    const after = await post('read', { scope, lot: { lotId: lot.id } });
    expect(after.lot.storage).toBe('pantry');
    expect(after.lot.version).toBeGreaterThan(before.lot.version);
    // Provenance is not disturbed by a later mutation.
    expect(after.lot.sourceType).toBe('RECEIPT');
  });

  it('11. the 0031 review-state trigger fails closed on real D1', async () => {
    const halfConfirmed = await batch([{
      sql: `INSERT INTO scan_items (id, scan_id, raw_name, estimated_quantity, unit, confidence,
        is_confirmed, review_state) VALUES (?, ?, 'x', 1, 'piece', 0.5, 0, 'CONFIRMED')`,
      values: [`bad-${randomUUID()}`, 'd1-receipt-1'],
    }]);
    expect(halfConfirmed.status).toBe(409);
  });
});
