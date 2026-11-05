import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { itineraryCost } from '../../shared/analyze';
import { bucketKeys, parseRange } from '../admin/range';
import { operations, overview, timeseries } from '../admin/metrics';
import {
  createAdminSession,
  destroyAdminSession,
  requireAdmin,
  requireAdminIdentity,
} from '../auth/sessions';
import { emailConfigured } from '../email';
import type { AppContext } from '../env';
import { burnPasswordCheck, hashPassword, newId, sha256, verifyPassword } from '../lib/crypto';
import { ApiError, clientIp, escapeLike, nowIso, pageParams, parseJson, parseJsonColumn } from '../lib/http';
import { enforce, hit } from '../lib/rateLimit';
import { getSettings, SETTING_DEFAULTS } from '../lib/settings';
import { placesConfigured } from '../places/google';
import { listMessages, parseItinerary } from '../trips/repo';

export const adminRoutes = new Hono<AppContext>();

const adminPassword = z.string().min(12, 'Use at least 12 characters').max(128);
const username = z.string().trim().toLowerCase().min(3, 'Use at least 3 characters').max(40).regex(/^[a-z0-9._-]+$/, 'Use letters, numbers, dots, dashes and underscores');

async function audit(
  c: Context<AppContext>,
  entry: { action: string; target?: string | null; outcome: 'success' | 'failure' | 'denied'; detail?: string | null; actorId?: string | null; actorName?: string | null },
) {
  const admin = c.get('admin');
  await c.env.DB.prepare('INSERT INTO audit_log (created_at, actor_admin_id, actor_username, action, target, outcome, detail, ip_hash) VALUES (?,?,?,?,?,?,?,?)')
    .bind(
      nowIso(),
      entry.actorId ?? admin?.id ?? null,
      entry.actorName ?? admin?.username ?? null,
      entry.action,
      entry.target ?? null,
      entry.outcome,
      entry.detail ?? null,
      // Hashed so repeat sources can be correlated without storing addresses.
      (await sha256(`audit:${clientIp(c)}`)).slice(0, 16),
    )
    .run();
}

// ---- Authentication. These routes work without a fully activated session. ----

adminRoutes.post('/login', async (c) => {
  const body = await parseJson(c, z.object({ username: z.string().trim().toLowerCase().max(100), password: z.string().max(128) }));
  const ip = clientIp(c);
  const limits = [
    { scope: 'admin_login_acct', id: `${ip}:${await sha256(body.username)}`, max: 5, windowSeconds: 900 },
    { scope: 'admin_login_ip', id: ip, max: 15, windowSeconds: 3600 },
  ];
  for (const limit of limits) {
    const { allowed, retryAfter } = await hit(c.env.DB, limit);
    if (!allowed) {
      await audit(c, { action: 'admin.login', target: `admin:${body.username.slice(0, 40)}`, outcome: 'denied', detail: 'rate limited' });
      throw new ApiError(429, 'RATE_LIMITED', 'Too many login attempts. Please wait and try again.', { retryAfter });
    }
  }
  const admin = await c.env.DB.prepare('SELECT id, username, password_hash, status, must_change_password FROM admins WHERE username = ?')
    .bind(body.username)
    .first<{ id: string; username: string; password_hash: string; status: string; must_change_password: number }>();
  let valid = false;
  if (admin) valid = await verifyPassword(body.password, admin.password_hash);
  else await burnPasswordCheck(body.password);
  if (!admin || !valid || admin.status !== 'active') {
    await audit(c, {
      action: 'admin.login',
      target: `admin:${body.username.slice(0, 40)}`,
      outcome: 'failure',
      detail: admin && valid ? 'account disabled' : 'invalid credentials',
      actorId: admin?.id ?? null,
      actorName: admin?.username ?? null,
    });
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Those credentials are not valid.');
  }
  await destroyAdminSession(c, false);
  await createAdminSession(c, admin.id);
  await c.env.DB.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').bind(nowIso(), admin.id).run();
  await audit(c, { action: 'admin.login', target: `admin:${admin.username}`, outcome: 'success', actorId: admin.id, actorName: admin.username });
  return c.json({ admin: { id: admin.id, username: admin.username, must_change_password: Boolean(admin.must_change_password) } });
});

adminRoutes.post('/logout', async (c) => {
  const admin = c.get('admin');
  await destroyAdminSession(c);
  if (admin) await audit(c, { action: 'admin.logout', target: `admin:${admin.username}`, outcome: 'success' });
  return c.json({ ok: true });
});

adminRoutes.get('/me', requireAdminIdentity, (c) => {
  const admin = c.get('admin')!;
  return c.json({ admin: { id: admin.id, username: admin.username, must_change_password: Boolean(admin.must_change_password) } });
});

adminRoutes.post('/change-password', requireAdminIdentity, async (c) => {
  const admin = c.get('admin')!;
  await enforce(c.env.DB, [{ scope: 'admin_change_pw', id: admin.id, max: 8, windowSeconds: 900 }], 'Too many attempts. Please wait and try again.');
  const body = await parseJson(c, z.object({ current_password: z.string().max(128), new_password: adminPassword }));
  const row = await c.env.DB.prepare('SELECT password_hash FROM admins WHERE id = ?').bind(admin.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(body.current_password, row.password_hash))) {
    await audit(c, { action: 'admin.password_change', target: `admin:${admin.username}`, outcome: 'failure', detail: 'wrong current password' });
    throw new ApiError(400, 'INVALID_CURRENT_PASSWORD', 'Your current password is incorrect.', { fields: { current_password: 'Your current password is incorrect.' } });
  }
  if (body.new_password === body.current_password || body.new_password.toLowerCase() === admin.username || (await verifyPassword(body.new_password, row.password_hash))) {
    throw new ApiError(400, 'WEAK_PASSWORD', 'Choose a password different from your current one and your username.', { fields: { new_password: 'Choose a different password.' } });
  }
  const hash = await hashPassword(body.new_password);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE admins SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').bind(hash, nowIso(), admin.id),
    c.env.DB.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').bind(admin.id),
  ]);
  await createAdminSession(c, admin.id);
  await audit(c, { action: 'admin.password_change', target: `admin:${admin.username}`, outcome: 'success' });
  return c.json({ admin: { id: admin.id, username: admin.username, must_change_password: false } });
});

// ---- Everything below needs a valid administrator who has replaced any temporary password. ----
const secured = new Hono<AppContext>();
secured.use('*', requireAdmin);

// ---- Administrators ----

secured.get('/admins', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, username, status, must_change_password, created_at, created_by, last_login_at FROM admins ORDER BY created_at ASC').all();
  return c.json({ admins: results, self: c.get('admin')!.id });
});

secured.post('/admins', async (c) => {
  const body = await parseJson(c, z.object({ username, password: adminPassword }));
  const hash = await hashPassword(body.password);
  const now = nowIso();
  const res = await c.env.DB.prepare(
    `INSERT INTO admins (id, username, password_hash, status, must_change_password, created_at, updated_at, created_by)
     VALUES (?,?,?,'active',1,?,?,?) ON CONFLICT(username) DO NOTHING`,
  )
    .bind(newId('adm'), body.username, hash, now, now, c.get('admin')!.username)
    .run();
  if (res.meta.changes !== 1) {
    await audit(c, { action: 'admin.create', target: `admin:${body.username}`, outcome: 'failure', detail: 'username taken' });
    throw new ApiError(409, 'USERNAME_TAKEN', 'That username is already in use.', { fields: { username: 'That username is already in use.' } });
  }
  await audit(c, { action: 'admin.create', target: `admin:${body.username}`, outcome: 'success' });
  return c.json({ ok: true }, 201);
});

async function targetAdmin(c: Context<AppContext>) {
  const row = await c.env.DB.prepare('SELECT id, username, status FROM admins WHERE id = ?').bind(c.req.param('id')).first<{ id: string; username: string; status: string }>();
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Administrator not found.');
  return row;
}

secured.post('/admins/:id/reset-password', async (c) => {
  const target = await targetAdmin(c);
  if (target.id === c.get('admin')!.id) throw new ApiError(400, 'USE_CHANGE_PASSWORD', 'Use Change password for your own account.');
  const body = await parseJson(c, z.object({ password: adminPassword }));
  const hash = await hashPassword(body.password);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE admins SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?').bind(hash, nowIso(), target.id),
    c.env.DB.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').bind(target.id),
  ]);
  await audit(c, { action: 'admin.password_reset', target: `admin:${target.username}`, outcome: 'success' });
  return c.json({ ok: true });
});

// The active-count check is inside each write, so two concurrent actions cannot both remove
// the second-to-last administrator and leave none.
const OTHER_ACTIVE = "(SELECT COUNT(*) FROM admins WHERE status = 'active' AND id <> ?1) >= 1";

secured.post('/admins/:id/status', async (c) => {
  const target = await targetAdmin(c);
  const body = await parseJson(c, z.object({ status: z.enum(['active', 'disabled']) }));
  if (body.status === 'disabled') {
    if (target.id === c.get('admin')!.id) {
      await audit(c, { action: 'admin.disable', target: `admin:${target.username}`, outcome: 'denied', detail: 'self' });
      throw new ApiError(400, 'CANNOT_DISABLE_SELF', 'You cannot disable your own account.');
    }
    const res = await c.env.DB.prepare(`UPDATE admins SET status = 'disabled', updated_at = ?2 WHERE id = ?1 AND ${OTHER_ACTIVE}`).bind(target.id, nowIso()).run();
    if (res.meta.changes !== 1) {
      await audit(c, { action: 'admin.disable', target: `admin:${target.username}`, outcome: 'denied', detail: 'last active administrator' });
      throw new ApiError(400, 'LAST_ADMIN', 'You cannot disable the last active administrator.');
    }
    await c.env.DB.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').bind(target.id).run();
    await audit(c, { action: 'admin.disable', target: `admin:${target.username}`, outcome: 'success' });
  } else {
    await c.env.DB.prepare("UPDATE admins SET status = 'active', updated_at = ? WHERE id = ?").bind(nowIso(), target.id).run();
    await audit(c, { action: 'admin.enable', target: `admin:${target.username}`, outcome: 'success' });
  }
  return c.json({ ok: true });
});

secured.delete('/admins/:id', async (c) => {
  const target = await targetAdmin(c);
  const body = await parseJson(c, z.object({ confirm: z.string() }));
  if (body.confirm !== target.username) throw new ApiError(400, 'CONFIRMATION_MISMATCH', 'Type the username exactly to confirm.');
  if (target.id === c.get('admin')!.id) {
    await audit(c, { action: 'admin.delete', target: `admin:${target.username}`, outcome: 'denied', detail: 'self' });
    throw new ApiError(400, 'CANNOT_DELETE_SELF', 'You cannot delete your own account.');
  }
  const res = await c.env.DB.prepare(`DELETE FROM admins WHERE id = ?1 AND ${OTHER_ACTIVE}`).bind(target.id).run();
  // D1 includes cascaded session rows in this count, so anything above zero means it was deleted.
  if (!res.meta.changes) {
    await audit(c, { action: 'admin.delete', target: `admin:${target.username}`, outcome: 'denied', detail: 'last active administrator' });
    throw new ApiError(400, 'LAST_ADMIN', 'You cannot delete the last active administrator.');
  }
  await audit(c, { action: 'admin.delete', target: `admin:${target.username}`, outcome: 'success' });
  return c.json({ ok: true });
});

// ---- Metrics ----

const range = (c: Context<AppContext>) => parseRange({ range: c.req.query('range'), from: c.req.query('from'), to: c.req.query('to') });

secured.get('/metrics/overview', async (c) => c.json(await overview(c.env.DB, range(c))));
secured.get('/metrics/timeseries', async (c) => c.json(await timeseries(c.env.DB, range(c))));
secured.get('/metrics/operations', async (c) => c.json(await operations(c.env.DB, range(c))));

// ---- Application users ----

const USER_SORTS: Record<string, string> = {
  email: 'u.email_normalized',
  created_at: 'u.created_at',
  status: 'u.status',
  trips: 'trip_count',
  llm_cost: 'llm_cost',
  places_cost: 'places_cost',
  total_cost: 'total_cost',
};

function sortDir(c: Context<AppContext>, fallback: 'asc' | 'desc' = 'desc') {
  const dir = c.req.query('dir');
  return dir === 'asc' || dir === 'desc' ? dir : fallback;
}

secured.get('/users', async (c) => {
  const r = range(c);
  const { page, pageSize, offset } = pageParams(c);
  const search = (c.req.query('q') ?? '').trim().toLowerCase();
  const like = `%${escapeLike(search)}%`;
  const sort = USER_SORTS[c.req.query('sort') ?? 'created_at'] ?? 'u.created_at';
  const dir = sortDir(c);
  const [count, rows] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM users u WHERE u.email_normalized LIKE ? ESCAPE '\\'").bind(like),
    c.env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.status, u.email_verified_at, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM trips t WHERE t.user_id = u.id) AS trip_count,
        COALESCE(x.llm_cost, 0) AS llm_cost, COALESCE(x.places_cost, 0) AS places_cost, COALESCE(x.total_cost, 0) AS total_cost
       FROM users u
       LEFT JOIN (
         SELECT user_id,
           SUM(CASE WHEN kind='llm' THEN estimated_cost END) AS llm_cost,
           SUM(CASE WHEN kind='places' THEN estimated_cost END) AS places_cost,
           SUM(estimated_cost) AS total_cost
         FROM usage_records WHERE user_id IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY user_id
       ) x ON x.user_id = u.id
       WHERE u.email_normalized LIKE ? ESCAPE '\\'
       ORDER BY ${sort} ${dir}, u.id LIMIT ? OFFSET ?`,
    ).bind(r.from, r.to, like, pageSize, offset),
  ]);
  return c.json({ range: r, users: rows.results, total: (count.results[0] as { n: number }).n, page, pageSize });
});

secured.get('/users/:id', async (c) => {
  const r = range(c);
  const id = c.req.param('id');
  const user = await c.env.DB.prepare('SELECT id, email, name, default_currency, status, email_verified_at, created_at, updated_at, last_login_at FROM users WHERE id = ?').bind(id).first();
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
  const [totals, lifetime, trips, sessions, series] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind='llm' THEN estimated_cost END),0) AS llm_cost,
              COALESCE(SUM(CASE WHEN kind='places' THEN estimated_cost END),0) AS places_cost,
              COALESCE(SUM(estimated_cost),0) AS total_cost,
              COUNT(*) AS requests, COALESCE(SUM(status='error'),0) AS failures,
              COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens
       FROM usage_records WHERE user_id = ? AND created_at BETWEEN ? AND ?`,
    ).bind(id, r.from, r.to),
    c.env.DB.prepare('SELECT COALESCE(SUM(estimated_cost),0) AS total_cost, COUNT(*) AS requests FROM usage_records WHERE user_id = ?').bind(id),
    c.env.DB.prepare(
      `SELECT t.id, t.title, t.destination, t.created_at, t.updated_at, t.day_count,
        COALESCE(SUM(CASE WHEN x.kind='llm' THEN x.estimated_cost END),0) AS llm_cost,
        COALESCE(SUM(CASE WHEN x.kind='places' THEN x.estimated_cost END),0) AS places_cost,
        COALESCE(SUM(x.estimated_cost),0) AS total_cost
       FROM trips t LEFT JOIN usage_records x ON x.trip_id = t.id AND x.created_at BETWEEN ? AND ?
       WHERE t.user_id = ? GROUP BY t.id ORDER BY t.created_at DESC LIMIT 200`,
    ).bind(r.from, r.to, id),
    c.env.DB.prepare('SELECT COUNT(*) AS active FROM sessions WHERE user_id = ? AND expires_at > ?').bind(id, nowIso()),
    c.env.DB.prepare(
      `SELECT substr(created_at, 1, ${r.bucket === 'hour' ? 13 : 10}) AS bucket, COALESCE(SUM(estimated_cost),0) AS cost, COUNT(*) AS requests
       FROM usage_records WHERE user_id = ? AND created_at BETWEEN ? AND ? GROUP BY bucket`,
    ).bind(id, r.from, r.to),
  ]);
  const points = new Map((series.results as { bucket: string; cost: number; requests: number }[]).map((p) => [p.bucket, p]));
  return c.json({
    range: r,
    user,
    period: totals.results[0],
    lifetime: lifetime.results[0],
    trips: trips.results,
    active_sessions: (sessions.results[0] as { active: number }).active,
    series: bucketKeys(r).map((bucket) => ({ bucket, cost: points.get(bucket)?.cost ?? 0, requests: points.get(bucket)?.requests ?? 0 })),
  });
});

secured.post('/users/:id/status', async (c) => {
  const body = await parseJson(c, z.object({ status: z.enum(['active', 'disabled']) }));
  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(c.req.param('id')).first<{ id: string; email: string }>();
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
  const statements = [c.env.DB.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').bind(body.status, nowIso(), user.id)];
  if (body.status === 'disabled') statements.push(c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id));
  await c.env.DB.batch(statements);
  await audit(c, { action: body.status === 'disabled' ? 'user.disable' : 'user.enable', target: `user:${user.id}`, outcome: 'success' });
  return c.json({ ok: true });
});

/**
 * Deleting a user removes the account, sessions, tokens, trips and conversations through foreign-key
 * cascades. Usage rows stay, keeping only the opaque ids, so historical cost totals remain correct.
 * See README "User deletion".
 */
secured.delete('/users/:id', async (c) => {
  const body = await parseJson(c, z.object({ confirm: z.string() }));
  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(c.req.param('id')).first<{ id: string; email: string }>();
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
  if (body.confirm.trim().toLowerCase() !== user.email.toLowerCase()) throw new ApiError(400, 'CONFIRMATION_MISMATCH', "Type the user's email exactly to confirm.");
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
  await audit(c, { action: 'user.delete', target: `user:${user.id}`, outcome: 'success' });
  return c.json({ ok: true });
});

// ---- Trips ----

const TRIP_SORTS: Record<string, string> = {
  created_at: 't.created_at',
  updated_at: 't.updated_at',
  title: "COALESCE(t.title, t.destination, '')",
  days: 't.day_count',
  llm_cost: 'llm_cost',
  places_cost: 'places_cost',
  total_cost: 'total_cost',
};

secured.get('/trips', async (c) => {
  const { page, pageSize, offset } = pageParams(c);
  const search = (c.req.query('q') ?? '').trim();
  const owner = c.req.query('owner');
  const userId = c.req.query('userId');
  const where: string[] = [];
  const binds: unknown[] = [];
  if (search) {
    const like = `%${escapeLike(search.toLowerCase())}%`;
    where.push("(LOWER(COALESCE(t.title,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.destination,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(u.email,'')) LIKE ? ESCAPE '\\')");
    binds.push(like, like, like);
  }
  if (owner === 'guest') where.push('t.guest_id IS NOT NULL');
  if (owner === 'user') where.push('t.user_id IS NOT NULL');
  if (userId) {
    where.push('t.user_id = ?');
    binds.push(userId);
  }
  const createdFrom = c.req.query('createdFrom');
  const createdTo = c.req.query('createdTo');
  if (createdFrom && /^\d{4}-\d{2}-\d{2}$/.test(createdFrom)) {
    where.push('t.created_at >= ?');
    binds.push(`${createdFrom}T00:00:00.000Z`);
  }
  if (createdTo && /^\d{4}-\d{2}-\d{2}$/.test(createdTo)) {
    where.push('t.created_at <= ?');
    binds.push(`${createdTo}T23:59:59.999Z`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = range(c);
  const sort = TRIP_SORTS[c.req.query('sort') ?? 'created_at'] ?? 't.created_at';
  const dir = sortDir(c);
  const [count, rows] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM trips t LEFT JOIN users u ON u.id = t.user_id ${clause}`).bind(...binds),
    c.env.DB.prepare(
      `SELECT t.id, t.title, t.destination, t.user_id, t.guest_id, u.email AS user_email, t.created_at, t.updated_at, t.day_count,
        COALESCE(x.llm_cost,0) AS llm_cost, COALESCE(x.places_cost,0) AS places_cost, COALESCE(x.total_cost,0) AS total_cost
       FROM trips t LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN (
         SELECT trip_id, SUM(CASE WHEN kind='llm' THEN estimated_cost END) AS llm_cost,
           SUM(CASE WHEN kind='places' THEN estimated_cost END) AS places_cost, SUM(estimated_cost) AS total_cost
         FROM usage_records WHERE trip_id IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY trip_id
       ) x ON x.trip_id = t.id
       ${clause} ORDER BY ${sort} ${dir}, t.id LIMIT ? OFFSET ?`,
    ).bind(r.from, r.to, ...binds, pageSize, offset),
  ]);
  return c.json({ range: r, trips: rows.results, total: (count.results[0] as { n: number }).n, page, pageSize });
});

secured.get('/trips/:id', async (c) => {
  const id = c.req.param('id');
  const trip = await c.env.DB.prepare('SELECT t.*, u.email AS user_email FROM trips t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?').bind(id).first<any>();
  if (!trip) throw new ApiError(404, 'NOT_FOUND', 'Trip not found.');
  const [usage, totals] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM usage_records WHERE trip_id = ? ORDER BY created_at DESC LIMIT 200').bind(id),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind='llm' THEN estimated_cost END),0) AS llm_cost,
              COALESCE(SUM(CASE WHEN kind='places' THEN estimated_cost END),0) AS places_cost,
              COALESCE(SUM(estimated_cost),0) AS total_cost, COUNT(*) AS requests
       FROM usage_records WHERE trip_id = ?`,
    ).bind(id),
  ]);
  await audit(c, { action: 'trip.view', target: `trip:${id}`, outcome: 'success' });
  const itinerary = parseItinerary(trip.itinerary);
  return c.json({
    trip: {
      id: trip.id,
      title: trip.title,
      destination: trip.destination,
      user_id: trip.user_id,
      user_email: trip.user_email,
      guest_id: trip.guest_id,
      start_date: trip.start_date,
      end_date: trip.end_date,
      duration_days: trip.duration_days,
      adults: trip.adults,
      children_ages: parseJsonColumn(trip.children_ages, []),
      budget_amount: trip.budget_amount,
      currency: trip.currency,
      interests: parseJsonColumn(trip.interests, []),
      pace: trip.pace,
      constraints: trip.constraints,
      lodging: trip.lodging,
      created_at: trip.created_at,
      updated_at: trip.updated_at,
      day_count: trip.day_count,
      itinerary,
      est_trip_cost: itineraryCost(itinerary),
    },
    messages: await listMessages(c.env.DB, id),
    usage: usage.results,
    totals: totals.results[0],
  });
});

// ---- Usage records ----

secured.get('/usage', async (c) => {
  const r = range(c);
  const { page, pageSize, offset } = pageParams(c, 50);
  const where = ['created_at BETWEEN ? AND ?'];
  const binds: unknown[] = [r.from, r.to];
  const kind = c.req.query('kind');
  if (kind === 'llm' || kind === 'places') {
    where.push('kind = ?');
    binds.push(kind);
  }
  const status = c.req.query('status');
  if (status === 'success' || status === 'error') {
    where.push('status = ?');
    binds.push(status);
  }
  const attribution = c.req.query('attribution');
  if (attribution === 'outside_trip') where.push('trip_id IS NULL');
  if (attribution === 'deleted_trip') where.push('trip_id IS NOT NULL AND trip_id NOT IN (SELECT id FROM trips)');
  if (attribution === 'guest') where.push('guest_id IS NOT NULL AND user_id IS NULL');
  if (attribution === 'user') where.push('user_id IS NOT NULL');
  const userId = c.req.query('userId');
  if (userId) {
    where.push('user_id = ?');
    binds.push(userId);
  }
  const clause = where.join(' AND ');
  const [count, rows, sum] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM usage_records WHERE ${clause}`).bind(...binds),
    c.env.DB.prepare(`SELECT * FROM usage_records WHERE ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset),
    c.env.DB.prepare(`SELECT COALESCE(SUM(estimated_cost),0) AS total_cost FROM usage_records WHERE ${clause}`).bind(...binds),
  ]);
  return c.json({ range: r, records: rows.results, total: (count.results[0] as { n: number }).n, total_cost: (sum.results[0] as { total_cost: number }).total_cost, page, pageSize });
});

// ---- Audit log: read-only here, and database triggers block changes anywhere else ----

secured.get('/audit', async (c) => {
  const { page, pageSize, offset } = pageParams(c, 50);
  const action = (c.req.query('action') ?? '').trim();
  const clause = action ? "WHERE action LIKE ? ESCAPE '\\'" : '';
  const binds = action ? [`%${escapeLike(action)}%`] : [];
  const [count, rows] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).bind(...binds),
    c.env.DB.prepare(`SELECT seq, created_at, actor_username, action, target, outcome, detail FROM audit_log ${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset),
  ]);
  return c.json({ entries: rows.results, total: (count.results[0] as { n: number }).n, page, pageSize });
});

// ---- System configuration ----

secured.get('/system', async (c) => {
  const { results: rates } = await c.env.DB.prepare(
    'SELECT p.* FROM pricing_rates p JOIN (SELECT kind, sku, MAX(id) AS id FROM pricing_rates GROUP BY kind, sku) m ON m.id = p.id ORDER BY p.kind, p.sku',
  ).all();
  const model = c.env.LLM_MODEL ?? null;
  const modelPriced = model ? (rates as { kind: string; sku: string }[]).some((r) => r.kind === 'llm' && (r.sku === model || r.sku === model.replace(/-\d{4}-\d{2}-\d{2}$/, ''))) : false;
  return c.json({
    llm: { provider: c.env.LLM_PROVIDER ?? null, model, key_configured: Boolean(c.env.OPENAI_API_KEY), model_priced: modelPriced },
    places: { key_configured: placesConfigured(c.env) },
    email: { configured: emailConfigured(c.env), from: c.env.EMAIL_FROM ?? null },
    public_url: c.env.APP_PUBLIC_URL ?? null,
    settings: await getSettings(c.env.DB),
    rates,
  });
});

const settingsSchema = z
  .object(Object.fromEntries(Object.keys(SETTING_DEFAULTS).map((k) => [k, z.number().min(0).max(1_000_000).optional()])))
  .strict();

secured.patch('/settings', async (c) => {
  const body = await parseJson(c, settingsSchema);
  const admin = c.get('admin')!;
  const entries = Object.entries(body).filter((e): e is [string, number] => e[1] !== undefined);
  if (entries.length) {
    await c.env.DB.batch(
      entries.map(([key, value]) =>
        c.env.DB.prepare('INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by').bind(key, String(value), nowIso(), admin.username),
      ),
    );
    await audit(c, { action: 'config.settings_update', target: 'settings', outcome: 'success', detail: entries.map(([k, v]) => `${k}=${v}`).join(', ').slice(0, 500) });
  }
  return c.json({ settings: await getSettings(c.env.DB) });
});

/** Inserts a new rate version. Existing usage rows keep their own snapshot and are not recalculated. */
secured.post('/pricing', async (c) => {
  const body = await parseJson(
    c,
    z
      .object({
        kind: z.enum(['llm', 'places']),
        sku: z.string().trim().min(1).max(100),
        input_per_million: z.number().min(0).max(100_000).nullable().optional(),
        cached_input_per_million: z.number().min(0).max(100_000).nullable().optional(),
        output_per_million: z.number().min(0).max(100_000).nullable().optional(),
        per_1000_units: z.number().min(0).max(100_000).nullable().optional(),
        source_note: z.string().trim().max(300).nullable().optional(),
      })
      .superRefine((v, ctx) => {
        if (v.kind === 'llm' && (v.input_per_million == null || v.output_per_million == null)) ctx.addIssue({ code: 'custom', path: ['input_per_million'], message: 'LLM rates need input and output prices' });
        if (v.kind === 'places' && v.per_1000_units == null) ctx.addIssue({ code: 'custom', path: ['per_1000_units'], message: 'Places rates need a price per 1,000 requests' });
      }),
  );
  const admin = c.get('admin')!;
  await c.env.DB.prepare(
    `INSERT INTO pricing_rates (kind, sku, input_per_million, cached_input_per_million, output_per_million, per_1000_units, source_note, created_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(body.kind, body.sku, body.input_per_million ?? null, body.cached_input_per_million ?? null, body.output_per_million ?? null, body.per_1000_units ?? null, body.source_note ?? null, nowIso(), admin.username)
    .run();
  await audit(c, { action: 'config.pricing_update', target: `${body.kind}:${body.sku}`, outcome: 'success', detail: JSON.stringify({ input: body.input_per_million, cached: body.cached_input_per_million, output: body.output_per_million, per_1000: body.per_1000_units }) });
  return c.json({ ok: true }, 201);
});

adminRoutes.route('/', secured);
