import type { Activity, Day, Itinerary } from '../shared/schemas';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

async function toError(res: Response): Promise<ApiError> {
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* A non-JSON failure gets the generic message below. */
  }
  const fallback = res.status === 429 ? 'Too many requests. Please wait a moment and try again.' : 'Something went wrong. Please try again.';
  return new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? fallback, data?.error?.fields ?? {});
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'NETWORK', "We couldn't reach the server. Check your connection and try again.");
  }
  if (!res.ok) throw await toError(res);
  return res.json() as Promise<T>;
}

export interface Trip {
  id: string;
  title: string | null;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  duration_days: number | null;
  adults: number | null;
  children_ages: number[];
  budget_amount: number | null;
  currency: string;
  interests: string[];
  pace: string | null;
  constraints: string | null;
  lodging: string | null;
  dest_lat: number | null;
  dest_lng: number | null;
  has_cover: boolean;
  cover_attribution: string | null;
  itinerary: Itinerary;
  day_count: number;
  created_at: string;
  updated_at: string;
}

export type TripSummary = Omit<Trip, 'itinerary'> & { stop_count: number };

export interface PlaceCard {
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
  query?: string;
}

export interface ChangeEntry {
  type: string;
  label: string;
  day_number?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  meta?: {
    changes?: ChangeEntry[];
    notes?: string[];
    places?: PlaceCard[];
    suggestions?: string[];
  } | null;
}

export type PlannerEvent =
  | { type: 'status'; message: string }
  | { type: 'reply_delta'; text: string }
  | { type: 'trip'; trip: Trip }
  | { type: 'outline'; days: { day_number: number; title: string; area: string }[] }
  | { type: 'day'; day: Day }
  | { type: 'show_map' }
  | { type: 'done'; message: ChatMessage; trip: Trip }
  | { type: 'error'; code: string; message: string; trip?: Trip };

/** POSTs and reads the server-sent event stream. A dropped connection is reported as an error event. */
export async function streamPlanner(path: string, body: unknown, onEvent: (e: PlannerEvent) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'NETWORK', "We couldn't reach the server. Check your connection and try again.");
  }
  if (!res.ok) throw await toError(res);
  if (!res.body) throw new ApiError(0, 'NETWORK', 'The response was empty. Please try again.');
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        if (!chunk.startsWith('data: ')) continue;
        const event = JSON.parse(chunk.slice(6)) as PlannerEvent;
        if (event.type === 'done' || event.type === 'error') finished = true;
        onEvent(event);
      }
    }
  } catch {
    /* Handled by the check below. */
  }
  if (!finished) {
    onEvent({ type: 'error', code: 'CONNECTION_LOST', message: 'The connection dropped before the assistant finished. Your trip has been refreshed with whatever was saved.' });
  }
}

export function tripName(trip: Pick<Trip, 'title' | 'destination'>): string {
  return trip.title ?? (trip.destination ? `Trip to ${trip.destination}` : 'New trip');
}

export function money(amount: number | null | undefined, currency: string): string {
  if (amount == null) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
}

export function formatDate(date: string | null, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  if (!date) return '';
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

export function formatTime(time: string | null): string {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function formatDuration(minutes: number | null): string {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ');
}

export type { Activity, Day, Itinerary };
