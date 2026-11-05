// Provider-independent LLM contract. Business logic only ever sees these types.
import type { TokenUsage } from '../usage/pricing';

export type LlmErrorCode =
  | 'config'
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'refused'
  | 'truncated'
  | 'malformed'
  | 'unavailable';

export class LlmError extends Error {
  constructor(
    public code: LlmErrorCode,
    message: string,
    public opts: { retryable?: boolean; status?: number; retryAfterMs?: number; usage?: TokenUsage | null } = {},
  ) {
    super(message);
  }
  get retryable() {
    return this.opts.retryable ?? false;
  }
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  /** JSON Schema for structured output; providers adapt it to their dialect. */
  schema?: { name: string; jsonSchema: Record<string, unknown> };
  maxOutputTokens: number;
  timeoutMs: number;
  /** Called with raw text deltas when the provider streams. */
  onDelta?: (text: string) => void;
}

export interface LlmResponse {
  text: string;
  usage: TokenUsage | null;
  finishReason: string | null;
  status: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
