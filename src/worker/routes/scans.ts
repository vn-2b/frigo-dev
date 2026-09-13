import { Context, Hono } from 'hono';
import { InventoryWriterAuthorityError, InventoryWriterSnapshotError, readInventoryAuthorityMode, readLegacyInventoryRevision, runLegacyInventoryBatch } from '../../../packages/db/src/inventory-writer-fence';
import { composeInventoryLotCommands, readAdoptedLotSnapshot, type LotCommandSpec } from '../../../packages/db/src/inventory-lot-commands';
import { LotCommandError } from '../../../packages/domain/src/inventory-lot-commands';
import { inventoryAuthorityFailure } from '../utils/inventory-authority';
import {
  lotExpiryFromEvidence, rawScanEvidence, receiptLineFacts, scanProvenance,
  type ExpiryBasis, type ScanProvenanceType,
} from '../utils/scan-evidence';
import { buildInventoryObservation, guardedObservationInsertStatement } from '../../../packages/db/src/inventory-observations';
import { ObservationError } from '../../../packages/domain/src/inventory-observations';
import { Env, AuthContext } from '../types';
import { AIRouter } from '@frigo/ai';
import { SQL } from '@frigo/db';
import {
  areUnitsCompatible,
  computeFreshness,
  convertUnit,
  findCanonicalIngredient,
  StandardUnit,
} from '@frigo/domain';
import { tenancyGuard } from '../middleware/tenancy';
import { rateLimiter } from '../middleware/rate-limit';
import { ScanConfirmSchema } from '../validation/schemas';
import { fetchHouseholdInventoryFromDb } from './inventory';
import { reserveScanQuota, finalizeScanQuota } from '../services/scan-quota';
import { sha256Hex } from '../utils/session';

export const scanRoutes = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

// scan_items.confidence is NOT NULL with a historical 0.9 default, so it
// cannot represent "the provider reported no confidence". T13 keeps writing it
// for legacy readers but treats ocr_confidence (nullable) as the truth.
const LEGACY_CONFIDENCE_FILLER = 0.9;

// T09 bounds a lot-command client key at 200 characters. A receipt scan id is
// itself a 64-char digest and the generated lot id embeds it, so the composed
// key `scan-confirm:<scanId>:<lotId>:<suffix>` overflowed that bound and the
// authority rejected the whole confirmation with INVALID_COMMAND. The key must
// stay DETERMINISTIC (replay identity depends on it), so an over-long key is
// collapsed into a stable digest of itself rather than truncated — truncation
// could make two different lots share one key and therefore one command.
const MAX_LOT_CLIENT_KEY = 200;

async function scanCommandKey(scanId: string, itemId: string, suffix: 'create' | 'correct'): Promise<string> {
  const key = `scan-confirm:${scanId}:${itemId}:${suffix}`;
  if (key.length <= MAX_LOT_CLIENT_KEY) return key;
  const digest = await sha256Hex(key);
  return `scan-confirm:${digest}:${suffix}`;
}

// Observation source refs are bounded at 200 characters by the T10 contract
// and carry observation identity, so they are collapsed the same way: a stable
// digest instead of a truncation that could collide two different lines.
const MAX_OBSERVATION_SOURCE_REF = 200;

export async function scanObservationSourceRef(scanId: string, lineId: string): Promise<string> {
  const ref = `${scanId}:${lineId}`;
  if (ref.length <= MAX_OBSERVATION_SOURCE_REF) return ref;
  return `${scanId.slice(0, 80)}:${await sha256Hex(ref)}`;
}

// Adopted-household scan confirmation: one atomic batch of canonical lot
// commands plus the reviewed draft writes, the T10 evidence observations and
// the completion-last status flip. Receipts are keyed per scan item so a
// response-loss retry replays the same confirmation identity instead of
// double-adding stock.
//
// T13 authority chain: OCR/vision evidence -> user review -> T10 observation
// -> T09 command -> lots. The observation is evidence, never a second writer:
// it is a plain INSERT into inventory_observations guarded by the same READY
// predicate as every other statement in the batch, so evidence and stock
// commit together or not at all.
async function confirmAdoptedScan(c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>, db: any,
  kv: any, auth: AuthContext, scanId: string, plan: {
    selectedIds: string[];
    batchStatements: any[];
    updates: Map<string, { id: string; quantityDelta: number; unit: string }>;
    inserts: Array<{ id: string; quantity: number; unit: string; expiryDate: string; ingredientId: string | null; name: string; storage: string; expiryBasis: ExpiryBasis; lineIds: string[] }>;
    provenance: ScanProvenanceType;
    purchase: { purchasedAt: string | null; purchasePriceFor: (lineIds: string[]) => { currency: 'VND'; amountMinor: number; minorDigits: 0 } | null };
    observations: Array<{ sourceRef: string; ingredientId: string | null; rawName: string | null;
      legacyItemId: string | null; quantity: number; unit: string; storage: 'fridge' | 'freezer' | 'pantry';
      expiryDate: string | null; expiryBasis: ExpiryBasis; note: string | null }>;
    readyGuard: { sql: string; bindings: unknown[] };
  }) {
  const scope = { householdId: auth.householdId, actorId: auth.userId };
  try {
    const snapshot = await readAdoptedLotSnapshot(db, scope);
    const now = new Date().toISOString();
    const specs: LotCommandSpec[] = [];
    for (const update of plan.updates.values()) {
      const mapped = snapshot.lots.find((entry) => entry.legacyItemId === update.id);
      const row = snapshot.legacyRows.find((candidate) => candidate.id === update.id);
      if (!mapped || !row) throw new LotCommandError('ADOPTION_REQUIRED');
      specs.push({
        clientKey: await scanCommandKey(scanId, update.id, 'correct'),
        input: {
          type: 'CORRECT', lotId: mapped.lot.id, expectedVersion: mapped.lot.version,
          changes: { quantity: Number(row.quantity) + update.quantityDelta, unit: update.unit },
          reason: 'Xác nhận từ nhận diện thông minh',
          revive: mapped.lot.state !== 'ACTIVE',
        },
      });
    }
    for (const insert of plan.inserts) {
      const location = snapshot.locations.find((entry) => entry.isDefault
        && entry.type.toLowerCase() === insert.storage);
      if (!location) throw new LotCommandError('DRIFT_DETECTED');
      // Expiry truth: a user-supplied date is KNOWN; an inferred shelf-life
      // date is ESTIMATED; no basis is UNKNOWN. Never silently upgraded.
      const expiry = lotExpiryFromEvidence(insert.expiryDate, insert.expiryBasis);
      specs.push({
        clientKey: await scanCommandKey(scanId, insert.id, 'create'),
        input: {
          type: 'CREATE', lotId: insert.id, ingredientId: insert.ingredientId, rawName: insert.name,
          quantity: insert.quantity, unit: insert.unit, storageLocationId: location.id,
          expiryAt: expiry.expiryAt, estimatedExpiryAt: expiry.estimatedExpiryAt,
          expiryKind: expiry.expiryKind,
          // Real receipt facts only; absent facts stay null rather than
          // becoming 0₫ or "purchased today".
          purchasedAt: plan.purchase.purchasedAt, openedAt: null,
          purchasePrice: plan.purchase.purchasePriceFor(insert.lineIds),
          // Authoritative server-side provenance: receipts are RECEIPT, fridge
          // photos are SCAN. Never inferred from client-supplied text.
          sourceType: plan.provenance, sourceId: scanId,
        },
      });
    }
    const composed = await composeInventoryLotCommands(db, scope, specs, now);
    const observationStatements = plan.observations.map((observation) => {
      const expiry = lotExpiryFromEvidence(observation.expiryDate, observation.expiryBasis);
      const expiryClaim = expiry.expiryKind === 'KNOWN'
        ? { expiryDate: expiry.expiryAt, expiryKind: 'KNOWN' as const }
        : expiry.expiryKind === 'ESTIMATED'
          ? { expiryDate: expiry.estimatedExpiryAt, expiryKind: 'ESTIMATED' as const }
          : { expiryDate: null, expiryKind: null };
      const built = buildInventoryObservation(scope, {
        sourceType: plan.provenance,
        sourceRef: observation.sourceRef,
        observedAt: now,
        ingredientId: observation.ingredientId,
        rawName: observation.rawName,
        lotId: null,
        legacyItemId: observation.legacyItemId,
        // The user reviewed and confirmed these values in the review UI; an
        // inferred expiry keeps the claim ESTIMATED instead.
        evidence: expiry.expiryKind === 'ESTIMATED' ? 'ESTIMATED' : 'CONFIRMED',
        note: observation.note,
        claim: {
          quantity: observation.quantity, unit: observation.unit as any,
          quantityMilli: null, canonicalUnit: null,
          storage: observation.storage, openedAt: null, ...expiryClaim,
        },
      }, snapshot.inventoryVersion, now);
      return guardedObservationInsertStatement(db, built, plan.readyGuard.sql, plan.readyGuard.bindings);
    });
    const statusStatement = db
      .prepare(
        `UPDATE scans SET status = 'confirmed', updated_at = datetime('now')
         WHERE id = ? AND household_id = ? AND status = 'ready'`
      )
      .bind(scanId, auth.householdId);
    const results = await db.batch([...composed.statements, ...plan.batchStatements,
      ...observationStatements, statusStatement]);
    const statusResult = results[results.length - 1] as any;
    if (statusResult?.meta?.changes !== 1) {
      const committed = await db
        .prepare('SELECT status FROM scans WHERE id = ? AND household_id = ?')
        .bind(scanId, auth.householdId)
        .first();
      if ((committed as any)?.status === 'confirmed') {
        const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true, actorId: auth.userId });
        return c.json({
          success: true, idempotentReplay: true, message: 'Bản quét này đã được xác nhận trước đó',
          inventoryCount: updatedList.length, items: updatedList,
        });
      }
      throw new Error('Scan confirmation state transition did not commit');
    }
    if (kv) await kv.delete(`inv_${auth.householdId}`).catch(() => {});
    const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true, actorId: auth.userId });
    return c.json({
      success: true, message: 'Đã cập nhật nguyên liệu vào tủ lạnh thành công',
      inventoryCount: updatedList.length, items: updatedList, confirmedItemIds: plan.selectedIds,
    });
  } catch (error: any) {
    if (error instanceof LotCommandError) {
      const failure = inventoryAuthorityFailure(error);
      return c.json({ error: error.message, code: failure.code }, failure.status);
    }
    if (error instanceof ObservationError) {
      // Evidence that cannot be represented must not silently vanish while the
      // stock command commits; the whole confirmation fails closed instead.
      return c.json({ error: 'Không thể ghi nhận bằng chứng từ bản quét', code: 'INVALID_OBSERVATION' }, 422);
    }
    console.error('Adopted scan confirmation failed:', error);
    return c.json({ error: 'Lỗi xác nhận đưa nguyên liệu vào tủ lạnh', code: 'DATABASE_ERROR' }, 500);
  }
}

function assertBatchSucceeded(results: any[] | undefined): void {
  if (results?.some((result) => result && result.success === false)) {
    throw new Error('D1 batch reported an unsuccessful statement');
  }
}

const STANDARD_UNITS = new Set<StandardUnit>([
  'g',
  'kg',
  'ml',
  'l',
  'piece',
  'pack',
  'bunch',
  'slice',
]);

function isStandardUnit(value: unknown): value is StandardUnit {
  return typeof value === 'string' && STANDARD_UNITS.has(value as StandardUnit);
}

/** Error raised while reconciling client review data with persisted scan rows. */
export class ScanConfirmationError extends Error {
  constructor(
    readonly code: 'INVALID_SCAN_ITEM' | 'DUPLICATE_SCAN_ITEM' | 'UNIT_MISMATCH' | 'INVALID_QUANTITY',
    message: string,
    readonly status = code === 'UNIT_MISMATCH' ? 422 : 400
  ) {
    super(message);
    this.name = 'ScanConfirmationError';
  }
}

export interface PersistedScanItem {
  id: string;
  raw_name: string;
  canonical_id?: string | null;
  estimated_quantity: number;
  unit: string;
  category?: string | null;
  storage?: string | null;
  is_confirmed?: number | boolean | null;
  unit_price_vnd?: number | null;
  total_price_vnd?: number | null;
}

export interface ResolvedScanItem {
  /** ID of the persisted prediction; undefined for a user-added row. */
  sourceId?: string;
  /** Stable client ID for a manual row, when supplied. */
  clientId?: string;
  name: string;
  quantity: number;
  unit: StandardUnit;
  canonicalId: string | null;
  category: string;
  storage: 'fridge' | 'freezer' | 'pantry';
  expiryDate?: string;
  /** How the confirmed expiry was established; decides KNOWN vs ESTIMATED. */
  expiryBasis: ExpiryBasis;
  /** The reviewer explicitly rejected this line; it must not become stock. */
  rejected: boolean;
  isManual: boolean;
}

/**
 * Convert a reviewed scan quantity into the unit used by an existing stock
 * row.  Returning the original number for incompatible units would silently
 * corrupt inventory (for example, treating 500g as 500 pieces), so this
 * helper fails closed instead.
 */
export function convertScanQuantity(quantity: number, from: StandardUnit, to: StandardUnit): number {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ScanConfirmationError('INVALID_QUANTITY', 'Số lượng nguyên liệu không hợp lệ');
  }
  if (!areUnitsCompatible(from, to)) {
    throw new ScanConfirmationError(
      'UNIT_MISMATCH',
      `Không thể quy đổi đơn vị ${from} sang ${to}`
    );
  }
  const converted = convertUnit(quantity, from, to);
  if (!Number.isFinite(converted) || converted <= 0) {
    throw new ScanConfirmationError('INVALID_QUANTITY', 'Số lượng nguyên liệu không hợp lệ');
  }
  return converted;
}

function normalizeStorage(value: unknown): 'fridge' | 'freezer' | 'pantry' {
  return value === 'freezer' || value === 'pantry' ? value : 'fridge';
}

/**
 * Hydrate a confirmation payload against the scan snapshot.  AI rows must use
 * an ID belonging to this scan; only explicit draft IDs (or rows without an
 * ID) are treated as manual additions.  This prevents a caller from smuggling
 * arbitrary scan IDs into another scan while retaining the review UI's
 * add-manual-item affordance.
 */
export function resolveScanConfirmationItems(
  persistedItems: readonly PersistedScanItem[],
  submittedItems: readonly any[]
): ResolvedScanItem[] {
  const byId = new Map(persistedItems.map((item) => [item.id, item]));
  const seenIds = new Set<string>();

  return submittedItems.map((submitted, index) => {
    const submittedId = typeof submitted?.id === 'string' ? submitted.id.trim() : '';
    if (submittedId && seenIds.has(submittedId)) {
      throw new ScanConfirmationError(
        'DUPLICATE_SCAN_ITEM',
        `Nguyên liệu bị lặp trong yêu cầu xác nhận: ${submittedId}`
      );
    }
    if (submittedId) seenIds.add(submittedId);

    const persisted = submittedId ? byId.get(submittedId) : undefined;
    const isManual = !persisted;
    if (submittedId && !persisted && !submittedId.startsWith('draft_')) {
      throw new ScanConfirmationError(
        'INVALID_SCAN_ITEM',
        'Nguyên liệu xác nhận không thuộc bản quét này'
      );
    }
    const alreadyConfirmed =
      persisted?.is_confirmed === true || Number(persisted?.is_confirmed) === 1;
    if (alreadyConfirmed) {
      throw new ScanConfirmationError(
        'INVALID_SCAN_ITEM',
        'Nguyên liệu trong bản quét đã được xác nhận trước đó',
        409
      );
    }

    const name = String(
      submitted?.rawName ?? submitted?.name ?? persisted?.raw_name ?? ''
    ).trim();
    if (!name) {
      throw new ScanConfirmationError('INVALID_SCAN_ITEM', `Nguyên liệu thứ ${index + 1} cần có tên`);
    }

    const canonicalFromName = findCanonicalIngredient(name);
    const canonicalFromPayload = submitted?.canonicalId
      ? findCanonicalIngredient(String(submitted.canonicalId))
      : null;
    const canonicalFromScan = persisted?.canonical_id
      ? findCanonicalIngredient(String(persisted.canonical_id))
      : null;
    // A user-edited name is authoritative; otherwise retain the scan's
    // canonical mapping, then accept a valid explicit canonicalId.
    const canonical = canonicalFromName || canonicalFromScan || canonicalFromPayload;

    const rawQuantity = submitted?.estimatedQuantity ?? submitted?.quantity ?? persisted?.estimated_quantity ?? 1;
    const quantity = Number(rawQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ScanConfirmationError('INVALID_QUANTITY', `Số lượng của ${name} không hợp lệ`);
    }

    const candidateUnit = submitted?.unit ?? persisted?.unit ?? canonical?.defaultUnit ?? 'piece';
    if (!isStandardUnit(candidateUnit)) {
      throw new ScanConfirmationError('INVALID_SCAN_ITEM', `Đơn vị của ${name} không hợp lệ`);
    }

    const category = String(
      submitted?.category ?? persisted?.category ?? canonical?.category ?? 'other'
    ).trim() || 'other';

    return {
      sourceId: persisted?.id,
      clientId: submittedId || undefined,
      name,
      quantity,
      unit: candidateUnit,
      canonicalId: canonical?.id || null,
      category,
      storage: normalizeStorage(submitted?.storage ?? persisted?.storage),
      expiryDate: submitted?.expiryDate,
      // A date the reviewer picked is a supplied fact; a day-chip estimate is
      // explicitly flagged by the client and stays ESTIMATED. Absence is
      // absence — the caller never turns it into a KNOWN date.
      expiryBasis: submitted?.expiryDate
        ? (submitted?.expiryEstimated === true ? 'inferred' : 'supplied')
        : 'absent',
      rejected: submitted?.rejected === true,
      isManual,
    };
  });
}

function hashScanPart(value: string): string {
  // Small deterministic hash keeps generated D1 IDs stable across retries
  // without embedding user-controlled names or relying on random IDs.
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableScanPart(item: ResolvedScanItem, index: number): string {
  const source = item.sourceId || item.clientId;
  if (source) {
    const safe = source.replace(/[^A-Za-z0-9_-]/g, '_');
    // Truncation must not destroy identity. A real receipt scan id is a
    // 64-char digest, so `receipt_item_<scanId>_<n>` exceeds 80 characters and
    // every line of one receipt used to truncate to the SAME id — the lots
    // then collided and the confirmation failed with LOT_EXISTS. Keep a
    // deterministic, collision-resistant suffix instead of a blind prefix.
    if (safe.length <= 80) return safe;
    return `${safe.slice(0, 60)}_${hashScanPart(safe)}`;
  }
  return `manual_${index}_${hashScanPart(`${item.name}|${item.quantity}|${item.unit}`)}`;
}

/**
 * Review DTO for one scan line. Surfaces what is actually known: the retained
 * raw extraction, the model's own confidence (null when it reported none — the
 * UI must show "unknown", never a fabricated high score), and the explicit
 * review lifecycle including rejection.
 */
export function scanItemDto(row: any, scanId: string) {
  const raw = rawScanEvidence(row);
  const reviewState = row.review_state === 'CONFIRMED' || row.review_state === 'REJECTED'
    ? row.review_state : 'PENDING';
  return {
    id: row.id,
    scanId: row.scan_id ?? scanId,
    rawName: row.raw_name,
    canonicalId: row.canonical_id,
    estimatedQuantity: row.estimated_quantity,
    unit: row.unit,
    // Truthful confidence: undefined when the provider reported none.
    confidence: row.ocr_confidence == null ? undefined : Number(row.ocr_confidence),
    category: row.category,
    storage: row.storage,
    isConfirmed: Boolean(row.is_confirmed),
    reviewState,
    unitPriceVnd: row.unit_price_vnd == null ? undefined : Number(row.unit_price_vnd),
    totalPriceVnd: row.total_price_vnd == null ? undefined : Number(row.total_price_vnd),
    // Raw extraction kept separable from the confirmed value so a correction
    // can still be explained after the fact.
    rawEvidence: raw.rawName === null && raw.quantity === null && raw.unit === null ? undefined : {
      rawName: raw.rawName ?? undefined,
      estimatedQuantity: raw.quantity ?? undefined,
      unit: raw.unit ?? undefined,
    },
  };
}

// Enforce multi-tenancy on all scan routes
scanRoutes.use('/scans*', tenancyGuard);

// Rate limit AI vision operations (max 12 per minute)
scanRoutes.use('/scans/fridge', rateLimiter({ maxRequests: 12, windowSeconds: 60, prefix: 'rl_scan' }));
scanRoutes.use('/scans/receipt', rateLimiter({ maxRequests: 12, windowSeconds: 60, prefix: 'rl_receipt' }));

// Helper to init AI Router with Cloudflare Workers AI GPU binding
function getAIRouter(env: Env) {
  return new AIRouter({
    aiMockMode: env.AI_MOCK_MODE === 'true',
    aiBinding: env.AI,
    qwenApiKey: env.QWEN_API_KEY,
    qwenBaseUrl: env.QWEN_BASE_URL,
    groqApiKey: env.GROQ_API_KEY,
    groqBaseUrl: env.GROQ_BASE_URL,
    groqVisionModel: env.GROQ_VISION_MODEL,
    zaiApiKey: env.ZAI_API_KEY,
    zaiBaseUrl: env.ZAI_BASE_URL,
    deepseekApiKey: env.DEEPSEEK_API_KEY,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL,
  });
}

// Helper: validate base64 size (max 5MB)
function validateBase64Payload(base64: string): { valid: boolean; error?: string } {
  if (!base64) return { valid: true };
  // Approximate size in bytes: length * (3/4)
  const estimatedBytes = (base64.length * 3) / 4;
  if (estimatedBytes > 5 * 1024 * 1024) {
    return { valid: false, error: 'Dung lượng ảnh vượt quá giới hạn cho phép (tối đa 5MB)' };
  }
  return { valid: true };
}

function imageMimeType(base64: string): string {
  return base64.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,/)?.[1] || 'image/jpeg';
}

async function scanCommand(c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>, scanType: string) {
  const key = c.req.header('Idempotency-Key');
  if (key !== undefined && !/^[A-Za-z0-9:_-]{1,128}$/.test(key)) return null;
  const auth = c.get('auth');
  const digest = key ? await sha256Hex(JSON.stringify([auth.userId, auth.householdId, key])) : crypto.randomUUID();
  const scanId = `${scanType === 'receipt' ? 'receipt' : 'scan'}_${digest}`;
  return { scanId, idempotencyKey: key ? `scan-command:${digest}` : `scan:${scanId}:v1` };
}

async function recoverScan(c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>,
  scanId: string, scanType: string, idempotencyKey: string, reservationId: string, imageBase64: string) {
  const auth = c.get('auth');
  const row: any = await c.env.DB.prepare('SELECT * FROM scans WHERE id = ? AND user_id = ? AND household_id = ?')
    .bind(scanId, auth.userId, auth.householdId).first();
  if (row && row.scan_type !== scanType) {
    return c.json({ error: 'Idempotency key đã được sử dụng', code: 'IDEMPOTENCY_CONFLICT' }, 409);
  }
  // A send may have reached the queue even when its response was lost.
  // Redelivery uses the same job; the queue claim fences duplicate processing.
  if (row?.status === 'pending' && c.env.SCAN_QUEUE_MODE === 'async' && c.env.SCAN_QUEUE) {
    await c.env.SCAN_QUEUE.send({
      type: 'scan.process.v1', jobId: `scan_job_${scanId}`, scanId,
      userId: auth.userId, householdId: auth.householdId, scanType,
      imageKey: c.env.IMAGES ? row.image_key : undefined,
      imageBase64: c.env.IMAGES ? undefined : imageBase64,
      mimeType: imageMimeType(imageBase64), idempotencyKey,
    });
    await finalizeScanQuota(c.env.DB, reservationId, 'consumed');
  }
  const items = row ? await c.env.DB.prepare(SQL.GET_SCAN_ITEMS).bind(scanId).all() : { results: [] };
  const scan = {
    id: scanId, userId: auth.userId, householdId: auth.householdId,
    scanType, status: row?.status || 'pending', imageKey: row?.image_key,
    createdAt: row?.created_at,
    merchantName: row?.merchant_name, invoiceNumber: row?.invoice_number,
    purchaseDate: row?.purchase_date, totalAmountVnd: row?.total_amount_vnd,
    items: (items.results || []).map((item: any) => scanItemDto(item, scanId)),
  };
  return c.json({ success: true, idempotentReplay: true, scan, ...(scanType === 'receipt' ? { receipt: scan } : {}) },
    ['pending', 'processing'].includes(scan.status) ? 202 : 200);
}

// POST /api/v1/scans/fridge
scanRoutes.post('/scans/fridge', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const imageBase64 = body.imageBase64 || '';
  const scanType = body.scanType || 'fridge';

  if (scanType !== 'fridge' && scanType !== 'food') {
    return c.json({ error: 'Loại bản quét không hợp lệ', code: 'INVALID_SCAN_TYPE' }, 400);
  }

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  // SEC-08 FIX: Check payload size limit
  const sizeCheck = validateBase64Payload(imageBase64);
  if (!sizeCheck.valid) {
    return c.json({ error: sizeCheck.error, code: 'PAYLOAD_TOO_LARGE' }, 413);
  }

  const command = await scanCommand(c, scanType);
  if (!command) return c.json({ error: 'Invalid idempotency key', code: 'INVALID_IDEMPOTENCY_KEY' }, 400);
  const { scanId, idempotencyKey } = command;
  const quota = await reserveScanQuota(db, { userId: auth.userId, householdId: auth.householdId, scanId, idempotencyKey });
  if (!quota.ok) {
    const status = quota.reason === 'exceeded' ? 429 : quota.reason === 'conflict' ? 409 : 503;
    return c.json({ error: quota.reason === 'exceeded' ? 'Đã vượt hạn mức quét trong tháng' : quota.reason === 'conflict' ? 'Idempotency key đã được sử dụng cho bản quét khác' : 'Không thể kiểm tra hạn mức quét', code: quota.reason === 'exceeded' ? 'SCAN_QUOTA_EXCEEDED' : quota.reason === 'conflict' ? 'IDEMPOTENCY_CONFLICT' : 'QUOTA_UNAVAILABLE' }, status);
  }
  const reservationId = quota.reservation.reservationId;
  if (!quota.acquired) return recoverScan(c, scanId, scanType, idempotencyKey, reservationId, imageBase64);
  const imageKey = `users/${auth.userId}/scans/${scanId}/original.webp`;
  const mimeType = imageMimeType(imageBase64);
  let imageStored = false;

  // R2 upload if configured
  if (c.env.IMAGES && imageBase64) {
    try {
      const buffer = Uint8Array.from(atob(imageBase64.replace(/^data:image\/\w+;base64,/, '')), (ch) =>
        ch.charCodeAt(0)
      );
      await c.env.IMAGES.put(imageKey, buffer, {
        httpMetadata: { contentType: mimeType },
      });
      imageStored = true;
    } catch (err) {
      console.warn('R2 upload failed:', err);
    }
  }

  // Optional async canary: persist a pending scan and let the durable queue
  // perform vision processing. The default remains synchronous to preserve the
  // existing client response contract until the canary is explicitly enabled.
  if (c.env.SCAN_QUEUE_MODE === 'async' && c.env.SCAN_QUEUE) {
    if (!imageBase64) {
      await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Scan queue requires an image payload', code: 'IMAGE_UNAVAILABLE' }, 400);
    }
    if (c.env.IMAGES && !imageStored) {
      await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Không thể lưu ảnh để xử lý nền', code: 'IMAGE_STORAGE_FAILED' }, 503);
    }
    // Cloudflare Queue messages are intentionally kept small; production has
    // R2 configured, while local canary environments may not. Avoid enqueueing
    // a multi-megabyte base64 body that would be rejected by the platform.
    if (!c.env.IMAGES && imageBase64.length > 120_000) {
      await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Môi trường xử lý nền cần R2 để lưu ảnh lớn', code: 'QUEUE_PAYLOAD_TOO_LARGE' }, 413);
    }
    let enqueueAttempted = false;
    try {
      const statements = [
        db.prepare('INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)')
          .bind(auth.householdId, 'Tủ lạnh gia đình', auth.userId),
        db.prepare(SQL.CREATE_SCAN)
          .bind(scanId, auth.userId, auth.householdId, imageKey, 'pending', scanType),
      ];
      const results = await db.batch(statements);
      assertBatchSucceeded(results);
      enqueueAttempted = true;
      await c.env.SCAN_QUEUE.send({
        type: 'scan.process.v1',
        jobId: `scan_job_${scanId}`,
        scanId,
        userId: auth.userId,
        householdId: auth.householdId,
        scanType: scanType === 'food' ? 'food' : 'fridge',
        imageKey: c.env.IMAGES ? imageKey : undefined,
        imageBase64: c.env.IMAGES ? undefined : imageBase64,
        mimeType,
        idempotencyKey,
      });
      await finalizeScanQuota(db, reservationId, 'consumed');
      return c.json({
        success: true,
        queued: true,
        scan: { id: scanId, userId: auth.userId, householdId: auth.householdId, imageKey, scanType, status: 'pending', items: [], createdAt: new Date().toISOString() },
      }, 202);
    } catch (err) {
      console.error('Scan queue enqueue failed:', err);
      if (!enqueueAttempted) await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Không thể xếp hàng bản quét', code: 'QUEUE_UNAVAILABLE' }, 503);
    }
  }

  // Call Real Vision AI (B4: 25s timeout — Workers free tier CPU limit is 30s;
  // without a timeout a hung AI call blocks the request until platform kill)
  const aiRouter = getAIRouter(c.env);
  let visionResult;
  try {
    visionResult = await Promise.race([
      aiRouter.vision({ imageBase64OrUrl: imageBase64 || 'mock-image', mimeType }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI_SCAN_TIMEOUT: Phân tích ảnh quá lâu. Vui lòng thử lại.')), 25000)
      ),
    ]);
  } catch (error) {
    await finalizeScanQuota(db, reservationId, 'released');
    throw error;
  }

  const scanItems = visionResult.items.map((item, idx) => {
    const canonical = findCanonicalIngredient(item.raw_name);
    const providerCanonical = item.canonical_id
      ? findCanonicalIngredient(item.canonical_id)
      : null;
    return {
      id: `scan_item_${scanId}_${idx}`,
      scanId,
      rawName: item.raw_name,
      canonicalId: canonical?.id || providerCanonical?.id || null,
      estimatedQuantity: item.estimated_quantity,
      unit: item.unit as StandardUnit,
      confidence: item.confidence,
      category: canonical?.category || item.category || 'other',
      storage: (item.storage || 'fridge') as 'fridge' | 'freezer' | 'pantry',
    };
  });

  const scanRecord = {
    id: scanId,
    userId: auth.userId,
    householdId: auth.householdId,
    imageKey,
    scanType,
    status: 'ready',
    items: scanItems,
    createdAt: new Date().toISOString(),
  };

  // Persist to D1 with batch operations
  try {
    const statements = [
      db
        .prepare('INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)')
        .bind(auth.householdId, 'Tủ lạnh gia đình', auth.userId),
      db
        .prepare(SQL.CREATE_SCAN)
        .bind(scanId, auth.userId, auth.householdId, imageKey, 'ready', scanType),
    ];

    for (const item of scanItems) {
      statements.push(
        db
          .prepare(SQL.INSERT_SCAN_ITEM)
          .bind(
            item.id,
            scanId,
            item.rawName,
            item.canonicalId,
            item.estimatedQuantity,
            item.unit,
            // The legacy NOT NULL column keeps its historical filler; the
            // ocr_* columns carry what the model actually reported.
            item.confidence ?? LEGACY_CONFIDENCE_FILLER,
            item.category,
            item.storage,
            item.rawName,
            item.estimatedQuantity,
            item.unit,
            item.confidence ?? null
          )
      );
    }

    const batchResults = await db.batch(statements);
    assertBatchSucceeded(batchResults);
  } catch (err) {
    console.error('D1 CREATE_SCAN batch failed:', err);
    await finalizeScanQuota(db, reservationId, 'released');
    return c.json({ error: 'Không thể lưu kết quả quét', code: 'DATABASE_ERROR' }, 500);
  }

  await finalizeScanQuota(db, reservationId, 'consumed');

  return c.json({
    success: true,
    scan: scanRecord,
  });
});

// POST /api/v1/scans/receipt
scanRoutes.post('/scans/receipt', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const imageBase64 = body.imageBase64 || '';

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  // SEC-08 FIX: Check payload size limit
  const sizeCheck = validateBase64Payload(imageBase64);
  if (!sizeCheck.valid) {
    return c.json({ error: sizeCheck.error, code: 'PAYLOAD_TOO_LARGE' }, 413);
  }

  const command = await scanCommand(c, 'receipt');
  if (!command) return c.json({ error: 'Invalid idempotency key', code: 'INVALID_IDEMPOTENCY_KEY' }, 400);
  const { scanId, idempotencyKey } = command;
  const quota = await reserveScanQuota(db, { userId: auth.userId, householdId: auth.householdId, scanId, idempotencyKey });
  if (!quota.ok) {
    const status = quota.reason === 'exceeded' ? 429 : quota.reason === 'conflict' ? 409 : 503;
    return c.json({ error: quota.reason === 'exceeded' ? 'Đã vượt hạn mức quét trong tháng' : quota.reason === 'conflict' ? 'Idempotency key đã được sử dụng cho bản quét khác' : 'Không thể kiểm tra hạn mức quét', code: quota.reason === 'exceeded' ? 'SCAN_QUOTA_EXCEEDED' : quota.reason === 'conflict' ? 'IDEMPOTENCY_CONFLICT' : 'QUOTA_UNAVAILABLE' }, status);
  }
  const reservationId = quota.reservation.reservationId;
  if (!quota.acquired) return recoverScan(c, scanId, 'receipt', idempotencyKey, reservationId, imageBase64);
  const imageKey = `users/${auth.userId}/scans/${scanId}/original.webp`;
  const mimeType = imageMimeType(imageBase64);
  let imageStored = false;

  if (c.env.IMAGES && imageBase64) {
    try {
      const buffer = Uint8Array.from(atob(imageBase64.replace(/^data:image\/\w+;base64,/, '')), (ch) =>
        ch.charCodeAt(0)
      );
      await c.env.IMAGES.put(imageKey, buffer, {
        httpMetadata: { contentType: mimeType },
      });
      imageStored = true;
    } catch (err) {
      console.warn('R2 receipt upload failed:', err);
    }
  }

  if (c.env.SCAN_QUEUE_MODE === 'async' && c.env.SCAN_QUEUE) {
    if (!imageBase64) {
      await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Scan queue requires an image payload', code: 'IMAGE_UNAVAILABLE' }, 400);
    }
    if (c.env.IMAGES && !imageStored) {
      await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Không thể lưu ảnh để xử lý nền', code: 'IMAGE_STORAGE_FAILED' }, 503);
    }
    if (!c.env.IMAGES && imageBase64.length > 120_000) {
      await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Môi trường xử lý nền cần R2 để lưu ảnh lớn', code: 'QUEUE_PAYLOAD_TOO_LARGE' }, 413);
    }

    let enqueueAttempted = false;
    try {
      const statements = [
        db.prepare('INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)')
          .bind(auth.householdId, 'Tủ lạnh gia đình', auth.userId),
        db.prepare(SQL.CREATE_SCAN)
          .bind(scanId, auth.userId, auth.householdId, imageKey, 'pending', 'receipt'),
      ];
      const results = await db.batch(statements);
      assertBatchSucceeded(results);
      enqueueAttempted = true;
      await c.env.SCAN_QUEUE.send({
        type: 'scan.process.v1',
        jobId: `scan_job_${scanId}`,
        scanId,
        userId: auth.userId,
        householdId: auth.householdId,
        scanType: 'receipt',
        imageKey: c.env.IMAGES ? imageKey : undefined,
        imageBase64: c.env.IMAGES ? undefined : imageBase64,
        mimeType,
        idempotencyKey,
      });
      await finalizeScanQuota(db, reservationId, 'consumed');
      return c.json({
        success: true,
        queued: true,
        receipt: {
          id: scanId,
          userId: auth.userId,
          householdId: auth.householdId,
          imageKey,
          scanType: 'receipt',
          status: 'pending',
          items: [],
          createdAt: new Date().toISOString(),
        },
      }, 202);
    } catch (err) {
      console.error('Receipt queue enqueue failed:', err);
      if (!enqueueAttempted) await finalizeScanQuota(db, reservationId, 'released');
      return c.json({ error: 'Không thể xếp hàng hóa đơn', code: 'QUEUE_UNAVAILABLE' }, 503);
    }
  }

  const aiRouter = getAIRouter(c.env);

  let receiptResult;
  try {
    receiptResult = await Promise.race([
      aiRouter.receiptScan({ imageBase64OrUrl: imageBase64 || 'mock-receipt', mimeType }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI_SCAN_TIMEOUT: Đọc hóa đơn quá lâu. Vui lòng thử lại.')), 25000)
      ),
    ]);
  } catch (error) {
    await finalizeScanQuota(db, reservationId, 'released');
    throw error;
  }

  const receiptRecord = {
    id: scanId,
    userId: auth.userId,
    householdId: auth.householdId,
    imageKey,
    scanType: 'receipt',
    status: 'ready',
    merchantName: receiptResult.merchant_name,
    invoiceNumber: receiptResult.invoice_number,
    purchaseDate: receiptResult.purchase_date,
    totalAmountVnd: receiptResult.total_amount_vnd,
    items: receiptResult.items.map((item, idx) => {
      const canonical = findCanonicalIngredient(item.raw_name);
      const providerCanonical = item.canonical_id
        ? findCanonicalIngredient(item.canonical_id)
        : null;
      return {
        id: `receipt_item_${scanId}_${idx}`,
        rawName: item.raw_name,
        canonicalId: canonical?.id || providerCanonical?.id || null,
        estimatedQuantity: item.estimated_quantity,
        unit: item.unit as StandardUnit,
        unitPriceVnd: item.unit_price_vnd,
        totalPriceVnd: item.total_price_vnd,
        category: item.category || 'other',
        storage: item.storage || 'fridge',
        confidence: item.confidence,
      };
    }),
    createdAt: new Date().toISOString(),
  };

  try {
    const statements = [
      db
        .prepare('INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)')
        .bind(auth.householdId, 'Tủ lạnh gia đình', auth.userId),
      db
        .prepare(`INSERT INTO scans
          (id, user_id, household_id, image_key, status, scan_type, merchant_name, invoice_number, purchase_date, total_amount_vnd)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          scanId,
          auth.userId,
          auth.householdId,
          imageStored ? imageKey : null,
          'ready',
          'receipt',
          receiptRecord.merchantName ?? null,
          receiptRecord.invoiceNumber ?? null,
          receiptRecord.purchaseDate ?? null,
          receiptRecord.totalAmountVnd ?? null,
        ),
    ];

    for (const item of receiptRecord.items) {
      statements.push(
        db
          .prepare(SQL.INSERT_RECEIPT_SCAN_ITEM)
          .bind(
            item.id,
            scanId,
            item.rawName,
            item.canonicalId,
            item.estimatedQuantity,
            item.unit,
            item.confidence ?? LEGACY_CONFIDENCE_FILLER,
            item.category,
            item.storage,
            item.unitPriceVnd ?? null,
            item.totalPriceVnd ?? null,
            item.rawName,
            item.estimatedQuantity,
            item.unit,
            item.confidence ?? null,
          )
      );
    }

    const batchResults = await db.batch(statements);
    assertBatchSucceeded(batchResults);
  } catch (err) {
    console.error('D1 receipt scan batch save failed:', err);
    await finalizeScanQuota(db, reservationId, 'released');
    return c.json({ error: 'Không thể lưu kết quả hóa đơn', code: 'DATABASE_ERROR' }, 500);
  }

  await finalizeScanQuota(db, reservationId, 'consumed');

  return c.json({
    success: true,
    receipt: receiptRecord,
  });
});

// GET /api/v1/scans/:id
scanRoutes.get('/scans/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const db = c.env.DB;

  if (!db) {
    return c.json({ error: 'Database service unavailable' }, 503);
  }

  try {
    // SEC-05 FIX: Enforce tenancy check - only owner of scan can read it
    const scan = await db
      .prepare('SELECT * FROM scans WHERE id = ? AND household_id = ?')
      .bind(id, auth.householdId)
      .first<any>();

    if (!scan) {
      return c.json({ error: 'Bản quét không tồn tại hoặc bạn không có quyền xem', code: 'NOT_FOUND' }, 404);
    }

    const itemsRes = await db.prepare(SQL.GET_SCAN_ITEMS).bind(id).all();
    const items = (itemsRes.results || []).map((row: any) => scanItemDto(row, scan.id));

    return c.json({
      scan: {
        id: scan.id,
        userId: scan.user_id,
        householdId: scan.household_id,
        imageKey: scan.image_key,
        scanType: scan.scan_type,
        status: scan.status,
        merchantName: scan.merchant_name ?? undefined,
        invoiceNumber: scan.invoice_number ?? undefined,
        purchaseDate: scan.purchase_date ?? undefined,
        totalAmountVnd: scan.total_amount_vnd == null ? undefined : Number(scan.total_amount_vnd),
        items,
        createdAt: scan.created_at,
      },
    });
  } catch (err) {
    console.error('D1 GET_SCAN failed:', err);
    return c.json({ error: 'Lỗi truy vấn bản quét', code: 'DATABASE_ERROR' }, 500);
  }
});

// POST /api/v1/scans/:id/confirm
scanRoutes.post('/scans/:id/confirm', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const kv = c.env.CACHE;
  const id = c.req.param('id');

  const rawBody = await c.req.json().catch(() => ({}));
  const parseResult = ScanConfirmSchema.safeParse(rawBody);

  if (!parseResult.success) {
    return c.json(
      {
        error: parseResult.error.errors[0]?.message || 'Dữ liệu xác nhận không hợp lệ',
        code: 'VALIDATION_ERROR',
      },
      400
    );
  }

  const confirmedItems = parseResult.data.items;

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  try {
    // SEC-05 FIX: Verify that the scan belongs to this household
    const scan = await db
      .prepare('SELECT id, status, scan_type, purchase_date FROM scans WHERE id = ? AND household_id = ?')
      .bind(id, auth.householdId)
      .first<any>();

    if (!scan) {
      return c.json({ error: 'Bản quét không tồn tại hoặc không thuộc hộ gia đình của bạn', code: 'NOT_FOUND' }, 404);
    }

    if (scan.status === 'confirmed') {
      const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true, actorId: auth.userId });
      return c.json({
        success: true,
        idempotentReplay: true,
        message: 'Bản quét này đã được xác nhận trước đó',
        inventoryCount: updatedList.length,
        items: updatedList,
      });
    }
    if (scan.status !== 'ready') {
      return c.json(
        { error: 'Bản quét chưa sẵn sàng để xác nhận', code: 'INVALID_SCAN_STATE' },
        409
      );
    }

    // Hydrate the review payload from the server-side scan snapshot. This
    // both preserves fields omitted by older clients (notably the unit) and
    // ensures an AI row from another scan cannot be smuggled into this command.
    const scanItemsResult = await db
      .prepare(
        `SELECT id, raw_name, canonical_id, estimated_quantity, unit, category, storage, is_confirmed,
                unit_price_vnd, total_price_vnd, ocr_raw_name, ocr_quantity, ocr_unit, ocr_confidence
         FROM scan_items WHERE scan_id = ?`
      )
      .bind(id)
      .all();
    const persistedItems = (scanItemsResult.results || []) as PersistedScanItem[];
    const allResolvedItems = resolveScanConfirmationItems(persistedItems, confirmedItems);
    // T13: an explicitly rejected line is durable review evidence, not stock.
    // It is recorded as REJECTED below and never reaches the lot authority.
    const rejectedItems = allResolvedItems.filter((item) => item.rejected);
    const resolvedItems = allResolvedItems.filter((item) => !item.rejected);
    // Authoritative provenance comes from the server's own scan row.
    const provenance = scanProvenance(scan.scan_type);
    const persistedById = new Map(persistedItems.map((item) => [item.id, item]));

    type ResolvedGroup = {
      key: string;
      items: ResolvedScanItem[];
      existing?: {
        id: string;
        quantity: number;
        unit: string;
        ingredient_id?: string | null;
        name?: string;
        expiry_date?: string | null;
      };
    };

    // Group rows that refer to the same canonical ingredient/name before
    // querying inventory. D1 does not expose uncommitted batch inserts to the
    // later SELECTs, so without grouping two tomatoes in one scan could create
    // two inventory rows instead of one aggregated projection.
    const groups = new Map<string, ResolvedGroup>();
    for (const item of resolvedItems) {
      const key = item.canonicalId
        ? `canonical:${item.canonicalId}`
        : `name:${item.name.toLocaleLowerCase()}`;
      const group = groups.get(key);
      if (group) {
        group.items.push(item);
      } else {
        groups.set(key, { key, items: [item] });
      }
    }

    type InventoryUpdate = {
      id: string;
      quantityDelta: number;
      unit: StandardUnit;
      expiryDate: string | null;
      freshness: string;
      ingredientId: string | null;
    };
    type InventoryInsert = {
      id: string;
      quantity: number;
      unit: StandardUnit;
      expiryDate: string;
      freshness: string;
      ingredientId: string | null;
      name: string;
      category: string;
      storage: 'fridge' | 'freezer' | 'pantry';
      expiryBasis: ExpiryBasis;
      /** scan_item ids that fed this lot; used to attribute receipt prices. */
      lineIds: string[];
    };

    const updates = new Map<string, InventoryUpdate>();
    const inserts: InventoryInsert[] = [];
    const events: Array<{
      id: string;
      itemId: string;
      quantity: number;
      unit: StandardUnit;
      metadata: string;
    }> = [];

    const inventoryRevision = await readLegacyInventoryRevision(db, auth.householdId);
    let groupIndex = 0;
    for (const group of groups.values()) {
      const first = group.items[0];
      const existingResult = await db
        .prepare(
          `SELECT id, quantity, unit, ingredient_id, name, expiry_date
           FROM inventory_items
           WHERE household_id = ?
             AND ((? IS NOT NULL AND ingredient_id = ?) OR LOWER(name) = LOWER(?))
           ORDER BY updated_at ASC`
        )
        .bind(auth.householdId, first.canonicalId, first.canonicalId, first.name)
        .all();
      const candidates = (existingResult.results || []) as Array<NonNullable<ResolvedGroup['existing']>>;
      const exactCandidate = candidates.find((candidate) => candidate.unit === first.unit);
      const compatibleCandidate = candidates.find(
        (candidate) =>
          isStandardUnit(candidate.unit) && areUnitsCompatible(first.unit, candidate.unit)
      );
      const existing = exactCandidate || compatibleCandidate;
      if (!existing && candidates.length > 0) {
        throw new ScanConfirmationError(
          'UNIT_MISMATCH',
          `Không thể quy đổi đơn vị ${first.unit} sang đơn vị tồn kho của ${first.name}`
        );
      }
      group.existing = existing || undefined;

      const targetUnitValue = existing?.unit || first.unit;
      if (!isStandardUnit(targetUnitValue)) {
        throw new ScanConfirmationError(
          'INVALID_SCAN_ITEM',
          `Đơn vị tồn kho của ${first.name} không hợp lệ`
        );
      }
      const targetUnit = targetUnitValue;

      let totalDelta = 0;
      const deltas: number[] = [];
      for (const item of group.items) {
        const delta = convertScanQuantity(item.quantity, item.unit, targetUnit);
        totalDelta += delta;
        deltas.push(delta);
      }
      if (!Number.isFinite(totalDelta) || totalDelta <= 0) {
        throw new ScanConfirmationError('INVALID_QUANTITY', `Số lượng của ${first.name} không hợp lệ`);
      }

      const shelfLife = findCanonicalIngredient(first.canonicalId || first.name)?.defaultShelfLifeDays || 7;
      const submittedExpiries = group.items
        .map((item) => item.expiryDate)
        .filter((value): value is string => Boolean(value));
      const existingExpiry = existing?.expiry_date || null;
      const expiryDate = [...submittedExpiries, ...(existingExpiry ? [existingExpiry] : [])]
        .sort()[0] || new Date(Date.now() + shelfLife * 86400000).toISOString().split('T')[0];
      const freshness = computeFreshness(expiryDate, undefined, shelfLife);
      // T13 expiry truth. The winning date decides the evidence class: a
      // reviewer-supplied date is KNOWN; a day-chip estimate or the default
      // shelf-life fallback is ESTIMATED. The pre-T13 code wrote every one of
      // these as KNOWN, which manufactured dated facts out of a guess.
      const expiryBasis: ExpiryBasis = group.items.some((item) => item.expiryDate === expiryDate
        && item.expiryBasis === 'supplied') ? 'supplied' : 'inferred';

      let itemId: string;
      if (existing) {
        const currentQuantity = Number(existing.quantity);
        if (!Number.isFinite(currentQuantity) || currentQuantity < 0) {
          throw new ScanConfirmationError('INVALID_QUANTITY', `Tồn kho của ${first.name} không hợp lệ`);
        }
        itemId = existing.id;
        const previous = updates.get(itemId);
        updates.set(itemId, {
          id: itemId,
          quantityDelta: (previous?.quantityDelta || 0) + totalDelta,
          unit: targetUnit,
          expiryDate,
          freshness,
          ingredientId: existing.ingredient_id || first.canonicalId,
        });
        if (!Number.isFinite(currentQuantity + totalDelta)) {
          throw new ScanConfirmationError('INVALID_QUANTITY', `Số lượng của ${first.name} quá lớn`);
        }
      } else {
        itemId = `item_${id}_${stableScanPart(first, groupIndex)}`;
        inserts.push({
          id: itemId,
          quantity: totalDelta,
          unit: targetUnit,
          expiryDate,
          freshness,
          ingredientId: first.canonicalId,
          name: first.name,
          category: first.category,
          storage: first.storage,
          expiryBasis,
          lineIds: group.items.map((item) => item.sourceId).filter((value): value is string => Boolean(value)),
        });
      }

      group.items.forEach((item, itemIndex) => {
        const sourceKey = stableScanPart(item, itemIndex);
        events.push({
          id: `evt_scan_${id}_${sourceKey}`,
          itemId,
          quantity: deltas[itemIndex],
          unit: targetUnit,
          metadata: JSON.stringify({
            scanId: id,
            scanItemId: item.sourceId || null,
            sourceQuantity: item.quantity,
            sourceUnit: item.unit,
          }),
        });
      });
      groupIndex += 1;
    }

    const selectedItems = resolvedItems.filter(
      (item): item is ResolvedScanItem & { sourceId: string } => Boolean(item.sourceId)
    );
    const selectedIds = selectedItems.map((item) => item.sourceId);
    // Every mutation below is guarded by the same READY predicate. The scan
    // status transition is deliberately the final statement; a concurrent
    // confirmation therefore turns all stale mutations into no-ops.
    const readyScanPredicate =
      `EXISTS (SELECT 1 FROM scans WHERE id = ? AND household_id = ? AND status = 'ready')`;
    const batchStatements: any[] = [];
    if (selectedItems.length > 0) {
      // Persist the user's reviewed values alongside the confirmation flag so
      // a later GET of the scan reflects exactly what was imported. Omitted
      // predictions remain unconfirmed and retain their original AI values.
      for (const item of selectedItems) {
        batchStatements.push(
          db
            .prepare(
              `UPDATE scan_items
               SET raw_name = ?, canonical_id = ?, estimated_quantity = ?, unit = ?,
                   category = ?, storage = ?, is_confirmed = 1, review_state = 'CONFIRMED'
               WHERE id = ? AND scan_id = ? AND ${readyScanPredicate}`
            )
            .bind(
              item.name,
              item.canonicalId,
              item.quantity,
              item.unit,
              item.category,
              item.storage,
              item.sourceId,
              id,
              id,
              auth.householdId
            )
        );
      }
    }

    // T13: an explicitly rejected line is recorded as durable review evidence.
    // Modelling rejection as "the line vanished from the request" would leave
    // it indistinguishable from a not-yet-reviewed line forever.
    for (const rejected of rejectedItems) {
      if (!rejected.sourceId) continue;
      batchStatements.push(
        db
          .prepare(
            `UPDATE scan_items SET review_state = 'REJECTED', is_confirmed = 0
             WHERE id = ? AND scan_id = ? AND is_confirmed = 0 AND ${readyScanPredicate}`
          )
          .bind(rejected.sourceId, id, id, auth.householdId)
      );
    }

    // Adopted households confirm through the lot authority: reviewed scan
    // values and the status transition commit in the same atomic batch as the
    // native commands, status update last.
    if (await readInventoryAuthorityMode(db, auth.householdId) === 'native') {
      return confirmAdoptedScan(c, db, kv, auth, id, {
        selectedIds, batchStatements, updates, inserts,
        provenance,
        purchase: {
          // Receipt facts are read from the server-side scan row, never from
          // the client payload, and stay null when the receipt lacked them.
          purchasedAt: provenance === 'RECEIPT'
            ? receiptLineFacts(provenance, scan, {}).purchasedAt : null,
          purchasePriceFor: (lineIds: string[]) => {
            if (provenance !== 'RECEIPT') return null;
            // Only attribute a price when exactly one receipt line feeds the
            // lot; a merged lot has no single provable line price.
            if (lineIds.length !== 1) return null;
            const line = persistedById.get(lineIds[0]);
            return line ? receiptLineFacts(provenance, scan, line).purchasePrice : null;
          },
        },
        observations: await Promise.all(resolvedItems.map(async (item, index) => ({
          sourceRef: await scanObservationSourceRef(id, item.sourceId ?? item.clientId ?? `manual-${index}`),
          ingredientId: item.canonicalId,
          rawName: item.name.slice(0, 200),
          legacyItemId: null,
          quantity: item.quantity,
          unit: item.unit,
          storage: item.storage,
          expiryDate: item.expiryDate ?? null,
          expiryBasis: item.expiryBasis,
          note: null,
        }))),
        readyGuard: { sql: readyScanPredicate, bindings: [id, auth.householdId] },
      });
    }

    for (const update of updates.values()) {
      batchStatements.push(
        db
          .prepare(
            `UPDATE inventory_items
             SET quantity = quantity + ?, unit = ?, ingredient_id = COALESCE(ingredient_id, ?),
                 expiry_date = ?, freshness = ?, version = version + 1, updated_at = datetime('now')
             WHERE id = ? AND household_id = ? AND ${readyScanPredicate}`
          )
          .bind(
            update.quantityDelta,
            update.unit,
            update.ingredientId,
            update.expiryDate,
            update.freshness,
            update.id,
            auth.householdId,
            id,
            auth.householdId
          )
      );
    }

    for (const insert of inserts) {
      batchStatements.push(
        db
          .prepare(
            `INSERT INTO inventory_items
             (id, household_id, ingredient_id, name, quantity, unit, category, storage,
              expiry_date, added_date, freshness, data_source)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE ${readyScanPredicate}`
          )
          .bind(
            insert.id,
            auth.householdId,
            insert.ingredientId,
            insert.name,
            insert.quantity,
            insert.unit,
            insert.category,
            insert.storage,
            insert.expiryDate,
            new Date().toISOString(),
            insert.freshness,
            'scan',
            id,
            auth.householdId
          )
      );
    }

    for (const event of events) {
      batchStatements.push(
        db
          .prepare(
            `INSERT INTO inventory_events
             (id, household_id, inventory_item_id, event_type, quantity_delta, unit, reason, metadata)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?
             WHERE ${readyScanPredicate}`
          )
          .bind(
            event.id,
            auth.householdId,
            event.itemId,
            'SCAN_CONFIRM',
            event.quantity,
            event.unit,
            'Xác nhận từ nhận diện thông minh',
            event.metadata,
            id,
            auth.householdId
          )
      );
    }

    batchStatements.push(
      db
        .prepare(
          `UPDATE scans SET status = 'confirmed', updated_at = datetime('now')
           WHERE id = ? AND household_id = ? AND status = 'ready'`
        )
        .bind(id, auth.householdId)
    );

    // D1 batch executes the state transition, projection, and audit events as
    // one transaction. A failed event insert therefore rolls back the status.
    const batchResults = await runLegacyInventoryBatch(db, auth.householdId, batchStatements, inventoryRevision,
      { sql: readyScanPredicate, bindings: [id, auth.householdId] });
    assertBatchSucceeded(batchResults);
    const statusResult = batchResults?.[batchResults.length - 1] as any;
    if (statusResult?.meta?.changes !== 1) {
      const committed = await db
        .prepare('SELECT status FROM scans WHERE id = ? AND household_id = ?')
        .bind(id, auth.householdId)
        .first();
      if ((committed as any)?.status === 'confirmed') {
        const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true, actorId: auth.userId });
        return c.json({
          success: true,
          idempotentReplay: true,
          message: 'Bản quét này đã được xác nhận trước đó',
          inventoryCount: updatedList.length,
          items: updatedList,
        });
      }
      throw new Error('Scan confirmation state transition did not commit');
    }

    if (kv) {
      await kv.delete(`inv_${auth.householdId}`).catch(() => {});
    }

    // Fetch fresh updated inventory from D1
    const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true, actorId: auth.userId });

    return c.json({
      success: true,
      message: 'Đã cập nhật nguyên liệu vào tủ lạnh thành công',
      inventoryCount: updatedList.length,
      items: updatedList,
      confirmedItemIds: selectedIds,
    });
  } catch (err: any) {
    if (err instanceof ScanConfirmationError) {
      return c.json(
        { error: err.message, code: err.code },
        err.status as 400 | 409 | 422
      );
    }
    // If another request confirmed this scan between our state read and the
    // batch, the unique event IDs make this batch fail atomically. Re-read the
    // state and expose the committed result as an idempotent replay.
    try {
      const committed = await db
        .prepare('SELECT status FROM scans WHERE id = ? AND household_id = ?')
        .bind(id, auth.householdId)
        .first();
      if ((committed as any)?.status === 'confirmed') {
        const updatedList = await fetchHouseholdInventoryFromDb(db, auth.householdId, kv, { strict: true, actorId: auth.userId });
        return c.json({
          success: true,
          idempotentReplay: true,
          message: 'Bản quét này đã được xác nhận trước đó',
          inventoryCount: updatedList.length,
          items: updatedList,
        });
      }
    } catch {
      // Fall through to the database error response.
    }
    if (err instanceof InventoryWriterAuthorityError || err instanceof InventoryWriterSnapshotError) {
      return c.json({ error: err.message, code: err.code }, 409);
    }
    console.error('D1 confirmScan items insert failed:', err);
    return c.json({ error: 'Lỗi xác nhận đưa nguyên liệu vào tủ lạnh', code: 'DATABASE_ERROR' }, 500);
  }
});
