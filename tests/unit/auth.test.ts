import { describe, it, expect, vi, afterEach } from 'vitest';
import { signJwt, verifyJwt } from '../../src/worker/utils/jwt';
import { isOtpProtectionAvailable, shouldConsumeOtpOnVerify } from '../../src/worker/utils/otp';
import { hashPassword, generateSalt, verifyPassword } from '../../src/worker/utils/password';
import { RegisterSchema, LoginSchema, VerifyOtpSchema, InventoryCreateSchema } from '../../src/worker/validation/schemas';
import { verifyGoogleToken, GOOGLE_OAUTH_CLIENT_ID } from '../../src/worker/utils/oauth';

describe('Zero-Trust Security & Cryptography Unit Tests', () => {
  const TEST_SECRET = 'unit-test-super-secure-jwt-secret-key-2026';

  it('fails closed when shared OTP protection storage is unavailable', () => {
    expect(isOtpProtectionAvailable({ CACHE: undefined })).toBe(false);
    expect(isOtpProtectionAvailable({ CACHE: {} as any })).toBe(true);
  });

  it('leaves password-reset OTP for the final reset endpoint to consume', () => {
    expect(shouldConsumeOtpOnVerify('register')).toBe(true);
    expect(shouldConsumeOtpOnVerify('login')).toBe(true);
    expect(shouldConsumeOtpOnVerify('forgot_password')).toBe(false);
  });

  describe('JWT Cryptographic Signing and Verification', () => {
    it('should sign and verify valid JWT tokens', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const token = await signJwt(
        {
          sub: 'usr_test_123',
          hid: 'hh_test_123',
          typ: 'access',
          email: 'test@frigo.local',
          role: 'owner',
          exp: nowSec + 3600,
        },
        TEST_SECRET
      );

      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);

      const result = await verifyJwt(token, TEST_SECRET);
      expect(result.valid).toBe(true);
      expect(result.payload?.sub).toBe('usr_test_123');
      expect(result.payload?.hid).toBe('hh_test_123');
      expect(result.payload?.email).toBe('test@frigo.local');
    });

    it('should reject tampered JWT tokens', async () => {
      const token = await signJwt(
        {
          sub: 'usr_test_123',
          hid: 'hh_test_123',
          typ: 'access',
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        TEST_SECRET
      );

      const parts = token.split('.');
      // Tamper with payload (sub changed to victim)
      const tamperedPayload = btoa(JSON.stringify({ sub: 'usr_victim_456', exp: 9999999999 }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      const result = await verifyJwt(tamperedToken, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Invalid JWT signature/);
    });

    it('should reject tokens signed with a different secret', async () => {
      const token = await signJwt(
        {
          sub: 'usr_test_123',
          hid: 'hh_test_123',
          typ: 'access',
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        TEST_SECRET
      );

      const result = await verifyJwt(token, 'attacker-different-secret');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Invalid JWT signature/);
    });

    it('should reject expired JWT tokens', async () => {
      const pastSec = Math.floor(Date.now() / 1000) - 100;
      const expiredToken = await signJwt(
        {
          sub: 'usr_test_123',
          hid: 'hh_test_123',
          typ: 'access',
          exp: pastSec,
        },
        TEST_SECRET
      );

      const result = await verifyJwt(expiredToken, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/expired/);
    });
  });

  describe('PBKDF2-HMAC-SHA256 Password Hasher', () => {
    it('should hash passwords deterministically and verify accurately', async () => {
      const password = 'SuperStrongPassword!2026';
      const salt = generateSalt();

      const hash1 = await hashPassword(password, salt);
      const hash2 = await hashPassword(password, salt);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // 256 bits = 64 hex chars

      // Verify correct password
      const isValid = await verifyPassword(password, salt, hash1);
      expect(isValid).toBe(true);

      // Verify wrong password fails
      const isInvalid = await verifyPassword('WrongPassword123', salt, hash1);
      expect(isInvalid).toBe(false);
    });

    it('should generate unique salts', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      expect(salt1).not.toBe(salt2);
      expect(salt1.length).toBe(32); // 16 bytes = 32 hex chars
    });
  });

  describe('Zod Schema Validation Tests', () => {
    it('should validate registration payloads strictly', () => {
      const valid = RegisterSchema.safeParse({
        name: 'Nguyen Van A',
        email: 'test@example.com',
        password: 'password123',
      });
      expect(valid.success).toBe(true);

      const validLogin = LoginSchema.safeParse({
        email: 'test@example.com',
        password: 'password123',
      });
      expect(validLogin.success).toBe(true);

      const invalidEmail = RegisterSchema.safeParse({
        name: 'Nguyen Van A',
        email: 'not-an-email',
        password: 'password123',
      });
      expect(invalidEmail.success).toBe(false);

      const shortPassword = RegisterSchema.safeParse({
        name: 'Nguyen Van A',
        email: 'test@example.com',
        password: '123',
      });
      expect(shortPassword.success).toBe(false);
    });

    it('should validate 6-digit OTP codes strictly', () => {
      const valid = VerifyOtpSchema.safeParse({
        email: 'test@example.com',
        code: '123456',
        purpose: 'register',
      });
      expect(valid.success).toBe(true);

      const invalidCode = VerifyOtpSchema.safeParse({
        email: 'test@example.com',
        code: '12345', // only 5 digits
        purpose: 'register',
      });
      expect(invalidCode.success).toBe(false);

      const letterCode = VerifyOtpSchema.safeParse({
        email: 'test@example.com',
        code: '12A456',
        purpose: 'register',
      });
      expect(letterCode.success).toBe(false);
    });

    it('should reject invalid inventory inputs (e.g. negative quantities or empty names)', () => {
      const valid = InventoryCreateSchema.safeParse({
        name: 'Thịt bò',
        quantity: 500,
        unit: 'g',
        storage: 'fridge',
      });
      expect(valid.success).toBe(true);

      const negativeQty = InventoryCreateSchema.safeParse({
        name: 'Thịt bò',
        quantity: -5,
        unit: 'g',
      });
      expect(negativeQty.success).toBe(false);

      const emptyName = InventoryCreateSchema.safeParse({
        name: '',
        quantity: 1,
      });
      expect(emptyName.success).toBe(false);
    });
  });

  describe('SEC-8: Google ID Token audience binding', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function makeIdToken(payload: Record<string, unknown>): string {
      const b64 = (obj: unknown) =>
        btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return `${b64({ alg: 'RS256', kid: 'test' })}.${b64(payload)}.${b64({ sig: 'x' })}`;
    }

    it('should accept a token whose aud matches our OAuth client', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              sub: 'g_user_1',
              email: 'user@example.com',
              email_verified: 'true',
              name: 'Tester',
              aud: GOOGLE_OAUTH_CLIENT_ID,
            }),
            { status: 200 }
          )
        )
      );

      const result = await verifyGoogleToken(makeIdToken({ aud: GOOGLE_OAUTH_CLIENT_ID }));
      expect(result.valid).toBe(true);
      expect(result.user?.email).toBe('user@example.com');
    });

    it('should reject a token minted for a different OAuth client (aud mismatch)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              sub: 'g_attacker',
              email: 'attacker@example.com',
              email_verified: 'true',
              name: 'Attacker',
              aud: '999999-other-app-client-id.apps.googleusercontent.com',
            }),
            { status: 200 }
          )
        )
      );

      const result = await verifyGoogleToken(makeIdToken({ aud: '999999-other-app-client-id' }));
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/different application/);
    });

    it('should reject a token missing the aud claim entirely', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              sub: 'g_noaud',
              email: 'noaud@example.com',
              email_verified: 'true',
            }),
            { status: 200 }
          )
        )
      );

      const result = await verifyGoogleToken(makeIdToken({}));
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/different application/);
    });
  });

  describe('S1: legacy guest-token ownership claims', () => {
    // Valid ownership claims do not override the T09F transfer deferral.
    async function guestOwnershipClaim(presentedToken: string, targetHouseholdId: string) {
      const v = await verifyJwt(presentedToken, TEST_SECRET);
      return (
        v.valid === true &&
        v.payload?.typ === 'guest' &&
        v.payload?.isGuest === true &&
        v.payload?.hid === targetHouseholdId
      );
    }

    async function mintToken(claims: Record<string, unknown>) {
      return signJwt(
        { exp: Math.floor(Date.now() / 1000) + 3600, ...claims } as any,
        TEST_SECRET
      );
    }

    it('recognizes the owner’s valid guest claim', async () => {
      const guestToken = await mintToken({ sub: 'guest_1', hid: 'hh_guest_1', typ: 'guest', isGuest: true });
      expect(await guestOwnershipClaim(guestToken, 'hh_guest_1')).toBe(true);
    });

    it('rejects a claim for another visitor household', async () => {
      // Attacker registers their own account but points migrateFromHouseholdId at
      // a victim's guest household (ids are hh_guest_<timestamp>, guessable).
      const attackerGuestToken = await mintToken({ sub: 'guest_a', hid: 'hh_guest_a', typ: 'guest', isGuest: true });
      expect(await guestOwnershipClaim(attackerGuestToken, 'hh_guest_victim')).toBe(false);
    });

    it('rejects a non-guest token as a guest ownership claim', async () => {
      const userToken = await mintToken({ sub: 'usr_1', hid: 'hh_usr_1', typ: 'access' });
      expect(await guestOwnershipClaim(userToken, 'hh_usr_1')).toBe(false);
    });

    it('rejects a forged token signed with the wrong secret', async () => {
      const forged = await signJwt(
        { sub: 'guest_x', hid: 'hh_guest_x', typ: 'guest', isGuest: true, exp: Math.floor(Date.now() / 1000) + 3600 },
        'attacker-secret'
      );
      expect(await guestOwnershipClaim(forged, 'hh_guest_x')).toBe(false);
    });

    it('rejects an expired guest token', async () => {
      const expired = await signJwt(
        { sub: 'guest_x', hid: 'hh_guest_x', typ: 'guest', isGuest: true, exp: Math.floor(Date.now() / 1000) - 10 },
        TEST_SECRET
      );
      expect(await guestOwnershipClaim(expired, 'hh_guest_x')).toBe(false);
    });
  });
});
