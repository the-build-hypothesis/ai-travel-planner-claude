import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { emailSchema, passwordSchema } from '../../shared/schemas';
import {
  claimGuestTrips,
  createUserSession,
  destroyAllUserSessions,
  destroyUserSession,
  requireUser,
} from '../auth/sessions';
import { emailConfigured, sendEmail, templates } from '../email';
import type { AppContext } from '../env';
import { burnPasswordCheck, hashPassword, newId, randomToken, sha256, verifyPassword } from '../lib/crypto';
import { ApiError, clientIp, nowIso, parseJson, publicUrl } from '../lib/http';
import { enforce } from '../lib/rateLimit';

const VERIFY_TTL_MS = 24 * 60 * 60_000;
const RESET_TTL_MS = 30 * 60_000;
const MINUTE = 60;
const HOUR = 3600;

export const authRoutes = new Hono<AppContext>();

const normalizeEmail = (email: string) => email.trim().toLowerCase();

function userPayload(user: { id: string; email: string; name: string | null; default_currency: string; email_verified_at: string | null; created_at: string }) {
  return { id: user.id, email: user.email, name: user.name, default_currency: user.default_currency, email_verified: Boolean(user.email_verified_at), created_at: user.created_at };
}

async function issueToken(db: D1Database, userId: string, purpose: 'verify_email' | 'reset_password', ttlMs: number): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await db.batch([
    // Only the newest link for each purpose stays valid.
    db.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').bind(new Date(now).toISOString(), userId, purpose),
    db.prepare('INSERT INTO auth_tokens (id, token_hash, user_id, purpose, created_at, expires_at) VALUES (?,?,?,?,?,?)').bind(newId('tok'), await sha256(token), userId, purpose, new Date(now).toISOString(), new Date(now + ttlMs).toISOString()),
  ]);
  return token;
}

/** Claims a token exactly once. The conditional UPDATE means two concurrent uses cannot both succeed. */
async function consumeToken(db: D1Database, token: string, purpose: string): Promise<string | null> {
  const row = await db
    .prepare('UPDATE auth_tokens SET used_at = ?1 WHERE token_hash = ?2 AND purpose = ?3 AND used_at IS NULL AND expires_at > ?1 RETURNING user_id')
    .bind(nowIso(), await sha256(token), purpose)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

async function sendVerification(c: Context<AppContext>, userId: string, email: string) {
  const token = await issueToken(c.env.DB, userId, 'verify_email', VERIFY_TTL_MS);
  return sendEmail(c.env, email, templates.verify(`${publicUrl(c)}/verify-email?token=${encodeURIComponent(token)}`), c.get('requestId'));
}

function requireEmailConfigured(c: Context<AppContext>) {
  // This is checked before any account lookup, so the error says nothing about whether an account exists.
  if (!emailConfigured(c.env)) {
    throw new ApiError(503, 'EMAIL_UNAVAILABLE', "We can't send email right now because of a configuration problem. Please try again later.");
  }
}

authRoutes.post('/register', async (c) => {
  const ip = clientIp(c);
  await enforce(c.env.DB, [{ scope: 'register_ip', id: ip, max: 10, windowSeconds: HOUR }], 'Too many sign-up attempts. Please try again later.');
  const body = await parseJson(c, z.object({ email: emailSchema, password: passwordSchema, name: z.string().trim().max(100).optional() }));
  requireEmailConfigured(c);
  const normalized = normalizeEmail(body.email);
  await enforce(c.env.DB, [{ scope: 'register_email', id: await sha256(normalized), max: 5, windowSeconds: HOUR }], 'Too many sign-up attempts. Please try again later.');

  // The password is always hashed, so a new and an existing address take the same time.
  const passwordHash = await hashPassword(body.password);
  const now = nowIso();
  const id = newId('usr');
  const inserted = await c.env.DB.prepare(
    `INSERT INTO users (id, email, email_normalized, name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(email_normalized) DO NOTHING`,
  )
    .bind(id, body.email.trim(), normalized, body.name || null, passwordHash, now, now)
    .run();

  let outcome;
  if (inserted.meta.changes === 1) {
    outcome = await sendVerification(c, id, body.email.trim());
  } else {
    const existing = await c.env.DB.prepare('SELECT id, email, email_verified_at FROM users WHERE email_normalized = ?').bind(normalized).first<{ id: string; email: string; email_verified_at: string | null }>();
    outcome = existing?.email_verified_at
      ? await sendEmail(c.env, existing.email, templates.alreadyRegistered(`${publicUrl(c)}/login`, `${publicUrl(c)}/forgot-password`), c.get('requestId'))
      : await sendVerification(c, existing!.id, existing!.email);
  }
  // The same response whether the address was new or already registered.
  if (!outcome.sent) {
    return c.json({ status: 'email_failed', message: "We couldn't send your confirmation email. Please try again, or use “Resend” on the login page in a few minutes." }, 202);
  }
  return c.json({ status: 'verification_sent', message: 'Check your inbox for a message from us to finish setting up your account.' }, 202);
});

authRoutes.post('/login', async (c) => {
  const body = await parseJson(c, z.object({ email: z.string().trim().max(254), password: z.string().max(128) }));
  const normalized = normalizeEmail(body.email);
  await enforce(
    c.env.DB,
    [
      { scope: 'login_ip', id: clientIp(c), max: 30, windowSeconds: 15 * MINUTE },
      { scope: 'login_acct', id: await sha256(normalized), max: 10, windowSeconds: 15 * MINUTE },
    ],
    'Too many login attempts. Please wait a few minutes and try again.',
  );
  const user = await c.env.DB.prepare('SELECT id, email, name, default_currency, status, email_verified_at, created_at, password_hash FROM users WHERE email_normalized = ?')
    .bind(normalized)
    .first<{ id: string; email: string; name: string | null; default_currency: string; status: string; email_verified_at: string | null; created_at: string; password_hash: string }>();
  const invalid = new ApiError(401, 'INVALID_CREDENTIALS', 'That email and password combination is incorrect.');
  if (!user) {
    await burnPasswordCheck(body.password);
    throw invalid;
  }
  if (!(await verifyPassword(body.password, user.password_hash))) throw invalid;
  // Account state is revealed only after the correct password has been given.
  if (user.status !== 'active') throw new ApiError(403, 'ACCOUNT_DISABLED', 'This account has been disabled. Please contact support.');
  if (!user.email_verified_at) throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Please confirm your email address before logging in.');

  await destroyUserSession(c, false);
  await createUserSession(c, user.id);
  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso(), user.id).run();
  const claimed = await claimGuestTrips(c, user.id);
  return c.json({ user: userPayload(user), claimedTrips: claimed });
});

authRoutes.post('/logout', async (c) => {
  await destroyUserSession(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', async (c) => {
  const user = c.get('user');
  const guestId = c.get('guestId');
  let guestTrips = 0;
  if (!user && guestId) {
    const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM trips WHERE guest_id = ?').bind(guestId).first<{ n: number }>();
    guestTrips = row?.n ?? 0;
  }
  return c.json({ user: user ? userPayload(user) : null, guest: !user && Boolean(guestId), guestTrips });
});

authRoutes.post('/verify-email', async (c) => {
  await enforce(c.env.DB, [{ scope: 'verify_ip', id: clientIp(c), max: 30, windowSeconds: HOUR }]);
  const body = await parseJson(c, z.object({ token: z.string().min(10).max(200) }));
  const userId = await consumeToken(c.env.DB, body.token, 'verify_email');
  if (!userId) throw new ApiError(400, 'INVALID_TOKEN', 'This confirmation link is invalid or has expired. Request a new one from the login page.');
  await c.env.DB.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?1), updated_at = ?1 WHERE id = ?2').bind(nowIso(), userId).run();
  return c.json({ ok: true });
});

authRoutes.post('/resend-verification', async (c) => {
  const body = await parseJson(c, z.object({ email: emailSchema }));
  const normalized = normalizeEmail(body.email);
  await enforce(
    c.env.DB,
    [
      { scope: 'resend_ip', id: clientIp(c), max: 10, windowSeconds: HOUR },
      { scope: 'resend_email', id: await sha256(normalized), max: 3, windowSeconds: HOUR },
    ],
    'Too many requests. Please wait a while before asking for another email.',
  );
  requireEmailConfigured(c);
  const user = await c.env.DB.prepare('SELECT id, email, email_verified_at FROM users WHERE email_normalized = ?').bind(normalized).first<{ id: string; email: string; email_verified_at: string | null }>();
  // Sent after the response, so timing does not reveal whether the address is registered.
  if (user && !user.email_verified_at) c.executionCtx.waitUntil(sendVerification(c, user.id, user.email));
  return c.json({ message: 'If that address has an unconfirmed account, a new confirmation email is on its way.' }, 202);
});

authRoutes.post('/forgot-password', async (c) => {
  const body = await parseJson(c, z.object({ email: emailSchema }));
  const normalized = normalizeEmail(body.email);
  await enforce(
    c.env.DB,
    [
      { scope: 'forgot_ip', id: clientIp(c), max: 10, windowSeconds: HOUR },
      { scope: 'forgot_email', id: await sha256(normalized), max: 3, windowSeconds: HOUR },
    ],
    'Too many reset requests. Please wait a while and try again.',
  );
  requireEmailConfigured(c);
  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE email_normalized = ? AND status = ?').bind(normalized, 'active').first<{ id: string; email: string }>();
  if (user) {
    c.executionCtx.waitUntil(
      (async () => {
        const token = await issueToken(c.env.DB, user.id, 'reset_password', RESET_TTL_MS);
        await sendEmail(c.env, user.email, templates.reset(`${publicUrl(c)}/reset-password?token=${encodeURIComponent(token)}`), c.get('requestId'));
      })(),
    );
  }
  return c.json({ message: 'If an account exists for that address, a reset link is on its way. It expires in 30 minutes.' }, 202);
});

authRoutes.post('/reset-password', async (c) => {
  await enforce(c.env.DB, [{ scope: 'reset_ip', id: clientIp(c), max: 20, windowSeconds: HOUR }]);
  const body = await parseJson(c, z.object({ token: z.string().min(10).max(200), password: passwordSchema }));
  // Hash first so a bad password cannot waste a token and a weak request cannot race it.
  const passwordHash = await hashPassword(body.password);
  const userId = await consumeToken(c.env.DB, body.token, 'reset_password');
  if (!userId) throw new ApiError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired. Please request a new one.');
  const now = nowIso();
  await c.env.DB.batch([
    // Receiving the reset email proves ownership of the address, so it also counts as verification.
    c.env.DB.prepare('UPDATE users SET password_hash = ?1, email_verified_at = COALESCE(email_verified_at, ?2), updated_at = ?2 WHERE id = ?3').bind(passwordHash, now, userId),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').bind(now, userId, 'reset_password'),
  ]);
  return c.json({ ok: true });
});

export const accountRoutes = new Hono<AppContext>();
accountRoutes.use('*', requireUser);

accountRoutes.patch('/', async (c) => {
  const body = await parseJson(
    c,
    z.object({ name: z.string().trim().max(100).nullable().optional(), default_currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code').optional() }).strict(),
  );
  const user = c.get('user')!;
  await c.env.DB.prepare('UPDATE users SET name = ?, default_currency = ?, updated_at = ? WHERE id = ?')
    .bind(body.name === undefined ? user.name : body.name || null, body.default_currency ?? user.default_currency, nowIso(), user.id)
    .run();
  const updated = await c.env.DB.prepare('SELECT id, email, name, default_currency, email_verified_at, created_at FROM users WHERE id = ?').bind(user.id).first<any>();
  return c.json({ user: userPayload(updated) });
});

accountRoutes.post('/change-password', async (c) => {
  const user = c.get('user')!;
  await enforce(c.env.DB, [{ scope: 'change_pw', id: user.id, max: 10, windowSeconds: 15 * MINUTE }], 'Too many attempts. Please wait a few minutes and try again.');
  const body = await parseJson(c, z.object({ current_password: z.string().max(128), new_password: passwordSchema }));
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(body.current_password, row.password_hash))) {
    throw new ApiError(400, 'INVALID_CURRENT_PASSWORD', 'Your current password is incorrect.', { fields: { current_password: 'Your current password is incorrect.' } });
  }
  const hash = await hashPassword(body.new_password);
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(hash, nowIso(), user.id).run();
  // Every other device is signed out, and this one gets a fresh session.
  await destroyAllUserSessions(c.env.DB, user.id);
  await createUserSession(c, user.id);
  c.executionCtx.waitUntil(sendEmail(c.env, user.email, templates.passwordChanged(), c.get('requestId')));
  return c.json({ ok: true });
});

export { userPayload, consumeToken };
