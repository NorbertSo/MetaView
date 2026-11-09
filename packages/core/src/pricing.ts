export interface ModelPricing {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  cache_read_usd_per_mtok: number;
  cache_write_usd_per_mtok: number;
}

export interface TokenUsage {
  inputTokens: number;       // uncached input
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function llmCostUsd(p: ModelPricing, u: TokenUsage): number {
  const cost =
    (u.inputTokens * p.input_usd_per_mtok +
      u.outputTokens * p.output_usd_per_mtok +
      u.cacheReadTokens * p.cache_read_usd_per_mtok +
      u.cacheWriteTokens * p.cache_write_usd_per_mtok) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
