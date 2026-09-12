import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import { executeInventoryLotCommand } from '../../packages/db/src/inventory-lot-commands';
import { readInventoryAuthority, readInventoryLot,
  readInventorySummary, assertProjectionParity } from '../../packages/db/src/inventory-read-authority';
import { recordInventoryObservation } from '../../packages/db/src/inventory-observations';
import { confirmReconciliationDecision, planInventoryReconciliationForHousehold } from '../../packages/db/src/inventory-reconciliation';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import { fetchHouseholdInventoryFromDb } from '../../src/worker/routes/inventory';
import type { InventoryObservationInput } from '../../packages/domain/src/inventory-observations';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { inventoryRoutes } from '../../src/worker/routes/inventory';
import type { AuthContext, Env } from '../../src/worker/types';
import { signJwt } from '../../src/worker/utils/jwt';
import { SqliteD1 } from '../helpers/sqlite-d1';

// T11: the canonical inventory read authority. Product reads derive from
// inventory_lots plus validated authority metadata; the compatibility
// projection (inventory_items) is checked for parity, never trusted, and
// never a fallback. Reads are coherent single-batch snapshots.
const scope = { householdId: 'read-household', actorId: 'read-user' };
const foreign = { householdId: 'read-foreign', actorId: 'read-foreign-user' };
const now = '2026-09-12T10:00:00Z';
let db: SqliteD1;
afterEach(() => db.close());

const FRIDGE = () => db.query<{ id: string }>('SELECT id FROM storage_locations WHERE household_id = ? AND type = ?', scope.householdId, 'FRIDGE')[0].id;

async function adoptHousehold(withLegacyRow = true) {
  if (withLegacyRow) {
    db.seed(`INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit, category, storage,
      expiry_date, expiry_kind, expiry_source, created_at, updated_at, added_date, data_source)
      VALUES ('rice-row', '${scope.householdId}', 'RICE', 'Rice', 2, 'kg', 'grain', 'pantry',
      NULL, 'unknown', 'unknown', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', 'manual')`);
    await backfillLegacyInventory(db, scope.householdId);
  }
  await executeInventoryAdoption(db, scope, {}, now);
}
async function createLot(lotId: string, spec: Partial<Record<string, unknown>> = {}, household = scope) {
  await executeInventoryLotCommand(db, household, `create-${lotId}`, {
    type: 'CREATE', lotId, ingredientId: 'CHICKEN_EGG', rawName: 'Eggs', quantity: 10, unit: 'piece',
    storageLocationId: household === scope ? FRIDGE() : FRIDGE(), sourceType: 'MANUAL', ...spec,
  }, now);
}
beforeEach(async () => {
  db = new SqliteD1();
  db.seed(`INSERT INTO users(id) VALUES ('read-user'), ('read-foreign-user');
    INSERT INTO households(id, name, created_by, created_at, updated_at) VALUES
      ('read-household', 'Read', 'read-user', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      ('read-foreign', 'Foreign', 'read-foreign-user', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
    INSERT INTO household_members(id, household_id, user_id, role) VALUES
      ('read-member', 'read-household', 'read-user', 'owner'),
      ('read-foreign-member', 'read-foreign', 'read-foreign-user', 'owner');`);
});

describe('T11 read authority — canonical model', () => {
  it('reads adopted inventory from lots only: native and backfilled mapping evidence, deterministic order', async () => {
    await adoptHousehold();
    await createLot('native-eggs');
    const { inventoryVersion, items } = await readInventoryAuthority(db, scope);
    expect(inventoryVersion).toBeGreaterThanOrEqual(1);
    expect(items.map((item) => [item.lotId, item.legacyItemId])).toEqual([
      ['native-eggs', 'native-eggs'],
      ['t08-legacy:rice-row', 'rice-row'],
    ]);
    const eggs = items[0], rice = items[1];
    expect(rice).toMatchObject({ quantity: 2000, unit: 'g', quantityMilli: 2_000_000, canonicalUnit: 'g',
      storage: 'pantry', state: 'ACTIVE', expiryKind: 'UNKNOWN', sourceType: 'LEGACY_BACKFILL',
      ingredientId: 'RICE', name: 'Rice', category: 'grain' });
    expect(eggs).toMatchObject({ quantity: 10, unit: 'piece', quantityMilli: 10_000, canonicalUnit: 'piece',
      storage: 'fridge', state: 'ACTIVE', sourceType: 'MANUAL', ingredientId: 'CHICKEN_EGG' });
    // UNKNOWN != ZERO: unknown expiry stays null, never fabricated.
    expect(rice.expiryAt).toBeNull();
    expect(rice.estimatedExpiryAt).toBeNull();
  });

  it('preserves unit semantics exactly: kg, g, l, ml, piece with canonical authority units', async () => {
    await adoptHousehold(false);
    await createLot('u-kg', { quantity: 1, unit: 'kg', rawName: 'Flour' });
    await createLot('u-g', { quantity: 250, unit: 'g', rawName: 'Sugar' });
    await createLot('u-l', { quantity: 1.5, unit: 'l', rawName: 'Milk' });
    await createLot('u-ml', { quantity: 500, unit: 'ml', rawName: 'Cream' });
    const { items } = await readInventoryAuthority(db, scope);
    expect(Object.fromEntries(items.map((item) => [item.lotId, [item.quantity, item.unit, item.quantityMilli, item.canonicalUnit]])))
      .toEqual({ 'u-kg': [1000, 'g', 1_000_000, 'g'], 'u-g': [250, 'g', 250_000, 'g'],
        'u-l': [1500, 'ml', 1_500_000, 'ml'], 'u-ml': [500, 'ml', 500_000, 'ml'] });
  });

  it('excludes terminal lots from current inventory, includes them in explicit historical views', async () => {
    await adoptHousehold(false);
    await createLot('eggs');
    await executeInventoryLotCommand(db, scope, 'use-1', {
      type: 'USE', lotId: 'eggs', expectedVersion: 1, quantity: 4, unit: 'piece', reason: 'Cooked breakfast' }, now);
    expect((await readInventoryAuthority(db, scope)).items[0]).toMatchObject({ quantity: 6, version: 2 });
    await executeInventoryLotCommand(db, scope, 'use-2', {
      type: 'USE', lotId: 'eggs', expectedVersion: 2, quantity: 6, unit: 'piece', reason: 'Finished' }, now);
    const current = await readInventoryAuthority(db, scope);
    expect(current.items).toEqual([]); // fully consumed lot is terminal
    const history = await readInventoryAuthority(db, scope, { includeTerminal: true });
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ lotId: 'eggs', state: 'CONSUMED', quantity: 0, quantityMilli: 0 });
  });

  it('resolves single lots by authoritative lotId or retained legacy mapping, never cross-tenant', async () => {
    await adoptHousehold();
    await createLot('native-eggs');
    const byLot = await readInventoryLot(db, scope, { lotId: 'native-eggs' });
    const byLegacy = await readInventoryLot(db, scope, { legacyItemId: 'rice-row' });
    expect(byLot.quantity).toBe(10);
    expect(byLegacy.quantity).toBe(2000);
    // Foreign household references are not-found; no existence leak.
    await expect(readInventoryLot(db, foreign, { lotId: 'native-eggs' }))
      .rejects.toMatchObject({ name: 'InventoryReadAuthorityError', code: 'LOT_NOT_FOUND' });
    await expect(readInventoryLot(db, foreign, { legacyItemId: 'rice-row' }))
      .rejects.toMatchObject({ code: 'LOT_NOT_FOUND' });
  });

  it('is household-scoped: a foreign member never sees the other household stock', async () => {
    await adoptHousehold();
    await createLot('native-eggs');
    await adoptHouseholdForeign();
    const foreignRead = await readInventorySummary(db, foreign);
    // Isolation, not emptiness: B sees only B stock (its own legacy row).
    expect(foreignRead.items.map((item) => item.legacyItemId)).toEqual(['foreign-row']);
    const summary = await readInventorySummary(db, scope, { ingredientIds: ['CHICKEN_EGG'] });
    expect(summary.items.map((item) => item.lotId)).toEqual(['native-eggs']);
    async function adoptHouseholdForeign() {
      db.seed(`INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit, category, storage,
        expiry_date, expiry_kind, expiry_source, created_at, updated_at, added_date, data_source)
        VALUES ('foreign-row', 'read-foreign', 'RICE', 'Foreign rice', 1, 'kg', 'grain', 'pantry',
        NULL, 'unknown', 'unknown', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', 'manual')`);
      await backfillLegacyInventory(db, foreign.householdId);
      await executeInventoryAdoption(db, foreign, {}, now);
    }
  });

  it('bounds results and rejects invalid limits instead of unbounded reads', async () => {
    await adoptHousehold(false);
    await createLot('eggs-1', { rawName: 'A' });
    await createLot('eggs-2', { rawName: 'B' });
    await expect(readInventoryAuthority(db, scope, { limit: 1 }))
      .rejects.toMatchObject({ code: 'READ_LIMIT_EXCEEDED' });
    await expect(readInventoryAuthority(db, scope, { limit: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_READ_QUERY' });
    await expect(readInventoryLot(db, scope, {}))
      .rejects.toMatchObject({ code: 'INVALID_READ_QUERY' });
    const bounded = await readInventoryAuthority(db, scope, { limit: 2 });
    expect(bounded.items).toHaveLength(2);
  });
});

describe('T11 read authority — truth boundaries', () => {
  it('unconfirmed observations never override authority (§29): lot says 10, observation claims 4, read returns 10', async () => {
    await adoptHousehold(false);
    await createLot('eggs');
    const { observation } = await recordInventoryObservation(db, scope, {
      sourceType: 'MANUAL', sourceRef: 'claim-4', observedAt: now, ingredientId: null, rawName: null,
      lotId: 'eggs', legacyItemId: null, evidence: 'OBSERVED', note: null,
      claim: { quantity: 4, unit: 'piece', quantityMilli: 4_000, canonicalUnit: 'piece',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    } as InventoryObservationInput, now);
    expect(observation.status).toBe('OPEN');
    const { items } = await readInventoryAuthority(db, scope);
    expect(items[0]).toMatchObject({ quantity: 10, quantityMilli: 10_000 });
    // After the T10 reconciliation commits through authority, the read follows.
    const [finding] = await planInventoryReconciliationForHousehold(db, scope.householdId, [observation]);
    await confirmReconciliationDecision(db, scope, { decisionKey: 'd-1', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'CORRECT', proposals: finding.proposals }, now);
    expect((await readInventoryAuthority(db, scope)).items[0]).toMatchObject({ quantity: 4, quantityMilli: 4_000, version: 2 });
  });

  it('projection tampering cannot leak into reads (§31): lot 8, projection 100, read returns 8 plus parity drift', async () => {
    await adoptHousehold();
    await createLot('eggs', { quantity: 8 });
    db.seed("UPDATE inventory_items SET quantity = 100 WHERE id = 'eggs'");
    const { items } = await readInventoryAuthority(db, scope);
    expect(items[0].quantity).toBe(8);
    const parity = await assertProjectionParity(db, scope);
    expect(parity).toEqual([{ code: 'QUANTITY_DRIFT', lotId: 'eggs', legacyItemId: 'eggs',
      detail: 'Projection 100piece vs lot 8000milli/piece' }]);
    // Coherent state has no diagnostics.
    db.seed("UPDATE inventory_items SET quantity = 8 WHERE id = 'eggs'");
    expect(await assertProjectionParity(db, scope)).toEqual([]);
  });

  it('fails closed on broken or unprovable mapping evidence — never falls back to the projection (§10, §27)', async () => {
    await adoptHousehold();
    await createLot('eggs');
    // The DB trigger normally fences live mapping edits; drop it to prove the
    // read layer fails closed independently of write-side fencing. Forging a
    // mapping breaks the lot<->projection correspondence, so the adoption gate
    // itself rejects the household before any content is derived.
    db.seed('DROP TRIGGER trg_inventory_lots_live_update');
    db.seed(`INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit, category, storage,
      expiry_date, expiry_kind, expiry_source, created_at, updated_at, added_date, data_source)
      VALUES ('forged-row', 'read-foreign', 'RICE', 'Forged', 1, 'kg', 'grain', 'pantry',
      NULL, 'unknown', 'unknown', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', 'manual')`);
    db.seed("UPDATE inventory_lots SET legacy_item_id = 'forged-row' WHERE id = 'eggs'");
    await expect(readInventoryAuthority(db, scope))
      .rejects.toMatchObject({ code: 'ADOPTION_REQUIRED' });
    // Duplicate authoritative mapping is equally impossible to serve.
    db.seed("UPDATE inventory_lots SET legacy_item_id = 'eggs' WHERE id = 't08-legacy:rice-row'");
    await expect(readInventorySummary(db, scope))
      .rejects.toMatchObject({ code: 'ADOPTION_REQUIRED' });
  });

  it('fails closed when adoption mapping evidence is tampered: CORRUPT_RECEIPT, no projection fallback', async () => {
    await adoptHousehold();
    await createLot('eggs');
    db.seed('DROP TRIGGER trg_inventory_adoption_receipts_immutable_update');
    db.seed("UPDATE inventory_adoption_receipts SET actor_id = 'read-foreign-user'");
    await expect(readInventoryAuthority(db, scope))
      .rejects.toMatchObject({ name: 'LotCommandError', code: 'CORRUPT_RECEIPT' });
    await expect(readInventorySummary(db, scope))
      .rejects.toMatchObject({ code: 'CORRUPT_RECEIPT' });
    await expect(readInventoryLot(db, scope, { lotId: 'eggs' }))
      .rejects.toMatchObject({ code: 'CORRUPT_RECEIPT' });
  });

  it('fails closed on corrupt lot rows: ACTIVE stock at zero (§27)', async () => {
    await adoptHousehold(false);
    await createLot('eggs');
    db.seed('DROP TRIGGER trg_inventory_lots_live_update');
    db.seed("UPDATE inventory_lots SET quantity_milli = 0 WHERE id = 'eggs'");
    await expect(readInventoryAuthority(db, scope))
      .rejects.toMatchObject({ code: 'CORRUPT_LOT_ROW' });
  });

  it('requires adoption before authority reads (§11): non-adopted households get ADOPTION_REQUIRED', async () => {
    db.seed(`INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit, category, storage,
      expiry_date, expiry_kind, expiry_source, created_at, updated_at, added_date, data_source)
      VALUES ('legacy-only', '${scope.householdId}', 'RICE', 'Rice', 2, 'kg', 'grain', 'pantry',
      NULL, 'unknown', 'unknown', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', 'manual')`);
    await expect(readInventoryAuthority(db, scope))
      .rejects.toMatchObject({ name: 'LotCommandError', code: 'ADOPTION_REQUIRED' });
  });
});

describe('T11 read/write coherence', () => {
  it('READ vs CORRECT: a paused writer commits after a coherent before-snapshot, never a hybrid (§28)', async () => {
    await adoptHousehold(false);
    await createLot('eggs');
    const before = await readInventoryAuthority(db, scope);
    expect(before.items[0]).toMatchObject({ quantity: 10, version: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let armed = true;
    db.hooks.beforeBatch = async () => {
      if (!armed) return;
      armed = false;
      db.hooks = {};
      const during = await readInventoryAuthority(db, scope);
      // The concurrent CORRECT has committed nothing yet: the read is the
      // complete before-state (single D1 batch = coherent snapshot).
      expect(during.items[0]).toMatchObject({ quantity: 10, version: 1 });
      release();
    };
    const command = executeInventoryLotCommand(db, scope, 'correct-1', {
      type: 'CORRECT', lotId: 'eggs', expectedVersion: 1, changes: { quantity: 7 }, reason: 'Counted' }, now);
    await gate;
    await command;
    const after = await readInventoryAuthority(db, scope);
    expect(after.items[0]).toMatchObject({ quantity: 7, version: 2 });
    expect(after.inventoryVersion).toBeGreaterThan(before.inventoryVersion);
  });

  it('READ vs USE and READ vs T10 reconciliation: authority moves only through commits', async () => {
    await adoptHousehold(false);
    await createLot('eggs');
    await executeInventoryLotCommand(db, scope, 'use-1', {
      type: 'USE', lotId: 'eggs', expectedVersion: 1, quantity: 3, unit: 'piece', reason: 'Cooked' }, now);
    expect((await readInventoryAuthority(db, scope)).items[0]).toMatchObject({ quantity: 7, version: 2 });
    const { observation } = await recordInventoryObservation(db, scope, {
      sourceType: 'MANUAL', sourceRef: 'dismiss-me', observedAt: now, ingredientId: null, rawName: null,
      lotId: 'eggs', legacyItemId: null, evidence: 'OBSERVED', note: null,
      claim: { quantity: 99, unit: 'piece', quantityMilli: 99_000, canonicalUnit: 'piece',
        storage: null, expiryDate: null, expiryKind: null, openedAt: null },
    } as InventoryObservationInput, now);
    await confirmReconciliationDecision(db, scope, { decisionKey: 'dismiss-1', observationId: observation.observationId,
      expectedObservationVersion: 1, decisionType: 'DISMISS' }, now);
    // A dismissed (wrong) observation leaves authority stock untouched.
    expect((await readInventoryAuthority(db, scope)).items[0]).toMatchObject({ quantity: 7, version: 2 });
  });
});

describe('T11 HTTP read cutover', () => {
  const secret = 'test-only-inventory-read-authority-secret';
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  app.use('*', authMiddleware);
  app.route('/', inventoryRoutes);
  let token: string;
  beforeEach(async () => {
    token = await signJwt({ sub: scope.actorId, hid: scope.householdId, typ: 'access',
      exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
  });
  const get = async () => {
    const response = await app.fetch(new Request('https://read.example/inventory', {
      headers: { Authorization: `Bearer ${token}` } }),
      { DB: db, ENVIRONMENT: 'test', JWT_SECRET: secret, WEEK_SCHEMA_MODE: 'legacy',
        CACHE: { put: async () => {}, get: async () => null } });
    return { status: response.status, json: await response.json() as { items?: Record<string, unknown>[] } };
  };

  it('GET /inventory for an adopted household serves authority content and ignores a tampered projection (§31)', async () => {
    await adoptHousehold();
    await createLot('eggs', { quantity: 8 });
    db.seed("UPDATE inventory_items SET quantity = 100 WHERE id = 'eggs'");
    const { status, json } = await get();
    expect(status).toBe(200);
    const eggs = json.items!.find((item) => item.lotId === 'eggs')!;
    expect(eggs).toMatchObject({ id: 'eggs', quantity: 8, unit: 'piece', lotVersion: 1,
      inventoryVersion: expect.any(Number) });
    // External identity compatibility: legacy rows keep their legacy id.
    expect(json.items!.map((item) => item.id).sort()).toEqual(['eggs', 'rice-row']);
    expect((json.items as Array<Record<string, unknown>>).every((item) => item.version !== undefined)).toBe(true);
  });

  it('GET /inventory for a not-yet-adopted household keeps the legacy compatibility response', async () => {
    db.seed(`INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit, category, storage,
      expiry_date, expiry_kind, expiry_source, created_at, updated_at, added_date, data_source)
      VALUES ('legacy-only', '${scope.householdId}', 'RICE', 'Rice', 2, 'kg', 'grain', 'pantry',
      NULL, 'unknown', 'unknown', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', 'manual')`);
    const { status, json } = await get();
    expect(status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.items![0]).toMatchObject({ id: 'legacy-only', quantity: 2, unit: 'kg', freshness: expect.any(String) });
    expect(json.items![0].lotId).toBeUndefined();
  });

  it('funnel: adopted households bypass the KV cache; authority read failures fail closed', async () => {
    await adoptHousehold();
    await createLot('eggs');
    const writes: string[] = [];
    const kv = { put: async (key: string) => { writes.push(key); }, get: async () => [{ id: 'stale' }] };
    const items = await fetchHouseholdInventoryFromDb(db, scope.householdId, kv, { actorId: scope.actorId });
    expect(items.map((item) => (item as { id: string }).id)).toEqual(['eggs', 'rice-row']);
    expect(writes).toEqual([]); // no 1h-stale authority caching
    db.seed('DROP TRIGGER trg_inventory_adoption_receipts_immutable_update');
    db.seed("UPDATE inventory_adoption_receipts SET actor_id = 'read-foreign-user'");
    await expect(fetchHouseholdInventoryFromDb(db, scope.householdId, kv, { actorId: scope.actorId, strict: true }))
      .rejects.toMatchObject({ name: 'InventoryReadError' });
  });
});
