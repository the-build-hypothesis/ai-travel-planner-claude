// OpenAI adapter (Chat Completions + Structured Outputs).
import { LlmError, type LlmProvider, type LlmUsage, type StructuredRequest, type StructuredResponse } from "./types";

const API_URL = "https://api.openai.com/v1/chat/completions";

/** Reasoning-model families reject `temperature`. */
function supportsTemperature(model: string): boolean {
  return !/^(o\d|gpt-5)/.test(model);
}

export class OpenAIProvider implements LlmProvider {
  readonly name = "openai";
  readonly endpoint = "chat.completions";

  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async generateStructured(req: StructuredRequest): Promise<StructuredResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_completion_tokens: req.maxOutputTokens,
      response_format: {
        type: "json_schema",
        json_schema: { name: req.schema.name, strict: true, schema: req.schema.jsonSchema },
      },
    };
    if (req.temperature !== undefined && supportsTemperature(req.model)) body.temperature = req.temperature;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new LlmError("timeout", `OpenAI request timed out after ${req.timeoutMs}ms`, true);
      throw new LlmError("network", "Network error contacting OpenAI", true);
    }

    let json: any;
    try {
      json = await res.json();
    } catch {
      clearTimeout(timer);
      throw new LlmError(res.ok ? "invalid_output" : "server", `OpenAI returned a non-JSON response (HTTP ${res.status})`, !res.ok, res.status);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const message = String(json?.error?.message ?? `HTTP ${res.status}`).slice(0, 300);
      const retryAfterHeader = Number(res.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : null;
      if (res.status === 401 || res.status === 403) throw new LlmError("auth", `OpenAI authentication failed: ${message}`, false, res.status);
      if (res.status === 429) {
        const quota = json?.error?.code === "insufficient_quota";
        throw new LlmError("rate_limited", `OpenAI rate limit: ${message}`, !quota, res.status, retryAfterMs);
      }
      if (res.status >= 500) throw new LlmError("server", `OpenAI server error: ${message}`, true, res.status, retryAfterMs);
      throw new LlmError("bad_request", `OpenAI rejected the request: ${message}`, false, res.status);
    }

    const usage = parseUsage(json?.usage);
    const choice = json?.choices?.[0];
    const finishReason: string | null = choice?.finish_reason ?? null;
    const msg = choice?.message;
    if (msg?.refusal) throw new LlmError("refused", "The model declined this request.", false, res.status, null, usage);
    if (finishReason === "length")
      throw new LlmError("truncated", "The model response was cut off before completion.", false, res.status, null, usage);
    const content = typeof msg?.content === "string" ? msg.content : null;
    if (!content) throw new LlmError("invalid_output", "The model returned an empty response.", true, res.status, null, usage);
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      throw new LlmError("invalid_output", "The model returned malformed JSON.", true, res.status, null, usage);
    }
    return { data, usage, model: String(json?.model ?? req.model), finishReason, httpStatus: res.status };
  }
}

function parseUsage(u: any): LlmUsage | null {
  if (!u || typeof u !== "object") return null;
  return {
    inputTokens: Number(u.prompt_tokens ?? 0),
    cachedInputTokens: Number(u.prompt_tokens_details?.cached_tokens ?? 0),
    outputTokens: Number(u.completion_tokens ?? 0),
    reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens ?? 0),
  };
}
