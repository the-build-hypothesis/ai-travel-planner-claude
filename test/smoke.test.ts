import { describe, expect, it } from "vitest";
import { Client, makeEnv } from "./helpers";

describe("smoke", () => {
  it("health endpoint reports configuration without secrets", async () => {
    const { env } = makeEnv();
    const c = new Client(env);
    const r = await c.get("/api/health");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.llm).toEqual({ provider: "openai", model: "gpt-4o-mini", configured: true });
    expect(JSON.stringify(r.json)).not.toContain("test-openai-key");
    expect(r.json.email.binding).toBe(true);
  });

  it("redirects plain HTTP to HTTPS and sets HSTS on HTTPS responses", async () => {
    const { env: e } = makeEnv();
    const { createExecutionContext } = await import("cloudflare:test");
    const worker = (await import("../src/worker/index")).default;
    const r = await worker.fetch(new Request("http://travel.example.com/trips?x=1"), e, createExecutionContext());
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("https://travel.example.com/trips?x=1");
    const h = await new Client(e).get("/api/health");
    expect(h.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("unknown API routes return JSON 404", async () => {
    const { env } = makeEnv();
    const r = await new Client(env).get("/api/nope");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("NOT_FOUND");
  });
});
