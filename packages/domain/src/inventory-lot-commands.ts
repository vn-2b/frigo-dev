import { z } from 'zod';
import {
  InventoryLotSchema,
  StorageLocationSchema,
  toLotQuantity,
  type InventoryLot,
  type StorageLocation,
} from './inventory-truth';

export class LotCommandError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'LotCommandError';
  }
}

const LotFields = InventoryLotSchema.innerType().shape;
const Unit = z.enum(['g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice']);
const RawName = z.string().refine((value) => !value.includes('\0'), 'Name cannot contain NUL');
const Reason = z.string().refine((value) => value.trim().length > 0 && !value.includes('\0'), 'A nonblank reason is required');

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

const CalendarDate = z.string().refine(isCalendarDate, 'Invalid calendar date');
// Date.parse normalizes impossible dates; validate the calendar before accepting an instant.
const Instant = z.string().datetime({ offset: true }).refine((value) =>
  isCalendarDate(value.slice(0, 10))
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.test(value)
  && Number.isFinite(Date.parse(value)), 'Invalid timestamp');

const MutableFields = {
  lotId: LotFields.id,
  expectedVersion: LotFields.version,
};
const CorrectionChanges = z.object({
  quantity: z.number().finite().nonnegative().optional(),
  unit: Unit.optional(),
  rawName: RawName.optional(),
  ingredientId: LotFields.ingredientId.optional(),
  expiryAt: CalendarDate.nullable().optional(),
  estimatedExpiryAt: CalendarDate.nullable().optional(),
  expiryKind: LotFields.expiryKind.optional(),
  purchasedAt: CalendarDate.nullable().optional(),
  openedAt: Instant.nullable().optional(),
  purchasePrice: LotFields.purchasePrice.optional(),
}).strict().refine((changes) => Object.values(changes).some((value) => value !== undefined), 'Correction requires an explicit change');

export const InventoryLotCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('CREATE'),
    lotId: LotFields.id,
    ingredientId: LotFields.ingredientId.default(null),
    rawName: RawName,
    quantity: z.number().finite().positive(),
    unit: Unit,
    storageLocationId: LotFields.storageLocationId,
    expiryAt: CalendarDate.nullable().default(null),
    estimatedExpiryAt: CalendarDate.nullable().default(null),
    expiryKind: LotFields.expiryKind.default('UNKNOWN'),
    purchasedAt: CalendarDate.nullable().default(null),
    openedAt: Instant.nullable().default(null),
    purchasePrice: LotFields.purchasePrice.default(null),
    sourceType: z.enum(['MANUAL', 'SCAN', 'SHOPPING', 'RECEIPT']),
    sourceId: LotFields.sourceId.default(null),
  }).strict(),
  z.object({
    type: z.literal('USE'), ...MutableFields,
    quantity: z.number().finite().positive(), unit: Unit, reason: Reason.optional(),
  }).strict(),
  z.object({
    type: z.literal('DISCARD'), ...MutableFields,
    quantity: z.number().finite().positive(), unit: Unit, reason: Reason.optional(),
  }).strict(),
  z.object({ type: z.literal('OPEN'), ...MutableFields, openedAt: Instant }).strict(),
  z.object({ type: z.literal('MOVE'), ...MutableFields, storageLocationId: LotFields.storageLocationId }).strict(),
  z.object({
    type: z.literal('CORRECT'), ...MutableFields,
    changes: CorrectionChanges,
    reason: Reason,
    revive: z.boolean().default(false),
    terminalState: z.enum(['CONSUMED', 'DISCARDED']).optional(),
  }).strict(),
]).superRefine((command, ctx) => {
  const issue = (path: string[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (command.type === 'CREATE') {
    if (command.ingredientId === null && command.rawName.trim().length === 0) {
      issue(['rawName'], 'A canonical ingredient or nonblank raw name is required');
    }
    if (command.sourceType !== 'MANUAL' && command.sourceId === null) {
      issue(['sourceId'], 'Source reference required');
    }
    const validExpiry = command.expiryKind === 'UNKNOWN'
      ? command.expiryAt === null && command.estimatedExpiryAt === null
      : command.expiryKind === 'ESTIMATED'
        ? command.expiryAt === null && command.estimatedExpiryAt !== null
        : command.expiryAt !== null && command.estimatedExpiryAt === null;
    if (!validExpiry) issue(['expiryKind'], 'Expiry evidence mismatch');
  }
  if (command.type === 'CORRECT') {
    if ((command.changes.quantity === 0) !== (command.terminalState !== undefined)) {
      issue(['terminalState'], 'Exactly a zero-quantity correction requires a terminal state');
    }
    if (command.revive && !(command.changes.quantity !== undefined && command.changes.quantity > 0)) {
      issue(['revive'], 'Revival requires an explicit positive quantity');
    }
  }
});
export type InventoryLotCommand = z.infer<typeof InventoryLotCommandSchema>;

export interface LotCommandContext {
  householdId: string;
  now: string;
  locations: StorageLocation[];
  ingredientIds: string[];
}

export interface SingleLotCommandPlan {
  before: InventoryLot | null;
  after: InventoryLot;
  changed: boolean;
  deltaMilli: number;
}

const ContextSchema = z.object({
  householdId: LotFields.householdId,
  now: Instant,
  locations: z.array(StorageLocationSchema),
  ingredientIds: z.array(LotFields.ingredientId.unwrap()),
}).strict();

function normalizeQuantity(quantity: number, unit: z.infer<typeof Unit>): ReturnType<typeof toLotQuantity> {
  try {
    return toLotQuantity(quantity, unit);
  } catch {
    throw new LotCommandError('UNREPRESENTABLE_QUANTITY', 'Quantity must fit exact safe-integer milli-units');
  }
}

function samePrice(a: InventoryLot['purchasePrice'], b: InventoryLot['purchasePrice']): boolean {
  return a === b || (a !== null && b !== null
    && a.currency === b.currency && a.amountMinor === b.amountMinor && a.minorDigits === b.minorDigits);
}

function sameEffect(before: InventoryLot, after: InventoryLot): boolean {
  const fields = [
    'quantityMilli', 'canonicalUnit', 'state', 'storageLocationId', 'ingredientId', 'rawName',
    'expiryAt', 'estimatedExpiryAt', 'expiryKind', 'purchasedAt', 'openedAt',
  ] as const;
  return fields.every((field) => before[field] === after[field]) && samePrice(before.purchasePrice, after.purchasePrice);
}

function validateAfter(lot: InventoryLot): InventoryLot {
  const result = InventoryLotSchema.safeParse(lot);
  if (!result.success) throw new LotCommandError('INVALID_COMMAND', result.error.message);
  if ((lot.state === 'ACTIVE') !== (lot.quantityMilli > 0)) throw new LotCommandError('INVALID_LOT_STATE');
  return lot;
}

export function planSingleLotCommand(
  input: unknown,
  existingLot: InventoryLot | null,
  context: LotCommandContext,
): SingleLotCommandPlan {
  const parsedContext = ContextSchema.safeParse(context);
  if (!parsedContext.success) throw new LotCommandError('INVALID_CONTEXT', parsedContext.error.message);
  const scope = parsedContext.data;
  const locationIds = new Set<string>();
  for (const location of scope.locations) {
    if (location.householdId !== scope.householdId) throw new LotCommandError('HOUSEHOLD_MISMATCH', 'Foreign storage location in context');
    if (locationIds.has(location.id)) throw new LotCommandError('INVALID_CONTEXT', 'Duplicate storage location');
    locationIds.add(location.id);
  }
  const ingredientIds = new Set(scope.ingredientIds);
  const requireLocation = (id: string) => {
    if (!locationIds.has(id)) throw new LotCommandError('LOCATION_NOT_FOUND');
  };
  const requireIngredient = (id: string | null) => {
    if (id !== null && !ingredientIds.has(id)) throw new LotCommandError('INGREDIENT_NOT_FOUND');
  };
  const parsedCommand = InventoryLotCommandSchema.safeParse(input);
  if (!parsedCommand.success) throw new LotCommandError('INVALID_COMMAND', parsedCommand.error.message);
  const command = parsedCommand.data;

  if (existingLot !== null) {
    const parsedLot = InventoryLotSchema.safeParse(existingLot);
    if (!parsedLot.success) throw new LotCommandError('INVALID_LOT', parsedLot.error.message);
    if (existingLot.householdId !== scope.householdId) throw new LotCommandError('HOUSEHOLD_MISMATCH');
    if (existingLot.id !== command.lotId) throw new LotCommandError('LOT_NOT_FOUND');
    requireLocation(existingLot.storageLocationId);
    requireIngredient(existingLot.ingredientId);
  }

  if (command.type === 'CREATE') {
    if (existingLot !== null) throw new LotCommandError('LOT_EXISTS');
    requireLocation(command.storageLocationId);
    requireIngredient(command.ingredientId);
    const after = validateAfter({
      id: command.lotId,
      householdId: scope.householdId,
      ingredientId: command.ingredientId,
      rawName: command.rawName,
      ...normalizeQuantity(command.quantity, command.unit),
      storageLocationId: command.storageLocationId,
      state: 'ACTIVE',
      purchasedAt: command.purchasedAt,
      openedAt: command.openedAt,
      expiryAt: command.expiryAt,
      estimatedExpiryAt: command.estimatedExpiryAt,
      expiryKind: command.expiryKind,
      sourceType: command.sourceType,
      sourceId: command.sourceId,
      version: 1,
      createdAt: scope.now,
      updatedAt: scope.now,
      purchasePrice: command.purchasePrice,
      legacyExpiryAt: null,
      legacyExpiryKind: null,
      legacyExpirySource: null,
      legacyOpenedAt: null,
      legacyVersion: null,
    });
    return { before: null, after, changed: true, deltaMilli: after.quantityMilli };
  }

  if (existingLot === null) throw new LotCommandError('LOT_NOT_FOUND');
  if (command.expectedVersion !== existingLot.version) throw new LotCommandError('STALE_VERSION');
  if (command.type !== 'CORRECT' && (existingLot.state !== 'ACTIVE' || existingLot.quantityMilli === 0)) {
    throw new LotCommandError('LOT_NOT_ACTIVE');
  }
  const after: InventoryLot = { ...existingLot };
  switch (command.type) {
    case 'USE':
    case 'DISCARD': {
      const quantity = normalizeQuantity(command.quantity, command.unit);
      if (quantity.canonicalUnit !== existingLot.canonicalUnit) throw new LotCommandError('INCOMPATIBLE_UNIT');
      if (quantity.quantityMilli > existingLot.quantityMilli) throw new LotCommandError('INSUFFICIENT_QUANTITY');
      after.quantityMilli -= quantity.quantityMilli;
      after.state = after.quantityMilli > 0 ? 'ACTIVE' : command.type === 'USE' ? 'CONSUMED' : 'DISCARDED';
      break;
    }
    case 'OPEN':
      if (after.openedAt === null) after.openedAt = command.openedAt;
      break;
    case 'MOVE':
      requireLocation(command.storageLocationId);
      after.storageLocationId = command.storageLocationId;
      break;
    case 'CORRECT': {
      const changes = command.changes;
      const unit = changes.unit ?? existingLot.canonicalUnit;
      if (normalizeQuantity(0, unit).canonicalUnit !== existingLot.canonicalUnit) throw new LotCommandError('INCOMPATIBLE_UNIT');
      if (changes.quantity !== undefined) {
        const quantity = normalizeQuantity(changes.quantity, unit);
        if (existingLot.state !== 'ACTIVE' && quantity.quantityMilli > 0 && !command.revive) {
          throw new LotCommandError('REVIVE_REQUIRED');
        }
        after.quantityMilli = quantity.quantityMilli;
        after.state = quantity.quantityMilli > 0 ? 'ACTIVE' : command.terminalState!;
      }
      if (changes.ingredientId !== undefined) after.ingredientId = changes.ingredientId;
      if (changes.rawName !== undefined) after.rawName = changes.rawName;
      if (changes.expiryAt !== undefined) after.expiryAt = changes.expiryAt;
      if (changes.estimatedExpiryAt !== undefined) after.estimatedExpiryAt = changes.estimatedExpiryAt;
      if (changes.expiryKind !== undefined) after.expiryKind = changes.expiryKind;
      if (changes.purchasedAt !== undefined) after.purchasedAt = changes.purchasedAt;
      if (changes.openedAt !== undefined) after.openedAt = changes.openedAt;
      if (changes.purchasePrice !== undefined) after.purchasePrice = changes.purchasePrice;
      requireIngredient(after.ingredientId);
      if ((changes.ingredientId !== undefined || changes.rawName !== undefined)
        && after.ingredientId === null && after.rawName.trim().length === 0) {
        throw new LotCommandError('INVALID_COMMAND', 'A corrected identity cannot be anonymous');
      }
      break;
    }
  }

  validateAfter(after);
  if (sameEffect(existingLot, after)) return { before: existingLot, after: existingLot, changed: false, deltaMilli: 0 };
  if (existingLot.version === Number.MAX_SAFE_INTEGER) throw new LotCommandError('VERSION_OVERFLOW');
  after.version += 1;
  after.updatedAt = scope.now;
  return { before: existingLot, after, changed: true, deltaMilli: after.quantityMilli - existingLot.quantityMilli };
}
