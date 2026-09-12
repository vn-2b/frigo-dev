import { pushOp, type PendingScope } from '../lib/sync';
import {
  capturePrivateSession, clearPrivateIdentity, currentPrivateScope, isOfflineGuestSession,
  privateCacheKey, privateSessionBlocked, removePrivateCaches,
} from '../lib/private-session';

export const BASE_URL = '/api/v1';

export function handleUnauthorized() {
  clearPrivateIdentity();
}

export type ApiErrorKind = 'offline' | 'http' | 'auth';

export class ApiError extends Error {
  kind: ApiErrorKind;
  status?: number;
  retryable?: boolean;
  constructor(kind: ApiErrorKind, message: string, status?: number, options?: { retryable?: boolean }) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryable = options?.retryable;
  }

  /** Machine-readable `code` from an `HTTP <status>: {json}` envelope, or null. */
  get code(): string | null {
    const envelope = /^HTTP \d{3}: ([\s\S]*)$/.exec(this.message);
    if (!envelope) return null;
    try {
      const body: unknown = JSON.parse(envelope[1]);
      return body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : null;
    } catch {
      return null;
    }
  }
}

export function isOffline(err: unknown): boolean {
  return err instanceof ApiError && err.kind === 'offline';
}

export function isNonRetryable(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.kind === 'http' &&
    typeof err.status === 'number' &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 409
  );
}

export function guardPrivateSession(): () => void {
  const isCurrent = capturePrivateSession();
  const assertCurrent = () => {
    if (!isCurrent()) throw new ApiError('auth', 'Phiên làm việc đã thay đổi. Vui lòng đăng nhập lại.');
  };
  assertCurrent();
  return assertCurrent;
}

export async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const assertCurrent = guardPrivateSession();
  const scope = getCurrentScope();
  const pathname = path.split('?')[0];
  const publicRead = (options?.method?.toUpperCase() || 'GET') === 'GET' &&
    (pathname === '/recipes' || pathname.startsWith('/recipes/'));
  if ((!scope.userId || !scope.householdId) && !path.startsWith('/auth/') &&
    pathname !== '/config' && pathname !== '/health' && !publicRead) {
    throw new ApiError('auth', 'Vui lòng đăng nhập hoặc bắt đầu phiên khách.');
  }
  if (isOfflineGuestSession() && !path.startsWith('/auth/') && pathname !== '/config') {
    throw new ApiError('offline', 'Phiên khách này chỉ lưu dữ liệu trên thiết bị.', undefined, { retryable: false });
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const headerEntries = options?.headers instanceof Headers
    ? options.headers.entries()
    : Array.isArray(options?.headers) ? options.headers : Object.entries(options?.headers ?? {});
  for (const [key, value] of headerEntries) {
    // Cookie authentication and owner expectations cannot be replaced by callers.
    if (['authorization', 'x-frigo-expected-user-id', 'x-frigo-expected-household-id'].includes(key.toLowerCase())) continue;
    const existingKey = Object.keys(headers).find((name) => name.toLowerCase() === key.toLowerCase());
    if (existingKey) delete headers[existingKey];
    headers[key] = value;
  }
  if (!path.startsWith('/auth/') && !path.startsWith('/billing/') &&
    pathname !== '/config' && pathname !== '/health' && (!publicRead || (scope.userId && scope.householdId))) {
    // Recipe reads can include a personalized inventory match, so fence them too.
    headers['X-Frigo-Expected-User-Id'] = scope.userId;
    headers['X-Frigo-Expected-Household-Id'] = scope.householdId;
  }
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });
  } catch {
    assertCurrent();
    // Network-level failure (no connectivity, DNS, aborted) => offline.
    throw new ApiError('offline', `Không có kết nối mạng khi gọi ${path}`, undefined, { retryable: true });
  }

  assertCurrent();

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    assertCurrent();
    if (res.status === 401) {
      handleUnauthorized();
      throw new ApiError('auth', `HTTP 401: ${text}`, 401);
    }
    if (res.status === 403) {
      throw new ApiError('auth', `HTTP 403: ${text}`, 403);
    }
    throw new ApiError('http', `HTTP ${res.status}: ${text}`, res.status);
  }

  try {
    const result = await res.json() as T;
    assertCurrent();
    return result;
  } catch (err) {
    assertCurrent();
    throw err;
  }
}

export function queueWrite(
  path: string,
  method: string,
  body: string | undefined,
  label: string,
  dedupeKey?: string,
  headers?: Record<string, string>
): void {
  if (privateSessionBlocked()) throw new ApiError('auth', 'Đồng bộ riêng tư đã tạm dừng.');
  pushOp({ path, method, body, label, dedupeKey, headers, ...getCurrentScope() });
}

export function getHouseholdId(): string {
  return currentPrivateScope().householdId;
}

export function getUserId(): string {
  return currentPrivateScope().userId;
}

export function getCurrentScope(): PendingScope {
  return currentPrivateScope();
}

export function clearTenantCaches(): void {
  try {
    removePrivateCaches();
  } catch {
    // storage may be unavailable in private browsing
  }
}

export function createClientItemId(prefix = 'item'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDeterministicKey(prefix: string, value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${(hash >>> 0).toString(16)}`;
}

export function readCachedInventory(householdId = getHouseholdId()): any[] {
  try {
    localStorage.removeItem(`frigo_inventory_${householdId}`);
    const raw = localStorage.getItem(privateCacheKey('inventory', householdId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function inventoryCacheKey(householdId = getHouseholdId()): string {
  return privateCacheKey('inventory', householdId);
}

export function shoppingCacheKey(householdId = getHouseholdId()): string {
  return privateCacheKey('shopping_list', householdId);
}

export function weekPlanCacheKey(householdId = getHouseholdId()): string {
  // Neither old key proves user ownership, even when the household matches.
  localStorage.removeItem('frigo_active_meal_plan');
  localStorage.removeItem(`frigo_active_meal_plan_${householdId}`);
  return privateCacheKey('active_meal_plan', householdId);
}

export function writeCachedInventory(items: any[], householdId = getHouseholdId()): void {
  localStorage.setItem(inventoryCacheKey(householdId), JSON.stringify(items));
}

export function readCachedWeekPlan<T>(): T | null {
  try {
    const raw = localStorage.getItem(weekPlanCacheKey());
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

export function writeCachedWeekPlan(plan: unknown): void {
  localStorage.setItem(weekPlanCacheKey(), JSON.stringify(plan));
}
