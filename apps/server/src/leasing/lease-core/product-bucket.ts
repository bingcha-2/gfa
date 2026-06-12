/**
 * product-bucket.ts — the single source of truth for product / family / bucket
 * naming and the round-trip mapping between them.
 *
 * Three concepts, kept strictly distinct:
 *  - Product : the top-level axis a card is sold for — antigravity | codex | anthropic.
 *  - Family  : which vendor a *model* belongs to — gemini | claude | gpt. Derived
 *              from the model name; never an independent axis, only a bucket suffix.
 *  - Bucket  : the billing/quota key, ALWAYS composite `<product>-<family>`.
 *
 * Rule: any quota/billing/blood-bar key is `bucketKey(product, model)`. The product
 * prefix means the same Claude model served via antigravity vs anthropic lands in
 * two different buckets (`antigravity-claude` vs `anthropic-claude`) and never
 * cross-counts. Nothing outside this module may re-implement model classification.
 */

import { QUOTA_WEIGHTS, CLAUDE_TIER_WEIGHTS, type QuotaWeight } from "@gfa/shared";

export type Product = "antigravity" | "codex" | "anthropic";
export type Family = "gemini" | "claude" | "gpt";

/** Detect a Gemini model. */
export function isGeminiModel(modelKey: unknown): boolean {
  const key = String(modelKey || "").toLowerCase();
  return key.includes("gemini") || key.startsWith("gem");
}

/** Detect an OpenAI/Codex model (gpt-* or *-codex). */
export function isCodexModel(modelKey: unknown): boolean {
  const key = String(modelKey || "").toLowerCase();
  return key.startsWith("gpt") || key.includes("codex");
}

/** Classify a model name into its vendor family. Claude is the fallback. */
export function modelFamily(modelKey: unknown): Family {
  if (isGeminiModel(modelKey)) return "gemini";
  if (isCodexModel(modelKey)) return "gpt";
  return "claude";
}

/** Claude 计费档位:用真实上报的 modelKey 区分单价(Opus/Sonnet/Haiku/Fable),
 *  避免所有 Claude 模型挤进同一权重。命中顺序很重要:
 *   1) 自动补全 / 非 Claude(tab_*、flash_lite)先拦,否则会被 modelFamily 的 claude
 *      兜底当成 Opus 计(自动补全本是 Flash-Lite 档,近零)。
 *   2) fable 特殊高价(= 2× Opus)。
 *   3) 档位词子串匹配 —— 天然忽略版本/日期/`-thinking` 后缀
 *      (claude-opus-4-6-thinking → opus;claude-haiku-4-5-20251001 → haiku)。
 *   4) 兜底 unknown:由计价侧按 Opus 计(防止用未收录别名套低价)并打日志。
 *  注:`-thinking` 不需单独倍率 —— 思考 token 已在上游 usage.output_tokens 里按输出计。 */
export type ClaudeTierKey = "opus" | "sonnet" | "haiku" | "fable" | "autocomplete" | "unknown";

export function claudeModelTier(modelKey: unknown): ClaudeTierKey {
  const k = String(modelKey || "").toLowerCase();
  if (k.startsWith("tab_") || k.includes("flash_lite") || k.includes("flash-lite") || k.includes("autocomplete"))
    return "autocomplete";
  if (k.includes("fable")) return "fable";
  if (k.includes("opus")) return "opus";
  if (k.includes("sonnet")) return "sonnet";
  if (k.includes("haiku")) return "haiku";
  return "unknown";
}

/**
 * 一次请求的 fair-share / 计费权重(CU,各家族自归一)。优先用真实 modelKey 区分 Claude
 * 档位单价;也兼容只传 bucket(如 "anthropic-claude" / "codex-gpt")的旧调用 —— 经
 * modelFamily 仍归到正确 family(gemini/gpt 不变),Claude 桶名落 unknown→Opus(与历史权重一致)。
 *   gemini/gpt:沿用 family 权重(单家族,以自身输入为基准)。
 *   claude:    按 claudeModelTier 取档位权重(以 Opus 输入为内部基准);unknown 兜底 Opus。
 * 注:`-thinking` 无需单独倍率 —— 思考 token 已在上游 usage.output_tokens 里按输出计。
 */
export function quotaWeightFor(modelOrBucket: string): QuotaWeight {
  const fam = modelFamily(modelOrBucket);
  if (fam !== "claude") return QUOTA_WEIGHTS[fam] || QUOTA_WEIGHTS.gemini;
  const tier = claudeModelTier(modelOrBucket);
  return CLAUDE_TIER_WEIGHTS[tier as keyof typeof CLAUDE_TIER_WEIGHTS] || CLAUDE_TIER_WEIGHTS.opus;
}

/** Build the composite billing bucket key for a model under a product.
 *  `product` is typed as string (callers usually hold a runtime `provider.id`);
 *  pass one of the Product values. */
export function bucketKey(product: string, modelKey: unknown): string {
  return `${product}-${modelFamily(modelKey)}`;
}

/** Split a composite bucket key back into its product and family. */
export function parseBucket(bucket: string): { product: string; family: string } {
  const idx = String(bucket || "").indexOf("-");
  if (idx < 0) return { product: String(bucket || ""), family: "" };
  return { product: bucket.slice(0, idx), family: bucket.slice(idx + 1) };
}

export function productOfBucket(bucket: string): string {
  return parseBucket(bucket).product;
}

export function familyOfBucket(bucket: string): string {
  return parseBucket(bucket).family;
}

/** Family segment of a bucket key, tolerant of legacy bare-family keys:
 *  `<product>-<family>` → family; bare `gemini|claude|gpt` → itself. */
export function bucketFamily(bucket: string): string {
  const i = String(bucket || "").indexOf("-");
  return i >= 0 ? bucket.slice(i + 1) : String(bucket || "");
}

export const PRODUCTS: Product[] = ["antigravity", "codex", "anthropic"];

/** Which model families each product actually serves. antigravity proxies two
 *  vendors (Gemini + Claude); codex and anthropic are single-family. */
const FAMILIES_BY_PRODUCT: Record<Product, Family[]> = {
  antigravity: ["gemini", "claude"],
  codex: ["gpt"],
  anthropic: ["claude"],
};

/** The composite bucket keys a single product exposes. */
export function bucketsForProduct(product: string): string[] {
  const families = FAMILIES_BY_PRODUCT[product as Product];
  return families ? families.map((f) => `${product}-${f}`) : [];
}

/** The composite bucket keys for a set of products (deduped, in order).
 *  An empty/absent product list (pool card) enumerates every product. */
export function bucketsForProducts(products: string[] | undefined): string[] {
  const src = products && products.length ? products : PRODUCTS;
  const out: string[] = [];
  for (const p of src) {
    for (const b of bucketsForProduct(p)) {
      if (!out.includes(b)) out.push(b);
    }
  }
  return out;
}

/** Whether a string is a real composite bucket key some pool actually serves.
 *  Guards against the common misconfig of setting a per-card limit under a bare
 *  family ("claude") instead of a composite ("antigravity-claude") — the former
 *  sets hasBucketCaps but the enforce lookup (composite) never matches, so the
 *  limit silently never trips. */
export function isValidBucket(bucket: string): boolean {
  return typeof bucket === "string" && bucketsForProducts(undefined).includes(bucket);
}

const PRODUCT_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  codex: "Codex",
  anthropic: "Anthropic",
};

const FAMILY_LABELS: Record<string, string> = {
  gemini: "Gemini",
  claude: "Claude",
  gpt: "GPT",
};

export function productLabel(product: string): string {
  return PRODUCT_LABELS[product] || product;
}

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family] || family;
}

/** Human label for a composite bucket key, e.g. "Antigravity · Claude". */
export function bucketLabel(bucket: string): string {
  const { product, family } = parseBucket(bucket);
  if (!family) return productLabel(product);
  return `${productLabel(product)} · ${familyLabel(family)}`;
}
