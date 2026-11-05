// Provider-independent domain schemas, shared by the Worker and the client.
import { z } from 'zod';

export const PACES = ['relaxed', 'balanced', 'packed'] as const;
export const CATEGORIES = ['sight', 'food', 'activity', 'nature', 'shopping', 'transport', 'lodging', 'other'] as const;
export const MAX_TRIP_DAYS = 14;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'Not a real calendar date');

export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

/** Editable trip details. Everything is optional because trips may start incomplete. */
export const tripDetailsFields = {
  title: z.string().trim().min(1).max(120).nullable(),
  destination: z.string().trim().min(1).max(200).nullable(),
  start_date: isoDate.nullable(),
  end_date: isoDate.nullable(),
  duration_days: z.number().int().min(1).max(MAX_TRIP_DAYS).nullable(),
  adults: z.number().int().min(1).max(20).nullable(),
  children_ages: z.array(z.number().int().min(0).max(17)).max(12),
  budget_amount: z.number().min(0).max(10_000_000).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
  interests: z.array(z.string().trim().min(1).max(60)).max(20),
  pace: z.enum(PACES).nullable(),
  constraints: z.string().trim().max(2000).nullable(),
  lodging: z.string().trim().max(300).nullable(),
};

export const tripPatchSchema = z
  .object(tripDetailsFields)
  .partial()
  .strict()
  .superRefine((t, ctx) => {
    if (t.start_date && t.end_date && t.end_date < t.start_date) {
      ctx.addIssue({ code: 'custom', path: ['end_date'], message: 'End date must be on or after the start date' });
    }
    if (t.start_date && t.end_date) {
      const days = daysBetween(t.start_date, t.end_date) + 1;
      if (days > MAX_TRIP_DAYS) {
        ctx.addIssue({ code: 'custom', path: ['end_date'], message: `Trips can be at most ${MAX_TRIP_DAYS} days` });
      }
    }
  });
export type TripPatch = z.infer<typeof tripPatchSchema>;

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export const locationSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(400).nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  /** Where the location data came from. Only `google_places` is treated as verified. */
  source: z.enum(['google_places', 'ai_estimate', 'user']),
  place_id: z.string().max(300).nullable(),
  rating: z.number().nullable(),
  rating_count: z.number().nullable(),
  price_level: z.string().max(60).nullable(),
  opening_hours: z.array(z.string().max(200)).max(14).nullable(),
  maps_url: z.string().max(600).nullable(),
  website: z.string().max(600).nullable(),
  photo_name: z.string().max(600).nullable(),
  photo_attribution: z.string().max(200).nullable(),
  verified_at: z.string().nullable(),
  /** Google Places reports that this business has closed for good. */
  permanently_closed: z.boolean().default(false),
});
export type TripLocation = z.infer<typeof locationSchema>;

export const activitySchema = z.object({
  id: z.string().min(1).max(40),
  start_time: hhmm.nullable(),
  duration_minutes: z.number().int().min(0).max(1440).nullable(),
  title: z.string().min(1).max(200),
  category: z.enum(CATEGORIES),
  description: z.string().max(2000),
  location: locationSchema.nullable(),
  /** Always an estimate: the AI or the traveler entered it, never a quoted price. */
  est_cost: z.number().min(0).max(10_000_000).nullable(),
  cost_note: z.string().max(300).nullable(),
  transit_note: z.string().max(500).nullable(),
  tip: z.string().max(500).nullable(),
});
export type Activity = z.infer<typeof activitySchema>;

export const daySchema = z.object({
  id: z.string().min(1).max(40),
  day_number: z.number().int().min(1).max(MAX_TRIP_DAYS),
  date: isoDate.nullable(),
  title: z.string().max(200),
  area: z.string().max(200).nullable(),
  summary: z.string().max(1000).nullable(),
  transport_notes: z.string().max(1000).nullable(),
  activities: z.array(activitySchema).max(15),
});
export type Day = z.infer<typeof daySchema>;

export const itinerarySchema = z.object({
  overview: z.string().max(2000).nullable(),
  tips: z.array(z.string().max(500)).max(12),
  days: z.array(daySchema).max(MAX_TRIP_DAYS),
});
export type Itinerary = z.infer<typeof itinerarySchema>;

export function emptyItinerary(): Itinerary {
  return { overview: null, tips: [], days: [] };
}

/** Fields a traveler may set directly on an activity from the UI. */
export const activityInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  start_time: hhmm.nullable().optional(),
  duration_minutes: z.number().int().min(0).max(1440).nullable().optional(),
  category: z.enum(CATEGORIES).optional(),
  description: z.string().max(2000).optional(),
  location_name: z.string().trim().max(200).nullable().optional(),
  est_cost: z.number().min(0).max(10_000_000).nullable().optional(),
});
export type ActivityInput = z.infer<typeof activityInputSchema>;

/** Direct, non-AI edit operations sent by the itinerary UI. */
export const directOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_activity'), day_number: z.number().int().min(1), activity: activityInputSchema }).strict(),
  z.object({ op: z.literal('update_activity'), activity_id: z.string().max(40), changes: activityInputSchema.partial() }).strict(),
  z.object({ op: z.literal('remove_activity'), activity_id: z.string().max(40) }).strict(),
  z
    .object({
      op: z.literal('move_activity'),
      activity_id: z.string().max(40),
      to_day_number: z.number().int().min(1),
      to_index: z.number().int().min(0).max(50),
    })
    .strict(),
  z.object({ op: z.literal('remove_day'), day_number: z.number().int().min(1) }).strict(),
]);
export type DirectOp = z.infer<typeof directOpSchema>;

export const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(128, 'Use at most 128 characters');
export const emailSchema = z.string().trim().max(254).email('Enter a valid email address');
