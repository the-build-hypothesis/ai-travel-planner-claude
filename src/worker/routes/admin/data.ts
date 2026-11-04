import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../env";
import { badRequest, notFound } from "../../lib/errors";
import { parseJson } from "../../lib/http";
import { parseItinerary, parsePrefs, toMessage, type TripRow } from "../trips";
import { audit, likePattern, pageParams, parseRange, requireAdmin, type Range } from "./common";

const HOUR = 3600_000;
const DAY = 86400_000;

/** Bucket size: hourly up to 3 days, daily up to 120 days, weekly beyond. All UTC. */
export function bucketFor(r: Range): { size: number; label: "hour" | "day" | "week" } {
  const span = r.to - r.from;
  if (span <= 3 * DAY) return { size: HOUR, label: "hour" };
  if (span <= 120 * DAY) return { size: DAY, label: "day" };
  return { size: 7 * DAY, label: "week" };
}

function bucketStarts(r: Range, size: number): number[] {
  const start = Math.floor(r.from / size) * size;
  const out: number[] = [];
  for (let t = start; t <= r.to && out.length < 2000; t += size) out.push(t);
  return out;
}

const n = (v: unknown) => Number(v ?? 0);

export const adminDataRoutes = new Hono<AppBindings>()
  .use(requireAdmin())

  // ───────────── Overview ─────────────
  .get("/overview", async (c) => {
    const r = parseRange(c);
    const db = c.env.DB;
    const [lifetime, period, periodTrips] = await db.batch([
      db.prepare(
        `SELECT
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM trips) AS trips,
          (SELECT COUNT(*) FROM trips WHERE guest_id IS NOT NULL) AS guest_trips,
          (SELECT COUNT(*) FROM guests) AS guests,
          (SELECT COALESCE(SUM(cost_usd),0) FROM usage_events WHERE provider='openai') AS llm_cost,
          (SELECT COALESCE(SUM(cost_usd),0) FROM usage_events WHERE provider='google_places') AS places_cost,
          (SELECT COUNT(*) FROM usage_events WHERE provider='openai' AND cost_usd IS NULL AND status='success') AS unpriced`,
      ),
      db.prepare(
        `SELECT
          (SELECT COUNT(*) FROM users WHERE created_at >= ?1 AND created_at < ?2) AS new_users,
          COALESCE(SUM(CASE WHEN provider='openai' THEN cost_usd END),0) AS llm_cost,
          COALESCE(SUM(CASE WHEN provider='google_places' THEN cost_usd END),0) AS places_cost,
          COALESCE(SUM(CASE WHEN user_id IS NULL AND guest_id IS NOT NULL THEN cost_usd END),0) AS guest_cost,
          COALESCE(SUM(CASE WHEN user_id IS NOT NULL THEN cost_usd END),0) AS user_cost,
          COALESCE(SUM(CASE WHEN trip_id IS NULL THEN cost_usd END),0) AS no_trip_cost,
          COALESCE(SUM(CASE WHEN user_id IS NULL AND guest_id IS NULL THEN cost_usd END),0) AS no_owner_cost,
          COALESCE(SUM(CASE WHEN provider='openai' THEN 1 END),0) AS llm_requests,
          COALESCE(SUM(CASE WHEN provider='google_places' THEN 1 END),0) AS places_requests,
          COALESCE(SUM(CASE WHEN provider='openai' AND status='error' THEN 1 END),0) AS llm_failures,
          COALESCE(SUM(CASE WHEN provider='google_places' AND status='error' THEN 1 END),0) AS places_failures,
          COALESCE(SUM(input_tokens),0) AS input_tokens,
          COALESCE(SUM(output_tokens),0) AS output_tokens,
          COALESCE(SUM(cached_input_tokens),0) AS cached_tokens,
          AVG(CASE WHEN provider='openai' AND status='success' THEN duration_ms END) AS llm_avg_ms,
          AVG(CASE WHEN provider='google_places' AND status='success' THEN duration_ms END) AS places_avg_ms
         FROM usage_events WHERE created_at >= ?1 AND created_at < ?2`,
      ).bind(r.from, r.to),
      db.prepare(
        `SELECT COUNT(*) AS trips, COALESCE(SUM(CASE WHEN guest_id IS NOT NULL THEN 1 END),0) AS guest_trips
         FROM trips WHERE created_at >= ? AND created_at < ?`,
      ).bind(r.from, r.to),
    ]);
    const L: any = lifetime.results[0];
    const P: any = period.results[0];
    const T: any = periodTrips.results[0];

    const b = bucketFor(r);
    const starts = bucketStarts(r, b.size);
    const [usageSeries, tripSeries, userSeries] = await db.batch([
      db.prepare(
        `SELECT (created_at / ?1) * ?1 AS b, provider,
            COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN status='error' THEN 1 END),0) AS errors,
            COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens
         FROM usage_events WHERE created_at >= ?2 AND created_at < ?3 GROUP BY b, provider`,
      ).bind(b.size, r.from, r.to),
      db.prepare(
        `SELECT (created_at / ?1) * ?1 AS b, COUNT(*) AS trips, COALESCE(SUM(CASE WHEN guest_id IS NOT NULL THEN 1 END),0) AS guest_trips
         FROM trips WHERE created_at >= ?2 AND created_at < ?3 GROUP BY b`,
      ).bind(b.size, r.from, r.to),
      db.prepare(`SELECT (created_at / ?1) * ?1 AS b, COUNT(*) AS users FROM users WHERE created_at >= ?2 AND created_at < ?3 GROUP BY b`).bind(
        b.size,
        r.from,
        r.to,
      ),
    ]);
    const series = starts.map((t) => ({
      t,
      llmCost: 0,
      placesCost: 0,
      llmRequests: 0,
      placesRequests: 0,
      llmErrors: 0,
      placesErrors: 0,
      inputTokens: 0,
      outputTokens: 0,
      trips: 0,
      guestTrips: 0,
      users: 0,
    }));
    const idx = new Map(starts.map((t, i) => [t, i]));
    for (const row of usageSeries.results as any[]) {
      const i = idx.get(n(row.b));
      if (i === undefined) continue;
      const s = series[i];
      if (row.provider === "openai") {
        s.llmCost += n(row.cost);
        s.llmRequests += n(row.requests);
        s.llmErrors += n(row.errors);
        s.inputTokens += n(row.input_tokens);
        s.outputTokens += n(row.output_tokens);
      } else if (row.provider === "google_places") {
        s.placesCost += n(row.cost);
        s.placesRequests += n(row.requests);
        s.placesErrors += n(row.errors);
      }
    }
    for (const row of tripSeries.results as any[]) {
      const i = idx.get(n(row.b));
      if (i !== undefined) {
        series[i].trips = n(row.trips);
        series[i].guestTrips = n(row.guest_trips);
      }
    }
    for (const row of userSeries.results as any[]) {
      const i = idx.get(n(row.b));
      if (i !== undefined) series[i].users = n(row.users);
    }

    return c.json({
      range: r,
      timezone: "UTC",
      lifetime: {
        users: n(L.users),
        trips: n(L.trips),
        guestTrips: n(L.guest_trips),
        guests: n(L.guests),
        llmCost: n(L.llm_cost),
        placesCost: n(L.places_cost),
        totalCost: n(L.llm_cost) + n(L.places_cost),
        unpricedLlmRequests: n(L.unpriced),
      },
      period: {
        newUsers: n(P.new_users),
        trips: n(T.trips),
        guestTrips: n(T.guest_trips),
        llmCost: n(P.llm_cost),
        placesCost: n(P.places_cost),
        totalCost: n(P.llm_cost) + n(P.places_cost),
        userCost: n(P.user_cost),
        guestCost: n(P.guest_cost),
        noTripCost: n(P.no_trip_cost),
        noOwnerCost: n(P.no_owner_cost),
        llmRequests: n(P.llm_requests),
        placesRequests: n(P.places_requests),
        llmFailures: n(P.llm_failures),
        placesFailures: n(P.places_failures),
        inputTokens: n(P.input_tokens),
        outputTokens: n(P.output_tokens),
        cachedTokens: n(P.cached_tokens),
        llmAvgMs: P.llm_avg_ms === null ? null : Math.round(n(P.llm_avg_ms)),
        placesAvgMs: P.places_avg_ms === null ? null : Math.round(n(P.places_avg_ms)),
      },
      bucket: b.label,
      series,
      config: {
        llmProvider: c.env.LLM_PROVIDER ?? null,
        llmModel: c.env.LLM_MODEL ?? null,
        placesConfigured: Boolean(c.env.GOOGLE_MAPS_API_KEY),
        emailConfigured: Boolean(c.env.EMAIL && c.env.EMAIL_FROM),
      },
    });
  })

  // ───────────── Users ─────────────
  .get("/users", async (c) => {
    const r = parseRange(c);
    const { page, pageSize, offset } = pageParams(c);
    const q = (c.req.query("q") || "").trim().toLowerCase().slice(0, 100);
    const sortMap: Record<string, string> = {
      created: "u.created_at",
      email: "u.email_normalized",
      trips: "trip_count",
      llm: "llm_cost",
      places: "places_cost",
      cost: "total_cost",
    };
    const sort = sortMap[c.req.query("sort") || "created"] ?? "u.created_at";
    const dir = c.req.query("dir") === "asc" ? "ASC" : "DESC";
    const status = c.req.query("status");
    const where: string[] = [];
    const params: unknown[] = [r.from, r.to];
    if (q) {
      where.push(`u.email_normalized LIKE ? ESCAPE '\\'`);
      params.push(likePattern(q));
    }
    if (status === "active" || status === "disabled") {
      where.push(`u.status = ?`);
      params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT u.id, u.email, u.display_name, u.status, u.email_verified_at, u.created_at,
        (SELECT COUNT(*) FROM trips t WHERE t.user_id = u.id) AS trip_count,
        COALESCE((SELECT SUM(cost_usd) FROM usage_events e WHERE e.user_id = u.id AND e.provider='openai' AND e.created_at >= ?1 AND e.created_at < ?2),0) AS llm_cost,
        COALESCE((SELECT SUM(cost_usd) FROM usage_events e WHERE e.user_id = u.id AND e.provider='google_places' AND e.created_at >= ?1 AND e.created_at < ?2),0) AS places_cost,
        COALESCE((SELECT SUM(cost_usd) FROM usage_events e WHERE e.user_id = u.id AND e.created_at >= ?1 AND e.created_at < ?2),0) AS total_cost
      FROM users u ${whereSql.replace(/\?/g, () => "?")}
      ORDER BY ${sort} ${dir}, u.id ASC LIMIT ${pageSize} OFFSET ${offset}`;
    // Positional params: ?1 ?2 are range; following ? bind sequentially after them.
    const rows = await c.env.DB.prepare(numberPlaceholders(sql, 3)).bind(...params).all();
    const total = await c.env.DB.prepare(numberPlaceholders(`SELECT COUNT(*) AS n FROM users u ${whereSql}`, 1))
      .bind(...params.slice(2))
      .first<{ n: number }>();
    return c.json({
      range: r,
      page,
      pageSize,
      total: total?.n ?? 0,
      users: (rows.results as any[]).map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        status: u.status,
        emailVerified: u.email_verified_at !== null,
        createdAt: u.created_at,
        tripCount: n(u.trip_count),
        llmCost: n(u.llm_cost),
        placesCost: n(u.places_cost),
        totalCost: n(u.total_cost),
      })),
    });
  })

  .get("/users/:id", async (c) => {
    const r = parseRange(c);
    const id = c.req.param("id");
    const db = c.env.DB;
    const u = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<any>();
    if (!u) throw notFound("User not found.");
    const [trips, usage, totals, sessions] = await db.batch([
      db.prepare(
        `SELECT t.id, t.title, t.destination, t.day_count, t.created_at, t.updated_at,
           COALESCE((SELECT SUM(cost_usd) FROM usage_events e WHERE e.trip_id = t.id AND e.provider='openai'),0) AS llm_cost,
           COALESCE((SELECT SUM(cost_usd) FROM usage_events e WHERE e.trip_id = t.id AND e.provider='google_places'),0) AS places_cost,
           COALESCE((SELECT SUM(cost_usd) FROM usage_events e WHERE e.trip_id = t.id AND e.created_at >= ?2 AND e.created_at < ?3),0) AS period_cost
         FROM trips t WHERE t.user_id = ?1 ORDER BY t.created_at DESC LIMIT 200`,
      ).bind(id, r.from, r.to),
      db.prepare(`SELECT * FROM usage_events WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 100`).bind(id, r.from, r.to),
      db.prepare(
        `SELECT COUNT(*) AS requests,
          COALESCE(SUM(CASE WHEN provider='openai' THEN 1 END),0) AS llm_requests,
          COALESCE(SUM(CASE WHEN provider='google_places' THEN 1 END),0) AS places_requests,
          COALESCE(SUM(CASE WHEN status='error' THEN 1 END),0) AS errors,
          COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
          COALESCE(SUM(CASE WHEN provider='openai' THEN cost_usd END),0) AS llm_cost,
          COALESCE(SUM(CASE WHEN provider='google_places' THEN cost_usd END),0) AS places_cost,
          COALESCE(SUM(CASE WHEN trip_id IS NULL THEN cost_usd END),0) AS no_trip_cost,
          MAX(created_at) AS last_request_at
         FROM usage_events WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
      ).bind(id, r.from, r.to),
      db.prepare(`SELECT COUNT(*) AS active, MAX(last_seen_at) AS last_seen FROM sessions WHERE user_id = ? AND expires_at > ?`).bind(id, Date.now()),
    ]);
    const msgCount = await db
      .prepare(`SELECT COUNT(*) AS n FROM messages m JOIN trips t ON t.id = m.trip_id WHERE t.user_id = ? AND m.role='user' AND m.created_at >= ? AND m.created_at < ?`)
      .bind(id, r.from, r.to)
      .first<{ n: number }>();
    await audit(c, { action: "user.view", targetType: "user", targetId: id, outcome: "success" });
    const T: any = totals.results[0];
    const S: any = sessions.results[0];
    return c.json({
      range: r,
      user: {
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        status: u.status,
        emailVerified: u.email_verified_at !== null,
        emailVerifiedAt: u.email_verified_at,
        createdAt: u.created_at,
        updatedAt: u.updated_at,
        passwordChangedAt: u.password_changed_at,
      },
      activity: {
        activeSessions: n(S.active),
        lastSeenAt: S.last_seen ?? null,
        messagesSent: msgCount?.n ?? 0,
        requests: n(T.requests),
        llmRequests: n(T.llm_requests),
        placesRequests: n(T.places_requests),
        errors: n(T.errors),
        inputTokens: n(T.input_tokens),
        outputTokens: n(T.output_tokens),
        llmCost: n(T.llm_cost),
        placesCost: n(T.places_cost),
        totalCost: n(T.llm_cost) + n(T.places_cost),
        noTripCost: n(T.no_trip_cost),
        lastRequestAt: T.last_request_at ?? null,
      },
      trips: (trips.results as any[]).map((t) => ({
        id: t.id,
        title: t.title,
        destination: t.destination,
        dayCount: t.day_count,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        llmCost: n(t.llm_cost),
        placesCost: n(t.places_cost),
        totalCost: n(t.llm_cost) + n(t.places_cost),
        periodCost: n(t.period_cost),
      })),
      usage: (usage.results as any[]).map(usageDto),
    });
  })

  .post("/users/:id/status", async (c) => {
    const id = c.req.param("id");
    const { status } = await parseJson(c, z.object({ status: z.enum(["active", "disabled"]) }));
    const u = await c.env.DB.prepare(`SELECT id, email FROM users WHERE id = ?`).bind(id).first<{ id: string; email: string }>();
    if (!u) throw notFound("User not found.");
    await c.env.DB.prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`).bind(status, Date.now(), id).run();
    if (status === "disabled") await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
    await audit(c, { action: status === "disabled" ? "user.disable" : "user.enable", targetType: "user", targetId: id, outcome: "success" });
    return c.json({ ok: true });
  })

  // Protected deletion: requires typing the user's email. Trips/messages/sessions are
  // deleted; usage_events are retained (no PII) for cost accounting.
  .delete("/users/:id", async (c) => {
    const id = c.req.param("id");
    const { confirmEmail } = await parseJson(c, z.object({ confirmEmail: z.string().max(254) }));
    const u = await c.env.DB.prepare(`SELECT id, email_normalized FROM users WHERE id = ?`).bind(id).first<{ id: string; email_normalized: string }>();
    if (!u) throw notFound("User not found.");
    if (confirmEmail.trim().toLowerCase() !== u.email_normalized) {
      throw badRequest("confirmEmail: Type the user's email address exactly to confirm deletion.");
    }
    const tripCount = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM trips WHERE user_id = ?`).bind(id).first<{ n: number }>();
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM messages WHERE trip_id IN (SELECT id FROM trips WHERE user_id = ?)`).bind(id),
      c.env.DB.prepare(`DELETE FROM trips WHERE user_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM email_tokens WHERE user_id = ?`).bind(id),
      c.env.DB.prepare(`UPDATE guests SET claimed_by_user_id = NULL WHERE claimed_by_user_id = ?`).bind(id),
      c.env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id),
    ]);
    await audit(c, { action: "user.delete", targetType: "user", targetId: id, outcome: "success", detail: { tripsDeleted: tripCount?.n ?? 0 } });
    return c.json({ ok: true, tripsDeleted: tripCount?.n ?? 0 });
  })

  // ───────────── Trips ─────────────
  .get("/trips", async (c) => {
    const r = parseRange(c);
    const { page, pageSize, offset } = pageParams(c);
    const q = (c.req.query("q") || "").trim().toLowerCase().slice(0, 100);
    const owner = c.req.query("owner");
    const userId = c.req.query("userId");
    const guestId = c.req.query("guestId");
    const createdInRange = c.req.query("createdInRange") === "1";
    const sortMap: Record<string, string> = { created: "t.created_at", updated: "t.updated_at", days: "t.day_count", cost: "period_cost" };
    const sort = sortMap[c.req.query("sort") || "created"] ?? "t.created_at";
    const dir = c.req.query("dir") === "asc" ? "ASC" : "DESC";
    const where: string[] = [];
    const params: unknown[] = [];
    if (q) {
      where.push(`(LOWER(t.title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.destination,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(u.email,'')) LIKE ? ESCAPE '\\')`);
      params.push(likePattern(q), likePattern(q), likePattern(q));
    }
    if (owner === "guest") where.push(`t.guest_id IS NOT NULL`);
    if (owner === "user") where.push(`t.user_id IS NOT NULL`);
    if (userId) {
      where.push(`t.user_id = ?`);
      params.push(userId);
    }
    if (guestId) {
      where.push(`t.guest_id = ?`);
      params.push(guestId);
    }
    if (createdInRange) {
      where.push(`t.created_at >= ? AND t.created_at < ?`);
      params.push(r.from, r.to);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT t.id, t.title, t.destination, t.user_id, t.guest_id, t.day_count, t.created_at, t.updated_at, u.email AS user_email,
        COALESCE((SELECT SUM(cost_usd) FROM usage_events e WHERE e.trip_id = t.id AND e.provider='openai' AND e.created_at >= ?1 AND e.created_at < ?2),0) AS llm_cost,
        COALESCE((SELECT SUM(cost_usd) FROM usage_events e WHERE e.trip_id = t.id AND e.provider='google_places' AND e.created_at >= ?1 AND e.created_at < ?2),0) AS places_cost,
        COALESCE((SELECT SUM(cost_usd) FROM usage_events e WHERE e.trip_id = t.id AND e.created_at >= ?1 AND e.created_at < ?2),0) AS period_cost,
        COALESCE((SELECT SUM(cost_usd) FROM usage_events e WHERE e.trip_id = t.id),0) AS lifetime_cost
      FROM trips t LEFT JOIN users u ON u.id = t.user_id
      ${whereSql}
      ORDER BY ${sort} ${dir}, t.id ASC LIMIT ${pageSize} OFFSET ${offset}`;
    const rows = await c.env.DB.prepare(numberPlaceholders(sql, 3)).bind(r.from, r.to, ...params).all();
    const total = await c.env.DB.prepare(numberPlaceholders(`SELECT COUNT(*) AS n FROM trips t LEFT JOIN users u ON u.id = t.user_id ${whereSql}`, 1))
      .bind(...params)
      .first<{ n: number }>();
    return c.json({
      range: r,
      page,
      pageSize,
      total: total?.n ?? 0,
      trips: (rows.results as any[]).map((t) => ({
        id: t.id,
        title: t.title,
        destination: t.destination,
        owner: t.user_id ? { kind: "user", id: t.user_id, email: t.user_email } : { kind: "guest", id: t.guest_id, email: null },
        dayCount: t.day_count,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        llmCost: n(t.llm_cost),
        placesCost: n(t.places_cost),
        totalCost: n(t.period_cost),
        lifetimeCost: n(t.lifetime_cost),
      })),
    });
  })

  .get("/trips/:id", async (c) => {
    const id = c.req.param("id");
    const db = c.env.DB;
    const row = await db.prepare(`SELECT * FROM trips WHERE id = ?`).bind(id).first<TripRow>();
    if (!row) throw notFound("Trip not found.");
    const [msgs, usage, owner] = await db.batch([
      db.prepare(`SELECT id, role, content, meta, created_at FROM messages WHERE trip_id = ? ORDER BY created_at ASC, rowid ASC`).bind(id),
      db.prepare(`SELECT * FROM usage_events WHERE trip_id = ? ORDER BY created_at DESC LIMIT 500`).bind(id),
      row.user_id
        ? db.prepare(`SELECT id, email FROM users WHERE id = ?`).bind(row.user_id)
        : db.prepare(`SELECT id, NULL AS email, created_at FROM guests WHERE id = ?`).bind(row.guest_id),
    ]);
    await audit(c, { action: "trip.view", targetType: "trip", targetId: id, outcome: "success" });
    const usageRows = (usage.results as any[]).map(usageDto);
    const sum = (p: string) => usageRows.filter((u) => u.provider === p).reduce((s, u) => s + (u.costUsd ?? 0), 0);
    const o: any = owner.results[0] ?? null;
    return c.json({
      trip: {
        id: row.id,
        title: row.title,
        destination: row.destination,
        owner: row.user_id ? { kind: "user", id: row.user_id, email: o?.email ?? null } : { kind: "guest", id: row.guest_id, email: null },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        dayCount: row.day_count,
        itineraryVersion: row.itinerary_version,
        preferences: parsePrefs(row),
        itinerary: parseItinerary(row),
      },
      messages: (msgs.results as any[]).map(toMessage),
      usage: usageRows,
      costs: { llm: sum("openai"), places: sum("google_places"), total: sum("openai") + sum("google_places") },
    });
  })

  // ───────────── Usage ─────────────
  .get("/usage", async (c) => {
    const r = parseRange(c);
    const { page, pageSize, offset } = pageParams(c, 50);
    const where = [`created_at >= ?`, `created_at < ?`];
    const params: unknown[] = [r.from, r.to];
    const provider = c.req.query("provider");
    if (provider === "openai" || provider === "google_places") {
      where.push(`provider = ?`);
      params.push(provider);
    }
    const status = c.req.query("status");
    if (status === "success" || status === "error") {
      where.push(`status = ?`);
      params.push(status);
    }
    const attribution = c.req.query("attribution");
    if (attribution === "no_trip") where.push(`trip_id IS NULL`);
    if (attribution === "guest") where.push(`user_id IS NULL AND guest_id IS NOT NULL`);
    if (attribution === "user") where.push(`user_id IS NOT NULL`);
    if (attribution === "none") where.push(`user_id IS NULL AND guest_id IS NULL`);
    const whereSql = where.join(" AND ");
    const db = c.env.DB;
    const [rows, total, breakdown] = await db.batch([
      db.prepare(
        `SELECT e.*, u.email AS user_email, (SELECT title FROM trips t WHERE t.id = e.trip_id) AS trip_title
         FROM usage_events e LEFT JOIN users u ON u.id = e.user_id
         WHERE ${whereSql.replace(/created_at/g, "e.created_at").replace(/\bprovider\b/g, "e.provider").replace(/\bstatus\b/g, "e.status").replace(/\btrip_id\b/g, "e.trip_id").replace(/\buser_id\b/g, "e.user_id").replace(/\bguest_id\b/g, "e.guest_id")}
         ORDER BY e.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
      ).bind(...params),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost FROM usage_events WHERE ${whereSql}`).bind(...params),
      db.prepare(
        `SELECT provider, model, operation, COUNT(*) AS requests,
           COALESCE(SUM(CASE WHEN status='error' THEN 1 END),0) AS errors,
           COALESCE(SUM(units),0) AS units, COALESCE(SUM(input_tokens),0) AS input_tokens,
           COALESCE(SUM(cached_input_tokens),0) AS cached_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
           COALESCE(SUM(cost_usd),0) AS cost, AVG(duration_ms) AS avg_ms,
           COALESCE(SUM(CASE WHEN cost_usd IS NULL AND status='success' THEN 1 END),0) AS unpriced
         FROM usage_events WHERE ${whereSql} GROUP BY provider, model, operation ORDER BY cost DESC`,
      ).bind(...params),
    ]);
    const attributionSplit = await db
      .prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN trip_id IS NOT NULL THEN cost_usd END),0) AS trip_cost,
          COALESCE(SUM(CASE WHEN trip_id IS NULL AND (user_id IS NOT NULL OR guest_id IS NOT NULL) THEN cost_usd END),0) AS owner_only_cost,
          COALESCE(SUM(CASE WHEN user_id IS NULL AND guest_id IS NULL THEN cost_usd END),0) AS unattributed_cost,
          COALESCE(SUM(CASE WHEN user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users) THEN cost_usd END),0) AS deleted_user_cost
         FROM usage_events WHERE created_at >= ? AND created_at < ?`,
      )
      .bind(r.from, r.to)
      .first<any>();
    const T: any = total.results[0];
    return c.json({
      range: r,
      page,
      pageSize,
      total: n(T.n),
      totalCost: n(T.cost),
      attribution: {
        tripCost: n(attributionSplit?.trip_cost),
        ownerWithoutTripCost: n(attributionSplit?.owner_only_cost),
        unattributedCost: n(attributionSplit?.unattributed_cost),
        deletedUserCost: n(attributionSplit?.deleted_user_cost),
      },
      breakdown: (breakdown.results as any[]).map((b) => ({
        provider: b.provider,
        model: b.model,
        operation: b.operation,
        requests: n(b.requests),
        errors: n(b.errors),
        units: n(b.units),
        inputTokens: n(b.input_tokens),
        cachedTokens: n(b.cached_tokens),
        outputTokens: n(b.output_tokens),
        cost: n(b.cost),
        avgMs: b.avg_ms === null ? null : Math.round(n(b.avg_ms)),
        unpriced: n(b.unpriced),
      })),
      events: (rows.results as any[]).map((e) => ({ ...usageDto(e), userEmail: e.user_email ?? null, tripTitle: e.trip_title ?? null })),
    });
  })

  // ───────────── Operational monitoring ─────────────
  .get("/monitoring", async (c) => {
    const r = parseRange(c);
    const db = c.env.DB;
    const [errors, failures, latency] = await db.batch([
      db.prepare(`SELECT * FROM app_errors WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 100`).bind(r.from, r.to),
      db.prepare(
        `SELECT id, created_at, provider, model, endpoint, operation, http_status, error_code, error_message, duration_ms, attempt, trip_id, user_id, guest_id
         FROM usage_events WHERE status = 'error' AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 100`,
      ).bind(r.from, r.to),
      db.prepare(
        `SELECT provider, duration_ms FROM usage_events WHERE status='success' AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 5000`,
      ).bind(r.from, r.to),
    ]);
    const byProvider: Record<string, number[]> = {};
    for (const row of latency.results as any[]) (byProvider[row.provider] ??= []).push(n(row.duration_ms));
    const pct = (arr: number[], p: number) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    };
    const latencyStats = Object.entries(byProvider).map(([provider, arr]) => ({
      provider,
      samples: arr.length,
      avgMs: Math.round(arr.reduce((s, x) => s + x, 0) / arr.length),
      p50Ms: pct(arr, 50),
      p95Ms: pct(arr, 95),
      maxMs: Math.max(...arr),
    }));
    return c.json({
      range: r,
      appErrors: (errors.results as any[]).map((e) => ({ id: e.id, createdAt: e.created_at, method: e.method, path: e.path, status: e.status, code: e.code, message: e.message })),
      apiFailures: (failures.results as any[]).map((f) => ({
        id: f.id,
        createdAt: f.created_at,
        provider: f.provider,
        model: f.model,
        endpoint: f.endpoint,
        operation: f.operation,
        httpStatus: f.http_status,
        errorCode: f.error_code,
        errorMessage: f.error_message,
        durationMs: f.duration_ms,
        attempt: f.attempt,
        tripId: f.trip_id,
        userId: f.user_id,
        guestId: f.guest_id,
      })),
      latency: latencyStats,
    });
  })

  // ───────────── Audit log (read-only) ─────────────
  .get("/audit", async (c) => {
    const { page, pageSize, offset } = pageParams(c, 50);
    const action = (c.req.query("action") || "").trim().slice(0, 60);
    const where = action ? `WHERE action LIKE ? ESCAPE '\\'` : "";
    const params = action ? [likePattern(action)] : [];
    const rows = await c.env.DB.prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`)
      .bind(...params)
      .all();
    const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).bind(...params).first<{ n: number }>();
    return c.json({
      page,
      pageSize,
      total: total?.n ?? 0,
      entries: (rows.results as any[]).map((a) => ({
        id: a.id,
        createdAt: a.created_at,
        adminId: a.admin_id,
        adminUsername: a.admin_username,
        action: a.action,
        targetType: a.target_type,
        targetId: a.target_id,
        outcome: a.outcome,
        detail: a.detail ? JSON.parse(a.detail) : null,
        ip: a.ip,
      })),
    });
  })

  // ───────────── Pricing configuration ─────────────
  .get("/pricing", async (c) => {
    const { results } = await c.env.DB.prepare(`SELECT * FROM pricing_rules ORDER BY provider, item`).all();
    return c.json({ rules: results, activeModel: c.env.LLM_MODEL ?? null, activeProvider: c.env.LLM_PROVIDER ?? null });
  })

  .put("/pricing/:id", async (c) => {
    const id = c.req.param("id");
    const rate = z.number().nonnegative().max(100_000).nullable();
    const body = await parseJson(
      c,
      z.object({
        provider: z.enum(["openai", "google_places"]).optional(),
        item: z.string().trim().min(1).max(100).optional(),
        description: z.string().max(300).nullable().optional(),
        input_per_mtok: rate.optional(),
        cached_input_per_mtok: rate.optional(),
        output_per_mtok: rate.optional(),
        per_1000_requests: rate.optional(),
        source: z.string().max(300).nullable().optional(),
      }),
    );
    const existing = await c.env.DB.prepare(`SELECT * FROM pricing_rules WHERE id = ?`).bind(id).first<any>();
    const version = `${new Date().toISOString().slice(0, 10)}.${Date.now().toString(36)}`;
    const admin = c.get("admin")!;
    if (!existing) {
      if (!body.provider || !body.item) throw badRequest("provider and item are required to create a pricing rule.");
      if (id !== `${body.provider}:${body.item}`) throw badRequest("Rule id must be '<provider>:<item>'.");
    }
    const next = {
      provider: existing?.provider ?? body.provider,
      item: existing?.item ?? body.item,
      description: body.description !== undefined ? body.description : (existing?.description ?? null),
      input_per_mtok: body.input_per_mtok !== undefined ? body.input_per_mtok : (existing?.input_per_mtok ?? null),
      cached_input_per_mtok: body.cached_input_per_mtok !== undefined ? body.cached_input_per_mtok : (existing?.cached_input_per_mtok ?? null),
      output_per_mtok: body.output_per_mtok !== undefined ? body.output_per_mtok : (existing?.output_per_mtok ?? null),
      per_1000_requests: body.per_1000_requests !== undefined ? body.per_1000_requests : (existing?.per_1000_requests ?? null),
      source: body.source !== undefined ? body.source : (existing?.source ?? "Set by administrator"),
    };
    await c.env.DB.prepare(
      `INSERT INTO pricing_rules (id, provider, item, description, input_per_mtok, cached_input_per_mtok, output_per_mtok, per_1000_requests, version, source, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET description=excluded.description, input_per_mtok=excluded.input_per_mtok,
         cached_input_per_mtok=excluded.cached_input_per_mtok, output_per_mtok=excluded.output_per_mtok,
         per_1000_requests=excluded.per_1000_requests, version=excluded.version, source=excluded.source,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    )
      .bind(id, next.provider, next.item, next.description, next.input_per_mtok, next.cached_input_per_mtok, next.output_per_mtok, next.per_1000_requests, version, next.source, Date.now(), admin.username)
      .run();
    await audit(c, {
      action: existing ? "config.pricing.update" : "config.pricing.create",
      targetType: "pricing_rule",
      targetId: id,
      outcome: "success",
      detail: {
        before: existing
          ? { input: existing.input_per_mtok, cached: existing.cached_input_per_mtok, output: existing.output_per_mtok, per1000: existing.per_1000_requests, version: existing.version }
          : null,
        after: { input: next.input_per_mtok, cached: next.cached_input_per_mtok, output: next.output_per_mtok, per1000: next.per_1000_requests, version },
      },
    });
    return c.json({ ok: true, version });
  });

/** Convert bare `?` placeholders into numbered ones starting at `start` (after ?1, ?2 …). */
function numberPlaceholders(sql: string, start: number): string {
  let i = start;
  return sql.replace(/\?(?!\d)/g, () => `?${i++}`);
}

function usageDto(e: any) {
  return {
    id: e.id,
    createdAt: e.created_at,
    provider: e.provider,
    model: e.model,
    endpoint: e.endpoint,
    operation: e.operation,
    userId: e.user_id,
    guestId: e.guest_id,
    tripId: e.trip_id,
    status: e.status,
    httpStatus: e.http_status,
    inputTokens: e.input_tokens,
    cachedInputTokens: e.cached_input_tokens,
    outputTokens: e.output_tokens,
    reasoningTokens: e.reasoning_tokens,
    units: e.units,
    costUsd: e.cost_usd,
    currency: e.currency,
    pricingVersion: e.pricing_version,
    pricingDetail: e.pricing_detail ? JSON.parse(e.pricing_detail) : null,
    durationMs: e.duration_ms,
    attempt: e.attempt,
    errorCode: e.error_code,
    errorMessage: e.error_message,
  };
}
