import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeInventoryLotCommand } from '../../packages/db/src/inventory-lot-commands';
import { backfillLegacyInventory } from '../../packages/db/src/inventory-truth';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { authRoutes } from '../../src/worker/routes/auth';
import type { AuthContext, Env } from '../../src/worker/types';
import { signJwt, verifyJwt } from '../../src/worker/utils/jwt';
import { createOtpDigest, OTP_DIGEST_VERSION } from '../../src/worker/utils/otp-digest';
import { verifyPassword } from '../../src/worker/utils/password';
import { SESSION_COOKIE, sha256Hex } from '../../src/worker/utils/session';
import { SqliteD1, type SqliteStatementEvent } from '../helpers/sqlite-d1';

// Node cannot load the Workers-only cloudflare:email module.
vi.mock('../../src/worker/services/email', () => ({
  sendEmail: vi.fn(async () => ({ sent: true, provider: 'test' })),
  buildOtpEmail: (code: string) => ({ subject: 'Test OTP', html: code, text: code }),
}));

const ORIGIN = 'https://frigo.example.com';
const EMAIL = 'inventory-transfer@example.com';
const CODE = '123456';
const OTP_SECRET = 'integration-only-otp-secret-at-least-32-bytes';
const JWT_SECRET = 'integration-only-jwt-secret-at-least-32-bytes';
const SOURCE = 'hh_guest_source';
const TARGET = 'hh_transferuser';
const FOREIGN = 'hh_guest_foreign';
const GUEST_TOKEN = 'inventory-transfer-guest-cookie';
const NOW = '2026-09-11T10:00:00Z';
const inventoryTables = [
  'households', 'household_members', 'inventory_items', 'inventory_lots',
  'inventory_events', 'inventory_commands', 'storage_locations', 'shopping_lists', 'shopping_items',
];
const authTables = ['users', 'profiles', 'auth_accounts', 'sessions_v2'];
const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
app.use('*', authMiddleware);
app.route('/', authRoutes);

let db: SqliteD1;
let env: Env;
let cacheValues: Map<string, string>;
let cache: ReturnType<typeof createCache>;

function createCache() {
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = cacheValues.get(key) ?? null;
      return value && type === 'json' ? JSON.parse(value) as unknown : value;
    }),
    put: vi.fn(async (key: string, value: string) => { cacheValues.set(key, value); }),
    delete: vi.fn(async (key: string) => { cacheValues.delete(key); }),
  };
}

function snapshot(tables = [...inventoryTables, ...authTables, 'auth_otps']) {
  return JSON.stringify(Object.fromEntries(tables.map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY id`)])));
}

function businessCache() {
  return [...cacheValues].filter(([key]) => !key.startsWith('rl_auth:'));
}

async function seedOtp(purpose = 'register') {
  const digest = await createOtpDigest(EMAIL, purpose, CODE, OTP_SECRET);
  db.execute(`INSERT INTO auth_otps(id, email, purpose, code_digest, digest_version, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`, [purpose, EMAIL, purpose, digest, OTP_DIGEST_VERSION, new Date(Date.now() + 600_000).toISOString()]);
}

async function nativeStock(householdId: string, actorId: string) {
  await backfillLegacyInventory(db, householdId);
  const location = db.query<{ id: string }>(
    "SELECT id FROM storage_locations WHERE household_id = ? AND type = 'FRIDGE'", householdId,
  )[0];
  await executeInventoryLotCommand(db, { householdId, actorId }, 'fixture-create', {
    type: 'CREATE', lotId: `lot-${householdId}`, ingredientId: 'CHICKEN_EGG', rawName: `PRIVATE-${householdId}`,
    quantity: 5, unit: 'piece', storageLocationId: location.id, sourceType: 'MANUAL',
  }, NOW);
}

async function sourceStock(kind: 'legacy' | 'backfilled' | 'native' | 'empty') {
  if (kind === 'native') return nativeStock(SOURCE, 'guest-source');
  if (kind === 'empty') return;
  db.execute(`INSERT INTO inventory_items(id, household_id, ingredient_id, name, quantity, unit, storage)
    VALUES ('source-item', ?, 'CHICKEN_EGG', 'PRIVATE-source-eggs', 7, 'piece', 'fridge')`, [SOURCE]);
  db.execute(`INSERT INTO inventory_events(id, household_id, inventory_item_id, event_type, quantity_delta, unit, metadata)
    VALUES ('source-event', ?, 'source-item', 'ADD', 7, 'piece', '{"original":"legacy"}')`, [SOURCE]);
  if (kind === 'backfilled') await backfillLegacyInventory(db, SOURCE);
}

async function verify(extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return request('/auth/verify-otp', { email: EMAIL, code: CODE, purpose: 'register', ...extra }, headers);
}

async function request(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await app.fetch(new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.221', ...extraHeaders },
    body: JSON.stringify(body),
  }), env);
  return { response, json: await response.json() as Record<string, unknown> };
}

beforeEach(async () => {
  db = new SqliteD1();
  cacheValues = new Map();
  cache = createCache();
  env = { DB: db, CACHE: cache as unknown as Env['CACHE'], ENVIRONMENT: 'production', APP_URL: ORIGIN,
    OTP_HASH_SECRET: OTP_SECRET, JWT_SECRET };
  db.seed(`INSERT INTO users(id, email, is_guest) VALUES
      ('transferuser', '${EMAIL}', 0), ('guest-source', NULL, 1), ('guest-foreign', NULL, 1);
    INSERT INTO auth_accounts(id, user_id, email, is_verified) VALUES ('pending', 'transferuser', '${EMAIL}', 0);
    INSERT INTO profiles(id, user_id, display_name) VALUES ('transfer-profile', 'transferuser', 'Transfer Test');
    INSERT INTO households(id, name, created_by) VALUES
      ('${SOURCE}', 'PRIVATE-source', 'guest-source'), ('${TARGET}', 'PRIVATE-target', 'transferuser'),
      ('${FOREIGN}', 'PRIVATE-foreign', 'guest-foreign');
    INSERT INTO household_members(id, household_id, user_id, role) VALUES
      ('source-member', '${SOURCE}', 'guest-source', 'owner'), ('target-member', '${TARGET}', 'transferuser', 'owner'),
      ('foreign-member', '${FOREIGN}', 'guest-foreign', 'owner');`);
  for (const householdId of [SOURCE, TARGET, FOREIGN]) {
    db.execute('INSERT INTO shopping_lists(id, household_id) VALUES (?, ?)', [`list-${householdId}`, householdId]);
    db.execute('INSERT INTO shopping_items(id, list_id, name) VALUES (?, ?, ?)',
      [`shopping-${householdId}`, `list-${householdId}`, `PRIVATE-shopping-${householdId}`]);
    for (const prefix of ['plan_active_', 'inv_']) cacheValues.set(`${prefix}${householdId}`, `PRIVATE-${prefix}${householdId}`);
  }
  await nativeStock(TARGET, 'transferuser');
  await nativeStock(FOREIGN, 'guest-foreign');
  db.execute(`INSERT INTO sessions_v2(id, user_id, household_id, token_hash, expires_at)
    VALUES ('guest-session', 'guest-source', ?, ?, ?)`,
  [SOURCE, await sha256Hex(GUEST_TOKEN), new Date(Date.now() + 3_600_000).toISOString()]);
  await seedOtp();
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

async function expectDeferred(householdId: string, headers: Record<string, string> = {}) {
  expect(db.query('SELECT is_verified FROM auth_accounts WHERE id = ?', 'pending')).toEqual([{ is_verified: 0 }]);
  expect(db.query('SELECT used, used_at, attempt_count FROM auth_otps WHERE id = ?', 'register'))
    .toEqual([{ used: 0, used_at: null, attempt_count: 0 }]);
  expect(db.query('SELECT * FROM sessions_v2 WHERE user_id = ?', 'transferuser')).toEqual([]);
  const before = snapshot();
  const cached = businessCache();
  const totalChanges = db.query('SELECT total_changes() AS count');
  const statements: SqliteStatementEvent[] = [];
  const batch = vi.fn();
  db.hooks = { beforeStatement: (event) => { statements.push(event); }, beforeBatch: batch };
  let first: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { response, json } = await verify({ migrateFromHouseholdId: householdId }, headers);
    expect(response.status).toBe(409);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(Object.keys(json).sort()).toEqual(['code', 'error']);
    expect(json.code).toBe('INVENTORY_TRANSFER_DEFERRED');
    expect(json.error).toContain('Hàng tồn kho vẫn được giữ nguyên trong hộ khách');
    expect(json.error).toContain('Chỉ gửi lại yêu cầu không kèm migrateFromHouseholdId nếu bạn chọn');
    expect(json.error).toContain('riêng biệt');
    for (const privateValue of [SOURCE, TARGET, FOREIGN, EMAIL, 'PRIVATE-', householdId]) {
      expect(JSON.stringify(json)).not.toContain(privateValue);
    }
    if (first) expect(json).toEqual(first);
    first = json;
    expect(snapshot()).toBe(before);
    expect(businessCache()).toEqual(cached);
    expect(db.query('SELECT total_changes() AS count')).toEqual(totalChanges);
  }
  expect(statements).toHaveLength(2);
  for (const statement of statements) {
    expect(statement.method).toBe('first');
    expect(statement.sql).toMatch(/SELECT[\s\S]+FROM auth_otps/);
    expect(statement.bindings).toEqual([EMAIL, 'register']);
  }
  expect(batch).not.toHaveBeenCalled();
  expect(cache.delete).not.toHaveBeenCalled();
  for (const [key] of [...cache.get.mock.calls, ...cache.put.mock.calls]) expect(key).toMatch(/^rl_auth:/);
  expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
}

describe('T09F guest transfer safe deferral', () => {
  it.each(['legacy', 'backfilled', 'native', 'empty'] as const)(
    'preserves all %s guest data, OTP and pending account with a real guest cookie', async (kind) => {
      await sourceStock(kind);
      await expectDeferred(SOURCE, { Cookie: `${SESSION_COOKIE}=${GUEST_TOKEN}` });
    },
  );

  it.each(['legacy', 'backfilled', 'native', 'empty'] as const)(
    'defers %s stock with valid legacy guest JWT proof, without ownership lookups', async (kind) => {
      await sourceStock(kind);
      const jwt = await signJwt({ sub: 'guest-source', hid: SOURCE, typ: 'guest', isGuest: true,
        exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
      await expectDeferred(SOURCE, { Authorization: `Bearer ${jwt}` });
    },
  );

  it.each([
    ['foreign household with source cookie', FOREIGN, { Cookie: `${SESSION_COOKIE}=${GUEST_TOKEN}` }],
    ['nonexistent household with source cookie', 'hh_guest_missing', { Cookie: `${SESSION_COOKIE}=${GUEST_TOKEN}` }],
    ['forged bearer', FOREIGN, { Authorization: 'Bearer forged-guest-token' }],
    ['forged cookie', SOURCE, { Cookie: `${SESSION_COOKIE}=forged-cookie` }],
    ['no guest proof', SOURCE, {}],
  ] satisfies [string, string, Record<string, string>][])(
    'returns the same non-disclosing deferral for %s', async (_label, householdId, headers) => {
      await sourceStock('native');
      await expectDeferred(householdId, headers);
    },
  );

  it.each(['wrong', 'expired', 'used', 'locked', 'missing'] as const)(
    'keeps existing OTP protection ahead of transfer deferral for %s OTP', async (condition) => {
      await sourceStock('backfilled');
      if (condition === 'expired') db.execute("UPDATE auth_otps SET expires_at = datetime('now', '-1 minute')");
      if (condition === 'used') db.execute('UPDATE auth_otps SET used = 1');
      if (condition === 'locked') db.execute("UPDATE auth_otps SET attempt_count = 5, locked_until = datetime('now', '+15 minutes')");
      if (condition === 'missing') db.execute('DELETE FROM auth_otps');
      const before = snapshot([...inventoryTables, ...authTables]);
      const { response, json } = await verify({ code: condition === 'wrong' ? '999999' : CODE, migrateFromHouseholdId: SOURCE });
      expect(response.status).toBe(condition === 'locked' ? 429 : 400);
      expect(json.code).not.toBe('INVENTORY_TRANSFER_DEFERRED');
      expect(json).not.toHaveProperty('migratedFromHouseholdId');
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(snapshot([...inventoryTables, ...authTables])).toBe(before);
      if (condition === 'wrong' || condition === 'expired') {
        expect(db.query('SELECT used, used_at, attempt_count FROM auth_otps')).toEqual([{ used: 0, used_at: null, attempt_count: 1 }]);
      }
    },
  );

  it.each(['', 'hh_other', 42, null])('retains schema rejection for malformed transfer ID %s', async (householdId) => {
    const before = snapshot();
    const { response, json } = await verify({ migrateFromHouseholdId: householdId });
    expect(response.status).toBe(400);
    expect(json.code).toBe('VALIDATION_ERROR');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(snapshot()).toBe(before);
  });

  it.each([false, true])('registers without migration, including an explicit retry after deferral=%s', async (retry) => {
    await sourceStock('native');
    const before = snapshot(inventoryTables);
    const headers = { Cookie: `${SESSION_COOKIE}=${GUEST_TOKEN}` };
    if (retry) await expectDeferred(SOURCE, headers);
    db.hooks = {};
    const { response, json } = await verify({}, headers);
    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json).not.toHaveProperty('migratedFromHouseholdId');
    expect(json.user).toMatchObject({ id: 'transferuser', householdId: TARGET, isGuest: false });
    expect(response.headers.get('Set-Cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=[a-f0-9]+;`));
    expect(db.query('SELECT is_verified FROM auth_accounts WHERE id = ?', 'pending')).toEqual([{ is_verified: 1 }]);
    expect(db.query('SELECT used, used_at FROM auth_otps WHERE id = ?', 'register')[0]).toMatchObject({ used: 1, used_at: expect.any(String) });
    expect(db.query('SELECT * FROM sessions_v2 WHERE user_id = ?', 'transferuser')).toHaveLength(1);
    expect(snapshot(inventoryTables)).toBe(before);
    const replay = await verify();
    expect(replay.response.status).toBe(400);
    expect(replay.response.headers.get('Set-Cookie')).toBeNull();
    expect(db.query('SELECT * FROM sessions_v2 WHERE user_id = ?', 'transferuser')).toHaveLength(1);
  });

  it('D3 client contract: the exact OTP issued by /auth/register survives a deferred transfer and then verifies without the field', async () => {
    // Full product sequence at the real route boundary (guest cookie present),
    // for a brand-new email: register → verify with migrateFromHouseholdId
    // (409, OTP untouched) → verify the SAME code without the field (200).
    await sourceStock('legacy');
    const email = 'guest-conversion@example.com';
    const headers = { Cookie: `${SESSION_COOKIE}=${GUEST_TOKEN}` };
    const devEnv = { ...env, ENVIRONMENT: 'development' as const };
    const registered = await app.fetch(new Request(`${ORIGIN}/auth/register`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.222', ...headers },
      body: JSON.stringify({ name: 'Guest Conversion', email, password: 'strong-password-1' }),
    }), devEnv);
    const issued = await registered.json() as { success: boolean; devOtp?: string };
    expect(registered.status, JSON.stringify(issued)).toBe(200);
    expect(issued.success).toBe(true);
    expect(issued.devOtp).toMatch(/^\d{6}$/);
    const account = db.query<{ user_id: string }>('SELECT user_id FROM auth_accounts WHERE email = ?', email);
    expect(account).toHaveLength(1);
    const userId = account[0].user_id;
    const otpBefore = db.query('SELECT id, used, used_at, attempt_count FROM auth_otps WHERE email = ?', email);
    expect(otpBefore).toHaveLength(1);
    expect(otpBefore[0]).toMatchObject({ used: 0, used_at: null, attempt_count: 0 });
    const inventoryBefore = snapshot(inventoryTables);
    const attempt = (extra: Record<string, unknown>) =>
      request('/auth/verify-otp', { email, code: issued.devOtp, purpose: 'register', ...extra }, headers);

    const deferred = await attempt({ migrateFromHouseholdId: SOURCE });
    expect(deferred.response.status).toBe(409);
    expect(deferred.json).toEqual({ error: expect.any(String), code: 'INVENTORY_TRANSFER_DEFERRED' });
    expect(deferred.response.headers.get('Set-Cookie')).toBeNull();
    // Deferral consumed nothing: same OTP row, unused, no failed attempt recorded.
    expect(db.query('SELECT id, used, used_at, attempt_count FROM auth_otps WHERE email = ?', email)).toEqual(otpBefore);
    expect(db.query('SELECT is_verified FROM auth_accounts WHERE email = ?', email)).toEqual([{ is_verified: 0 }]);
    expect(db.query('SELECT * FROM sessions_v2 WHERE user_id = ?', userId)).toEqual([]);
    expect(snapshot(inventoryTables)).toBe(inventoryBefore);

    const continued = await attempt({});
    expect(continued.response.status).toBe(200);
    expect(continued.json.success).toBe(true);
    expect(continued.json).not.toHaveProperty('migratedFromHouseholdId');
    expect(continued.json.user).toMatchObject({ id: userId, householdId: `hh_${userId}`, isGuest: false });
    expect(continued.response.headers.get('Set-Cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=[a-f0-9]+;`));
    expect(db.query('SELECT used FROM auth_otps WHERE email = ?', email)).toEqual([{ used: 1 }]);
    expect(db.query('SELECT is_verified FROM auth_accounts WHERE email = ?', email)).toEqual([{ is_verified: 1 }]);
    expect(db.query('SELECT * FROM sessions_v2 WHERE user_id = ?', userId)).toHaveLength(1);
    // Guest stock stayed in the guest household; nothing moved to the account.
    expect(snapshot(inventoryTables)).toBe(inventoryBefore);
    expect(db.query('SELECT household_id FROM inventory_items WHERE id = ?', 'source-item')).toEqual([{ household_id: SOURCE }]);
    expect(db.query('SELECT COUNT(*) AS count FROM inventory_items WHERE household_id = ?', `hh_${userId}`)).toEqual([{ count: 0 }]);
    // The consumed OTP cannot be replayed, with or without the field.
    expect((await attempt({})).response.status).toBe(400);
    expect((await attempt({ migrateFromHouseholdId: SOURCE })).response.status).toBe(400);
    expect(db.query('SELECT * FROM sessions_v2 WHERE user_id = ?', userId)).toHaveLength(1);
  });

  it('leaves forgot-password preliminary verification and final reset unchanged even with a transfer field', async () => {
    await sourceStock('native');
    db.execute("UPDATE auth_accounts SET is_verified = 1 WHERE id = 'pending'");
    await seedOtp('forgot_password');
    const before = snapshot();
    const inventory = snapshot(inventoryTables);
    const { response, json } = await verify({ purpose: 'forgot_password', migrateFromHouseholdId: SOURCE });
    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(json).not.toHaveProperty('migratedFromHouseholdId');
    expect(snapshot()).toBe(before);
    const resetJwt = await verifyJwt(String(json.resetToken), JWT_SECRET);
    expect(resetJwt.valid).toBe(true);
    expect(resetJwt.payload).toMatchObject({ sub: EMAIL, typ: 'reset', purpose: 'password_reset' });
    const newPassword = 'updated-password-strong';
    const reset = await request('/auth/reset-password', { email: EMAIL, code: CODE, newPassword });
    expect(reset.response.status).toBe(200);
    expect(reset.json.success).toBe(true);
    expect(reset.response.headers.get('Set-Cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=[a-f0-9]+;`));
    expect(db.query('SELECT used FROM auth_otps WHERE id = ?', 'forgot_password')).toEqual([{ used: 1 }]);
    const account = db.query<{ salt: string; password_hash: string }>('SELECT salt, password_hash FROM auth_accounts WHERE id = ?', 'pending')[0];
    expect(await verifyPassword(newPassword, account.salt, account.password_hash)).toBe(true);
    expect(snapshot(inventoryTables)).toBe(inventory);
  });
});
