import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AdminRow, AppContext, Principal, UserRow } from '../env';
import { newId, randomToken, sha256 } from '../lib/crypto';
import { ApiError, nowIso } from '../lib/http';

export const USER_COOKIE = '__Host-tp_session';
export const GUEST_COOKIE = '__Host-tp_guest';
export const ADMIN_COOKIE = '__Host-tp_admin';

const DAY = 86_400_000;
const USER_IDLE_MS = 30 * DAY;
const USER_ABSOLUTE_MS = 90 * DAY;
const ADMIN_IDLE_MS = 60 * 60_000;
const ADMIN_ABSOLUTE_MS = 12 * 60 * 60_000;
const GUEST_COOKIE_SECONDS = 180 * 86_400;
const REFRESH_AFTER_MS = 60 * 60_000;

function setAuthCookie(c: Context<AppContext>, name: string, value: string, maxAge: number, sameSite: 'Lax' | 'Strict') {
  setCookie(c, name, value, { path: '/', httpOnly: true, secure: true, sameSite, maxAge });
}

// ---- Application users ----

export async function createUserSession(c: Context<AppContext>, userId: string): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at, absolute_expires_at) VALUES (?,?,?,?,?,?,?)')
    .bind(newId('ses'), await sha256(token), userId, new Date(now).toISOString(), new Date(now).toISOString(), new Date(now + USER_IDLE_MS).toISOString(), new Date(now + USER_ABSOLUTE_MS).toISOString())
    .run();
  setAuthCookie(c, USER_COOKIE, token, USER_IDLE_MS / 1000, 'Lax');
}

/** Revokes the presented session. A caller about to issue a new cookie passes clearCookie = false. */
export async function destroyUserSession(c: Context<AppContext>, clearCookie = true): Promise<void> {
  const token = getCookie(c, USER_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  if (clearCookie) deleteCookie(c, USER_COOKIE, { path: '/', secure: true });
}

export async function destroyAllUserSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

interface SessionJoin extends UserRow {
  session_id: string;
  expires_at: string;
  absolute_expires_at: string;
  last_seen_at: string;
}

async function loadUser(c: Context<AppContext>): Promise<UserRow | null> {
  const token = getCookie(c, USER_COOKIE);
  if (!token) return null;
  const row = await c.env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, s.absolute_expires_at, s.last_seen_at,
            u.id, u.email, u.name, u.default_currency, u.status, u.email_verified_at, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  )
    .bind(await sha256(token))
    .first<SessionJoin>();
  if (!row) return null;
  const now = Date.now();
  if (Date.parse(row.expires_at) <= now || Date.parse(row.absolute_expires_at) <= now || row.status !== 'active') {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(row.session_id).run();
    return null;
  }
  if (now - Date.parse(row.last_seen_at) > REFRESH_AFTER_MS) {
    const expires = Math.min(now + USER_IDLE_MS, Date.parse(row.absolute_expires_at));
    await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .bind(new Date(now).toISOString(), new Date(expires).toISOString(), row.session_id)
      .run();
    setAuthCookie(c, USER_COOKIE, token, Math.floor((expires - now) / 1000), 'Lax');
  }
  const { id, email, name, default_currency, status, email_verified_at, created_at } = row;
  return { id, email, name, default_currency, status, email_verified_at, created_at };
}

// ---- Guests ----

async function loadGuest(c: Context<AppContext>): Promise<string | null> {
  const token = getCookie(c, GUEST_COOKIE);
  if (!token) return null;
  const row = await c.env.DB.prepare('SELECT id FROM guests WHERE token_hash = ? AND claimed_by_user_id IS NULL')
    .bind(await sha256(token))
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Guests are created only when they first do something, so casual page views leave no rows behind. */
export async function ensureGuest(c: Context<AppContext>): Promise<string> {
  const existing = c.get('guestId');
  if (existing) return existing;
  const token = randomToken();
  const id = newId('gst');
  const now = nowIso();
  await c.env.DB.prepare('INSERT INTO guests (id, token_hash, created_at, last_seen_at) VALUES (?,?,?,?)').bind(id, await sha256(token), now, now).run();
  setAuthCookie(c, GUEST_COOKIE, token, GUEST_COOKIE_SECONDS, 'Lax');
  c.set('guestId', id);
  return id;
}

/** The party that owns trips on this request, or null when nothing has established one yet. */
export function currentPrincipal(c: Context<AppContext>): Principal | null {
  const user = c.get('user');
  if (user) return { type: 'user', id: user.id };
  const guestId = c.get('guestId');
  return guestId ? { type: 'guest', id: guestId } : null;
}

export async function requirePrincipal(c: Context<AppContext>): Promise<Principal> {
  return currentPrincipal(c) ?? { type: 'guest', id: await ensureGuest(c) };
}

/**
 * Moves the trips owned by the guest cookie presented on this request to the account. Only that
 * cookie can claim them, so other guests' trips are out of reach. It updates rows in place, so
 * running it twice creates no duplicates.
 */
export async function claimGuestTrips(c: Context<AppContext>, userId: string): Promise<number> {
  const guestId = c.get('guestId');
  if (!guestId) return 0;
  const now = nowIso();
  const results = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE trips SET user_id = ?, guest_id = NULL WHERE guest_id = ?').bind(userId, guestId),
    c.env.DB.prepare('UPDATE usage_records SET user_id = ? WHERE guest_id = ? AND user_id IS NULL').bind(userId, guestId),
    c.env.DB.prepare('UPDATE guests SET claimed_by_user_id = ?, claimed_at = ? WHERE id = ?').bind(userId, now, guestId),
  ]);
  deleteCookie(c, GUEST_COOKIE, { path: '/', secure: true });
  c.set('guestId', null);
  return results[0].meta.changes ?? 0;
}

export const loadIdentity: MiddlewareHandler<AppContext> = async (c, next) => {
  c.set('user', await loadUser(c));
  c.set('guestId', await loadGuest(c));
  await next();
};

export const requireUser: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!c.get('user')) throw new ApiError(401, 'UNAUTHENTICATED', 'Please log in to continue.');
  await next();
};

// ---- Administrators: separate cookie, table and session lifetime ----

export async function createAdminSession(c: Context<AppContext>, adminId: string): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare('INSERT INTO admin_sessions (id, token_hash, admin_id, created_at, last_seen_at, expires_at, absolute_expires_at) VALUES (?,?,?,?,?,?,?)')
    .bind(newId('ases'), await sha256(token), adminId, new Date(now).toISOString(), new Date(now).toISOString(), new Date(now + ADMIN_IDLE_MS).toISOString(), new Date(now + ADMIN_ABSOLUTE_MS).toISOString())
    .run();
  setAuthCookie(c, ADMIN_COOKIE, token, ADMIN_ABSOLUTE_MS / 1000, 'Strict');
}

export async function destroyAdminSession(c: Context<AppContext>, clearCookie = true): Promise<void> {
  const token = getCookie(c, ADMIN_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  if (clearCookie) deleteCookie(c, ADMIN_COOKIE, { path: '/', secure: true });
}

export const loadAdmin: MiddlewareHandler<AppContext> = async (c, next) => {
  c.set('admin', null);
  c.set('adminSessionId', null);
  const token = getCookie(c, ADMIN_COOKIE);
  if (token) {
    const row = await c.env.DB.prepare(
      `SELECT s.id AS session_id, s.expires_at, s.absolute_expires_at, a.id, a.username, a.status, a.must_change_password, a.created_at
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`,
    )
      .bind(await sha256(token))
      .first<AdminRow & { session_id: string; expires_at: string; absolute_expires_at: string }>();
    if (row) {
      const now = Date.now();
      if (Date.parse(row.expires_at) <= now || Date.parse(row.absolute_expires_at) <= now || row.status !== 'active') {
        await c.env.DB.prepare('DELETE FROM admin_sessions WHERE id = ?').bind(row.session_id).run();
      } else {
        const expires = Math.min(now + ADMIN_IDLE_MS, Date.parse(row.absolute_expires_at));
        await c.env.DB.prepare('UPDATE admin_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').bind(new Date(now).toISOString(), new Date(expires).toISOString(), row.session_id).run();
        const { id, username, status, must_change_password, created_at } = row;
        c.set('admin', { id, username, status, must_change_password, created_at });
        c.set('adminSessionId', row.session_id);
      }
    }
  }
  await next();
};

/** Requires a signed-in administrator. Used only by the password-change and identity endpoints. */
export const requireAdminIdentity: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!c.get('admin')) throw new ApiError(401, 'ADMIN_UNAUTHENTICATED', 'Administrator login required.');
  await next();
};

/** Requires an administrator who has already replaced any temporary password. */
export const requireAdmin: MiddlewareHandler<AppContext> = async (c, next) => {
  const admin = c.get('admin');
  if (!admin) throw new ApiError(401, 'ADMIN_UNAUTHENTICATED', 'Administrator login required.');
  if (admin.must_change_password) throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing.');
  await next();
};
