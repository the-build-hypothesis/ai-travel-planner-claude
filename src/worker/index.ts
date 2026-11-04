import { Hono } from "hono";
import type { AppBindings, Env } from "./env";
import { BUILD_INFO } from "./build-info";
import { uuid } from "./lib/crypto";
import { ApiError } from "./lib/errors";
import { cleanupRateLimits } from "./lib/ratelimit";
import { readLlmConfig } from "./llm";
import { authRoutes, accountRoutes } from "./routes/auth";
import { tripRoutes } from "./routes/trips";
import { adminAuthRoutes, adminAccountRoutes } from "./routes/admin/auth";
import { adminDataRoutes } from "./routes/admin/data";
import { loadAdminSession, loadGuest, loadUserSession } from "./services/sessions";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function allowedOrigins(env: Env, reqUrl: string): Set<string> {
  const set = new Set<string>([new URL(reqUrl).origin]);
  try {
    if (env.APP_PUBLIC_URL) set.add(new URL(env.APP_PUBLIC_URL).origin);
  } catch {
    /* ignore malformed */
  }
  return set;
}

export const app = new Hono<AppBindings>();

// Security headers for API responses.
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
});

// CSRF protection: state-changing requests must (1) carry a custom header, which
// cross-site forms cannot set without a CORS preflight (we never grant CORS), and
// (2) if the browser sends Origin / Sec-Fetch-Site, it must be same-origin.
app.use("/api/*", async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    if (c.req.header("x-requested-with") !== "fetch") {
      throw new ApiError(403, "CSRF", "Request blocked: missing anti-forgery header.");
    }
    const origin = c.req.header("origin");
    if (origin && !allowedOrigins(c.env, c.req.url).has(origin)) {
      throw new ApiError(403, "CSRF", "Request blocked: cross-origin request.");
    }
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") {
      throw new ApiError(403, "CSRF", "Request blocked: cross-site request.");
    }
  }
  await next();
});

// Identity resolution. Admin and user identities are resolved independently and
// never grant access to each other's routes.
app.use("/api/admin/*", async (c, next) => {
  c.set("user", null);
  c.set("guestId", null);
  await loadAdminSession(c);
  await next();
});
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/admin/")) return next();
  c.set("admin", null);
  await loadUserSession(c);
  if (!c.get("user")) await loadGuest(c);
  else c.set("guestId", null);
  await next();
});

app.get("/api/health", async (c) => {
  let llm: { provider: string | null; model: string | null; configured: boolean };
  try {
    const cfg = readLlmConfig(c.env);
    llm = { provider: cfg.provider, model: cfg.model, configured: Boolean(c.env.OPENAI_API_KEY) || cfg.provider !== "openai" };
  } catch {
    llm = { provider: c.env.LLM_PROVIDER ?? null, model: c.env.LLM_MODEL ?? null, configured: false };
  }
  let db = false;
  try {
    db = (await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>())?.ok === 1;
  } catch {
    db = false;
  }
  return c.json({
    ok: db,
    commit: BUILD_INFO.commit,
    builtAt: BUILD_INFO.builtAt,
    buildSource: BUILD_INFO.source,
    llm,
    places: { configured: Boolean(c.env.GOOGLE_MAPS_API_KEY) },
    email: { binding: Boolean(c.env.EMAIL), senderConfigured: Boolean(c.env.EMAIL_FROM) },
    publicUrlConfigured: Boolean(c.env.APP_PUBLIC_URL),
    database: db,
  });
});

app.get("/api/me", (c) => {
  const user = c.get("user");
  return c.json({
    user,
    guest: !user && Boolean(c.get("guestId")),
    features: { places: Boolean(c.env.GOOGLE_MAPS_API_KEY), email: Boolean(c.env.EMAIL && c.env.EMAIL_FROM) },
  });
});

app.route("/api/auth", authRoutes);
app.route("/api/account", accountRoutes);
app.route("/api/trips", tripRoutes);
app.route("/api/admin/auth", adminAuthRoutes);
app.route("/api/admin/admins", adminAccountRoutes);
app.route("/api/admin", adminDataRoutes);

app.all("/api/*", () => {
  throw new ApiError(404, "NOT_FOUND", "Unknown API endpoint.");
});

// Non-API paths are served by the static assets binding (SPA fallback).
app.all("*", async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text("Not found", 404);
});

app.onError(async (err, c) => {
  if (err instanceof ApiError) {
    if (err.status === 429 && err.details && typeof err.details === "object" && "retryAfter" in err.details) {
      c.header("Retry-After", String((err.details as { retryAfter: number }).retryAfter));
    }
    if (err.status >= 500) await logAppError(c.env, c.req.method, c.req.path, err.status, err.code, err.message);
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, err.status);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("Unhandled error", c.req.method, c.req.path, message);
  await logAppError(c.env, c.req.method, c.req.path, 500, "INTERNAL", message);
  return c.json({ error: { code: "INTERNAL", message: "Something went wrong on our side. Please try again.", details: null } }, 500);
});

async function logAppError(env: Env, method: string, path: string, status: number, code: string, message: string) {
  try {
    // Paths only (no query strings, which could contain tokens).
    await env.DB.prepare(`INSERT INTO app_errors (id, created_at, method, path, status, code, message) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), Date.now(), method, path.slice(0, 200), status, code, message.slice(0, 500))
      .run();
  } catch {
    /* ignore */
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (Math.random() < 0.01) ctx.waitUntil(cleanupRateLimits(env.DB).catch(() => {}));
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
