// Provider-independent schemas for trip data. Used for validation in the Worker
// and (as types only) by the client.
import { z } from "zod";

export const CATEGORIES = [
  "sight",
  "food",
  "activity",
  "outdoors",
  "shopping",
  "nightlife",
  "culture",
  "transport",
  "lodging",
  "rest",
  "other",
] as const;
export const categorySchema = z.enum(CATEGORIES);

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM")
  .nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

/** Data retrieved from Google Places — the only "verified" facts we display. */
export const placeSchema = z.object({
  source: z.literal("google_places"),
  placeId: z.string().max(300),
  name: z.string().max(300),
  address: z.string().max(500).nullable(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  rating: z.number().min(0).max(5).nullable(),
  userRatingCount: z.number().int().nonnegative().nullable(),
  priceLevel: z.string().max(60).nullable(),
  openingHours: z.array(z.string().max(200)).max(14).nullable(),
  businessStatus: z.string().max(60).nullable(),
  mapsUri: z.string().max(1000).nullable(),
  website: z.string().max(1000).nullable(),
  fetchedAt: z.number().int(),
});
export type Place = z.infer<typeof placeSchema>;

export const costSchema = z.object({
  amount: z.number().nonnegative().max(1_000_000),
  currency: z.string().min(3).max(3),
  per: z.enum(["person", "group"]),
  note: z.string().max(300).nullable(),
});

export const activitySchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  category: categorySchema,
  startTime: timeSchema,
  durationMinutes: z.number().int().min(0).max(24 * 60).nullable(),
  locationName: z.string().max(200).nullable(),
  address: z.string().max(400).nullable(),
  description: z.string().max(2000),
  tips: z.string().max(1000).nullable(),
  /** Always an estimate — never presented as a verified price. */
  estimatedCost: costSchema.nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  coordSource: z.enum(["ai_estimate", "google_places", "user"]).nullable(),
  transportToNext: z.string().max(400).nullable(),
  bookingRecommended: z.boolean(),
  place: placeSchema.nullable(),
});
export type Activity = z.infer<typeof activitySchema>;

export const daySchema = z.object({
  dayNumber: z.number().int().min(1).max(30),
  date: isoDate.nullable(),
  title: z.string().max(200),
  area: z.string().max(200).nullable(),
  summary: z.string().max(1500),
  activities: z.array(activitySchema).max(14),
  estimatedDayCost: z.number().nonnegative().max(10_000_000).nullable(),
});
export type Day = z.infer<typeof daySchema>;

export const itinerarySchema = z.object({
  currency: z.string().min(3).max(3),
  overview: z.string().max(3000),
  days: z.array(daySchema).max(30),
  assumptions: z.array(z.string().max(400)).max(12),
  totalEstimatedCost: z.number().nonnegative().max(100_000_000).nullable(),
  updatedAt: z.number().int(),
});
export type Itinerary = z.infer<typeof itinerarySchema>;

export const PACES = ["relaxed", "moderate", "packed"] as const;

export const preferencesSchema = z.object({
  destination: z.string().max(200).nullable().default(null),
  startDate: isoDate.nullable().default(null),
  endDate: isoDate.nullable().default(null),
  durationDays: z.number().int().min(1).max(30).nullable().default(null),
  adults: z.number().int().min(0).max(50).nullable().default(null),
  children: z.number().int().min(0).max(50).nullable().default(null),
  childAges: z.array(z.number().int().min(0).max(17)).max(20).default([]),
  budgetAmount: z.number().nonnegative().max(100_000_000).nullable().default(null),
  budgetCurrency: z.string().min(3).max(3).nullable().default(null),
  budgetNotes: z.string().max(300).nullable().default(null),
  interests: z.array(z.string().max(60)).max(30).default([]),
  pace: z.enum(PACES).nullable().default(null),
  lodging: z.string().max(300).nullable().default(null),
  requirements: z.string().max(1000).nullable().default(null),
});
export type TripPreferences = z.infer<typeof preferencesSchema>;
export const emptyPreferences = (): TripPreferences => preferencesSchema.parse({});

// ───────────────────────── LLM structured output ─────────────────────────
// The model never returns a whole new trip unless asked: it returns only the
// days it changed ("patch") so unrelated days are preserved byte-for-byte.

export const llmActivitySchema = z.object({
  id: z.string().max(64).nullable(),
  title: z.string().min(1).max(200),
  category: categorySchema,
  startTime: z.string().max(5).nullable(),
  durationMinutes: z.number().nullable(),
  locationName: z.string().max(200).nullable(),
  address: z.string().max(400).nullable(),
  description: z.string().max(2000),
  tips: z.string().max(1000).nullable(),
  costAmount: z.number().nullable(),
  costPer: z.enum(["person", "group"]).nullable(),
  costNote: z.string().max(300).nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  transportToNext: z.string().max(400).nullable(),
  bookingRecommended: z.boolean(),
});
export type LlmActivity = z.infer<typeof llmActivitySchema>;

export const llmDaySchema = z.object({
  dayNumber: z.number().int().min(1).max(30),
  title: z.string().max(200),
  area: z.string().max(200).nullable(),
  summary: z.string().max(1500),
  activities: z.array(llmActivitySchema).max(14),
  estimatedDayCost: z.number().nullable(),
});
export type LlmDay = z.infer<typeof llmDaySchema>;

export const llmPreferencesSchema = z.object({
  destination: z.string().max(200).nullable(),
  startDate: z.string().max(10).nullable(),
  endDate: z.string().max(10).nullable(),
  durationDays: z.number().int().nullable(),
  adults: z.number().int().nullable(),
  children: z.number().int().nullable(),
  childAges: z.array(z.number().int()).nullable(),
  budgetAmount: z.number().nullable(),
  budgetCurrency: z.string().max(3).nullable(),
  budgetNotes: z.string().max(300).nullable(),
  interests: z.array(z.string().max(60)).nullable(),
  pace: z.enum(PACES).nullable(),
  lodging: z.string().max(300).nullable(),
  requirements: z.string().max(1000).nullable(),
});

export const llmTurnSchema = z.object({
  reply: z.string().min(1).max(6000),
  intent: z.enum(["clarify", "generate", "modify", "answer"]),
  tripTitle: z.string().max(120).nullable(),
  preferenceUpdates: llmPreferencesSchema,
  itinerary: z
    .object({
      mode: z.enum(["replace_all", "patch"]),
      currency: z.string().max(3).nullable(),
      overview: z.string().max(3000).nullable(),
      assumptions: z.array(z.string().max(400)).nullable(),
      days: z.array(llmDaySchema).max(30),
      removeDayNumbers: z.array(z.number().int()),
    })
    .nullable(),
  suggestions: z.array(z.string().max(120)).max(5),
});
export type LlmTurn = z.infer<typeof llmTurnSchema>;

// ───────────────────────── API DTOs ─────────────────────────
export interface TripSummary {
  id: string;
  title: string;
  destination: string | null;
  dayCount: number;
  startDate: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  meta: { changedDays?: number[]; intent?: string; suggestions?: string[]; error?: boolean } | null;
  createdAt: number;
}

export interface TripDetail extends TripSummary {
  preferences: TripPreferences;
  itinerary: Itinerary | null;
  itineraryVersion: number;
  messages: ChatMessage[];
}
