// Request-level usage & cost accounting for billable external APIs.
import type { Actor } from "../env";
import { uuid } from "../lib/crypto";

export interface PricingRule {
  id: string;
  provider: string;
  item: string;
  input_per_mtok: number | null;
  cached_input_per_mtok: number | null;
  output_per_mtok: number | null;
  per_1000_requests: number | null;
  version: string;
}

export interface Attribution {
  userId: string | null;
  guestId: string | null;
  tripId: string | null;
}

export const attributionFor = (actor: Actor | null, tripId: string | null): Attribution => ({
  userId: actor?.userId ?? null,
  guestId: actor?.guestId ?? null,
  tripId,
});

export async function getPricing(db: D1Database, provider: string, item: string): Promise<PricingRule | null> {
  return db
    .prepare(`SELECT * FROM pricing_rules WHERE provider = ? AND item = ?`)
    .bind(provider, item)
    .first<PricingRule>();
}

/**
 * Resolve the LLM pricing rule for a model id. Exact match first; then the
 * longest configured model id that is a prefix of a dated snapshot id
 * (e.g. "gpt-4o-mini-2024-07-18" → "gpt-4o-mini"). Returns null when unknown —
 * the cost is then recorded as NULL ("pricing unknown"), never guessed.
 */
export async function getLlmPricing(db: D1Database, provider: string, model: string): Promise<PricingRule | null> {
  const exact = await getPricing(db, provider, model);
  if (exact) return exact;
  const { results } = await db
    .prepare(`SELECT * FROM pricing_rules WHERE provider = ?`)
    .bind(provider)
    .all<PricingRule>();
  const candidates = results
    .filter((r) => /^-\d{4}-\d{2}-\d{2}$/.test(model.slice(r.item.length)) && model.startsWith(r.item))
    .sort((a, b) => b.item.length - a.item.length);
  return candidates[0] ?? null;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** Cost in USD. Cached input tokens are billed at the cached rate; the rest at the input rate.
 *  Reasoning tokens are already included in output tokens by the provider. */
export function llmCost(rule: PricingRule, u: TokenUsage): number {
  const cached = Math.min(u.cachedInputTokens, u.inputTokens);
  const uncached = u.inputTokens - cached;
  const inRate = rule.input_per_mtok ?? 0;
  const cachedRate = rule.cached_input_per_mtok ?? inRate;
  const outRate = rule.output_per_mtok ?? 0;
  const cost = (uncached * inRate + cached * cachedRate + u.outputTokens * outRate) / 1_000_000;
  return round8(cost);
}

export function requestCost(rule: PricingRule, units: number): number {
  return round8(((rule.per_1000_requests ?? 0) * units) / 1000);
}

const round8 = (n: number) => Math.round(n * 1e8) / 1e8;

export interface UsageRecord {
  provider: string;
  model: string | null;
  endpoint: string;
  operation: string;
  attribution: Attribution;
  status: "success" | "error";
  httpStatus?: number | null;
  tokens?: TokenUsage | null;
  units?: number;
  costUsd: number | null;
  pricing: PricingRule | null;
  durationMs: number;
  attempt?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export async function recordUsage(db: D1Database, r: UsageRecord): Promise<void> {
  const detail = r.pricing
    ? JSON.stringify({
        rule: r.pricing.id,
        input_per_mtok: r.pricing.input_per_mtok,
        cached_input_per_mtok: r.pricing.cached_input_per_mtok,
        output_per_mtok: r.pricing.output_per_mtok,
        per_1000_requests: r.pricing.per_1000_requests,
      })
    : JSON.stringify({ rule: null, note: "No pricing rule configured for this model/SKU; cost unknown." });
  await db
    .prepare(
      `INSERT INTO usage_events (id, created_at, provider, model, endpoint, operation, user_id, guest_id, trip_id,
        status, http_status, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, units, cost_usd,
        currency, pricing_version, pricing_detail, duration_ms, attempt, error_code, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      uuid(),
      Date.now(),
      r.provider,
      r.model,
      r.endpoint,
      r.operation,
      r.attribution.userId,
      r.attribution.guestId,
      r.attribution.tripId,
      r.status,
      r.httpStatus ?? null,
      r.tokens?.inputTokens ?? null,
      r.tokens?.cachedInputTokens ?? null,
      r.tokens?.outputTokens ?? null,
      r.tokens?.reasoningTokens ?? null,
      r.units ?? 0,
      r.costUsd,
      r.pricing?.version ?? null,
      detail,
      Math.round(r.durationMs),
      r.attempt ?? 1,
      r.errorCode ?? null,
      r.errorMessage ? r.errorMessage.slice(0, 500) : null,
    )
    .run();
}
