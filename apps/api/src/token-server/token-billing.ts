/**
 * token-billing.ts — Token counting, billing calculation, and window management.
 *
 * Extracted from remote-token-server/index.js (L160-L574, L283-L323).
 * All functions are pure — they operate on records passed in, no global state.
 */

import { compareVersions } from './data-store';

// ── Default constants ────────────────────────────────────────────────────────

export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_AFFINITY_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = 1;
export const DEFAULT_KEY_WINDOW_MS = 5 * 60 * 60 * 1000;
export const DEFAULT_KEY_WINDOW_LIMIT = 300;
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
  Number(process.env.BCAI_MAX_REMOTE_LEASE_TTL_MS || 60 * 1000),
);
export const PHONE_VERIFICATION_COOLDOWN_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.BCAI_PHONE_VERIFICATION_COOLDOWN_MS || 24 * 60 * 60 * 1000),
);
export const FIRST_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
export const SECOND_QUOTA_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const MAX_QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const CAPACITY_COOLDOWN_MS = 15 * 1000;
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

/** Detect if a model key refers to a Gemini model. */
export function isGeminiModel(modelKey: unknown): boolean {
  const key = String(modelKey || '').toLowerCase();
  return key.includes('gemini') || key.startsWith('gem');
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
