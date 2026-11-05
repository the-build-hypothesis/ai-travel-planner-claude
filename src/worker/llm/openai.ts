import type { TokenUsage } from '../usage/pricing';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './types';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/** OpenAI strict mode rejects a few JSON Schema keywords that generic schemas may carry. */
export function toOpenAiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toOpenAiSchema);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === '$schema' || key === 'format' || key === 'pattern' || key === 'minLength' || key === 'maxLength') continue;
      if (key === 'properties' && value && typeof value === 'object') {
        out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toOpenAiSchema(v)]));
        continue;
      }
      out[key] = toOpenAiSchema(value);
    }
    return out;
  }
  return schema;
}

function parseUsage(raw: any): TokenUsage | null {
  if (!raw) return null;
  return {
    inputTokens: raw.prompt_tokens ?? 0,
    cachedInputTokens: raw.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: raw.completion_tokens ?? 0,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

function errorFromResponse(status: number, body: string, retryAfter: string | null): LlmError {
  let detail = '';
  try {
    detail = JSON.parse(body)?.error?.message ?? '';
  } catch {
    /* non-JSON error body */
  }
  const message = `OpenAI ${status}${detail ? `: ${detail}` : ''}`;
  if (status === 401 || status === 403) return new LlmError('auth', message, { status });
  if (status === 429) {
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
    // insufficient_quota is a 429 too, but waiting will not help.
    const retryable = !/quota/i.test(detail);
    return new LlmError('rate_limited', message, { status, retryable, retryAfterMs });
  }
  if (status >= 500) return new LlmError('server', message, { status, retryable: true });
  return new LlmError('bad_request', message, { status });
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  constructor(private apiKey: string) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
        max_completion_tokens: req.maxOutputTokens,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (req.schema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: req.schema.name, strict: true, schema: toOpenAiSchema(req.schema.jsonSchema) },
        };
      }
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw errorFromResponse(res.status, await res.text(), res.headers.get('retry-after'));
      }
      return await this.readStream(res, req);
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (controller.signal.aborted) {
        throw new LlmError('timeout', `OpenAI request timed out after ${req.timeoutMs} ms`, { retryable: true });
      }
      throw new LlmError('network', `OpenAI request failed: ${(err as Error).message}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readStream(res: Response, req: LlmRequest): Promise<LlmResponse> {
    if (!res.body) throw new LlmError('malformed', 'OpenAI returned an empty body');
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let text = '';
    let refusal = '';
    let usage: TokenUsage | null = null;
    let finishReason: string | null = null;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new LlmError('server', `OpenAI stream error: ${chunk.error.message ?? 'unknown'}`, { retryable: true });
        if (chunk.usage) usage = parseUsage(chunk.usage);
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (delta?.refusal) refusal += delta.refusal;
        if (delta?.content) {
          text += delta.content;
          req.onDelta?.(delta.content);
        }
      }
    }
    if (refusal) throw new LlmError('refused', 'The model declined this request.', { usage });
    if (finishReason === 'length') throw new LlmError('truncated', 'The model response hit its output limit.', { usage, retryable: true });
    if (finishReason === 'content_filter') throw new LlmError('refused', 'The response was blocked by a content filter.', { usage });
    return { text, usage, finishReason, status: res.status };
  }
}
