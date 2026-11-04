import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTurn, normalizeItinerary } from "../src/worker/services/planner";
import { emptyPreferences } from "../src/shared/schemas";
import {
  Client,
  clarifyTurn,
  errorCompletion,
  generateTurn,
  installFetchMock,
  makeEnv,
  okCompletion,
  patchTurn,
  registerAndLogin,
  type MockState,
} from "./helpers";

let mock: MockState;
beforeEach(() => {
  mock = installFetchMock();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function newTripWithPlan(c: Client) {
  const t = await c.post("/api/trips", {});
  mock.openaiQueue.push(okCompletion(generateTurn(3)));
  const r = await c.post(`/api/trips/${t.json.trip.id}/messages`, { content: "3 days in Tokyo for a family of four" });
  expect(r.status).toBe(200);
  return r.json.trip;
}

describe("trip creation & validation", () => {
  it("guest creates a trip; a secure guest cookie is issued", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const r = await c.fetch("POST", "/api/trips", {});
    expect(r.status).toBe(201);
    expect(r.json.trip.title).toBe("New trip");
    const sc = r.headers.getSetCookie().find((x) => x.startsWith("__Host-tp_guest="))!;
    expect(sc).toMatch(/HttpOnly/i);
    const token = c.cookies.get("__Host-tp_guest")!;
    expect(token.length).toBeGreaterThanOrEqual(43); // 256-bit
    const list = await c.get("/api/trips");
    expect(list.json.trips).toHaveLength(1);
    expect((await c.get(`/api/trips/${r.json.trip.id}`)).json.trip.messages).toEqual([]);
  });

  it("validates trip details", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const t = await c.post("/api/trips", {});
    const id = t.json.trip.id;
    expect((await c.patch(`/api/trips/${id}`, { preferences: { adults: -1 } })).status).toBe(400);
    expect((await c.patch(`/api/trips/${id}`, { preferences: { startDate: "2027-05-10", endDate: "2027-05-01" } })).status).toBe(400);
    expect((await c.patch(`/api/trips/${id}`, { title: "" })).status).toBe(400);
    const ok = await c.patch(`/api/trips/${id}`, { title: "Summer", preferences: { destination: "Rome", startDate: "2027-06-01", endDate: "2027-06-05", budgetCurrency: "EUR" } });
    expect(ok.status).toBe(200);
    expect(ok.json.trip.preferences.durationDays).toBe(5);
    expect(ok.json.trip.destination).toBe("Rome");
  });

  it("rejects oversized messages", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const t = await c.post("/api/trips", {});
    const r = await c.post(`/api/trips/${t.json.trip.id}/messages`, { content: "x".repeat(2001) });
    expect(r.status).toBe(400);
    expect(mock.openaiCalls).toHaveLength(0);
  });
});

describe("itinerary generation & editing", () => {
  it("asks clarifying questions without creating an itinerary", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const t = await c.post("/api/trips", {});
    mock.openaiQueue.push(okCompletion(clarifyTurn()));
    const r = await c.post(`/api/trips/${t.json.trip.id}/messages`, { content: "I want a vacation" });
    expect(r.status).toBe(200);
    expect(r.json.reply.meta.intent).toBe("clarify");
    expect(r.json.trip.itinerary).toBeNull();
    expect(r.json.trip.preferences.interests).toEqual(["food"]);
  });

  it("generates and persists a structured itinerary, verified with Places", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const trip = await newTripWithPlan(c);
    expect(trip.title).toBe("Tokyo Family Adventure");
    expect(trip.itinerary.days).toHaveLength(3);
    expect(trip.itinerary.days[0].date).toBe("2027-04-03");
    expect(trip.itinerary.days[2].date).toBe("2027-04-05");
    expect(trip.itinerary.totalEstimatedCost).toBe(300 + 310 + 320);
    const museum = trip.itinerary.days[0].activities[0];
    expect(museum.place?.source).toBe("google_places");
    expect(museum.coordSource).toBe("google_places");
    // Lunch had no locationName → not looked up, stays unverified.
    expect(trip.itinerary.days[0].activities[1].place).toBeNull();
    expect(mock.placesCalls.length).toBe(6);
    // Reopen: persisted with conversation history.
    const again = await c.get(`/api/trips/${trip.id}`);
    expect(again.json.trip.itinerary).toEqual(trip.itinerary);
    expect(again.json.trip.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    // The LLM request carried the trip context and used the configured model.
    expect(mock.openaiCalls[0].body.model).toBe("gpt-4o-mini");
    expect(mock.openaiCalls[0].body.response_format.type).toBe("json_schema");
  });

  it("requests missing days when the model returns a partial plan", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const t = await c.post("/api/trips", {});
    const partial = generateTurn(3);
    partial.preferenceUpdates.durationDays = 5;
    mock.openaiQueue.push(okCompletion(partial));
    const cont = generateTurn(5);
    cont.itinerary!.days = cont.itinerary!.days.slice(3);
    cont.itinerary!.mode = "patch";
    mock.openaiQueue.push(okCompletion(cont));
    const r = await c.post(`/api/trips/${t.json.trip.id}/messages`, { content: "5 days in Tokyo" });
    expect(r.status).toBe(200);
    expect(r.json.trip.itinerary.days).toHaveLength(5);
    expect(r.json.reply.meta.incomplete).toBe(false);
    expect(mock.openaiCalls).toHaveLength(2);
    expect(mock.openaiCalls[1].body.messages.at(-1).content).toContain("days 4 through 5");
  });

  it("modifies only the requested day and preserves unrelated days exactly", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const trip = await newTripWithPlan(c);
    const placesBefore = mock.placesCalls.length;
    const keep = trip.itinerary.days[1].activities[0].id;
    mock.openaiQueue.push(okCompletion(patchTurn(2, [keep], "Free garden walk")));
    const r = await c.post(`/api/trips/${trip.id}/messages`, { content: "Make day 2 less expensive" });
    expect(r.status).toBe(200);
    const after = r.json.trip.itinerary;
    expect(after.days[0]).toEqual(trip.itinerary.days[0]);
    expect(after.days[2]).toEqual(trip.itinerary.days[2]);
    expect(after.days[1].title).toBe("Cheaper day 2");
    expect(after.days[1].activities.map((a: any) => a.title)).toContain("Free garden walk");
    // Kept activity retains its id and verified place data (same location, no re-lookup).
    const kept = after.days[1].activities.find((a: any) => a.id === keep);
    expect(kept.place).toEqual(trip.itinerary.days[1].activities[0].place);
    expect(r.json.reply.meta.changedDays).toEqual([2]);
    // Only the new activity was looked up.
    expect(mock.placesCalls.length - placesBefore).toBe(1);
    // The model received the current itinerary as context.
    const ctx = mock.openaiCalls.at(-1).body.messages[1].content;
    expect(ctx).toContain(keep);
  });

  it("supports direct edits: reorder, remove, add, with optimistic concurrency", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const trip = await newTripWithPlan(c);
    const it = structuredClone(trip.itinerary);
    const d1 = it.days[0];
    [d1.activities[0], d1.activities[1]] = [d1.activities[1], d1.activities[0]];
    it.days[1].activities.pop();
    it.days[2].activities.push({ ...d1.activities[1], id: "act_custom1", title: "My custom stop", place: null, coordSource: "user" });
    const r = await c.put(`/api/trips/${trip.id}/itinerary`, { baseVersion: trip.itineraryVersion, itinerary: it });
    expect(r.status).toBe(200);
    expect(r.json.trip.itinerary.days[0].activities[0].title).toBe("Lunch 1");
    expect(r.json.trip.itinerary.days[1].activities).toHaveLength(2);
    expect(r.json.trip.itinerary.days[2].activities.at(-1).title).toBe("My custom stop");
    // Stale version is rejected.
    const stale = await c.put(`/api/trips/${trip.id}/itinerary`, { baseVersion: trip.itineraryVersion, itinerary: it });
    expect(stale.status).toBe(409);
  });

  it("does not trust client-forged 'verified' place data", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const trip = await newTripWithPlan(c);
    const it = structuredClone(trip.itinerary);
    it.days[0].activities[1].place = { ...it.days[0].activities[0].place, placeId: "forged-id", name: "Fake Verified", rating: 5 };
    const r = await c.put(`/api/trips/${trip.id}/itinerary`, { baseVersion: trip.itineraryVersion, itinerary: it });
    expect(r.status).toBe(200);
    expect(r.json.trip.itinerary.days[0].activities[1].place).toBeNull();
  });

  it("rejects malformed itinerary edits", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const trip = await newTripWithPlan(c);
    const it = structuredClone(trip.itinerary);
    it.days[0].activities[0].startTime = "25:99";
    expect((await c.put(`/api/trips/${trip.id}/itinerary`, { baseVersion: trip.itineraryVersion, itinerary: it })).status).toBe(400);
  });

  it("rolls back the user message when the LLM fails, and reports a clear error", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const t = await c.post("/api/trips", {});
    mock.openaiQueue.push(errorCompletion(400, "bad"));
    const r = await c.post(`/api/trips/${t.json.trip.id}/messages`, { content: "Plan Paris" });
    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe("LLM_ERROR");
    expect((await c.get(`/api/trips/${t.json.trip.id}`)).json.trip.messages).toHaveLength(0);
  });

  it("deletes trips", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const t = await c.post("/api/trips", {});
    expect((await c.del(`/api/trips/${t.json.trip.id}`)).status).toBe(200);
    expect((await c.get(`/api/trips/${t.json.trip.id}`)).status).toBe(404);
  });
});

describe("authorization", () => {
  it("guests cannot access other guests' trips", async () => {
    const { env: e } = makeEnv();
    const a = new Client(e);
    const b = new Client(e);
    const t = await a.post("/api/trips", {});
    await b.post("/api/trips", {});
    const id = t.json.trip.id;
    expect((await b.get(`/api/trips/${id}`)).status).toBe(404);
    expect((await b.patch(`/api/trips/${id}`, { title: "hijack" })).status).toBe(404);
    expect((await b.post(`/api/trips/${id}/messages`, { content: "hi" })).status).toBe(404);
    expect((await b.del(`/api/trips/${id}`)).status).toBe(404);
    expect((await b.get("/api/trips")).json.trips.map((x: any) => x.id)).not.toContain(id);
    // Forged guest cookie is not accepted.
    const forged = new Client(e);
    forged.cookies.set("__Host-tp_guest", "A".repeat(43));
    expect((await forged.get(`/api/trips/${id}`)).status).toBe(404);
  });

  it("users cannot access other users' trips", async () => {
    const { env: e, sent } = makeEnv();
    const a = new Client(e);
    const b = new Client(e);
    await registerAndLogin(a, sent);
    await registerAndLogin(b, sent);
    const t = await a.post("/api/trips", {});
    const id = t.json.trip.id;
    expect((await b.get(`/api/trips/${id}`)).status).toBe(404);
    expect((await b.put(`/api/trips/${id}/itinerary`, { baseVersion: 0, itinerary: { currency: "USD", overview: "", days: [], assumptions: [], totalEstimatedCost: null, updatedAt: 1 } })).status).toBe(404);
    expect((await b.del(`/api/trips/${id}`)).status).toBe(404);
    expect((await a.get(`/api/trips/${id}`)).status).toBe(200);
    // Signed-out visitor can't see it either.
    expect((await new Client(e).get(`/api/trips/${id}`)).status).toBe(404);
  });

  it("enforces per-actor LLM rate limits server-side", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const t = await c.post("/api/trips", {});
    const codes = [];
    for (let i = 0; i < 7; i++) {
      mock.openaiQueue.push(okCompletion(clarifyTurn()));
      codes.push((await c.post(`/api/trips/${t.json.trip.id}/messages`, { content: `msg ${i}` })).status);
    }
    expect(codes.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(codes[6]).toBe(429);
  });
});

describe("guest-to-account migration", () => {
  it("moves the browser's guest trips into the account on login without duplicates", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    const trip = await newTripWithPlan(c);
    const other = new Client(e);
    const otherTrip = await other.post("/api/trips", {});

    const { user, migrated } = await registerAndLogin(c, sent);
    expect(migrated).toBe(1);
    expect(c.cookies.has("__Host-tp_guest")).toBe(false);
    const mine = await c.get("/api/trips");
    expect(mine.json.trips.map((t: any) => t.id)).toEqual([trip.id]);
    const full = await c.get(`/api/trips/${trip.id}`);
    expect(full.json.trip.messages).toHaveLength(2);
    // Guest usage is attributed to the user.
    const u = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE trip_id = ? AND user_id = ?").bind(trip.id, user.id).first<{ n: number }>();
    expect(u!.n).toBeGreaterThan(0);
    // The other guest's trip was not claimed.
    expect((await other.get(`/api/trips/${otherTrip.json.trip.id}`)).status).toBe(200);
    const owner = await env.DB.prepare("SELECT user_id, guest_id FROM trips WHERE id = ?").bind(otherTrip.json.trip.id).first<any>();
    expect(owner.user_id).toBeNull();
    // Logging in again doesn't duplicate.
    await c.post("/api/auth/logout");
    const again = await c.post("/api/auth/login", { email: full.json.trip ? (await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(user.id).first<any>()).email : "", password: "correct horse battery" });
    expect(again.json.migratedTrips).toBe(0);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM trips WHERE user_id = ?").bind(user.id).first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("a stolen-but-claimed guest cookie can no longer read migrated trips", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    const t = await c.post("/api/trips", {});
    const guestCookie = c.cookies.get("__Host-tp_guest")!;
    await registerAndLogin(c, sent);
    const thief = new Client(e);
    thief.cookies.set("__Host-tp_guest", guestCookie);
    expect((await thief.get(`/api/trips/${t.json.trip.id}`)).status).toBe(404);
  });
});

describe("planner merge logic (unit)", () => {
  it("renumbers days and keeps dates in sync after removing a day", () => {
    const base = applyTurn({ title: "New trip", preferences: emptyPreferences(), itinerary: null }, generateTurn(3));
    const turn = patchTurn(1, [], "x");
    turn.itinerary!.days = [];
    turn.itinerary!.removeDayNumbers = [2];
    const r = applyTurn({ title: "t", preferences: base.preferences, itinerary: base.itinerary }, turn);
    expect(r.itinerary!.days.map((d) => d.dayNumber)).toEqual([1, 2]);
    expect(r.itinerary!.days[1].title).toBe("Day 3 title");
    expect(r.itinerary!.days[1].date).toBe("2027-04-04");
  });

  it("ignores invalid preference values from the model", () => {
    const t = clarifyTurn();
    t.preferenceUpdates.startDate = "next tuesday";
    t.preferenceUpdates.adults = -3;
    t.preferenceUpdates.budgetCurrency = "usd";
    const r = applyTurn({ title: "x", preferences: emptyPreferences(), itinerary: null }, t);
    expect(r.preferences.startDate).toBeNull();
    expect(r.preferences.adults).toBeNull();
    expect(r.preferences.budgetCurrency).toBe("USD");
  });

  it("normalizes totals", () => {
    const base = applyTurn({ title: "New trip", preferences: emptyPreferences(), itinerary: null }, generateTurn(2));
    const n = normalizeItinerary(base.itinerary!, base.preferences);
    expect(n.totalEstimatedCost).toBe(610);
  });
});
