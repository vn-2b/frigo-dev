import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeInventoryAdoption } from '../../packages/db/src/inventory-adoption-executor';
import { executeInventoryLotCommand } from '../../packages/db/src/inventory-lot-commands';
import { readInventoryAuthority, readInventoryLot,
  readInventorySummary, assertProjectionParity } from '../../packages/db/src/inventory-read-authority';
import { executeInventoryFefoCommand } from '../../packages/db/src/inventory-lot-commands';
import { readInventoryAuthorityMode } from '../../packages/db/src/inventory-writer-fence';
import { computeReadFreshness, displayQuantity } from '../../packages/domain/src/inventory-read-authority';
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
    // Retained legacy display alias (kg) presents exactly; authority stays g.
    expect(rice).toMatchObject({ quantity: 2, unit: 'kg', quantityMilli: 2_000_000, canonicalUnit: 'g',
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
    expect(byLegacy).toMatchObject({ quantity: 2, unit: 'kg', quantityMilli: 2_000_000, canonicalUnit: 'g' });
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

  it('GET /inventory for an adopted-but-empty household returns 200 with items: [] — never the legacy rows or KV', async () => {
    await adoptHousehold(false);
    const staleKv = { put: async () => {}, get: async () => [{ id: 'stale-kv-row' }] };
    const response = await app.fetch(new Request('https://read.example/inventory', {
      headers: { Authorization: `Bearer ${token}` } }),
      { DB: db, ENVIRONMENT: 'test', JWT_SECRET: secret, WEEK_SCHEMA_MODE: 'legacy', CACHE: staleKv });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(db.query('SELECT id FROM inventory_adoption_receipts')).toHaveLength(1); // no auto-adoption
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

describe('T11 hardening — adopted-but-empty household (dual-truth invariant)', () => {
  const staleKv = { put: async () => {}, get: async () => [{ id: 'stale-kv-row', quantity: 99 }] };

  it('reads [] from authority with a valid receipt and zero lots; never legacy rows, never KV, never auto-adoption', async () => {
    await adoptHousehold(false);
    // Stale legacy projection rows exist but are not part of the adopted truth.
    db.seed(`INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit, category, storage,
      expiry_date, expiry_kind, expiry_source, created_at, updated_at, added_date, data_source)
      VALUES ('stale-legacy', '${scope.householdId}', 'RICE', 'Stale', 5, 'kg', 'grain', 'pantry',
      NULL, 'unknown', 'unknown', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', 'manual')`);
    expect(await readInventoryAuthorityMode(db, scope.householdId)).toBe('native');
    // Stale rows without lots break admission for the legacy row set: the
    // adopted-empty contract applies to a projection that is also empty.
    await expect(readInventoryAuthority(db, scope)).rejects.toMatchObject({ code: 'ADOPTION_REQUIRED' });
    db.seed("DELETE FROM inventory_items WHERE id = 'stale-legacy'");
    const receiptsBefore = db.query('SELECT id FROM inventory_adoption_receipts').length;
    const authority = await readInventoryAuthority(db, scope);
    expect(authority.items).toEqual([]);
    const funnel = await fetchHouseholdInventoryFromDb(db, scope.householdId, staleKv, { actorId: scope.actorId, strict: true });
    expect(funnel).toEqual([]);
    expect(db.query('SELECT id FROM inventory_adoption_receipts').length).toBe(receiptsBefore); // no auto-adoption
    expect(db.query('SELECT id FROM inventory_lots')).toEqual([]);
  });

  it('adopted household whose only lot became terminal reads [] for current stock, not the legacy projection', async () => {
    await adoptHousehold();
    const version = db.query<{ version: number }>("SELECT version FROM inventory_lots WHERE id = 't08-legacy:rice-row'")[0].version;
    await executeInventoryLotCommand(db, scope, 'discard-all', {
      type: 'DISCARD', lotId: 't08-legacy:rice-row', expectedVersion: version, quantity: 2, unit: 'kg', reason: 'Spoiled' }, now);
    const authority = await readInventoryAuthority(db, scope);
    expect(authority.items).toEqual([]);
    const funnel = await fetchHouseholdInventoryFromDb(db, scope.householdId, staleKv, { actorId: scope.actorId, strict: true });
    expect(funnel).toEqual([]);
    const history = await readInventoryAuthority(db, scope, { includeTerminal: true });
    expect(history.items[0]).toMatchObject({ state: 'DISCARDED', quantity: 0, quantityMilli: 0 });
  });
});

describe('T11 hardening — READ vs MOVE / DISCARD / FEFO coherence', () => {
  function pauseBeforeFirstBatch(run: () => Promise<void>) {
    let armed = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    db.hooks.beforeBatch = async (statements) => {
      if (!armed || !statements.some(({ sql }) => sql.startsWith('INSERT INTO inventory_commands'))) return;
      armed = false;
      db.hooks = {};
      await run();
      release();
    };
    return gate;
  }

  it('READ vs MOVE: before snapshot has the original location/version, after has the new one, never mixed', async () => {
    await adoptHousehold(false);
    await createLot('eggs');
    const fridge = FRIDGE();
    const freezer = db.query<{ id: string }>('SELECT id FROM storage_locations WHERE household_id = ? AND type = ?', scope.householdId, 'FREEZER')[0].id;
    let during: Awaited<ReturnType<typeof readInventoryAuthority>> | undefined;
    const gate = pauseBeforeFirstBatch(async () => { during = await readInventoryAuthority(db, scope); });
    const command = executeInventoryLotCommand(db, scope, 'move-1', {
      type: 'MOVE', lotId: 'eggs', expectedVersion: 1, storageLocationId: freezer }, now);
    await gate;
    await command;
    expect(during!.items[0]).toMatchObject({ storageLocationId: fridge, storage: 'fridge', version: 1 });
    const after = await readInventoryAuthority(db, scope);
    expect(after.items[0]).toMatchObject({ storageLocationId: freezer, storage: 'freezer', version: 2, quantity: 10 });
    // Every observed snapshot is one of the two legal states.
    for (const snapshot of [during!, after]) {
      const item = snapshot.items[0];
      expect([[fridge, 1], [freezer, 2]]).toContainEqual([item.storageLocationId, item.version]);
    }
  });

  it('READ vs DISCARD: before snapshot sees ACTIVE quantity, after excludes the terminal lot; history shows DISCARDED/0', async () => {
    await adoptHousehold(false);
    await createLot('eggs');
    let during: Awaited<ReturnType<typeof readInventoryAuthority>> | undefined;
    const gate = pauseBeforeFirstBatch(async () => { during = await readInventoryAuthority(db, scope); });
    const command = executeInventoryLotCommand(db, scope, 'discard-1', {
      type: 'DISCARD', lotId: 'eggs', expectedVersion: 1, quantity: 10, unit: 'piece', reason: 'Spoiled' }, now);
    await gate;
    await command;
    expect(during!.items[0]).toMatchObject({ state: 'ACTIVE', quantity: 10, version: 1 });
    expect((await readInventoryAuthority(db, scope)).items).toEqual([]);
    const history = await readInventoryAuthority(db, scope, { includeTerminal: true });
    expect(history.items[0]).toMatchObject({ state: 'DISCARDED', quantity: 0, quantityMilli: 0, version: 2 });
  });

  it('READ vs FEFO: multi-lot consumption is coherent before OR after — never a partially consumed cross-lot hybrid', async () => {
    await adoptHousehold(false);
    await createLot('eggs-early', { expiryAt: '2026-09-14', expiryKind: 'KNOWN' });
    await createLot('eggs-late', { expiryAt: '2026-09-30', expiryKind: 'KNOWN' });
    let during: Awaited<ReturnType<typeof readInventoryAuthority>> | undefined;
    const gate = pauseBeforeFirstBatch(async () => { during = await readInventoryAuthority(db, scope); });
    const command = executeInventoryFefoCommand(db, scope, 'fefo-1', {
      type: 'USE', mode: 'FEFO', ingredientId: 'CHICKEN_EGG', quantity: 14, unit: 'piece', reason: 'Baking' }, now);
    await gate;
    await command;
    const byLot = (snapshot: Awaited<ReturnType<typeof readInventoryAuthority>>) =>
      Object.fromEntries(snapshot.items.map((item) => [item.lotId, [item.quantity, item.version, item.state]]));
    // Before: both lots untouched. After: the earliest-expiring lot fully
    // consumed (terminal, excluded from current view), the later lot at 6.
    expect(byLot(during!)).toEqual({ 'eggs-early': [10, 1, 'ACTIVE'], 'eggs-late': [10, 1, 'ACTIVE'] });
    const after = await readInventoryAuthority(db, scope, { includeTerminal: true });
    expect(byLot(after)).toEqual({ 'eggs-early': [0, 2, 'CONSUMED'], 'eggs-late': [6, 2, 'ACTIVE'] });
    // The single-batch read can never observe {early consumed, late untouched}
    // or {early untouched, late reduced}: both lots move in one D1 transaction.
    expect(during!.inventoryVersion).toBeLessThan(after.inventoryVersion);
  });
});

describe('T11 hardening — summary, display units, freshness', () => {
  it('readInventorySummary activeCount reflects the returned (filtered) summary', async () => {
    await adoptHousehold(false);
    await createLot('eggs-1', { rawName: 'Eggs A' });
    await createLot('eggs-2', { rawName: 'Eggs B' });
    await createLot('rice-1', { ingredientId: 'RICE', rawName: 'Rice', quantity: 1, unit: 'kg' });
    const all = await readInventorySummary(db, scope);
    expect(all.activeCount).toBe(3);
    expect(all.items).toHaveLength(3);
    const rice = await readInventorySummary(db, scope, { ingredientIds: ['RICE'] });
    expect(rice.activeCount).toBe(1);
    expect(rice.items.map((item) => item.lotId)).toEqual(['rice-1']);
    const none = await readInventorySummary(db, scope, { ingredientIds: ['TOMATO'] });
    expect(none).toMatchObject({ activeCount: 0, items: [] });
  });

  it('kg and l retained legacy display aliases present exactly; authority stays canonical; projection corruption cannot alter either', async () => {
    db.seed(`INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit, category, storage,
      expiry_date, expiry_kind, expiry_source, created_at, updated_at, added_date, data_source) VALUES
      ('rice-kg', '${scope.householdId}', 'RICE', 'Rice', 2, 'kg', 'grain', 'pantry', NULL, 'unknown', 'unknown',
        '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', 'manual'),
      ('milk-l', '${scope.householdId}', 'FRESH_MILK', 'Milk', 1.5, 'l', 'dairy', 'fridge', NULL, 'unknown', 'unknown',
        '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', 'manual')`);
    await backfillLegacyInventory(db, scope.householdId);
    await executeInventoryAdoption(db, scope, {}, now);
    await createLot('sugar-native', { ingredientId: 'RICE', rawName: 'Sugar', quantity: 500, unit: 'g' });
    const { items } = await readInventoryAuthority(db, scope);
    const view = Object.fromEntries(items.map((item) => [item.legacyItemId, [item.quantity, item.unit, item.quantityMilli, item.canonicalUnit]]));
    expect(view).toEqual({
      'rice-kg': [2, 'kg', 2_000_000, 'g'],
      'milk-l': [1.5, 'l', 1_500_000, 'ml'],
      'sugar-native': [500, 'g', 500_000, 'g'], // native lots without an alias present canonically
    });
    // Projection says 999 kg: the row no longer agrees with authority, so the
    // kg alias is dropped and presentation falls back to canonical. Authority
    // and value are untouched either way.
    db.seed("UPDATE inventory_items SET quantity = 999 WHERE id = 'rice-kg'");
    const tampered = (await readInventoryAuthority(db, scope)).items.find((item) => item.legacyItemId === 'rice-kg')!;
    expect(tampered).toMatchObject({ quantity: 2000, unit: 'g', quantityMilli: 2_000_000, canonicalUnit: 'g' });
    // A malformed retained unit falls back to canonical presentation, never truth loss.
    db.seed("UPDATE inventory_items SET quantity = 2, unit = 'bag' WHERE id = 'rice-kg'");
    const malformed = (await readInventoryAuthority(db, scope)).items.find((item) => item.legacyItemId === 'rice-kg')!;
    expect(malformed).toMatchObject({ quantity: 2000, unit: 'g', quantityMilli: 2_000_000 });
  });

  it('displayQuantity never crosses semantic families and only presents provable aliases', () => {
    expect(displayQuantity(2_000_000, 'g', 'kg')).toEqual({ quantity: 2, unit: 'kg' });
    expect(displayQuantity(1_500_000, 'ml', 'l')).toEqual({ quantity: 1.5, unit: 'l' });
    expect(displayQuantity(500_000, 'g', null)).toEqual({ quantity: 500, unit: 'g' });
    expect(displayQuantity(500_000, 'g', 'g')).toEqual({ quantity: 500, unit: 'g' });
    expect(displayQuantity(3_000, 'pack', 'g')).toEqual({ quantity: 3, unit: 'pack' });
    expect(displayQuantity(3_000, 'piece', 'bunch')).toEqual({ quantity: 3, unit: 'piece' });
    expect(displayQuantity(2_000_000, 'g', 'l')).toEqual({ quantity: 2000, unit: 'g' }); // wrong family alias
    expect(displayQuantity(1, 'g', 'kg')).toEqual({ quantity: 0.000001, unit: 'kg' }); // 1 milligram round-trips exactly (1e-6 kg)
    expect(displayQuantity(2_000_000, 'g', 'bag')).toEqual({ quantity: 2000, unit: 'g' }); // unknown alias -> canonical
  });

  it('computeReadFreshness is deterministic and fails closed on invalid authoritative expiry', () => {
    const clock = Date.parse('2026-09-12T10:00:00Z');
    expect(computeReadFreshness('2026-09-12', 'ACTIVE', clock)).toBe('expiring'); // known expiry today
    expect(computeReadFreshness('2026-09-14', 'ACTIVE', clock)).toBe('use_soon'); // 62h
    expect(computeReadFreshness('2026-09-30', 'ACTIVE', clock)).toBe('fresh');
    expect(computeReadFreshness(null, 'ACTIVE', clock)).toBe('fresh'); // UNKNOWN expiry is not a fresh claim about a date, but it is not expiring either
    expect(computeReadFreshness('2026-09-30', 'CONSUMED', clock)).toBe('out_of_stock');
    expect(computeReadFreshness('2026-09-30', 'DISCARDED', clock)).toBe('out_of_stock');
    for (const invalid of ['not-a-date', '2026-13-01', '2026-02-30', '2026-9-1', '', '2026-09-12T00:00:00Z']) {
      expect(() => computeReadFreshness(invalid, 'ACTIVE', clock)).toThrow(/Invalid authoritative expiry date/);
    }
    expect(() => computeReadFreshness('2026-09-30', 'ACTIVE', Number.NaN)).toThrow(/Invalid clock/);
  });

  it('a lot with an impossible authoritative expiry fails the read closed (CORRUPT_LOT_ROW), never "fresh"', async () => {
    await adoptHousehold(false);
    await createLot('eggs', { expiryAt: '2026-09-30', expiryKind: 'KNOWN' });
    const clock = Date.parse('2026-09-12T10:00:00Z');
    expect((await readInventoryAuthority(db, scope, { now: clock })).items[0].freshness).toBe('fresh');
    // Bypass the schema CHECK to simulate corrupt authority data.
    db.seed('PRAGMA ignore_check_constraints = ON');
    db.seed('DROP TRIGGER trg_inventory_lots_live_update');
    db.seed("UPDATE inventory_lots SET expiry_at = '2026-02-30' WHERE id = 'eggs'");
    // Two independent fail-closed layers: the T09 snapshot schema rejects the
    // impossible date (DRIFT_DETECTED); if it ever admitted one, the freshness
    // derivation itself refuses to classify it (CORRUPT_LOT_ROW). Never "fresh".
    await expect(readInventoryAuthority(db, scope, { now: clock })).rejects.toMatchObject({
      code: expect.stringMatching(/^(DRIFT_DETECTED|CORRUPT_LOT_ROW)$/) });
    await expect(readInventoryAuthority(db, scope, { now: Number.NaN })).rejects.toMatchObject({ code: 'INVALID_READ_QUERY' });
  });
});
