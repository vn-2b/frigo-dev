import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import { observationIdentity } from '../../packages/domain/src/inventory-observations';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { inventoryRoutes } from '../../src/worker/routes/inventory';
import { inventoryTruthRoutes } from '../../src/worker/routes/inventory-truth';
import { scanRoutes } from '../../src/worker/routes/scans';
import type { AuthContext, Env } from '../../src/worker/types';
import { signJwt } from '../../src/worker/utils/jwt';
import { SqliteD1 } from '../helpers/sqlite-d1';

// T13 closed-loop integration: receipt/vision evidence -> review -> T10
// observation -> T09 authority -> T11 read -> Inventory UX contracts, over
// real SQLite with the real route handlers and real migrations.

const scope = { householdId: 't13-household', actorId: 't13-user' };
const other = { householdId: 't13-other', actorId: 't13-other-user' };
const secret = 'test-only-t13-receipt-vision-truth-secret-value';
const now = '2026-09-11T10:00:00Z';

const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
app.use('*', authMiddleware);
app.route('/', inventoryRoutes);
app.route('/', inventoryTruthRoutes);
app.route('/', scanRoutes);

let db: SqliteD1;
let token: string;
let otherToken: string;

beforeEach(async () => {
  db = new SqliteD1();
  db.seed(`INSERT INTO users(id) VALUES ('t13-user'), ('t13-other-user');
    INSERT INTO households(id, name, created_by, created_at, updated_at) VALUES
      ('t13-household', 'T13', 't13-user', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      ('t13-other', 'Other', 't13-other-user', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
    INSERT INTO household_members(id, household_id, user_id, role) VALUES
      ('t13-member', 't13-household', 't13-user', 'owner'),
      ('t13-other-member', 't13-other', 't13-other-user', 'owner');`);
  token = await signJwt({ sub: scope.actorId, hid: scope.householdId, typ: 'access',
    exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
  otherToken = await signJwt({ sub: other.actorId, hid: other.householdId, typ: 'access',
    exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
});
afterEach(() => db.close());

async function request(method: string, path: string, body?: unknown,
  headers: Record<string, string> = {}, bearer = token) {
  const response = await app.fetch(new Request(`https://t13.example${path}`, {
    method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { DB: db, ENVIRONMENT: 'test', JWT_SECRET: secret, WEEK_SCHEMA_MODE: 'legacy' });
  return { status: response.status, json: await response.json() as Record<string, any> };
}

/** Adopt the household so the T09/T11 authority governs it. */
async function adopt(target = scope) {
  await backfillLegacyInventory(db, target.householdId);
  await executeInventoryAdoption(db, target, {}, now);
}

interface SeedLine {
  id: string; rawName: string; quantity: number; unit: string;
  confidence?: number | null; totalPriceVnd?: number | null; unitPriceVnd?: number | null;
}

function seedScan(options: {
  scanId: string; scanType: 'receipt' | 'fridge'; householdId?: string; actorId?: string;
  purchaseDate?: string | null; merchant?: string | null; lines: SeedLine[];
}) {
  const householdId = options.householdId ?? scope.householdId;
  const actorId = options.actorId ?? scope.actorId;
  db.seed(`INSERT INTO scans (id, user_id, household_id, status, scan_type, merchant_name, purchase_date)
    VALUES ('${options.scanId}', '${actorId}', '${householdId}', 'ready', '${options.scanType}',
      ${options.merchant === undefined || options.merchant === null ? 'NULL' : `'${options.merchant}'`},
      ${options.purchaseDate === undefined || options.purchaseDate === null ? 'NULL' : `'${options.purchaseDate}'`});`);
  for (const line of options.lines) {
    db.seed(`INSERT INTO scan_items (id, scan_id, raw_name, canonical_id, estimated_quantity, unit,
      confidence, category, storage, unit_price_vnd, total_price_vnd,
      ocr_raw_name, ocr_quantity, ocr_unit, ocr_confidence)
      VALUES ('${line.id}', '${options.scanId}', '${line.rawName}', NULL, ${line.quantity}, '${line.unit}',
        0.9, 'other', 'fridge',
        ${line.unitPriceVnd == null ? 'NULL' : line.unitPriceVnd},
        ${line.totalPriceVnd == null ? 'NULL' : line.totalPriceVnd},
        '${line.rawName}', ${line.quantity}, '${line.unit}',
        ${line.confidence == null ? 'NULL' : line.confidence});`);
  }
}

function lots() {
  return db.query<any>(`SELECT id, source_type, source_id, purchased_at, currency, amount_minor,
    minor_digits, expiry_at, estimated_expiry_at, expiry_kind, quantity_milli, canonical_unit, raw_name
    FROM inventory_lots ORDER BY id`);
}

describe('T13 receipt provenance and purchase facts', () => {
  it('AC1/AC2: a receipt confirmation creates a RECEIPT lot carrying real purchase facts', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-1', scanType: 'receipt', purchaseDate: '2026-09-10', merchant: 'WinMart',
      lines: [{ id: 'line-1', rawName: 'Thịt heo', quantity: 2, unit: 'kg', confidence: 0.55, totalPriceVnd: 85000 }] });

    const result = await request('POST', '/scans/receipt-1/confirm', {
      items: [{ id: 'line-1', rawName: 'Thịt heo', estimatedQuantity: 2, unit: 'kg' }],
    });
    expect(result.status).toBe(200);

    const [lot] = lots();
    // Receipt provenance, not the pre-T13 collapse into SCAN.
    expect(lot.source_type).toBe('RECEIPT');
    expect(lot.source_id).toBe('receipt-1');
    // Real receipt facts survive to the lot, exactly.
    expect(lot.purchased_at).toBe('2026-09-10');
    expect(lot.currency).toBe('VND');
    expect(lot.amount_minor).toBe(85000);
    expect(lot.minor_digits).toBe(0);
  });

  it('AC2: absent purchase facts stay NULL instead of becoming 0₫ / today', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-2', scanType: 'receipt', purchaseDate: null,
      lines: [{ id: 'line-2', rawName: 'Cà chua', quantity: 3, unit: 'piece', totalPriceVnd: null }] });

    expect((await request('POST', '/scans/receipt-2/confirm', {
      items: [{ id: 'line-2', rawName: 'Cà chua', estimatedQuantity: 3, unit: 'piece' }],
    })).status).toBe(200);

    const [lot] = lots();
    expect(lot.source_type).toBe('RECEIPT');
    expect(lot.purchased_at).toBeNull();
    expect(lot.amount_minor).toBeNull();
    expect(lot.currency).toBeNull();
  });

  it('AC1: a fridge scan stays SCAN and never acquires purchase facts', async () => {
    await adopt();
    // A fridge scan row that nonetheless carries a stray purchase_date must not
    // be promoted into receipt facts.
    seedScan({ scanId: 'fridge-1', scanType: 'fridge', purchaseDate: '2026-09-10',
      lines: [{ id: 'line-3', rawName: 'Trứng gà', quantity: 6, unit: 'piece' }] });

    expect((await request('POST', '/scans/fridge-1/confirm', {
      items: [{ id: 'line-3', rawName: 'Trứng gà', estimatedQuantity: 6, unit: 'piece' }],
    })).status).toBe(200);

    const [lot] = lots();
    expect(lot.source_type).toBe('SCAN');
    expect(lot.purchased_at).toBeNull();
    expect(lot.amount_minor).toBeNull();
  });

  it('AC1: provenance follows the server-side scan type, not client-supplied text', async () => {
    await adopt();
    seedScan({ scanId: 'fridge-2', scanType: 'fridge',
      lines: [{ id: 'line-4', rawName: 'Trứng gà', quantity: 6, unit: 'piece' }] });

    expect((await request('POST', '/scans/fridge-2/confirm', {
      items: [{ id: 'line-4', rawName: 'Trứng gà', estimatedQuantity: 6, unit: 'piece',
        // Hostile client input attempting to claim receipt provenance.
        sourceType: 'RECEIPT', dataSource: 'receipt' }],
    })).status).toBe(200);

    expect(lots()[0].source_type).toBe('SCAN');
  });
});

describe('T13 expiry truth', () => {
  it('AC3: an inferred shelf-life date becomes ESTIMATED, never KNOWN', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-3', scanType: 'receipt',
      lines: [{ id: 'line-5', rawName: 'Thịt heo', quantity: 1, unit: 'kg' }] });

    expect((await request('POST', '/scans/receipt-3/confirm', {
      items: [{ id: 'line-5', rawName: 'Thịt heo', estimatedQuantity: 1, unit: 'kg' }],
    })).status).toBe(200);

    const [lot] = lots();
    // Pre-T13 this wrote expiry_kind = 'KNOWN' with a guessed shelf-life date.
    expect(lot.expiry_kind).toBe('ESTIMATED');
    expect(lot.expiry_at).toBeNull();
    expect(lot.estimated_expiry_at).not.toBeNull();
  });

  it('AC3: an explicitly picked date becomes KNOWN', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-4', scanType: 'receipt',
      lines: [{ id: 'line-6', rawName: 'Sữa tươi', quantity: 1, unit: 'l' }] });

    expect((await request('POST', '/scans/receipt-4/confirm', {
      items: [{ id: 'line-6', rawName: 'Sữa tươi', estimatedQuantity: 1, unit: 'l',
        expiryDate: '2026-09-25' }],
    })).status).toBe(200);

    const [lot] = lots();
    expect(lot.expiry_kind).toBe('KNOWN');
    expect(lot.expiry_at).toBe('2026-09-25');
    expect(lot.estimated_expiry_at).toBeNull();
  });

  it('AC3: a day-chip estimate stays ESTIMATED even though a date is supplied', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-5', scanType: 'receipt',
      lines: [{ id: 'line-7', rawName: 'Sữa tươi', quantity: 1, unit: 'l' }] });

    expect((await request('POST', '/scans/receipt-5/confirm', {
      items: [{ id: 'line-7', rawName: 'Sữa tươi', estimatedQuantity: 1, unit: 'l',
        expiryDate: '2026-09-18', expiryEstimated: true }],
    })).status).toBe(200);

    const [lot] = lots();
    expect(lot.expiry_kind).toBe('ESTIMATED');
    expect(lot.estimated_expiry_at).toBe('2026-09-18');
    expect(lot.expiry_at).toBeNull();
  });
});

describe('T13 raw evidence and line rejection', () => {
  it('AC6: raw OCR evidence survives a user correction', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-6', scanType: 'receipt',
      lines: [{ id: 'line-8', rawName: 'Thịt gà', quantity: 2, unit: 'kg' }] });

    expect((await request('POST', '/scans/receipt-6/confirm', {
      // The reviewer corrects 2 kg down to 1.2 kg.
      items: [{ id: 'line-8', rawName: 'Thịt gà', estimatedQuantity: 1.2, unit: 'kg' }],
    })).status).toBe(200);

    const [row] = db.query<any>("SELECT estimated_quantity, ocr_quantity, ocr_raw_name, review_state FROM scan_items WHERE id = 'line-8'");
    // Confirmed value AND the original extraction are both still readable.
    expect(row.estimated_quantity).toBe(1.2);
    expect(row.ocr_quantity).toBe(2);
    expect(row.ocr_raw_name).toBe('Thịt gà');
    expect(row.review_state).toBe('CONFIRMED');

    const detail = await request('GET', '/scans/receipt-6');
    const line = detail.json.scan.items.find((item: any) => item.id === 'line-8');
    expect(line.estimatedQuantity).toBe(1.2);
    expect(line.rawEvidence).toMatchObject({ estimatedQuantity: 2 });
  });

  it('AC5: an explicitly rejected line is recorded and never becomes stock', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-7', scanType: 'receipt',
      lines: [
        { id: 'line-keep', rawName: 'Cà chua', quantity: 3, unit: 'piece' },
        { id: 'line-drop', rawName: 'Nước rửa chén', quantity: 1, unit: 'piece' },
      ] });

    expect((await request('POST', '/scans/receipt-7/confirm', {
      items: [
        { id: 'line-keep', rawName: 'Cà chua', estimatedQuantity: 3, unit: 'piece' },
        { id: 'line-drop', rawName: 'Nước rửa chén', estimatedQuantity: 1, unit: 'piece', rejected: true },
      ],
    })).status).toBe(200);

    const rows = db.query<any>("SELECT id, review_state, is_confirmed FROM scan_items ORDER BY id");
    expect(rows).toEqual([
      { id: 'line-drop', review_state: 'REJECTED', is_confirmed: 0 },
      { id: 'line-keep', review_state: 'CONFIRMED', is_confirmed: 1 },
    ]);
    // Rejection is durable evidence, not just an omitted request line.
    expect(lots().map((lot) => lot.raw_name)).toEqual(['Cà chua']);
  });

  it('AC5: accepts the review DTO the server itself emitted, including null canonicalId', async () => {
    // Regression: the review UI round-trips the whole scan DTO. A line the
    // server emitted with canonicalId null (unmapped ingredient) plus the
    // read-only evidence fields must confirm, not fail validation. Found by
    // browser verification of the real receipt review flow.
    await adopt();
    seedScan({ scanId: 'receipt-dto', scanType: 'receipt', purchaseDate: '2026-09-10',
      lines: [{ id: 'line-dto', rawName: 'Nuoc mam Nam Ngu', quantity: 500, unit: 'ml', confidence: 0.95 }] });

    const detail = await request('GET', '/scans/receipt-dto');
    const line = detail.json.scan.items[0];
    expect(line.canonicalId).toBeNull();

    const confirmed = await request('POST', '/scans/receipt-dto/confirm', {
      // Exactly the shape the review page holds in state.
      items: [{ ...line, rawName: 'Nuoc mam (da sua)', estimatedQuantity: 500 }],
    });
    expect(confirmed.status).toBe(200);
    expect(lots().map((lot) => lot.raw_name)).toEqual(['Nuoc mam (da sua)']);
  });

  it('AC5/AC7: a realistic 64-char digest scan id confirms within the T09 key bound', async () => {
    // Regression: a real receipt scan id is a 64-char digest, and the derived
    // lot id embeds it, so `scan-confirm:<scanId>:<lotId>:create` exceeded the
    // 200-char T09 client-key bound and the authority rejected the whole
    // confirmation with INVALID_COMMAND. Found by browser verification.
    await adopt();
    const scanId = `receipt_${'a1b2c3d4'.repeat(8)}`;
    expect(scanId.length).toBeGreaterThan(64);
    const lineId = `receipt_item_${scanId}_0`;
    seedScan({ scanId, scanType: 'receipt', purchaseDate: '2026-09-10',
      lines: [{ id: lineId, rawName: 'Thit ba chi', quantity: 500, unit: 'g', totalPriceVnd: 85000 }] });

    const confirmed = await request('POST', `/scans/${scanId}/confirm`, {
      items: [{ id: lineId, rawName: 'Thit ba chi', estimatedQuantity: 500, unit: 'g' }],
    });
    expect(confirmed.status).toBe(200);

    const [lot] = lots();
    expect(lot.source_type).toBe('RECEIPT');
    expect(lot.amount_minor).toBe(85000);
    // Evidence identity stays inside the T10 bound too.
    const [observation] = db.query<any>('SELECT source_ref FROM inventory_observations');
    expect(observation.source_ref.length).toBeLessThanOrEqual(200);

    // Replay still resolves to the same command identity.
    const replay = await request('POST', `/scans/${scanId}/confirm`, {
      items: [{ id: lineId, rawName: 'Thit ba chi', estimatedQuantity: 500, unit: 'g' }],
    });
    expect(replay.status).toBe(200);
    expect(replay.json.idempotentReplay).toBe(true);
    expect(lots()).toHaveLength(1);
  });

  it('AC5/AC7: every line of a realistic digest-id receipt gets its own lot', async () => {
    // Regression: `receipt_item_<64-char digest>_<n>` exceeded the 80-char
    // identity slice, so all lines of one receipt truncated to the SAME lot id
    // and the confirmation died with LOT_EXISTS. Found by browser verification.
    await adopt();
    const scanId = `receipt_${'a1b2c3d4'.repeat(8)}`;
    const lines = [0, 1, 2].map((index) => ({
      id: `receipt_item_${scanId}_${index}`,
      rawName: ['Thit ba chi', 'Ca chua', 'Bap cai'][index],
      quantity: index + 1, unit: 'piece',
    }));
    expect(lines[0].id.length).toBeGreaterThan(80);
    seedScan({ scanId, scanType: 'receipt', lines });

    const confirmed = await request('POST', `/scans/${scanId}/confirm`, {
      items: lines.map((line) => ({
        id: line.id, rawName: line.rawName, estimatedQuantity: line.quantity, unit: line.unit,
      })),
    });
    expect(confirmed.status).toBe(200);

    // Three distinct lots, one per receipt line.
    const created = lots();
    expect(created).toHaveLength(3);
    expect(new Set(created.map((lot) => lot.id)).size).toBe(3);
    expect(created.map((lot) => lot.raw_name).sort()).toEqual(['Bap cai', 'Ca chua', 'Thit ba chi']);
    // And three distinct observations.
    const observations = db.query<any>('SELECT source_ref FROM inventory_observations');
    expect(new Set(observations.map((row) => row.source_ref)).size).toBe(3);
  });

  it('AC4: truthful confidence is surfaced, absent confidence stays absent', async () => {
    seedScan({ scanId: 'receipt-8', scanType: 'receipt',
      lines: [
        { id: 'line-known', rawName: 'Thịt heo', quantity: 1, unit: 'kg', confidence: 0.12 },
        { id: 'line-unknown', rawName: 'Cà chua', quantity: 2, unit: 'piece', confidence: null },
      ] });
    const detail = await request('GET', '/scans/receipt-8');
    const byId = Object.fromEntries(detail.json.scan.items.map((item: any) => [item.id, item]));
    expect(byId['line-known'].confidence).toBe(0.12);
    // Never a fabricated 0.9.
    expect(byId['line-unknown'].confidence).toBeUndefined();
  });
});

describe('T13 observation integration and atomicity', () => {
  it('AC7: confirmation records T10 evidence in the same commit as the T09 command', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-9', scanType: 'receipt',
      lines: [{ id: 'line-9', rawName: 'Cà chua', quantity: 3, unit: 'piece' }] });

    expect((await request('POST', '/scans/receipt-9/confirm', {
      items: [{ id: 'line-9', rawName: 'Cà chua', estimatedQuantity: 3, unit: 'piece' }],
    })).status).toBe(200);

    const observations = db.query<any>('SELECT source_type, source_ref, evidence, status, quantity, unit FROM inventory_observations');
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      source_type: 'RECEIPT', source_ref: 'receipt-9:line-9', status: 'OPEN', quantity: 3, unit: 'piece',
    });
    // Stock and evidence exist together.
    expect(lots()).toHaveLength(1);
  });

  it('AC7: a fridge confirmation records SCAN evidence', async () => {
    await adopt();
    seedScan({ scanId: 'fridge-3', scanType: 'fridge',
      lines: [{ id: 'line-10', rawName: 'Trứng gà', quantity: 6, unit: 'piece' }] });

    expect((await request('POST', '/scans/fridge-3/confirm', {
      items: [{ id: 'line-10', rawName: 'Trứng gà', estimatedQuantity: 6, unit: 'piece' }],
    })).status).toBe(200);

    expect(db.query<any>('SELECT source_type FROM inventory_observations')).toEqual([{ source_type: 'SCAN' }]);
  });

  it('AC7: observation integration adds no second stock writer', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-10', scanType: 'receipt',
      lines: [{ id: 'line-11', rawName: 'Cà chua', quantity: 3, unit: 'piece' }] });

    await request('POST', '/scans/receipt-10/confirm', {
      items: [{ id: 'line-11', rawName: 'Cà chua', estimatedQuantity: 3, unit: 'piece' }],
    });

    // Exactly one lot, created by exactly one T09 command. Evidence never
    // duplicates stock.
    expect(lots()).toHaveLength(1);
    const commands = db.query<any>("SELECT command_type FROM inventory_commands ORDER BY id");
    expect(commands.filter((command) => command.command_type === 'CREATE')).toHaveLength(1);
  });

  it('AC7: replaying a confirmation duplicates neither stock nor evidence', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-11', scanType: 'receipt',
      lines: [{ id: 'line-12', rawName: 'Cà chua', quantity: 3, unit: 'piece' }] });
    const payload = { items: [{ id: 'line-12', rawName: 'Cà chua', estimatedQuantity: 3, unit: 'piece' }] };

    expect((await request('POST', '/scans/receipt-11/confirm', payload)).status).toBe(200);
    const replay = await request('POST', '/scans/receipt-11/confirm', payload);
    expect(replay.status).toBe(200);
    expect(replay.json.idempotentReplay).toBe(true);

    expect(lots()).toHaveLength(1);
    expect(db.query<any>('SELECT id FROM inventory_observations')).toHaveLength(1);
    expect(lots()[0].quantity_milli).toBe(3000);
  });

  it('AC7: an altered-payload replay does not silently add more stock', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-12', scanType: 'receipt',
      lines: [{ id: 'line-13', rawName: 'Cà chua', quantity: 3, unit: 'piece' }] });

    expect((await request('POST', '/scans/receipt-12/confirm', {
      items: [{ id: 'line-13', rawName: 'Cà chua', estimatedQuantity: 3, unit: 'piece' }],
    })).status).toBe(200);
    const before = lots();

    // Documented existing semantics: a confirmed scan replays rather than
    // applying a different payload.
    const altered = await request('POST', '/scans/receipt-12/confirm', {
      items: [{ id: 'line-13', rawName: 'Cà chua', estimatedQuantity: 99, unit: 'piece' }],
    });
    expect(altered.status).toBe(200);
    expect(altered.json.idempotentReplay).toBe(true);
    expect(lots()).toEqual(before);
  });
});

describe('T13 Inventory UX V2 read routes and tenancy', () => {
  it('AC8/AC9: lot detail exposes provenance, expiry kind and purchase truth', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-13', scanType: 'receipt', purchaseDate: '2026-09-10',
      lines: [{ id: 'line-14', rawName: 'Thịt heo', quantity: 2, unit: 'kg', totalPriceVnd: 85000 }] });
    await request('POST', '/scans/receipt-13/confirm', {
      items: [{ id: 'line-14', rawName: 'Thịt heo', estimatedQuantity: 2, unit: 'kg' }],
    });

    const lotId = lots()[0].id;
    const detail = await request('GET', `/inventory/lots/${lotId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.lot).toMatchObject({
      lotId, sourceType: 'RECEIPT', dataSource: 'receipt', sourceId: 'receipt-13',
      purchasedAt: '2026-09-10', expiryKind: 'ESTIMATED', expiryAt: null,
    });
    expect(detail.json.lot.estimatedExpiryAt).not.toBeNull();
    expect(detail.json.lot.lotVersion).toBeGreaterThan(0);
  });

  it('AC8: summary reads through T11 authority', async () => {
    await adopt();
    seedScan({ scanId: 'receipt-14', scanType: 'receipt',
      lines: [{ id: 'line-15', rawName: 'Cà chua', quantity: 3, unit: 'piece' }] });
    await request('POST', '/scans/receipt-14/confirm', {
      items: [{ id: 'line-15', rawName: 'Cà chua', estimatedQuantity: 3, unit: 'piece' }],
    });

    const summary = await request('GET', '/inventory/summary');
    expect(summary.status).toBe(200);
    expect(summary.json.activeCount).toBe(1);
    expect(summary.json.items[0]).toMatchObject({ dataSource: 'receipt', sourceType: 'RECEIPT' });
    expect(summary.json.inventoryVersion).toBeGreaterThan(0);
  });

  it('AC8: household B cannot read household A lots, evidence or reconciliation', async () => {
    await adopt();
    await adopt(other);
    seedScan({ scanId: 'receipt-15', scanType: 'receipt',
      lines: [{ id: 'line-16', rawName: 'Cà chua', quantity: 3, unit: 'piece' }] });
    await request('POST', '/scans/receipt-15/confirm', {
      items: [{ id: 'line-16', rawName: 'Cà chua', estimatedQuantity: 3, unit: 'piece' }],
    });
    const lotId = lots()[0].id;
    const observationId = db.query<any>('SELECT id FROM inventory_observations')[0].id;

    // Foreign lot: not found, no existence leak.
    expect((await request('GET', `/inventory/lots/${lotId}`, undefined, {}, otherToken)).status).toBe(404);
    // Foreign evidence is simply not listed.
    const foreignList = await request('GET', '/inventory/observations', undefined, {}, otherToken);
    expect(foreignList.status).toBe(200);
    expect(foreignList.json.observations).toEqual([]);
    // Foreign reconciliation decision is not found.
    const foreignDecision = await request('POST', `/inventory/observations/${observationId}/decision`, {
      decisionKey: 'cross-tenant-attempt', observationId,
      expectedObservationVersion: 1, decisionType: 'DISMISS',
    }, {}, otherToken);
    expect(foreignDecision.status).toBe(404);
    // A's evidence is untouched by B's attempt.
    expect(db.query<any>('SELECT status FROM inventory_observations')).toEqual([{ status: 'OPEN' }]);
    // Foreign scan stays invisible.
    expect((await request('GET', '/scans/receipt-15', undefined, {}, otherToken)).status).toBe(404);
  });

  it('AC12: an unadopted household gets a specific authority code, not a generic error', async () => {
    const summary = await request('GET', '/inventory/summary');
    expect(summary.status).toBe(409);
    expect(summary.json.code).toBe('INVENTORY_AUTHORITY_REQUIRED');
  });
});

describe('T13 reconciliation decisions', () => {
  async function openObservation() {
    await adopt();
    seedScan({ scanId: 'fridge-4', scanType: 'fridge',
      lines: [{ id: 'line-17', rawName: 'Cà chua', quantity: 3, unit: 'piece' }] });
    await request('POST', '/scans/fridge-4/confirm', {
      items: [{ id: 'line-17', rawName: 'Cà chua', estimatedQuantity: 3, unit: 'piece' }],
    });
    return db.query<any>('SELECT id, version FROM inventory_observations')[0];
  }

  it('AC8: observations list carries the deterministic T10 verdict and proposals', async () => {
    await openObservation();
    const list = await request('GET', '/inventory/observations');
    expect(list.status).toBe(200);
    expect(list.json.observations).toHaveLength(1);
    const [observation] = list.json.observations;
    expect(observation.sourceType).toBe('SCAN');
    expect(observation.dataSource).toBe('scan');
    expect(observation.verdict).toBeTruthy();
    expect(Array.isArray(observation.proposals)).toBe(true);
  });

  it('AC8: dismissing an observation closes it without touching stock', async () => {
    const observation = await openObservation();
    const before = lots();
    const decision = await request('POST', `/inventory/observations/${observation.id}/decision`, {
      decisionKey: `dismiss:${observation.id}`, observationId: observation.id,
      expectedObservationVersion: observation.version, decisionType: 'DISMISS',
    });
    expect(decision.status).toBe(201);
    expect(db.query<any>('SELECT status FROM inventory_observations')).toEqual([{ status: 'RECONCILED' }]);
    expect(lots()).toEqual(before);
  });

  it('AC8: a realistic receipt-length observation id is still decidable', async () => {
    // Regression: real scan ids are 64-char digests, so the derived
    // observation id is far longer than a bare source ref. A 200-char bound on
    // the request body made every receipt observation permanently undecidable
    // while short synthetic fixtures kept passing.
    await adopt();
    const scanId = `receipt_${'a'.repeat(64)}`;
    const lineId = `receipt_item_${scanId}_0`;
    seedScan({ scanId, scanType: 'receipt', purchaseDate: '2026-09-10', merchant: 'WinMart',
      lines: [{ id: lineId, rawName: 'Cà chua', quantity: 3, unit: 'piece' }] });
    await request('POST', `/scans/${scanId}/confirm`, {
      items: [{ id: lineId, rawName: 'Cà chua', estimatedQuantity: 3, unit: 'piece' }],
    });
    const observation = db.query<any>('SELECT id, version FROM inventory_observations')[0];
    // The old hard-coded 200-char body bound rejected exactly this shape.
    expect(observation.id.length).toBeGreaterThan(160);
    const decision = await request('POST', `/inventory/observations/${observation.id}/decision`, {
      decisionKey: `dismiss:${observation.id}`.slice(0, 160), observationId: observation.id,
      expectedObservationVersion: observation.version, decisionType: 'DISMISS',
    });
    expect(decision.status).toBe(201);
    expect(db.query<any>('SELECT status FROM inventory_observations')).toEqual([{ status: 'RECONCILED' }]);
  });

  it('AC8: the decision bound accepts the longest identity T10 can construct', async () => {
    const worstCase = observationIdentity('h'.repeat(128), 'HEURISTIC', 's'.repeat(200));
    await adopt();
    // Unknown-but-well-formed ids must fail as NOT_FOUND, never as a length
    // validation error, or long real identities become undecidable again.
    const response = await request('POST', `/inventory/observations/${worstCase}/decision`, {
      decisionKey: 'worst-case-length', observationId: worstCase,
      expectedObservationVersion: 1, decisionType: 'DISMISS',
    });
    expect(response.status).toBe(404);
    expect(response.json.code).toBe('NOT_FOUND');
  });

  it('AC8: a dismissal replays under the same key instead of deciding twice', async () => {
    const observation = await openObservation();
    const payload = {
      decisionKey: `dismiss-replay:${observation.id}`, observationId: observation.id,
      expectedObservationVersion: observation.version, decisionType: 'DISMISS' as const,
    };
    expect((await request('POST', `/inventory/observations/${observation.id}/decision`, payload)).status).toBe(201);
    const replay = await request('POST', `/inventory/observations/${observation.id}/decision`, payload);
    expect(replay.status).toBe(200);
    expect(replay.json.idempotentReplay).toBe(true);
    expect(db.query<any>('SELECT COUNT(*) AS count FROM inventory_reconciliation_decisions')[0].count).toBe(1);
  });

  it('AC12: a stale observation version is reported as a specific conflict', async () => {
    const observation = await openObservation();
    await request('POST', `/inventory/observations/${observation.id}/decision`, {
      decisionKey: `first:${observation.id}`, observationId: observation.id,
      expectedObservationVersion: observation.version, decisionType: 'DISMISS',
    });
    const stale = await request('POST', `/inventory/observations/${observation.id}/decision`, {
      decisionKey: `second:${observation.id}`, observationId: observation.id,
      expectedObservationVersion: observation.version, decisionType: 'DISMISS',
    });
    expect(stale.status).toBe(409);
    expect(['ALREADY_DECIDED', 'CONFLICT', 'STALE_SNAPSHOT']).toContain(stale.json.code);
  });

  it('rejects a body whose observation id disagrees with the path', async () => {
    const observation = await openObservation();
    const mismatch = await request('POST', `/inventory/observations/${observation.id}/decision`, {
      decisionKey: 'mismatch', observationId: 'someone-elses-observation',
      expectedObservationVersion: 1, decisionType: 'DISMISS',
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.code).toBe('VALIDATION_ERROR');
  });
});

describe('T13 manual authority loop', () => {
  it('AC10/AC11: an UNKNOWN expiry lot is correctable through T09 and re-read as KNOWN', async () => {
    await adopt();
    // Manual add without any expiry basis: UNKNOWN, not "fresh".
    const created = await request('POST', '/inventory', {
      id: 'manual-1', name: 'Hành tây', quantity: 2, unit: 'piece', category: 'vegetable', storage: 'pantry',
    });
    expect(created.status).toBe(201);
    const lot = lots().find((entry) => entry.raw_name === 'Hành tây');
    expect(lot.expiry_kind).toBe('UNKNOWN');
    expect(lot.expiry_at).toBeNull();
    expect(lot.estimated_expiry_at).toBeNull();

    const detail = await request('GET', `/inventory/lots/${lot.id}`);
    expect(detail.json.lot.expiryKind).toBe('UNKNOWN');

    // Correct it to an explicit date through the authority.
    const patched = await request('PATCH', '/inventory/manual-1', {
      version: detail.json.lot.version, expiryDate: '2026-10-01',
    });
    expect(patched.status).toBe(200);

    const after = await request('GET', `/inventory/lots/${lot.id}`);
    expect(after.json.lot.expiryKind).toBe('KNOWN');
    expect(after.json.lot.expiryAt).toBe('2026-10-01');
  });

  it('AC3/AC11: a manual day-chip stays ESTIMATED and an explicit date is KNOWN', async () => {
    await adopt();
    // Day chip: an inferred date, recorded as an estimate.
    expect((await request('POST', '/inventory', {
      id: 'chip-1', name: 'Rau muong', quantity: 1, unit: 'bunch', category: 'vegetable',
      storage: 'fridge', expiryDate: '2026-09-18', expiryEstimated: true,
    })).status).toBe(201);
    const chipLot = lots().find((lot) => lot.raw_name === 'Rau muong');
    expect(chipLot.expiry_kind).toBe('ESTIMATED');
    expect(chipLot.estimated_expiry_at).toBe('2026-09-18');
    expect(chipLot.expiry_at).toBeNull();

    // Explicit date picker: a dated fact.
    expect((await request('POST', '/inventory', {
      id: 'exact-1', name: 'Sua tuoi', quantity: 1, unit: 'l', category: 'dairy',
      storage: 'fridge', expiryDate: '2026-09-28',
    })).status).toBe(201);
    const exactLot = lots().find((lot) => lot.raw_name === 'Sua tuoi');
    expect(exactLot.expiry_kind).toBe('KNOWN');
    expect(exactLot.expiry_at).toBe('2026-09-28');
  });

  it('AC11 / closed-loop D: correcting an ESTIMATED lot with a real date yields KNOWN', async () => {
    // Regression: the PATCH adapter carried the lot's previous ESTIMATED kind
    // forward, so a user-supplied date could never establish a fact and the
    // lot stayed an estimate forever. Found by browser verification.
    await adopt();
    expect((await request('POST', '/inventory', {
      id: 'estimate-1', name: 'Ca rot', quantity: 3, unit: 'piece', category: 'vegetable',
      storage: 'fridge', expiryDate: '2026-09-18', expiryEstimated: true,
    })).status).toBe(201);
    const before = lots().find((lot) => lot.raw_name === 'Ca rot');
    expect(before.expiry_kind).toBe('ESTIMATED');

    const detail = await request('GET', `/inventory/lots/${before.id}`);
    const corrected = await request('PATCH', '/inventory/estimate-1', {
      version: detail.json.lot.version, expiryDate: '2026-10-05', expiryEstimated: false,
    });
    expect(corrected.status).toBe(200);

    const after = await request('GET', `/inventory/lots/${before.id}`);
    expect(after.json.lot.expiryKind).toBe('KNOWN');
    expect(after.json.lot.expiryAt).toBe('2026-10-05');
    expect(after.json.lot.estimatedExpiryAt).toBeNull();
  });

  it('AC10/AC11: a stale version is reported as CONFLICT rather than overwriting', async () => {
    await adopt();
    await request('POST', '/inventory', {
      id: 'manual-2', name: 'Khoai tây', quantity: 2, unit: 'piece', category: 'vegetable', storage: 'pantry',
    });
    const conflict = await request('PATCH', '/inventory/manual-2', { version: 99, quantity: 5 });
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe('CONFLICT');
  });

  it('AC10: a storage MOVE lands through the authority and the read refreshes', async () => {
    await adopt();
    await request('POST', '/inventory', {
      id: 'manual-3', name: 'Cà rốt', quantity: 2, unit: 'piece', category: 'vegetable', storage: 'fridge',
    });
    const lot = lots().find((entry) => entry.raw_name === 'Cà rốt');
    const before = await request('GET', `/inventory/lots/${lot.id}`);
    expect(before.json.lot.storage).toBe('fridge');

    const moved = await request('PATCH', '/inventory/manual-3', {
      version: before.json.lot.version, storage: 'pantry',
    });
    expect(moved.status).toBe(200);

    const after = await request('GET', `/inventory/lots/${lot.id}`);
    expect(after.json.lot.storage).toBe('pantry');
    expect(after.json.lot.lotVersion).toBeGreaterThan(before.json.lot.lotVersion);
  });
});

describe('T13 adoption path', () => {
  it('AC13: the documented adoption path activates authority and is tenant-scoped', async () => {
    await backfillLegacyInventory(db, scope.householdId);
    // Before adoption the truth routes report the specific recoverable code.
    expect((await request('GET', '/inventory/summary')).json.code).toBe('INVENTORY_AUTHORITY_REQUIRED');

    const adoption = await request('POST', '/inventory/adopt', {});
    expect(adoption.status).toBe(201);
    expect(adoption.json.adoption.householdId).toBe(scope.householdId);

    // After adoption the same route reads through T11 authority.
    const summary = await request('GET', '/inventory/summary');
    expect(summary.status).toBe(200);
    expect(summary.json.activeCount).toBe(0);
    expect(summary.json.items).toEqual([]);

    // Adoption never crosses households.
    expect(db.query<any>("SELECT COUNT(*) AS count FROM inventory_lots WHERE household_id = 't13-other'")[0].count).toBe(0);
  });
});
