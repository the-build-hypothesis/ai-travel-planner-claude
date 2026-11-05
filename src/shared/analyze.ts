// Deterministic checks on an itinerary, shared by server and client.
import type { Day, Itinerary } from './schemas';

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function minutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

const PACE_MAX: Record<string, number> = { relaxed: 4, balanced: 6, packed: 8 };

/** Returns traveler-facing warnings for overlaps, overstuffed days and impractical hops. */
export function dayWarnings(day: Day, pace: string | null): string[] {
  const warnings: string[] = [];
  const timed = day.activities.filter((a) => a.start_time);
  for (let i = 1; i < timed.length; i++) {
    const prev = timed[i - 1];
    const cur = timed[i];
    const prevStart = minutes(prev.start_time!);
    const curStart = minutes(cur.start_time!);
    if (curStart < prevStart) {
      warnings.push(`"${cur.title}" is listed after "${prev.title}" but starts earlier.`);
    } else if (prev.duration_minutes && prevStart + prev.duration_minutes > curStart) {
      warnings.push(`"${prev.title}" overlaps "${cur.title}".`);
    }
    const a = prev.location;
    const b = cur.location;
    if (a?.lat != null && a.lng != null && b?.lat != null && b.lng != null) {
      const km = haversineKm({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
      const gap = curStart - (prevStart + (prev.duration_minutes ?? 0));
      if (km > 30 && gap < 45) warnings.push(`Only ${Math.max(gap, 0)} minutes to cover about ${Math.round(km)} km before "${cur.title}".`);
    }
  }
  const max = PACE_MAX[pace ?? 'balanced'] ?? 6;
  if (day.activities.length > max + 1) warnings.push(`${day.activities.length} stops is a lot for a ${pace ?? 'balanced'} day.`);
  for (const activity of day.activities) {
    if (activity.location?.permanently_closed) warnings.push(`Google Places lists "${activity.location.name}" as permanently closed. Consider replacing "${activity.title}".`);
  }
  return warnings;
}

/** Finds places that appear more than once across a trip, usually by mistake. */
export function duplicateWarnings(itinerary: Itinerary, day: Day): string[] {
  const seen = new Map<string, { day: number; index: number }>();
  const warnings: string[] = [];
  for (const d of itinerary.days) {
    d.activities.forEach((a, index) => {
      const key = a.location?.place_id;
      if (!key) return;
      const first = seen.get(key);
      if (!first) {
        seen.set(key, { day: d.day_number, index });
      } else if (d.day_number === day.day_number) {
        warnings.push(`"${a.title}" is already on day ${first.day}.`);
      }
    });
  }
  return warnings;
}

export function dayCost(day: Day): number {
  return day.activities.reduce((sum, a) => sum + (a.est_cost ?? 0), 0);
}

export function itineraryCost(itinerary: Itinerary): number {
  return itinerary.days.reduce((sum, d) => sum + dayCost(d), 0);
}
