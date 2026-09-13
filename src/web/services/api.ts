// Compatibility facade; domain modules retain ownership-fenced server and offline operations.
import { ApiError, fetchJson, isNonRetryable, getCurrentScope } from './http';
import { flush, pendingCount, getPendingOps } from '../lib/sync';
import { capturePrivateSession, privateSessionBlocked } from '../lib/private-session';
import { authApi } from './auth';
import { inventoryApi } from './inventory';
import { inventoryTruthApi } from './inventory-truth';
import { scansApi } from './scans';
import { recipesApi } from './recipes';
import { shoppingApi } from './shopping';
import { weekApi } from './week';
import { notificationsApi } from './notifications';
import { invalidateReplayedQueries } from '../lib/query-invalidation';

export { ApiError, isOffline, clearTenantCaches } from './http';
export type { ApiErrorKind } from './http';

export const api = {
  ...authApi,
  ...inventoryApi,
  ...inventoryTruthApi,
  ...scansApi,
  ...recipesApi,
  ...shoppingApi,
  ...weekApi,
  ...notificationsApi,

  confirmPlusPayment: async (
    cycle: 'monthly' | 'annual'
  ): Promise<{ success: boolean; granted: boolean; status: string; message?: string }> => {
    return fetchJson('/auth/plus/activate', {
      method: 'POST',
      body: JSON.stringify({ cycle }),
    });
  },

  createPaymentIntent: async (plan: 'monthly' | 'annual') => {
    return fetchJson<{ success: boolean; payment: { id: string; orderCode: string; amountVnd: number; currency: string; plan: string; description: string; expiresAt: string } }>('/billing/payment-intents', {
      method: 'POST',
      body: JSON.stringify({ plan }),
    });
  },

  retryPendingWrites: async (): Promise<{ attempted: number; remaining: number }> => {
    const scope = getCurrentScope();
    if (privateSessionBlocked() || !scope.userId || !scope.householdId ||
      !getPendingOps().some((op) => op.userId === scope.userId && op.householdId === scope.householdId)) {
      return { attempted: 0, remaining: pendingCount() };
    }
    const isCurrent = capturePrivateSession();
    const replayedPaths: string[] = [];
    const result = await flush(
      async (op) => {
        if (!isCurrent()) throw new ApiError('auth', 'Đồng bộ riêng tư đã tạm dừng.');
        // The cookie may have changed in another tab. Local storage is not authorization.
        const me = await api.getMe({ requireServer: true });
        if (!isCurrent() || me.user?.id !== op.userId || me.user?.household?.id !== op.householdId) {
          throw new ApiError('auth', 'Chủ sở hữu thao tác không khớp với phiên máy chủ.');
        }
        await fetchJson(op.path, { method: op.method, body: op.body, headers: op.headers });
        if (isCurrent()) replayedPaths.push(op.path);
      },
      isNonRetryable,
      { scope: getCurrentScope, canReplay: isCurrent }
    );
    if (result.attempted > 0 && isCurrent()) {
      try {
        await api.getInventory();
        await api.getShoppingList();
        await api.getCurrentWeekPlan();
      } catch {
        // reconcile best-effort
      }
      if (isCurrent()) await invalidateReplayedQueries(replayedPaths);
    }
    return result;
  },
};
