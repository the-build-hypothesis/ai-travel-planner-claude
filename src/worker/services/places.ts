// Google Places API (New) integration — server-side only.
// Every billable request is recorded in usage_events with its SKU and cost.
import type { Activity, Itinerary, Place } from "../../shared/schemas";
import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { getPricing, recordUsage, requestCost, type Attribution } from "./usage";

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
// Field mask determines the billing SKU. rating / opening hours / price level /
// website are "Enterprise" fields → Text Search Enterprise SKU.
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.regularOpeningHours.weekdayDescriptions",
  "places.businessStatus",
  "places.googleMapsUri",
  "places.websiteUri",
  "places.primaryTypeDisplayName",
].join(",");
export const PLACES_SKU = "text_search_enterprise";
const CACHE_TTL_MS = 7 * 86400_000;
const TIMEOUT_MS = 10_000;
const SKIP_CATEGORIES = new Set(["transport", "rest"]);

export interface PlaceResult extends Place {
  primaryType: string | null;
}

export function placesConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_MAPS_API_KEY);
}

function toPlace(p: any): PlaceResult | null {
  const lat = p?.location?.latitude;
  const lng = p?.location?.longitude;
  if (!p?.id || typeof lat !== "number" || typeof lng !== "number") return null;
  return {
    source: "google_places",
    placeId: String(p.id).slice(0, 300),
    name: String(p.displayName?.text ?? "").slice(0, 300) || "Unnamed place",
    address: p.formattedAddress ? String(p.formattedAddress).slice(0, 500) : null,
    lat,
    lng,
    rating: typeof p.rating === "number" ? p.rating : null,
    userRatingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
    priceLevel: p.priceLevel ? String(p.priceLevel).replace("PRICE_LEVEL_", "").toLowerCase().slice(0, 60) : null,
    openingHours: Array.isArray(p.regularOpeningHours?.weekdayDescriptions)
      ? p.regularOpeningHours.weekdayDescriptions.slice(0, 7).map((s: unknown) => String(s).slice(0, 200))
      : null,
    businessStatus: p.businessStatus ? String(p.businessStatus).slice(0, 60) : null,
    mapsUri: p.googleMapsUri ? String(p.googleMapsUri).slice(0, 1000) : null,
    website: p.websiteUri ? String(p.websiteUri).slice(0, 1000) : null,
    fetchedAt: Date.now(),
    primaryType: p.primaryTypeDisplayName?.text ? String(p.primaryTypeDisplayName.text).slice(0, 80) : null,
  };
}

export interface SearchOptions {
  env: Env;
  query: string;
  maxResults: number;
  bias?: { lat: number; lng: number; radiusM: number } | null;
  operation: string;
  attribution: Attribution;
  fetchImpl?: typeof fetch;
}

/** Text Search with D1 caching. Cache hits are not billed and not recorded. */
export async function searchPlaces(o: SearchOptions): Promise<{ results: PlaceResult[]; cached: boolean }> {
  if (!o.env.GOOGLE_MAPS_API_KEY) throw new PlacesError("config", "Google Places is not configured.");
  const query = o.query.trim().slice(0, 300);
  const biasKey = o.bias ? `${o.bias.lat.toFixed(2)},${o.bias.lng.toFixed(2)},${o.bias.radiusM}` : "";
  const key = await sha256(`v1|${o.maxResults}|${biasKey}|${query.toLowerCase()}`);
  const cached = await o.env.DB.prepare(`SELECT result, created_at FROM places_cache WHERE query_hash = ?`)
    .bind(key)
    .first<{ result: string | null; created_at: number }>();
  if (cached && Date.now() - cached.created_at < CACHE_TTL_MS) {
    return { results: cached.result ? (JSON.parse(cached.result) as PlaceResult[]) : [], cached: true };
  }

  const body: Record<string, unknown> = { textQuery: query, pageSize: o.maxResults };
  if (o.bias) {
    body.locationBias = {
      circle: { center: { latitude: o.bias.lat, longitude: o.bias.lng }, radius: Math.min(o.bias.radiusM, 50_000) },
    };
  }
  const pricing = await getPricing(o.env.DB, "google_places", PLACES_SKU);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let res: Response;
  try {
    res = await doFetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": o.env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    const timeout = controller.signal.aborted;
    await recordUsage(o.env.DB, {
      provider: "google_places",
      model: PLACES_SKU,
      endpoint: "places:searchText",
      operation: o.operation,
      attribution: o.attribution,
      status: "error",
      units: 0,
      costUsd: 0,
      pricing,
      durationMs: Date.now() - started,
      errorCode: timeout ? "timeout" : "network",
      errorMessage: timeout ? "Places request timed out" : "Network error contacting Google Places",
    });
    throw new PlacesError(timeout ? "timeout" : "network", "Google Places is unavailable right now.");
  }
  clearTimeout(timer);
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    // Failed requests (4xx/5xx) are not billed by Google; record with zero cost.
    await recordUsage(o.env.DB, {
      provider: "google_places",
      model: PLACES_SKU,
      endpoint: "places:searchText",
      operation: o.operation,
      attribution: o.attribution,
      status: "error",
      httpStatus: res.status,
      units: 0,
      costUsd: 0,
      pricing,
      durationMs: Date.now() - started,
      errorCode: String(json?.error?.status ?? `http_${res.status}`).slice(0, 60),
      errorMessage: String(json?.error?.message ?? "Places request failed").slice(0, 300),
    });
    throw new PlacesError(res.status === 429 ? "rate_limited" : "api", "Google Places request failed.");
  }
  const results = (Array.isArray(json?.places) ? json.places : []).map(toPlace).filter(Boolean) as PlaceResult[];
  await recordUsage(o.env.DB, {
    provider: "google_places",
    model: PLACES_SKU,
    endpoint: "places:searchText",
    operation: o.operation,
    attribution: o.attribution,
    status: "success",
    httpStatus: res.status,
    units: 1,
    costUsd: pricing ? requestCost(pricing, 1) : null,
    pricing,
    durationMs: Date.now() - started,
  });
  await o.env.DB.prepare(
    `INSERT INTO places_cache (query_hash, query, result, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(query_hash) DO UPDATE SET result = excluded.result, created_at = excluded.created_at`,
  )
    .bind(key, query, JSON.stringify(results), Date.now())
    .run();
  // Remember individual places so client-side additions can be re-validated server-side.
  for (const r of results) {
    await o.env.DB.prepare(
      `INSERT INTO places_cache (query_hash, query, result, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(query_hash) DO UPDATE SET result = excluded.result, created_at = excluded.created_at`,
    )
      .bind(`place:${r.placeId}`, r.name, JSON.stringify(r), Date.now())
      .run();
  }
  return { results, cached: false };
}

export async function getCachedPlace(db: D1Database, placeId: string): Promise<PlaceResult | null> {
  const row = await db
    .prepare(`SELECT result FROM places_cache WHERE query_hash = ?`)
    .bind(`place:${placeId}`)
    .first<{ result: string }>();
  return row ? (JSON.parse(row.result) as PlaceResult) : null;
}

export class PlacesError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function itineraryCenter(it: Itinerary | null): { lat: number; lng: number } | null {
  const pts = (it?.days ?? []).flatMap((d) => d.activities).filter((a) => a.lat !== null && a.lng !== null);
  if (!pts.length) return null;
  // Median is robust to a single wrong coordinate.
  const lats = pts.map((p) => p.lat as number).sort((a, b) => a - b);
  const lngs = pts.map((p) => p.lng as number).sort((a, b) => a - b);
  return { lat: lats[Math.floor(lats.length / 2)], lng: lngs[Math.floor(lngs.length / 2)] };
}

/**
 * Verify activities against Google Places. Only activities without verified place
 * data are looked up (so unchanged activities never re-bill). Bounded per call.
 */
export async function enrichItinerary(opts: {
  env: Env;
  itinerary: Itinerary;
  destination: string | null;
  attribution: Attribution;
  onlyDays?: number[];
  maxLookups?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ itinerary: Itinerary; lookups: number; verified: number; failed: number }> {
  const { env, itinerary } = opts;
  if (!placesConfigured(env)) return { itinerary, lookups: 0, verified: 0, failed: 0 };
  const center = itineraryCenter(itinerary);
  const targets: Activity[] = [];
  for (const d of itinerary.days) {
    if (opts.onlyDays && !opts.onlyDays.includes(d.dayNumber)) continue;
    for (const a of d.activities) {
      if (!a.place && a.locationName && !SKIP_CATEGORIES.has(a.category) && a.coordSource !== "user") targets.push(a);
    }
  }
  const limited = targets.slice(0, opts.maxLookups ?? 24);
  let verified = 0;
  let failed = 0;
  const queue = [...limited];
  const worker = async () => {
    while (queue.length) {
      const a = queue.shift()!;
      const q = [a.locationName, a.address && a.address.length < 120 ? a.address : null, opts.destination]
        .filter(Boolean)
        .join(", ");
      try {
        const { results } = await searchPlaces({
          env,
          query: q,
          maxResults: 1,
          bias: center ? { ...center, radiusM: 50_000 } : null,
          operation: "place_verify",
          attribution: opts.attribution,
          fetchImpl: opts.fetchImpl,
        });
        const p = results[0];
        // Reject matches implausibly far from the AI estimate / trip centre (wrong-city matches).
        const ref = a.lat !== null && a.lng !== null ? { lat: a.lat, lng: a.lng } : center;
        if (p && (!ref || haversineKm(ref.lat, ref.lng, p.lat, p.lng) < 60)) {
          const { primaryType: _pt, ...place } = p;
          a.place = place;
          a.lat = p.lat;
          a.lng = p.lng;
          a.coordSource = "google_places";
          if (!a.address && p.address) a.address = p.address;
          verified++;
        }
      } catch {
        failed++;
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { itinerary, lookups: limited.length, verified, failed };
}
