// The conversational planner: runs one traveler request end to end.
import { MAX_TRIP_DAYS, tripPatchSchema, type Activity, type Day, type Itinerary } from '../../shared/schemas';
import type { Env, Principal } from '../env';
import { callStructured, LlmError, llmUserMessage } from '../llm';
import {
  dayOutputSchema,
  outlineSchema,
  turnSchema,
  type DayOutput,
  type OutlineOutput,
  type TripUpdates,
  type TurnOutput,
} from '../llm/schemas';
import { daySystemPrompt, outlineSystemPrompt, turnSystemPrompt } from '../llm/prompts';
import type { LlmMessage } from '../llm/types';
import { haversineKm } from '../../shared/analyze';
import { logError } from '../lib/errors';
import { nowIso } from '../lib/http';
import {
  activityFromAi,
  applyAiOps,
  cleanDayTitle,
  clone,
  dayId,
  isPlaceholderStop,
  normalizeSchedule,
  renumber,
  type ActivityWithQuery,
  type Change,
} from '../itinerary/ops';
import { searchPlaces, type PlaceResult } from '../places/google';
import type { Attribution } from '../usage/record';
import {
  addMessage,
  listMessages,
  parseItinerary,
  reloadTrip,
  saveItinerary,
  snapshotItinerary,
  tripDto,
  type TripDto,
  type TripRow,
} from './repo';

export type PlannerEvent =
  | { type: 'status'; message: string }
  | { type: 'reply_delta'; text: string }
  | { type: 'trip'; trip: TripDto }
  | { type: 'outline'; days: { day_number: number; title: string; area: string }[] }
  | { type: 'day'; day: Day }
  | { type: 'show_map' }
  | { type: 'done'; message: unknown; trip: TripDto }
  | { type: 'error'; code: string; message: string; trip?: TripDto };

export type Emit = (event: PlannerEvent) => void;

interface TurnContext {
  env: Env;
  principal: Principal;
  requestId: string;
  emit: Emit;
}

const today = () => nowIso().slice(0, 10);
const DAY_CONCURRENCY = 4;
const MAX_ENRICH_PER_TURN = 40;

/**
 * Pulls the human-readable "reply" out of a partially received JSON object, so the assistant's words
 * can stream while the structured fields behind them are still arriving. Holds text back when the
 * intent is "research", because a second reply built on search results replaces it.
 */
export class ReplyStreamer {
  private raw = '';
  private cursor = -1;
  private done = false;
  constructor(private onText: (text: string) => void, private holdResearch = true) {}

  push(chunk: string): void {
    this.raw += chunk;
    if (this.done) return;
    if (this.cursor < 0) {
      const match = /"reply"\s*:\s*"/.exec(this.raw);
      if (!match) return;
      const intent = /"intent"\s*:\s*"(\w+)"/.exec(this.raw)?.[1];
      if (this.holdResearch && intent === 'research') {
        this.done = true;
        return;
      }
      this.cursor = match.index + match[0].length;
    }
    let out = '';
    while (this.cursor < this.raw.length) {
      const ch = this.raw[this.cursor];
      if (ch === '"') {
        this.done = true;
        break;
      }
      if (ch !== '\\') {
        out += ch;
        this.cursor++;
        continue;
      }
      const next = this.raw[this.cursor + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = this.raw.slice(this.cursor + 2, this.cursor + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        this.cursor += 6;
        continue;
      }
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
      out += map[next] ?? next;
      this.cursor += 2;
    }
    if (out) this.onText(out);
  }
}

async function pool<T, R>(items: T[], size: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}

function attributionFor(ctx: TurnContext, trip: TripRow | TripDto): Attribution {
  return { principal: ctx.principal, tripId: trip.id, tripLabel: trip.title ?? trip.destination ?? null };
}

/** Copies Google data onto an activity, but only if the match plausibly is the same place. */
export function applyPlace(activity: Activity, place: PlaceResult, bias: { lat: number; lng: number } | null): boolean {
  if (place.lat == null || place.lng == null) return false;
  const estimate = activity.location;
  if (estimate?.lat != null && estimate.lng != null) {
    if (haversineKm({ lat: estimate.lat, lng: estimate.lng }, { lat: place.lat, lng: place.lng }) > 60) return false;
  } else if (bias && haversineKm(bias, { lat: place.lat, lng: place.lng }) > 200) {
    return false;
  }
  const closed = place.business_status === 'CLOSED_PERMANENTLY';
  activity.location = {
    permanently_closed: closed,
    name: place.name,
    address: place.address,
    lat: place.lat,
    lng: place.lng,
    source: 'google_places',
    place_id: place.place_id,
    rating: place.rating,
    rating_count: place.rating_count,
    price_level: place.price_level,
    opening_hours: place.opening_hours,
    maps_url: place.maps_url,
    website: place.website,
    photo_name: place.photo_name,
    photo_attribution: place.photo_attribution,
    verified_at: nowIso(),
  };
  return true;
}

/** Verifies new stops against Google Places. Any failure leaves the stop marked as an AI estimate. */
async function enrich(ctx: TurnContext, trip: TripRow | TripDto, activities: ActivityWithQuery[], budget: { left: number }): Promise<void> {
  const bias = trip.dest_lat != null && trip.dest_lng != null ? { lat: trip.dest_lat, lng: trip.dest_lng } : null;
  const candidates = activities.filter((a) => a.place_query && a.category !== 'transport');
  await pool(candidates, 5, async (activity) => {
    if (budget.left <= 0) return;
    budget.left--;
    const outcome = await searchPlaces(ctx.env, {
      query: activity.place_query!,
      pageSize: 1,
      bias,
      attribution: attributionFor(ctx, trip),
      operation: 'verify_activity',
    });
    if (outcome.status === 'ok' && outcome.results[0]) applyPlace(activity, outcome.results[0], bias);
  });
  for (const activity of activities) delete activity.place_query;
}

function dayFromOutput(output: DayOutput, base: Partial<Day>): { day: Day; fresh: ActivityWithQuery[] } {
  const fresh = output.activities
    .filter((a) => !isPlaceholderStop(a.title))
    .slice(0, 15)
    .map(activityFromAi);
  normalizeSchedule(fresh);
  return {
    day: {
      id: base.id ?? dayId(),
      day_number: base.day_number ?? 1,
      date: base.date ?? null,
      title: (cleanDayTitle(output.title || '') || base.title || 'Day plan').slice(0, 200),
      area: (output.area ?? base.area ?? null)?.slice(0, 200) ?? null,
      summary: output.summary?.slice(0, 1000) ?? null,
      transport_notes: output.transport_notes?.slice(0, 1000) ?? null,
      activities: fresh,
    },
    fresh,
  };
}

async function generateDay(ctx: TurnContext, trip: TripDto, brief: string, operation: string): Promise<DayOutput> {
  return callStructured(ctx.env, {
    operation,
    schemaName: 'itinerary_day',
    schema: dayOutputSchema,
    messages: [
      { role: 'system', content: daySystemPrompt(trip, today()) },
      { role: 'user', content: brief },
    ],
    maxOutputTokens: 3000,
    timeoutMs: 75_000,
    attribution: attributionFor(ctx, trip),
  });
}

async function generateFullItinerary(ctx: TurnContext, trip: TripDto, instructions: string): Promise<{ itinerary: Itinerary; failedDays: number[] }> {
  const dayCount = Math.min(trip.duration_days ?? 3, MAX_TRIP_DAYS);
  ctx.emit({ type: 'status', message: `Sketching your ${dayCount}-day route…` });
  const outline: OutlineOutput = await callStructured(ctx.env, {
    operation: 'itinerary_outline',
    schemaName: 'itinerary_outline',
    schema: outlineSchema,
    messages: [
      { role: 'system', content: outlineSystemPrompt(trip, today(), dayCount) },
      { role: 'user', content: instructions },
    ],
    maxOutputTokens: 2000,
    timeoutMs: 60_000,
    attribution: attributionFor(ctx, trip),
  });
  const briefs = outline.days.slice(0, dayCount);
  if (briefs.length === 0) throw new LlmError('malformed', 'The outline contained no days');
  ctx.emit({ type: 'outline', days: briefs.map((d, i) => ({ day_number: i + 1, title: d.title, area: d.area })) });
  ctx.emit({ type: 'status', message: 'Planning each day and checking places…' });

  const isFirstBuild = trip.itinerary.days.length === 0;
  const itinerary: Itinerary = {
    overview: outline.overview.slice(0, 2000),
    tips: outline.tips.slice(0, 8).map((t) => t.slice(0, 500)),
    days: [],
  };
  const budget = { left: MAX_ENRICH_PER_TURN };
  const failedDays: number[] = [];
  const slots = new Array<Day>(briefs.length);
  let saveChain: Promise<void> = Promise.resolve();

  await pool(briefs, DAY_CONCURRENCY, async (brief, i) => {
    const elsewhere = briefs
      .filter((_, j) => j !== i)
      .flatMap((b) => b.anchors)
      .join(', ');
    const prompt = `Write day ${i + 1} of ${briefs.length}.
Theme: ${brief.title}. Area: ${brief.area}. Focus: ${brief.focus}.
Build it around: ${brief.anchors.join(', ')}.
These belong to other days, so do not use them: ${elsewhere || '(none)'}.
Traveler's request: ${instructions}`;
    let day: Day;
    try {
      const { day: built, fresh } = dayFromOutput(await generateDay(ctx, trip, prompt, 'itinerary_day'), {
        day_number: i + 1,
        title: brief.title,
        area: brief.area,
      });
      await enrich(ctx, trip, fresh, budget);
      day = built;
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      // One failed day should not throw away the others. It is reported and can be regenerated.
      failedDays.push(i + 1);
      day = {
        id: dayId(),
        day_number: i + 1,
        date: null,
        title: brief.title.slice(0, 200),
        area: brief.area.slice(0, 200),
        summary: 'This day could not be generated. Use Regenerate to try again.',
        transport_notes: null,
        activities: [],
      };
    }
    slots[i] = day;
    itinerary.days = slots.filter(Boolean).sort((a, b) => a.day_number - b.day_number);
    if (trip.start_date) {
      day.date = new Date(Date.parse(`${trip.start_date}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    }
    ctx.emit({ type: 'day', day: clone(day) });
    // Progress is saved only for a first build. A rebuild must not disturb the existing plan until it succeeds.
    if (isFirstBuild) {
      const snapshot = clone(itinerary);
      saveChain = saveChain.then(() => saveItinerary(ctx.env.DB, trip.id, snapshot));
      await saveChain;
    }
  });

  itinerary.days = slots;
  if (failedDays.length === briefs.length) throw new LlmError('server', 'Every day failed to generate');
  return { itinerary: renumber(itinerary, trip.start_date), failedDays: failedDays.sort((a, b) => a - b) };
}

function otherDaysSummary(itinerary: Itinerary, except: number | null): string {
  return (
    itinerary.days
      .filter((d) => d.day_number !== except)
      .flatMap((d) => d.activities.map((a) => a.title))
      .join(', ') || '(none)'
  );
}

export async function regenerateDay(ctx: TurnContext, trip: TripDto, itinerary: Itinerary, dayNumber: number, instructions: string | null, budget = { left: MAX_ENRICH_PER_TURN }): Promise<void> {
  const index = itinerary.days.findIndex((d) => d.day_number === dayNumber);
  if (index < 0) throw new LlmError('bad_request', `Day ${dayNumber} does not exist`);
  const current = itinerary.days[index];
  const prompt = `Rewrite day ${dayNumber} of ${itinerary.days.length}.
Current plan for this day: ${current.title}${current.area ? ` in ${current.area}` : ''}: ${current.activities.map((a) => a.title).join(', ') || 'empty'}.
Other days already include these, so do not repeat them: ${otherDaysSummary(itinerary, dayNumber)}.
What the traveler wants: ${instructions ?? 'A fresh plan for this day.'}`;
  const { day, fresh } = dayFromOutput(await generateDay(ctx, trip, prompt, 'regenerate_day'), current);
  await enrich(ctx, trip, fresh, budget);
  itinerary.days[index] = day;
  ctx.emit({ type: 'day', day: clone(day) });
}

async function addGeneratedDay(ctx: TurnContext, trip: TripDto, itinerary: Itinerary, instructions: string | null, budget: { left: number }): Promise<Day | null> {
  if (itinerary.days.length >= MAX_TRIP_DAYS) return null;
  const dayNumber = itinerary.days.length + 1;
  const prompt = `Write new day ${dayNumber}, added to the end of the trip.
Other days already include these, so do not repeat them: ${otherDaysSummary(itinerary, null)}.
What the traveler wants: ${instructions ?? 'A well-rounded additional day.'}`;
  const { day, fresh } = dayFromOutput(await generateDay(ctx, trip, prompt, 'add_day'), { day_number: dayNumber });
  await enrich(ctx, trip, fresh, budget);
  itinerary.days.push(day);
  ctx.emit({ type: 'day', day: clone(day) });
  return day;
}

/** Validates model-proposed details field by field. One invalid value is dropped, not the whole update. */
export function sanitizeTripUpdates(updates: TripUpdates): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) continue;
    const candidate = key === 'currency' && typeof value === 'string' ? value.toUpperCase() : value;
    if (tripPatchSchema.safeParse({ [key]: candidate }).success) out[key] = candidate;
  }
  const check = tripPatchSchema.safeParse(out);
  if (!check.success) {
    delete out.start_date;
    delete out.end_date;
  }
  return out;
}

const JSON_COLUMNS = new Set(['children_ages', 'interests']);

/** Applies a validated patch and keeps duration and dates consistent. The caller validates first. */
export async function applyTripPatch(db: D1Database, row: TripRow, patch: Record<string, unknown>): Promise<TripRow> {
  const merged = { ...patch };
  const start = 'start_date' in merged ? (merged.start_date as string | null) : row.start_date;
  let end = 'end_date' in merged ? (merged.end_date as string | null) : row.end_date;
  // A new start date can pass the old end date. The stale end date goes; duration then recomputes it below.
  if (start && end && end < start) {
    merged.end_date = null;
    end = null;
    if (!('duration_days' in merged) && row.duration_days) merged.duration_days = row.duration_days;
    if (typeof merged.duration_days === 'number') delete merged.end_date;
  }
  if (start && end && ('start_date' in merged || 'end_date' in merged) && !('duration_days' in merged)) {
    const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
    if (days <= MAX_TRIP_DAYS) merged.duration_days = days;
  }
  if (typeof merged.duration_days === 'number' && start && !('end_date' in merged)) {
    merged.end_date = new Date(Date.parse(`${start}T00:00:00Z`) + (merged.duration_days - 1) * 86_400_000).toISOString().slice(0, 10);
  }
  const keys = Object.keys(merged);
  if (keys.length === 0) return row;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (JSON_COLUMNS.has(k) ? JSON.stringify(merged[k]) : merged[k]));
  await db.prepare(`UPDATE trips SET ${sets}, updated_at = ? WHERE id = ?`).bind(...values, nowIso(), row.id).run();
  const updated = await reloadTrip(db, row.id);
  // Dates shown on existing days follow the trip's start date.
  if ('start_date' in merged && updated.day_count > 0) {
    await saveItinerary(db, row.id, renumber(parseItinerary(updated.itinerary), updated.start_date));
    return reloadTrip(db, row.id);
  }
  return updated;
}

/** Finds the destination's coordinates and cover photo. Failure here must never block planning. */
export async function resolveDestination(ctx: TurnContext, row: TripRow): Promise<TripRow> {
  if (!row.destination) return row;
  const outcome = await searchPlaces(ctx.env, {
    query: row.destination,
    pageSize: 1,
    attribution: { principal: ctx.principal, tripId: row.id, tripLabel: row.title ?? row.destination },
    operation: 'resolve_destination',
  });
  const place = outcome.status === 'ok' ? outcome.results[0] : undefined;
  if (!place || place.lat == null) return row;
  await ctx.env.DB.prepare('UPDATE trips SET dest_lat = ?, dest_lng = ?, cover_photo_name = ?, cover_photo_attribution = ? WHERE id = ?')
    .bind(place.lat, place.lng, place.photo_name, place.photo_attribution, row.id)
    .run();
  return reloadTrip(ctx.env.DB, row.id);
}

const MAX_HISTORY = 14;

async function buildHistory(db: D1Database, tripId: string): Promise<LlmMessage[]> {
  const messages = await listMessages(db, tripId, MAX_HISTORY);
  return messages.map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
}

export interface PlaceCard extends PlaceResult {
  query: string;
}

async function runResearch(ctx: TurnContext, row: TripRow, queries: string[]): Promise<{ cards: PlaceCard[]; summary: string; available: boolean }> {
  const bias = row.dest_lat != null && row.dest_lng != null ? { lat: row.dest_lat, lng: row.dest_lng } : null;
  const outcomes = await Promise.all(
    queries.slice(0, 3).map(async (query) => ({
      query,
      outcome: await searchPlaces(ctx.env, { query, pageSize: 6, bias, attribution: attributionFor(ctx, row), operation: 'research_search' }),
    })),
  );
  const seen = new Set<string>();
  const cards: PlaceCard[] = [];
  for (const { query, outcome } of outcomes) {
    if (outcome.status !== 'ok') continue;
    for (const place of outcome.results) {
      if (seen.has(place.place_id) || place.business_status === 'CLOSED_PERMANENTLY') continue;
      seen.add(place.place_id);
      cards.push({ ...place, query });
    }
  }
  const summary = cards
    .slice(0, 8)
    .map((c) => `- ${c.name} | ${c.address ?? 'address unavailable'} | rating ${c.rating ?? 'n/a'} (${c.rating_count ?? 0} reviews) | price ${c.price_level ?? 'n/a'}`)
    .join('\n');
  return { cards: cards.slice(0, 8), summary, available: outcomes.some((o) => o.outcome.status === 'ok') };
}

function failureMessage(err: unknown): { code: string; message: string } {
  if (err instanceof LlmError) return { code: `LLM_${err.code.toUpperCase()}`, message: llmUserMessage(err) };
  return { code: 'INTERNAL', message: 'Something went wrong on our side, and your plan was not changed. Please try again.' };
}

/** Runs one traveler message end to end. The caller has already authorized the request and holds the trip lock. */
export async function runTurn(ctx: TurnContext, initial: TripRow, userText: string): Promise<void> {
  let row = initial;
  try {
    // Retrying after a failure resends the same text, which should not appear twice in the conversation.
    const [latest] = await listMessages(ctx.env.DB, row.id, 1);
    if (!(latest?.role === 'user' && latest.content === userText)) await addMessage(ctx.env.DB, row.id, 'user', userText);
    const history = await buildHistory(ctx.env.DB, row.id);

    ctx.emit({ type: 'status', message: 'Thinking…' });
    const streamer = new ReplyStreamer((text) => ctx.emit({ type: 'reply_delta', text }));
    let turn: TurnOutput = await callStructured(ctx.env, {
      operation: 'chat_turn',
      schemaName: 'planner_turn',
      schema: turnSchema,
      messages: [{ role: 'system', content: turnSystemPrompt(tripDto(row), today()) }, ...history],
      maxOutputTokens: 4000,
      timeoutMs: 60_000,
      attribution: attributionFor(ctx, row),
      onDelta: (t) => streamer.push(t),
    });

    const before = { destination: row.destination };
    const patch = sanitizeTripUpdates(turn.trip_updates);
    if (Object.keys(patch).length) {
      row = await applyTripPatch(ctx.env.DB, row, patch);
      if (!row.title && row.destination) {
        row = await applyTripPatch(ctx.env.DB, row, { title: `Trip to ${row.destination}`.slice(0, 120) });
      }
      if (row.destination && (row.destination !== before.destination || row.dest_lat == null)) {
        ctx.emit({ type: 'status', message: 'Finding your destination…' });
        row = await resolveDestination(ctx, row);
      }
      ctx.emit({ type: 'trip', trip: tripDto(row) });
    }

    let cards: PlaceCard[] = [];
    let researchNote: string | null = null;
    if (turn.intent === 'research' && turn.research_queries.length) {
      ctx.emit({ type: 'status', message: 'Searching real places…' });
      const research = await runResearch(ctx, row, turn.research_queries);
      cards = research.cards;
      if (!research.available) researchNote = 'Live place search is unavailable right now, so these suggestions have not been checked against Google Places.';
      const context = research.summary || 'No results were found. Say so plainly and offer general guidance, clearly labeled as unverified.';
      const followUp = new ReplyStreamer((text) => ctx.emit({ type: 'reply_delta', text }), false);
      turn = await callStructured(ctx.env, {
        operation: 'research_reply',
        schemaName: 'planner_turn',
        schema: turnSchema,
        messages: [{ role: 'system', content: turnSystemPrompt(tripDto(row), today(), context) }, ...history],
        maxOutputTokens: 4000,
        timeoutMs: 60_000,
        attribution: attributionFor(ctx, row),
        onDelta: (t) => followUp.push(t),
      });
    }

    const trip = tripDto(row);
    const changes: Change[] = [];
    let failures: string[] = [];
    let failedDays: number[] = [];

    if (turn.intent === 'generate' && trip.destination) {
      if (!trip.duration_days) {
        row = await applyTripPatch(ctx.env.DB, row, { duration_days: 3 });
      }
      const fresh = tripDto(row);
      const { itinerary, failedDays: failed } = await generateFullItinerary(ctx, fresh, userText);
      failedDays = failed;
      if (fresh.itinerary.days.length) await snapshotItinerary(ctx.env.DB, row.id, fresh.itinerary, 'Before rebuilding the itinerary');
      await saveItinerary(ctx.env.DB, row.id, itinerary);
      changes.push({ type: 'generated', label: `${itinerary.days.length}-day itinerary` });
    } else if (turn.edits.length || turn.intent === 'edit') {
      const result = await applyEdits(ctx, trip, turn, row);
      changes.push(...result.changes);
      failures = result.failures;
    }

    row = await reloadTrip(ctx.env.DB, row.id);
    if (turn.show_map) ctx.emit({ type: 'show_map' });

    const notes = [...failures];
    if (researchNote) notes.push(researchNote);
    if (failedDays.length) notes.push(`Day${failedDays.length > 1 ? 's' : ''} ${failedDays.join(', ')} could not be generated. Use Regenerate on ${failedDays.length > 1 ? 'those days' : 'that day'}.`);
    const message = await addMessage(ctx.env.DB, row.id, 'assistant', turn.reply.trim() || 'Done.', {
      changes,
      notes,
      places: cards,
      suggestions: turn.suggestions.slice(0, 4).map((s) => s.slice(0, 100)),
      intent: turn.intent,
    });
    await ctx.env.DB.prepare('UPDATE trips SET updated_at = ? WHERE id = ?').bind(nowIso(), row.id).run();
    ctx.emit({ type: 'done', message, trip: tripDto(await reloadTrip(ctx.env.DB, row.id)) });
  } catch (err) {
    const failure = failureMessage(err);
    await logError(ctx.env.DB, {
      source: 'planner',
      code: err instanceof LlmError ? err.code : 'internal',
      message: (err as Error).message ?? 'unknown',
      path: `/api/trips/${row.id}/messages`,
      requestId: ctx.requestId,
    });
    console.error('turn failed', ctx.requestId, (err as Error).message);
    const current = await reloadTrip(ctx.env.DB, row.id).catch(() => row);
    ctx.emit({ type: 'error', ...failure, trip: tripDto(current) });
  }
}

async function applyEdits(ctx: TurnContext, trip: TripDto, turn: TurnOutput, row: TripRow): Promise<{ changes: Change[]; failures: string[] }> {
  const result = applyAiOps(trip.itinerary, turn.edits, trip.start_date);
  const budget = { left: MAX_ENRICH_PER_TURN };
  const working = result.itinerary;
  const changes = [...result.changes];
  const failures = [...result.failures];

  if (result.fresh.length) {
    ctx.emit({ type: 'status', message: 'Checking new places…' });
    await enrich(ctx, trip, result.fresh, budget);
  }
  for (const request of result.regenerate) {
    ctx.emit({ type: 'status', message: `Rewriting day ${request.day_number}…` });
    try {
      await regenerateDay(ctx, trip, working, request.day_number, request.instructions, budget);
      changes.push({ type: 'day_regenerated', label: `Day ${request.day_number}`, day_number: request.day_number });
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      failures.push(`Day ${request.day_number} could not be rewritten and was left as it was.`);
    }
  }
  for (const request of result.addDays) {
    ctx.emit({ type: 'status', message: 'Adding a day…' });
    try {
      const day = await addGeneratedDay(ctx, trip, working, request.instructions, budget);
      if (day) changes.push({ type: 'day_added', label: `Day ${day.day_number}: ${day.title}`, day_number: day.day_number });
      else failures.push(`Trips can be at most ${MAX_TRIP_DAYS} days.`);
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      failures.push('The extra day could not be generated.');
    }
  }
  if (changes.length) {
    await snapshotItinerary(ctx.env.DB, row.id, trip.itinerary, changes.map((c) => c.label).join(', '));
    renumber(working, trip.start_date);
    await saveItinerary(ctx.env.DB, row.id, working);
    // Duration follows the real number of days once the itinerary has changed shape.
    if (working.days.length !== trip.duration_days && working.days.length > 0) {
      await applyTripPatch(ctx.env.DB, row, { duration_days: working.days.length });
    }
  } else if (turn.intent === 'edit' && failures.length === 0) {
    failures.push('No changes were made to your itinerary. Try describing the change a little differently.');
  }
  return { changes, failures };
}
