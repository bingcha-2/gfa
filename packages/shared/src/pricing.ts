import pricingData from "./pricing.json";

export type FamilyPrice = { inputPerM: number; outputPerM: number; cacheReadPerM: number };
export type Family = "claude" | "gemini" | "gpt";

/** 单一真实定价源(美元/百万 token)。改价只改 pricing.json。 */
export const PRICING: Record<Family, FamilyPrice> = pricingData as Record<Family, FamilyPrice>;

/** fair-share 相对权重 = 定价比值(input 归一为 1)。 */
export const QUOTA_WEIGHTS: Record<Family, { input: number; output: number; cache: number }> =
  Object.fromEntries(
    (Object.entries(PRICING) as [Family, FamilyPrice][]).map(([fam, p]) => [
      fam,
      { input: 1, output: p.outputPerM / p.inputPerM, cache: p.cacheReadPerM / p.inputPerM },
    ]),
  ) as Record<Family, { input: number; output: number; cache: number }>;
