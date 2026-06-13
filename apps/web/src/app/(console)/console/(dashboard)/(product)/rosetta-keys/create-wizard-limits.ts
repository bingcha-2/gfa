import type { CardType } from "./types";

const POOL_BUCKET_KEYS = [
  "antigravity-gemini",
  "antigravity-claude",
  "codex-gpt",
  "anthropic-claude",
];

function positiveInteger(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.floor(num);
}

export function buildCreateWizardBucketLimits({
  cardType,
  bucketLimits,
}: {
  cardType: CardType;
  bucketLimits: Record<string, number>;
}): Record<string, number> {
  if (cardType === "pool") {
    const next: Record<string, number> = {};
    for (const bucket of POOL_BUCKET_KEYS) {
      next[bucket] = positiveInteger(bucketLimits[bucket]) ?? 1;
    }
    return next;
  }

  const next: Record<string, number> = {};
  for (const [bucket, limit] of Object.entries(bucketLimits)) {
    const value = positiveInteger(limit);
    if (value) next[bucket] = value;
  }
  return next;
}
