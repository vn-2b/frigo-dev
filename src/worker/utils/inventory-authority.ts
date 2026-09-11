import { LotCommandError } from '../../../packages/domain/src/inventory-lot-commands';
import { readInventoryAuthorityMode } from '../../../packages/db/src/inventory-writer-fence';

export { readInventoryAuthorityMode };

export interface InventoryAuthorityFailure {
  status: 400 | 403 | 404 | 409 | 422 | 500;
  code: string;
}

// Native lot-command failures map onto the legacy writer response contracts;
// anything unrecognized stays a server error rather than a silent fallback.
export function inventoryAuthorityFailure(error: LotCommandError): InventoryAuthorityFailure {
  switch (error.code) {
    case 'FORBIDDEN':
      return { status: 403, code: 'FORBIDDEN' };
    case 'INVALID_COMMAND':
      return { status: 400, code: 'VALIDATION_ERROR' };
    case 'INCOMPATIBLE_UNIT':
      return { status: 422, code: 'UNIT_MISMATCH' };
    case 'UNREPRESENTABLE_QUANTITY':
      return { status: 422, code: 'VALIDATION_ERROR' };
    case 'INSUFFICIENT_QUANTITY':
      return { status: 409, code: 'INSUFFICIENT_INVENTORY' };
    case 'REVIVE_REQUIRED':
      return { status: 409, code: 'REVIVE_REQUIRED' };
    case 'LOT_EXISTS':
      return { status: 409, code: 'CONFLICT' };
    case 'IDEMPOTENCY_CONFLICT':
      return { status: 409, code: 'IDEMPOTENCY_CONFLICT' };
    case 'STALE_SNAPSHOT':
    case 'STALE_VERSION':
      return { status: 409, code: 'CONFLICT' };
    case 'VERSION_OVERFLOW':
      return { status: 409, code: 'VERSION_OVERFLOW' };
    case 'ADOPTION_REQUIRED':
      return { status: 409, code: 'INVENTORY_AUTHORITY_REQUIRED' };
    case 'ADOPTION_ALREADY_ACTIVE':
      return { status: 409, code: 'ADOPTION_ALREADY_ACTIVE' };
    case 'INVALID_TERMINAL_EVIDENCE':
      return { status: 422, code: 'INVALID_TERMINAL_EVIDENCE' };
    case 'TERMINAL_EVIDENCE_REQUIRED':
      return { status: 422, code: 'TERMINAL_EVIDENCE_REQUIRED' };
    case 'ADOPTION_LIMIT_EXCEEDED':
      return { status: 422, code: 'ADOPTION_LIMIT_EXCEEDED' };
    default:
      return { status: 500, code: 'DATABASE_ERROR' };
  }
}

export interface LotExpiryFields {
  expiryAt: string | null;
  estimatedExpiryAt: string | null;
  expiryKind: 'KNOWN' | 'BEST_BEFORE' | 'USE_BY' | 'ESTIMATED' | 'UNKNOWN';
}

// A bare legacy date is KNOWN dated evidence; USE_BY/BEST_BEFORE is never
// inferred. Existing lot kinds are preserved when a caller edits the date.
export function lotExpiryFieldsFromLegacy(expiryDate: string | null,
  currentKind?: LotExpiryFields['expiryKind']): LotExpiryFields {
  if (!expiryDate) return { expiryAt: null, estimatedExpiryAt: null, expiryKind: 'UNKNOWN' };
  if (currentKind === 'ESTIMATED') return { expiryAt: null, estimatedExpiryAt: expiryDate, expiryKind: 'ESTIMATED' };
  if (currentKind === 'BEST_BEFORE' || currentKind === 'USE_BY') {
    return { expiryAt: expiryDate, estimatedExpiryAt: null, expiryKind: currentKind };
  }
  return { expiryAt: expiryDate, estimatedExpiryAt: null, expiryKind: 'KNOWN' };
}
