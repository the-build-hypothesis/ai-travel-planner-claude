// Provider-independent LLM interfaces. Business logic depends only on these.

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StructuredRequest {
  model: string;
  messages: LlmMessage[];
  /** JSON Schema (draft 2020-12 subset) describing the required output. */
  schema: { name: string; jsonSchema: Record<string, unknown> };
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
}

export interface LlmUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface StructuredResponse {
  /** Parsed JSON (not yet validated against the business schema). */
  data: unknown;
  usage: LlmUsage | null;
  /** Model id reported by the provider (may be a dated snapshot of the requested model). */
  model: string;
  finishReason: string | null;
  httpStatus: number;
}

export type LlmErrorCode =
  | "config"
  | "auth"
  | "rate_limited"
  | "timeout"
  | "bad_request"
  | "server"
  | "network"
  | "invalid_output"
  | "refused"
  | "truncated";

/** Normalized provider error. `usage` is set when the provider billed the request anyway. */
export class LlmError extends Error {
  constructor(
    public code: LlmErrorCode,
    message: string,
    public retryable: boolean,
    public httpStatus: number | null = null,
    public retryAfterMs: number | null = null,
    public usage: LlmUsage | null = null,
  ) {
    super(message);
  }
}

export interface LlmProvider {
  readonly name: string;
  /** Endpoint label recorded in usage records. */
  readonly endpoint: string;
  generateStructured(req: StructuredRequest): Promise<StructuredResponse>;
}
