export type ApiUsdQuotaDefault = { fiveHour: number; weekly: number };

/**
 * API-equivalent USD quota for one sellable share. These are max-utilization
 * operational estimates, not provider balances. Whole-account estimates are
 * divided by the production default of 8 base shares × 1.5 oversell = 12
 * sellable shares; a published catalog may override every value.
 *
 * Estimate snapshot: 2026-07-14.
 * - Codex 5h is currently disabled, so both Codex tiers use a zero 5h quota.
 *   Max-utilization estimates are $875/week for 5x and $3,500/week for 20x.
 * - Claude Max 20x is estimated at ~$360/5h and ~$1,900/week. Max 5x and Pro
 *   use the official per-session tier ratios and the observed ~2x weekly
 *   Max 20x/5x relationship.
 */
export const API_USD_QUOTA_PER_SEAT_DEFAULTS: Record<
  string,
  Record<string, ApiUsdQuotaDefault>
> = {
  codex: {
    plus: { fiveHour: 0, weekly: 72.916667 },
    pro: { fiveHour: 0, weekly: 291.666667 },
  },
  anthropic: {
    pro: { fiveHour: 1.5, weekly: 15.833333 },
    "max-5x": { fiveHour: 7.5, weekly: 79.166667 },
    "max-20x": { fiveHour: 30, weekly: 158.333333 },
  },
};

export const API_USD_DEFAULT_LEVELS: Record<string, string> = {
  codex: "pro",
  anthropic: "max-20x",
};
