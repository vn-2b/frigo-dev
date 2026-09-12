import { rebindPendingOps } from '../lib/sync';
import { LOGOUT_PENDING_KEY, isOfflineGuestSession } from '../lib/private-session';
import {
  BASE_URL, ApiError, fetchJson, isOffline, getCurrentScope, getUserId, getHouseholdId,
  guardPrivateSession, handleUnauthorized,
} from './http';

// DEC-012: the server refuses guest→account inventory transfer before consuming
// the OTP; the same code stays valid for a retry without the transfer field.
export const INVENTORY_TRANSFER_DEFERRED = 'INVENTORY_TRANSFER_DEFERRED';

export function isInventoryTransferDeferred(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === INVENTORY_TRANSFER_DEFERRED;
}

export const authApi = {
  logout: async (): Promise<void> => {
    const response = await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST', credentials: 'include', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || (await response.json() as { success?: boolean }).success !== true) {
      throw new Error('Logout not confirmed');
    }
  },

  getMe: async (options?: { requireServer?: boolean }) => {
    const assertCurrent = guardPrivateSession();
    try {
      const result = await fetchJson<any>('/me');
      assertCurrent();
      const scope = getCurrentScope();
      if (result.user?.id !== scope.userId || result.user?.household?.id !== scope.householdId) {
        localStorage.setItem(LOGOUT_PENDING_KEY, 'true');
        handleUnauthorized();
        throw new ApiError('auth', 'Danh tính phiên máy chủ đã thay đổi. Vui lòng đăng xuất và đăng nhập lại.');
      }
      return result;
    } catch (err) {
      assertCurrent();
      if (options?.requireServer || !isOffline(err) || !isOfflineGuestSession()) throw err;
      return {
        user: {
          id: getUserId(),
          displayName: 'Bạn mới của Frigo',
          isGuest: true,
          household: { id: getHouseholdId(), name: 'Tủ lạnh nhà tôi' },
          subscription: null,
        }
      };
    }
  },

  getPublicConfig: async () => {
    try {
      return await fetchJson<{ turnstileSiteKey: string | null }>('/config');
    } catch (err) {
      if (!isOffline(err)) throw err;
      return { turnstileSiteKey: null as string | null };
    }
  },

  register: async (name: string, email: string, password: string, turnstileToken?: string | null) => {
    try {
      return await fetchJson<{ success: boolean; message: string; email: string; devOtp?: string }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, turnstileToken }),
      });
    } catch (err: any) {
      // SEC-04: never fake a successful registration — surface the real error.
      console.warn('Backend register failed:', err);
      throw err;
    }
  },

  verifyOtp: async (
    email: string,
    code: string,
    purpose: 'register' | 'forgot_password',
    migrateFromHouseholdId?: string | null
  ) => {
    const assertCurrent = guardPrivateSession();
    try {
      const result = await fetchJson<{ success: boolean; user?: any; resetToken?: string; migratedFromHouseholdId?: string }>('/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({
          email,
          code,
          purpose,
          ...(purpose === 'register' && migrateFromHouseholdId
            ? { migrateFromHouseholdId }
            : {}),
        }),
      });
      assertCurrent();

      // Preserve offline guest mutations when the same guest household is
      // migrated into the newly registered account.
      if (
        purpose === 'register' &&
        migrateFromHouseholdId &&
        result.migratedFromHouseholdId === migrateFromHouseholdId &&
        result.success &&
        result.user?.id &&
        result.user?.householdId
      ) {
        const current = getCurrentScope();
        if (current.householdId === migrateFromHouseholdId) {
          rebindPendingOps(current, {
            userId: result.user.id,
            householdId: result.user.householdId,
          });
        }
      }

      return result;
    } catch (err: any) {
      // SEC-04: never fake a verified session — surface the real error.
      console.warn('Backend verify OTP failed:', err);
      throw err;
    }
  },

  resendOtp: async (email: string, purpose: string, turnstileToken?: string | null) => {
    try {
      return await fetchJson<{ success: boolean; message: string; devOtp?: string }>('/auth/resend-otp', {
        method: 'POST',
        body: JSON.stringify({ email, purpose, turnstileToken }),
      });
    } catch (err: any) {
      // SEC-04: surface the real error instead of a fake OTP.
      console.warn('Backend resend OTP failed:', err);
      throw err;
    }
  },

  login: async (email: string, password: string, turnstileToken?: string | null) => {
    try {
      return await fetchJson<{ success: boolean; user: any }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, turnstileToken }),
      });
    } catch (err: any) {
      // SEC-04: never fake a login session — surface the real error.
      console.warn('Backend login failed:', err);
      throw err;
    }
  },

  forgotPassword: async (email: string, turnstileToken?: string | null) => {
    try {
      return await fetchJson<{ success: boolean; message: string; devOtp?: string }>('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email, turnstileToken }),
      });
    } catch (err: any) {
      // SEC-04: surface the real error instead of a fake OTP.
      console.warn('Backend forgot-password failed:', err);
      throw err;
    }
  },

  resetPassword: async (email: string, code: string, newPassword: string) => {
    try {
      return await fetchJson<{ success: boolean; message: string; user?: { id: string; email: string; displayName: string; householdId: string } }>('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email, code, newPassword }),
      });
    } catch (err: any) {
      // SEC-04: surface the real error instead of faking success.
      console.warn('Backend reset-password failed:', err);
      throw err;
    }
  },

  loginWithGoogle: async (credential?: string, userInfo?: any) => {
    try {
      return await fetchJson<{ success: boolean; user: any }>('/auth/google', {
        method: 'POST',
        body: JSON.stringify({ credential, userInfo }),
      });
    } catch (err: any) {
      // SEC-04: never fake a Google session — surface the real error.
      console.warn('Backend Google auth failed:', err);
      throw err;
    }
  },
};
