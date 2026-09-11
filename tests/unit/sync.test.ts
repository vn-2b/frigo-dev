import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/web/services/api';
import { flush, getPendingOps, pendingCount, pushOp, PendingOp } from '../../src/web/lib/sync';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
}

describe('offline outbox and scan persistence contract', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not replay an operation into a different household', async () => {
    pushOp({
      path: '/inventory',
      method: 'POST',
      body: '{"name":"victim item"}',
      label: 'victim',
      userId: 'user-a',
      householdId: 'house-a',
    });
    pushOp({
      path: '/inventory',
      method: 'POST',
      body: '{"name":"current item"}',
      label: 'current',
      userId: 'user-b',
      householdId: 'house-b',
    });

    let replayedUserId: string | undefined;
    const replay = vi.fn(async (op: PendingOp) => {
      replayedUserId = op.userId;
    });
    const result = await flush(replay, undefined, {
      scope: { userId: 'user-b', householdId: 'house-b' },
    });

    expect(result.attempted).toBe(1);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replayedUserId).toBe('user-b');
    expect(getPendingOps()).toHaveLength(1);
    expect(getPendingOps()[0].userId).toBe('user-a');
  });

  it('serializes overlapping flush calls so one operation is replayed once', async () => {
    pushOp({
      path: '/inventory',
      method: 'POST',
      body: '{"name":"one"}',
      label: 'one',
      userId: 'user-a',
      householdId: 'house-a',
    });

    let releaseReplay!: () => void;
    const replay = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseReplay = resolve;
        })
    );
    const options = { scope: { userId: 'user-a', householdId: 'house-a' } };
    const first = flush(replay, undefined, options);
    const second = flush(replay, undefined, options);

    // Let the first call finish; the second call must then observe an empty queue.
    await vi.waitFor(() => expect(releaseReplay).toBeTypeOf('function'));
    releaseReplay();
    await Promise.all([first, second]);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(pendingCount()).toBe(0);
  });

  it('imports an offline fridge scan as replayable inventory writes, not a local scan confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    storage.setItem('frigo_user_id', 'guest-1');
    storage.setItem('frigo_household_id', 'hh_guest_1');

    const scan = await api.scanFridge('image-data');
    expect(scan.id).toMatch(/^scan_offline_/);
    expect(scan.offline).toBe(true);
    expect(scan.items).toHaveLength(0);

    const reviewedItem = {
      id: 'manual-1', rawName: 'Trứng gà', estimatedQuantity: 6, unit: 'piece', storage: 'fridge',
    };
    const result = await api.confirmScan(scan.id, [reviewedItem]);
    expect(result.pendingSync).toBe(true);

    const ops = getPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].path).toBe('/inventory');
    expect(ops[0].path).not.toContain('/scans/');
    expect(ops[0].householdId).toBe('hh_guest_1');
    const body = JSON.parse(ops[0].body || '{}');
    expect(body.id).toContain('offline_scan_offline_');
    expect(body.dataSource).toBe('scan');
  });

  it('keeps queued operations scoped when the active account changes before retry', async () => {
    pushOp({
      path: '/inventory',
      method: 'POST',
      body: '{"name":"old account"}',
      label: 'old',
      userId: 'user-a',
      householdId: 'house-a',
    });
    storage.setItem('frigo_user_id', 'user-b');
    storage.setItem('frigo_household_id', 'house-b');
    storage.setItem('frigo_token', 'new-token');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.retryPendingWrites();

    expect(result.attempted).toBe(0);
    expect(result.remaining).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts only pending operations owned by the active user and household', () => {
    pushOp({ path: '/inventory', method: 'POST', label: 'A', userId: 'user-a', householdId: 'house-a' });
    pushOp({ path: '/inventory', method: 'POST', label: 'B', userId: 'user-a', householdId: 'house-a' });
    pushOp({ path: '/inventory', method: 'POST', label: 'foreign', userId: 'user-b', householdId: 'house-b' });

    expect(pendingCount({ userId: 'user-a', householdId: 'house-a' })).toBe(2);
    expect(pendingCount({ userId: 'user-b', householdId: 'house-b' })).toBe(1);
    expect(pendingCount()).toBe(3);
  });

  it('keeps guest outbox and scope unchanged when inventory transfer is deferred', async () => {
    storage.setItem('frigo_user_id', 'guest-1');
    storage.setItem('frigo_household_id', 'hh_guest_1');
    pushOp({
      path: '/inventory', method: 'POST', body: '{"id":"offline_item"}',
      label: 'guest item', userId: 'guest-1', householdId: 'hh_guest_1',
    });
    const before = getPendingOps();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Inventory transfer deferred', code: 'INVENTORY_TRANSFER_DEFERRED',
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })));

    await expect(api.verifyOtp('a@example.com', '123456', 'register', 'hh_guest_1'))
      .rejects.toMatchObject({
        kind: 'http', status: 409, message: expect.stringContaining('INVENTORY_TRANSFER_DEFERRED'),
      });
    expect(getPendingOps()).toEqual(before);
    expect(storage.getItem('frigo_user_id')).toBe('guest-1');
    expect(storage.getItem('frigo_household_id')).toBe('hh_guest_1');
    expect(storage.getItem('frigo_token')).toBeNull();
  });

  it('retains outbox compatibility with a server-confirmed successful registration migration', async () => {
    storage.setItem('frigo_user_id', 'guest-1');
    storage.setItem('frigo_household_id', 'hh_guest_1');
    pushOp({
      path: '/inventory',
      method: 'POST',
      body: '{"id":"offline_item"}',
      label: 'guest item',
      userId: 'guest-1',
      householdId: 'hh_guest_1',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            migratedFromHouseholdId: 'hh_guest_1',
            user: { id: 'user-1', householdId: 'hh_user-1' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    await api.verifyOtp('a@example.com', '123456', 'register', 'hh_guest_1');

    expect(fetch).toHaveBeenCalledWith('/api/v1/auth/verify-otp', expect.objectContaining({
      credentials: 'include',
    }));
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
    expect(storage.getItem('frigo_token')).toBeNull();

    expect(getPendingOps()).toEqual([
      expect.objectContaining({ userId: 'user-1', householdId: 'hh_user-1' }),
    ]);
  });

  it('preserves idempotency headers when replaying an offline cooking command', async () => {
    storage.setItem('frigo_user_id', 'user-a');
    storage.setItem('frigo_household_id', 'house-a');
    storage.setItem('frigo_token', 'token-a');
    storage.setItem(
      'frigo_inventory_house-a',
      JSON.stringify([{ id: 'i1', ingredientId: 'PORK_BELLY', name: 'Thịt ba chỉ', quantity: 500, unit: 'g' }])
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    await api.completeCooking(
      'thit-kho',
      [{ ingredientId: 'PORK_BELLY', name: 'Thịt ba chỉ', quantityDeducted: 100, unit: 'g' }],
      'cook_command_123'
    );

    expect(getPendingOps()).toEqual([
      expect.objectContaining({
        path: '/recipes/thit-kho/cook/complete',
        headers: { 'Idempotency-Key': 'cook_command_123' },
      }),
    ]);
  });

  it('queues weekly shopping completion as one idempotent command', async () => {
    storage.setItem('frigo_user_id', 'user-a');
    storage.setItem('frigo_household_id', 'house-a');
    storage.setItem('frigo_token', 'token-a');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    const result = await api.completeWeekShopping('plan_12345678', [
      {
        ingredientId: 'PORK_BELLY',
        name: 'Thịt ba chỉ',
        missingQuantity: 500,
        recommendedPurchaseQuantity: 500,
        unit: 'g',
        category: 'meat',
      },
      {
        ingredientId: 'CHICKEN_EGG',
        name: 'Trứng gà',
        missingQuantity: 6,
        recommendedPurchaseQuantity: 6,
        unit: 'piece',
        category: 'egg',
      },
    ]);

    expect(result.pendingSync).toBe(true);
    expect(getPendingOps()).toHaveLength(1);
    expect(getPendingOps()[0]).toEqual(
      expect.objectContaining({
        path: '/week/plans/plan_12345678/shopping/complete',
        method: 'POST',
        headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }),
      })
    );
    expect(JSON.parse(getPendingOps()[0].body || '{}').items).toHaveLength(2);
    expect(JSON.parse(getPendingOps()[0].body || '{}').commandId).toBe(
      getPendingOps()[0].headers?.['Idempotency-Key']
    );
  });

  it('queues an offline weekly plan creation with a stable plan id', async () => {
    storage.setItem('frigo_user_id', 'user-a');
    storage.setItem('frigo_household_id', 'house-a');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    const plan = await api.createWeekPlan({
      householdId: 'house-a',
      startDate: '2026-09-07',
      householdSize: 2,
      mealSlotsPreset: 'dinner_only',
      budgetTargetVnd: 500000,
      priorities: ['use_fridge'],
      shoppingFrequency: 'once',
    });

    const op = getPendingOps()[0];
    expect(op.path).toBe('/week/plans');
    expect(op.headers?.['Idempotency-Key']).toBeTruthy();
    expect(plan.id).toBe(JSON.parse(op.body || '{}').planId);
  });
});
