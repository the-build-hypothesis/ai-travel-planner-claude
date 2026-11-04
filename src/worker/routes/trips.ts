import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  itinerarySchema,
  llmTurnSchema,
  preferencesSchema,
  type ChatMessage,
  type Itinerary,
  type TripDetail,
  type TripPreferences,
  type TripSummary,
} from "../../shared/schemas";
import type { Actor, AppBindings } from "../env";
import { uuid } from "../lib/crypto";
import { ApiError, badRequest, conflict, notFound } from "../lib/errors";
import { clientIp, parseJson } from "../lib/http";
import { enforce } from "../lib/ratelimit";
import { callStructured, LlmError } from "../llm";
import { TURN_JSON_SCHEMA } from "../llm/turnSchema";
import { getCachedPlace, enrichItinerary, itineraryCenter, placesConfigured, PlacesError, searchPlaces } from "../services/places";
import { applyTurn, buildContinuationMessages, buildMessages, DEFAULT_TRIP_TITLE, MAX_DAYS, normalizeItinerary } from "../services/planner";
import { ensureGuest } from "../services/sessions";
import { attributionFor } from "../services/usage";

type C = Context<AppBindings>;

export const LIMITS = {
  messageChars: 2000,
  guestTrips: 25,
  userTrips: 300,
  llmPerMinute: 6,
  guestLlmPerDay: 40,
  userLlmPerDay: 150,
  ipLlmPerDay: 300,
  placesSearchPer10Min: 25,
};

export interface TripRow {
  id: string;
  user_id: string | null;
  guest_id: string | null;
  title: string;
  destination: string | null;
  preferences: string;
  itinerary: string | null;
  itinerary_version: number;
  day_count: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  meta: string | null;
  created_at: number;
}

export function currentActor(c: C): Actor | null {
  const user = c.get("user");
  if (user) return { kind: "user", userId: user.id, guestId: null };
  const guestId = c.get("guestId");
  if (guestId) return { kind: "guest", userId: null, guestId };
  return null;
}

async function requireActor(c: C): Promise<Actor> {
  const a = currentActor(c);
  if (a) return a;
  const guestId = await ensureGuest(c);
  return { kind: "guest", userId: null, guestId };
}

const actorKey = (a: Actor) => (a.userId ? `u:${a.userId}` : `g:${a.guestId}`);

/** Server-side ownership check. Non-owned trips are indistinguishable from missing ones. */
export async function loadOwnedTrip(c: C, tripId: string): Promise<{ row: TripRow; actor: Actor }> {
  const actor = currentActor(c);
  if (!actor || tripId.length > 64) throw notFound("Trip not found.");
  const row = actor.userId
    ? await c.env.DB.prepare(`SELECT * FROM trips WHERE id = ? AND user_id = ?`).bind(tripId, actor.userId).first<TripRow>()
    : await c.env.DB.prepare(`SELECT * FROM trips WHERE id = ? AND guest_id = ?`).bind(tripId, actor.guestId).first<TripRow>();
  if (!row) throw notFound("Trip not found.");
  return { row, actor };
}

export function parsePrefs(row: TripRow): TripPreferences {
  const r = preferencesSchema.safeParse(JSON.parse(row.preferences || "{}"));
  return r.success ? r.data : preferencesSchema.parse({});
}

export function parseItinerary(row: TripRow): Itinerary | null {
  if (!row.itinerary) return null;
  const r = itinerarySchema.safeParse(JSON.parse(row.itinerary));
  return r.success ? r.data : null;
}

export function toSummary(row: TripRow): TripSummary {
  const prefs = parsePrefs(row);
  return {
    id: row.id,
    title: row.title,
    destination: row.destination,
    dayCount: row.day_count,
    startDate: prefs.startDate,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toMessage(m: MessageRow): ChatMessage {
  return { id: m.id, role: m.role, content: m.content, meta: m.meta ? JSON.parse(m.meta) : null, createdAt: m.created_at };
}

export async function tripDetail(db: D1Database, row: TripRow): Promise<TripDetail> {
  const { results } = await db
    .prepare(`SELECT id, role, content, meta, created_at FROM messages WHERE trip_id = ? ORDER BY created_at ASC, rowid ASC`)
    .bind(row.id)
    .all<MessageRow>();
  return {
    ...toSummary(row),
    preferences: parsePrefs(row),
    itinerary: parseItinerary(row),
    itineraryVersion: row.itinerary_version,
    messages: results.map(toMessage),
  };
}

async function saveTrip(
  db: D1Database,
  row: TripRow,
  next: { title: string; preferences: TripPreferences; itinerary: Itinerary | null },
): Promise<TripRow> {
  const now = Date.now();
  const updated = await db
    .prepare(
      `UPDATE trips SET title = ?, destination = ?, preferences = ?, itinerary = ?, itinerary_version = itinerary_version + 1,
         day_count = ?, updated_at = ?
       WHERE id = ? AND itinerary_version = ?
       RETURNING *`,
    )
    .bind(
      next.title,
      next.preferences.destination,
      JSON.stringify(next.preferences),
      next.itinerary ? JSON.stringify(next.itinerary) : null,
      next.itinerary?.days.length ?? 0,
      now,
      row.id,
      row.itinerary_version,
    )
    .first<TripRow>();
  if (!updated) throw conflict("This trip was changed in another tab. Reload to see the latest version.", "VERSION_CONFLICT");
  return updated;
}

/** Re-validate client-supplied itinerary edits; place data can only come from the server. */
async function sanitizeClientItinerary(db: D1Database, incoming: Itinerary, previous: Itinerary | null): Promise<Itinerary> {
  const known = new Map<string, NonNullable<Itinerary["days"][number]["activities"][number]["place"]>>();
  for (const d of previous?.days ?? []) for (const a of d.activities) if (a.place) known.set(a.place.placeId, a.place);
  for (const d of incoming.days) {
    for (const a of d.activities) {
      if (!a.place) {
        if (a.coordSource === "google_places") a.coordSource = a.lat !== null ? "user" : null;
        continue;
      }
      let p = known.get(a.place.placeId) ?? null;
      if (!p) {
        const cached = await getCachedPlace(db, a.place.placeId);
        if (cached) {
          const { primaryType: _pt, ...rest } = cached;
          p = rest;
        }
      }
      a.place = p;
      if (p) {
        a.lat = p.lat;
        a.lng = p.lng;
        a.coordSource = "google_places";
      } else if (a.coordSource === "google_places") {
        a.coordSource = "user";
      }
    }
  }
  const total = incoming.days.reduce((s, d) => s + d.activities.length, 0);
  if (total > 200) throw badRequest("Too many activities in this itinerary.");
  return incoming;
}

const createSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  preferences: preferencesSchema.partial().optional(),
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  preferences: preferencesSchema.partial().optional(),
});

export const tripRoutes = new Hono<AppBindings>()
  .get("/", async (c) => {
    const actor = currentActor(c);
    if (!actor) return c.json({ trips: [] });
    const { results } = actor.userId
      ? await c.env.DB.prepare(`SELECT * FROM trips WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500`).bind(actor.userId).all<TripRow>()
      : await c.env.DB.prepare(`SELECT * FROM trips WHERE guest_id = ? ORDER BY updated_at DESC LIMIT 500`).bind(actor.guestId).all<TripRow>();
    return c.json({ trips: results.map(toSummary) });
  })

  .post("/", async (c) => {
    const body = await parseJson(c, createSchema);
    const actor = await requireActor(c);
    await enforce(c.env.DB, [
      { bucket: `trip-create:${actorKey(actor)}`, limit: 30, windowSec: 3600, message: "You've created a lot of trips recently. Please wait a bit." },
      { bucket: `trip-create:ip:${clientIp(c)}`, limit: 60, windowSec: 3600 },
    ]);
    const countRow = actor.userId
      ? await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM trips WHERE user_id = ?`).bind(actor.userId).first<{ n: number }>()
      : await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM trips WHERE guest_id = ?`).bind(actor.guestId).first<{ n: number }>();
    const max = actor.userId ? LIMITS.userTrips : LIMITS.guestTrips;
    if ((countRow?.n ?? 0) >= max) {
      throw new ApiError(
        403,
        "TRIP_LIMIT",
        actor.userId ? "You've reached the maximum number of trips. Delete some to create more." : "Guest trip limit reached. Create a free account to save more trips.",
      );
    }
    const prefs = preferencesSchema.parse(body.preferences ?? {});
    const id = uuid();
    const now = Date.now();
    const row = await c.env.DB.prepare(
      `INSERT INTO trips (id, user_id, guest_id, title, destination, preferences, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
      .bind(id, actor.userId, actor.guestId, body.title ?? DEFAULT_TRIP_TITLE, prefs.destination, JSON.stringify(prefs), now, now)
      .first<TripRow>();
    return c.json({ trip: await tripDetail(c.env.DB, row!) }, 201);
  })

  .get("/:id", async (c) => {
    const { row } = await loadOwnedTrip(c, c.req.param("id"));
    return c.json({ trip: await tripDetail(c.env.DB, row) });
  })

  .patch("/:id", async (c) => {
    const { row } = await loadOwnedTrip(c, c.req.param("id"));
    const body = await parseJson(c, patchSchema);
    const prefs = body.preferences ? preferencesSchema.parse({ ...parsePrefs(row), ...body.preferences }) : parsePrefs(row);
    if (prefs.startDate && prefs.endDate && prefs.endDate < prefs.startDate) throw badRequest("endDate: End date must be after the start date.");
    if (prefs.startDate && prefs.endDate) {
      const days = Math.round((Date.parse(prefs.endDate) - Date.parse(prefs.startDate)) / 86400_000) + 1;
      if (days > 30) throw badRequest("endDate: Trips can be at most 30 days long.");
      prefs.durationDays = days;
    }
    let itinerary = parseItinerary(row);
    if (itinerary) itinerary = normalizeItinerary(itinerary, prefs);
    const updated = await saveTrip(c.env.DB, row, { title: body.title ?? row.title, preferences: prefs, itinerary });
    return c.json({ trip: await tripDetail(c.env.DB, updated) });
  })

  .delete("/:id", async (c) => {
    const { row } = await loadOwnedTrip(c, c.req.param("id"));
    await c.env.DB.prepare(`DELETE FROM trips WHERE id = ?`).bind(row.id).run();
    return c.json({ ok: true });
  })

  // Direct UI edits (reorder, remove, edit, add). Optimistic concurrency via baseVersion.
  .put("/:id/itinerary", async (c) => {
    const { row } = await loadOwnedTrip(c, c.req.param("id"));
    const body = await parseJson(c, z.object({ baseVersion: z.number().int(), itinerary: itinerarySchema }), 512 * 1024);
    if (body.baseVersion !== row.itinerary_version) {
      throw conflict("This trip changed since you loaded it. Reload to see the latest version.", "VERSION_CONFLICT");
    }
    const prefs = parsePrefs(row);
    const clean = await sanitizeClientItinerary(c.env.DB, body.itinerary, parseItinerary(row));
    const itinerary = normalizeItinerary({ ...clean, updatedAt: Date.now() }, prefs);
    const updated = await saveTrip(c.env.DB, row, { title: row.title, preferences: prefs, itinerary });
    return c.json({ trip: await tripDetail(c.env.DB, updated) });
  })

  // Conversational planning turn.
  .post("/:id/messages", async (c) => {
    const { row, actor } = await loadOwnedTrip(c, c.req.param("id"));
    const body = await parseJson(c, z.object({ content: z.string().trim().min(1, "Message can't be empty.").max(LIMITS.messageChars, `Messages are limited to ${LIMITS.messageChars} characters.`) }));
    const key = actorKey(actor);
    await enforce(c.env.DB, [
      { bucket: `llm:min:${key}`, limit: LIMITS.llmPerMinute, windowSec: 60, message: "You're sending messages quickly — please wait a moment." },
      {
        bucket: `llm:day:${key}`,
        limit: actor.userId ? LIMITS.userLlmPerDay : LIMITS.guestLlmPerDay,
        windowSec: 86400,
        message: actor.userId ? "Daily AI request limit reached. Please try again tomorrow." : "Guest daily AI limit reached. Create a free account for a higher limit.",
      },
      { bucket: `llm:ip:${clientIp(c)}`, limit: LIMITS.ipLlmPerDay, windowSec: 86400, message: "Daily AI request limit reached for this network." },
    ]);

    const prefs = parsePrefs(row);
    const itinerary = parseItinerary(row);
    const { results: history } = await c.env.DB.prepare(
      `SELECT role, content FROM (SELECT role, content, created_at, rowid AS r FROM messages WHERE trip_id = ? ORDER BY created_at DESC, r DESC LIMIT 10) ORDER BY created_at ASC, r ASC`,
    )
      .bind(row.id)
      .all<{ role: "user" | "assistant" | "system"; content: string }>();

    const userMsg: MessageRow = { id: uuid(), role: "user", content: body.content, meta: null, created_at: Date.now() };
    await c.env.DB.prepare(`INSERT INTO messages (id, trip_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, NULL, ?)`)
      .bind(userMsg.id, row.id, userMsg.role, userMsg.content, userMsg.created_at)
      .run();

    const attribution = attributionFor(actor, row.id);
    let turn;
    try {
      turn = await callStructured({
        env: c.env,
        messages: buildMessages({ preferences: prefs, itinerary, history, userMessage: body.content, today: new Date().toISOString().slice(0, 10) }),
        schemaName: "planner_turn",
        jsonSchema: TURN_JSON_SCHEMA,
        validator: llmTurnSchema,
        operation: itinerary ? "trip_chat" : "trip_plan",
        attribution,
        maxOutputTokens: 14000,
        timeoutMs: 120_000,
        maxAttempts: 2,
        temperature: 0.6,
      });
    } catch (e) {
      // Roll back the user message so a retry doesn't duplicate it.
      await c.env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(userMsg.id).run();
      throw llmToApiError(e);
    }

    let merged = applyTurn({ title: row.title, preferences: prefs, itinerary }, turn.data);

    // Completeness check: if a (re)generated plan is missing days, request the
    // remaining days in bounded follow-up calls rather than saving a partial plan.
    let incomplete = false;
    const isGeneration = turn.data.intent === "generate" || turn.data.itinerary?.mode === "replace_all";
    const expected = Math.min(merged.preferences.durationDays ?? 0, MAX_DAYS);
    for (let round = 0; isGeneration && merged.itinerary && merged.itineraryChanged && round < 3; round++) {
      const have = merged.itinerary.days.length;
      if (have >= expected) break;
      const fromDay = have + 1;
      const toDay = Math.min(expected, fromDay + 3);
      try {
        const cont = await callStructured({
          env: c.env,
          messages: buildContinuationMessages({ preferences: merged.preferences, itinerary: merged.itinerary, fromDay, toDay, today: new Date().toISOString().slice(0, 10) }),
          schemaName: "planner_turn",
          jsonSchema: TURN_JSON_SCHEMA,
          validator: llmTurnSchema,
          operation: "trip_plan_continue",
          attribution,
          maxOutputTokens: 10000,
          timeoutMs: 90_000,
          maxAttempts: 1,
          temperature: 0.6,
        });
        const days = (cont.data.itinerary?.days ?? []).filter((d) => d.dayNumber >= fromDay && d.dayNumber <= toDay);
        if (!days.length) {
          incomplete = true;
          break;
        }
        const next = applyTurn(
          { title: merged.title ?? row.title, preferences: merged.preferences, itinerary: merged.itinerary },
          { ...cont.data, intent: "modify", tripTitle: null, itinerary: { ...cont.data.itinerary!, mode: "patch", days, removeDayNumbers: [] } },
        );
        merged = { ...next, title: merged.title, changedDays: [...new Set([...merged.changedDays, ...next.changedDays])].sort((a, b) => a - b), itineraryChanged: true };
      } catch {
        incomplete = true;
        break;
      }
    }
    if (merged.itinerary && expected > merged.itinerary.days.length && isGeneration) incomplete = true;

    let nextItinerary = merged.itinerary;
    let verification = { lookups: 0, verified: 0, failed: 0 };
    if (nextItinerary && merged.itineraryChanged && placesConfigured(c.env)) {
      const r = await enrichItinerary({
        env: c.env,
        itinerary: nextItinerary,
        destination: merged.preferences.destination,
        attribution,
        onlyDays: merged.changedDays,
      });
      nextItinerary = r.itinerary;
      verification = { lookups: r.lookups, verified: r.verified, failed: r.failed };
    }
    let title = merged.title ?? row.title;
    if (title === DEFAULT_TRIP_TITLE && merged.preferences.destination) title = `Trip to ${merged.preferences.destination}`.slice(0, 120);

    // Re-read the version in case the trip changed during the LLM call.
    const fresh = await c.env.DB.prepare(`SELECT * FROM trips WHERE id = ?`).bind(row.id).first<TripRow>();
    if (!fresh) throw notFound("Trip not found.");
    if (fresh.itinerary_version !== row.itinerary_version) {
      await c.env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(userMsg.id).run();
      throw conflict("This trip was changed while the assistant was working. Please resend your message.", "VERSION_CONFLICT");
    }
    const updated = await saveTrip(c.env.DB, fresh, { title, preferences: merged.preferences, itinerary: nextItinerary });

    const assistantMsg: MessageRow = {
      id: uuid(),
      role: "assistant",
      content: incomplete
        ? `${turn.data.reply}\n\nNote: I couldn't finish every day this time — ask me to "plan the remaining days" to complete the itinerary.`
        : turn.data.reply,
      meta: JSON.stringify({
        intent: turn.data.intent,
        incomplete,
        changedDays: merged.itineraryChanged ? merged.changedDays : [],
        suggestions: turn.data.suggestions.slice(0, 4),
        verification,
      }),
      created_at: Date.now(),
    };
    await c.env.DB.prepare(`INSERT INTO messages (id, trip_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(assistantMsg.id, row.id, assistantMsg.role, assistantMsg.content, assistantMsg.meta, assistantMsg.created_at)
      .run();
    return c.json({ trip: await tripDetail(c.env.DB, updated), reply: toMessage(assistantMsg) });
  })

  // Destination & attraction research (Google Places).
  .post("/:id/places/search", async (c) => {
    const { row, actor } = await loadOwnedTrip(c, c.req.param("id"));
    const { query } = await parseJson(c, z.object({ query: z.string().trim().min(2).max(200) }));
    if (!placesConfigured(c.env)) {
      throw new ApiError(503, "PLACES_NOT_CONFIGURED", "Place search isn't available right now (Google Places is not configured).");
    }
    await enforce(c.env.DB, [
      { bucket: `places:${actorKey(actor)}`, limit: LIMITS.placesSearchPer10Min, windowSec: 600, message: "Too many searches — please wait a few minutes." },
    ]);
    const prefs = parsePrefs(row);
    const center = itineraryCenter(parseItinerary(row));
    const q = center || !prefs.destination || query.toLowerCase().includes(prefs.destination.toLowerCase()) ? query : `${query} in ${prefs.destination}`;
    try {
      const { results, cached } = await searchPlaces({
        env: c.env,
        query: q,
        maxResults: 8,
        bias: center ? { ...center, radiusM: 30_000 } : null,
        operation: "place_search",
        attribution: attributionFor(actor, row.id),
      });
      return c.json({ results, cached, query: q });
    } catch (e) {
      if (e instanceof PlacesError) throw new ApiError(502, "PLACES_ERROR", "Place search is temporarily unavailable. Please try again.");
      throw e;
    }
  })

  // Re-run Google Places verification for unverified activities.
  .post("/:id/verify-places", async (c) => {
    const { row, actor } = await loadOwnedTrip(c, c.req.param("id"));
    if (!placesConfigured(c.env)) throw new ApiError(503, "PLACES_NOT_CONFIGURED", "Place verification isn't available (Google Places is not configured).");
    await enforce(c.env.DB, [{ bucket: `verify:${actorKey(actor)}`, limit: 6, windowSec: 3600, message: "Verification was run recently — please wait before retrying." }]);
    const itinerary = parseItinerary(row);
    if (!itinerary) throw badRequest("This trip doesn't have an itinerary yet.");
    const prefs = parsePrefs(row);
    const r = await enrichItinerary({ env: c.env, itinerary, destination: prefs.destination, attribution: attributionFor(actor, row.id), maxLookups: 30 });
    const updated = await saveTrip(c.env.DB, row, { title: row.title, preferences: prefs, itinerary: r.itinerary });
    return c.json({ trip: await tripDetail(c.env.DB, updated), verification: { lookups: r.lookups, verified: r.verified, failed: r.failed } });
  });

export function llmToApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof LlmError) {
    switch (e.code) {
      case "config":
        return new ApiError(503, "LLM_NOT_CONFIGURED", "The AI planner isn't configured right now. Please try again later.");
      case "rate_limited":
        return new ApiError(503, "LLM_BUSY", "The AI service is busy right now. Please try again in a minute.");
      case "timeout":
        return new ApiError(504, "LLM_TIMEOUT", "The AI took too long to respond. Try again, or ask for a smaller change.");
      case "truncated":
        return new ApiError(502, "LLM_TRUNCATED", "That plan was too long to generate in one go. Try fewer days or a smaller change.");
      case "refused":
        return new ApiError(422, "LLM_REFUSED", "The assistant can't help with that request.");
      case "invalid_output":
        return new ApiError(502, "LLM_INVALID_OUTPUT", "The AI returned an unusable response. Please try again.");
      default:
        return new ApiError(502, "LLM_ERROR", "The AI service had a problem. Please try again.");
    }
  }
  return new ApiError(500, "INTERNAL", "Something went wrong.");
}
