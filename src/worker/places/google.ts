import type { Env, Principal } from '../env';
import { sha256 } from '../lib/crypto';
import { nowIso, parseJsonColumn } from '../lib/http';
import { hit } from '../lib/rateLimit';
import { getSettings } from '../lib/settings';
import { recordPlacesUsage, type Attribution } from '../usage/record';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const SEARCH_ENDPOINT = 'places:searchText';
const SEARCH_SKU = 'places.text_search_enterprise';
const PHOTO_SKU = 'places.photo';
const CACHE_DAYS = 30;

// rating, priceLevel, regularOpeningHours and websiteUri put this mask on the Text Search Enterprise SKU.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.regularOpeningHours.weekdayDescriptions',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.primaryTypeDisplayName',
  'places.businessStatus',
  'places.photos.name',
  'places.photos.authorAttributions.displayName',
].join(',');

export interface PlaceResult {
  place_id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  rating_count: number | null;
  price_level: string | null;
  opening_hours: string[] | null;
  website: string | null;
  maps_url: string | null;
  type_label: string | null;
  photo_name: string | null;
  photo_attribution: string | null;
  business_status: string | null;
}

export type PlacesOutcome =
  | { status: 'ok'; results: PlaceResult[]; cached: boolean }
  | { status: 'unavailable' | 'quota' | 'error' };

const PRICE_LABELS: Record<string, string> = {
  PRICE_LEVEL_FREE: 'Free',
  PRICE_LEVEL_INEXPENSIVE: '$',
  PRICE_LEVEL_MODERATE: '$$',
  PRICE_LEVEL_EXPENSIVE: '$$$',
  PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
};

export function normalizePlace(raw: any): PlaceResult {
  return {
    place_id: String(raw.id ?? ''),
    name: raw.displayName?.text ?? 'Unnamed place',
    address: raw.formattedAddress ?? null,
    lat: raw.location?.latitude ?? null,
    lng: raw.location?.longitude ?? null,
    rating: raw.rating ?? null,
    rating_count: raw.userRatingCount ?? null,
    price_level: PRICE_LABELS[raw.priceLevel] ?? null,
    opening_hours: raw.regularOpeningHours?.weekdayDescriptions ?? null,
    website: raw.websiteUri ?? null,
    maps_url: raw.googleMapsUri ?? null,
    type_label: raw.primaryTypeDisplayName?.text ?? null,
    photo_name: raw.photos?.[0]?.name ?? null,
    photo_attribution: raw.photos?.[0]?.authorAttributions?.[0]?.displayName ?? null,
    business_status: raw.businessStatus ?? null,
  };
}

export function placesConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_MAPS_API_KEY);
}

async function withinQuota(env: Env, principal: Principal | null): Promise<boolean> {
  if (!principal) return true;
  const settings = await getSettings(env.DB);
  const max = principal.type === 'guest' ? settings.guest_places_requests_per_day : settings.user_places_requests_per_day;
  const { allowed } = await hit(env.DB, { scope: 'places_day', id: `${principal.type}:${principal.id}`, max, windowSeconds: 86_400 });
  return allowed;
}

export interface SearchOptions {
  query: string;
  pageSize: number;
  bias?: { lat: number; lng: number } | null;
  attribution: Attribution;
  operation: string;
}

async function cacheKey(opts: Pick<SearchOptions, 'query' | 'pageSize' | 'bias'>): Promise<string> {
  const bias = opts.bias ? `${opts.bias.lat.toFixed(1)},${opts.bias.lng.toFixed(1)}` : '';
  return sha256(`${opts.query.trim().toLowerCase()}|${opts.pageSize}|${bias}`);
}

export async function cachedSearch(env: Env, opts: Pick<SearchOptions, 'query' | 'pageSize' | 'bias'>): Promise<PlaceResult[] | null> {
  const row = await env.DB.prepare('SELECT result, fetched_at FROM place_cache WHERE cache_key = ?')
    .bind(await cacheKey(opts))
    .first<{ result: string; fetched_at: string }>();
  if (!row || Date.now() - Date.parse(row.fetched_at) > CACHE_DAYS * 86_400_000) return null;
  return parseJsonColumn<PlaceResult[] | null>(row.result, null);
}

/** Runs a Text Search. Cache hits are free and create no usage record, because nothing is billed. */
export async function searchPlaces(env: Env, opts: SearchOptions): Promise<PlacesOutcome> {
  if (!placesConfigured(env)) return { status: 'unavailable' };
  const cached = await cachedSearch(env, opts);
  if (cached) return { status: 'ok', results: cached, cached: true };
  if (!(await withinQuota(env, opts.attribution.principal))) return { status: 'quota' };

  const body: Record<string, unknown> = { textQuery: opts.query, pageSize: opts.pageSize };
  if (opts.bias) {
    body.locationBias = { circle: { center: { latitude: opts.bias.lat, longitude: opts.bias.lng }, radius: 50_000 } };
  }
  const started = Date.now();
  const common = { attribution: opts.attribution, operation: opts.operation, endpoint: SEARCH_ENDPOINT, sku: SEARCH_SKU };
  try {
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY!,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text();
      await recordPlacesUsage(env.DB, {
        ...common,
        status: 'error',
        httpStatus: res.status,
        durationMs: Date.now() - started,
        billableUnits: 0,
        errorCode: `http_${res.status}`,
        errorMessage: detail,
      });
      return { status: 'error' };
    }
    const data = (await res.json()) as { places?: unknown[] };
    const results = (data.places ?? []).map(normalizePlace).filter((p) => p.place_id);
    await recordPlacesUsage(env.DB, { ...common, status: 'success', httpStatus: res.status, durationMs: Date.now() - started, billableUnits: 1 });
    await env.DB.prepare('INSERT OR REPLACE INTO place_cache (cache_key, result, fetched_at) VALUES (?,?,?)')
      .bind(await cacheKey(opts), JSON.stringify(results), nowIso())
      .run();
    return { status: 'ok', results, cached: false };
  } catch (err) {
    await recordPlacesUsage(env.DB, {
      ...common,
      status: 'error',
      durationMs: Date.now() - started,
      billableUnits: 0,
      errorCode: (err as Error).name === 'TimeoutError' ? 'timeout' : 'network',
      errorMessage: (err as Error).message,
    });
    return { status: 'error' };
  }
}

/** Fetches a Place photo through the Worker so the API key never reaches the browser. */
export async function fetchPlacePhoto(env: Env, photoName: string, attribution: Attribution, ctx: ExecutionContext): Promise<Response | null> {
  if (!placesConfigured(env) || !/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(photoName)) return null;
  // The edge cache means a re-viewed photo is not billed again.
  const cacheUrl = new Request(`https://photo-cache.internal/${photoName}`);
  const cache = (caches as unknown as { default: Cache }).default;
  const hitResponse = await cache.match(cacheUrl);
  if (hitResponse) return hitResponse;
  if (!(await withinQuota(env, attribution.principal))) return null;

  const started = Date.now();
  const common = { attribution, operation: 'place_photo', endpoint: 'places.photos.media', sku: PHOTO_SKU };
  try {
    const res = await fetch(`https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=1200`, {
      headers: { 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY! },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok || !res.body) {
      await recordPlacesUsage(env.DB, { ...common, status: 'error', httpStatus: res.status, durationMs: Date.now() - started, billableUnits: 0, errorCode: `http_${res.status}` });
      return null;
    }
    await recordPlacesUsage(env.DB, { ...common, status: 'success', httpStatus: res.status, durationMs: Date.now() - started, billableUnits: 1 });
    const out = new Response(res.body, {
      headers: { 'Content-Type': res.headers.get('content-type') ?? 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
    });
    ctx.waitUntil(cache.put(cacheUrl, out.clone()));
    return out;
  } catch (err) {
    await recordPlacesUsage(env.DB, { ...common, status: 'error', durationMs: Date.now() - started, billableUnits: 0, errorCode: 'network', errorMessage: (err as Error).message });
    return null;
  }
}
