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

  it("unknown API routes return JSON 404", async () => {
    const { env } = makeEnv();
    const r = await new Client(env).get("/api/nope");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("NOT_FOUND");
  });
});
