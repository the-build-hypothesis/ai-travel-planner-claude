import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { daysBetween, directOpSchema, MAX_TRIP_DAYS, tripPatchSchema, type Activity } from '../../shared/schemas';
import { currentPrincipal, requirePrincipal } from '../auth/sessions';
import type { AppContext, Env, Principal } from '../env';
import { applyDirectOp, activityId, clone, DirectEditError, renumber } from '../itinerary/ops';
import { callStructured, LlmError, llmUserMessage, resolveLlm } from '../llm';
import { ideasSystemPrompt } from '../llm/prompts';
import { ideasSchema } from '../llm/schemas';
import { logError } from '../lib/errors';
import { ApiError, clientIp, nowIso, parseJson, parseJsonColumn } from '../lib/http';
import { enforce } from '../lib/rateLimit';
import { getSettings } from '../lib/settings';
import { cachedSearch, fetchPlacePhoto, placesConfigured, searchPlaces } from '../places/google';
import { applyPlace, applyTripPatch, regenerateDay, resolveDestination, runTurn, type PlannerEvent } from '../trips/planner';
import {
  acquireBusy,
  addMessage,
  createTrip,
  getOwnedTrip,
  isBusy,
  listMessages,
  listTrips,
  parseItinerary,
  releaseBusy,
  reloadTrip,
  saveItinerary,
  snapshotItinerary,
  tripDto,
  type TripRow,
} from '../trips/repo';

export const tripRoutes = new Hono<AppContext>();
export const exploreRoutes = new Hono<AppContext>();

const MAX_MESSAGE_CHARS = 2000;
const TURN_LOCK_SECONDS = 180;

async function ownedOr404(c: Context<AppContext>, principal: Principal | null): Promise<TripRow> {
  const id = c.req.param('id')!;
  const row = principal ? await getOwnedTrip(c.env.DB, id, principal) : null;
  if (!row) throw new ApiError(404, 'NOT_FOUND', "We couldn't find that trip. It may have been deleted, or it may belong to another account.");
  return row;
}

function assertNotBusy(row: TripRow) {
  if (isBusy(row)) throw new ApiError(409, 'TRIP_BUSY', 'The assistant is still working on this trip. Please wait for it to finish.');
}

/** Server-side spend protection. Burst and daily limits per owner and IP, plus a global daily cost cap. */
async function guardAiSpend(c: Context<AppContext>, principal: Principal): Promise<void> {
  const settings = await getSettings(c.env.DB);
  const isGuest = principal.type === 'guest';
  const message = isGuest
    ? "You've reached the guest limit for AI requests. Create a free account for a higher limit, or try again later."
    : "You've reached your AI request limit for now. Please try again later.";
  await enforce(
    c.env.DB,
    [
      { scope: 'ai_min', id: `${principal.type}:${principal.id}`, max: 10, windowSeconds: 60 },
      { scope: 'ai_day', id: `${principal.type}:${principal.id}`, max: isGuest ? settings.guest_ai_requests_per_day : settings.user_ai_requests_per_day, windowSeconds: 86_400 },
      { scope: 'ai_ip_hour', id: clientIp(c), max: 120, windowSeconds: 3600 },
      // Clearing cookies mints a new guest, so guests also share a limit per network address.
      ...(isGuest ? [{ scope: 'ai_guest_ip_hour', id: clientIp(c), max: 30, windowSeconds: 3600 }] : []),
    ],
    message,
  );
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const spent = await c.env.DB.prepare('SELECT COALESCE(SUM(estimated_cost), 0) AS total FROM usage_records WHERE created_at >= ?').bind(since).first<{ total: number }>();
  if ((spent?.total ?? 0) >= settings.daily_cost_cap_usd) {
    await logError(c.env.DB, { source: 'cost_guard', code: 'daily_cap', message: 'The daily API cost cap was reached; AI requests are paused', requestId: c.get('requestId') });
    throw new ApiError(503, 'SERVICE_BUSY', 'AI planning is paused for now because of unusually high demand. Please try again later.');
  }
}

function assertLlmConfigured(env: Env) {
  try {
    resolveLlm(env);
  } catch (err) {
    if (err instanceof LlmError) throw new ApiError(503, 'LLM_NOT_CONFIGURED', llmUserMessage(err));
    throw err;
  }
}

/**
 * Streams planner events as server-sent events. The work runs under waitUntil, so if the browser
 * disconnects mid-way the turn can still finish and be saved within the platform's grace period.
 */
function sseResponse(c: Context<AppContext>, run: (emit: (event: PlannerEvent) => void) => Promise<void>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let open = true;
  let queue: Promise<unknown> = Promise.resolve();
  const send = (text: string) => {
    if (!open) return;
    queue = queue.then(() => writer.write(encoder.encode(text))).catch(() => {
      open = false;
    });
  };
  const keepAlive = setInterval(() => send(': keep-alive\n\n'), 15_000);
  const work = (async () => {
    try {
      await run((event) => send(`data: ${JSON.stringify(event)}\n\n`));
    } finally {
      clearInterval(keepAlive);
      await queue;
      await writer.close().catch(() => undefined);
    }
  })();
  c.executionCtx.waitUntil(work);
  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
  });
}

tripRoutes.get('/', async (c) => {
  const principal = currentPrincipal(c);
  return c.json({ trips: principal ? await listTrips(c.env.DB, principal) : [] });
});

tripRoutes.post('/', async (c) => {
  await enforce(c.env.DB, [{ scope: 'trip_create_ip', id: clientIp(c), max: 40, windowSeconds: 3600 }], 'Too many new trips. Please try again later.');
  const body = await parseJson(c, z.object({ title: z.string().trim().min(1).max(120).optional() }).strict());
  const principal = await requirePrincipal(c);
  const row = await createTrip(c.env.DB, principal, c.get('user')?.default_currency ?? 'USD', { title: body.title });
  return c.json({ trip: tripDto(row) }, 201);
});

tripRoutes.get('/:id', async (c) => {
  const row = await ownedOr404(c, currentPrincipal(c));
  const undo = await c.env.DB.prepare('SELECT reason FROM itinerary_versions WHERE trip_id = ? ORDER BY seq DESC LIMIT 1').bind(row.id).first<{ reason: string }>();
  return c.json({ trip: tripDto(row), messages: await listMessages(c.env.DB, row.id), undo: undo?.reason ?? null, busy: isBusy(row) });
});

tripRoutes.patch('/:id', async (c) => {
  const row = await ownedOr404(c, currentPrincipal(c));
  assertNotBusy(row);
  const patch = await parseJson(c, tripPatchSchema);
  const start = patch.start_date !== undefined ? patch.start_date : row.start_date;
  const end = patch.end_date !== undefined ? patch.end_date : row.end_date;
  if (start && end) {
    if (end < start) throw new ApiError(400, 'VALIDATION_ERROR', 'End date must be on or after the start date.', { fields: { end_date: 'End date must be on or after the start date.' } });
    if (daysBetween(start, end) + 1 > MAX_TRIP_DAYS) throw new ApiError(400, 'VALIDATION_ERROR', `Trips can be at most ${MAX_TRIP_DAYS} days.`, { fields: { end_date: `Trips can be at most ${MAX_TRIP_DAYS} days.` } });
  }
  let updated = await applyTripPatch(c.env.DB, row, patch);
  if (patch.destination && patch.destination !== row.destination) {
    await enforce(c.env.DB, [{ scope: 'dest_resolve', id: row.id, max: 10, windowSeconds: 3600 }]);
    updated = await resolveDestination({ env: c.env, principal: currentPrincipal(c)!, requestId: c.get('requestId'), emit: () => undefined }, updated);
  }
  return c.json({ trip: tripDto(updated) });
});

tripRoutes.delete('/:id', async (c) => {
  const row = await ownedOr404(c, currentPrincipal(c));
  assertNotBusy(row);
  await c.env.DB.prepare('DELETE FROM trips WHERE id = ?').bind(row.id).run();
  return c.json({ ok: true });
});

tripRoutes.post('/:id/messages', async (c) => {
  const principal = currentPrincipal(c);
  const row = await ownedOr404(c, principal);
  const body = await parseJson(c, z.object({ content: z.string().trim().min(1, 'Type a message first').max(MAX_MESSAGE_CHARS, `Keep messages under ${MAX_MESSAGE_CHARS} characters`) }));
  assertLlmConfigured(c.env);
  await guardAiSpend(c, principal!);
  if (!(await acquireBusy(c.env.DB, row.id, TURN_LOCK_SECONDS))) assertNotBusy({ ...row, busy_until: new Date(Date.now() + 1000).toISOString() });
  const ctxBase = { env: c.env, principal: principal!, requestId: c.get('requestId') };
  return sseResponse(c, async (emit) => {
    try {
      await runTurn({ ...ctxBase, emit }, row, body.content);
    } finally {
      await releaseBusy(c.env.DB, row.id);
    }
  });
});

tripRoutes.post('/:id/days/:day/regenerate', async (c) => {
  const principal = currentPrincipal(c);
  const row = await ownedOr404(c, principal);
  const dayNumber = Number.parseInt(c.req.param('day'), 10);
  const body = await parseJson(c, z.object({ instructions: z.string().trim().max(500).nullable().optional() }));
  const trip = tripDto(row);
  if (!trip.itinerary.days.some((d) => d.day_number === dayNumber)) throw new ApiError(404, 'NOT_FOUND', 'That day is not in this itinerary.');
  assertLlmConfigured(c.env);
  await guardAiSpend(c, principal!);
  if (!(await acquireBusy(c.env.DB, row.id, TURN_LOCK_SECONDS))) assertNotBusy({ ...row, busy_until: new Date(Date.now() + 1000).toISOString() });
  const ctxBase = { env: c.env, principal: principal!, requestId: c.get('requestId') };
  return sseResponse(c, async (emit) => {
    try {
      emit({ type: 'status', message: `Rewriting day ${dayNumber}…` });
      const working = clone(trip.itinerary);
      await regenerateDay({ ...ctxBase, emit }, trip, working, dayNumber, body.instructions ?? null);
      await snapshotItinerary(c.env.DB, row.id, trip.itinerary, `Regenerated day ${dayNumber}`);
      renumber(working, trip.start_date);
      await saveItinerary(c.env.DB, row.id, working);
      const message = await addMessage(c.env.DB, row.id, 'assistant', `I rewrote day ${dayNumber}${body.instructions ? ` with your note in mind: "${body.instructions}"` : ''}. The other days are unchanged.`, {
        changes: [{ type: 'day_regenerated', label: `Day ${dayNumber}`, day_number: dayNumber }],
        notes: [],
        places: [],
        suggestions: [],
      });
      emit({ type: 'done', message, trip: tripDto(await reloadTrip(c.env.DB, row.id)) });
    } catch (err) {
      await logError(c.env.DB, { source: 'planner', code: err instanceof LlmError ? err.code : 'internal', message: (err as Error).message, path: c.req.path, requestId: c.get('requestId') });
      const message = err instanceof LlmError ? llmUserMessage(err) : 'Something went wrong, and this day was not changed. Please try again.';
      emit({ type: 'error', code: 'REGENERATE_FAILED', message, trip: tripDto(await reloadTrip(c.env.DB, row.id)) });
    } finally {
      await releaseBusy(c.env.DB, row.id);
    }
  });
});

tripRoutes.post('/:id/itinerary/ops', async (c) => {
  const row = await ownedOr404(c, currentPrincipal(c));
  assertNotBusy(row);
  const op = await parseJson(c, directOpSchema);
  const itinerary = parseItinerary(row.itinerary);
  try {
    const { itinerary: next, label } = applyDirectOp(itinerary, op, row.start_date);
    await snapshotItinerary(c.env.DB, row.id, itinerary, label);
    await saveItinerary(c.env.DB, row.id, next);
    return c.json({ trip: tripDto(await reloadTrip(c.env.DB, row.id)), undo: label });
  } catch (err) {
    if (err instanceof DirectEditError) throw new ApiError(400, 'INVALID_EDIT', err.message);
    throw err;
  }
});

tripRoutes.post('/:id/itinerary/undo', async (c) => {
  const row = await ownedOr404(c, currentPrincipal(c));
  assertNotBusy(row);
  const version = await c.env.DB.prepare('SELECT seq, itinerary FROM itinerary_versions WHERE trip_id = ? ORDER BY seq DESC LIMIT 1').bind(row.id).first<{ seq: number; itinerary: string }>();
  if (!version) throw new ApiError(400, 'NOTHING_TO_UNDO', 'There is nothing to undo.');
  await saveItinerary(c.env.DB, row.id, renumber(parseItinerary(version.itinerary), row.start_date));
  await c.env.DB.prepare('DELETE FROM itinerary_versions WHERE seq = ?').bind(version.seq).run();
  const next = await c.env.DB.prepare('SELECT reason FROM itinerary_versions WHERE trip_id = ? ORDER BY seq DESC LIMIT 1').bind(row.id).first<{ reason: string }>();
  return c.json({ trip: tripDto(await reloadTrip(c.env.DB, row.id)), undo: next?.reason ?? null });
});

const PLACE_QUERY_LIMITS = (c: Context<AppContext>, id: string) => [
  { scope: 'place_search_min', id, max: 15, windowSeconds: 60 },
  { scope: 'place_search_ip', id: clientIp(c), max: 150, windowSeconds: 3600 },
];

tripRoutes.get('/:id/places', async (c) => {
  const principal = currentPrincipal(c);
  const row = await ownedOr404(c, principal);
  const query = (c.req.query('q') ?? '').trim();
  if (query.length < 2 || query.length > 200) throw new ApiError(400, 'VALIDATION_ERROR', 'Search for between 2 and 200 characters.');
  await enforce(c.env.DB, PLACE_QUERY_LIMITS(c, `${principal!.type}:${principal!.id}`));
  const bias = row.dest_lat != null && row.dest_lng != null ? { lat: row.dest_lat, lng: row.dest_lng } : null;
  const outcome = await searchPlaces(c.env, {
    query,
    pageSize: 8,
    bias,
    attribution: { principal: principal!, tripId: row.id, tripLabel: row.title ?? row.destination },
    operation: 'explore_trip',
  });
  return c.json(placesResponse(outcome, query));
});

function placesResponse(outcome: Awaited<ReturnType<typeof searchPlaces>>, query: string) {
  if (outcome.status === 'ok') return { status: 'ok' as const, query, places: outcome.results };
  const messages = {
    unavailable: 'Live place search is not available right now.',
    quota: "You've reached today's place search limit. Please try again tomorrow.",
    error: 'Place search failed. Please try again.',
  };
  return { status: outcome.status, query, places: [], message: messages[outcome.status] };
}

/** Adds a place from search results. The verified data is re-read from the server cache, not from the client. */
tripRoutes.post('/:id/places/add', async (c) => {
  const row = await ownedOr404(c, currentPrincipal(c));
  assertNotBusy(row);
  const body = await parseJson(
    c,
    z.object({ query: z.string().trim().min(2).max(200), place_id: z.string().max(300), day_number: z.number().int().min(1), page_size: z.union([z.literal(6), z.literal(8)]) }),
  );
  const bias = row.dest_lat != null && row.dest_lng != null ? { lat: row.dest_lat, lng: row.dest_lng } : null;
  const results = await cachedSearch(c.env, { query: body.query, pageSize: body.page_size, bias });
  const place = results?.find((p) => p.place_id === body.place_id);
  if (!place) throw new ApiError(404, 'PLACE_EXPIRED', 'That search result has expired. Please search again.');
  const itinerary = parseItinerary(row.itinerary);
  const day = itinerary.days.find((d) => d.day_number === body.day_number);
  if (!day) throw new ApiError(400, 'INVALID_EDIT', `Day ${body.day_number} is not in this itinerary.`);
  const before = clone(itinerary);
  const activity: Activity = {
    id: activityId(),
    start_time: null,
    duration_minutes: 60,
    title: place.name,
    category: /restaurant|cafe|food|bar|bakery/i.test(place.type_label ?? '') ? 'food' : 'sight',
    description: place.type_label ?? '',
    location: null,
    est_cost: null,
    cost_note: null,
    transit_note: null,
    tip: null,
  };
  applyPlace(activity, place, null);
  day.activities.push(activity);
  await snapshotItinerary(c.env.DB, row.id, before, `Added ${place.name}`);
  await saveItinerary(c.env.DB, row.id, itinerary);
  return c.json({ trip: tripDto(await reloadTrip(c.env.DB, row.id)), undo: `Added ${place.name}` });
});

/** Photos are looked up from the trip's stored data, so the client cannot request arbitrary Places resources. */
tripRoutes.get('/:id/photos/:key', async (c) => {
  const principal = currentPrincipal(c);
  const row = await ownedOr404(c, principal);
  const key = c.req.param('key');
  let photoName: string | null = null;
  if (key === 'cover') photoName = row.cover_photo_name;
  else {
    for (const day of parseItinerary(row.itinerary).days) {
      const hit = day.activities.find((a) => a.id === key);
      if (hit) photoName = hit.location?.photo_name ?? null;
    }
  }
  if (!photoName) throw new ApiError(404, 'NOT_FOUND', 'No photo is available.');
  const res = await fetchPlacePhoto(c.env, photoName, { principal: principal!, tripId: row.id, tripLabel: row.title ?? row.destination }, c.executionCtx as ExecutionContext);
  if (!res) throw new ApiError(404, 'NOT_FOUND', 'No photo is available.');
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'private, max-age=86400');
  return out;
});

// ---- Research outside a saved trip. Usage here is recorded with no trip attached. ----

exploreRoutes.get('/places', async (c) => {
  const query = (c.req.query('q') ?? '').trim();
  if (query.length < 2 || query.length > 200) throw new ApiError(400, 'VALIDATION_ERROR', 'Search for between 2 and 200 characters.');
  const principal = await requirePrincipal(c);
  await enforce(c.env.DB, PLACE_QUERY_LIMITS(c, `${principal.type}:${principal.id}`));
  const outcome = await searchPlaces(c.env, { query, pageSize: 8, attribution: { principal, tripId: null }, operation: 'explore_search' });
  return c.json(placesResponse(outcome, query));
});

exploreRoutes.post('/ideas', async (c) => {
  const body = await parseJson(c, z.object({ prompt: z.string().trim().min(3, 'Tell us a little more').max(500, 'Keep it under 500 characters') }));
  assertLlmConfigured(c.env);
  const principal = await requirePrincipal(c);
  await guardAiSpend(c, principal);
  try {
    const result = await callStructured(c.env, {
      operation: 'destination_ideas',
      schemaName: 'destination_ideas',
      schema: ideasSchema,
      messages: [
        { role: 'system', content: ideasSystemPrompt(nowIso().slice(0, 10)) },
        { role: 'user', content: body.prompt },
      ],
      maxOutputTokens: 1000,
      timeoutMs: 45_000,
      attribution: { principal, tripId: null },
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof LlmError) {
      await logError(c.env.DB, { source: 'explore', code: err.code, message: err.message, path: c.req.path, requestId: c.get('requestId') });
      throw new ApiError(502, 'LLM_FAILED', llmUserMessage(err));
    }
    throw err;
  }
});

export const configRoute = new Hono<AppContext>();
configRoute.get('/', (c) => c.json({ placesAvailable: placesConfigured(c.env), maxTripDays: MAX_TRIP_DAYS }));

export { parseJsonColumn };
