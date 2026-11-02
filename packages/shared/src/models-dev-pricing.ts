import type { ApiPriceModel, ApiPriceRegistry, ApiPricingProvider, TokenPrice } from "./api-pricing";

const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
function price(cost: any, provider: ApiPricingProvider): TokenPrice | undefined {
  if (!valid(cost?.input) || !valid(cost?.output) || cost.input + cost.output === 0) return;
  for (const field of ["cache_read", "cache_write"]) if (cost[field] != null && !valid(cost[field])) return;
  return { input: cost.input, output: cost.output, cacheRead: cost.cache_read ?? 0,
    cacheWrite5m: cost.cache_write ?? 0,
    // Anthropic's one-hour cache creation is 2x base input; models.dev's
    // cache_write is the five-minute rate. Never reuse that for the 1h bucket.
    cacheWrite1h: provider === "anthropic" ? cost.input * 2 : cost.cache_write ?? 0 };
}
function tier(cost: any): { size: number; cost: any } | undefined {
  const tiers = cost?.tiers;
  if (Array.isArray(tiers) && tiers.length) {
    if (tiers.length !== 1 || tiers[0]?.tier?.type !== "context" || !(tiers[0].tier.size > 0)) throw new Error("Unsupported pricing tiers");
    return { size: tiers[0].tier.size, cost: tiers[0] };
  }
  if (cost?.context_over_200k) return { size: 200000, cost: cost.context_over_200k };
}
/** Only the original vendor's price, never a third-party reseller's same-name SKU. */
export function modelsDevRegistry(data: any, version: string, effectiveAt: number): ApiPriceRegistry {
  const models: ApiPriceModel[] = [];
  for (const [vendor, provider] of [["anthropic", "anthropic"], ["openai", "codex"], ["google", "antigravity"]] as const) {
    const entries = data?.[vendor]?.models;
    if (!entries || typeof entries !== "object") throw new Error(`Missing ${vendor} catalog`);
    let accepted = 0;
    for (const [id, model] of Object.entries(entries) as [string, any][]) {
      if (!model?.modalities?.output?.includes("text")) continue;
      const short = price(model.cost, provider);
      if (!short) continue;
      const t = tier(model.cost);
      const long = t ? price(t.cost, provider) : undefined;
      if (t && !long) throw new Error(`Invalid long-context price: ${vendor}/${id}`);
      const row: ApiPriceModel = { provider, canonicalModelId: id, aliases: [],
        effectiveFrom: new Date(effectiveAt).toISOString(), contextThreshold: t?.size,
        modes: { standard: { short, ...(long ? { long } : {}) } } };
      const fastCost = model.experimental?.modes?.fast?.cost;
      const fast = price(fastCost, provider);
      if (fast) {
        const ft = tier(fastCost);
        if (ft && ft.size !== t?.size) throw new Error(`Inconsistent fast tier: ${id}`);
        row.modes.priority = { short: fast, ...(ft ? { long: price(ft.cost, provider) } : t ? { long: fast } : {}) };
        // Mode costs are independent: an untiered fast table is flat; never multiply standard rates.
      }
      models.push(row); accepted++;
    }
    if (!accepted) throw new Error(`Empty ${vendor} pricing catalog`);
  }
  return { version, effectiveAt, models };
}
