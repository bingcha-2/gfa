/**
 * access-key-limit.ts — Pure rate-limit / usage-accounting helpers extracted from
 * AccessKeyStore. These operate purely on a record (+ args) with no store state or
 * file I/O, so they live here as standalone functions. The store's orchestration
 * (resolveFromRequest / validateRecord / recordUsage / publicStatus) stays in
 * access-key-store.ts because it is entangled with the file cache (writeCache) and
 * the in-memory indexes; it calls into these helpers.
 */
import {
  normalizeUsageToGross,
  readTokenCount,
  billableTokenUsageTotal,
  eventUsageForLimit,
  bucketWindowStart,
} from './token-billing';
import { bucketKey, modelFamily } from '../lease-core/product-bucket';

/** Bucket key for the model a request is asking for, scoped to the product
 *  serving it. Falls back to bare family when product is unknown (legacy path). */
export function requestBucket(product: string | undefined, modelKey: string): string {
  return product ? bucketKey(product, modelKey) : modelFamily(modelKey);
}

/**
 * Normalize a raw usage payload into the canonical token counts (and billing
 * bucket) that recordUsage() persists. Exposed so callers (e.g. the per-call
 * token-usage tracker) record EXACTLY the same numbers as the card counters.
 */
export function computeUsageDetail(usage: any = {}, modelKey = '', product = '') {
  // 单点收口:先按模型家族把上报归一成 gross input 口径,计费与拼车两条链共享同一份。
  const norm = normalizeUsageToGross(usage, modelKey);
  const inputTokens = readTokenCount(norm.inputTokens);
  const outputTokens = readTokenCount(norm.outputTokens);
  const cachedInputTokens = readTokenCount(norm.cachedInputTokens);
  const cacheCreationTokens = readTokenCount(norm.cacheCreationTokens);
  const rawTotalTokens = readTokenCount(norm.rawTotalTokens) || inputTokens + outputTokens;
  const totalTokens = billableTokenUsageTotal(
    { ...norm, inputTokens, outputTokens, cachedInputTokens, rawTotalTokens },
    modelKey,
  );
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    rawTotalTokens,
    totalTokens,
    bucket: requestBucket(product, modelKey || ''),
  };
}

/** Sum a bucket's CU-weighted usage from events with `at >= windowStart`.
 *  anthropic/codex → CU(加权);antigravity → 原始(与 recentBucketUsage 口径一致)。 */
export function bucketUsageSince(record: any, bucket: string, windowStart: number): number {
  let used = 0;
  for (const item of record.tokenUsageEvents || []) {
    if (Number(item?.at || 0) < windowStart) continue;
    if (requestBucket(String(item?.product || ''), String(item?.modelKey || '')) !== bucket) continue;
    used += eventUsageForLimit(item);
  }
  return used;
}

/** Token usage for ONE bucket within its current window. Bound cards align the
 *  window to the account's upstream reset (alignedResetAt); alignedResetAt<=0 →
 *  fixed-period (pool). */
export function bucketUsageInWindow(record: any, bucket: string, now: number, alignedResetAt: number): number {
  const windowStart = bucketWindowStart(record, bucket, now, alignedResetAt, Number(record.windowMs) || undefined);
  return bucketUsageSince(record, bucket, windowStart);
}

/** Read-only variant: does not advance/persist the bucket window start. */
export function bucketUsageInWindowReadonly(record: any, bucket: string, now: number, alignedResetAt: number): number {
  const windowStart = bucketWindowStart(record, bucket, now, alignedResetAt, Number(record.windowMs) || undefined, false);
  return bucketUsageSince(record, bucket, windowStart);
}
