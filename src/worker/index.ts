import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { loadAdmin, loadIdentity } from './auth/sessions';
import type { AppContext, Env } from './env';
import { randomToken } from './lib/crypto';
import { logError, recordRequestMetric } from './lib/errors';
import { ApiError } from './lib/http';
import { adminRoutes } from './routes/admin';
import { accountRoutes, authRoutes } from './routes/auth';
import { configRoute, exploreRoutes, tripRoutes } from './routes/trips';

const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // Map tile servers ask for a referrer. Origin-only keeps reset and verification tokens out of it.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    // Leaflet positions its map panes with inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://tile.openstreetmap.org",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
};

function isLocal(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function routeGroup(path: string): string {
  if (path.startsWith('/api/admin')) return 'admin';
  if (path.startsWith('/api/auth') || path.startsWith('/api/account')) return 'auth';
  if (/^\/api\/trips\/[^/]+\/(messages|days)/.test(path)) return 'planner';
  if (path.startsWith('/api/trips')) return 'trips';
  if (path.startsWith('/api/explore')) return 'explore';
  return 'other';
}

const app = new Hono<AppContext>();

app.onError(async (err, c) => {
  if (err instanceof ApiError) {
    const headers: Record<string, string> = {};
    if (typeof err.extra?.retryAfter === 'number') headers['Retry-After'] = String(err.extra.retryAfter);
    return c.json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status, headers);
  }
  if (err instanceof HTTPException) {
    const code = err.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST';
    return c.json({ error: { code, message: err.status === 413 ? 'That request is too large.' : 'That request could not be processed.' } }, err.status);
  }
  const requestId = c.get('requestId');
  console.error('unhandled error', requestId, err);
  c.executionCtx.waitUntil(logError(c.env.DB, { source: 'api', code: 'unhandled', message: err.message, path: c.req.path, requestId }));
  return c.json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.', requestId } }, 500);
});

const api = new Hono<AppContext>();

/**
 * CSRF defense in addition to SameSite cookies: a state-changing request carrying a foreign Origin
 * or a cross-site fetch marker is rejected before any handler runs.
 */
api.use('*', async (c, next) => {
  c.set('requestId', randomToken(8));
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const url = new URL(c.req.url);
    const origin = c.req.header('origin');
    const allowed = new Set([url.origin]);
    if (c.env.APP_PUBLIC_URL) allowed.add(new URL(c.env.APP_PUBLIC_URL).origin);
    const localDev = origin && isLocal(url.hostname) && isLocal(new URL(origin).hostname);
    if (origin && !allowed.has(origin) && !localDev) throw new ApiError(403, 'CSRF_REJECTED', 'This request came from an untrusted origin.');
    if (!origin && c.req.header('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'CSRF_REJECTED', 'This request came from an untrusted origin.');
    const type = c.req.header('content-type') ?? '';
    const length = c.req.header('content-length');
    if (length && length !== '0' && !type.toLowerCase().startsWith('application/json')) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Requests must be sent as JSON.');
    }
  }
  await next();
});

api.use('*', bodyLimit({ maxSize: 64 * 1024, onError: () => { throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'That request is too large.'); } }));

// Request-volume metrics for the dashboard, written after the response has been produced.
api.use('*', async (c, next) => {
  const started = Date.now();
  await next();
  c.executionCtx.waitUntil(recordRequestMetric(c.env.DB, routeGroup(c.req.path), c.res.status, Date.now() - started));
  c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
});

api.get('/health', async (c) => {
  let database = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch {
    database = 'error';
  }
  let build: unknown = null;
  try {
    const res = await c.env.ASSETS.fetch(new Request(new URL('/build.json', c.req.url)));
    if (res.ok) build = await res.json();
  } catch {
    /* Reported as null when no build info is available. */
  }
  return c.json({ status: database === 'ok' ? 'ok' : 'degraded', database, build }, database === 'ok' ? 200 : 503);
});

// Admin routes load only admin identity, and user routes load only user identity,
// so neither kind of session can ever satisfy the other's checks.
const admin = new Hono<AppContext>();
admin.use('*', loadAdmin);
admin.route('/', adminRoutes);
api.route('/admin', admin);

const user = new Hono<AppContext>();
user.use('*', loadIdentity);
user.route('/auth', authRoutes);
user.route('/account', accountRoutes);
user.route('/trips', tripRoutes);
user.route('/explore', exploreRoutes);
user.route('/config', configRoute);
api.route('/', user);

api.all('*', () => {
  throw new ApiError(404, 'NOT_FOUND', 'That API route does not exist.');
});

app.route('/api', api);

app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  // HTML must revalidate so users pick up new deployments; hashed assets can stay cached.
  const out = new Response(res.body, res);
  if ((out.headers.get('content-type') ?? '').includes('text/html')) out.headers.set('Cache-Control', 'no-cache');
  return out;
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && !isLocal(url.hostname)) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    const res = await app.fetch(request, env, ctx);
    const out = new Response(res.body, res);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
    return out;
  },

  /** Daily housekeeping: expired sessions, tokens and counters, and old operational rows. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const now = new Date();
    const iso = now.toISOString();
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(iso),
      env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(iso),
      env.DB.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').bind(days(7)),
      env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now.getTime() - 2 * 86_400_000),
      env.DB.prepare('DELETE FROM place_cache WHERE fetched_at < ?').bind(days(30)),
      env.DB.prepare('DELETE FROM error_logs WHERE created_at < ?').bind(days(90)),
      env.DB.prepare('DELETE FROM api_metrics WHERE bucket < ?').bind(days(400).slice(0, 13)),
    ]);
  },
};
