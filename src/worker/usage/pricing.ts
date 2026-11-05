export interface PricingRate {
  id: number;
  kind: 'llm' | 'places';
  sku: string;
  input_per_million: number | null;
  cached_input_per_million: number | null;
  output_per_million: number | null;
  per_1000_units: number | null;
  currency: string;
  source_note: string | null;
}

export async function findRate(db: D1Database, kind: 'llm' | 'places', sku: string): Promise<PricingRate | null> {
  const exact = await db
    .prepare('SELECT * FROM pricing_rates WHERE kind = ? AND sku = ? ORDER BY id DESC LIMIT 1')
    .bind(kind, sku)
    .first<PricingRate>();
  if (exact || kind !== 'llm') return exact;
  // Dated snapshots such as gpt-4o-mini-2024-07-18 use the base model's price.
  const base = sku.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (base === sku) return null;
  return db
    .prepare('SELECT * FROM pricing_rates WHERE kind = ? AND sku = ? ORDER BY id DESC LIMIT 1')
    .bind(kind, base)
    .first<PricingRate>();
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/**
 * OpenAI reports cached tokens as a subset of input tokens and reasoning tokens as a subset of
 * output tokens. Cached tokens therefore bill at the cached rate and only the rest at the input rate.
 * Returns null costs when no rate is known, so unpriced usage is never reported as free.
 */
export function llmCost(usage: TokenUsage, rate: PricingRate | null) {
  if (!rate || rate.input_per_million == null || rate.output_per_million == null) {
    return { inputCost: null, cachedInputCost: null, outputCost: null, total: null };
  }
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const inputCost = ((usage.inputTokens - cached) * rate.input_per_million) / 1_000_000;
  const cachedInputCost = (cached * (rate.cached_input_per_million ?? rate.input_per_million)) / 1_000_000;
  const outputCost = (usage.outputTokens * rate.output_per_million) / 1_000_000;
  return { inputCost, cachedInputCost, outputCost, total: inputCost + cachedInputCost + outputCost };
}

export function unitCost(units: number, rate: PricingRate | null): number | null {
  if (!rate || rate.per_1000_units == null) return null;
  return (units * rate.per_1000_units) / 1000;
}

export function rateSnapshot(rate: PricingRate | null): string | null {
  if (!rate) return null;
  const { id, sku, input_per_million, cached_input_per_million, output_per_million, per_1000_units, currency, source_note } = rate;
  return JSON.stringify({ id, sku, input_per_million, cached_input_per_million, output_per_million, per_1000_units, currency, source_note });
}
