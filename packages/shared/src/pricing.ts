import pricingData from "./pricing.json";

export type FamilyPrice = { inputPerM: number; outputPerM: number; cacheReadPerM: number };
export type Family = "claude" | "gemini" | "gpt";
/** Claude 计费档位:按真实单价区分(避免 Opus/Sonnet/Haiku 同权重)。
 *  fable = 2× Opus;autocomplete = Flash-Lite 档(近零),给 tab_* 自动补全用。 */
export type ClaudeTier = "opus" | "sonnet" | "haiku" | "fable" | "autocomplete";

export type QuotaWeight = { input: number; output: number; cache: number };

// 把价目源拆成:三个 family(PRICING/QUOTA_WEIGHTS 沿用)+ Claude 档位表(新增)。
const { claudeTiers, ...familyPricing } = pricingData as {
  claude: FamilyPrice;
  gemini: FamilyPrice;
  gpt: FamilyPrice;
  claudeTiers: Record<ClaudeTier, FamilyPrice>;
};

/** 单一真实定价源(美元/百万 token)。改价只改 pricing.json。 */
export const PRICING: Record<Family, FamilyPrice> = familyPricing as Record<Family, FamilyPrice>;

/** Claude 每档真实定价(美元/百万 token)。 */
export const CLAUDE_TIER_PRICING: Record<ClaudeTier, FamilyPrice> = claudeTiers;

/** price → 相对权重(以传入 base 为单位 1 的归一化)。 */
function toWeights(p: FamilyPrice, base: number): QuotaWeight {
  return { input: p.inputPerM / base, output: p.outputPerM / base, cache: p.cacheReadPerM / base };
}

/** fair-share 相对权重 = 定价比值(input 归一为 1)。 */
export const QUOTA_WEIGHTS: Record<Family, QuotaWeight> = Object.fromEntries(
  (Object.entries(PRICING) as [Family, FamilyPrice][]).map(([fam, p]) => [fam, toWeights(p, p.inputPerM)]),
) as Record<Family, QuotaWeight>;

// Claude 档位权重统一以 **Opus 输入**(=1)为基准归一化。这样 Opus 的权重保持
// {input:1, output:5, cache:0.1}(与历史 claude 权重一致)→ 既有 DEFAULT_BUDGETS 无需重标定;
// 只有 Sonnet(×0.6)/Haiku(×0.2)/Fable(×2)/autocomplete(~×0.02)相对 Opus 重新缩放。
const CLAUDE_BASE_PER_M = CLAUDE_TIER_PRICING.opus.inputPerM;

/** Claude 每档的 fair-share 权重(Opus-输入等价单元)。 */
export const CLAUDE_TIER_WEIGHTS: Record<ClaudeTier, QuotaWeight> = Object.fromEntries(
  (Object.entries(CLAUDE_TIER_PRICING) as [ClaudeTier, FamilyPrice][]).map(([tier, p]) => [
    tier,
    toWeights(p, CLAUDE_BASE_PER_M),
  ]),
) as Record<ClaudeTier, QuotaWeight>;
