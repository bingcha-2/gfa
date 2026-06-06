/**
 * token-billing.ts — Token counting, billing calculation, and window management.
 *
 * Extracted from remote-token-server/index.js (L160-L574, L283-L323).
 * All functions are pure — they operate on records passed in, no global state.
 */

import { compareVersions } from './data-store';
import {
  isGeminiModel,
  isCodexModel,
  modelFamily,
  bucketKey,
  bucketLabel as composeBucketLabel,
} from '../lease-core/product-bucket';

// Re-exported from the single naming/mapping source (lease-core/product-bucket).
// Kept here for the many existing import sites; do not re-implement classification.
export { isGeminiModel, isCodexModel };

/** The family segment of a bucket key — composite `<product>-<family>` → family,
 *  bare legacy `gemini|claude|gpt` → itself. Used for limit multipliers. */
function bucketFamilyName(bucket: string): string {
  const i = bucket.indexOf('-');
  return i >= 0 ? bucket.slice(i + 1) : bucket;
}

/** The billing bucket a stored usage event counts toward. Composite
 *  `<product>-<family>` when the event recorded its product; bare family for
 *  legacy events written before product was tracked (they self-heal as the
 *  5h/weekly window rolls over). */
function eventBucket(item: any): string {
  const product = String(item?.product || '');
  const model = String(item?.modelKey || '');
  return product ? bucketKey(product, model) : modelFamily(model);
}

// ── Default constants ────────────────────────────────────────────────────────

export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_AFFINITY_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = 1;
export const DEFAULT_KEY_WINDOW_MS = 5 * 60 * 60 * 1000;
export const DEFAULT_WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_KEY_WINDOW_LIMIT = 300;
/** Total shares per upstream account. A card consumes `weight` shares:
 * 1 = shared, 4 = exclusive (capacity=4), up to 8 (capacity=8). Configurable via env. */
export const ACCOUNT_SHARE_CAPACITY = Math.max(
  4,
  Math.min(8, Number(process.env.BCAI_ACCOUNT_SHARE_CAPACITY || 8)),
);
export const DEFAULT_KEY_TOKENS_PER_REQUEST = Math.max(
  1000,
  Number(process.env.BCAI_DEFAULT_KEY_TOKENS_PER_REQUEST || 100_000),
);
export const DEFAULT_KEY_SESSION_TTL_MS = 10 * 60 * 1000;
export const ACCESS_KEY_BINDING_GRACE_MS = Math.max(
  1000,
  Number(process.env.BCAI_ACCESS_KEY_BINDING_GRACE_MS || 15_000),
);
export const MAX_REMOTE_LEASE_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.BCAI_MAX_REMOTE_LEASE_TTL_MS || 15 * 60 * 1000),
);
// Bound cards pin to one account (no scheduler rebalancing), so their lease can
// run much longer than the pool default — up to the upstream token's real life.
// Capped here as a safety ceiling when the token expiry can't be decoded.
export const BOUND_LEASE_TTL_MS = Math.max(
  MAX_REMOTE_LEASE_TTL_MS,
  Number(process.env.BCAI_BOUND_LEASE_TTL_MS || 40 * 60 * 1000),
);

/** Decode a JWT access token's `exp` claim (seconds) → epoch ms, or 0 if undecodable. */
export function decodeJwtExpMs(token: string): number {
  try {
    const seg = String(token || "").split(".")[1];
    if (!seg) return 0;
    const json = Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = Number(JSON.parse(json)?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}
export const PHONE_VERIFICATION_COOLDOWN_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.BCAI_PHONE_VERIFICATION_COOLDOWN_MS || 24 * 60 * 60 * 1000),
);
export const FIRST_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
export const SECOND_QUOTA_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const MAX_QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const CAPACITY_COOLDOWN_MS = 10 * 1000;
export const MAX_CAPACITY_COOLDOWN_MS = 2 * 60 * 1000;
export const REMOTE_ACCOUNT_ERROR_THRESHOLD = Math.max(
  1,
  Number(process.env.BCAI_REMOTE_ACCOUNT_ERROR_THRESHOLD || 3),
);
export const REMOTE_TRANSIENT_ERROR_COOLDOWN_MS = Math.max(
  5 * 1000,
  Number(process.env.BCAI_REMOTE_TRANSIENT_ERROR_COOLDOWN_MS || 30 * 1000),
);
export const REMOTE_RECHECK_COOLDOWN_MS = Math.max(
  60 * 1000,
  Number(process.env.BCAI_REMOTE_RECHECK_COOLDOWN_MS || 5 * 60 * 1000),
);
export const LOCATION_UNSUPPORTED_COOLDOWN_MS = Math.max(
  60 * 1000,
  Number(process.env.BCAI_LOCATION_UNSUPPORTED_COOLDOWN_MS || 5 * 60 * 1000),
);
export const LOCATION_UNSUPPORTED_MAX_FAILURES = Number(
  process.env.BCAI_LOCATION_UNSUPPORTED_MAX_FAILURES || 20,
);
export const MODEL_PRESSURE_BASE_MS = 20 * 1000;
export const MODEL_PRESSURE_MAX_MS = 30 * 1000;
export const MODEL_PRESSURE_UNIQUE_THRESHOLD = 8;
export const MODEL_PRESSURE_WINDOW_MS = 60 * 1000;
export const PROBATION_INTERVAL_MS = 10 * 60 * 1000;
export const AUTO_RECHECK_AFTER_MS = Math.max(
  60 * 1000,
  Number(process.env.BCAI_AUTO_RECHECK_AFTER_MS || 5 * 60 * 1000),
);
export const AUTO_RECHECK_SWEEP_MS = Math.max(
  30 * 1000,
  Number(process.env.BCAI_AUTO_RECHECK_SWEEP_MS || 60 * 1000),
);
export const AUTO_RECHECK_VERIFY_LIMIT = Math.max(
  1,
  Number(process.env.BCAI_AUTO_RECHECK_VERIFY_LIMIT || 20),
);
export const MIN_HEALTHY_CANDIDATES = 2;
export const AUTH_FAILURE_COOLDOWN_MS = 30 * 60 * 1000;
export const TOKEN_REFRESH_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const RECENT_SUCCESS_GRACE_MS = Math.max(
  60 * 1000,
  Number(process.env.BCAI_RECENT_SUCCESS_GRACE_MS || 10 * 60 * 1000),
);
export const VERIFICATION_FAILURES_BEFORE_QUARANTINE = Math.max(
  1,
  Number(process.env.BCAI_VERIFICATION_FAILURES_BEFORE_QUARANTINE || 2),
);

// ── Token count helpers ──────────────────────────────────────────────────────

/** Safely parse a token count. Returns 0 for invalid/non-positive values. */
export function readTokenCount(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

// ── Provider-driven billing buckets ──────────────────────────────────────────
// A card's token-window usage is split into named buckets. Each (window, bucket)
// has its own limit. Antigravity: gemini(×5)/opus(×1) within one 5h window.
// Codex: a single "codex" bucket (×1). The scheme is supplied per-provider so the
// access-key store no longer hardcodes gemini/opus.
export interface ProviderBilling {
  /** Per-bucket limit derived from the card's base token-window limit.
   *  When `record` is supplied and has a `bucketLimits` override for the
   *  bucket, that value takes priority over the default multiplier. */
  bucketLimit(baseLimit: number, bucket: string, record?: any): number;
  /** Human label used in limit-exceeded error messages. */
  bucketLabel(bucket: string): string;
}

/**
 * Universal billing scheme — a single card is usable across ALL products.
 * Usage is split into composite `<product>-<family>` buckets (see product-bucket)
 * so the same Claude model served via antigravity vs anthropic never cross-counts,
 * and the per-family limit multiplier still applies (gemini ×5, others ×1).
 */
export const UNIVERSAL_BILLING: ProviderBilling = {
  bucketLimit: (baseLimit: number, bucket: string, record?: any) => {
    // Per-card override: record.bucketLimits.{bucket} takes priority.
    const custom = Number(record?.bucketLimits?.[bucket] ?? 0);
    if (custom > 0) return custom;
    return bucketFamilyName(bucket) === 'gemini' ? baseLimit * 5 : baseLimit;
  },
  bucketLabel: (bucket: string) => composeBucketLabel(bucket),
};

/** @deprecated cards are universal; kept as an alias of UNIVERSAL_BILLING. */
export const ANTIGRAVITY_BILLING = UNIVERSAL_BILLING;

/** Aggregate current-window billable tokens grouped by composite billing bucket. */
export function recentBucketUsage(record: any, now = Date.now()): Map<string, number> {
  resetWindowIfExpired(record, now);
  const out = new Map<string, number>();
  for (const item of record.tokenUsageEvents || []) {
    const billable = billableTokenUsageTotal(item, item?.modelKey);
    const bucket = eventBucket(item);
    out.set(bucket, (out.get(bucket) || 0) + billable);
  }
  return out;
}

/** Check if an account has available credits or unknown status. */
export function accountHasCreditsOrUnknown(account: any): boolean {
  const credits = account?.credits;
  if (!credits || !credits.known) return true;
  return Boolean(credits.available);
}

/** Discounted cached tokens = ceil(count / 10). */
export function discountedCachedTokens(cachedTokens: unknown): number {
  const count = readTokenCount(cachedTokens);
  return count > 0 ? Math.ceil(count / 10) : 0;
}

/**
 * Calculate billable tokens from usage, applying cache discount.
 * Cache hits are discounted to 1/10 their value.
 */
export function billableTokenUsageTotal(usage: any = {}, modelKey = ''): number {
  const inputTokens = readTokenCount(usage.inputTokens);
  const outputTokens = readTokenCount(usage.outputTokens);
  const cachedInputTokens = Math.min(
    inputTokens || Number.MAX_SAFE_INTEGER,
    readTokenCount(usage.cachedInputTokens) || readTokenCount(usage.cachedTokens),
  );
  const rawTotalTokens =
    readTokenCount(usage.rawTotalTokens) ||
    readTokenCount(usage.totalTokenCount) ||
    inputTokens + outputTokens;
  const reportedTotalTokens = readTokenCount(usage.totalTokens);

  let billable: number;
  if (rawTotalTokens > 0 && cachedInputTokens > 0) {
    billable = Math.max(0, rawTotalTokens - cachedInputTokens + discountedCachedTokens(cachedInputTokens));
  } else {
    billable = rawTotalTokens || reportedTotalTokens || inputTokens + outputTokens;
  }
  return billable;
}

// ── Window management ────────────────────────────────────────────────────────

/**
 * Fixed-period window reset: if the current window has expired, clear all
 * usage events and start a new window.
 */
export function resetWindowIfExpired(record: any, now = Date.now()): boolean {
  const windowMs = Number(record.windowMs || DEFAULT_KEY_WINDOW_MS);
  const startedAt = Number(record.windowStartedAt || 0);
  if (startedAt === 0 || now - startedAt >= windowMs) {
    record.windowStartedAt = now;
    record.usageEvents = [];
    record.tokenUsageEvents = [];
    return true;
  }
  return false;
}

/** Get the token window duration in ms. */
export function tokenWindowMs(record: any): number {
  const configured = Number(record?.tokenWindowMs || 0);
  return configured > 0 ? configured : Number(record?.windowMs || DEFAULT_KEY_WINDOW_MS);
}

/** Get the token window limit. */
export function tokenWindowLimit(record: any): number {
  const explicit = Number(
    record?.tokenWindowLimit ?? record?.windowTokenLimit ?? record?.tokenLimit ?? 0,
  );
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const requestLimit = Number(record?.windowLimit || 0);
  return requestLimit > 0 ? Math.floor(requestLimit * DEFAULT_KEY_TOKENS_PER_REQUEST) : 0;
}

/** Aggregate recent token usage within the current window. */
export function recentTokenUsage(record: any, now = Date.now()) {
  resetWindowIfExpired(record, now);
  return (record.tokenUsageEvents || []).reduce(
    (total: any, item: any) => {
      const rawTotal =
        readTokenCount(item?.rawTotalTokens) ||
        readTokenCount(item?.totalTokens) ||
        readTokenCount(item?.inputTokens) + readTokenCount(item?.outputTokens);
      const billable = billableTokenUsageTotal(item, item.modelKey);

      total.inputTokens += readTokenCount(item?.inputTokens);
      total.outputTokens += readTokenCount(item?.outputTokens);
      total.cachedInputTokens +=
        readTokenCount(item?.cachedInputTokens) || readTokenCount(item?.cachedTokens);
      total.rawTotalTokens += rawTotal;
      total.totalTokens += billable;

      if (isGeminiModel(item?.modelKey)) {
        total.geminiRawTokens += rawTotal;
        total.geminiEffectiveTokens += billable;
      } else {
        total.opusRawTokens += rawTotal;
        total.opusEffectiveTokens += billable;
      }
      return total;
    },
    {
      inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
      rawTotalTokens: 0, totalTokens: 0,
      geminiRawTokens: 0, geminiEffectiveTokens: 0,
      opusRawTokens: 0, opusEffectiveTokens: 0,
    },
  );
}

/** Get remaining ms until the current window resets. */
export function tokenWindowResetMs(record: any, now = Date.now()): number {
  resetWindowIfExpired(record, now);
  const startedAt = Number(record.windowStartedAt || 0);
  if (startedAt <= 0) return 0;
  const windowMs = Number(record.windowMs || DEFAULT_KEY_WINDOW_MS);
  return Math.max(0, startedAt + windowMs - now);
}

// ── Weekly window management ─────────────────────────────────────────────────

/** Fixed-period weekly window reset: if the current weekly window has expired,
 *  clear all weekly usage events and start a new window. */
export function resetWeeklyWindowIfExpired(record: any, now = Date.now()): boolean {
  const windowMs = Number(record.weeklyWindowMs || DEFAULT_WEEKLY_WINDOW_MS);
  const startedAt = Number(record.weeklyWindowStartedAt || 0);
  if (startedAt === 0 || now - startedAt >= windowMs) {
    record.weeklyWindowStartedAt = now;
    record.weeklyTokenUsageEvents = [];
    return true;
  }
  return false;
}

/** Get the weekly token window limit. 0 = unlimited. */
export function weeklyTokenLimit(record: any): number {
  const explicit = Number(record?.weeklyTokenLimit ?? 0);
  return Number.isFinite(explicit) && explicit > 0 ? Math.floor(explicit) : 0;
}

/** Get the weekly window duration in ms. */
export function weeklyWindowMs(record: any): number {
  const configured = Number(record?.weeklyWindowMs || 0);
  return configured > 0 ? configured : DEFAULT_WEEKLY_WINDOW_MS;
}

/** Get remaining ms until the weekly window resets. */
export function weeklyWindowResetMs(record: any, now = Date.now()): number {
  resetWeeklyWindowIfExpired(record, now);
  const startedAt = Number(record.weeklyWindowStartedAt || 0);
  if (startedAt <= 0) return 0;
  const windowMs = Number(record.weeklyWindowMs || DEFAULT_WEEKLY_WINDOW_MS);
  return Math.max(0, startedAt + windowMs - now);
}

/** Aggregate weekly-window billable tokens grouped by composite billing bucket. */
export function recentWeeklyBucketUsage(record: any, now = Date.now()): Map<string, number> {
  resetWeeklyWindowIfExpired(record, now);
  const out = new Map<string, number>();
  for (const item of record.weeklyTokenUsageEvents || []) {
    const billable = billableTokenUsageTotal(item, item?.modelKey);
    const bucket = eventBucket(item);
    out.set(bucket, (out.get(bucket) || 0) + billable);
  }
  return out;
}

// ── Key expiration ───────────────────────────────────────────────────────────

/** Compute ISO expiration date from firstUsedAt + durationMs. */
export function keyExpiresAt(record: any): string {
  if (!record?.firstUsedAt) return '';
  const durationMs = Number(record.durationMs || 0);
  if (!durationMs) return '';
  return new Date(Date.parse(record.firstUsedAt) + durationMs).toISOString();
}

// ── Session TTL ──────────────────────────────────────────────────────────────

/** Get session TTL for an access key record. */
export function accessKeySessionTtlMs(record: any): number {
  const configured = Number(record?.sessionTtlMs || 0);
  return configured > 0 ? configured : DEFAULT_KEY_SESSION_TTL_MS;
}

/** Check if an access key session has expired. */
export function isAccessKeySessionExpired(record: any, now = Date.now()): boolean {
  const expiresAt = Date.parse(record?.sessionExpiresAt || '');
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

// ── Client version validation ────────────────────────────────────────────────

/**
 * Validate client version against minimum requirement.
 */
export function validateClientVersion(
  payload: any,
  minClientVersion: string,
): { ok: boolean; statusCode?: number; clientVersion?: string; minClientVersion?: string; upgradeUrl?: string; missingClientVersion?: boolean } {
  if (!minClientVersion) return { ok: true };
  const clientVersion = String(payload?.clientVersion || payload?.version || '').trim();
  if (!clientVersion || compareVersions(clientVersion, minClientVersion) < 0) {
    const missingClientVersion = !clientVersion;
    return {
      ok: false,
      statusCode: missingClientVersion ? 401 : 426,
      missingClientVersion,
      clientVersion,
      minClientVersion,
    };
  }
  return { ok: true, clientVersion };
}

/** Normalize a model key string. */
export function normalizeModelKey(value: unknown): string {
  return String(value || '').trim();
}

/** Create an affinity key from clientId and modelKey. */
export function affinityKey(clientId: string, modelKey: string): string {
  return `${clientId}::${modelKey}`;
}
