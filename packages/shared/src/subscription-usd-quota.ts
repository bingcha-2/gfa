export type ApiUsdQuotaDefault = { fiveHour: number; weekly: number };

/**
 * API-equivalent USD quota for one sellable share. These are max-utilization
 * operational allocations, not provider balances. A published catalog may
 * override every value.
 *
 * Allocation snapshot: 2026-08-13.
 * - Codex 5h is currently disabled, so both Codex tiers use a zero 5h quota.
 *   Each purchased share receives $100/week: an 8-seat car grants $100 to
 *   each one-share user, a 4-person car grants $200 to each two-share user,
 *   and all 8 base shares add up to $800.
 * - Claude Max 20x is estimated at ~$360/5h and ~$1,900/week. Max 5x and Pro
 *   use the official per-session tier ratios and the observed ~2x weekly
 *   Max 20x/5x relationship.
 */
export const API_USD_QUOTA_PER_SEAT_DEFAULTS: Record<
  string,
  Record<string, ApiUsdQuotaDefault>
> = {
  codex: {
    plus: { fiveHour: 0, weekly: 100 },
    pro: { fiveHour: 0, weekly: 100 },
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

/**
 * Cheapest sellable level for a product (lowest weekly, then 5h). Use this as
 * the SAFE fallback when a subscription carries no recorded level and the
 * catalog offers no default: under-grant to the cheapest tier rather than
 * silently gifting the top tier (a level-less anthropic row must not default to
 * max-20x). Returns "" if the product has no defaults.
 */
export function cheapestApiUsdLevel(product: string): string {
  const levels = API_USD_QUOTA_PER_SEAT_DEFAULTS[product];
  if (!levels) return "";
  let best = "";
  let bestRank = Number.POSITIVE_INFINITY;
  for (const [level, quota] of Object.entries(levels)) {
    // Rank by weekly (the dominant cap) first, then 5h as a tiebreak.
    const rank = (Number(quota.weekly) || 0) * 1e6 + (Number(quota.fiveHour) || 0);
    if (rank < bestRank) { bestRank = rank; best = level; }
  }
  return best;
}
