import type { Principal } from '../env';
import { emptyItinerary, itinerarySchema, type Itinerary } from '../../shared/schemas';
import { newId } from '../lib/crypto';
import { nowIso, parseJsonColumn } from '../lib/http';

export interface TripRow {
  id: string;
  user_id: string | null;
  guest_id: string | null;
  title: string | null;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  duration_days: number | null;
  adults: number | null;
  children_ages: string;
  budget_amount: number | null;
  currency: string;
  interests: string;
  pace: string | null;
  constraints: string | null;
  lodging: string | null;
  dest_lat: number | null;
  dest_lng: number | null;
  cover_photo_name: string | null;
  cover_photo_attribution: string | null;
  itinerary: string;
  day_count: number;
  busy_until: string | null;
  created_at: string;
  updated_at: string;
}

export type TripDto = ReturnType<typeof tripDto>;

export function parseItinerary(raw: string): Itinerary {
  const parsed = itinerarySchema.safeParse(parseJsonColumn(raw, null));
  return parsed.success ? parsed.data : emptyItinerary();
}

/** The trip as sent to its owner. Ownership columns and internal state are not included. */
export function tripDto(row: TripRow) {
  return {
    id: row.id,
    title: row.title,
    destination: row.destination,
    start_date: row.start_date,
    end_date: row.end_date,
    duration_days: row.duration_days,
    adults: row.adults,
    children_ages: parseJsonColumn<number[]>(row.children_ages, []),
    budget_amount: row.budget_amount,
    currency: row.currency,
    interests: parseJsonColumn<string[]>(row.interests, []),
    pace: row.pace,
    constraints: row.constraints,
    lodging: row.lodging,
    dest_lat: row.dest_lat,
    dest_lng: row.dest_lng,
    has_cover: Boolean(row.cover_photo_name),
    cover_attribution: row.cover_photo_attribution,
    itinerary: parseItinerary(row.itinerary),
    day_count: row.day_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function ownerClause(p: Principal): { sql: string; id: string } {
  return { sql: p.type === 'user' ? 'user_id = ?' : 'guest_id = ?', id: p.id };
}

/**
 * The single gate for reading a trip. The owner is part of the query, so another owner's trip is
 * indistinguishable from one that does not exist.
 */
export async function getOwnedTrip(db: D1Database, id: string, principal: Principal): Promise<TripRow | null> {
  const owner = ownerClause(principal);
  return db.prepare(`SELECT * FROM trips WHERE id = ? AND ${owner.sql}`).bind(id, owner.id).first<TripRow>();
}

export async function reloadTrip(db: D1Database, id: string): Promise<TripRow> {
  const row = await db.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first<TripRow>();
  if (!row) throw new Error('Trip disappeared');
  return row;
}

export async function listTrips(db: D1Database, principal: Principal) {
  const owner = ownerClause(principal);
  const { results } = await db
    .prepare(`SELECT * FROM trips WHERE ${owner.sql} ORDER BY updated_at DESC LIMIT 200`)
    .bind(owner.id)
    .all<TripRow>();
  return results.map((row) => {
    const { itinerary, ...rest } = tripDto(row);
    return { ...rest, stop_count: itinerary.days.reduce((n, d) => n + d.activities.length, 0) };
  });
}

export async function createTrip(db: D1Database, principal: Principal, currency = 'USD', fields: { title?: string | null } = {}): Promise<TripRow> {
  const id = newId('trp');
  const now = nowIso();
  await db
    .prepare('INSERT INTO trips (id, user_id, guest_id, title, currency, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, principal.type === 'user' ? principal.id : null, principal.type === 'guest' ? principal.id : null, fields.title ?? null, currency, now, now)
    .run();
  return reloadTrip(db, id);
}

export async function saveItinerary(db: D1Database, tripId: string, itinerary: Itinerary): Promise<void> {
  const valid = itinerarySchema.parse(itinerary);
  await db
    .prepare('UPDATE trips SET itinerary = ?, day_count = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(valid), valid.days.length, nowIso(), tripId)
    .run();
}

const VERSIONS_KEPT = 20;

/** Stores the itinerary as it stands, before a change, so the change can be undone. */
export async function snapshotItinerary(db: D1Database, tripId: string, itinerary: Itinerary, reason: string): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO itinerary_versions (trip_id, itinerary, reason, created_at) VALUES (?,?,?,?)').bind(tripId, JSON.stringify(itinerary), reason.slice(0, 200), nowIso()),
    db.prepare('DELETE FROM itinerary_versions WHERE trip_id = ?1 AND seq NOT IN (SELECT seq FROM itinerary_versions WHERE trip_id = ?1 ORDER BY seq DESC LIMIT ?2)').bind(tripId, VERSIONS_KEPT),
  ]);
}

export interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  meta: string | null;
  created_at: string;
}

export function messageDto(row: MessageRow) {
  return { id: row.id, role: row.role, content: row.content, meta: parseJsonColumn<Record<string, unknown> | null>(row.meta, null), created_at: row.created_at };
}

export async function addMessage(db: D1Database, tripId: string, role: 'user' | 'assistant', content: string, meta?: Record<string, unknown> | null) {
  const row: MessageRow = { id: newId('msg'), role, content, meta: meta ? JSON.stringify(meta) : null, created_at: nowIso() };
  await db
    .prepare('INSERT INTO messages (id, trip_id, role, content, meta, created_at) VALUES (?,?,?,?,?,?)')
    .bind(row.id, tripId, role, row.content, row.meta, row.created_at)
    .run();
  return messageDto(row);
}

export async function listMessages(db: D1Database, tripId: string, limit = 300) {
  const { results } = await db
    .prepare('SELECT id, role, content, meta, created_at FROM (SELECT * FROM messages WHERE trip_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC')
    .bind(tripId, limit)
    .all<MessageRow>();
  return results.map(messageDto);
}

/** Single-writer lock per trip, so concurrent generations cannot double-spend or overwrite each other. */
export async function acquireBusy(db: D1Database, tripId: string, seconds = 300): Promise<boolean> {
  const now = new Date();
  const res = await db
    .prepare('UPDATE trips SET busy_until = ? WHERE id = ? AND (busy_until IS NULL OR busy_until < ?)')
    .bind(new Date(now.getTime() + seconds * 1000).toISOString(), tripId, now.toISOString())
    .run();
  return res.meta.changes === 1;
}

export async function releaseBusy(db: D1Database, tripId: string): Promise<void> {
  await db.prepare('UPDATE trips SET busy_until = NULL WHERE id = ?').bind(tripId).run();
}

export function isBusy(row: TripRow): boolean {
  return Boolean(row.busy_until && row.busy_until > nowIso());
}
