import { z } from 'zod';
import {
  type InventoryLot,
  toLotQuantity,
} from './inventory-truth';
import {
  LotCommandError,
  planSingleLotCommand,
  type LotCommandContext,
  type SingleLotCommandPlan,
} from './inventory-lot-commands';

export const MAX_FEFO_EFFECTS = 32;
export const MAX_FEFO_SNAPSHOT_LOTS = 1000;
export const MAX_FEFO_RECEIPT_BYTES = 262_144;

type FefoCanonicalUnit = 'g' | 'ml' | 'piece';
type FefoExternalUnit = FefoCanonicalUnit | 'kg' | 'l' | 'pack' | 'bunch' | 'slice';

export interface InventoryFefoCommand {
  type: 'USE';
  mode: 'FEFO';
  ingredientId: string;
  quantityMilli: number;
  canonicalUnit: FefoCanonicalUnit;
  reason?: string;
  expectedInventoryVersion?: number;
}

const FefoExternalCommandSchema = z.object({
  type: z.literal('USE'),
  mode: z.literal('FEFO'),
  ingredientId: z.string().min(1).max(200).refine((value) =>
    value === value.trim() && !value.includes('\0') && /^[A-Z][A-Z0-9_]*$/.test(value),
  'Invalid canonical ingredient ID'),
  quantity: z.number().finite().positive(),
  unit: z.enum(['g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice']),
  reason: z.string().max(1000).optional().refine((value) =>
    value === undefined || (value.trim().length > 0 && !value.includes('\0')),
  'A nonblank reason without NUL is required'),
  expectedInventoryVersion: z.number().int().safe().positive().optional(),
}).strict();

function invalidCommand(message: string): never {
  throw new LotCommandError('INVALID_COMMAND', message);
}

/** Parses the intentionally narrow external FEFO USE shape into exact milli-units. */
export function parseInventoryFefoCommand(input: unknown): InventoryFefoCommand {
  const parsed = FefoExternalCommandSchema.safeParse(input);
  if (!parsed.success) return invalidCommand(parsed.error.message);
  const command = parsed.data;
  if (command.unit === 'pack' || command.unit === 'bunch' || command.unit === 'slice') {
    throw new LotCommandError('UNSUPPORTED_FEFO_UNIT', 'Contextual FEFO units require product context');
  }

  let quantity: ReturnType<typeof toLotQuantity>;
  try {
    quantity = toLotQuantity(command.quantity, command.unit as FefoExternalUnit);
  } catch {
    throw new LotCommandError('UNREPRESENTABLE_QUANTITY', 'Quantity must fit exact safe-integer milli-units');
  }
  if (quantity.canonicalUnit !== 'g' && quantity.canonicalUnit !== 'ml' && quantity.canonicalUnit !== 'piece') {
    throw new LotCommandError('UNSUPPORTED_FEFO_UNIT', 'Contextual FEFO units require product context');
  }
  return {
    type: 'USE',
    mode: 'FEFO',
    ingredientId: command.ingredientId,
    quantityMilli: quantity.quantityMilli,
    canonicalUnit: quantity.canonicalUnit,
    ...(command.reason === undefined ? {} : { reason: command.reason }),
    ...(command.expectedInventoryVersion === undefined
      ? {}
      : { expectedInventoryVersion: command.expectedInventoryVersion }),
  };
}

function compareNullableDate(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : 0;
  if (!Number.isFinite(bTime)) return -1;
  return aTime < bTime ? -1 : aTime > bTime ? 1 : 0;
}

function expiryPriority(lot: InventoryLot): { date: string | null; certainty: number } {
  if (lot.expiryAt !== null) return { date: lot.expiryAt, certainty: 0 };
  if (lot.estimatedExpiryAt !== null) return { date: lot.estimatedExpiryAt, certainty: 1 };
  return { date: null, certainty: 2 };
}

function compareBinaryId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable FEFO ordering; unknown expiry and purchase evidence sort after known facts. */
export function compareFefoLots(a: InventoryLot, b: InventoryLot): number {
  const aExpiry = expiryPriority(a);
  const bExpiry = expiryPriority(b);
  const expiry = compareNullableDate(aExpiry.date, bExpiry.date);
  if (expiry !== 0) return expiry;
  if (aExpiry.certainty !== bExpiry.certainty) return aExpiry.certainty - bExpiry.certainty;

  const purchased = compareNullableDate(a.purchasedAt, b.purchasedAt);
  if (purchased !== 0) return purchased;

  const created = compareNullableDate(a.createdAt, b.createdAt);
  if (created !== 0) return created;
  return compareBinaryId(a.id, b.id);
}

function assertNormalizedCommand(command: InventoryFefoCommand): void {
  if (command.type !== 'USE' || command.mode !== 'FEFO'
    || !/^[A-Z][A-Z0-9_]*$/.test(command.ingredientId) || command.ingredientId.length > 200
    || !Number.isSafeInteger(command.quantityMilli) || command.quantityMilli <= 0
    || !['g', 'ml', 'piece'].includes(command.canonicalUnit)
    || (command.reason !== undefined && (command.reason.length > 1000 || command.reason.trim().length === 0 || command.reason.includes('\0')))
    || (command.expectedInventoryVersion !== undefined
      && (!Number.isSafeInteger(command.expectedInventoryVersion) || command.expectedInventoryVersion <= 0))) {
    invalidCommand('Invalid normalized FEFO command');
  }
}

function isEligibleLot(lot: InventoryLot, command: InventoryFefoCommand, context: LotCommandContext): boolean {
  return lot.householdId === context.householdId
    && lot.ingredientId === command.ingredientId
    && lot.canonicalUnit === command.canonicalUnit
    && lot.state === 'ACTIVE'
    && Number.isSafeInteger(lot.quantityMilli)
    && lot.quantityMilli > 0;
}

function allocationQuantity(quantityMilli: number, canonicalUnit: FefoCanonicalUnit): number {
  const quantity = quantityMilli / 1000;
  try {
    const normalized = toLotQuantity(quantity, canonicalUnit);
    if (normalized.quantityMilli !== quantityMilli || normalized.canonicalUnit !== canonicalUnit) {
      throw new Error('not exactly representable');
    }
  } catch {
    throw new LotCommandError('UNREPRESENTABLE_QUANTITY', 'FEFO allocation must fit the single-lot command contract');
  }
  return quantity;
}

/** Plans all FEFO decrements before persistence; callers must execute the returned plans atomically. */
export function planInventoryFefo(
  command: InventoryFefoCommand,
  lots: InventoryLot[],
  context: LotCommandContext,
): SingleLotCommandPlan[] {
  assertNormalizedCommand(command);
  if (!Array.isArray(lots) || lots.length > MAX_FEFO_SNAPSHOT_LOTS) {
    throw new LotCommandError('FEFO_LIMIT_EXCEEDED', `FEFO snapshots may contain at most ${MAX_FEFO_SNAPSHOT_LOTS} lots`);
  }

  const lotIds = new Set<string>();
  for (const lot of lots) {
    if (lotIds.has(lot.id)) throw new LotCommandError('DUPLICATE_LOT_ID', 'FEFO snapshot contains duplicate lot IDs');
    lotIds.add(lot.id);
  }

  const eligible = lots.filter((lot) => isEligibleLot(lot, command, context)).sort(compareFefoLots);
  let remaining = BigInt(command.quantityMilli);
  const allocations: Array<{ lot: InventoryLot; quantityMilli: number }> = [];
  for (const lot of eligible) {
    if (remaining === 0n) break;
    const available = BigInt(lot.quantityMilli);
    const take = available < remaining ? available : remaining;
    allocations.push({ lot, quantityMilli: Number(take) });
    remaining -= take;
  }
  if (remaining !== 0n) throw new LotCommandError('INSUFFICIENT_INVENTORY');
  if (allocations.length > MAX_FEFO_EFFECTS) {
    throw new LotCommandError('FEFO_LIMIT_EXCEEDED', `FEFO may affect at most ${MAX_FEFO_EFFECTS} lots`);
  }

  return allocations.map(({ lot, quantityMilli }) => planSingleLotCommand({
    type: 'USE',
    lotId: lot.id,
    expectedVersion: lot.version,
    quantity: allocationQuantity(quantityMilli, command.canonicalUnit),
    unit: command.canonicalUnit,
    ...(command.reason === undefined ? {} : { reason: command.reason }),
  }, lot, context));
}
