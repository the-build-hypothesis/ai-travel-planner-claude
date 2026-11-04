import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { DUMMY_HASH, hashPassword, randomToken, sha256, uuid, verifyPassword } from "../lib/crypto";
import { ApiError, badRequest, unauthorized } from "../lib/errors";
import { clientIp, parseJson } from "../lib/http";
import { check, enforce, hit } from "../lib/ratelimit";
import {
  EmailConfigError,
  accountExistsEmail,
  passwordResetEmail,
  publicUrl,
  sendEmail,
  verificationEmail,
} from "../services/email";
import {
  createUserSession,
  destroyUserSession,
  invalidateAllUserSessions,
  migrateGuestToUser,
} from "../services/sessions";

export const VERIFY_TOKEN_TTL_MS = 24 * 3600_000;
export const RESET_TOKEN_TTL_MS = 30 * 60_000;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters.")
  .max(200, "Password is too long.")
  .refine((p) => new Set(p).size >= 4, "Password is too simple.");

const emailSchema = z.string().trim().max(254).pipe(z.email("Enter a valid email address."));

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().max(80).optional().nullable(),
});

const loginSchema = z.object({ email: z.string().trim().max(254), password: z.string().max(200) });

function emailFailureResponse(e: unknown): ApiError {
  if (e instanceof EmailConfigError) {
    return new ApiError(503, "EMAIL_NOT_CONFIGURED", "Email delivery isn't available right now. Please try again later.");
  }
  return new ApiError(502, "EMAIL_SEND_FAILED", "We couldn't send the email. Please try again in a few minutes.");
}

async function issueEmailToken(db: D1Database, userId: string, purpose: "verify_email" | "reset_password", ttlMs: number) {
  const token = randomToken();
  const now = Date.now();
  // Only one live token per purpose: older unused tokens are invalidated.
  await db.batch([
    db.prepare(`UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL`).bind(now, userId, purpose),
    db.prepare(`INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`).bind(
      await sha256(token),
      userId,
      purpose,
      now,
      now + ttlMs,
    ),
  ]);
  return token;
}

/** Atomically consume a token: returns the user id or null if invalid/expired/used. */
async function consumeEmailToken(db: D1Database, token: string, purpose: string): Promise<string | null> {
  if (!token || token.length > 100) return null;
  const row = await db
    .prepare(
      `UPDATE email_tokens SET used_at = ?
       WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
       RETURNING user_id`,
    )
    .bind(Date.now(), await sha256(token), purpose, Date.now())
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export const authRoutes = new Hono<AppBindings>()
  .post("/register", async (c) => {
    const ip = clientIp(c);
    await enforce(c.env.DB, [
      { bucket: `register:ip:${ip}`, limit: 10, windowSec: 3600, message: "Too many sign-up attempts. Try again later." },
    ]);
    const body = await parseJson(c, registerSchema);
    const emailNorm = normalizeEmail(body.email);
    if (body.password.toLowerCase().includes(emailNorm.split("@")[0]) && emailNorm.split("@")[0].length >= 4) {
      throw badRequest("password: Password must not contain your email name.");
    }
    const base = publicUrl(c.env, new URL(c.req.url).origin);
    const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE email_normalized = ?`).bind(emailNorm).first<{ id: string }>();

    // Account-enumeration protection: identical response whether or not the
    // address is registered. Existing owners get a notice email instead.
    let emailSent = true;
    try {
      if (existing) {
        await hashPassword(body.password); // equalize timing
        await sendEmail(c.env, body.email, accountExistsEmail(`${base}/login`, `${base}/forgot-password`), "account_exists");
      } else {
        const id = uuid();
        const now = Date.now();
        const passwordHash = await hashPassword(body.password);
        try {
          await c.env.DB.prepare(
            `INSERT INTO users (id, email, email_normalized, display_name, password_hash, status, created_at, updated_at, password_changed_at)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          )
            .bind(id, body.email.trim(), emailNorm, body.displayName || null, passwordHash, now, now, now)
            .run();
        } catch (e) {
          if (String(e).includes("UNIQUE")) {
            // Concurrent registration for the same address — treat like "exists".
            return c.json({ ok: true, emailSent: true, message: "Check your inbox to verify your email, then sign in." });
          }
          throw e;
        }
        const token = await issueEmailToken(c.env.DB, id, "verify_email", VERIFY_TOKEN_TTL_MS);
        await sendEmail(c.env, body.email, verificationEmail(`${base}/verify-email?token=${token}`, 24), "verify_email");
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      emailSent = false;
      if (e instanceof EmailConfigError) {
        // Account (if new) is created; the user can sign in and resend later.
      }
    }
    return c.json({
      ok: true,
      emailSent,
      message: emailSent
        ? "Check your inbox for a verification link, then sign in."
        : "Your request was received, but we couldn't send the verification email. You can sign in and resend it later.",
    });
  })

  .post("/login", async (c) => {
    const ip = clientIp(c);
    const body = await parseJson(c, loginSchema);
    const emailNorm = normalizeEmail(body.email);
    const emailKey = await sha256(emailNorm);
    const limits = [
      { bucket: `login:ip:${ip}`, limit: 30, windowSec: 900, message: "Too many sign-in attempts. Please wait 15 minutes." },
      { bucket: `login-fail:email:${emailKey}`, limit: 8, windowSec: 900, message: "Too many failed sign-in attempts for this account. Please wait 15 minutes or reset your password." },
    ];
    await enforce(c.env.DB, [limits[0]]);
    await check(c.env.DB, [limits[1]]);
    const user = await c.env.DB.prepare(`SELECT id, password_hash, status FROM users WHERE email_normalized = ?`)
      .bind(emailNorm)
      .first<{ id: string; password_hash: string; status: string }>();
    const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      await hit(c.env.DB, limits[1].bucket, 900);
      throw new ApiError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");
    }
    if (user.status !== "active") {
      throw new ApiError(403, "ACCOUNT_DISABLED", "This account has been disabled. Please contact support.");
    }
    await createUserSession(c, user.id);
    const migrated = await migrateGuestToUser(c, user.id);
    const u = await c.env.DB.prepare(`SELECT id, email, display_name, email_verified_at FROM users WHERE id = ?`)
      .bind(user.id)
      .first<{ id: string; email: string; display_name: string | null; email_verified_at: number | null }>();
    return c.json({
      user: { id: u!.id, email: u!.email, displayName: u!.display_name, emailVerified: u!.email_verified_at !== null },
      migratedTrips: migrated,
    });
  })

  .post("/logout", async (c) => {
    await destroyUserSession(c);
    return c.json({ ok: true });
  })

  .post("/verify-email", async (c) => {
    await enforce(c.env.DB, [{ bucket: `token:ip:${clientIp(c)}`, limit: 30, windowSec: 900 }]);
    const { token } = await parseJson(c, z.object({ token: z.string().min(10).max(100) }));
    const userId = await consumeEmailToken(c.env.DB, token, "verify_email");
    if (!userId) {
      throw new ApiError(400, "INVALID_TOKEN", "This verification link is invalid or has expired. Request a new one from your account page.");
    }
    await c.env.DB.prepare(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?`)
      .bind(Date.now(), Date.now(), userId)
      .run();
    return c.json({ ok: true });
  })

  .post("/resend-verification", async (c) => {
    const user = c.get("user");
    if (!user) throw unauthorized();
    if (user.emailVerified) return c.json({ ok: true, alreadyVerified: true });
    await enforce(c.env.DB, [
      { bucket: `resend:user:${user.id}`, limit: 3, windowSec: 3600, message: "You've requested several emails recently. Please wait before trying again." },
    ]);
    const base = publicUrl(c.env, new URL(c.req.url).origin);
    try {
      const token = await issueEmailToken(c.env.DB, user.id, "verify_email", VERIFY_TOKEN_TTL_MS);
      await sendEmail(c.env, user.email, verificationEmail(`${base}/verify-email?token=${token}`, 24), "verify_email");
    } catch (e) {
      throw emailFailureResponse(e);
    }
    return c.json({ ok: true, message: `Verification email sent to ${user.email}.` });
  })

  .post("/forgot-password", async (c) => {
    const ip = clientIp(c);
    await enforce(c.env.DB, [
      { bucket: `forgot:ip:${ip}`, limit: 5, windowSec: 900, message: "Too many reset requests. Please wait a few minutes." },
    ]);
    const { email } = await parseJson(c, z.object({ email: emailSchema }));
    const emailNorm = normalizeEmail(email);
    if (!c.env.EMAIL || !c.env.EMAIL_FROM) {
      // Configuration issue, independent of whether the account exists.
      throw new ApiError(503, "EMAIL_NOT_CONFIGURED", "Password reset email isn't available right now. Please try again later.");
    }
    const perEmail = await hit(c.env.DB, `forgot:email:${await sha256(emailNorm)}`, 3600);
    const user = await c.env.DB.prepare(`SELECT id, email, status FROM users WHERE email_normalized = ?`)
      .bind(emailNorm)
      .first<{ id: string; email: string; status: string }>();
    const base = publicUrl(c.env, new URL(c.req.url).origin);
    if (user && user.status === "active" && perEmail <= 3) {
      const token = await issueEmailToken(c.env.DB, user.id, "reset_password", RESET_TOKEN_TTL_MS);
      // Send in the background so response timing doesn't reveal account existence.
      // Failures are recorded in app_errors (visible to admins).
      c.executionCtx.waitUntil(
        sendEmail(c.env, user.email, passwordResetEmail(`${base}/reset-password?token=${token}`, 30), "reset_password").catch(() => {}),
      );
    }
    return c.json({
      ok: true,
      message: "If an account exists for that address, we'll email a password reset link. It expires in 30 minutes.",
    });
  })

  .post("/reset-password", async (c) => {
    await enforce(c.env.DB, [{ bucket: `token:ip:${clientIp(c)}`, limit: 30, windowSec: 900 }]);
    const body = await parseJson(c, z.object({ token: z.string().min(10).max(100), password: passwordSchema }));
    const userId = await consumeEmailToken(c.env.DB, body.token, "reset_password");
    if (!userId) throw new ApiError(400, "INVALID_TOKEN", "This reset link is invalid or has expired. Please request a new one.");
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`,
      ).bind(await hashPassword(body.password), now, now, now, userId),
      // Invalidate every session and any other outstanding reset tokens.
      c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
      c.env.DB.prepare(`UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'reset_password' AND used_at IS NULL`).bind(now, userId),
    ]);
    return c.json({ ok: true, message: "Your password has been reset. Please sign in with your new password." });
  });

export const accountRoutes = new Hono<AppBindings>()
  .use(async (c, next) => {
    if (!c.get("user")) throw unauthorized();
    await next();
  })
  .patch("/", async (c) => {
    const user = c.get("user")!;
    const body = await parseJson(c, z.object({ displayName: z.string().trim().max(80).nullable() }));
    await c.env.DB.prepare(`UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?`)
      .bind(body.displayName || null, Date.now(), user.id)
      .run();
    return c.json({ user: { ...user, displayName: body.displayName || null } });
  })
  .post("/password", async (c) => {
    const user = c.get("user")!;
    await enforce(c.env.DB, [{ bucket: `pwchange:user:${user.id}`, limit: 10, windowSec: 3600 }]);
    const body = await parseJson(c, z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }));
    const row = await c.env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(user.id).first<{ password_hash: string }>();
    if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw new ApiError(400, "INVALID_CREDENTIALS", "Your current password is incorrect.");
    }
    if (body.currentPassword === body.newPassword) throw badRequest("newPassword: Choose a password you haven't used here.");
    const now = Date.now();
    await c.env.DB.prepare(`UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?`)
      .bind(await hashPassword(body.newPassword), now, now, user.id)
      .run();
    // Sign out all other devices; keep this session.
    await invalidateAllUserSessions(c.env.DB, user.id, c.get("sessionHash"));
    return c.json({ ok: true, message: "Password updated. Other devices have been signed out." });
  });
