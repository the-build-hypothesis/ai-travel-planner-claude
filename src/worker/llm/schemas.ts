// Provider-independent schemas for model output. Every field is required and nullable because that is
// what strict structured output needs. Ranges are enforced after parsing, when output is converted to
// domain objects, so one out-of-range number does not throw away a whole response.
import { z } from 'zod';
import { CATEGORIES, PACES } from '../../shared/schemas';

export const newActivitySchema = z.object({
  start_time: z.string().nullable().describe('Local 24-hour time, HH:MM'),
  duration_minutes: z.number().nullable(),
  title: z.string(),
  category: z.enum(CATEGORIES),
  description: z.string().describe('One or two helpful sentences'),
  location_name: z.string().nullable().describe('Name of the real place, or null for a generic stop'),
  place_query: z.string().nullable().describe('Search text that finds this exact place, such as "Senso-ji Temple, Asakusa, Tokyo"'),
  approx_lat: z.number().nullable(),
  approx_lng: z.number().nullable(),
  est_cost: z.number().nullable().describe("Rough total for the whole party in the trip's currency"),
  cost_note: z.string().nullable(),
  transit_from_previous: z.string().nullable(),
  tip: z.string().nullable(),
});
export type NewActivity = z.infer<typeof newActivitySchema>;

const activityChangesSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  start_time: z.string().nullable(),
  duration_minutes: z.number().nullable(),
  est_cost: z.number().nullable(),
  cost_note: z.string().nullable(),
  tip: z.string().nullable(),
});

export const aiEditOpSchema = z.object({
  op: z.enum(['add_activity', 'remove_activity', 'replace_activity', 'update_activity', 'move_activity', 'regenerate_day', 'add_day', 'remove_day']),
  activity_id: z.string().nullable(),
  day_number: z.number().nullable(),
  to_day_number: z.number().nullable(),
  after_activity_id: z.string().nullable(),
  start_time: z.string().nullable(),
  activity: newActivitySchema.nullable(),
  changes: activityChangesSchema.nullable(),
  instructions: z.string().nullable(),
});
export type AiEditOp = z.infer<typeof aiEditOpSchema>;

export const tripUpdatesSchema = z.object({
  title: z.string().nullable(),
  destination: z.string().nullable(),
  start_date: z.string().nullable().describe('YYYY-MM-DD'),
  end_date: z.string().nullable().describe('YYYY-MM-DD'),
  duration_days: z.number().nullable(),
  adults: z.number().nullable(),
  children_ages: z.array(z.number()).nullable(),
  budget_amount: z.number().nullable(),
  currency: z.string().nullable().describe('ISO 4217 code'),
  interests: z.array(z.string()).nullable(),
  pace: z.enum(PACES).nullable(),
  constraints: z.string().nullable(),
  lodging: z.string().nullable(),
});
export type TripUpdates = z.infer<typeof tripUpdatesSchema>;

// `intent` comes first so the server knows whether to stream `reply` before it starts arriving.
export const turnSchema = z.object({
  intent: z.enum(['chat', 'clarify', 'generate', 'edit', 'research']),
  reply: z.string(),
  trip_updates: tripUpdatesSchema,
  edits: z.array(aiEditOpSchema),
  research_queries: z.array(z.string()),
  suggestions: z.array(z.string()),
  show_map: z.boolean(),
});
export type TurnOutput = z.infer<typeof turnSchema>;

export const outlineSchema = z.object({
  overview: z.string(),
  tips: z.array(z.string()),
  days: z.array(
    z.object({
      title: z.string(),
      area: z.string(),
      focus: z.string(),
      anchors: z.array(z.string()).describe('The main named places this day is built around'),
    }),
  ),
});
export type OutlineOutput = z.infer<typeof outlineSchema>;

export const dayOutputSchema = z.object({
  title: z.string(),
  area: z.string().nullable(),
  summary: z.string().nullable(),
  transport_notes: z.string().nullable(),
  activities: z.array(newActivitySchema),
});
export type DayOutput = z.infer<typeof dayOutputSchema>;

export const ideasSchema = z.object({
  intro: z.string(),
  ideas: z.array(
    z.object({
      destination: z.string(),
      country: z.string(),
      why: z.string(),
      best_for: z.string(),
      starter_prompt: z.string().describe('A first message the traveler could send to plan this trip'),
    }),
  ),
});
