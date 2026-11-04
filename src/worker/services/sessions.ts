// Session management for application users, guests, and administrators.
// Tokens live only in HttpOnly cookies; the database stores SHA-256 hashes.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppBindings, SessionAdmin, SessionUser } from "../env";
import { randomToken, sha256, uuid } from "../lib/crypto";

export const USER_COOKIE = "__Host-tp_session";
export const GUEST_COOKIE = "__Host-tp_guest";
export const ADMIN_COOKIE = "__Host-tp_admin";

export const USER_SESSION_TTL_MS = 30 * 86400_000; // absolute
export const USER_SESSION_IDLE_MS = 14 * 86400_000; // idle timeout
export const GUEST_TTL_S = 180 * 86400;
export const ADMIN_SESSION_TTL_MS = 8 * 3600_000; // absolute
export const ADMIN_SESSION_IDLE_MS = 30 * 60_000; // idle timeout
const TOUCH_INTERVAL_MS = 60_000;

type C = Context<AppBindings>;

const cookieOpts = (maxAge: number) => ({
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax" as const,
  maxAge,
});

// ───────────────────────── Users ─────────────────────────

export async function createUserSession(c: C, userId: string): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(await sha256(token), userId, now, now + USER_SESSION_TTL_MS, now)
    .run();
  setCookie(c, USER_COOKIE, token, cookieOpts(USER_SESSION_TTL_MS / 1000));
}

export async function loadUserSession(c: C): Promise<void> {
  c.set("user", null);
  c.set("sessionHash", null);
  const token = getCookie(c, USER_COOKIE);
  if (!token || token.length > 100) return;
  const hash = await sha256(token);
  const row = await c.env.DB.prepare(
    `SELECT s.user_id, s.expires_at, s.last_seen_at, u.email, u.display_name, u.email_verified_at, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  )
    .bind(hash)
    .first<{
      user_id: string;
      expires_at: number;
      last_seen_at: number;
      email: string;
      display_name: string | null;
      email_verified_at: number | null;
      status: string;
    }>();
  const now = Date.now();
  if (!row || row.expires_at <= now || now - row.last_seen_at > USER_SESSION_IDLE_MS || row.status !== "active") {
    if (row) await c.env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(hash).run();
    deleteCookie(c, USER_COOKIE, { path: "/", secure: true });
    return;
  }
  if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
    await c.env.DB.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`).bind(now, hash).run();
  }
  const user: SessionUser = {
    id: row.user_id,
    email: row.email,
    displayName: row.display_name,
    emailVerified: row.email_verified_at !== null,
  };
  c.set("user", user);
  c.set("sessionHash", hash);
}

export async function destroyUserSession(c: C): Promise<void> {
  const hash = c.get("sessionHash");
  if (hash) await c.env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(hash).run();
  deleteCookie(c, USER_COOKIE, { path: "/", secure: true });
}

export async function invalidateAllUserSessions(db: D1Database, userId: string, exceptHash?: string | null) {
  if (exceptHash) {
    await db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`).bind(userId, exceptHash).run();
  } else {
    await db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
  }
}

// ───────────────────────── Guests ─────────────────────────

export async function loadGuest(c: C): Promise<void> {
  c.set("guestId", null);
  const token = getCookie(c, GUEST_COOKIE);
  if (!token || token.length > 100) return;
  const row = await c.env.DB.prepare(`SELECT id, claimed_by_user_id, last_seen_at FROM guests WHERE token_hash = ?`)
    .bind(await sha256(token))
    .first<{ id: string; claimed_by_user_id: string | null; last_seen_at: number }>();
  if (!row) return;
  c.set("guestId", row.id);
  if (Date.now() - row.last_seen_at > 3600_000) {
    await c.env.DB.prepare(`UPDATE guests SET last_seen_at = ? WHERE id = ?`).bind(Date.now(), row.id).run();
  }
}

/** Returns the current guest id, creating a guest identity (and cookie) if needed. */
export async function ensureGuest(c: C): Promise<string> {
  const existing = c.get("guestId");
  if (existing) return existing;
  const token = randomToken();
  const id = uuid();
  const now = Date.now();
  await c.env.DB.prepare(`INSERT INTO guests (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)`)
    .bind(id, await sha256(token), now, now)
    .run();
  setCookie(c, GUEST_COOKIE, token, cookieOpts(GUEST_TTL_S));
  c.set("guestId", id);
  return id;
}

/**
 * Move the current browser's guest trips to a user account. Only the guest whose
 * secret cookie is presented can be claimed, so other guests' trips are never
 * reachable. Idempotent: trips are moved (UPDATE), never copied.
 */
export async function migrateGuestToUser(c: C, userId: string): Promise<number> {
  const guestId = c.get("guestId");
  if (!guestId) return 0;
  const now = Date.now();
  const res = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE trips SET user_id = ?, guest_id = NULL, updated_at = updated_at WHERE guest_id = ?`).bind(
      userId,
      guestId,
    ),
    c.env.DB.prepare(`UPDATE usage_events SET user_id = ? WHERE guest_id = ? AND user_id IS NULL`).bind(userId, guestId),
    c.env.DB.prepare(`UPDATE guests SET claimed_by_user_id = ?, claimed_at = ? WHERE id = ?`).bind(userId, now, guestId),
  ]);
  deleteCookie(c, GUEST_COOKIE, { path: "/", secure: true });
  c.set("guestId", null);
  return res[0].meta.changes ?? 0;
}

// ───────────────────────── Admins ─────────────────────────

export async function createAdminSession(c: C, adminId: string): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO admin_sessions (token_hash, admin_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(await sha256(token), adminId, now, now + ADMIN_SESSION_TTL_MS, now)
    .run();
  setCookie(c, ADMIN_COOKIE, token, { ...cookieOpts(ADMIN_SESSION_TTL_MS / 1000), sameSite: "Strict" });
}

export async function loadAdminSession(c: C): Promise<void> {
  c.set("admin", null);
  c.set("adminSessionHash", null);
  const token = getCookie(c, ADMIN_COOKIE);
  if (!token || token.length > 100) return;
  const hash = await sha256(token);
  const row = await c.env.DB.prepare(
    `SELECT s.admin_id, s.expires_at, s.last_seen_at, a.username, a.must_change_password, a.status
     FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`,
  )
    .bind(hash)
    .first<{ admin_id: string; expires_at: number; last_seen_at: number; username: string; must_change_password: number; status: string }>();
  const now = Date.now();
  if (!row || row.expires_at <= now || now - row.last_seen_at > ADMIN_SESSION_IDLE_MS || row.status !== "active") {
    if (row) await c.env.DB.prepare(`DELETE FROM admin_sessions WHERE token_hash = ?`).bind(hash).run();
    deleteCookie(c, ADMIN_COOKIE, { path: "/", secure: true });
    return;
  }
  if (now - row.last_seen_at > 15_000) {
    await c.env.DB.prepare(`UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?`).bind(now, hash).run();
  }
  const admin: SessionAdmin = { id: row.admin_id, username: row.username, mustChangePassword: row.must_change_password === 1 };
  c.set("admin", admin);
  c.set("adminSessionHash", hash);
}

export async function destroyAdminSession(c: C): Promise<void> {
  const hash = c.get("adminSessionHash");
  if (hash) await c.env.DB.prepare(`DELETE FROM admin_sessions WHERE token_hash = ?`).bind(hash).run();
  deleteCookie(c, ADMIN_COOKIE, { path: "/", secure: true });
}
