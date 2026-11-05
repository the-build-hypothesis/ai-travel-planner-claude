import { newId } from '../lib/crypto';
import { nowIso } from '../lib/http';
import type { Principal } from '../env';
import { findRate, llmCost, rateSnapshot, unitCost, type TokenUsage } from './pricing';

export interface Attribution {
  principal: Principal | null;
  tripId: string | null;
  tripLabel?: string | null;
}

interface CommonFields {
  attribution: Attribution;
  operation: string;
  status: 'success' | 'error';
  httpStatus?: number | null;
  durationMs: number;
  attempt?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

// API keys can appear in provider error text or URLs, so messages are scrubbed before storage.
export function scrubError(message: string | null | undefined): string | null {
  if (!message) return null;
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/AIza[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/([?&]key=)[^&\s]+/g, '$1[redacted]')
    .slice(0, 500);
}

async function insert(db: D1Database, row: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(row);
  await db
    .prepare(`INSERT INTO usage_records (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .bind(...keys.map((k) => row[k] ?? null))
    .run();
}

function base(c: CommonFields) {
  const p = c.attribution.principal;
  return {
    id: newId('use'),
    created_at: nowIso(),
    operation: c.operation,
    user_id: p?.type === 'user' ? p.id : null,
    guest_id: p?.type === 'guest' ? p.id : null,
    trip_id: c.attribution.tripId,
    trip_label: c.attribution.tripLabel ?? null,
    status: c.status,
    http_status: c.httpStatus ?? null,
    duration_ms: Math.round(c.durationMs),
    attempt: c.attempt ?? 1,
    error_code: c.errorCode ?? null,
    error_message: scrubError(c.errorMessage),
  };
}

export async function recordLlmUsage(
  db: D1Database,
  fields: CommonFields & { provider: string; model: string; usage: TokenUsage | null },
): Promise<void> {
  try {
    const rate = await findRate(db, 'llm', fields.model);
    const cost = fields.usage ? llmCost(fields.usage, rate) : null;
    await insert(db, {
      ...base(fields),
      kind: 'llm',
      provider: fields.provider,
      model_or_endpoint: fields.model,
      sku: fields.model,
      input_tokens: fields.usage?.inputTokens,
      cached_input_tokens: fields.usage?.cachedInputTokens,
      output_tokens: fields.usage?.outputTokens,
      reasoning_tokens: fields.usage?.reasoningTokens,
      billable_units: fields.usage ? 1 : 0,
      input_cost: cost?.inputCost,
      cached_input_cost: cost?.cachedInputCost,
      output_cost: cost?.outputCost,
      // A failed call with no usage report costs nothing as far as we can tell.
      estimated_cost: fields.usage ? cost?.total : 0,
      currency: rate?.currency ?? 'USD',
      pricing_version: rate ? `rate-${rate.id}` : null,
      pricing_snapshot: rateSnapshot(rate),
    });
  } catch (err) {
    console.error('failed to record LLM usage', err);
  }
}

export async function recordPlacesUsage(
  db: D1Database,
  fields: CommonFields & { endpoint: string; sku: string; billableUnits: number },
): Promise<void> {
  try {
    const rate = await findRate(db, 'places', fields.sku);
    await insert(db, {
      ...base(fields),
      kind: 'places',
      provider: 'google_places',
      model_or_endpoint: fields.endpoint,
      sku: fields.sku,
      billable_units: fields.billableUnits,
      estimated_cost: fields.billableUnits === 0 ? 0 : unitCost(fields.billableUnits, rate),
      currency: rate?.currency ?? 'USD',
      pricing_version: rate ? `rate-${rate.id}` : null,
      pricing_snapshot: rateSnapshot(rate),
    });
  } catch (err) {
    console.error('failed to record Places usage', err);
  }
}
