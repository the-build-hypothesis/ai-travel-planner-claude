import { z } from 'zod';
import type { Env } from '../env';
import { recordLlmUsage, type Attribution } from '../usage/record';
import { OpenAiProvider } from './openai';
import { LlmError, type LlmMessage, type LlmProvider } from './types';

export { LlmError } from './types';

export interface LlmConfig {
  providerName: string;
  model: string;
  provider: LlmProvider;
}

/**
 * Resolves the provider and model strictly from runtime configuration.
 * There is deliberately no default or fallback: misconfiguration is an error, not a silent substitution.
 */
export function resolveLlm(env: Env): LlmConfig {
  const providerName = env.LLM_PROVIDER?.trim();
  const model = env.LLM_MODEL?.trim();
  if (!providerName) throw new LlmError('config', 'LLM_PROVIDER is not configured');
  if (!model) throw new LlmError('config', 'LLM_MODEL is not configured');
  switch (providerName.toLowerCase()) {
    case 'openai': {
      if (!env.OPENAI_API_KEY) throw new LlmError('config', 'OPENAI_API_KEY is not configured');
      return { providerName: 'openai', model, provider: new OpenAiProvider(env.OPENAI_API_KEY) };
    }
    default:
      throw new LlmError('config', `Unsupported LLM_PROVIDER "${providerName}"`);
  }
}

export interface StructuredCall<T extends z.ZodType> {
  operation: string;
  schemaName: string;
  schema: T;
  messages: LlmMessage[];
  maxOutputTokens: number;
  timeoutMs?: number;
  attribution: Attribution;
  onDelta?: (text: string) => void;
}

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt: number, err: LlmError): number {
  const computed = 500 * 2 ** (attempt - 1) + Math.random() * 250;
  return Math.min(err.opts.retryAfterMs ?? computed, 8000);
}

/**
 * Calls the configured model, validates the output against `schema`, and records every attempt.
 * Retries are bounded. Output that fails validation is retried like any other transient failure
 * and never reaches persistence.
 */
export async function callStructured<T extends z.ZodType>(env: Env, call: StructuredCall<T>): Promise<z.infer<T>> {
  const { provider, model, providerName } = resolveLlm(env);
  const jsonSchema = z.toJSONSchema(call.schema) as Record<string, unknown>;
  let lastError: LlmError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    const common = { attribution: call.attribution, operation: call.operation, provider: providerName, model, attempt };
    try {
      const res = await provider.complete({
        model,
        messages: call.messages,
        schema: { name: call.schemaName, jsonSchema },
        maxOutputTokens: call.maxOutputTokens,
        timeoutMs: call.timeoutMs ?? 60_000,
        // Text from a retried attempt would be duplicated, so only the first attempt streams.
        onDelta: attempt === 1 ? call.onDelta : undefined,
      });
      let parsed: z.infer<T>;
      try {
        const result = call.schema.safeParse(JSON.parse(res.text));
        if (!result.success) throw new Error(result.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        parsed = result.data;
      } catch (err) {
        throw new LlmError('malformed', `Model output failed validation: ${(err as Error).message}`, {
          retryable: true,
          usage: res.usage,
          status: res.status,
        });
      }
      await recordLlmUsage(env.DB, { ...common, status: 'success', httpStatus: res.status, durationMs: Date.now() - started, usage: res.usage });
      return parsed;
    } catch (err) {
      const llmErr = err instanceof LlmError ? err : new LlmError('server', (err as Error).message);
      await recordLlmUsage(env.DB, {
        ...common,
        status: 'error',
        httpStatus: llmErr.opts.status ?? null,
        durationMs: Date.now() - started,
        usage: llmErr.opts.usage ?? null,
        errorCode: llmErr.code,
        errorMessage: llmErr.message,
      });
      lastError = llmErr;
      if (!llmErr.retryable || attempt === MAX_ATTEMPTS) throw llmErr;
      await sleep(backoff(attempt, llmErr));
    }
  }
  throw lastError ?? new LlmError('server', 'LLM call failed');
}

/** Message safe to show travelers. Never includes provider detail. */
export function llmUserMessage(err: LlmError): string {
  switch (err.code) {
    case 'rate_limited':
      return 'The AI service is busy right now. Please try again in a minute.';
    case 'timeout':
      return 'The AI service took too long to respond. Please try again.';
    case 'config':
    case 'auth':
      return 'The AI service is not available because of a configuration problem. The team has been notified.';
    case 'refused':
      return "The AI service couldn't help with that request. Try rephrasing it.";
    case 'malformed':
    case 'truncated':
      return "The AI service returned an incomplete answer, so nothing was changed. Please try again.";
    default:
      return 'The AI service is temporarily unavailable. Please try again.';
  }
}
