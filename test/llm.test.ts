import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { callStructured, LlmError, resolveLlm } from '../src/worker/llm';
import { toOpenAiSchema } from '../src/worker/llm/openai';
import { dayOutputSchema, turnSchema } from '../src/worker/llm/schemas';
import { ReplyStreamer, sanitizeTripUpdates } from '../src/worker/trips/planner';
import { Client, mockExternal, sseBody, testEnv, turn } from './helpers';
import type { Env } from '../src/worker/env';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const envWith = (overrides: Partial<Env>): Env => ({ ...testEnv, ...overrides });

const schema = z.object({ answer: z.string() });
function call(env: Env, onDelta?: (t: string) => void) {
  return callStructured(env, {
    operation: 'unit_test',
    schemaName: 'unit',
    schema,
    messages: [{ role: 'user', content: 'hi' }],
    maxOutputTokens: 50,
    timeoutMs: 5000,
    attribution: { principal: null, tripId: null },
    onDelta,
  });
}

describe('provider and model selection', () => {
  it('uses the provider and model from configuration', () => {
    const resolved = resolveLlm(envWith({ LLM_PROVIDER: 'openai', LLM_MODEL: 'some-configured-model' }));
    expect(resolved.providerName).toBe('openai');
    expect(resolved.model).toBe('some-configured-model');
  });

  it('sends exactly the configured model to the provider', async () => {
    const calls = mockExternal(() => ({ answer: 'yes' }));
    await call(envWith({ LLM_MODEL: 'configured-model-xyz' }));
    expect(calls.llm[0].model).toBe('configured-model-xyz');
  });

  it.each([
    [{ LLM_PROVIDER: undefined }, /LLM_PROVIDER/],
    [{ LLM_MODEL: undefined }, /LLM_MODEL/],
    [{ LLM_MODEL: '   ' }, /LLM_MODEL/],
    [{ OPENAI_API_KEY: undefined }, /OPENAI_API_KEY/],
    [{ LLM_PROVIDER: 'anthropic' }, /Unsupported LLM_PROVIDER/],
  ])('fails instead of substituting a default for %j', (overrides, message) => {
    expect(() => resolveLlm(envWith(overrides))).toThrow(message);
  });

  it('never silently falls back to another model when the model errors', async () => {
    const calls = mockExternal(() => new Response(JSON.stringify({ error: { message: 'The model does not exist' } }), { status: 404 }));
    await expect(call(envWith({ LLM_MODEL: 'missing-model' }))).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls.llm.map((c) => c.model)).toEqual(['missing-model']);
  });

  it('keeps the same model across retries', async () => {
    let n = 0;
    const calls = mockExternal(() => (++n < 3 ? new Response('{}', { status: 500 }) : { answer: 'ok' }));
    await call(envWith({ LLM_MODEL: 'steady-model' }));
    expect(calls.llm.map((c) => c.model)).toEqual(['steady-model', 'steady-model', 'steady-model']);
  });

  it('returns a clean 503 to travelers when not configured, without internals', async () => {
    const client = new Client({ LLM_MODEL: undefined });
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    const calls = mockExternal(() => turn());
    const { status, data } = await client.json('POST', `/api/trips/${trip.id}/messages`, { content: 'hello' });
    expect(status).toBe(503);
    expect(data.error.code).toBe('LLM_NOT_CONFIGURED');
    expect(JSON.stringify(data)).not.toMatch(/LLM_MODEL|OPENAI/);
    expect(calls.llm).toHaveLength(0);
  });

  it('keeps the API key server-side, in the auth header only', async () => {
    const calls = mockExternal(() => ({ answer: 'ok' }));
    await call(envWith({ OPENAI_API_KEY: 'sk-unit-secret' }));
    expect(calls.llm[0].headers.Authorization).toBe('Bearer sk-unit-secret');
    expect(JSON.stringify({ ...calls.llm[0], headers: undefined })).not.toContain('sk-unit-secret');
  });
});

describe('structured output', () => {
  it('requests strict JSON schema output', async () => {
    const calls = mockExternal(() => ({ answer: 'ok' }));
    await call(testEnv);
    const format = calls.llm[0].response_format;
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.additionalProperties).toBe(false);
    expect(format.json_schema.schema.required).toEqual(['answer']);
  });

  it.each([['turn', turnSchema], ['day', dayOutputSchema]])('%s schema meets strict-mode rules throughout', (_n, s) => {
    const visit = (node: any, path: string) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach((v, i) => visit(v, `${path}[${i}]`));
      if (node.type === 'object') {
        expect(node.additionalProperties, path).toBe(false);
        expect([...(node.required ?? [])].sort(), path).toEqual(Object.keys(node.properties).sort());
      }
      for (const key of ['$schema', 'format', 'pattern', 'minLength', 'maxLength']) expect(node, path).not.toHaveProperty(key);
      for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`);
    };
    visit(toOpenAiSchema(z.toJSONSchema(s)), '$');
  });

  it('does not treat a property that is named like a keyword as a keyword', () => {
    expect(toOpenAiSchema({ properties: { format: { type: 'string', format: 'email' } } })).toEqual({ properties: { format: { type: 'string' } } });
  });

  it('parses valid output and records one success', async () => {
    mockExternal(() => ({ answer: 'forty-two' }));
    expect(await call(testEnv)).toEqual({ answer: 'forty-two' });
  });

  it.each([
    ['invalid JSON', 'not json at all'],
    ['wrong shape', '{"wrong":"shape"}'],
    ['wrong type', '{"answer":42}'],
  ])('retries on %s, then fails safely', async (_label, output) => {
    const calls = mockExternal(() => output);
    await expect(call(testEnv)).rejects.toMatchObject({ code: 'malformed' });
    expect(calls.llm).toHaveLength(3);
  });

  it('recovers when a retry returns valid output', async () => {
    let n = 0;
    mockExternal(() => (++n === 1 ? 'broken' : { answer: 'fixed' }));
    expect(await call(testEnv)).toEqual({ answer: 'fixed' });
  });

  it('streams deltas only from the first attempt', async () => {
    let n = 0;
    mockExternal(() => (++n === 1 ? 'broken' : { answer: 'fixed' }));
    const deltas: string[] = [];
    await call(testEnv, (t) => deltas.push(t));
    expect(deltas).toEqual(['broken']);
  });

  it('drops only the invalid fields from model-proposed trip details', () => {
    const updates = { ...(turn().trip_updates as any), destination: 'Tokyo', adults: -4, currency: 'jpy', pace: 'relaxed', start_date: '2027-13-99', duration_days: 500 };
    expect(sanitizeTripUpdates(updates)).toEqual({ destination: 'Tokyo', currency: 'JPY', pace: 'relaxed' });
  });

  it('drops an inconsistent pair of dates', () => {
    const updates = { ...(turn().trip_updates as any), start_date: '2027-05-10', end_date: '2027-05-01' };
    expect(sanitizeTripUpdates(updates)).toEqual({});
  });
});

describe('error handling', () => {
  const cases: [string, number, string, boolean][] = [
    ['auth', 401, 'auth', false],
    ['forbidden', 403, 'auth', false],
    ['bad request', 400, 'bad_request', false],
    ['server error', 500, 'server', true],
    ['overloaded', 503, 'server', true],
  ];
  it.each(cases)('normalizes %s', async (_label, status, code, retried) => {
    const calls = mockExternal(() => new Response(JSON.stringify({ error: { message: 'x' } }), { status }));
    await expect(call(testEnv)).rejects.toMatchObject({ code });
    expect(calls.llm).toHaveLength(retried ? 3 : 1);
  });

  it('retries rate limits, honoring Retry-After', async () => {
    let n = 0;
    const calls = mockExternal(() => (++n === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : { answer: 'ok' }));
    expect(await call(testEnv)).toEqual({ answer: 'ok' });
    expect(calls.llm).toHaveLength(2);
  });

  it('does not retry an exhausted quota', async () => {
    const calls = mockExternal(() => new Response(JSON.stringify({ error: { message: 'You exceeded your current quota' } }), { status: 429 }));
    await expect(call(testEnv)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(calls.llm).toHaveLength(1);
  });

  it('bounds retries on timeouts', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      attempts++;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const err = await callStructured(testEnv, {
      operation: 'unit_timeout',
      schemaName: 'unit',
      schema,
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 10,
      timeoutMs: 5,
      attribution: { principal: null, tripId: null },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('timeout');
    expect(attempts).toBe(3);
  });

  it('treats a network failure as retryable', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts++;
      throw new TypeError('connection reset');
    });
    await expect(call(testEnv)).rejects.toMatchObject({ code: 'network' });
    expect(attempts).toBe(3);
  });

  it('reports truncation and keeps the billed tokens', async () => {
    mockExternal(() => new Response(sseBody('{"answer":"cut', undefined, 'length'), { status: 200 }));
    await expect(call(testEnv)).rejects.toMatchObject({ code: 'truncated' });
    const row = await testEnv.DB.prepare("SELECT input_tokens, error_code FROM usage_records WHERE error_code = 'truncated' LIMIT 1").first<any>();
    expect(row.input_tokens).toBe(1000);
  });

  it('treats a refusal as non-retryable', async () => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { refusal: 'No' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
    const calls = mockExternal(() => new Response(body, { status: 200 }));
    await expect(call(testEnv)).rejects.toMatchObject({ code: 'refused' });
    expect(calls.llm).toHaveLength(1);
  });

  it('gives travelers a safe message on failure', async () => {
    const client = new Client();
    const trip = (await client.json('POST', '/api/trips', {})).data.trip;
    mockExternal(() => new Response(JSON.stringify({ error: { message: 'Internal detail: org-123 sk-secret' } }), { status: 401 }));
    const events = await client.sse(`/api/trips/${trip.id}/messages`, { content: 'hello' });
    const error = events.find((e) => e.type === 'error');
    expect(error.message).not.toContain('org-123');
    expect(error.message).not.toContain('sk-secret');
    const logged = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM error_logs WHERE source = 'planner' AND code = 'auth'").first<{ n: number }>();
    expect(logged!.n).toBeGreaterThan(0);
  });
});

describe('reply streaming', () => {
  const collect = (chunks: string[]) => {
    let out = '';
    const s = new ReplyStreamer((t) => (out += t));
    for (const chunk of chunks) s.push(chunk);
    return out;
  };

  it('extracts the reply across arbitrary chunk boundaries', () => {
    const json = JSON.stringify({ intent: 'chat', reply: 'Hello "world"\nLine two é', edits: [] });
    expect(collect(json.split(''))).toBe('Hello "world"\nLine two é');
    expect(collect([json])).toBe('Hello "world"\nLine two é');
  });

  it('decodes unicode escapes split between chunks', () => {
    expect(collect(['{"intent":"chat","reply":"caf\\u', '00e9 ok"}'])).toBe('café ok');
  });

  it('holds back replies for research turns', () => {
    expect(collect([JSON.stringify({ intent: 'research', reply: 'Looking now', research_queries: [] })])).toBe('');
  });

  it('stops at the end of the reply', () => {
    expect(collect([JSON.stringify({ intent: 'edit', reply: 'Done', edits: [{ op: 'x', note: 'not reply' }] })])).toBe('Done');
  });
});
