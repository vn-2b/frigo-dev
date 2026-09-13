import { Hono } from 'hono';
import { z } from 'zod';
import { Env, AuthContext } from '../types';
import {
  InventoryReadAuthorityError, readInventoryLot, readInventorySummary,
} from '../../../packages/db/src/inventory-read-authority';
import { readInventoryObservations } from '../../../packages/db/src/inventory-observations';
import {
  confirmReconciliationDecision, planInventoryReconciliationForHousehold,
} from '../../../packages/db/src/inventory-reconciliation';
import {
  MAX_OBSERVATION_SOURCE_REF, ObservationError, observationIdentity,
  type InventoryObservation,
} from '../../../packages/domain/src/inventory-observations';
import { LotCommandError } from '../../../packages/domain/src/inventory-lot-commands';
import { readInventoryAuthorityMode } from '../../../packages/db/src/inventory-writer-fence';
import { inventoryAuthorityFailure } from '../utils/inventory-authority';
import { provenanceDataSource } from '../utils/scan-evidence';
import type { InventoryReadItem } from '../../../packages/domain/src/inventory-read-authority';
import { tenancyGuard } from '../middleware/tenancy';
import { rateLimiter } from '../middleware/rate-limit';

// T13 Inventory UX V2 read/decision surface. Every route here is additive and
// household-scoped, and every one of them composes the ALREADY CERTIFIED
// services: T11 read authority for inventory state, T10 observation/
// reconciliation services for evidence and decisions. No reconciliation
// algorithm is reimplemented in route code, no route writes inventory
// directly, and the frontend submits INTENT only — the server owns decision
// semantics.
export const inventoryTruthRoutes = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

inventoryTruthRoutes.use('/inventory/*', tenancyGuard);
inventoryTruthRoutes.use('/inventory/*', async (c, next) =>
  (c.req.method === 'GET' ? next()
    : rateLimiter({ maxRequests: 60, windowSeconds: 60, prefix: 'rl_inv_truth' })(c, next)));

/**
 * Cross-tenant and not-yet-adopted reads must be indistinguishable from
 * "no such thing" — a different status per case would leak existence.
 */
function readFailure(c: any, error: unknown) {
  if (error instanceof InventoryReadAuthorityError) {
    switch (error.code) {
      case 'LOT_NOT_FOUND':
        return c.json({ error: 'Không tìm thấy lô nguyên liệu này', code: 'NOT_FOUND' }, 404);
      case 'ADOPTION_REQUIRED':
        return c.json({
          error: 'Tủ lạnh này chưa bật lớp quản lý theo lô',
          code: 'INVENTORY_AUTHORITY_REQUIRED',
        }, 409);
      case 'READ_FORBIDDEN':
        return c.json({ error: 'Không có quyền truy cập', code: 'FORBIDDEN' }, 403);
      case 'INVALID_READ_QUERY':
        return c.json({ error: 'Tham số truy vấn không hợp lệ', code: 'VALIDATION_ERROR' }, 400);
      default:
        console.error('T13 inventory truth read failed:', error);
        return c.json({ error: 'Không thể đọc kho theo lô', code: 'DATABASE_ERROR' }, 500);
    }
  }
  if (error instanceof LotCommandError) {
    const failure = inventoryAuthorityFailure(error);
    return c.json({ error: error.message, code: failure.code }, failure.status);
  }
  console.error('T13 inventory truth read failed:', error);
  return c.json({ error: 'Không thể đọc kho theo lô', code: 'DATABASE_ERROR' }, 500);
}

const OBSERVATION_FAILURES: Record<string, { status: 400 | 403 | 404 | 409 | 422; code: string }> = {
  OBSERVATION_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  FORBIDDEN: { status: 403, code: 'FORBIDDEN' },
  OBSERVATION_NOT_OPEN: { status: 409, code: 'ALREADY_DECIDED' },
  OBSERVATION_VERSION_CONFLICT: { status: 409, code: 'CONFLICT' },
  OBSERVATION_STALE: { status: 409, code: 'STALE_SNAPSHOT' },
  OBSERVATION_NOT_ACTIONABLE: { status: 422, code: 'NOT_ACTIONABLE' },
  IDEMPOTENCY_CONFLICT: { status: 409, code: 'IDEMPOTENCY_CONFLICT' },
  INVALID_DECISION: { status: 400, code: 'VALIDATION_ERROR' },
  INVALID_OBSERVATION: { status: 400, code: 'VALIDATION_ERROR' },
  INVALID_LIMIT: { status: 400, code: 'VALIDATION_ERROR' },
  INVALID_STATUS_FILTER: { status: 400, code: 'VALIDATION_ERROR' },
  UNREPRESENTABLE_QUANTITY: { status: 422, code: 'VALIDATION_ERROR' },
};

function observationFailure(c: any, error: unknown) {
  if (error instanceof ObservationError) {
    const mapped = OBSERVATION_FAILURES[error.code];
    if (mapped) return c.json({ error: error.message, code: mapped.code }, mapped.status);
    console.error('T13 reconciliation failed:', error);
    return c.json({ error: 'Không thể xử lý đối chiếu kho', code: 'DATABASE_ERROR' }, 500);
  }
  return readFailure(c, error);
}

/** Lot detail DTO: enough truth for the user, no internal surface. */
export function lotDetailDto(item: InventoryReadItem, inventoryVersion: number) {
  return {
    id: item.legacyItemId ?? item.lotId,
    lotId: item.lotId,
    legacyItemId: item.legacyItemId,
    name: item.name,
    ingredientId: item.ingredientId,
    category: item.category,
    quantity: item.quantity,
    unit: item.unit,
    quantityMilli: item.quantityMilli,
    canonicalUnit: item.canonicalUnit,
    storage: item.storage,
    storageLocationId: item.storageLocationId,
    state: item.state,
    freshness: item.freshness,
    // Expiry truth, kept explicitly separable: a KNOWN date and an ESTIMATED
    // date are different facts and UNKNOWN is neither.
    expiryKind: item.expiryKind,
    expiryAt: item.expiryAt,
    estimatedExpiryAt: item.estimatedExpiryAt,
    openedAt: item.openedAt,
    purchasedAt: item.purchasedAt,
    // Provenance the user can understand; sourceId is the household's own
    // scan/receipt id, which the caller is already authorized to read.
    sourceType: item.sourceType,
    dataSource: provenanceDataSource(item.sourceType),
    sourceId: item.sourceId,
    lotVersion: item.version,
    version: item.legacyVersion ?? item.version,
    inventoryVersion,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function observationDto(observation: InventoryObservation) {
  return {
    observationId: observation.observationId,
    sourceType: observation.sourceType,
    sourceRef: observation.sourceRef,
    dataSource: provenanceDataSource(observation.sourceType),
    observedAt: observation.observedAt,
    recordedAt: observation.recordedAt,
    ingredientId: observation.ingredientId,
    rawName: observation.rawName,
    lotId: observation.lotId,
    legacyItemId: observation.legacyItemId,
    evidence: observation.evidence,
    note: observation.note,
    status: observation.status,
    version: observation.version,
    claim: observation.claim,
  };
}

// GET /api/v1/inventory/summary — T11 authority, never the projection.
inventoryTruthRoutes.get('/inventory/summary', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  try {
    // These routes describe canonical lot truth, which only exists for an
    // adopted household. A not-yet-adopted household gets the specific
    // recoverable code instead of an empty list that would look like
    // "your fridge is empty".
    if (await readInventoryAuthorityMode(db, auth.householdId) !== 'native') {
      return c.json({
        error: 'Tủ lạnh này chưa bật lớp quản lý theo lô',
        code: 'INVENTORY_AUTHORITY_REQUIRED',
      }, 409);
    }
    const summary = await readInventorySummary(db, { householdId: auth.householdId, actorId: auth.userId });
    return c.json({
      inventoryVersion: summary.inventoryVersion,
      activeCount: summary.activeCount,
      items: summary.items.map((item) => lotDetailDto(item, summary.inventoryVersion)),
    });
  } catch (error) {
    return readFailure(c, error);
  }
});

// GET /api/v1/inventory/lots/:lotId — canonical lot detail for Inventory UX V2.
inventoryTruthRoutes.get('/inventory/lots/:lotId', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const lotId = c.req.param('lotId');
  if (!db) return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  try {
    const scope = { householdId: auth.householdId, actorId: auth.userId };
    if (await readInventoryAuthorityMode(db, auth.householdId) !== 'native') {
      return c.json({
        error: 'Tủ lạnh này chưa bật lớp quản lý theo lô',
        code: 'INVENTORY_AUTHORITY_REQUIRED',
      }, 409);
    }
    // Accept either identity the UI legitimately holds: the authoritative lot
    // id or the legacy projection id it is mapped to. Both resolve through
    // T11, so a foreign id is simply not found.
    const item = await readInventoryLot(db, scope, { lotId })
      .catch(async (error) => {
        if (error instanceof InventoryReadAuthorityError && error.code === 'LOT_NOT_FOUND') {
          return readInventoryLot(db, scope, { legacyItemId: lotId });
        }
        throw error;
      });
    const summary = await readInventorySummary(db, scope);
    return c.json({ lot: lotDetailDto(item, summary.inventoryVersion) });
  } catch (error) {
    return readFailure(c, error);
  }
});

const ObservationQuery = z.object({
  status: z.enum(['OPEN', 'RECONCILED', 'STALE']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// GET /api/v1/inventory/observations — evidence + the deterministic T10 plan.
inventoryTruthRoutes.get('/inventory/observations', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  const parsed = ObservationQuery.safeParse({
    status: c.req.query('status') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
  });
  if (!parsed.success) {
    return c.json({ error: 'Tham số truy vấn không hợp lệ', code: 'VALIDATION_ERROR' }, 400);
  }
  try {
    const status = parsed.data.status ?? 'OPEN';
    const observations = await readInventoryObservations(db, auth.householdId,
      { status, limit: parsed.data.limit ?? 50 });
    // Findings come from the certified T10 planner; route code never derives
    // its own reconciliation verdict.
    const findings = observations.length === 0 ? []
      : await planInventoryReconciliationForHousehold(db, auth.householdId, observations);
    const byObservation = new Map(findings.map((finding) => [finding.observationId, finding]));
    return c.json({
      observations: observations.map((observation) => {
        const finding = byObservation.get(observation.observationId);
        return {
          ...observationDto(observation),
          verdict: finding?.verdict ?? null,
          reasons: finding?.reasons ?? [],
          matchedLotId: finding?.matchedLotId ?? null,
          // The exact proposals a confirmed decision would carry. The client
          // echoes them back as intent; the server re-derives and re-checks.
          proposals: finding?.proposals ?? [],
        };
      }),
    });
  } catch (error) {
    return observationFailure(c, error);
  }
});

// Longest identity the certified T10 constructor can produce, derived from it
// rather than restated, so this bound cannot drift away from the real shape.
const MAX_OBSERVATION_ID_LENGTH = observationIdentity(
  'h'.repeat(128), 'HEURISTIC', 's'.repeat(MAX_OBSERVATION_SOURCE_REF)).length;

const DecisionBody = z.object({
  decisionKey: z.string().trim().min(1).max(160),
  // A T10 observation id is `t10-observation:<household>:<type>:<sourceRef>`,
  // so it is legitimately longer than a bare source ref. Bounding it at
  // MAX_OBSERVATION_SOURCE_REF made every receipt-derived observation
  // undecidable; the bound is derived from the identity shape instead.
  observationId: z.string().trim().min(1).max(MAX_OBSERVATION_ID_LENGTH),
  expectedObservationVersion: z.coerce.number().int().positive(),
  decisionType: z.enum(['CORRECT', 'MOVE', 'DISMISS']),
  proposals: z.array(z.record(z.string(), z.unknown())).max(2).optional(),
}).strict();

// POST /api/v1/inventory/observations/:observationId/decision
// Accept (CORRECT/MOVE) or dismiss. Composes the certified T10 decision
// executor, which composes T09 commands in one atomic batch.
inventoryTruthRoutes.post('/inventory/observations/:observationId/decision', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const observationId = c.req.param('observationId');
  if (!db) return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = DecisionBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message || 'Dữ liệu quyết định không hợp lệ', code: 'VALIDATION_ERROR' }, 400);
  }
  // The path identifies the observation; a body that disagrees is a
  // client bug or an attempt to decide a different resource.
  if (parsed.data.observationId !== observationId) {
    return c.json({ error: 'Định danh bằng chứng không khớp', code: 'VALIDATION_ERROR' }, 400);
  }
  if (await readInventoryAuthorityMode(db, auth.householdId) !== 'native') {
    return c.json({
      error: 'Tủ lạnh này chưa bật lớp quản lý theo lô',
      code: 'INVENTORY_AUTHORITY_REQUIRED',
    }, 409);
  }
  try {
    const execution = await confirmReconciliationDecision(db,
      { householdId: auth.householdId, actorId: auth.userId },
      {
        decisionKey: parsed.data.decisionKey,
        observationId,
        expectedObservationVersion: parsed.data.expectedObservationVersion,
        decisionType: parsed.data.decisionType,
        proposals: parsed.data.proposals as any,
      },
      new Date().toISOString());
    if (c.env.CACHE) await c.env.CACHE.delete(`inv_${auth.householdId}`).catch(() => {});
    return c.json({
      success: true,
      ...(execution.replayed ? { idempotentReplay: true } : {}),
      decision: {
        decisionId: execution.decisionId,
        decisionType: execution.decisionType,
        observationId: execution.observationId,
        observationVersion: execution.observationVersion,
        appliedCommandCount: execution.executions.length,
      },
    }, execution.replayed ? 200 : 201);
  } catch (error) {
    return observationFailure(c, error);
  }
});
