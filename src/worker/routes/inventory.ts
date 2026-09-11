import { Hono } from 'hono';
import { Env, AuthContext } from '../types';
import { SQL } from '@frigo/db';
import { InventoryWriterAuthorityError, runLegacyInventoryBatch } from '../../../packages/db/src/inventory-writer-fence';
import {
  areUnitsCompatible,
  computeFreshness,
  convertUnit,
  findCanonicalIngredient,
  StandardUnit,
} from '@frigo/domain';
import { tenancyGuard } from '../middleware/tenancy';
import { rateLimiter } from '../middleware/rate-limit';
import { InventoryCreateSchema, InventoryUpdateSchema } from '../validation/schemas';

export const inventoryRoutes = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

function readIdempotencyKey(c: any): string | null {
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key) return null;
  return IDEMPOTENCY_KEY_RE.test(key) ? key : null;
}

export function inventoryMutationFingerprint(
  operation: string,
  itemId: string,
  payload: Record<string, unknown> = {}
): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)])
      );
    }
    return value;
  };

  return JSON.stringify({ operation, itemId, ...normalize(payload) as Record<string, unknown> });
}

export function inventoryMutationFingerprintFromMetadata(metadata: unknown): string | null {
  if (typeof metadata !== 'string' || metadata.length === 0) return null;
  try {
    const parsed = JSON.parse(metadata) as { commandFingerprint?: unknown; requestFingerprint?: unknown };
    const fingerprint = parsed.requestFingerprint ?? parsed.commandFingerprint;
    return typeof fingerprint === 'string' ? fingerprint : null;
  } catch {
    return null;
  }
}

export function inventoryMutationResultFromMetadata(metadata: unknown): Record<string, unknown> | null {
  if (typeof metadata !== 'string' || metadata.length === 0) return null;
  try {
    const parsed = JSON.parse(metadata) as { result?: unknown };
    return parsed.result && typeof parsed.result === 'object'
      ? (parsed.result as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function stableInventoryEventId(
  operation: 'update' | 'discard',
  itemId: string,
  idempotencyKey: string
): Promise<string>;
export async function stableInventoryEventId(
  operation: 'update' | 'discard',
  householdId: string,
  itemId: string,
  idempotencyKey: string
): Promise<string>;
export async function stableInventoryEventId(
  operation: 'update' | 'discard',
  householdOrItemId: string,
  itemOrKey: string,
  maybeKey?: string
): Promise<string> {
  const householdId = maybeKey === undefined ? '' : householdOrItemId;
  const itemId = maybeKey === undefined ? householdOrItemId : itemOrKey;
  const idempotencyKey = maybeKey === undefined ? itemOrKey : maybeKey;
  const input = new TextEncoder().encode(`${operation}:${householdId}:${itemId}:${idempotencyKey}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `evt_${operation}_${hex.slice(0, 48)}`;
}

function inventoryCreateFingerprint(item: {
  id: string;
  ingredientId?: string | null;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  storage: string;
  expiryDate?: string | null;
  dataSource: string;
}): string {
  return inventoryMutationFingerprint('create', item.id, {
    ingredientId: item.ingredientId || null,
    name: item.name,
    quantity: Number(item.quantity),
    unit: item.unit,
    category: item.category,
    storage: item.storage,
    expiryDate: item.expiryDate || null,
    dataSource: item.dataSource,
  });
}

const storedInventoryCommandFingerprint = inventoryMutationFingerprintFromMetadata;

function assertBatchSucceeded(results: any[] | undefined): void {
  if (results?.some((result) => result && result.success === false)) {
    throw new Error('D1 batch reported an unsuccessful statement');
  }
}

export function parseInventoryIfMatch(value: string | undefined): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  const match = raw.match(/^(?:W\/)?"?(\d+)"?$/);
  return match ? Number(match[1]) : null;
}

type InventoryReplayResult =
  | { kind: 'missing' }
  | { kind: 'conflict' }
  | { kind: 'replay'; item: any | null };

async function readInventoryReplay(
  db: any,
  eventId: string,
  itemId: string,
  householdId: string,
  requestFingerprint: string
): Promise<InventoryReplayResult> {
  const event = (await db
    .prepare('SELECT metadata FROM inventory_events WHERE id = ? AND household_id = ? LIMIT 1')
    .bind(eventId, householdId)
    .first()) as { metadata: string | null } | null;
  if (!event) return { kind: 'missing' };

  const storedFingerprint = inventoryMutationFingerprintFromMetadata(event.metadata);
  if (storedFingerprint && storedFingerprint !== requestFingerprint) return { kind: 'conflict' };

  const item = (await db.prepare(SQL.GET_INVENTORY_ITEM).bind(itemId, householdId).first()) as any;
  return { kind: 'replay', item };
}

function mapInventoryRow(row: any): any {
  return {
    id: row.id,
    householdId: row.household_id,
    // Keep the API projection string-safe for the domain engine while the D1
    // column itself remains nullable for genuinely unmapped ingredients.
    ingredientId: row.ingredient_id || '',
    normalizationStatus: row.ingredient_id ? 'matched' : 'unmapped',
    name: row.name,
    quantity: row.quantity,
    unit: row.unit as StandardUnit,
    category: row.category,
    storage: row.storage,
    expiryDate: row.expiry_date,
    addedDate: row.added_date,
    freshness: row.freshness,
    dataSource: row.data_source,
    version: Number.isInteger(Number(row.version)) ? Number(row.version) : 1,
    updatedAt: row.updated_at,
  };
}

// Enforce strict multi-tenancy isolation on all inventory operations
inventoryRoutes.use('/inventory*', tenancyGuard);

// Budget-friendly D1 writes: cap mutations per user (reads are cheap + cached)
inventoryRoutes.use(
  '/inventory',
  async (c, next) => (c.req.method === 'GET' ? next() : rateLimiter({ maxRequests: 60, windowSeconds: 60, prefix: 'rl_inv_w' })(c, next))
);
inventoryRoutes.use(
  '/inventory/*',
  async (c, next) => (c.req.method === 'GET' ? next() : rateLimiter({ maxRequests: 60, windowSeconds: 60, prefix: 'rl_inv_w' })(c, next))
);

/**
 * Fetch household inventory directly from D1 (Single Source of Truth) with KV caching
 */
export interface InventoryReadOptions {
  /**
   * Strict reads are used by commands that must not continue with a fabricated
   * empty inventory. The default remains permissive for legacy read callers.
   */
  strict?: boolean;
}

export class InventoryReadError extends Error {
  readonly code = 'DATABASE_UNAVAILABLE';

  constructor(message = 'Database service unavailable') {
    super(message);
    this.name = 'InventoryReadError';
  }
}

export async function fetchHouseholdInventoryFromDb(
  db: any,
  householdId: string,
  kv?: any,
  options: InventoryReadOptions = {}
): Promise<any[]> {
  if (!db) {
    if (options.strict) throw new InventoryReadError();
    return [];
  }

  try {
    const res = await db.prepare(SQL.GET_INVENTORY).bind(householdId).all();
    const items = (res.results || []).map(mapInventoryRow);

    if (kv) {
      // Invalidate / update KV read cache (1 hour TTL)
      await kv.put(`inv_${householdId}`, JSON.stringify(items), { expirationTtl: 3600 }).catch(() => {});
    }

    return items;
  } catch (err) {
    console.error('Failed fetching inventory from D1:', err);
    // A strict command must fail closed; returning stale/empty data here can
    // generate an incorrect plan or claim a mutation succeeded.
    if (options.strict) {
      throw new InventoryReadError('Failed fetching inventory from database');
    }
    if (kv) {
      const cached = await kv.get(`inv_${householdId}`, 'json').catch(() => null);
      if (cached) return cached as any[];
    }
    return [];
  }
}

// Backward-compatible export for other modules
export async function getHouseholdInventory(db: any, householdId: string): Promise<any[]> {
  return await fetchHouseholdInventoryFromDb(db, householdId);
}

// GET /api/v1/inventory
inventoryRoutes.get('/inventory', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const kv = c.env.CACHE;

  try {
    const items = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true });
    return c.json({ items });
  } catch (err) {
    console.error('GET inventory unavailable:', err);
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }
});

// POST /api/v1/inventory
inventoryRoutes.post('/inventory', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const kv = c.env.CACHE;

  const rawBody = await c.req.json().catch(() => ({}));
  const parseResult = InventoryCreateSchema.safeParse(rawBody);

  if (!parseResult.success) {
    return c.json(
      {
        error: parseResult.error.errors[0]?.message || 'Dữ liệu nguyên liệu không hợp lệ',
        code: 'VALIDATION_ERROR',
      },
      400
    );
  }

  const body = parseResult.data;
  const canonical = findCanonicalIngredient(body.name);
  const ingredientId = canonical?.id || null;
  const category = body.category !== 'other' ? body.category : (canonical ? canonical.category : 'other');
  const unit = body.unit !== 'piece' ? body.unit : (canonical ? canonical.defaultUnit : 'piece');
  const freshness = computeFreshness(body.expiryDate ?? undefined, undefined, canonical?.defaultShelfLifeDays || 7);

  const newItem = {
    id: body.id || `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    householdId: auth.householdId,
    ingredientId,
    name: body.name.trim(),
    quantity: Number(body.quantity),
    unit,
    category,
    storage: body.storage,
    expiryDate: body.expiryDate || null,
    addedDate: new Date().toISOString(),
    freshness,
    dataSource: body.dataSource,
    updatedAt: new Date().toISOString(),
  };
  const createFingerprint = inventoryCreateFingerprint(newItem);

  if (!db) {
    // Keep the response contract explicit in environments without a D1
    // binding; mutations must not look durable when no database exists.
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  try {
    // Client-generated IDs make offline POST replay idempotent. Never allow
    // an existing resource ID from another household to be overwritten.
    if (body.id) {
      const existingById = await db
        .prepare('SELECT * FROM inventory_items WHERE id = ? LIMIT 1')
        .bind(body.id)
        .first<any>();
      if (existingById && existingById.household_id !== auth.householdId) {
        return c.json({ error: 'ID nguyên liệu đã thuộc hộ gia đình khác', code: 'CONFLICT' }, 409);
      }
      if (existingById) {
        const addEvent = await db
          .prepare('SELECT metadata FROM inventory_events WHERE id = ? AND household_id = ? LIMIT 1')
          .bind(`evt_add_${newItem.id}`, auth.householdId)
          .first<{ metadata: string | null }>();
        const storedFingerprint = storedInventoryCommandFingerprint(addEvent?.metadata);
        const legacyFingerprint = inventoryCreateFingerprint({
          id: existingById.id,
          ingredientId: existingById.ingredient_id,
          name: existingById.name,
          quantity: existingById.quantity,
          unit: existingById.unit,
          category: existingById.category,
          storage: existingById.storage,
          expiryDate: existingById.expiry_date,
          dataSource: existingById.data_source,
        });
        if ((storedFingerprint || legacyFingerprint) !== createFingerprint) {
          return c.json(
            { error: 'ID nguyên liệu đã được dùng cho dữ liệu khác', code: 'IDEMPOTENCY_CONFLICT' },
            409
          );
        }
        return c.json({ success: true, idempotentReplay: true, item: mapInventoryRow(existingById) });
      }
    }

    // Atomic insert of item and inventory audit event
    const batchResults = await runLegacyInventoryBatch(db, auth.householdId, [
      db.prepare(SQL.INSERT_INVENTORY_ITEM.replace(/^INSERT /, 'INSERT OR IGNORE ')).bind(
        newItem.id,
        newItem.householdId,
        newItem.ingredientId,
        newItem.name,
        newItem.quantity,
        newItem.unit,
        newItem.category,
        newItem.storage,
        newItem.expiryDate,
        newItem.addedDate,
        newItem.freshness,
        newItem.dataSource
      ),
      db.prepare(SQL.INSERT_INVENTORY_EVENT.replace(/^INSERT /, 'INSERT OR IGNORE ')).bind(
        `evt_add_${newItem.id}`,
        auth.householdId,
        newItem.id,
        'ADD',
        newItem.quantity,
        newItem.unit,
        'Thêm nguyên liệu thủ công',
        JSON.stringify({ commandFingerprint: createFingerprint })
      ),
    ]);
    assertBatchSucceeded(batchResults);

    // A concurrent replay may have won the insert race; return the durable
    // row rather than an optimistic object that was never persisted.
    const persisted = await db
      .prepare(SQL.GET_INVENTORY_ITEM)
      .bind(newItem.id, auth.householdId)
      .first<any>();
    if (!persisted) {
      throw new Error('Inventory insert did not produce a durable row');
    }
    const persistedEvent = await db
      .prepare('SELECT metadata FROM inventory_events WHERE id = ? AND household_id = ? LIMIT 1')
      .bind(`evt_add_${newItem.id}`, auth.householdId)
      .first<{ metadata: string | null }>();
    if (storedInventoryCommandFingerprint(persistedEvent?.metadata) !== createFingerprint) {
      return c.json(
        { error: 'ID nguyên liệu đã được dùng cho dữ liệu khác', code: 'IDEMPOTENCY_CONFLICT' },
        409
      );
    }

    if (kv) {
      await kv.delete(`inv_${auth.householdId}`).catch(() => {});
    }

    const insertResult = batchResults?.[0] as any;
    const idempotentReplay = insertResult?.meta?.changes === 0;
    return c.json(
      { success: true, ...(idempotentReplay ? { idempotentReplay: true } : {}), item: mapInventoryRow(persisted) },
      idempotentReplay ? 200 : 201
    );
  } catch (err: any) {
    if (err instanceof InventoryWriterAuthorityError) return c.json({ error: err.message, code: err.code }, 409);
    console.error('D1 INSERT_INVENTORY_ITEM error:', err);
    return c.json({ error: 'Không thể thêm nguyên liệu vào cơ sở dữ liệu', code: 'DATABASE_ERROR' }, 500);
  }
});

// PATCH /api/v1/inventory/:id
inventoryRoutes.patch('/inventory/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.CACHE;
  const rawIdempotencyKey = c.req.header('Idempotency-Key')?.trim();
  if (rawIdempotencyKey && !readIdempotencyKey(c)) {
    return c.json({ error: 'Idempotency-Key không hợp lệ', code: 'VALIDATION_ERROR' }, 400);
  }
  const idempotencyKey = readIdempotencyKey(c);

  const rawBody = await c.req.json().catch(() => ({}));
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody) || !('version' in rawBody)) {
    return c.json(
      { error: 'version là bắt buộc để cập nhật nguyên liệu', code: 'PRECONDITION_REQUIRED' },
      428
    );
  }
  const parseResult = InventoryUpdateSchema.safeParse(rawBody);

  if (!parseResult.success) {
    return c.json(
      {
        error: parseResult.error.errors[0]?.message || 'Dữ liệu cập nhật không hợp lệ',
        code: 'VALIDATION_ERROR',
      },
      400
    );
  }

  const body = parseResult.data;
  if (!db) {
    return c.json({ error: 'Database service unavailable' }, 503);
  }

  try {
    // Row-level tenancy check: ensure item belongs to this household
    const existing = await db
      .prepare(SQL.GET_INVENTORY_ITEM)
      .bind(id, auth.householdId)
      .first<any>();

    if (!existing) {
      return c.json({ error: 'Nguyên liệu không tồn tại hoặc bạn không có quyền sửa', code: 'NOT_FOUND' }, 404);
    }

    const requestFingerprint = inventoryMutationFingerprint('PATCH', id, body as Record<string, unknown>);
    const replayEventId = idempotencyKey
      ? await stableInventoryEventId('update', auth.householdId, id, idempotencyKey)
      : null;
    if (replayEventId) {
      const replay = await readInventoryReplay(db, replayEventId, id, auth.householdId, requestFingerprint);
      if (replay.kind === 'conflict') {
        return c.json(
          { error: 'Idempotency-Key đã được dùng cho một lệnh cập nhật khác', code: 'IDEMPOTENCY_CONFLICT' },
          409
        );
      }
      if (replay.kind === 'replay') {
        return c.json({ success: true, idempotentReplay: true, item: mapInventoryRow(replay.item || existing) });
      }
    }

    const canonical = findCanonicalIngredient(body.name || existing.name);
    const storedVersion = Number.isInteger(Number(existing.version)) ? Number(existing.version) : 1;
    const expectedVersion = Number(body.version);
    if (expectedVersion !== storedVersion) {
      return c.json(
        {
          error: 'Nguyên liệu đã được cập nhật bởi thiết bị khác',
          code: 'CONFLICT',
          expectedVersion: storedVersion,
          receivedVersion: expectedVersion,
        },
        409
      );
    }
    const name = body.name !== undefined ? body.name.trim() : existing.name;
    const unit = body.unit !== undefined ? body.unit : existing.unit;
    const unitChanged = body.unit !== undefined && body.unit !== existing.unit;
    if (unitChanged && !areUnitsCompatible(existing.unit as StandardUnit, unit as StandardUnit)) {
      return c.json(
        {
          error: `Không thể quy đổi đơn vị ${existing.unit} sang ${unit}`,
          code: 'UNIT_MISMATCH',
        },
        422
      );
    }
    const convertedExistingQuantity = unitChanged
      ? convertUnit(Number(existing.quantity), existing.unit as StandardUnit, unit as StandardUnit)
      : Number(existing.quantity);
    const quantity = body.quantity !== undefined ? Number(body.quantity) : convertedExistingQuantity;
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(convertedExistingQuantity)) {
      return c.json({ error: 'Số lượng nguyên liệu không hợp lệ', code: 'VALIDATION_ERROR' }, 400);
    }
    const category =
      body.category !== undefined
        ? body.category
        : body.name !== undefined && canonical
          ? canonical.category
          : existing.category;
    const storage = body.storage !== undefined ? body.storage : existing.storage;
    const expiryDate = body.expiryDate !== undefined ? body.expiryDate : existing.expiry_date;
    const freshness = expiryDate ? computeFreshness(expiryDate, undefined, canonical?.defaultShelfLifeDays || 7) : existing.freshness;
    const ingredientId = body.name !== undefined ? canonical?.id || null : existing.ingredient_id || canonical?.id || null;

    const batchResults = await runLegacyInventoryBatch(db, auth.householdId, [
      db
        .prepare(
          `UPDATE inventory_items
           SET name = ?, ingredient_id = ?, quantity = ?, unit = ?, category = ?, storage = ?,
               expiry_date = ?, freshness = ?, version = version + 1, updated_at = datetime('now')
           WHERE id = ? AND household_id = ?
             AND version = ?`
        )
        .bind(
          name,
          ingredientId,
          quantity,
          unit,
          category,
          storage,
          expiryDate,
          freshness,
          id,
          auth.householdId,
          expectedVersion
        ),
      db
        .prepare(
          `INSERT INTO inventory_events
             (id, household_id, inventory_item_id, event_type, quantity_delta, unit, reason, metadata)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?
           WHERE changes() = 1`
        )
        .bind(
          replayEventId || `evt_update_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          auth.householdId,
          id,
          'MANUAL_UPDATE',
          quantity - convertedExistingQuantity,
          unit,
          'Cập nhật nguyên liệu',
          JSON.stringify({ requestFingerprint })
        ),
    ]);
    assertBatchSucceeded(batchResults);
    const updateResult = batchResults?.[0] as any;
    if (updateResult?.meta?.changes !== 1) {
      if (replayEventId) {
        const replay = await readInventoryReplay(db, replayEventId, id, auth.householdId, requestFingerprint);
        if (replay.kind === 'conflict') {
          return c.json(
            { error: 'Idempotency-Key đã được dùng cho một lệnh cập nhật khác', code: 'IDEMPOTENCY_CONFLICT' },
            409
          );
        }
        if (replay.kind === 'replay') {
          return c.json({ success: true, idempotentReplay: true, item: mapInventoryRow(replay.item || existing) });
        }
      }
      return c.json({ error: 'Nguyên liệu không tồn tại hoặc đã thay đổi', code: 'CONFLICT' }, 409);
    }

    if (kv) {
      await kv.delete(`inv_${auth.householdId}`).catch(() => {});
    }

    const updatedItem = {
      id,
      householdId: auth.householdId,
      ingredientId,
      name,
      quantity,
      unit,
      category,
      storage,
      expiryDate,
      freshness,
      dataSource: existing.data_source,
      version: expectedVersion + 1,
      updatedAt: new Date().toISOString(),
    };

    return c.json({ success: true, item: updatedItem });
  } catch (err: any) {
    const replayEventId = idempotencyKey
      ? await stableInventoryEventId('update', auth.householdId, id, idempotencyKey)
      : null;
    if (replayEventId) {
      try {
        const requestFingerprint = inventoryMutationFingerprint('PATCH', id, body as Record<string, unknown>);
        const replay = await readInventoryReplay(db, replayEventId, id, auth.householdId, requestFingerprint);
        if (replay.kind === 'conflict') {
          return c.json(
            { error: 'Idempotency-Key đã được dùng cho một lệnh cập nhật khác', code: 'IDEMPOTENCY_CONFLICT' },
            409
          );
        }
        if (replay.kind === 'replay' && replay.item) {
          return c.json({ success: true, idempotentReplay: true, item: mapInventoryRow(replay.item) });
        }
      } catch {
        // Fall through to the original database error.
      }
    }
    if (err instanceof InventoryWriterAuthorityError) return c.json({ error: err.message, code: err.code }, 409);
    console.error('D1 UPDATE_INVENTORY_ITEM failed:', err);
    return c.json({ error: 'Lỗi cập nhật nguyên liệu trong cơ sở dữ liệu', code: 'DATABASE_ERROR' }, 500);
  }
});

// DELETE /api/v1/inventory/:id
inventoryRoutes.delete('/inventory/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const db = c.env.DB;
  const kv = c.env.CACHE;
  const rawIdempotencyKey = c.req.header('Idempotency-Key')?.trim();
  if (rawIdempotencyKey && !readIdempotencyKey(c)) {
    return c.json({ error: 'Idempotency-Key không hợp lệ', code: 'VALIDATION_ERROR' }, 400);
  }
  const idempotencyKey = readIdempotencyKey(c);
  const expectedVersion = parseInventoryIfMatch(c.req.header('If-Match'));
  if (expectedVersion === null) {
    return c.json({ error: 'If-Match là bắt buộc để xóa nguyên liệu', code: 'PRECONDITION_REQUIRED' }, 428);
  }

  if (!db) {
    return c.json({ error: 'Database service unavailable' }, 503);
  }

  try {
    // Row-level tenancy check: ensure item belongs to this household
    const existing = await db
      .prepare(SQL.GET_INVENTORY_ITEM)
      .bind(id, auth.householdId)
      .first<any>();

    if (!existing) {
      return c.json({ error: 'Nguyên liệu không tồn tại hoặc bạn không có quyền xóa', code: 'NOT_FOUND' }, 404);
    }

    const requestFingerprint = inventoryMutationFingerprint('DELETE', id, {});
    const replayEventId = idempotencyKey
      ? await stableInventoryEventId('discard', auth.householdId, id, idempotencyKey)
      : null;
    if (replayEventId) {
      const replayEvent = await db
        .prepare('SELECT id, metadata FROM inventory_events WHERE id = ? AND household_id = ? LIMIT 1')
        .bind(replayEventId, auth.householdId)
        .first<{ id: string; metadata: string | null }>();
      if (replayEvent) {
        const storedFingerprint = inventoryMutationFingerprintFromMetadata(replayEvent.metadata);
        if (storedFingerprint && storedFingerprint !== requestFingerprint) {
          return c.json(
            { error: 'Idempotency-Key đã được dùng cho một lệnh xóa khác', code: 'IDEMPOTENCY_CONFLICT' },
            409
          );
        }
        return c.json({ success: true, idempotentReplay: true, message: 'Nguyên liệu đã được xóa trước đó' });
      }
    }

    const storedVersion = Number.isInteger(Number(existing.version)) ? Number(existing.version) : 1;
    if (expectedVersion !== storedVersion) {
      return c.json(
        {
          error: 'Nguyên liệu đã được cập nhật bởi thiết bị khác',
          code: 'CONFLICT',
          expectedVersion: storedVersion,
          receivedVersion: expectedVersion,
        },
        409
      );
    }

    // Keep the projection row so inventory events never point at a deleted
    // item. A zero-quantity row is also useful for freshness/history views and
    // can be rebuilt or permanently purged by a future retention job.
    const batchResults = await runLegacyInventoryBatch(db, auth.householdId, [
      db
        .prepare(
          `UPDATE inventory_items
           SET quantity = 0, freshness = 'out_of_stock', version = version + 1, updated_at = datetime('now')
           WHERE id = ? AND household_id = ?
             AND version = ?`
        )
        .bind(id, auth.householdId, expectedVersion),
      db
        .prepare(
          `INSERT INTO inventory_events
             (id, household_id, inventory_item_id, event_type, quantity_delta, unit, reason, metadata)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?
           WHERE changes() = 1`
        )
        .bind(
          replayEventId || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          auth.householdId,
          id,
          'DISCARD',
          -existing.quantity,
          existing.unit,
          'Người dùng xóa nguyên liệu khỏi tủ',
          JSON.stringify({ requestFingerprint })
        ),
    ]);
    assertBatchSucceeded(batchResults);
    const deleteResult = batchResults?.[0] as any;
    if (deleteResult?.meta?.changes !== 1) {
      if (replayEventId) {
        const replay = await readInventoryReplay(db, replayEventId, id, auth.householdId, requestFingerprint);
        if (replay.kind === 'conflict') {
          return c.json(
            { error: 'Idempotency-Key đã được dùng cho một lệnh xóa khác', code: 'IDEMPOTENCY_CONFLICT' },
            409
          );
        }
        if (replay.kind === 'replay') {
          return c.json({ success: true, idempotentReplay: true, message: 'Nguyên liệu đã được xóa trước đó' });
        }
      }
      return c.json({ error: 'Nguyên liệu không tồn tại hoặc đã thay đổi', code: 'CONFLICT' }, 409);
    }

    if (kv) {
      await kv.delete(`inv_${auth.householdId}`).catch(() => {});
    }

    return c.json({ success: true, message: 'Đã xóa nguyên liệu thành công' });
  } catch (err: any) {
    const replayEventId = idempotencyKey
      ? await stableInventoryEventId('discard', auth.householdId, id, idempotencyKey)
      : null;
    if (replayEventId) {
      try {
        const requestFingerprint = inventoryMutationFingerprint('DELETE', id, {});
        const replay = await readInventoryReplay(db, replayEventId, id, auth.householdId, requestFingerprint);
        if (replay.kind === 'conflict') {
          return c.json(
            { error: 'Idempotency-Key đã được dùng cho một lệnh xóa khác', code: 'IDEMPOTENCY_CONFLICT' },
            409
          );
        }
        if (replay.kind === 'replay') {
          return c.json({ success: true, idempotentReplay: true, message: 'Nguyên liệu đã được xóa trước đó' });
        }
      } catch {
        // Fall through to the original database error.
      }
    }
    if (err instanceof InventoryWriterAuthorityError) return c.json({ error: err.message, code: err.code }, 409);
    console.error('D1 DELETE_INVENTORY_ITEM failed:', err);
    return c.json({ error: 'Lỗi xóa nguyên liệu', code: 'DATABASE_ERROR' }, 500);
  }
});
