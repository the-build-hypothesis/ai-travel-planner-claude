// LLM entry point: provider selection from runtime config, bounded retries,
// structured-output validation and per-attempt usage accounting.
import type { z } from "zod";
import type { Env } from "../env";
import { getLlmPricing, llmCost, recordUsage, type Attribution } from "../services/usage";
import { OpenAIProvider } from "./openai";
import { LlmError, type LlmMessage, type LlmProvider, type LlmUsage } from "./types";

export { LlmError } from "./types";

export interface LlmConfig {
  provider: string;
  model: string;
}

/**
 * Reads LLM_PROVIDER / LLM_MODEL. No defaults and no substitution: if either is
 * missing or the provider is unsupported, a "config" error is raised.
 */
export function readLlmConfig(env: Env): LlmConfig {
  const provider = (env.LLM_PROVIDER ?? "").trim().toLowerCase();
  const model = (env.LLM_MODEL ?? "").trim();
  if (!provider) throw new LlmError("config", "LLM_PROVIDER is not configured.", false);
  if (!model) throw new LlmError("config", "LLM_MODEL is not configured.", false);
  return { provider, model };
}

export type FetchLike = typeof fetch;

export function createProvider(env: Env, fetchImpl?: FetchLike): { provider: LlmProvider; model: string } {
  const cfg = readLlmConfig(env);
  switch (cfg.provider) {
    case "openai": {
      if (!env.OPENAI_API_KEY) throw new LlmError("config", "OPENAI_API_KEY is not configured.", false);
      return { provider: new OpenAIProvider(env.OPENAI_API_KEY, fetchImpl), model: cfg.model };
    }
    default:
      throw new LlmError("config", `Unsupported LLM_PROVIDER "${cfg.provider}".`, false);
  }
}

export interface CallOptions<T> {
  env: Env;
  messages: LlmMessage[];
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  validator: z.ZodType<T>;
  operation: string;
  attribution: Attribution;
  maxOutputTokens?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  temperature?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface CallResult<T> {
  data: T;
  model: string;
  usage: LlmUsage | null;
  costUsd: number | null;
  attempts: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function callStructured<T>(o: CallOptions<T>): Promise<CallResult<T>> {
  const { provider, model } = createProvider(o.env, o.fetchImpl);
  const maxAttempts = Math.min(Math.max(o.maxAttempts ?? 3, 1), 4);
  const sleep = o.sleep ?? defaultSleep;
  let lastErr: LlmError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    try {
      const res = await provider.generateStructured({
        model,
        messages: o.messages,
        schema: { name: o.schemaName, jsonSchema: o.jsonSchema },
        maxOutputTokens: o.maxOutputTokens ?? 8000,
        timeoutMs: o.timeoutMs ?? 90_000,
        temperature: o.temperature,
      });
      const pricing = res.usage ? await getLlmPricing(o.env.DB, provider.name, res.model) : null;
      const cost = res.usage && pricing ? llmCost(pricing, res.usage) : null;
      const parsed = o.validator.safeParse(res.data);
      if (!parsed.success) {
        // Billed, but unusable: record as an error attempt and retry (bounded).
        await recordUsage(o.env.DB, {
          provider: provider.name,
          model: res.model,
          endpoint: provider.endpoint,
          operation: o.operation,
          attribution: o.attribution,
          status: "error",
          httpStatus: res.httpStatus,
          tokens: res.usage,
          units: 1,
          costUsd: cost,
          pricing,
          durationMs: Date.now() - started,
          attempt,
          errorCode: "invalid_output",
          errorMessage: "Structured output failed schema validation",
        });
        lastErr = new LlmError("invalid_output", "The AI returned an invalid itinerary format.", true, res.httpStatus);
        continue;
      }
      await recordUsage(o.env.DB, {
        provider: provider.name,
        model: res.model,
        endpoint: provider.endpoint,
        operation: o.operation,
        attribution: o.attribution,
        status: "success",
        httpStatus: res.httpStatus,
        tokens: res.usage,
        units: 1,
        costUsd: cost,
        pricing,
        durationMs: Date.now() - started,
        attempt,
      });
      return { data: parsed.data, model: res.model, usage: res.usage, costUsd: cost, attempts: attempt };
    } catch (e) {
      const err =
        e instanceof LlmError ? e : new LlmError("server", e instanceof Error ? e.message : "Unknown LLM error", false);
      if (err.code === "config") throw err;
      const pricing = err.usage ? await getLlmPricing(o.env.DB, provider.name, model) : null;
      await recordUsage(o.env.DB, {
        provider: provider.name,
        model,
        endpoint: provider.endpoint,
        operation: o.operation,
        attribution: o.attribution,
        status: "error",
        httpStatus: err.httpStatus,
        tokens: err.usage,
        units: err.usage ? 1 : 0,
        costUsd: err.usage && pricing ? llmCost(pricing, err.usage) : err.usage ? null : 0,
        pricing,
        durationMs: Date.now() - started,
        attempt,
        errorCode: err.code,
        errorMessage: err.message,
      });
      lastErr = err;
      if (!err.retryable || attempt === maxAttempts) throw err;
      const backoff = Math.min(err.retryAfterMs ?? 800 * 2 ** (attempt - 1), 8000);
      await sleep(backoff);
    }
  }
  throw lastErr ?? new LlmError("server", "LLM request failed", false);
}
