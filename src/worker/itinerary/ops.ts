// Deterministic itinerary edits. AI edits and UI edits both pass through here, so a change only ever
// touches the activities it names and everything else is preserved byte for byte.
import { addDays, CATEGORIES, type Activity, type ActivityInput, type Day, type DirectOp, type Itinerary, type TripLocation } from '../../shared/schemas';
import { randomToken } from '../lib/crypto';
import type { NewActivity, AiEditOp } from '../llm/schemas';

export interface Change {
  type: 'added' | 'removed' | 'replaced' | 'updated' | 'moved' | 'day_removed' | 'day_regenerated' | 'day_added' | 'generated';
  label: string;
  day_number?: number;
}

export const activityId = () => `a_${randomToken(8)}`;
export const dayId = () => `d_${randomToken(8)}`;

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validTime(v: string | null | undefined): string | null {
  return v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null;
}

function clampNumber(v: number | null | undefined, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.min(v, max) : null;
}

export function estimatedLocation(name: string, lat: number | null, lng: number | null): TripLocation {
  const validLat = typeof lat === 'number' && lat >= -90 && lat <= 90 ? lat : null;
  const validLng = typeof lng === 'number' && lng >= -180 && lng <= 180 ? lng : null;
  return {
    name: name.slice(0, 200),
    address: null,
    lat: validLat !== null && validLng !== null ? validLat : null,
    lng: validLat !== null && validLng !== null ? validLng : null,
    source: 'ai_estimate',
    place_id: null,
    rating: null,
    rating_count: null,
    price_level: null,
    opening_hours: null,
    maps_url: null,
    website: null,
    photo_name: null,
    photo_attribution: null,
    verified_at: null,
    permanently_closed: false,
  };
}

const MIN_GAP_MINUTES = 10;

/** Pushes AI-generated stops later where they would overlap, leaving at least a short gap between them. */
export function normalizeSchedule(activities: Activity[]): void {
  const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  let previousEnd: number | null = null;
  for (const activity of activities) {
    if (!activity.start_time) continue;
    let start = toMinutes(activity.start_time);
    if (previousEnd !== null && start < previousEnd + MIN_GAP_MINUTES) {
      const shifted = previousEnd + MIN_GAP_MINUTES;
      // Past midnight the day is simply too full. It stays as is, and the day's warnings flag it.
      if (shifted < 24 * 60) {
        start = shifted;
        activity.start_time = toTime(start);
      }
    }
    previousEnd = start + (activity.duration_minutes ?? 0);
  }
}

export function cleanDayTitle(title: string): string {
  return title.replace(/^\s*day\s*\d+\s*[:\-–—]\s*/i, '').trim();
}

/** The model sometimes adds a placeholder like "End of Day", which is not something to do. */
export function isPlaceholderStop(title: string): boolean {
  return /^(end of (the )?day|day ends?|free time ends?)$/i.test(title.trim());
}

export type ActivityWithQuery = Activity & { place_query?: string | null };

/** Turns untrusted model output into a valid Activity, dropping anything out of range. */
export function activityFromAi(a: NewActivity): ActivityWithQuery {
  return {
    id: activityId(),
    start_time: validTime(a.start_time),
    duration_minutes: clampNumber(a.duration_minutes, 0, 1440),
    title: (a.title || 'Untitled stop').slice(0, 200),
    category: (CATEGORIES as readonly string[]).includes(a.category) ? a.category : 'other',
    description: (a.description ?? '').slice(0, 2000),
    location: a.location_name ? estimatedLocation(a.location_name, a.approx_lat, a.approx_lng) : null,
    est_cost: clampNumber(a.est_cost, 0, 10_000_000),
    cost_note: a.cost_note?.slice(0, 300) ?? null,
    transit_note: a.transit_from_previous?.slice(0, 500) ?? null,
    tip: a.tip?.slice(0, 500) ?? null,
    place_query: a.place_query ?? a.location_name ?? null,
  };
}

export function activityFromInput(input: ActivityInput): Activity {
  const name = input.location_name?.trim();
  return {
    id: activityId(),
    start_time: input.start_time ?? null,
    duration_minutes: input.duration_minutes ?? null,
    title: input.title,
    category: input.category ?? 'other',
    description: input.description ?? '',
    location: name ? { ...estimatedLocation(name, null, null), source: 'user' } : null,
    est_cost: input.est_cost ?? null,
    cost_note: null,
    transit_note: null,
    tip: null,
  };
}

export function renumber(itinerary: Itinerary, startDate: string | null): Itinerary {
  itinerary.days.forEach((day, i) => {
    day.day_number = i + 1;
    day.date = startDate ? addDays(startDate, i) : null;
  });
  return itinerary;
}

function locate(itinerary: Itinerary, id: string | null | undefined): { day: Day; index: number } | null {
  if (!id) return null;
  for (const day of itinerary.days) {
    const index = day.activities.findIndex((a) => a.id === id);
    if (index >= 0) return { day, index };
  }
  return null;
}

/** Inserts in time order when the new stop has a time, otherwise at the end of the day. */
function insertChronological(day: Day, activity: Activity, afterId?: string | null): void {
  const after = afterId ? day.activities.findIndex((a) => a.id === afterId) : -1;
  if (after >= 0) {
    day.activities.splice(after + 1, 0, activity);
    return;
  }
  if (activity.start_time) {
    const idx = day.activities.findIndex((a) => a.start_time && a.start_time > activity.start_time!);
    if (idx >= 0) {
      day.activities.splice(idx, 0, activity);
      return;
    }
  }
  day.activities.push(activity);
}

/** Keeps the day's time slots in order when stops are rearranged by hand. */
function reassignTimes(day: Day): void {
  const slots = day.activities.map((a) => a.start_time).filter((t): t is string => Boolean(t)).sort();
  let i = 0;
  for (const activity of day.activities) {
    if (activity.start_time) activity.start_time = slots[i++];
  }
}

export interface AiOpsResult {
  itinerary: Itinerary;
  changes: Change[];
  failures: string[];
  /** Newly created activities that still need Places enrichment. */
  fresh: ActivityWithQuery[];
  regenerate: { day_number: number; instructions: string | null }[];
  addDays: { instructions: string | null }[];
}

/** Applies model-proposed edits. Unknown ids are reported as failures instead of being guessed at. */
export function applyAiOps(source: Itinerary, ops: AiEditOp[], startDate: string | null): AiOpsResult {
  const itinerary = clone(source);
  const result: AiOpsResult = { itinerary, changes: [], failures: [], fresh: [], regenerate: [], addDays: [] };
  const dayByNumber = (n: number | null | undefined) => itinerary.days.find((d) => d.day_number === n);
  const removedDays: Day[] = [];

  for (const op of ops) {
    switch (op.op) {
      case 'add_activity': {
        const day = dayByNumber(op.day_number);
        if (!day || !op.activity) {
          result.failures.push(`Could not add a stop to day ${op.day_number ?? '?'}.`);
          break;
        }
        const activity = activityFromAi(op.activity);
        insertChronological(day, activity, op.after_activity_id);
        result.fresh.push(activity);
        result.changes.push({ type: 'added', label: activity.title, day_number: day.day_number });
        break;
      }
      case 'remove_activity': {
        const found = locate(itinerary, op.activity_id);
        if (!found) {
          result.failures.push('Could not find a stop to remove.');
          break;
        }
        const [removed] = found.day.activities.splice(found.index, 1);
        result.changes.push({ type: 'removed', label: removed.title, day_number: found.day.day_number });
        break;
      }
      case 'replace_activity': {
        const found = locate(itinerary, op.activity_id);
        if (!found || !op.activity) {
          result.failures.push('Could not find a stop to replace.');
          break;
        }
        const old = found.day.activities[found.index];
        const activity = activityFromAi(op.activity);
        activity.start_time ??= old.start_time;
        found.day.activities[found.index] = activity;
        result.fresh.push(activity);
        result.changes.push({ type: 'replaced', label: `${old.title} → ${activity.title}`, day_number: found.day.day_number });
        break;
      }
      case 'update_activity': {
        const found = locate(itinerary, op.activity_id);
        if (!found || !op.changes) {
          result.failures.push('Could not find a stop to update.');
          break;
        }
        const a = found.day.activities[found.index];
        const ch = op.changes;
        if (ch.title) a.title = ch.title.slice(0, 200);
        if (ch.description != null) a.description = ch.description.slice(0, 2000);
        if (validTime(ch.start_time)) a.start_time = validTime(ch.start_time);
        const duration = clampNumber(ch.duration_minutes, 0, 1440);
        if (duration !== null) a.duration_minutes = duration;
        const cost = clampNumber(ch.est_cost, 0, 10_000_000);
        if (cost !== null) a.est_cost = cost;
        if (ch.cost_note != null) a.cost_note = ch.cost_note.slice(0, 300);
        if (ch.tip != null) a.tip = ch.tip.slice(0, 500);
        found.day.activities.sort((x, y) => (x.start_time ?? '99').localeCompare(y.start_time ?? '99'));
        result.changes.push({ type: 'updated', label: a.title, day_number: found.day.day_number });
        break;
      }
      case 'move_activity': {
        const found = locate(itinerary, op.activity_id);
        const target = dayByNumber(op.to_day_number) ?? found?.day;
        if (!found || !target) {
          result.failures.push('Could not find a stop to move.');
          break;
        }
        const [moved] = found.day.activities.splice(found.index, 1);
        if (validTime(op.start_time)) moved.start_time = validTime(op.start_time);
        insertChronological(target, moved, op.after_activity_id);
        result.changes.push({ type: 'moved', label: moved.title, day_number: target.day_number });
        break;
      }
      case 'regenerate_day': {
        if (!dayByNumber(op.day_number)) {
          result.failures.push(`Day ${op.day_number ?? '?'} is not in this itinerary.`);
          break;
        }
        result.regenerate.push({ day_number: op.day_number!, instructions: op.instructions ?? null });
        break;
      }
      case 'add_day':
        result.addDays.push({ instructions: op.instructions ?? null });
        break;
      case 'remove_day': {
        const day = dayByNumber(op.day_number);
        if (!day) {
          result.failures.push(`Day ${op.day_number ?? '?'} is not in this itinerary.`);
          break;
        }
        removedDays.push(day);
        result.changes.push({ type: 'day_removed', label: `Day ${day.day_number}: ${day.title}`, day_number: day.day_number });
        break;
      }
    }
  }
  // Applied last so the day numbers in a single batch of ops all refer to the same itinerary.
  if (removedDays.length) itinerary.days = itinerary.days.filter((d) => !removedDays.includes(d));
  renumber(itinerary, startDate);
  return result;
}

export class DirectEditError extends Error {}

/** Applies one validated edit from the itinerary UI. */
export function applyDirectOp(source: Itinerary, op: DirectOp, startDate: string | null): { itinerary: Itinerary; label: string } {
  const itinerary = clone(source);
  const need = (id: string) => {
    const found = locate(itinerary, id);
    if (!found) throw new DirectEditError('That stop no longer exists. Refresh and try again.');
    return found;
  };
  const dayOf = (n: number) => {
    const day = itinerary.days.find((d) => d.day_number === n);
    if (!day) throw new DirectEditError(`Day ${n} is not in this itinerary.`);
    return day;
  };
  let label: string;
  switch (op.op) {
    case 'add_activity': {
      const activity = activityFromInput(op.activity);
      insertChronological(dayOf(op.day_number), activity);
      label = `Added ${activity.title}`;
      break;
    }
    case 'update_activity': {
      const { day, index } = need(op.activity_id);
      const a = day.activities[index];
      const ch = op.changes;
      if (ch.title !== undefined) a.title = ch.title;
      if (ch.start_time !== undefined) a.start_time = ch.start_time;
      if (ch.duration_minutes !== undefined) a.duration_minutes = ch.duration_minutes;
      if (ch.category !== undefined) a.category = ch.category;
      if (ch.description !== undefined) a.description = ch.description;
      if (ch.est_cost !== undefined) a.est_cost = ch.est_cost;
      if (ch.location_name !== undefined) {
        const name = ch.location_name?.trim();
        // Renaming a place means the verified data no longer describes it.
        if (!name) a.location = null;
        else if (name !== a.location?.name) a.location = { ...estimatedLocation(name, null, null), source: 'user' };
      }
      if (ch.start_time !== undefined) day.activities.sort((x, y) => (x.start_time ?? '99').localeCompare(y.start_time ?? '99'));
      label = `Updated ${a.title}`;
      break;
    }
    case 'remove_activity': {
      const { day, index } = need(op.activity_id);
      const [removed] = day.activities.splice(index, 1);
      label = `Removed ${removed.title}`;
      break;
    }
    case 'move_activity': {
      const { day, index } = need(op.activity_id);
      const target = dayOf(op.to_day_number);
      const [moved] = day.activities.splice(index, 1);
      target.activities.splice(Math.min(op.to_index, target.activities.length), 0, moved);
      reassignTimes(target);
      if (target !== day) reassignTimes(day);
      label = `Moved ${moved.title}`;
      break;
    }
    case 'remove_day': {
      const day = dayOf(op.day_number);
      itinerary.days = itinerary.days.filter((d) => d !== day);
      label = `Removed day ${op.day_number}`;
      break;
    }
  }
  return { itinerary: renumber(itinerary, startDate), label };
}
