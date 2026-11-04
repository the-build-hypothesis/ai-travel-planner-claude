import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import type { Env } from "../src/worker/env";
import worker from "../src/worker/index";
import type { LlmTurn } from "../src/shared/schemas";

export const BASE = "https://travel.example.com";

export interface SentEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export function makeEnv(overrides: Partial<Env> = {}): { env: Env; sent: SentEmail[] } {
  const sent: SentEmail[] = [];
  const EMAIL = {
    async send(msg: any) {
      sent.push({ to: String(msg.to), subject: msg.subject, html: msg.html, text: msg.text });
      return { messageId: `msg-${sent.length}` };
    },
  } as unknown as SendEmail;
  return { env: { ...(env as unknown as Env), EMAIL, ...overrides }, sent };
}

/** Minimal browser-like client with a cookie jar. */
export class Client {
  cookies = new Map<string, string>();
  constructor(
    public env: Env,
    public ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  ) {}

  async fetch(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = {
      "cf-connecting-ip": this.ip,
      origin: BASE,
      "x-requested-with": "fetch",
      ...extraHeaders,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const req = new Request(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, this.env, ctx);
    await waitOnExecutionContext(ctx);
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim())) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }
  get = (p: string) => this.fetch("GET", p);
  post = (p: string, b: unknown = {}) => this.fetch("POST", p, b);
  put = (p: string, b: unknown) => this.fetch("PUT", p, b);
  patch = (p: string, b: unknown) => this.fetch("PATCH", p, b);
  del = (p: string, b?: unknown) => this.fetch("DELETE", p, b);
}

export function uniqueEmail(prefix = "user") {
  return `${prefix}.${crypto.randomUUID().slice(0, 8)}@Example.com`;
}

export function tokenFromEmail(e: SentEmail): string {
  const m = e.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("no token in email");
  return m[1];
}

export async function registerAndLogin(client: Client, sent: SentEmail[], email = uniqueEmail(), password = "correct horse battery") {
  const r = await client.post("/api/auth/register", { email, password });
  if (r.status !== 200) throw new Error(`register failed ${r.status} ${JSON.stringify(r.json)}`);
  const l = await client.post("/api/auth/login", { email, password });
  if (l.status !== 200) throw new Error(`login failed ${l.status} ${JSON.stringify(l.json)}`);
  return { email, password, user: l.json.user, migrated: l.json.migratedTrips, verifyEmail: sent[sent.length - 1] };
}

// ───────────────────────── External API mocks ─────────────────────────

export interface MockState {
  openaiCalls: any[];
  placesCalls: any[];
  openaiQueue: Array<(body: any) => Response>;
}

export function okCompletion(turn: unknown, usage = { prompt_tokens: 1200, completion_tokens: 800, cached: 200 }, model = "gpt-4o-mini-2024-07-18") {
  return () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(turn), refusal: null } }],
        usage: {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          prompt_tokens_details: { cached_tokens: usage.cached },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

export function errorCompletion(status: number, message = "boom") {
  return () => new Response(JSON.stringify({ error: { message, type: "server_error" } }), { status, headers: { "content-type": "application/json" } });
}

export function installFetchMock(): MockState {
  const state: MockState = { openaiCalls: [], placesCalls: [], openaiQueue: [] };
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.startsWith("https://api.openai.com/")) {
      state.openaiCalls.push({ url, body, headers: init?.headers });
      const next = state.openaiQueue.shift();
      if (!next) return errorCompletion(500, "no mock queued")();
      return next(body);
    }
    if (url.startsWith("https://places.googleapis.com/")) {
      state.placesCalls.push({ url, body, headers: init?.headers });
      const q = String(body?.textQuery ?? "");
      return new Response(
        JSON.stringify({
          places: [
            {
              id: `place-${q.replace(/[^a-z0-9]/gi, "").slice(0, 20)}`,
              displayName: { text: q.split(",")[0] },
              formattedAddress: `1 Test St, ${q}`,
              location: { latitude: 35.68 + Math.random() * 0.01, longitude: 139.76 + Math.random() * 0.01 },
              rating: 4.5,
              userRatingCount: 1200,
              regularOpeningHours: { weekdayDescriptions: ["Monday: 9:00 AM – 5:00 PM"] },
              businessStatus: "OPERATIONAL",
              googleMapsUri: "https://maps.google.com/?cid=1",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected outbound fetch: ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return state;
}

// ───────────────────────── Fixture LLM turns ─────────────────────────

const act = (id: string | null, title: string, time: string, loc: string | null, cost: number | null, lat = 35.7, lng = 139.7) => ({
  id,
  title,
  category: "sight" as const,
  startTime: time,
  durationMinutes: 90,
  locationName: loc,
  address: null,
  description: `${title} description`,
  tips: null,
  costAmount: cost,
  costPer: "person" as const,
  costNote: null,
  lat,
  lng,
  transportToNext: "10 min walk",
  bookingRecommended: false,
});

const prefsNull = {
  destination: null,
  startDate: null,
  endDate: null,
  durationDays: null,
  adults: null,
  children: null,
  childAges: null,
  budgetAmount: null,
  budgetCurrency: null,
  budgetNotes: null,
  interests: null,
  pace: null,
  lodging: null,
  requirements: null,
};

export function generateTurn(days = 3): LlmTurn {
  return {
    reply: "Here's a 3-day plan for Tokyo!",
    intent: "generate",
    tripTitle: "Tokyo Family Adventure",
    preferenceUpdates: { ...prefsNull, destination: "Tokyo, Japan", durationDays: days, adults: 2, children: 2, childAges: [10, 14], budgetAmount: 5000, budgetCurrency: "USD", interests: ["technology", "food"], startDate: "2027-04-03" },
    itinerary: {
      mode: "replace_all",
      currency: "USD",
      overview: "A fun family trip",
      assumptions: ["Prices are estimates"],
      removeDayNumbers: [],
      days: Array.from({ length: days }, (_, i) => ({
        dayNumber: i + 1,
        title: `Day ${i + 1} title`,
        area: "Shibuya",
        summary: `Summary ${i + 1}`,
        estimatedDayCost: 300 + i * 10,
        activities: [
          act(null, `Museum ${i + 1}`, "09:00", `Museum ${i + 1}`, 20),
          act(null, `Lunch ${i + 1}`, "12:30", null, 15),
          act(null, `Park ${i + 1}`, "14:30", `Park ${i + 1}`, 0),
        ],
      })),
    },
    suggestions: ["Make day 2 cheaper"],
  };
}

export function patchTurn(dayNumber: number, keepIds: string[], newTitle: string): LlmTurn {
  return {
    reply: `Updated day ${dayNumber}.`,
    intent: "modify",
    tripTitle: null,
    preferenceUpdates: { ...prefsNull },
    itinerary: {
      mode: "patch",
      currency: null,
      overview: null,
      assumptions: null,
      removeDayNumbers: [],
      days: [
        {
          dayNumber,
          title: `Cheaper day ${dayNumber}`,
          area: "Asakusa",
          summary: "Budget-friendly",
          estimatedDayCost: 120,
          activities: [...keepIds.map((id, i) => ({ ...act(id, `Kept ${i}`, `0${8 + i}:00`, `Museum ${dayNumber}`, 10) })), act(null, newTitle, "16:00", "Garden X", 5)],
        },
      ],
    },
    suggestions: [],
  };
}

export function clarifyTurn(): LlmTurn {
  return {
    reply: "Where would you like to go, and for how many days?",
    intent: "clarify",
    tripTitle: null,
    preferenceUpdates: { ...prefsNull, interests: ["food"] },
    itinerary: null,
    suggestions: ["5 days in Lisbon"],
  };
}
