import { Hono } from 'hono';
import { Env, AuthContext } from '../types';
import { SQL } from '@frigo/db';
import { hashPassword, generateSalt, verifyPassword } from '../utils/password';
import { signJwt } from '../utils/jwt';
import { generateSessionToken, sha256Hex, SESSION_COOKIE } from '../utils/session';
import { createOtpDigest, verifyOtpDigest, OTP_DIGEST_VERSION } from '../utils/otp-digest';
import { SCAN_QUOTA_POLICY } from '../config/scan-quota-policy';
import { verifyGoogleToken } from '../utils/oauth';
import { verifyTurnstileToken } from '../utils/turnstile';
import { getJwtSecret } from '../middleware/auth';
import { hasTrustedOrigin } from '../middleware/csrf';
import { sendEmail, buildOtpEmail } from '../services/email';
import { shouldConsumeOtpOnVerify } from '../utils/otp';
import { getScanQuota } from '../services/scan-quota';

// Persist digests before delivery; reset email latency stays outside the response path.
async function issueAndSendOtp(
  db: any,
  env: Env,
  email: string,
  purpose: 'register' | 'forgot_password' | 'login',
  issue = true,
  scheduleDelivery?: (task: Promise<void>) => void,
): Promise<{ code: string; emailSent: boolean; provider: string }> {
  const otpCode = generateOtp();
  const otpId = `otp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const otpSecret = env.OTP_HASH_SECRET;
  if (!otpSecret) throw new Error('OTP_HASH_SECRET is not configured');
  const digest = await createOtpDigest(email, purpose, otpCode, otpSecret);
  // Unknown reset accounts do equivalent random/HMAC work, without storing or mailing a challenge.
  if (!issue) return { code: otpCode, emailSent: false, provider: 'none' };
  const insert = db
    .prepare('INSERT INTO auth_otps (id, email, code_digest, digest_version, purpose, expires_at, used, attempt_count) VALUES (?, ?, ?, ?, ?, ?, 0, 0)')
    .bind(otpId, email, digest, OTP_DIGEST_VERSION, purpose, expiresAt);
  if (purpose === 'forgot_password') {
    const results = await db.batch([
      db.prepare("UPDATE auth_otps SET used = 1, used_at = datetime('now') WHERE email = ? AND purpose = ? AND used = 0")
        .bind(email, purpose),
      insert,
    ]);
    if (results.some((result: { success: boolean }) => !result.success)) throw new Error('OTP_PERSIST_FAILED');
  } else {
    await insert.run();
  }

  const { subject, html, text } = buildOtpEmail(otpCode, purpose);
  const deliver = async () => {
    const result = await sendEmail(env, { to: email, subject, html, text });
    if (!result.sent) {
      console.error(JSON.stringify({ event: 'otp_delivery_failed', provider: result.provider }));
    }
    return result;
  };
  if (scheduleDelivery) {
    scheduleDelivery(deliver().then(() => {}).catch(() => {
      console.error(JSON.stringify({ event: 'otp_delivery_failed' }));
    }));
    return { code: otpCode, emailSent: false, provider: 'scheduled' };
  }
  const result = await deliver();
  return { code: otpCode, emailSent: result.sent, provider: result.provider };
}

async function requestPasswordReset(db: Env['DB'], env: Env, email: string, scheduleDelivery: (task: Promise<void>) => void) {
  const account = await db!.prepare('SELECT user_id FROM auth_accounts WHERE email = ?').bind(email).first();
  let devOtp: string | undefined;
  try {
    const result = await issueAndSendOtp(db, env, email, 'forgot_password', Boolean(account), scheduleDelivery);
    devOtp = result.code;
  } catch {
    // Delivery/storage failures must not become a membership oracle.
    console.error(JSON.stringify({ event: 'password_reset_issue_failed' }));
  }
  return {
    success: true,
    message: 'Nếu email này có tài khoản Frigo, hướng dẫn đặt lại mật khẩu sẽ được gửi đến email của bạn.',
    ...(env.ENVIRONMENT === 'development' ? { devOtp } : {}),
  };
}
import { rateLimiter } from '../middleware/rate-limit';
import {
  RegisterSchema,
  LoginSchema,
  VerifyOtpSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  ResendOtpSchema,
  GoogleAuthSchema,
} from '../validation/schemas';

export const authRoutes = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

// Session bootstrap also needs CSRF protection before a cookie exists.
for (const path of ['login', 'register', 'verify-otp', 'resend-otp', 'forgot-password', 'reset-password', 'google', 'guest', 'logout']) {
  authRoutes.use(`/auth/${path}`, async (c, next) => {
    if (c.req.method === 'POST' && c.env.ENVIRONMENT === 'production' && !hasTrustedOrigin(c)) {
      return c.json({ error: 'Cross-site request blocked', code: 'CSRF_ORIGIN_DENIED' }, 403);
    }
    return next();
  });
}

// Apply rate limiting to all auth endpoints (max 15 requests per minute)
authRoutes.use('/auth/*', rateLimiter({ maxRequests: 15, windowSeconds: 60, prefix: 'rl_auth' }));

function generateOtp(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(100000 + (array[0] % 900000));
}

function setSessionCookie(c: any, token: string): void {
  c.header('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 86400}`);
}

const OTP_MAX_FAILURES = 5;
const OTP_LOCK_SECONDS = 15 * 60;
const OTP_RESEND_COOLDOWN_SECONDS = 60;

async function getLatestOtp(
  db: any,
  email: string,
  purpose: string
): Promise<any | null> {
  return db.prepare(
    `SELECT id, expires_at, used, used_at, code_digest, digest_version, attempt_count, locked_until
       FROM auth_otps
      WHERE email = ? AND purpose = ? AND used = 0
      ORDER BY created_at DESC LIMIT 1`
  ).bind(email, purpose).first();
}

async function markOtpFailure(db: any, otp: any): Promise<number> {
  const result: any = await db.prepare(
    `UPDATE auth_otps
        SET attempt_count = attempt_count + 1,
            locked_until = CASE WHEN attempt_count + 1 >= ? THEN datetime('now', '+15 minutes') ELSE locked_until END
      WHERE id = ? AND used = 0 AND attempt_count < 5
        AND (locked_until IS NULL OR datetime(locked_until) <= datetime('now'))`
  ).bind(OTP_MAX_FAILURES, otp.id).run();
  if (result?.meta?.changes !== 1) return OTP_MAX_FAILURES;
  const row: any = await db.prepare('SELECT attempt_count FROM auth_otps WHERE id = ?').bind(otp.id).first();
  return Number(row?.attempt_count || 0);
}

async function consumeOtp(db: Env['DB'], id: string): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE auth_otps SET used = 1, used_at = datetime('now')
      WHERE id = ? AND used = 0 AND datetime(expires_at) > datetime('now')
        AND attempt_count < ?
        AND (locked_until IS NULL OR datetime(locked_until) <= datetime('now'))`
  ).bind(id, OTP_MAX_FAILURES).run();
  return result.meta?.changes === 1;
}

// Persist only the hash of the opaque cookie credential.
async function createSessionAndToken(
  db: any,
  _env: Env,
  user: { id: string; email: string; householdId: string; role?: string; isGuest?: boolean }
): Promise<string> {
  if (!db) throw new Error('SESSION_PERSIST_FAILED');
  const token = generateSessionToken();
  const tokenHash = await sha256Hex(token);
  const expSec = Math.floor(Date.now() / 1000) + 7 * 86400;

  // Persist session to D1 if available
  if (db) {
    try {
      const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const expiresAt = new Date(expSec * 1000).toISOString();
      await db
        .prepare('INSERT INTO sessions_v2 (id, user_id, household_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)')
        .bind(sessionId, user.id, user.householdId, tokenHash, expiresAt)
        .run();
    } catch {
      console.error(JSON.stringify({ event: 'session_persist_failed' }));
      throw new Error('SESSION_PERSIST_FAILED');
    }
  }

  return token;
}

// 1. GET /me — Current User Profile
authRoutes.get('/me', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  try {
    const userRow: any = await db.prepare(SQL.GET_USER_PROFILE).bind(auth.householdId, auth.userId).first();
    const prefRow: any = await db.prepare(SQL.GET_USER_PREFERENCES).bind(auth.userId).first();

    const quota = await getScanQuota(db, auth.userId);

    return c.json({
      user: {
        id: auth.userId,
        email: userRow?.email || auth.email || `${auth.userId}@frigo.local`,
        isGuest: Boolean(userRow?.is_guest ?? auth.isGuest),
        isPlus: quota.isPlus,
        displayName: userRow?.display_name || (auth.isGuest ? 'Khách ghé thăm' : 'Người dùng Frigo'),
        avatarUrl: userRow?.avatar_url || '/icons/favicon.svg',
        household: {
          id: userRow?.household_id || auth.householdId,
          name: userRow?.household_name || 'Tủ lạnh của tôi',
        },
        preferences: prefRow
          ? {
              householdSize: prefRow.household_size,
              spicyLevel: prefRow.spicy_level,
              favoriteCuisines: JSON.parse(prefRow.favorite_cuisines || '["vietnamese"]'),
              dietaryRestrictions: JSON.parse(prefRow.dietary_restrictions || '[]'),
            }
          : {
              householdSize: 2,
              spicyLevel: 'medium',
              favoriteCuisines: ['vietnamese', 'korean'],
              dietaryRestrictions: [],
            },
        subscription: {
          ...quota,
          maxScans: quota.limit,
          scansUsed: quota.used,
        },
      },
    });
  } catch {
    console.error(JSON.stringify({ event: 'profile_load_failed' }));
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }
});

// 2. POST /auth/register — Register new account
authRoutes.post('/auth/register', async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));

  // Production requires bot protection before account lookup.
  const turnstile = await verifyTurnstileToken(
    c.env,
    rawBody?.turnstileToken,
    c.req.header('cf-connecting-ip')
  );
  if (!turnstile.ok) {
    return c.json({ error: 'Xác thực chống bot thất bại. Vui lòng thử lại.', code: 'TURNSTILE_FAILED' }, 403);
  }

  const parseResult = RegisterSchema.safeParse(rawBody);

  if (!parseResult.success) {
    return c.json(
      {
        error: parseResult.error.errors[0]?.message || 'Dữ liệu đăng ký không hợp lệ',
        code: 'VALIDATION_ERROR',
      },
      400
    );
  }

  const { name, email, password } = parseResult.data;
  const normalizedEmail = email.trim().toLowerCase();
  const db = c.env.DB;

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  try {
    // Check if account already exists and is verified
    const existing: any = await db
      .prepare('SELECT id, user_id, is_verified FROM auth_accounts WHERE email = ?')
      .bind(normalizedEmail)
      .first();

    if (existing && existing.is_verified === 1) {
      return c.json({ error: 'Email này đã được đăng ký. Vui lòng đăng nhập.' }, 409);
    }

    // `auth_accounts.id` is not required to equal `user_id` in the schema;
    // preserve the existing principal when retrying an unverified signup.
    const userId = existing?.user_id || existing?.id || `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const salt = generateSalt();
    const hash = await hashPassword(password, salt); // PBKDF2 100k rounds

    // Create or update core user and profile atomically
    await db.batch([
      // Do not use INSERT OR REPLACE here: replacing a parent user row can
      // cascade-delete sessions, inventory, and household data.
      db.prepare(
        `INSERT INTO users (id, email, is_guest) VALUES (?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET email = excluded.email, is_guest = 0, updated_at = datetime('now')`
      ).bind(userId, normalizedEmail),
      db.prepare(
        `INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, updated_at = datetime('now')`
      ).bind(
        `prof_${userId}`,
        userId,
        name.trim()
      ),
      db.prepare(
        `INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = datetime('now')`
      ).bind(
        `hh_${userId}`,
        `Tủ lạnh của ${name.trim()}`,
        userId
      ),
      db.prepare(
        `INSERT INTO household_members (id, household_id, user_id, role) VALUES (?, ?, ?, ?)
         ON CONFLICT(household_id, user_id) DO UPDATE SET role = excluded.role`
      ).bind(`hm_${userId}`, `hh_${userId}`, userId, 'owner'),
      db.prepare(
        `INSERT INTO auth_accounts (id, user_id, email, password_hash, salt, is_verified)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(email) DO UPDATE SET
           user_id = excluded.user_id,
           password_hash = excluded.password_hash,
           salt = excluded.salt,
           is_verified = 0,
           updated_at = datetime('now')`
      ).bind(userId, userId, normalizedEmail, hash, salt),
      db.prepare(
        `INSERT OR IGNORE INTO user_preferences
          (id, user_id, household_size, spicy_level, favorite_cuisines, dietary_restrictions)
         VALUES (?, ?, 2, 'medium', '["vietnamese"]', '[]')`
      ).bind(`pref_${userId}`, userId),
      db.prepare(
        `INSERT OR IGNORE INTO subscriptions
          (id, user_id, plan, status, scan_count_current_month, max_scans_per_month)
         VALUES (?, ?, 'free', 'active', 0, ?)`
      ).bind(`sub_${userId}`, userId, SCAN_QUOTA_POLICY.free),
      db.prepare(
        'INSERT OR IGNORE INTO shopping_lists (id, household_id, name) VALUES (?, ?, ?)'
      ).bind(`list_hh_${userId}`, `hh_${userId}`, 'Danh sách mua sắm'),
    ]);

    // Generate 6-digit OTP code valid for 10 minutes + deliver via email
    const { code: otpCode, emailSent } = await issueAndSendOtp(db, c.env, normalizedEmail, 'register');

    const isProduction = c.env.ENVIRONMENT === 'production';
    const responseData: any = {
      success: true,
      message: emailSent
        ? 'Mã xác thực OTP đã được tạo và gửi đến email của bạn'
        : 'Tài khoản đã tạo. Không thể gửi email lúc này — vui lòng thử gửi lại mã sau.',
      email: normalizedEmail,
      expiresInMinutes: 10,
    };

    // SEC-02 FIX: NEVER leak devOtp in production responses
    if (!isProduction) {
      responseData.devOtp = otpCode;
    }

    return c.json(responseData);
  } catch {
    console.error(JSON.stringify({ event: 'registration_failed' }));
    return c.json({ error: 'Không thể tạo tài khoản' }, 500);
  }
});

// 3. POST /auth/verify-otp — Verify OTP for Register or Forgot Password
authRoutes.post('/auth/verify-otp', async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));
  const parseResult = VerifyOtpSchema.safeParse(rawBody);

  if (!parseResult.success) {
    return c.json(
      {
        error: parseResult.error.errors[0]?.message || 'Dữ liệu OTP không hợp lệ',
        code: 'VALIDATION_ERROR',
      },
      400
    );
  }

  const { email, code, purpose } = parseResult.data;
  const normalizedEmail = email.trim().toLowerCase();
  const cleanCode = code.trim();
  const db = c.env.DB;

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  try {
    const otpRow: any = await getLatestOtp(db, normalizedEmail, purpose);
    if (!otpRow) return c.json({ error: 'Mã OTP không chính xác hoặc đã được sử dụng' }, 400);
    if (otpRow.attempt_count >= OTP_MAX_FAILURES || (otpRow.locked_until && new Date(otpRow.locked_until).getTime() > Date.now())) {
      c.header('Retry-After', String(OTP_LOCK_SECONDS));
      return c.json(
        { error: 'Bạn đã nhập sai quá 5 lần. Vui lòng đợi 15 phút rồi thử lại.' },
        429
      );
    }

    const secret = c.env.OTP_HASH_SECRET;
    if (!secret) return c.json({ error: 'Dịch vụ OTP chưa được cấu hình', code: 'OTP_PROTECTION_UNAVAILABLE' }, 503);
    const valid = Boolean(secret && otpRow.code_digest && (await verifyOtpDigest(normalizedEmail, purpose, cleanCode, otpRow.code_digest, otpRow.digest_version, secret)));
    if (!valid) {
      const attempts = await markOtpFailure(db, otpRow);
      if (attempts >= OTP_MAX_FAILURES) {
        c.header('Retry-After', String(OTP_LOCK_SECONDS));
        return c.json(
          { error: 'Bạn đã nhập sai quá 5 lần. Vui lòng đợi 15 phút rồi thử lại.' },
          429
        );
      }
      return c.json({ error: 'Mã OTP không chính xác hoặc đã được sử dụng' }, 400);
    }

    if (new Date(otpRow.expires_at).getTime() < Date.now()) {
      await markOtpFailure(db, otpRow);
      return c.json({ error: 'Mã OTP đã hết hạn. Vui lòng bấm gửi lại mã mới.' }, 400);
    }

    // Defer every transfer until ownership, lots, events and receipts can move atomically.
    if (purpose === 'register' && parseResult.data.migrateFromHouseholdId) {
      return c.json({
        error: 'Chưa hỗ trợ chuyển dữ liệu từ hộ khách một cách an toàn. Hàng tồn kho vẫn được giữ nguyên trong hộ khách; tài khoản chưa được kích hoạt và mã OTP chưa được sử dụng. Chỉ gửi lại yêu cầu không kèm migrateFromHouseholdId nếu bạn chọn giữ dữ liệu hộ khách và tài khoản mới riêng biệt.',
        code: 'INVENTORY_TRANSFER_DEFERRED',
      }, 409);
    }

    // Reset verification is preliminary; only the final reset consumes it.
    if (shouldConsumeOtpOnVerify(purpose) && !await consumeOtp(db, otpRow.id)) {
      return c.json({ error: 'Mã OTP không chính xác hoặc đã được sử dụng' }, 400);
    }

    if (purpose === 'register') {
      // Activate account
      await db.prepare('UPDATE auth_accounts SET is_verified = 1 WHERE email = ?').bind(normalizedEmail).run();

      const userRow: any = await db
        .prepare(
          'SELECT u.id, u.email, p.display_name, p.avatar_url FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.email = ?'
        )
        .bind(normalizedEmail)
        .first();

      const userId = userRow?.id;
      const householdId = `hh_${userId}`;

      // The reusable credential is returned only via the HttpOnly cookie.
      const token = await createSessionAndToken(db, c.env, {
        id: userId,
        email: normalizedEmail,
        householdId,
        role: 'owner',
      });
      setSessionCookie(c, token);

      return c.json({
        success: true,
        message: 'Xác thực tài khoản thành công!',
        user: {
          id: userId,
          email: userRow?.email,
          displayName: userRow?.display_name || 'Người dùng Frigo',
          avatarUrl: userRow?.avatar_url || '/icons/favicon.svg',
          householdId,
          isGuest: false,
        },
      });
    }

    if (purpose === 'forgot_password') {
      // Generate one-time reset token signed with HMAC
      const jwtSecret = getJwtSecret(c.env);
      const resetToken = await signJwt(
        {
          sub: normalizedEmail,
          hid: 'reset_flow',
          typ: 'reset',
          purpose: 'password_reset',
          exp: Math.floor(Date.now() / 1000) + 900, // 15 minutes
        },
        jwtSecret
      );

      return c.json({
        success: true,
        message: 'Mã OTP hợp lệ. Hãy nhập mật khẩu mới của bạn.',
        resetToken,
        email: normalizedEmail,
      });
    }

    return c.json({ success: true });
  } catch {
    console.error(JSON.stringify({ event: 'otp_verification_failed' }));
    return c.json({ error: 'Lỗi kiểm tra OTP' }, 500);
  }
});

// 4. POST /auth/resend-otp — Resend new OTP
authRoutes.post('/auth/resend-otp', async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));
  const turnstile = await verifyTurnstileToken(c.env, rawBody?.turnstileToken, c.req.header('cf-connecting-ip'));
  if (!turnstile.ok) {
    return c.json({ error: 'Xác thực chống bot thất bại. Vui lòng thử lại.', code: 'TURNSTILE_FAILED' }, 403);
  }
  const parsed = ResendOtpSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.errors[0]?.message || 'Email hoặc mục đích OTP không hợp lệ' },
      400
    );
  }

  const normalizedEmail = parsed.data.email.trim().toLowerCase();
  const purpose = parsed.data.purpose;
  const db = c.env.DB;

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  try {
    if (c.env.CACHE) {
      const cooldownKey = `otp_resend_${normalizedEmail}_${purpose}`;
      if (await c.env.CACHE.get(cooldownKey)) {
        c.header('Retry-After', String(OTP_RESEND_COOLDOWN_SECONDS));
        return c.json(
          {
            error: 'Vui lòng đợi 60 giây trước khi gửi lại mã OTP.',
            retryAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
          },
          429
        );
      }
      // Set before email delivery to prevent rapid sequential requests.
      await c.env.CACHE.put(cooldownKey, '1', {
        expirationTtl: OTP_RESEND_COOLDOWN_SECONDS,
      });
    }

    if (purpose === 'forgot_password') {
      return c.json(await requestPasswordReset(db, c.env, normalizedEmail, (task) => c.executionCtx.waitUntil(task)));
    }

    // Only the newest code remains valid for this flow.
    await db
      .prepare('UPDATE auth_otps SET used = 1 WHERE email = ? AND purpose = ? AND used = 0')
      .bind(normalizedEmail, purpose)
      .run();

    const { code: otpCode, emailSent } = await issueAndSendOtp(
      db,
      c.env,
      normalizedEmail,
      purpose
    );

    const isProduction = c.env.ENVIRONMENT === 'production';
    const responseData: any = {
      success: true,
      message: emailSent ? 'Đã tạo và gửi lại mã OTP mới' : 'Không thể gửi email lúc này — vui lòng thử lại sau.',
    };

    if (!isProduction) responseData.devOtp = otpCode;
    return c.json(responseData);
  } catch {
    return c.json({ error: 'Không thể gửi lại OTP' }, 500);
  }
});

// 5. POST /auth/login — Email/Password Login
authRoutes.post('/auth/login', async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));

  // Production requires bot protection before account lookup.
  const turnstile = await verifyTurnstileToken(
    c.env,
    rawBody?.turnstileToken,
    c.req.header('cf-connecting-ip')
  );
  if (!turnstile.ok) {
    return c.json({ error: 'Xác thực chống bot thất bại. Vui lòng thử lại.', code: 'TURNSTILE_FAILED' }, 403);
  }

  const parseResult = LoginSchema.safeParse(rawBody);

  if (!parseResult.success) {
    return c.json(
      {
        error: parseResult.error.errors[0]?.message || 'Email hoặc mật khẩu không hợp lệ',
        code: 'VALIDATION_ERROR',
      },
      400
    );
  }

  const { email, password } = parseResult.data;
  const normalizedEmail = email.trim().toLowerCase();
  const db = c.env.DB;

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  try {
    const account: any = await db
      .prepare(
        `SELECT a.user_id, a.password_hash, a.salt, a.is_verified, p.display_name, p.avatar_url
         FROM auth_accounts a
         LEFT JOIN profiles p ON p.user_id = a.user_id
         WHERE a.email = ?`
      )
      .bind(normalizedEmail)
      .first();

    if (!account) {
      return c.json({ error: 'Email hoặc mật khẩu không chính xác' }, 401);
    }

    // Verify PBKDF2 password
    const isPasswordValid = await verifyPassword(password, account.salt, account.password_hash);
    if (!isPasswordValid) {
      // Legacy SHA-256 fallback migration check
      const encoder = new TextEncoder();
      const data = encoder.encode(`${password}:${account.salt}`);
      const legacyHashBuffer = await crypto.subtle.digest('SHA-256', data);
      const legacyHash = Array.from(new Uint8Array(legacyHashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      if (legacyHash === account.password_hash) {
        // Upgrade legacy hash to PBKDF2 on the fly!
        const newSalt = generateSalt();
        const newPbkdf2Hash = await hashPassword(password, newSalt);
        await db
          .prepare('UPDATE auth_accounts SET password_hash = ?, salt = ? WHERE user_id = ?')
          .bind(newPbkdf2Hash, newSalt, account.user_id)
          .run();
      } else {
        return c.json({ error: 'Email hoặc mật khẩu không chính xác' }, 401);
      }
    }

    // Check email verification status
    if (account.is_verified === 0) {
      const { code: otpCode, emailSent } = await issueAndSendOtp(db, c.env, normalizedEmail, 'register');

      const isProduction = c.env.ENVIRONMENT === 'production';
      const responseData: any = {
        error: emailSent
          ? 'Tài khoản chưa hoàn tất xác thực OTP. Vui lòng xác thực mã gửi đến email.'
          : 'Tài khoản chưa hoàn tất xác thực OTP. Không thể gửi email lúc này — vui lòng thử gửi lại mã.',
        requireOtp: true,
        email: normalizedEmail,
      };

      if (!isProduction) {
        responseData.devOtp = otpCode;
      }

      return c.json(responseData, 403);
    }

    const householdId = `hh_${account.user_id}`;

    // SEC-04 FIX: Return signed cryptographic JWT
    const token = await createSessionAndToken(db, c.env, {
      id: account.user_id,
      email: normalizedEmail,
      householdId,
      role: 'owner',
    });
    setSessionCookie(c, token);

    return c.json({
      success: true,
      user: {
        id: account.user_id,
        email: normalizedEmail,
        displayName: account.display_name || 'Người dùng Frigo',
        avatarUrl: account.avatar_url || '/icons/favicon.svg',
        householdId,
        isGuest: false,
      },
    });
  } catch {
    console.error(JSON.stringify({ event: 'login_failed' }));
    return c.json({ error: 'Đăng nhập thất bại' }, 500);
  }
});

// 6. POST /auth/forgot-password — Request OTP for password reset
authRoutes.post('/auth/forgot-password', async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));

  // Production requires bot protection before account lookup.
  const turnstile = await verifyTurnstileToken(
    c.env,
    rawBody?.turnstileToken,
    c.req.header('cf-connecting-ip')
  );
  if (!turnstile.ok) {
    return c.json({ error: 'Xác thực chống bot thất bại. Vui lòng thử lại.', code: 'TURNSTILE_FAILED' }, 403);
  }

  const parseResult = ForgotPasswordSchema.safeParse(rawBody);

  if (!parseResult.success) {
    return c.json({ error: 'Email không hợp lệ' }, 400);
  }

  const normalizedEmail = parseResult.data.email.trim().toLowerCase();
  const db = c.env.DB;

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  try {
    return c.json(await requestPasswordReset(db, c.env, normalizedEmail, (task) => c.executionCtx.waitUntil(task)));
  } catch {
    return c.json({ error: 'Không thể tạo yêu cầu quên mật khẩu', code: 'RESET_REQUEST_UNAVAILABLE' }, 503);
  }
});

// 7. POST /auth/reset-password — Confirm OTP and set new password
authRoutes.post('/auth/reset-password', async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));
  const parseResult = ResetPasswordSchema.safeParse(rawBody);

  if (!parseResult.success) {
    return c.json(
      {
        error: parseResult.error.errors[0]?.message || 'Dữ liệu đặt lại mật khẩu không hợp lệ',
        code: 'VALIDATION_ERROR',
      },
      400
    );
  }

  const { email, code, newPassword } = parseResult.data;
  const normalizedEmail = email.trim().toLowerCase();
  const cleanCode = code.trim();
  const db = c.env.DB;

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  try {
    const otpPurpose = 'forgot_password';
    const otpRow: any = await getLatestOtp(db, normalizedEmail, otpPurpose);
    if (!otpRow) return c.json({ error: 'Mã OTP không chính xác hoặc đã được sử dụng' }, 400);
    if (otpRow.attempt_count >= OTP_MAX_FAILURES || (otpRow.locked_until && new Date(otpRow.locked_until).getTime() > Date.now())) {
      c.header('Retry-After', String(OTP_LOCK_SECONDS));
      return c.json(
        { error: 'Bạn đã nhập sai quá 5 lần. Vui lòng đợi 15 phút rồi thử lại.' },
        429
      );
    }

    const secret = c.env.OTP_HASH_SECRET;
    if (!secret) return c.json({ error: 'Dịch vụ OTP chưa được cấu hình', code: 'OTP_PROTECTION_UNAVAILABLE' }, 503);
    const valid = Boolean(secret && otpRow.code_digest && (await verifyOtpDigest(normalizedEmail, 'forgot_password', cleanCode, otpRow.code_digest, otpRow.digest_version, secret)));
    if (!valid) {
      const attempts = await markOtpFailure(db, otpRow);
      if (attempts >= OTP_MAX_FAILURES) {
        c.header('Retry-After', String(OTP_LOCK_SECONDS));
        return c.json(
          { error: 'Bạn đã nhập sai quá 5 lần. Vui lòng đợi 15 phút rồi thử lại.' },
          429
        );
      }
      return c.json({ error: 'Mã OTP không chính xác hoặc đã được sử dụng' }, 400);
    }

    if (new Date(otpRow.expires_at).getTime() < Date.now()) {
      await markOtpFailure(db, otpRow);
      return c.json({ error: 'Mã OTP đã hết hạn. Vui lòng thử lại.' }, 400);
    }

    // Consume atomically so concurrent reset requests cannot both succeed.
    if (!await consumeOtp(db, otpRow.id)) {
      return c.json({ error: 'Mã OTP không chính xác hoặc đã được sử dụng' }, 400);
    }

    // Update password with PBKDF2 100k rounds
    const salt = generateSalt();
    const hash = await hashPassword(newPassword, salt);

    await db.batch([
      db.prepare("UPDATE auth_accounts SET password_hash = ?, salt = ?, updated_at = datetime('now') WHERE email = ?")
        .bind(hash, salt, normalizedEmail),
      db.prepare(`UPDATE sessions_v2 SET revoked_at = datetime('now')
        WHERE user_id = (SELECT user_id FROM auth_accounts WHERE email = ?) AND revoked_at IS NULL`)
        .bind(normalizedEmail),
    ]);

    // UX: auto-login after successful reset — issue a fresh session so the user
    // lands straight in the app instead of re-typing the new password.
    const account = await db
      .prepare('SELECT user_id FROM auth_accounts WHERE email = ?')
      .bind(normalizedEmail)
      .first<{ user_id: string }>();

    if (account) {
      const token = await createSessionAndToken(db, c.env, {
        id: account.user_id,
        email: normalizedEmail,
        householdId: `hh_${account.user_id}`,
      });
      setSessionCookie(c, token);
      return c.json({
        success: true,
        user: {
          id: account.user_id,
          email: normalizedEmail,
          displayName: normalizedEmail.split('@')[0],
          householdId: `hh_${account.user_id}`,
        },
        message: 'Đặt lại mật khẩu thành công!',
      });
    }

    return c.json({
      success: true,
      message: 'Đặt lại mật khẩu thành công! Bạn có thể đăng nhập ngay.',
    });
  } catch {
    console.error(JSON.stringify({ event: 'password_reset_failed' }));
    return c.json({ error: 'Lỗi đặt lại mật khẩu' }, 500);
  }
});

// 8. POST /auth/google — Google Sign-In with Cryptographic OAuth Token Verification
authRoutes.post('/auth/google', async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));
  const parseResult = GoogleAuthSchema.safeParse(rawBody);

  if (!parseResult.success) {
    return c.json({ error: 'Dữ liệu Google OAuth không hợp lệ' }, 400);
  }

  const { credential, userInfo } = parseResult.data;

  let email = '';
  let name = '';
  let googleId = '';
  let avatarUrl = '/icons/favicon.svg';

  // SEC-03 FIX: Cryptographically verify Google ID Token with Google's public endpoint
  if (credential) {
    const googleVerify = await verifyGoogleToken(credential);
    if (!googleVerify.valid || !googleVerify.user) {
      return c.json({ error: `Xác thực Google thất bại: ${googleVerify.error || 'Token không hợp lệ'}` }, 401);
    }
    email = googleVerify.user.email;
    name = googleVerify.user.name;
    googleId = googleVerify.user.sub;
    avatarUrl = googleVerify.user.picture || avatarUrl;
  } else if (userInfo && c.env.ENVIRONMENT !== 'production') {
    // Only allow manual userInfo payload in non-production environments
    email = userInfo.email.toLowerCase();
    name = userInfo.name || email.split('@')[0];
    googleId = userInfo.sub || `g_${Date.now()}`;
    avatarUrl = userInfo.picture || avatarUrl;
  } else {
    return c.json({ error: 'Yêu cầu Google OAuth credential hợp lệ' }, 400);
  }

  const db = c.env.DB;

  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  try {
    // Resolve email and provider identity independently. They should never
    // silently point at two different local accounts; doing so would let a
    // later upsert rebind one account to another provider identity.
    const existingByEmail: any = await db
      .prepare('SELECT id, user_id, email, google_id FROM auth_accounts WHERE email = ? LIMIT 1')
      .bind(email)
      .first();
    const existingByGoogle: any = await db
      .prepare('SELECT id, user_id, email, google_id FROM auth_accounts WHERE google_id = ? LIMIT 1')
      .bind(googleId)
      .first();

    if (
      existingByEmail &&
      existingByGoogle &&
      existingByEmail.user_id !== existingByGoogle.user_id
    ) {
      return c.json(
        {
          error: 'Tài khoản Google đã liên kết với một tài khoản Frigo khác',
          code: 'GOOGLE_ACCOUNT_CONFLICT',
        },
        409
      );
    }

    const existing = existingByEmail || existingByGoogle;
    // Google `sub` values are provider-controlled identifiers. Hash the full
    // value instead of truncating it (the old prefix scheme could collide).
    const googleDigest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(googleId)
    );
    const googleHash = Array.from(new Uint8Array(googleDigest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const userId = existing ? existing.user_id : `usr_g_${googleHash.slice(0, 32)}`;
    const householdId = `hh_${userId}`;

    await db.batch([
      // Preserve existing child rows when a returning Google user signs in.
      db.prepare(
        `INSERT INTO users (id, email, is_guest) VALUES (?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET email = excluded.email, is_guest = 0, updated_at = datetime('now')`
      ).bind(userId, email),
      db.prepare(
        `INSERT INTO profiles (id, user_id, display_name, avatar_url) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
           avatar_url = excluded.avatar_url, updated_at = datetime('now')`
      ).bind(
        `prof_${userId}`,
        userId,
        name,
        avatarUrl
      ),
      db.prepare('INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)').bind(
        householdId,
        `Tủ lạnh của ${name}`,
        userId
      ),
      db.prepare(
        'INSERT OR IGNORE INTO household_members (id, household_id, user_id, role) VALUES (?, ?, ?, ?)'
      ).bind(`hm_${userId}`, householdId, userId, 'owner'),
      db.prepare(
        `INSERT INTO auth_accounts (id, user_id, email, google_id, is_verified)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           user_id = excluded.user_id,
           email = excluded.email,
           google_id = excluded.google_id,
           is_verified = 1,
           updated_at = datetime('now')`
      ).bind(existing?.id || userId, userId, email, googleId),
      db.prepare(
        `INSERT OR IGNORE INTO user_preferences
          (id, user_id, household_size, spicy_level, favorite_cuisines, dietary_restrictions)
         VALUES (?, ?, 2, 'medium', '["vietnamese"]', '[]')`
      ).bind(`pref_${userId}`, userId),
      db.prepare(
        `INSERT OR IGNORE INTO subscriptions
          (id, user_id, plan, status, scan_count_current_month, max_scans_per_month)
         VALUES (?, ?, 'free', 'active', 0, ?)`
      ).bind(`sub_${userId}`, userId, SCAN_QUOTA_POLICY.free),
      db.prepare(
        'INSERT OR IGNORE INTO shopping_lists (id, household_id, name) VALUES (?, ?, ?)'
      ).bind(`list_hh_${userId}`, householdId, 'Danh sách mua sắm'),
    ]);

    // SEC-04 FIX: Return signed cryptographic JWT
    const token = await createSessionAndToken(db, c.env, {
      id: userId,
      email,
      householdId,
      role: 'owner',
    });
    setSessionCookie(c, token);

    return c.json({
      success: true,
      user: {
        id: userId,
        email,
        displayName: name,
        avatarUrl,
        householdId,
        isGuest: false,
      },
    });
  } catch {
    console.error(JSON.stringify({ event: 'google_auth_failed' }));
    return c.json({ error: 'Lỗi xác thực Google' }, 500);
  }
});

// 9. POST /auth/guest — Guest Mode with signed token
authRoutes.post('/auth/guest', async (c) => {
  // Keep the suffix alphanumeric so it remains compatible with the guest
  // migration contract (`hh_guest_<suffix>`), while avoiding timestamp-only
  // collisions under concurrent requests.
  const guestSuffix = `${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
  const newGuestId = `guest_${guestSuffix}`;
  const householdId = `hh_${newGuestId}`;
  const email = `${newGuestId}@frigo.local`;

  if (!c.env.DB) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  // A guest still needs real FK parents before inventory, scan, or shopping
  // mutations can be persisted. Without these rows every guest write fails
  // once D1 foreign-key enforcement is enabled.
  try {
    await c.env.DB.batch([
        c.env.DB
          .prepare('INSERT OR IGNORE INTO users (id, email, is_guest) VALUES (?, ?, 1)')
          .bind(newGuestId, email),
        c.env.DB
          .prepare('INSERT OR IGNORE INTO profiles (id, user_id, display_name, avatar_url) VALUES (?, ?, ?, ?)')
          .bind(`prof_${newGuestId}`, newGuestId, 'Khách ghé thăm', '/icons/favicon.svg'),
        c.env.DB
          .prepare('INSERT OR IGNORE INTO households (id, name, created_by) VALUES (?, ?, ?)')
          .bind(householdId, 'Tủ lạnh khách ghé thăm', newGuestId),
        c.env.DB
          .prepare(
            'INSERT OR IGNORE INTO household_members (id, household_id, user_id, role) VALUES (?, ?, ?, ?)'
          )
          .bind(`hm_${newGuestId}`, householdId, newGuestId, 'owner'),
        c.env.DB
          .prepare(
            'INSERT OR IGNORE INTO user_preferences (id, user_id, household_size, spicy_level, favorite_cuisines, dietary_restrictions) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .bind(`pref_${newGuestId}`, newGuestId, 2, 'medium', '["vietnamese"]', '[]'),
        c.env.DB
          .prepare(
            'INSERT OR IGNORE INTO subscriptions (id, user_id, plan, status, scan_count_current_month, max_scans_per_month) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .bind(`sub_${newGuestId}`, newGuestId, 'free', 'active', 0, SCAN_QUOTA_POLICY.free),
        c.env.DB
          .prepare('INSERT OR IGNORE INTO shopping_lists (id, household_id, name) VALUES (?, ?, ?)')
          .bind(`list_${householdId}`, householdId, 'Danh sách mua sắm'),
    ]);
  } catch {
    console.error(JSON.stringify({ event: 'guest_initialization_failed' }));
    return c.json(
      {
        error: 'Không thể khởi tạo phiên khách. Vui lòng thử lại sau.',
        code: 'GUEST_INITIALIZATION_FAILED',
      },
      503
    );
  }

  const token = await createSessionAndToken(c.env.DB, c.env, {
    id: newGuestId,
    email,
    householdId,
    role: 'owner',
    isGuest: true,
  });
  setSessionCookie(c, token);

  return c.json({
    success: true,
    user: {
      id: newGuestId,
      email,
      displayName: 'Khách ghé thăm',
      avatarUrl: '/icons/favicon.svg',
      householdId,
      isGuest: true,
    },
  });
});

// 10. POST /auth/logout — Sign out and revoke session
authRoutes.post('/auth/logout', async (c) => {
  const db = c.env.DB;
  const cookieHeader = c.req.header('cookie') || '';
  const cookieToken = cookieHeader.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!db) return c.json({ error: 'Không thể đăng xuất lúc này', code: 'LOGOUT_FAILED' }, 503);
  if (cookieToken) {
    try {
      const tokenHash = await sha256Hex(decodeURIComponent(cookieToken));
      const result: any = await db.prepare("UPDATE sessions_v2 SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL").bind(tokenHash).run();
      if (result?.success === false) return c.json({ error: 'Không thể đăng xuất lúc này', code: 'LOGOUT_FAILED' }, 503);
    } catch {
      return c.json({ error: 'Không thể đăng xuất lúc này', code: 'LOGOUT_FAILED' }, 503);
    }
  }
  c.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return c.json({ success: true, message: 'Đăng xuất thành công' });
});

// 11. POST /auth/plus/activate — server-authoritative Frigo Plus entitlement.
// The client can NEVER grant Plus to itself. A real payment is only confirmed once
// a server-held secret (PLUS_GRANT_SECRET, e.g. from a verified NAPAS callback or
// an ops back-office action) is presented; otherwise the request records intent and
// returns pending_verification without unlocking anything.
authRoutes.post('/auth/plus/activate', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const rawBody = await c.req.json().catch(() => ({}));
  const cycle = rawBody?.cycle === 'annual' ? 'annual' : 'monthly';

  if (auth?.isGuest) {
    return c.json({ error: 'Vui lòng đăng nhập để kích hoạt Frigo Plus.' }, 401);
  }

  // Entitlement changes are durable; do not report a pending/active result
  // when the authoritative subscription store is unavailable.
  if (!db) {
    return c.json({ error: 'Database service unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
  }

  const grantSecret = c.env.PLUS_GRANT_SECRET;
  const provided = typeof rawBody?.grantCode === 'string' ? rawBody.grantCode : '';
  const manualGrant = Boolean(grantSecret) && provided.length > 0 && provided === grantSecret;

  try {
    if (manualGrant) {
      const expiresAt = new Date(
        Date.now() + (cycle === 'annual' ? 366 : 31) * 86400 * 1000
      ).toISOString();
      await db
        .prepare(
          `INSERT INTO subscriptions (id, user_id, plan, status, expires_at)
           VALUES (?, ?, 'plus', 'active', ?)
           ON CONFLICT(user_id) DO UPDATE SET
             plan = 'plus', status = 'active', expires_at = excluded.expires_at,
             updated_at = datetime('now')`
        )
        .bind(`sub_${auth.userId}`, auth.userId, expiresAt)
        .run();
      return c.json({ success: true, granted: true, status: 'active', expiresAt });
    }

    // No verifiable payment yet — do not unlock. Client will reflect server state.
    return c.json({
      success: true,
      granted: false,
      status: 'pending_verification',
      message:
        'Giao dịch đang được đối soát. Frigo Plus sẽ tự động kích hoạt khi thanh toán của bạn được xác minh.',
    });
  } catch (err: any) {
    console.error('Plus activate error:', err);
    return c.json({ error: err?.message || 'Không thể xử lý yêu cầu Plus' }, 500);
  }
});
