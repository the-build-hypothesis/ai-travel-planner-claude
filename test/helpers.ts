import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as rawEnv } from 'cloudflare:workers';
import { vi } from 'vitest';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/env';

export const BASE = 'https://app.example.test';

export interface SentEmail {
  to: string;
  subject: string;
  text?: string;
  from: unknown;
}

export const outbox: SentEmail[] = [];
export const emailControl = { fail: false };

const fakeEmail = {
  async send(message: SentEmail) {
    if (emailControl.fail) throw Object.assign(new Error('boom'), { code: 'E_DELIVERY_FAILED' });
    outbox.push(message);
    return { messageId: 'test-message' };
  },
};

export const testEnv: Env = {
  ...(rawEnv as unknown as Env),
  // Spread alone can drop binding objects, so the database is carried over explicitly.
  DB: (rawEnv as unknown as Env).DB,
  EMAIL: fakeEmail as unknown as Env['EMAIL'],
  ASSETS: { fetch: async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }) } as unknown as Fetcher,
};

let ipCounter = 0;

/** A browser-like client: it keeps its own cookie jar and sends a same-origin Origin header. */
export class Client {
  cookies = new Map<string, string>();
  ip = `203.0.113.${++ipCounter % 250}-${Math.random().toString(36).slice(2, 8)}`;
  constructor(public envOverride: Partial<Env> = {}) {}

  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const h: Record<string, string> = { 'cf-connecting-ip': this.ip, origin: BASE, ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['content-type'] = 'application/json';
    const req = new Request(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req as any, { ...testEnv, ...this.envOverride }, ctx);
    // Reading the body first lets streaming handlers finish before waitUntil work is awaited.
    const buffered = new Response(await res.arrayBuffer(), res);
    await waitOnExecutionContext(ctx);
    for (const cookie of res.headers.getSetCookie()) {
      const [pair, ...attrs] = cookie.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      const expired = attrs.some((a) => /max-age=0/i.test(a)) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return buffered;
  }

  async json<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; data: T; res: Response }> {
    const res = await this.raw(method, path, body, headers);
    const text = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, res };
  }

  /** Sends a chat message and returns the parsed server-sent events. */
  async sse(path: string, body: unknown): Promise<any[]> {
    const res = await this.raw('POST', path, body);
    const text = await res.text();
    if (!res.ok) throw new Error(`SSE request failed ${res.status}: ${text}`);
    return text
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice(6)));
  }
}

export function sseBody(content: string, usage = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 0 } }, finishReason = 'stop'): string {
  const chunks = [
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: finishReason }] },
    { choices: [], usage },
    '[DONE]',
  ];
  return chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
}

export function turn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'chat',
    reply: 'Sounds good.',
    trip_updates: {
      title: null, destination: null, start_date: null, end_date: null, duration_days: null, adults: null,
      children_ages: null, budget_amount: null, currency: null, interests: null, pace: null, constraints: null, lodging: null,
    },
    edits: [],
    research_queries: [],
    suggestions: [],
    show_map: false,
    ...overrides,
  };
}

export function aiActivity(title: string, start = '09:00', overrides: Record<string, unknown> = {}) {
  return {
    start_time: start,
    duration_minutes: 90,
    title,
    category: 'sight',
    description: `${title} description`,
    location_name: title,
    place_query: `${title}, Tokyo`,
    approx_lat: 35.68,
    approx_lng: 139.76,
    est_cost: 20,
    cost_note: null,
    transit_from_previous: null,
    tip: null,
    ...overrides,
  };
}

export function aiOp(op: string, fields: Record<string, unknown> = {}) {
  return { op, activity_id: null, day_number: null, to_day_number: null, after_activity_id: null, start_time: null, activity: null, changes: null, instructions: null, ...fields };
}

export interface MockCalls {
  llm: any[];
  places: any[];
  photos: string[];
}

/**
 * Replaces global fetch. LLM calls are answered by `llm`, which picks a response from the schema
 * name in the request. Any other outbound URL fails the test, so nothing can reach a real API.
 */
export function mockExternal(llm: (body: any, call: number) => unknown | Response, places?: (body: any) => unknown | Response): MockCalls {
  const calls: MockCalls = { llm: [], places: [], photos: [] };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('https://api.openai.com/')) {
      const body = JSON.parse(String(init?.body));
      calls.llm.push({ ...body, headers: init?.headers });
      const out = llm(body, calls.llm.length);
      if (out instanceof Response) return out;
      return new Response(sseBody(typeof out === 'string' ? out : JSON.stringify(out)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes('places:searchText')) {
      const body = JSON.parse(String(init?.body));
      calls.places.push(body);
      const out = places ? places(body) : defaultPlaces(body);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://places.googleapis.com/v1/places/') && url.includes('/media')) {
      calls.photos.push(url);
      return new Response('jpeg-bytes', { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    throw new Error(`Unexpected outbound request in test: ${url}`);
  });
  return calls;
}

export function defaultPlaces(body: any) {
  return {
    places: [
      {
        id: `place-${body.textQuery}`,
        displayName: { text: String(body.textQuery).split(',')[0] },
        formattedAddress: '1 Test St, Tokyo',
        location: { latitude: 35.69, longitude: 139.77 },
        rating: 4.5,
        userRatingCount: 1200,
        priceLevel: 'PRICE_LEVEL_MODERATE',
        regularOpeningHours: { weekdayDescriptions: ['Monday: 9:00 AM – 5:00 PM'] },
        websiteUri: 'https://example.test',
        googleMapsUri: 'https://maps.example.test/place',
        primaryTypeDisplayName: { text: 'Tourist attraction' },
        photos: [{ name: 'places/abc/photos/def', authorAttributions: [{ displayName: 'A Photographer' }] }],
      },
    ],
  };
}

/** A complete scripted generation for an itinerary, keyed on which schema each call asks for. */
export function plannerLlm(opts: { turn: Record<string, unknown>; days?: number }) {
  return (body: any) => {
    const name = body.response_format?.json_schema?.name;
    if (name === 'planner_turn') return opts.turn;
    if (name === 'itinerary_outline') {
      return {
        overview: 'A compact plan.',
        tips: ['Carry a transit card.'],
        days: Array.from({ length: opts.days ?? 2 }, (_, i) => ({ title: `Theme ${i + 1}`, area: `Area ${i + 1}`, focus: 'Focus', anchors: [`Anchor ${i + 1}`] })),
      };
    }
    if (name === 'itinerary_day') {
      const match = /Write day (\d+)/.exec(body.messages.at(-1).content);
      if (!match) return { title: 'New day', area: 'Somewhere', summary: 'Summary', transport_notes: null, activities: [aiActivity('Regenerated stop', '10:00')] };
      const n = match[1];
      return { title: `Day title ${n}`, area: `Area ${n}`, summary: 'Summary', transport_notes: null, activities: [aiActivity(`Museum ${n}`, '09:00'), aiActivity(`Lunch ${n}`, '12:00', { category: 'food' })] };
    }
    if (name === 'destination_ideas') {
      return { intro: 'Some ideas', ideas: [{ destination: 'Lisbon', country: 'Portugal', why: 'Sunny', best_for: 'Couples', starter_prompt: 'Plan Lisbon' }] };
    }
    throw new Error(`Unexpected schema in test: ${name}`);
  };
}

export function eventsOf(events: any[], type: string) {
  return events.filter((e) => e.type === type);
}

export function tokenFromEmail(email: SentEmail): string {
  const match = /token=([A-Za-z0-9_%-]+)/.exec(email.text ?? '');
  if (!match) throw new Error(`No token in email: ${email.subject}`);
  return decodeURIComponent(match[1]);
}

let userCounter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}.${Date.now()}.${++userCounter}@example.test`;

/** Registers, verifies and logs in through the real endpoints. */
export async function registerAndLogin(client: Client, email = uniqueEmail(), password = 'correct horse battery') {
  const reg = await client.json('POST', '/api/auth/register', { email, password });
  if (reg.status !== 202) throw new Error(`register failed: ${JSON.stringify(reg.data)}`);
  const message = [...outbox].reverse().find((m) => m.to === email);
  if (!message) throw new Error('no verification email');
  const verified = await client.json('POST', '/api/auth/verify-email', { token: tokenFromEmail(message) });
  if (verified.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verified.data)}`);
  const login = await client.json('POST', '/api/auth/login', { email, password });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.data)}`);
  return { email, password, user: login.data.user, claimedTrips: login.data.claimedTrips };
}

export const ADMIN_PASSWORD = 'a-long-admin-passphrase-1';

/** Takes the bootstrap admin through its forced password change, once per test file. */
export async function activatedAdmin(): Promise<Client> {
  const client = new Client();
  const row = await testEnv.DB.prepare("SELECT must_change_password FROM admins WHERE username = 'admin'").first<{ must_change_password: number }>();
  if (row?.must_change_password) {
    await client.json('POST', '/api/admin/login', { username: 'admin', password: 'admin' });
    const changed = await client.json('POST', '/api/admin/change-password', { current_password: 'admin', new_password: ADMIN_PASSWORD });
    if (changed.status !== 200) throw new Error(`admin activation failed: ${JSON.stringify(changed.data)}`);
    return client;
  }
  const login = await client.json('POST', '/api/admin/login', { username: 'admin', password: ADMIN_PASSWORD });
  if (login.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(login.data)}`);
  return client;
}
