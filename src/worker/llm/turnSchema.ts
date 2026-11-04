// Strict JSON Schema for the planner's structured response. Mirrors
// llmTurnSchema in src/shared/schemas.ts (which is used for validation).
import { CATEGORIES, PACES } from "../../shared/schemas";

const str = { type: "string" };
const nstr = { type: ["string", "null"] };
const nnum = { type: ["number", "null"] };
const nint = { type: ["integer", "null"] };

function obj(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };
}

const activity = obj({
  id: { ...nstr, description: "Existing activity id when keeping/editing an activity; null for new activities." },
  title: str,
  category: { type: "string", enum: [...CATEGORIES] },
  startTime: { ...nstr, description: "24h HH:MM local time" },
  durationMinutes: nint,
  locationName: { ...nstr, description: "Specific real venue/place name suitable for a map search; null for generic items." },
  address: nstr,
  description: str,
  tips: nstr,
  costAmount: { ...nnum, description: "ESTIMATED cost in the itinerary currency; null if unknown." },
  costPer: { type: ["string", "null"], enum: ["person", "group", null] },
  costNote: nstr,
  lat: { ...nnum, description: "Approximate latitude (estimate)." },
  lng: { ...nnum, description: "Approximate longitude (estimate)." },
  transportToNext: { ...nstr, description: "How to get to the next stop and approximate travel time." },
  bookingRecommended: { type: "boolean" },
});

const day = obj({
  dayNumber: { type: "integer" },
  title: str,
  area: nstr,
  summary: str,
  activities: { type: "array", items: activity },
  estimatedDayCost: nnum,
});

/** Schema for per-day activity fill-in calls. */
export const DAYS_JSON_SCHEMA: Record<string, unknown> = obj({ days: { type: "array", items: day } });

const preferences = obj({
  destination: nstr,
  startDate: { ...nstr, description: "YYYY-MM-DD" },
  endDate: { ...nstr, description: "YYYY-MM-DD" },
  durationDays: nint,
  adults: nint,
  children: nint,
  childAges: { type: ["array", "null"], items: { type: "integer" } },
  budgetAmount: nnum,
  budgetCurrency: { ...nstr, description: "ISO 4217 code" },
  budgetNotes: nstr,
  interests: { type: ["array", "null"], items: str },
  pace: { type: ["string", "null"], enum: [...PACES, null] },
  lodging: nstr,
  requirements: nstr,
});

export const TURN_JSON_SCHEMA: Record<string, unknown> = obj({
  reply: { type: "string", description: "Conversational reply shown to the traveler (plain text, may use short bullet lists)." },
  intent: { type: "string", enum: ["clarify", "generate", "modify", "answer"] },
  tripTitle: nstr,
  preferenceUpdates: { ...preferences, description: "Only fields that changed in this turn; null means unchanged." },
  itinerary: {
    anyOf: [
      obj({
        mode: { type: "string", enum: ["replace_all", "patch"] },
        currency: nstr,
        overview: nstr,
        assumptions: { type: ["array", "null"], items: str },
        days: { type: "array", items: day },
        removeDayNumbers: { type: "array", items: { type: "integer" } },
      }),
      { type: "null" },
    ],
  },
  suggestions: { type: "array", items: str, description: "2-4 short follow-up requests the traveler might send next." },
});
