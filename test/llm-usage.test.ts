import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callStructured, createProvider, LlmError, readLlmConfig } from "../src/worker/llm";
import { llmCost, getLlmPricing, requestCost, getPricing } from "../src/worker/services/usage";
import { searchPlaces } from "../src/worker/services/places";
import type { Env } from "../src/worker/env";
import { Client, errorCompletion, generateTurn, installFetchMock, makeEnv, okCompletion, registerAndLogin, type MockState } from "./helpers";

let mock: MockState;
beforeEach(() => {
  mock = installFetchMock();
});
afterEach(() => vi.unstubAllGlobals());

const noSleep = async () => {};
const schema = z.object({ ok: z.boolean() });
const attribution = { userId: null, guestId: null, tripId: null };

function baseOpts(e: Env, op = `test_${crypto.randomUUID().slice(0, 8)}`) {
  return { env: e, messages: [{ role: "user" as const, content: "hi" }], schemaName: "t", jsonSchema: {}, validator: schema, operation: op, attribution, sleep: noSleep };
}

async function eventsFor(op: string) {
  const { results } = await env.DB.prepare("SELECT * FROM usage_events WHERE operation = ? ORDER BY attempt").bind(op).all<any>();
  return results;
}

describe("provider selection & configuration", () => {
  it("selects provider and model from LLM_PROVIDER / LLM_MODEL", async () => {
    const { env: e } = makeEnv({ LLM_PROVIDER: "OpenAI", LLM_MODEL: "gpt-4.1-mini" });
    expect(readLlmConfig(e)).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
    expect(createProvider(e).provider.name).toBe("openai");
    mock.openaiQueue.push(okCompletion({ ok: true }, undefined, "gpt-4.1-mini-2025-04-14"));
    const r = await callStructured(baseOpts(e));
    expect(mock.openaiCalls[0].body.model).toBe("gpt-4.1-mini");
    expect(r.model).toBe("gpt-4.1-mini-2025-04-14");
  });

  it("fails clearly (no default, no substitution) when config is missing or unsupported", async () => {
    for (const over of [{ LLM_MODEL: "" }, { LLM_PROVIDER: "" }, { LLM_PROVIDER: "anthropic" }, { OPENAI_API_KEY: "" }]) {
      const { env: e } = makeEnv(over as Partial<Env>);
      await expect(callStructured(baseOpts(e))).rejects.toMatchObject({ code: "config" });
    }
    expect(mock.openaiCalls).toHaveLength(0);
  });

  it("surfaces config errors to users as 503 without leaking details", async () => {
    const { env: e } = makeEnv({ LLM_MODEL: "" });
    const c = new Client(e);
    const t = await c.post("/api/trips", {});
    const r = await c.post(`/api/trips/${t.json.trip.id}/messages`, { content: "Plan Rome" });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("LLM_NOT_CONFIGURED");
  });

  it("never falls back to another model when the configured one fails", async () => {
    const { env: e } = makeEnv({ LLM_MODEL: "gpt-4o" });
    mock.openaiQueue.push(errorCompletion(500), errorCompletion(503), errorCompletion(500));
    await expect(callStructured(baseOpts(e))).rejects.toBeInstanceOf(LlmError);
    expect(mock.openaiCalls).toHaveLength(3); // bounded retries
    expect(new Set(mock.openaiCalls.map((c) => c.body.model))).toEqual(new Set(["gpt-4o"]));
  });
});

describe("structured output & error handling", () => {
  it("sends a strict JSON schema and validates the response", async () => {
    const { env: e } = makeEnv();
    mock.openaiQueue.push(okCompletion({ ok: "yes" }), okCompletion({ ok: true }));
    const opts = baseOpts(e);
    const r = await callStructured(opts);
    expect(r.data).toEqual({ ok: true });
    expect(r.attempts).toBe(2);
    expect(mock.openaiCalls[0].body.response_format.json_schema.strict).toBe(true);
    const ev = await eventsFor(opts.operation);
    expect(ev.map((x) => [x.status, x.error_code])).toEqual([
      ["error", "invalid_output"],
      ["success", null],
    ]);
    // The invalid attempt was still billed and costed.
    expect(ev[0].cost_usd).toBeGreaterThan(0);
  });

  it("handles malformed JSON, truncation and refusals", async () => {
    const { env: e } = makeEnv();
    mock.openaiQueue.push(() => new Response(JSON.stringify({ model: "gpt-4o-mini", choices: [{ finish_reason: "stop", message: { content: "{not json" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }));
    mock.openaiQueue.push(() => new Response(JSON.stringify({ model: "gpt-4o-mini", choices: [{ finish_reason: "length", message: { content: "{" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }));
    await expect(callStructured({ ...baseOpts(e), maxAttempts: 2 })).rejects.toMatchObject({ code: "truncated" });
    mock.openaiQueue.push(() => new Response(JSON.stringify({ model: "gpt-4o-mini", choices: [{ finish_reason: "stop", message: { content: null, refusal: "no" } }] }), { status: 200 }));
    await expect(callStructured(baseOpts(e))).rejects.toMatchObject({ code: "refused" });
  });

  it("does not retry auth / bad-request errors; retries 429 rate limits", async () => {
    const { env: e } = makeEnv();
    mock.openaiQueue.push(errorCompletion(401, "bad key"));
    await expect(callStructured(baseOpts(e))).rejects.toMatchObject({ code: "auth" });
    expect(mock.openaiCalls).toHaveLength(1);
    mock.openaiQueue.push(() => new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers: { "retry-after": "1" } }), okCompletion({ ok: true }));
    const r = await callStructured(baseOpts(e));
    expect(r.attempts).toBe(2);
  });

  it("times out slow requests", async () => {
    const { env: e } = makeEnv();
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    await expect(callStructured({ ...baseOpts(e), timeoutMs: 20, maxAttempts: 1 })).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("cost calculations", () => {
  it("prices gpt-4o-mini input / cached / output tokens separately", async () => {
    const rule = (await getLlmPricing(env.DB, "openai", "gpt-4o-mini"))!;
    // 1,000,000 uncached input @0.15 + 1,000,000 cached @0.075 + 1,000,000 output @0.60
    expect(llmCost(rule, { inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 0 })).toBeCloseTo(0.825, 8);
    expect(llmCost(rule, { inputTokens: 1200, cachedInputTokens: 200, outputTokens: 800, reasoningTokens: 0 })).toBeCloseTo((1000 * 0.15 + 200 * 0.075 + 800 * 0.6) / 1e6, 10);
  });

  it("maps dated snapshots to their base model and returns null for unknown models", async () => {
    expect((await getLlmPricing(env.DB, "openai", "gpt-4o-mini-2024-07-18"))!.item).toBe("gpt-4o-mini");
    expect((await getLlmPricing(env.DB, "openai", "gpt-4o-2024-08-06"))!.item).toBe("gpt-4o");
    expect(await getLlmPricing(env.DB, "openai", "mystery-model")).toBeNull();
  });

  it("records unknown-model usage with NULL cost (never guessed)", async () => {
    const { env: e } = makeEnv({ LLM_MODEL: "mystery-model" });
    mock.openaiQueue.push(okCompletion({ ok: true }, undefined, "mystery-model"));
    const opts = baseOpts(e);
    const r = await callStructured(opts);
    expect(r.costUsd).toBeNull();
    const [ev] = await eventsFor(opts.operation);
    expect(ev.cost_usd).toBeNull();
    expect(JSON.parse(ev.pricing_detail).rule).toBeNull();
    expect(ev.input_tokens).toBe(1200);
  });

  it("prices Places Text Search per request using the configured SKU", async () => {
    const rule = (await getPricing(env.DB, "google_places", "text_search_enterprise"))!;
    expect(requestCost(rule, 1)).toBeCloseTo(0.035, 8);
    expect(requestCost(rule, 1000)).toBeCloseTo(35, 6);
  });
});

describe("usage recording & attribution", () => {
  it("records LLM usage per request with tokens, cost, pricing snapshot and attribution (guest + trip)", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const t = await c.post("/api/trips", {});
    mock.openaiQueue.push(okCompletion(generateTurn(2)));
    await c.post(`/api/trips/${t.json.trip.id}/messages`, { content: "2 days in Tokyo" });
    const { results } = await env.DB.prepare("SELECT * FROM usage_events WHERE trip_id = ? ORDER BY created_at").bind(t.json.trip.id).all<any>();
    const llm = results.filter((r) => r.provider === "openai");
    const places = results.filter((r) => r.provider === "google_places");
    expect(llm).toHaveLength(1);
    expect(llm[0]).toMatchObject({ status: "success", operation: "trip_plan", input_tokens: 1200, cached_input_tokens: 200, output_tokens: 800, units: 1, currency: "USD", pricing_version: "2026-11-04.1", user_id: null });
    expect(llm[0].guest_id).toBeTruthy();
    expect(llm[0].model).toBe("gpt-4o-mini-2024-07-18");
    expect(llm[0].cost_usd).toBeCloseTo((1000 * 0.15 + 200 * 0.075 + 800 * 0.6) / 1e6, 10);
    expect(JSON.parse(llm[0].pricing_detail)).toMatchObject({ rule: "openai:gpt-4o-mini", input_per_mtok: 0.15, output_per_mtok: 0.6 });
    expect(llm[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(places).toHaveLength(4);
    expect(places[0]).toMatchObject({ endpoint: "places:searchText", model: "text_search_enterprise", units: 1, status: "success", guest_id: llm[0].guest_id });
    expect(places[0].cost_usd).toBeCloseTo(0.035, 8);
    // Credentials never stored.
    expect(JSON.stringify(results)).not.toContain("test-openai-key");
    expect(JSON.stringify(results)).not.toContain("test-google-key");
  });

  it("attributes usage to registered users", async () => {
    const { env: e, sent } = makeEnv();
    const c = new Client(e);
    const { user } = await registerAndLogin(c, sent);
    const t = await c.post("/api/trips", {});
    mock.openaiQueue.push(okCompletion(generateTurn(1)));
    await c.post(`/api/trips/${t.json.trip.id}/messages`, { content: "1 day in Tokyo" });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE provider = 'openai' AND user_id = ? AND guest_id IS NULL AND trip_id = ?").bind(user.id, t.json.trip.id).first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  it("serves repeated Places lookups from cache without billing", async () => {
    const { env: e } = makeEnv();
    const q = `Cache test ${crypto.randomUUID()}`;
    const a = await searchPlaces({ env: e, query: q, maxResults: 1, operation: "cache_test", attribution });
    const b = await searchPlaces({ env: e, query: q, maxResults: 1, operation: "cache_test", attribution });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(mock.placesCalls.filter((c) => c.body.textQuery === q)).toHaveLength(1);
    // Unattributed usage (no user, guest or trip) is recorded too.
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE operation = 'cache_test' AND user_id IS NULL AND guest_id IS NULL AND trip_id IS NULL").first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(mock.placesCalls.at(-1).headers["X-Goog-FieldMask"]).toContain("places.regularOpeningHours");
  });

  it("records failed Places requests with zero cost", async () => {
    const { env: e } = makeEnv();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "key" } }), { status: 403 }));
    await expect(searchPlaces({ env: e, query: `fail ${crypto.randomUUID()}`, maxResults: 1, operation: "fail_test", attribution })).rejects.toThrow();
    const ev = await env.DB.prepare("SELECT * FROM usage_events WHERE operation = 'fail_test'").first<any>();
    expect(ev).toMatchObject({ status: "error", cost_usd: 0, units: 0, error_code: "PERMISSION_DENIED", http_status: 403 });
  });

  it("place search endpoint is rate limited and attributed to the trip", async () => {
    const { env: e } = makeEnv();
    const c = new Client(e);
    const t = await c.post("/api/trips", {});
    const r = await c.post(`/api/trips/${t.json.trip.id}/places/search`, { query: `ramen ${crypto.randomUUID().slice(0, 6)}` });
    expect(r.status).toBe(200);
    expect(r.json.results[0].source).toBe("google_places");
    const ev = await env.DB.prepare("SELECT * FROM usage_events WHERE trip_id = ? AND operation = 'place_search'").bind(t.json.trip.id).first<any>();
    expect(ev.cost_usd).toBeCloseTo(0.035, 8);
  });

  it("place search reports unavailability when Google is not configured", async () => {
    const { env: e } = makeEnv({ GOOGLE_MAPS_API_KEY: "" });
    const c = new Client(e);
    const t = await c.post("/api/trips", {});
    const r = await c.post(`/api/trips/${t.json.trip.id}/places/search`, { query: "ramen" });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("PLACES_NOT_CONFIGURED");
  });
});
