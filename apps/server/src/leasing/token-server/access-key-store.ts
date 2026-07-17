/**
 * access-key-store.ts — In-memory access key cache with debounced disk persistence.
 *
 * Extracted from remote-token-server/index.js (L325-L868).
 * Encapsulates all access key state: cache, usage recording, and the
 * session-JWT runtime credential resolution (resolveFromRequest).
 */

import * as crypto from 'crypto';
import { readJsonFile, writeJsonFile } from './data-store';
import {
  resetWindowIfExpired,
  resetWeeklyWindowIfExpired,
  tokenWindowMs,
  weeklyTokenLimit,
  weeklyWindowMs as weeklyWindowMsFn,
  weeklyWindowResetMs,
  recentTokenUsage,
  recentBucketUsage,
  recentWeeklyBucketUsage,
  tokenWindowResetMs,
  formatWindowLabel,
  UNIVERSAL_BILLING,
  ProviderBilling,
  keyExpiresAt,
  isAccessKeySessionExpired,
  ACCOUNT_SHARE_CAPACITY,
} from './token-billing';
import {
  bucketFamily,
  bucketsForProducts,
} from '../lease-core/product-bucket';
import {
  looksLikeUserSessionToken,
  missingShadowRecord,
  sessionResolveFailure,
  sessionResolverUnavailable,
  shadowRecordValidationFailure,
  type SessionResolverLike,
} from './session-credential';

export type { SessionResolverLike } from './session-credential';

import {
  requestBucket,
  computeUsageDetail as computeUsageDetailPure,
  bucketUsageInWindow,
  bucketUsageInWindowReadonly,
} from './access-key-limit';
import {
  apiValueUsdForEvent,
  apiValueUsdForEvents,
  usdQuotaForProduct,
  usdQuotaLimit,
  usedUsd5h,
  usedUsdWeekly,
  supportsApiUsdProduct,
  usesUsdQuota,
  usesUsdQuotaForProduct,
} from './api-usd-quota';
import type { ProviderQuotaSnapshotInput } from '../lease-core/provider';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AccessKeyRecord {
  id: string;
  key: string;
  name?: string;
  status?: string;
  firstUsedAt?: string;
  durationMs?: number;
  windowMs?: number;
  /** 每模型(复合桶 `<产品>-<家族>`)token 上限。每卡封顶的唯一来源。 */
  bucketLimits?: Record<string, number>;
  windowStartedAt?: number;
  tokenUsageEvents?: any[];
  /** Weekly (long) window fields — independent second tier of rate limiting. */
  weeklyWindowMs?: number;
  weeklyTokenLimit?: number;
  /** Per-composite-bucket weekly token caps. Takes precedence over weeklyTokenLimit. */
  weeklyBucketLimits?: Record<string, number>;
  weeklyWindowStartedAt?: number;
  weeklyTokenUsageEvents?: any[];
  /** Product-scoped API-equivalent USD caps. Legacy aggregate fields are read during migration only. */
  usdQuotaByProduct?: Record<string, { fiveHour?: number; weekly?: number }>;
  usdUsageByProduct?: Record<string, {
    used5h?: number;
    usedWeekly?: number;
    windowStartedAt5h?: number;
    windowStartedAtWeekly?: number;
    upstreamAccountId?: number;
    upstreamFiveHour?: UsdUpstreamWindowState;
    upstreamWeekly?: UsdUpstreamWindowState;
  }>;
  usdLimit5h?: number;
  usdLimitWeekly?: number;
  quotaAlgorithm?: string;
  usdQuotaProducts?: string[];
  usdUsed5h?: number;
  usdUsedWeekly?: number;
  /** Kept separate from legacy Antigravity token/fair-share windows. */
  usdWindowStartedAt5h?: number;
  usdWindowStartedAtWeekly?: number;
  /** Per-product static binding: { codex?: accountId, antigravity?: accountId }.
   * A card may be sold for one or both pools; each entry pins it to one account
   * in that pool. */
  bindings?: Record<string, number>;
  /** Legacy single-binding fields, still read by boundAccountIdFor as a fallback. */
  provider?: string;
  boundAccountId?: number;
  /** Bind-line subscription shadow records MUST hold a seat (binding) to lease (M13b).
   * Set by entitlement-sync on every sync of a bind-line subscription. If seat
   * assignment failed for EVERY product, the record is binding-less and would
   * otherwise fall through to the broad dynamic POOL in LeaseService.leaseToken —
   * access the subscription never sold. The flag makes the lease path 409 instead.
   * Admin pool cards, pool-line subscriptions, and migrated legacy cards never
   * carry it, so their behavior is unchanged. */
  requiresBinding?: boolean;
  /** ABSOLUTE expiry (ISO) — set on subscription shadow records (mirrors
   * Subscription.expiresAt). Takes priority over firstUsedAt+durationMs in
   * keyExpiresAt(). Regular cards never carry it. */
  keyExpiresAt?: string;
  /** Owning account (Customer.id). Set on subscription shadow records by
   *  entitlement-sync; legacy file/pool cards leave it undefined. Used by
   *  reportResult to stamp CardUsageHourly.customerId. */
  customerId?: string;
  /** Account-internal failover order (mirrors Subscription.priority); lower = used
   *  first. Set on subscription shadow records; legacy cards leave it undefined. */
  priority?: number;
  /** Card-migration provenance: set when a legacy card was re-homed to a
   * customer Subscription (bind-card). The record keeps its id (usage/windows
   * carry over); its key is rotated to the subscription's backing key. */
  migratedToCustomerId?: string;
  migratedAt?: string;
  /** Old card key kept for idempotent re-bind lookups ONLY — the byKey auth
   * index is built from `key`, so this value can no longer authenticate. */
  migratedFromKey?: string;
  lastUsedAt?: string;
  activeSessionId?: string;
  sessionClientId?: string;
  sessionStartedAt?: string;
  sessionLastSeenAt?: string;
  sessionExpiresAt?: string;
  sessionTtlMs?: number;
  [k: string]: unknown;
}

export type UsdUpstreamWindowState = {
  /** Whether the upstream explicitly reports that this window exists. */
  present?: boolean;
  /** End of the currently observed upstream epoch. */
  resetAt?: number;
  /** resetAt already consumed by the local natural-expiry path. */
  appliedResetAt?: number;
  lowFraction?: number;
  observedAt?: number;
  lastSnapshotId?: string;
  /** Last server-proven refill/reset event applied to this local window. */
  appliedResetEventId?: string;
  reboundCandidateCount?: number;
  /** Natural expiry already opened a new local epoch; next fraction is baseline. */
  baselinePending?: boolean;
  /** Rebinding must establish one baseline without inheriting a reset that
   * happened before this subscription moved to the new mother account. */
  baselineReason?: 'rebind';
};

export type UpstreamUsdQuotaSnapshotMeta = {
  observedAt?: number;
  arrivedAt?: number;
  snapshotId?: string;
  /** Trusted reset epochs observed before this snapshot. A forward move from
   * one of these epochs proves a rollover even when the subscription has not
   * yet established its own upstream baseline. */
  previousResetAtByScope?: Partial<Record<'fiveHour' | 'weekly', number>>;
  /** Remaining fractions captured from the persisted mother account before
   * this snapshot overwrote it. A sufficiently large recovery of the consumed
   * share is trusted reset evidence even when resetAt is unchanged. */
  previousFractionByScope?: Partial<Record<'fiveHour' | 'weekly', number>>;
};

export interface AccessKeysData {
  keys: AccessKeyRecord[];
  updatedAt: string;
}

export interface ResolveResult {
  key: string;
  record: AccessKeyRecord | null;
  data?: AccessKeysData;
  error?: string;
  /** 超额(模型/周配额用尽)时为 true,调用方应回 429 而非 401。 */
  limitExceeded?: boolean;
  /** 配额用尽时距窗口重置的毫秒数,用于 Retry-After。 */
  resetMs?: number;
  /** True when the request authenticated with a customer session JWT (the
   * record is a subscription shadow record). Callers skip the per-card
   * single-session machinery for these — multi-device is governed by Device
   * rows + Subscription.deviceLimit instead. */
  viaSession?: boolean;
  /** Machine-readable session failure (SESSION_INVALID / DEVICE_REVOKED /
   * SUBSCRIPTION_EXPIRED) for the client's fatal-error matching. */
  sessionError?: { statusCode: number; code: string };
}

const UPSTREAM_RESET_DRIFT_MS = 60_000;
const UPSTREAM_REBOUND_RECOVERY_RATIO = 0.5;
const UPSTREAM_REBOUND_CONFIRMATIONS = 2;
const FRACTION_EPSILON = 1e-9;

/**
 * USD quota amounts are fixed per subscription share. Only their reset epochs
 * follow the bound upstream account. Before the first credible upstream sample,
 * the historical usage-anchored window remains as a migration fallback.
 */
function usdProductKey(product: unknown): string {
  return String(product || '').trim().toLowerCase();
}

function upstreamWindowState(
  record: AccessKeyRecord,
  product: unknown,
  scope: 'fiveHour' | 'weekly',
  create = false,
): UsdUpstreamWindowState | null {
  const usage = usdProductUsage(record, product, create);
  if (!usage) return null;
  const field = scope === 'fiveHour' ? 'upstreamFiveHour' : 'upstreamWeekly';
  if (!usage[field] && create) usage[field] = {};
  return usage[field] ?? null;
}

function clearUsdScopeUsage(
  record: AccessKeyRecord,
  product: unknown,
  scope: 'fiveHour' | 'weekly',
): void {
  const state = usdProductUsage(record, product);
  if (state) {
    if (scope === 'fiveHour') {
      state.windowStartedAt5h = undefined;
      state.used5h = undefined;
    } else {
      state.windowStartedAtWeekly = undefined;
      state.usedWeekly = undefined;
    }
    return;
  }
  if (scope === 'fiveHour') {
    record.usdWindowStartedAt5h = undefined;
    if (!Array.isArray(record.usdQuotaProducts)) record.windowStartedAt = undefined;
    record.usdUsed5h = undefined;
  } else {
    record.usdWindowStartedAtWeekly = undefined;
    if (!Array.isArray(record.usdQuotaProducts)) record.weeklyWindowStartedAt = undefined;
    record.usdUsedWeekly = undefined;
  }
}

function startUsdScopeAt(
  record: AccessKeyRecord,
  product: unknown,
  scope: 'fiveHour' | 'weekly',
  startedAt: number,
): void {
  const usage = usdProductUsage(record, product, true);
  if (!usage || !(startedAt > 0)) return;
  if (scope === 'fiveHour') usage.windowStartedAt5h = startedAt;
  else usage.windowStartedAtWeekly = startedAt;
}

function resetUpstreamObservation(
  record: AccessKeyRecord,
  product: unknown,
  baselineReason?: 'rebind',
): void {
  const usage = usdProductUsage(record, product);
  if (!usage) return;
  usage.upstreamAccountId = undefined;
  usage.upstreamFiveHour = baselineReason ? { baselineReason } : undefined;
  usage.upstreamWeekly = baselineReason ? { baselineReason } : undefined;
}

function normalizeObservedAt(value: unknown, fallback: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  // Accept both Unix seconds and milliseconds from older clients.
  return raw < 10_000_000_000 ? raw * 1000 : raw;
}

function normalizeRemainingFraction(percent: unknown): number | null {
  if (percent === null || percent === undefined) return null;
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.max(0, Math.min(1, value / 100));
}

function applyUpstreamWindowSnapshot(
  record: AccessKeyRecord,
  product: string,
  scope: 'fiveHour' | 'weekly',
  sample: {
    present?: boolean;
    fraction: number | null;
    resetAt?: number;
    trustedPreviousResetAt?: number;
    trustedResetEventId?: string;
  },
  meta: { observedAt: number; snapshotId: string },
): boolean {
  const state = upstreamWindowState(record, product, scope, true)!;
  const previousObservedAt = Number(state.observedAt || 0);
  if (meta.snapshotId && state.lastSnapshotId === meta.snapshotId) return false;
  if (previousObservedAt > 0 && meta.observedAt < previousObservedAt) return false;

  const previousResetAt = Number(state.resetAt || 0);
  const incomingResetAt = Number(sample.resetAt || 0);
  if (incomingResetAt > 0 && previousResetAt > 0
    && incomingResetAt + UPSTREAM_RESET_DRIFT_MS < previousResetAt) {
    // A backward reset epoch is an out-of-order upstream sample. Do not let its
    // high fraction masquerade as a reset rebound.
    return false;
  }

  const commitMeta = () => {
    state.observedAt = meta.observedAt;
    state.lastSnapshotId = meta.snapshotId || undefined;
  };
  const clearCandidate = () => {
    state.reboundCandidateCount = undefined;
  };
  const baselineFraction = () => {
    state.lowFraction = sample.fraction ?? undefined;
    state.baselinePending = undefined;
    state.baselineReason = undefined;
    clearCandidate();
  };

  if (sample.present === false) {
    clearUsdScopeUsage(record, product, scope);
    state.present = false;
    state.resetAt = undefined;
    state.appliedResetAt = undefined;
    state.lowFraction = undefined;
    state.baselinePending = undefined;
    state.baselineReason = undefined;
    state.appliedResetEventId = undefined;
    clearCandidate();
    commitMeta();
    return true;
  }

  const restored = state.present === false && sample.present === true;
  if (sample.present === true) state.present = true;
  if (restored) {
    // Explicit upstream window restoration starts a fresh local epoch, but is
    // isolated to this scope (5h restoration cannot touch weekly, and vice versa).
    clearUsdScopeUsage(record, product, scope);
    startUsdScopeAt(record, product, scope, meta.observedAt);
    state.resetAt = incomingResetAt || undefined;
    state.appliedResetAt = undefined;
    state.appliedResetEventId = undefined;
    baselineFraction();
    commitMeta();
    return true;
  }

  const trustedResetEventId = String(sample.trustedResetEventId || '');
  if (trustedResetEventId && state.appliedResetEventId !== trustedResetEventId) {
    // Anthropic can refill every account in-place while leaving the next
    // scheduled resetAt unchanged. The caller only supplies this event after it
    // observed a sufficiently large recovery from the persisted mother-account
    // low water mark, so it is safe to bypass both the rollout baseline and the
    // generic two-sample rebound guard. Persisting the id makes retries idempotent.
    clearUsdScopeUsage(record, product, scope);
    startUsdScopeAt(record, product, scope, meta.observedAt);
    state.resetAt = incomingResetAt || previousResetAt || undefined;
    state.appliedResetAt = undefined;
    baselineFraction();
    state.appliedResetEventId = trustedResetEventId;
    commitMeta();
    return true;
  }

  const firstCredibleSample = previousObservedAt <= 0
    && previousResetAt <= 0
    && state.lowFraction === undefined;
  const trustedPreviousResetAt = Number(sample.trustedPreviousResetAt || 0);
  const trustedForwardReset = previousResetAt <= 0
    && state.baselineReason !== 'rebind'
    && trustedPreviousResetAt > 0
    && incomingResetAt > trustedPreviousResetAt + UPSTREAM_RESET_DRIFT_MS;
  if (trustedForwardReset) {
    // The subscription has no upstream baseline yet, but the mother-account
    // refresh observed both sides of the epoch transition. That evidence is
    // stronger than the rollout guard below: keeping historical usage here
    // would strand the old epoch under the new resetAt forever.
    clearUsdScopeUsage(record, product, scope);
    startUsdScopeAt(record, product, scope, meta.observedAt);
    state.resetAt = incomingResetAt;
    baselineFraction();
    commitMeta();
    return true;
  }
  if (firstCredibleSample) {
    // Smooth rollout: establish the mother-account epoch without gifting a
    // reset to subscriptions that already carry historical usage.
    state.resetAt = incomingResetAt || undefined;
    baselineFraction();
    commitMeta();
    return true;
  }

  if (incomingResetAt > previousResetAt + UPSTREAM_RESET_DRIFT_MS && previousResetAt > 0) {
    // If natural expiry already consumed the old epoch, advancing resetAt is
    // merely confirmation of the same rollover and must not clear twice.
    if (Number(state.appliedResetAt || 0) !== previousResetAt) {
      clearUsdScopeUsage(record, product, scope);
    }
    // The first trusted observation of the advanced epoch is the earliest
    // boundary we can prove locally. Using resetAt-duration can point into the
    // future when an upstream rolling window extends its resetAt, dropping the
    // very request that carried the reset snapshot.
    startUsdScopeAt(record, product, scope, meta.observedAt);
    state.resetAt = incomingResetAt;
    baselineFraction();
    commitMeta();
    return true;
  }
  if (incomingResetAt > previousResetAt) state.resetAt = incomingResetAt;

  if (state.baselinePending) {
    baselineFraction();
    commitMeta();
    return true;
  }

  const fraction = sample.fraction;
  if (fraction === null) {
    commitMeta();
    return true;
  }
  const previousLow = Number(state.lowFraction);
  if (!Number.isFinite(previousLow)) {
    baselineFraction();
    commitMeta();
    return true;
  }

  if (fraction <= previousLow + FRACTION_EPSILON) {
    state.lowFraction = Math.min(previousLow, fraction);
    clearCandidate();
    commitMeta();
    return true;
  }

  const consumed = 1 - previousLow;
  const recovered = fraction - previousLow;
  const recoveryRatio = consumed > FRACTION_EPSILON ? recovered / consumed : 0;
  if (recoveryRatio + FRACTION_EPSILON < UPSTREAM_REBOUND_RECOVERY_RATIO) {
    clearCandidate();
    commitMeta();
    return true;
  }

  state.reboundCandidateCount = Math.max(0, Number(state.reboundCandidateCount) || 0) + 1;
  if (state.reboundCandidateCount >= UPSTREAM_REBOUND_CONFIRMATIONS) {
    clearUsdScopeUsage(record, product, scope);
    startUsdScopeAt(record, product, scope, meta.observedAt);
    state.lowFraction = fraction;
    clearCandidate();
  }
  commitMeta();
  return true;
}

function resetAtMs(value: Date | null | undefined): number | undefined {
  const ms = value instanceof Date ? value.getTime() : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function isUsdScopeActive(
  record: AccessKeyRecord,
  product: unknown,
  scope: 'fiveHour' | 'weekly',
): boolean {
  return upstreamWindowState(record, product, scope)?.present !== false;
}

function usdProductUsage(record: AccessKeyRecord, product: unknown, create = false) {
  const key = usdProductKey(product);
  if (!key || !record.usdQuotaByProduct?.[key]) return null;
  if (!record.usdUsageByProduct && create) record.usdUsageByProduct = {};
  if (!record.usdUsageByProduct?.[key] && create) record.usdUsageByProduct![key] = {};
  return record.usdUsageByProduct?.[key] ?? null;
}

function usedUsd5hForProduct(record: AccessKeyRecord, product: unknown): number {
  const state = usdProductUsage(record, product);
  return state ? Math.max(0, Number(state.used5h) || 0) : usedUsd5h(record);
}

function usedUsdWeeklyForProduct(record: AccessKeyRecord, product: unknown): number {
  const state = usdProductUsage(record, product);
  return state ? Math.max(0, Number(state.usedWeekly) || 0) : usedUsdWeekly(record);
}

function usd5hStartedAt(record: AccessKeyRecord, product: unknown = ''): number {
  const state = usdProductUsage(record, product);
  if (state) return Number(state.windowStartedAt5h || 0);
  return Number(record.usdWindowStartedAt5h
    || (!Array.isArray(record.usdQuotaProducts) ? record.windowStartedAt : 0)
    || 0);
}

function usdWeeklyStartedAt(record: AccessKeyRecord, product: unknown = ''): number {
  const state = usdProductUsage(record, product);
  if (state) return Number(state.windowStartedAtWeekly || 0);
  return Number(record.usdWindowStartedAtWeekly
    || (!Array.isArray(record.usdQuotaProducts) ? record.weeklyWindowStartedAt : 0)
    || 0);
}

function expireUsd5hWindow(record: AccessKeyRecord, now: number, product: unknown = ''): void {
  const upstream = upstreamWindowState(record, product, 'fiveHour');
  if (upstream?.present === false) {
    clearUsdScopeUsage(record, product, 'fiveHour');
    return;
  }
  const upstreamResetAt = Number(upstream?.resetAt || 0);
  if (upstreamResetAt > 0 && now >= upstreamResetAt
    && Number(upstream?.appliedResetAt || 0) !== upstreamResetAt) {
    clearUsdScopeUsage(record, product, 'fiveHour');
    upstream!.appliedResetAt = upstreamResetAt;
    upstream!.baselinePending = true;
    upstream!.reboundCandidateCount = undefined;
    return;
  }
  const startedAt = usd5hStartedAt(record, product);
  // Once an upstream epoch is known and still current, it is authoritative.
  if (upstreamResetAt > now) return;
  if (startedAt > 0 && now - startedAt >= tokenWindowMs(record)) {
    clearUsdScopeUsage(record, product, 'fiveHour');
    if (upstream) upstream.baselinePending = true;
  }
}

function expireUsdWeeklyWindow(record: AccessKeyRecord, now: number, product: unknown = ''): void {
  const upstream = upstreamWindowState(record, product, 'weekly');
  if (upstream?.present === false) {
    clearUsdScopeUsage(record, product, 'weekly');
    return;
  }
  const upstreamResetAt = Number(upstream?.resetAt || 0);
  if (upstreamResetAt > 0 && now >= upstreamResetAt
    && Number(upstream?.appliedResetAt || 0) !== upstreamResetAt) {
    clearUsdScopeUsage(record, product, 'weekly');
    upstream!.appliedResetAt = upstreamResetAt;
    upstream!.baselinePending = true;
    upstream!.reboundCandidateCount = undefined;
    return;
  }
  const startedAt = usdWeeklyStartedAt(record, product);
  if (upstreamResetAt > now) return;
  if (startedAt > 0 && now - startedAt >= weeklyWindowMsFn(record)) {
    clearUsdScopeUsage(record, product, 'weekly');
    if (upstream) upstream.baselinePending = true;
  }
}

function usd5hResetMs(record: AccessKeyRecord, now: number, product: unknown = ''): number {
  const upstream = upstreamWindowState(record, product, 'fiveHour');
  if (upstream?.present === false) return 0;
  const upstreamResetAt = Number(upstream?.resetAt || 0);
  if (upstreamResetAt > now) return upstreamResetAt - now;
  const startedAt = usd5hStartedAt(record, product);
  return startedAt > 0 ? Math.max(0, startedAt + tokenWindowMs(record) - now) : 0;
}

function usdWeeklyResetMs(record: AccessKeyRecord, now: number, product: unknown = ''): number {
  const upstream = upstreamWindowState(record, product, 'weekly');
  if (upstream?.present === false) return 0;
  const upstreamResetAt = Number(upstream?.resetAt || 0);
  if (upstreamResetAt > now) return upstreamResetAt - now;
  const startedAt = usdWeeklyStartedAt(record, product);
  return startedAt > 0 ? Math.max(0, startedAt + weeklyWindowMsFn(record) - now) : 0;
}

/**
 * Decide whether a delayed report belongs to the currently active local USD
 * epoch. A report completed before an upstream rollover must not consume the
 * newly-opened personal window merely because its retry arrived afterwards.
 */
function usdEventBelongsToCurrentScope(
  record: AccessKeyRecord,
  product: unknown,
  scope: 'fiveHour' | 'weekly',
  occurredAt: number,
  now: number,
): boolean {
  const upstream = upstreamWindowState(record, product, scope);
  if (upstream?.present === false) return false;
  const duration = scope === 'fiveHour' ? tokenWindowMs(record) : weeklyWindowMsFn(record);
  const upstreamResetAt = Number(upstream?.resetAt || 0);
  if (upstreamResetAt > now) {
    const startedAt = scope === 'fiveHour'
      ? usd5hStartedAt(record, product)
      : usdWeeklyStartedAt(record, product);
    return occurredAt >= (startedAt > 0 ? startedAt : upstreamResetAt - duration)
      && occurredAt < upstreamResetAt;
  }
  if (upstreamResetAt > 0 && Number(upstream?.appliedResetAt || 0) === upstreamResetAt) {
    return occurredAt >= upstreamResetAt;
  }
  const startedAt = scope === 'fiveHour'
    ? usd5hStartedAt(record, product)
    : usdWeeklyStartedAt(record, product);
  if (startedAt > 0) return occurredAt >= startedAt && occurredAt < startedAt + duration;
  return occurredAt >= now - duration;
}

function hasLegacyQuotaProduct(record: Partial<AccessKeyRecord>): boolean {
  const products = Array.isArray((record as any).products)
    ? (record as any).products
    : Object.keys(record.bindings && typeof record.bindings === 'object' ? record.bindings : {});
  return products.some((product: unknown) => !supportsApiUsdProduct(product));
}

// Per-product USD weights from legacy window events. Each event carries the
// product it was billed under (recordUsage stamps `product`), so we can value
// events grouped by their REAL product instead of guessing. Products outside the
// quota set (or unpriceable, e.g. antigravity → $0) contribute nothing.
function usdUsageWeightsByProduct(
  events: unknown,
  products: string[],
): { weights: Record<string, number>; total: number } {
  const weights: Record<string, number> = {};
  let total = 0;
  if (Array.isArray(events)) {
    for (const event of events) {
      const product = String((event as { product?: unknown } | null)?.product || '');
      if (!products.includes(product)) continue;
      const value = apiValueUsdForEvent(event);
      if (!(value > 0)) continue;
      weights[product] = (weights[product] || 0) + value;
      total += value;
    }
  }
  return { weights, total };
}

// Convert a token-era window snapshot into per-product USD usage. The used-USD
// aggregate is apportioned by each product's ACTUAL consumption (from the window
// events); a limit-ratio split is only the fallback when no attributable events
// survive (e.g. only a bare aggregate number was persisted). Splitting purely by
// limit ratio mis-throttled multi-product subs on first boot after rollout —
// e.g. spend entirely on Anthropic showed up partly as phantom Codex usage.
function splitLegacyUsdUsage(
  record: AccessKeyRecord,
  quotas: Record<string, { fiveHour?: number; weekly?: number }>,
  events5h?: unknown,
  eventsWeekly?: unknown,
): NonNullable<AccessKeyRecord['usdUsageByProduct']> {
  const products = Object.keys(quotas);
  const total5hLimit = products.reduce((sum, product) => sum + usdQuotaLimit(quotas[product]?.fiveHour), 0);
  const totalWeeklyLimit = products.reduce((sum, product) => sum + usdQuotaLimit(quotas[product]?.weekly), 0);
  const used5h = usedUsd5h(record);
  const usedWeekly = usedUsdWeekly(record);
  const started5h = usd5hStartedAt(record);
  const startedWeekly = usdWeeklyStartedAt(record);
  const weights5h = usdUsageWeightsByProduct(events5h, products);
  const weightsWeekly = usdUsageWeightsByProduct(eventsWeekly, products);
  const share = (
    product: string,
    used: number,
    weights: { weights: Record<string, number>; total: number },
    limit: number,
    totalLimit: number,
  ): number => {
    if (!(used > 0)) return 0;
    if (weights.total > 0) return used * (weights.weights[product] || 0) / weights.total;
    return totalLimit > 0 ? used * limit / totalLimit : 0;
  };
  return Object.fromEntries(products.map((product) => {
    const limit5h = usdQuotaLimit(quotas[product]?.fiveHour);
    const limitWeekly = usdQuotaLimit(quotas[product]?.weekly);
    return [product, {
      used5h: share(product, used5h, weights5h, limit5h, total5hLimit),
      usedWeekly: share(product, usedWeekly, weightsWeekly, limitWeekly, totalWeeklyLimit),
      windowStartedAt5h: started5h || undefined,
      windowStartedAtWeekly: startedWeekly || undefined,
    }];
  }));
}

function openUsd5hWindow(record: AccessKeyRecord, now: number, product: unknown = ''): void {
  expireUsd5hWindow(record, now, product);
  const state = usdProductUsage(record, product, true);
  if (state) {
    if (!(Number(state.windowStartedAt5h || 0) > 0)) {
      state.windowStartedAt5h = now;
      if (!Number.isFinite(Number(state.used5h))) state.used5h = 0;
    }
    return;
  }
  if (!(Number(record.usdWindowStartedAt5h || 0) > 0)) {
    record.usdWindowStartedAt5h = usd5hStartedAt(record) || now;
    if (!Array.isArray(record.usdQuotaProducts)) record.windowStartedAt = record.usdWindowStartedAt5h;
    if (!Number.isFinite(Number(record.usdUsed5h))) record.usdUsed5h = 0;
  }
}

function openUsdWeeklyWindow(record: AccessKeyRecord, now: number, product: unknown = ''): void {
  expireUsdWeeklyWindow(record, now, product);
  const state = usdProductUsage(record, product, true);
  if (state) {
    if (!(Number(state.windowStartedAtWeekly || 0) > 0)) {
      state.windowStartedAtWeekly = now;
      if (!Number.isFinite(Number(state.usedWeekly))) state.usedWeekly = 0;
    }
    return;
  }
  if (!(Number(record.usdWindowStartedAtWeekly || 0) > 0)) {
    record.usdWindowStartedAtWeekly = usdWeeklyStartedAt(record) || now;
    if (!Array.isArray(record.usdQuotaProducts)) record.weeklyWindowStartedAt = record.usdWindowStartedAtWeekly;
    if (!Number.isFinite(Number(record.usdUsedWeekly))) record.usdUsedWeekly = 0;
  }
}

// ── AccessKeyStore ───────────────────────────────────────────────────────────

// Hard cap on the per-card reportId dedup ring (bounds access-keys.json size on
// very busy cards; the ring is also cleared on window reset / pruned in flush).
const MAX_RECENT_REPORT_IDS = 5000;

export class AccessKeyStore {
  private cache: AccessKeysData | null = null;
  private dirty = false;
  // In-memory compatibility dedup: cardId → (reportId → seenAt). Durable quota
  // paths additionally persist QuotaReportReceipt atomically with accounting;
  // this bounded ring protects direct/legacy callers without growing JSON state.
  private reportDedup = new Map<string, Map<string, number>>();
  // Serializes report mutation + durable checkpoint for the same session
  // credential. The store is shared by every product service, so Codex and
  // Anthropic reports for one subscription cannot overwrite each other's
  // Subscription.windowState snapshots.
  private usageReportChains = new Map<string, Promise<void>>();
  // O(1) lookup indexes over cache.keys, rebuilt whenever the cache is (re)loaded.
  // Card membership only changes via (re)load — recordUsage/session updates mutate
  // records in place, so these stay valid without per-write maintenance.
  // byKey is keyed by sha256(key), not the raw key: an O(1) hash lookup preserves
  // the timing-attack resistance the previous constantTimeEqual scan gave (no
  // early-exit byte comparison against the stored secret).
  private byId = new Map<string, AccessKeyRecord>();
  private byKey = new Map<string, AccessKeyRecord>();
  // 去影子:订阅 record 独立于文件 cache —— 不进 access-keys.json,reload 碰不到它们。
  private subscriptionById = new Map<string, AccessKeyRecord>();
  private subscriptionByBackingKey = new Map<string, AccessKeyRecord>();
  // 启动屏障:订阅表尚未成功加载时,成员对账不得用「只有文件卡」的残缺名单覆盖
  // 旧账本。默认 true —— 只有真正负责加载订阅的进程(TokenServerService 持有
  // prisma 时)才拉起屏障,单测/fixture 不受影响。
  private subscriptionsReady = true;
  private subscriptionsReadyCallbacks: Array<() => void | Promise<void>> = [];

  constructor(
    private readonly filePath: string,
    private readonly billing: ProviderBilling = UNIVERSAL_BILLING,
    private readonly now: () => number = Date.now,
  ) {}

  // ── Subscription readiness barrier ───────────────────────────────────────

  /** Arm the barrier before the first subscription load attempt. */
  beginSubscriptionBarrier(): void {
    this.subscriptionsReady = false;
  }

  areSubscriptionsReady(): boolean {
    return this.subscriptionsReady;
  }

  /** Release only after every deferred membership checkpoint is durable. */
  async markSubscriptionsReady(): Promise<void> {
    if (this.subscriptionsReady) return;
    while (this.subscriptionsReadyCallbacks.length > 0) {
      const callbacks = this.subscriptionsReadyCallbacks.splice(0);
      try {
        await Promise.all(callbacks.map((callback) => callback()));
      } catch (error) {
        // Re-run idempotent reconciliation on the next subscription retry.
        this.subscriptionsReadyCallbacks.unshift(...callbacks);
        throw error;
      }
    }
    this.subscriptionsReady = true;
  }

  /** Run now if ready, otherwise once when the barrier releases. */
  onSubscriptionsReady(callback: () => void | Promise<void>): void {
    if (this.subscriptionsReady) { void callback(); return; }
    this.subscriptionsReadyCallbacks.push(callback);
  }

  // ── Read / Write ─────────────────────────────────────────────────────────

  readAll(): AccessKeysData {
    if (!this.cache) {
      const parsed = readJsonFile(this.filePath);
      this.cache = {
        keys: Array.isArray(parsed.keys) ? parsed.keys : [],
        updatedAt: parsed.updatedAt || '',
      };
      this.rebuildIndex();
    }
    return this.cache;
  }

  /** sha256 hex of a key value — the byKey index key (see field comment). */
  private keyHash(value: string): string {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
  }

  async withUsageReportLock<T>(identity: string, task: () => Promise<T>): Promise<T> {
    const lockKey = this.keyHash(identity || '__missing-identity__');
    const previous = this.usageReportChains.get(lockKey) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.usageReportChains.set(lockKey, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.usageReportChains.get(lockKey) === tail) this.usageReportChains.delete(lockKey);
    }
  }

  // 周上限【只认显式配置】(QUOTA-REDESIGN 决策5):weeklyBucketLimits[bucket] > weeklyTokenLimit。
  // 「cap5h × R 自动派生」整套删除 —— 单一全局倍率 R 无法把 5h 正确换算成周(真实比 3~30
  // 因人而异),那是「周额度纯靠猜」的病根。没配显式周上限的卡,周维度不再有派生封顶。
  private weeklyBucketCap(record: AccessKeyRecord, bucket: string): number {
    const weeklyBucketLimits = record.weeklyBucketLimits && typeof record.weeklyBucketLimits === 'object'
      ? record.weeklyBucketLimits as Record<string, number>
      : {};
    const explicitBucketWeekly = Number(weeklyBucketLimits[bucket] || 0);
    if (explicitBucketWeekly > 0) return explicitBucketWeekly;

    const explicitWeekly = weeklyTokenLimit(record);
    if (explicitWeekly > 0) return this.billing.bucketLimit(explicitWeekly, bucket);

    return 0;
  }

  /** Rebuild byId/byKey from the current cache. Called after every (re)load. */
  private rebuildIndex(): void {
    this.byId.clear();
    this.byKey.clear();
    if (!this.cache) return;
    for (const k of this.cache.keys) {
      if (!k) continue;
      if (k.id) this.byId.set(k.id, k);
      if (k.key) this.byKey.set(this.keyHash(k.key), k);
    }
  }

  /**
   * Reload cache from disk (e.g., after an admin card edit writes the file).
   * Token window events are no longer persisted to access-keys.json (see
   * serializable()), so they are carried over in memory for cards that still exist by id —
   * otherwise every admin edit (which triggers reload) would reset all rate-limit
   * windows. Subscription windows survive restarts through Subscription.windowState;
   * retired file cards retain only this in-process compatibility behavior.
   */
  reload(): void {
    const carry = new Map<string, Pick<AccessKeyRecord,
      'tokenUsageEvents' | 'weeklyTokenUsageEvents'>>();
    if (this.cache) {
      for (const k of this.cache.keys) {
        if (!k?.id) continue;
        carry.set(k.id, {
          tokenUsageEvents: k.tokenUsageEvents,
          weeklyTokenUsageEvents: k.weeklyTokenUsageEvents,
        });
      }
    }
    this.cache = null;
    this.readAll();
    for (const k of this.cache!.keys) {
      const prev = k?.id ? carry.get(k.id) : undefined;
      if (!prev) continue;
      if (prev.tokenUsageEvents) k.tokenUsageEvents = prev.tokenUsageEvents;
      if (prev.weeklyTokenUsageEvents) k.weeklyTokenUsageEvents = prev.weeklyTokenUsageEvents;
    }
    // 订阅 record 在 subscriptionById(独立于文件),reload 天然不碰,无需任何保留逻辑。
  }

  /**
   * 去影子:把 DB 订阅的配置 record 注册进内存(cache + byId),不写 access-keys.json。
   * 已存在同 id(老卡密影子或已注册)→ 只刷新配置字段、保留用量/窗口状态(配置变更
   * 绝不能清零限额)。boot 批量加载 + 订阅激活时调用,使限额引擎无需文件影子即可服务订阅。
   */
  loadSubscriptionRecords(records: Array<Partial<AccessKeyRecord> & { id: string }>): void {
    for (const rec of records) {
      if (!rec?.id) continue;
      const existing = this.subscriptionById.get(rec.id);
      if (existing) {
        // 已存在 → 只刷新配置,保留用量/窗口状态(配置变更绝不能清零限额)。
        const incomingUsd = usesUsdQuota(rec);
        const existingUsd = usesUsdQuota(existing);
        const usdManaged = incomingUsd || existingUsd;
        // Historical records may carry a zero-valued USD placeholder written by
        // an older reset path. On the one-way legacy → USD transition, the real
        // source is the current token-event window, never that placeholder.
        const transitioningToUsd = incomingUsd && !existingUsd;
        const incomingProductQuotas = rec.usdQuotaByProduct && typeof rec.usdQuotaByProduct === 'object'
          ? rec.usdQuotaByProduct
          : null;
        const trackUsd5h = usdQuotaLimit(rec.usdLimit5h) > 0;
        const trackUsdWeekly = usdQuotaLimit(rec.usdLimitWeekly) > 0;
        const keepLegacy = hasLegacyQuotaProduct(rec);
        const legacyUsdWindowFallback = !Array.isArray(existing.usdQuotaProducts);
        const productUsage = incomingProductQuotas
          ? existing.usdUsageByProduct
            ? Object.fromEntries(Object.keys(incomingProductQuotas).map((product) => [
              product,
              existing.usdUsageByProduct?.[product] || {},
            ]))
            : splitLegacyUsdUsage(existing, incomingProductQuotas)
          : undefined;
        if (productUsage) {
          for (const product of Object.keys(productUsage)) {
            const previousAccountId = this.boundAccountIdFor(existing, product);
            const incomingAccountId = this.boundAccountIdFor(rec as AccessKeyRecord, product);
            if (previousAccountId !== incomingAccountId) {
              resetUpstreamObservation({
                ...existing,
                usdUsageByProduct: productUsage,
              }, product, 'rebind');
              productUsage[product].upstreamAccountId = incomingAccountId > 0
                ? incomingAccountId
                : undefined;
            }
          }
        }
        const usage = usdManaged ? {
          tokenUsageEvents: keepLegacy ? existing.tokenUsageEvents : [],
          weeklyTokenUsageEvents: keepLegacy ? existing.weeklyTokenUsageEvents : [],
          usdUsageByProduct: productUsage,
          usdUsed5h: incomingProductQuotas ? undefined : trackUsd5h
            ? transitioningToUsd
              ? apiValueUsdForEvents(existing.tokenUsageEvents)
              : usedUsd5h(existing)
            : undefined,
          usdUsedWeekly: incomingProductQuotas ? undefined : trackUsdWeekly
            ? transitioningToUsd
              ? apiValueUsdForEvents(existing.weeklyTokenUsageEvents)
              : usedUsdWeekly(existing)
            : undefined,
          usdWindowStartedAt5h: incomingProductQuotas ? undefined : trackUsd5h
            ? transitioningToUsd || legacyUsdWindowFallback
              ? existing.windowStartedAt
              : existing.usdWindowStartedAt5h
            : undefined,
          usdWindowStartedAtWeekly: incomingProductQuotas ? undefined : trackUsdWeekly
            ? transitioningToUsd || legacyUsdWindowFallback
              ? existing.weeklyWindowStartedAt
              : existing.usdWindowStartedAtWeekly
            : undefined,
          windowStartedAt: keepLegacy ? existing.windowStartedAt : undefined,
          weeklyWindowStartedAt: keepLegacy ? existing.weeklyWindowStartedAt : undefined,
          firstUsedAt: existing.firstUsedAt,
        } : {
          tokenUsageEvents: existing.tokenUsageEvents,
          weeklyTokenUsageEvents: existing.weeklyTokenUsageEvents,
          windowStartedAt: existing.windowStartedAt,
          weeklyWindowStartedAt: existing.weeklyWindowStartedAt,
          firstUsedAt: existing.firstUsedAt,
        };
        Object.assign(existing, rec, usage);
      } else {
        this.subscriptionById.set(rec.id, { ...rec } as AccessKeyRecord);
      }
    }
    // 重建 backingKeyValue → record 索引(findByKey 认订阅卡)
    this.subscriptionByBackingKey.clear();
    for (const rec of this.subscriptionById.values()) {
      if (rec.key) this.subscriptionByBackingKey.set(this.keyHash(rec.key), rec);
    }
  }

  /**
   * 从持久化快照(Subscription.windowState)精准恢复某订阅 record 的 5h/周窗口
   * (起点 + 窗口内事件)。重启直接恢复,替代旧的从用量日志回放。
   * stateJson 解析失败/无 record → 安静跳过(冷启动兜底)。
   */
  restoreSubscriptionWindow(id: string, stateJson: string | null | undefined): void {
    if (!id || !stateJson) return;
    const rec = this.subscriptionById.get(id);
    if (!rec) return;
    let s: any;
    try { s = JSON.parse(stateJson); } catch { return; }
    if (!s || typeof s !== "object") return;
    const keepLegacy = !usesUsdQuota(rec) || hasLegacyQuotaProduct(rec);
    rec.windowStartedAt = keepLegacy ? Number(s.windowStartedAt || 0) || undefined : undefined;
    rec.weeklyWindowStartedAt = keepLegacy ? Number(s.weeklyWindowStartedAt || 0) || undefined : undefined;
    if (usesUsdQuota(rec)) {
      if (rec.usdQuotaByProduct) {
        if (s.usdUsageByProduct && typeof s.usdUsageByProduct === 'object') {
          rec.usdUsageByProduct = Object.fromEntries(Object.keys(rec.usdQuotaByProduct).map((product) => [
            product,
            s.usdUsageByProduct[product] && typeof s.usdUsageByProduct[product] === 'object'
              ? s.usdUsageByProduct[product]
              : {},
          ]));
          for (const product of Object.keys(rec.usdQuotaByProduct)) {
            const usage = rec.usdUsageByProduct[product];
            const persistedAccountId = Number(usage?.upstreamAccountId || 0);
            const boundAccountId = this.boundAccountIdFor(rec, product);
            if (persistedAccountId > 0 && persistedAccountId !== boundAccountId) {
              resetUpstreamObservation(rec, product, 'rebind');
              usage.upstreamAccountId = boundAccountId > 0 ? boundAccountId : undefined;
            }
          }
        } else {
          const legacySnapshot = {
            ...rec,
            usdUsed5h: Number.isFinite(Number(s.usdUsed5h)) ? Math.max(0, Number(s.usdUsed5h)) : apiValueUsdForEvents(s.tokenUsageEvents),
            usdUsedWeekly: Number.isFinite(Number(s.usdUsedWeekly)) ? Math.max(0, Number(s.usdUsedWeekly)) : apiValueUsdForEvents(s.weeklyTokenUsageEvents),
            usdWindowStartedAt5h: Number(s.usdWindowStartedAt5h || s.windowStartedAt || 0) || undefined,
            usdWindowStartedAtWeekly: Number(s.usdWindowStartedAtWeekly || s.weeklyWindowStartedAt || 0) || undefined,
          };
          rec.usdUsageByProduct = splitLegacyUsdUsage(
            legacySnapshot, rec.usdQuotaByProduct, s.tokenUsageEvents, s.weeklyTokenUsageEvents);
        }
        rec.usdWindowStartedAt5h = undefined;
        rec.usdUsed5h = undefined;
        rec.usdWindowStartedAtWeekly = undefined;
        rec.usdUsedWeekly = undefined;
      } else if (usdQuotaLimit(rec.usdLimit5h) > 0) {
        rec.usdWindowStartedAt5h = Number(s.usdWindowStartedAt5h || s.windowStartedAt || 0) || undefined;
        rec.usdUsed5h = Number.isFinite(Number(s.usdUsed5h)) ? Math.max(0, Number(s.usdUsed5h)) : apiValueUsdForEvents(s.tokenUsageEvents);
      } else {
        rec.usdWindowStartedAt5h = undefined;
        rec.usdUsed5h = undefined;
      }
      if (!rec.usdQuotaByProduct && usdQuotaLimit(rec.usdLimitWeekly) > 0) {
        rec.usdWindowStartedAtWeekly = Number(s.usdWindowStartedAtWeekly || s.weeklyWindowStartedAt || 0) || undefined;
        rec.usdUsedWeekly = Number.isFinite(Number(s.usdUsedWeekly)) ? Math.max(0, Number(s.usdUsedWeekly)) : apiValueUsdForEvents(s.weeklyTokenUsageEvents);
      } else {
        rec.usdWindowStartedAtWeekly = undefined;
        rec.usdUsedWeekly = undefined;
      }
      rec.tokenUsageEvents = keepLegacy && Array.isArray(s.tokenUsageEvents) ? s.tokenUsageEvents : [];
      rec.weeklyTokenUsageEvents = keepLegacy && Array.isArray(s.weeklyTokenUsageEvents) ? s.weeklyTokenUsageEvents : [];
    } else {
      rec.tokenUsageEvents = Array.isArray(s.tokenUsageEvents) ? s.tokenUsageEvents : [];
      rec.weeklyTokenUsageEvents = Array.isArray(s.weeklyTokenUsageEvents) ? s.weeklyTokenUsageEvents : [];
    }
  }

  /**
   * 快照所有订阅 record 的实时 5h/周窗口,供 token-server 定时 + 关机持久化到
   * Subscription.windowState。只输出有窗口活动的订阅(无活动的不写,省 DB)。
   * 美元额度订阅按产品保存紧凑累计值；旧算法仍保存窗口内事件以兼容 Antigravity。
   */
  serializeSubscriptionWindows(options: { includeUsd?: boolean } = { includeUsd: true }): Array<{ id: string; windowState: string }> {
    const out: Array<{ id: string; windowState: string }> = [];
    for (const rec of this.subscriptionById.values()) {
      if (!rec?.id) continue;
      if (options.includeUsd === false && usesUsdQuota(rec) && !hasLegacyQuotaProduct(rec)) continue;
      const hasActivity =
        Number(rec.windowStartedAt || 0) > 0 ||
        Number(rec.weeklyWindowStartedAt || 0) > 0 ||
        Number(rec.usdWindowStartedAt5h || 0) > 0 ||
        Number(rec.usdWindowStartedAtWeekly || 0) > 0 ||
        Number(rec.usdUsed5h || 0) > 0 ||
        Number(rec.usdUsedWeekly || 0) > 0 ||
        Object.values(rec.usdUsageByProduct || {}).some((usage) =>
          Number(usage.windowStartedAt5h || 0) > 0
          || Number(usage.windowStartedAtWeekly || 0) > 0
          || Number(usage.used5h || 0) > 0
          || Number(usage.usedWeekly || 0) > 0
          || Boolean(usage.upstreamFiveHour)
          || Boolean(usage.upstreamWeekly)
        ) ||
        (rec.tokenUsageEvents?.length || 0) > 0 ||
        (rec.weeklyTokenUsageEvents?.length || 0) > 0;
      if (!hasActivity) continue;
      const keepLegacy = !usesUsdQuota(rec) || hasLegacyQuotaProduct(rec);
      const state = {
        ...(keepLegacy ? {
          windowStartedAt: rec.windowStartedAt || 0,
          weeklyWindowStartedAt: rec.weeklyWindowStartedAt || 0,
          tokenUsageEvents: rec.tokenUsageEvents || [],
          weeklyTokenUsageEvents: rec.weeklyTokenUsageEvents || [],
        } : {}),
        ...(rec.usdQuotaByProduct ? { usdUsageByProduct: rec.usdUsageByProduct || {} } : {}),
        ...(usdQuotaLimit(rec.usdLimit5h) > 0 ? {
          usdWindowStartedAt5h: rec.usdWindowStartedAt5h || 0,
          usdUsed5h: usedUsd5h(rec),
        } : {}),
        ...(usdQuotaLimit(rec.usdLimitWeekly) > 0 ? {
          usdWindowStartedAtWeekly: rec.usdWindowStartedAtWeekly || 0,
          usdUsedWeekly: usedUsdWeekly(rec),
        } : {}),
      };
      out.push({ id: rec.id, windowState: JSON.stringify(state) });
    }
    return out;
  }

  snapshotSubscriptionUsage(id: string): string {
    const record = this.subscriptionById.get(id);
    if (!record) return "";
    return JSON.stringify({
      usdUsageByProduct: record.usdUsageByProduct,
      usdWindowStartedAt5h: record.usdWindowStartedAt5h,
      usdUsed5h: record.usdUsed5h,
      usdWindowStartedAtWeekly: record.usdWindowStartedAtWeekly,
      usdUsedWeekly: record.usdUsedWeekly,
      tokenUsageEvents: record.tokenUsageEvents,
      weeklyTokenUsageEvents: record.weeklyTokenUsageEvents,
      lastUsedAt: record.lastUsedAt,
    });
  }

  restoreSubscriptionUsage(id: string, snapshot: string): void {
    const record = this.subscriptionById.get(id);
    if (!record || !snapshot) return;
    const state = JSON.parse(snapshot);
    // JSON omits undefined properties. Clear the complete mutable usage surface
    // before restoring, otherwise a failed first report can leave a newly-created
    // usdUsageByProduct/window field behind and still consume quota after rollback.
    for (const key of [
      'usdUsageByProduct', 'usdWindowStartedAt5h', 'usdUsed5h',
      'usdWindowStartedAtWeekly', 'usdUsedWeekly', 'tokenUsageEvents',
      'weeklyTokenUsageEvents', 'lastUsedAt',
    ] as const) delete (record as any)[key];
    Object.assign(record, state);
  }

  /** Snapshot every subscription whose USD state can be changed by one report:
   * the reporting subscription plus all active subscriptions following the same
   * mother account's reset epochs. */
  snapshotUsdMutationScope(cardId: string, accountId: number, product: string): Array<{ id: string; snapshot: string }> {
    const ids = new Set<string>([cardId, ...this.subscriptionsBoundToAccount(accountId, usdProductKey(product))]);
    return [...ids]
      .map((id) => ({ id, snapshot: this.snapshotSubscriptionUsage(id) }))
      .filter((item) => Boolean(item.snapshot));
  }

  restoreSubscriptionUsages(snapshots: Array<{ id: string; snapshot: string }>): void {
    for (const item of snapshots) this.restoreSubscriptionUsage(item.id, item.snapshot);
  }

  serializeSubscriptionWindowsFor(ids: Iterable<string>): Array<{ id: string; windowState: string }> {
    const serialized = new Map(this.serializeSubscriptionWindows().map((item) => [item.id, item.windowState]));
    return [...new Set(ids)].map((id) => ({ id, windowState: serialized.get(id) || '{}' }));
  }

  forgetUsageReport(cardId: string, reportId: string): void {
    if (reportId) this.reportDedup.get(cardId)?.delete(reportId);
  }

  /**
   * 卡迁移「转化即删」去影子:把刚迁移出来的 DB 订阅配置 record 注册进 subscriptionById,
   * 并把同 id 文件影子卡的实时限流窗口(events + 窗口起点 + firstUsedAt + 累计计数器)平移到
   * 订阅 record 上,然后把文件影子卡从 cache/byId/byKey 物理删除并落盘。
   *
   * 不变量(调用方须保证):已在进程级 withAccessKeysWriteLock 内、DB Subscription 行已提交;
   * 本方法全程同步、无 await —— 与并发 flush/recordUsage 互斥(JS 单线程,debounce flush 的
   * setTimeout 回调不会打断同步段)。平移在删除之前完成 → 删除后 findById 落到订阅 record 时
   * 限流额度连续(不被重置/穿透);老卡 key 在内存(byKey)与文件里同时消失。重启后该订阅由
   * boot 的 loadActiveSubscriptions + restoreSubscriptionWindow(从 Subscription.windowState
   * 精准恢复窗口)接管,口径与此刻平移一致 —— 平移后的窗口由定时持久化写入 windowState。
   */
  migrateCardRecordToSubscription(subRecord: Partial<AccessKeyRecord> & { id: string }): void {
    const id = subRecord.id;
    // 1) 注册订阅配置 record(新 id → 建;已存在 → 刷新配置、保留既有窗口)。
    this.loadSubscriptionRecords([subRecord]);
    // 2) 把文件影子卡的实时窗口/计数器平移到订阅 record —— 务必在删除影子之前。
    const sub = this.subscriptionById.get(id);
    const file = this.byId.get(id);
    if (sub && file) {
      sub.tokenUsageEvents = file.tokenUsageEvents;
      sub.weeklyTokenUsageEvents = file.weeklyTokenUsageEvents;
      sub.windowStartedAt = file.windowStartedAt;
      sub.weeklyWindowStartedAt = file.weeklyWindowStartedAt;
      sub.firstUsedAt = file.firstUsedAt;
      sub.lastUsedAt = file.lastUsedAt;
    }
    // 3) 物理删除文件影子卡(cache + 两个索引)并落盘。
    this.removeFileRecordById(id);
  }

  /**
   * 从文件 cache + byId + byKey 删除单条卡记录并立即落盘。仅供「转化即删」去影子内部使用:
   * byKey 仅在该项确实指向被删 record 时才删(避免误删同 keyHash 的订阅卡 backingKey 索引)。
   */
  private removeFileRecordById(id: string): void {
    if (!this.cache) this.readAll();
    const rec = this.byId.get(id);
    if (!rec || !this.cache) return;
    this.cache.keys = this.cache.keys.filter((k) => k && k.id !== id);
    this.byId.delete(id);
    if (rec.key) {
      const h = this.keyHash(rec.key);
      if (this.byKey.get(h) === rec) this.byKey.delete(h);
    }
    this.dirty = true;
    this.flush();
  }

  /**
   * 去影子:列出所有已注册的订阅 record(subscriptionById 的快照)。
   * 运行时限额从内存读、不读文件 —— 测试与诊断据此核验注册状态,无需触碰 access-keys.json。
   */
  listSubscriptionRecords(): AccessKeyRecord[] {
    return [...this.subscriptionById.values()];
  }

  /**
   * 列出某 customerId 的所有 ACTIVE 订阅 record,按 priority 升序(小=优先)。
   * 供 SubscriptionScheduler 做账户级接力。只看内存 subscriptionById(订阅卡),
   * 文件卡不参与账户接力(无 customerId)。
   */
  listByCustomerSorted(customerId: string): AccessKeyRecord[] {
    if (!customerId) return [];
    const out: AccessKeyRecord[] = [];
    for (const rec of this.subscriptionById.values()) {
      if (rec.customerId === customerId && String(rec.status || "active") === "active") {
        out.push(rec);
      }
    }
    return out.sort((a, b) => (Number(a.priority ?? 0)) - (Number(b.priority ?? 0)));
  }

  /**
   * 即时更新某订阅 record 的接力优先级(账户中心拖动排序后调用)。
   * 只在 record 已驻留内存时更新 —— 否则该订阅下次从 DB 装载时自带新 priority,
   * 绝不能凭 {id,priority} 往 Map 里塞半截 stub(会污染调度/findByKey)。
   * 返回是否命中,便于调用方判断是否需要 DB 兜底。
   */
  setSubscriptionPriority(id: string, priority: number): boolean {
    const rec = this.subscriptionById.get(id);
    if (!rec) return false;
    rec.priority = Math.max(0, Math.floor(Number(priority) || 0));
    return true;
  }


  /** Immediately flush dirty cache to disk. Only the file-card config store
   *  (cache.keys) is persisted here; runtime usage no longer writes the file —
   *  file cards are retired (don't serve), subscriptions persist via
   *  Subscription.windowState. Used by the migration shadow-delete + admin edits. */
  flush(): void {
    if (!this.dirty || !this.cache) return;
    this.dirty = false;
    try {
      const now = this.now();
      for (const key of this.cache.keys) {
        if (!key) continue;
        resetWindowIfExpired(key, now);
        const windowStart = Number(key.windowStartedAt || 0);
        if (windowStart > 0) {
          if (Array.isArray(key.tokenUsageEvents)) {
            key.tokenUsageEvents = key.tokenUsageEvents.filter((e: any) => e.at >= windowStart);
          }
        }
        // Prune weekly window events too.
        resetWeeklyWindowIfExpired(key, now);
        const weeklyStart = Number(key.weeklyWindowStartedAt || 0);
        if (weeklyStart > 0 && Array.isArray(key.weeklyTokenUsageEvents)) {
          key.weeklyTokenUsageEvents = key.weeklyTokenUsageEvents.filter((e: any) => e.at >= weeklyStart);
        }
      }
      writeJsonFile(this.filePath, this.serializable());
    } catch (err: any) {
      this.dirty = true;
      console.error(`[access-key-store] flush failed: ${err.message}`);
    }
  }

  /**
   * Disk view of the cache: card metadata + counters, WITHOUT the per-request
   * window event arrays. Subscription windows persist in Subscription.windowState;
   * legacy file-card windows remain process-local until those cards retire.
   * Omitting them keeps access-keys.json small and, critically, avoids
   * JSON.stringify hitting V8's max-string-length on busy cards.
   */
  private serializable(): AccessKeysData {
    if (!this.cache) return { keys: [], updatedAt: '' };
    return {
      updatedAt: this.cache.updatedAt,
      keys: this.cache.keys.map((k) => {
        if (!k) return k;
        // Strip all historical per-request arrays if an old access-keys file
        // still contains them. Runtime quota state lives in DB-backed windows.
        const { usageEvents, tokenUsageEvents, weeklyTokenUsageEvents, ...rest } = k as any;
        return rest as AccessKeyRecord;
      }),
    };
  }

  // ── Lookup ───────────────────────────────────────────────────────────────

  findById(cardId: string): AccessKeyRecord | null {
    if (!cardId) return null;
    this.readAll();
    // 文件卡(byId)优先,其次订阅 record(subscriptionById)。
    return this.byId.get(cardId) || this.subscriptionById.get(cardId) || null;
  }

  /**
   * Console-only corrective action for a DB-backed subscription. Clears one
   * product window's consumed USD without touching its sibling window, quota
   * limit, or upstream reset observation. File cards are intentionally excluded.
   */
  resetSubscriptionUsdUsage(
    subscriptionId: string,
    product: string,
    scope: 'fiveHour' | 'weekly',
  ): { previousUsed: number; limit: number } | null {
    const record = this.subscriptionById.get(subscriptionId);
    const productKey = usdProductKey(product);
    if (!record || !productKey || !record.usdQuotaByProduct?.[productKey]) return null;
    const quota = usdQuotaForProduct(record, productKey);
    const limit = scope === 'fiveHour' ? quota.fiveHour : quota.weekly;
    if (!(limit > 0)) return null;
    const previousUsed = scope === 'fiveHour'
      ? usedUsd5hForProduct(record, productKey)
      : usedUsdWeeklyForProduct(record, productKey);
    clearUsdScopeUsage(record, productKey, scope);
    return { previousUsed, limit };
  }

  findByKey(keyValue: string): AccessKeyRecord | null {
    if (!keyValue) return null;
    this.readAll();
    const h = this.keyHash(keyValue);
    return this.byKey.get(h) || this.subscriptionByBackingKey.get(h) || null;
  }

  /**
   * The upstream account id this card is statically bound to within the given
   * pool, or 0 if it isn't bound here. Binding is provider-scoped because the
   * antigravity and codex account pools allocate ids independently (both start
   * at 1), so the same numeric id means different accounts in each pool. An
   * untagged card (no `provider`) matches any pool for backward compatibility.
   */
  boundAccountIdFor(record: AccessKeyRecord, providerId: string): number {
    const map = record?.bindings;
    if (map && typeof map === "object") {
      const fromMap = Number(map[providerId] || 0);
      if (Number.isFinite(fromMap) && fromMap > 0) return fromMap;
    }
    // Legacy single-binding fallback.
    const bound = Number(record?.boundAccountId || 0);
    if (!Number.isFinite(bound) || bound <= 0) return 0;
    if (record.provider && record.provider !== providerId) return 0;
    return bound;
  }

  /**
   * Whether the card has ANY static binding (in any pool). Distinguishes the two
   * card modes: a card with no binding at all is a "pool" card (dynamic pool,
   * legacy); a card bound for a different pool is "not sold for" this pool.
   */
  hasAnyBinding(record: AccessKeyRecord): boolean {
    const map = record?.bindings;
    if (map && typeof map === "object" && Object.values(map).some((v) => Number(v) > 0)) return true;
    return Number(record?.boundAccountId || 0) > 0;
  }

  /**
   * 去影子:绑定到某上游号的「订阅」id(subscriptionById,不写文件)。
   * boundAccountIdFor 读 record.bindings[providerId]。account-system 下用量看板
   * (getBoundCardsForAccount)只列订阅 —— 文件卡已退役、不再混取。号池订阅无
   * bindings,自然不被纳入。
   */
  subscriptionsBoundToAccount(accountId: number, providerId: string): string[] {
    if (accountId <= 0) return [];
    const out: string[] = [];
    for (const rec of this.subscriptionById.values()) {
      if (rec.status && rec.status !== 'active') continue;
      if (this.boundAccountIdFor(rec, providerId) === accountId) out.push(rec.id);
    }
    return out;
  }

  /**
   * Synchronize reset epochs from one trusted mother-account snapshot into every
   * active USD subscription bound to that account. Quota amounts remain fixed;
   * only the independent 5h/weekly epoch state is updated.
   */
  applyUpstreamUsdQuotaSnapshot(
    accountId: number,
    product: string,
    inputs: ProviderQuotaSnapshotInput[] | null | undefined,
    meta: UpstreamUsdQuotaSnapshotMeta = {},
  ): number {
    const quotaProduct = usdProductKey(product);
    if (accountId <= 0 || !supportsApiUsdProduct(quotaProduct) || !Array.isArray(inputs)) return 0;
    const input = inputs.find((candidate) => candidate && typeof candidate === 'object');
    if (!input) return 0;

    const arrivedAt = normalizeObservedAt(meta.arrivedAt, this.now());
    // Client timestamps may be stale but must never move our ordering clock
    // into the future and suppress every subsequent legitimate snapshot.
    const observedAt = Math.min(arrivedAt, normalizeObservedAt(meta.observedAt, arrivedAt));
    const snapshotId = String(meta.snapshotId || '');
    const hourlyFraction = normalizeRemainingFraction(input.hourlyPercent);
    const weeklyFraction = normalizeRemainingFraction(input.weeklyPercent);
    const hourlyResetAt = resetAtMs(input.hourlyResetAt);
    const weeklyResetAt = resetAtMs(input.weeklyResetAt);
    const trustedRefillEvent = (
      scope: 'fiveHour' | 'weekly',
      fraction: number | null,
    ): string | undefined => {
      const previous = Number(meta.previousFractionByScope?.[scope]);
      if (!snapshotId || fraction === null || !Number.isFinite(previous) || previous < 0) return undefined;
      if (fraction <= previous + FRACTION_EPSILON) return undefined;
      const consumed = 1 - previous;
      const recovered = fraction - previous;
      const recoveryRatio = consumed > FRACTION_EPSILON ? recovered / consumed : 0;
      if (recoveryRatio + FRACTION_EPSILON < UPSTREAM_REBOUND_RECOVERY_RATIO) return undefined;
      return `refill:${quotaProduct}:${accountId}:${scope}:${snapshotId}`;
    };
    const hasHourly = input.hourlyPresent !== undefined || hourlyFraction !== null || hourlyResetAt !== undefined;
    const hasWeekly = input.weeklyPresent !== undefined || weeklyFraction !== null || weeklyResetAt !== undefined;
    if (!hasHourly && !hasWeekly) return 0;

    let touched = 0;
    for (const subscriptionId of this.subscriptionsBoundToAccount(accountId, quotaProduct)) {
      const record = this.subscriptionById.get(subscriptionId);
      if (!record || !usesUsdQuotaForProduct(record, quotaProduct)) continue;
      const usage = usdProductUsage(record, quotaProduct, true)!;
      const previousObservedAccountId = Number(usage.upstreamAccountId || 0);
      if (previousObservedAccountId !== accountId) {
        // First observation after rollout or rebind is baseline-only. Existing
        // personal usage is deliberately preserved.
        resetUpstreamObservation(
          record,
          quotaProduct,
          previousObservedAccountId > 0 ? 'rebind' : undefined,
        );
        usage.upstreamAccountId = accountId;
      }
      let changed = false;
      if (hasHourly) {
        changed = applyUpstreamWindowSnapshot(record, quotaProduct, 'fiveHour', {
          present: input.hourlyPresent,
          fraction: hourlyFraction,
          resetAt: hourlyResetAt,
          trustedPreviousResetAt: meta.previousResetAtByScope?.fiveHour,
          trustedResetEventId: trustedRefillEvent('fiveHour', hourlyFraction),
        }, { observedAt, snapshotId }) || changed;
      }
      if (hasWeekly) {
        changed = applyUpstreamWindowSnapshot(record, quotaProduct, 'weekly', {
          present: input.weeklyPresent,
          fraction: weeklyFraction,
          resetAt: weeklyResetAt,
          trustedPreviousResetAt: meta.previousResetAtByScope?.weekly,
          trustedResetEventId: trustedRefillEvent('weekly', weeklyFraction),
        }, { observedAt, snapshotId }) || changed;
      }
      if (changed) touched += 1;
    }
    return touched;
  }

  /**
   * 反向索引:返回绑定到某上游号(provider 作用域)的「全量 record 对象」。
   * 同时扫描文件卡(byId)与订阅 record(subscriptionById),按 id 去重(一条
   * record 可能同时落在两个 Map 里)。订阅 record 沿用 subscriptionsBoundToAccount
   * 的 active-status 闸:status 已设且非 'active' 的跳过。fairShare 接力方需读
   * (rec as any).weight / rec.weights,故返回整条 record 而非 id。O(n) 线扫即可,
   * 不额外维护新 Map。
   */
  getRecordsBoundTo(accountId: number, providerId: string): AccessKeyRecord[] {
    if (accountId <= 0) return [];
    // Startup quota restoration can ask for membership before any lease/auth
    // lookup has lazily populated the file-backed indexes. Always establish the
    // authoritative key snapshot here so restart reconciliation cannot replace
    // a persisted participant set with an accidental empty membership event.
    this.readAll();
    const out: AccessKeyRecord[] = [];
    const seen = new Set<string>();
    for (const rec of this.byId.values()) {
      if (seen.has(rec.id)) continue;
      if (rec.status && rec.status !== 'active') continue;   // 与 subscriptionById / hardBoundAccountIds 口径一致:禁用/过期卡不进 Σw,免稀释 e_i
      if (this.boundAccountIdFor(rec, providerId) === accountId) {
        seen.add(rec.id);
        out.push(rec);
      }
    }
    for (const rec of this.subscriptionById.values()) {
      if (seen.has(rec.id)) continue;
      if (rec.status && rec.status !== 'active') continue;
      if (this.boundAccountIdFor(rec, providerId) === accountId) {
        seen.add(rec.id);
        out.push(rec);
      }
    }
    return out;
  }

  /**
   * Strict pool partitioning: collect accounts held by active hard-bound cards.
   * Soft policies (preferred-dynamic/display-bound-pool) may show a binding but
   * do not reserve that account or participate in hard-bound fair-share.
   */
  hardBoundAccountIds(providerId: string): Set<number> {
    const out = new Set<number>();
    const consider = (rec: AccessKeyRecord) => {
      if (!rec) return;
      if (rec.status && rec.status !== 'active') return;
      if (isSoftAssignmentPolicy((rec as any).assignmentPolicy)) return;
      const id = this.boundAccountIdFor(rec, providerId);
      if (id > 0) out.add(id);
    };
    for (const rec of this.byId.values()) consider(rec);
    for (const rec of this.subscriptionById.values()) consider(rec);
    return out;
  }

  /**
   * Fair-share Σw input for hard-bound owners on an account.
   * Soft policies are quota-capped elsewhere and must not dilute pinned owners.
   */
  getHardBoundCardWeights(accountId: number, providerId: string): Array<{ cardId: string; weight: number }> {
    const out: Array<{ cardId: string; weight: number }> = [];
    for (const r of this.getRecordsBoundTo(accountId, providerId)) {
      if (isSoftAssignmentPolicy((r as any).assignmentPolicy)) continue;
      // USD-managed subscriptions keep their hard binding for routing/seat
      // reservation, but their quota is subscription-local and must not dilute
      // the legacy fair-share denominator or become a window participant.
      if (usesUsdQuotaForProduct(r, providerId)) continue;
      const w = Math.floor(Number((r as any).weights?.[providerId] || 0) || Number((r as any).weight ?? 1));
      out.push({ cardId: r.id, weight: Number.isFinite(w) && w >= 1 ? w : 1 });
    }
    return out;
  }

  /**
   * Antigravity 旧算法的固定席位分母：优先读统一 quotaSeatCapacity；
   * 兼容读取历史 salesSeatCapacity[product]，最后回退默认容量。
   */
  getSeatCapacityFor(accountId: number, providerId: string): number {
    let cap = 0;
    for (const r of this.getRecordsBoundTo(accountId, providerId)) {
      if (isSoftAssignmentPolicy((r as any).assignmentPolicy)) continue;
      const c = Math.floor(Number(
        (r as any).quotaSeatCapacity
        || (r as any).salesSeatCapacity?.[providerId]
        || 0,
      ));
      if (Number.isFinite(c) && c > cap) cap = c;
    }
    return cap > 0 ? cap : ACCOUNT_SHARE_CAPACITY;
  }

  /**
   * 该卡是否独享(营销标签,唯一判定源)。口径:显式 config.exclusive===true,
   * 或 weight≥号总份数(买满整号容量 = 独享展示)。仅作展示/血条用(独享走裸份额、单层条);
   * 不影响座位分配/发卡闸 —— 即「只标独享标签,不锁号」,满容量卡仍可被超卖、与他人共用。
   */
  isExclusiveCard(cardId: string): boolean {
    return this.isExclusiveRecord(this.findById(cardId));
  }

  /** 记录级独享判定(isExclusiveCard 与 publicStatus.exclusive 的同一真相源)。 */
  private isExclusiveRecord(rec: AccessKeyRecord | undefined | null): boolean {
    if (!rec) return false;
    if ((rec as any).exclusive === true) return true;
    const weight = Math.max(1, Math.floor(Number((rec as any).weight) || 1));
    return weight >= ACCOUNT_SHARE_CAPACITY;
  }

  // ── Request resolution ─────────────────────────────────────────────────

  /** Injected session-JWT → subscription resolver (see SessionResolverLike). */
  private sessionResolver: SessionResolverLike | null = null;

  /** Wire the customer-session resolver. Called from a Nest OnModuleInit (the
   * store is a plain class shared across pools and can't use DI itself). */
  setSessionResolver(resolver: SessionResolverLike | null): void {
    this.sessionResolver = resolver;
  }

  /**
   * Resolve the runtime credential from a request, checking validity and limits.
   *
   * The ONLY runtime credential is the customer session JWT: an Authorization
   * bearer that LOOKS like a user-session token routes to the injected
   * SessionTokenResolver, which verifies it and maps it to the customer's
   * ACTIVE Subscription — whose id IS the shadow record id. The record then
   * runs the shared validation pipeline (status/expiry/window/bucket/weekly).
   *
   * Card-string credentials (x-token-server-secret / x-access-key / payload
   * key fields) were removed with the force-upgrade — clients below 9.5.0 are
   * upgraded away and no longer served. Card VALUES still resolve via
   * findByKey() for the bind-card redemption flow (card-migration.service),
   * which converts a legacy card into a Subscription; they just can no longer
   * LEASE directly.
   */
  async resolveFromRequest(
    req: any,
    _payload: any,
    options: { activate?: boolean; enforceLimit?: boolean; modelKey?: string; product?: string; alignedResetAt?: number | ((record: any) => number) } = {},
  ): Promise<ResolveResult> {
    const authHeader = String(req?.headers?.authorization || '');
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!looksLikeUserSessionToken(bearer)) {
      return {
        key: '',
        record: null,
        error: bearer ? 'Invalid access key' : 'Missing access key',
      };
    }

    const data = this.readAll();
    if (!this.sessionResolver) return sessionResolverUnavailable();
    const resolved = await this.sessionResolver.resolve(bearer, { product: options.product });
    if (!resolved.ok) return sessionResolveFailure(resolved);
    const record = this.byId.get(resolved.cardId) || this.subscriptionById.get(resolved.cardId) || null;
    if (!record) return missingShadowRecord();
    // Migrated never-used card: no absolute expiry AND not yet armed.
    const unarmed = !record.keyExpiresAt && !record.firstUsedAt;
    const result: ResolveResult = { ...this.validateRecord(String(record.key || ''), record, data, options), viaSession: true };
    // This lease just armed firstUsedAt → tell the resolver the record's
    // now-effective expiry so Subscription.expiresAt gets resynced. Fires at
    // most ONCE per record (firstUsedAt persists) and is NOT awaited — zero
    // added latency on the hot path; the hook owns its errors.
    if (unarmed && result.record && record.firstUsedAt) {
      const effective = keyExpiresAt(record);
      if (effective) this.sessionResolver.onShadowRecordFirstUse?.(record.id, effective);
    }
    // Record-level expiry/disabled on the session path → SUBSCRIPTION_EXPIRED
    // machine code (the sub row was ACTIVE but the record can't serve).
    return shadowRecordValidationFailure(result);
  }

  /**
   * Shared validation pipeline for a looked-up record: status → activation →
   * expiry → window resets → per-bucket caps (429 w/ resetMs) → weekly window.
   * Extracted verbatim from the historical resolveFromRequest body; the
   * session path runs records through it unchanged.
   */
  private validateRecord(
    keyValue: string,
    record: AccessKeyRecord,
    data: AccessKeysData,
    options: { activate?: boolean; enforceLimit?: boolean; modelKey?: string; product?: string; alignedResetAt?: number | ((record: any) => number); dryRun?: boolean } = {},
  ): ResolveResult {
    if (record.status && record.status !== 'active') {
      return { key: keyValue, record: null, error: 'Access key disabled' };
    }

    const now = this.now();
    if (!record.firstUsedAt && options.activate) {
      record.firstUsedAt = new Date(now).toISOString();
    }
    const expiresAt = keyExpiresAt(record);
    if (expiresAt && Date.parse(expiresAt) <= now) {
      if (!options.dryRun) record.status = 'expired';
      return { key: keyValue, record: null, error: 'Access key expired' };
    }

    // Bound cards align each bucket to its account window (alignedResetAt); the
    // global tumbling reset must be skipped for them, or it would wipe events the
    // aligned per-bucket window still needs.
    const aligned = typeof options.alignedResetAt === 'function'
      ? (Number(options.alignedResetAt(record)) || 0)
      : (Number(options.alignedResetAt) || 0);
    const productUsdQuota = usdQuotaForProduct(record, options.product);
    const usd5hLimit = productUsdQuota.fiveHour;
    const usdWeeklyLimit = productUsdQuota.weekly;
    const usdManaged = usesUsdQuotaForProduct(record, options.product);
    const usd5hActive = usd5hLimit > 0 && isUsdScopeActive(record, options.product, 'fiveHour');
    const usdWeeklyActive = usdWeeklyLimit > 0 && isUsdScopeActive(record, options.product, 'weekly');
    // USD-managed subscriptions follow their bound upstream epoch when known;
    // legacy token caps keep the historical account-aligned behavior.
    if (usdManaged) {
      if (usd5hLimit > 0) expireUsd5hWindow(record, now, options.product);
      if (usdWeeklyLimit > 0) expireUsdWeeklyWindow(record, now, options.product);
    } else if (aligned <= 0) resetWindowIfExpired(record, now);

    if (options.enforceLimit && usd5hActive) {
      const usedUsd = usedUsd5hForProduct(record, options.product);
      if (usedUsd + 1e-9 >= usd5hLimit) {
        return {
          key: keyValue, record: null, limitExceeded: true,
          resetMs: usd5hResetMs(record, now, options.product),
          error: `Access key API-equivalent USD limit exceeded ($${usedUsd.toFixed(2)}/$${usd5hLimit.toFixed(2)}/5h)`,
        };
      }
    }

    // 每卡封顶的唯一来源:bucketLimits(按复合桶 `<产品>-<家族>` 设的每模型上限)。
    const hasBucketCaps =
      !!record.bucketLimits &&
      typeof record.bucketLimits === 'object' &&
      Object.values(record.bucketLimits).some((v) => Number(v) > 0);

    if (options.enforceLimit && hasBucketCaps && !usdManaged) {
      const modelKeyStr = String(options.modelKey || '').trim();

      if (modelKeyStr) {
        const bucket = requestBucket(options.product, modelKeyStr);
        const limit = this.billing.bucketLimit(0, bucket, record);
        // Bound (aligned) cards count usage within the account-aligned window;
        // pool cards use the global fixed-period window.
        const used = aligned > 0
          ? bucketUsageInWindow(record, bucket, now, aligned)
          : (recentBucketUsage(record, now).get(bucket) || 0);
        if (limit > 0 && used >= limit) {
          const windowLabel = aligned > 0 ? '账号窗口' : formatWindowLabel(record.windowMs);
          const resetMs = aligned > 0 ? Math.max(0, aligned - now) : tokenWindowResetMs(record, now);
          return {
            key: keyValue, record: null,
            limitExceeded: true, resetMs,
            error: `Access key ${this.billing.bucketLabel(bucket)} token limit exceeded (${used}/${limit} tokens/${windowLabel})`,
          };
        }
      }
      // 无 modelKey(预热 / 探活)不消费任何具体桶 → 不做额度拦截。真实消费都带 modelKey,走上面
      // 的精确单桶检查:某个产品的桶爆了只拦那个产品(anthropic-claude 爆只拦 claude),绝不连累
      // 其他满额产品(antigravity-gemini 0/10000)或没设限的产品。这彻底消除「用过的桶爆 → 判整
      // 卡死 → 锁住整张卡(含满额产品)的预热」这种跨产品污染。
    }

    // ── Weekly window check (second tier) ──────────────────────────────────
    // 周上限【只认显式配置】(QUOTA-REDESIGN 决策5):weeklyTokenLimit / weeklyBucketLimits。
    // 「cap5h × R 自动派生」已删除(R 无法正确换算 5h→周)。没配显式周上限 → 周维度不拦。
    if (!usdManaged) resetWeeklyWindowIfExpired(record, now);
    if (options.enforceLimit) {
      if (usdWeeklyActive) {
        const usedUsd = usedUsdWeeklyForProduct(record, options.product);
        if (usedUsd + 1e-9 >= usdWeeklyLimit) {
          return {
            key: keyValue, record: null, limitExceeded: true,
            resetMs: usdWeeklyResetMs(record, now, options.product),
            error: `Access key weekly USD limit exceeded ($${usedUsd.toFixed(2)}/$${usdWeeklyLimit.toFixed(2)}/week)`,
          };
        }
      }
      const modelKeyStr = usdManaged ? '' : String(options.modelKey || '').trim();
      // 无 modelKey(预热/探活)不消费具体桶 → 不拦截(理由同 5h 窗口)。
      if (modelKeyStr) {
        const bucket = requestBucket(options.product, modelKeyStr);
        const weeklyCap = this.weeklyBucketCap(record, bucket);
        if (weeklyCap > 0) {
          const used = recentWeeklyBucketUsage(record, now).get(bucket) || 0;
          if (used >= weeklyCap) {
            return {
              key: keyValue, record: null,
              limitExceeded: true, resetMs: weeklyWindowResetMs(record, now),
              error: `Access key ${this.billing.bucketLabel(bucket)} weekly token limit exceeded (${used}/${weeklyCap} tokens/week)`,
            };
          }
        }
      }
    }

    return { key: keyValue, record, data };
  }

  /**
   * 只读三道闸预检(bucketLimits + weekly + expiry/status),供 SubscriptionScheduler
   * 对候选订阅逐个判断"当前 bucket 还有没有额度"。复用 validateRecord 的 dryRun 模式,
   * 绝不写缓存、不改 record 状态。fair-share(第三道闸)由 scheduler 另调 checkFairShare。
   */
  precheckRecord(
    record: AccessKeyRecord,
    options: { modelKey?: string; product?: string; alignedResetAt?: number | ((record: any) => number); enforceLimit?: boolean },
  ): { allowed: boolean; resetMs?: number; reason?: string } {
    const res = this.validateRecord(String(record.key || record.id), record, this.readAll(), {
      ...options,
      enforceLimit: options.enforceLimit ?? true,
      dryRun: true,
    });
    if (res.record) return { allowed: true };
    return { allowed: false, resetMs: res.resetMs, reason: res.error };
  }

  // ── Usage recording ────────────────────────────────────────────────────

  /** Read-only fast path used before mutating the causal quota reducer. */
  hasUsageReport(cardId: string, reportId: string): boolean {
    return Boolean(reportId && this.reportDedup.get(cardId)?.has(reportId));
  }

  /**
   * Normalize a raw usage payload into the canonical token counts (and billing
   * bucket) that recordUsage() persists. Exposed so callers (e.g. the per-call
   * token-usage tracker) record EXACTLY the same numbers as the card counters.
   */
  computeUsageDetail(usage: any = {}, modelKey = '', product = '') {
    return computeUsageDetailPure(usage, modelKey, product);
  }

  /**
   * Record a usage report against a card. Idempotent by reportId: a reportId
   * already seen within the current usage window is NOT counted again, and the
   * method returns false. Returns true when this report was newly counted.
   *
   * This in-memory ring is the compatibility deduper for direct/legacy callers.
   * The production durable quota path additionally commits QuotaReportReceipt,
   * window state and CardUsageHourly in one DB transaction, so restart retries
   * are exactly-once. Reports without a reportId cannot be deduped here; callers
   * must enforce once-per-success semantics.
   */
  // applyUsdConsumption gates the in-memory USD 5h/weekly increment. USD windows
  // are persisted ONLY by the per-report durable checkpoint (checkpointUsdReport);
  // the interval timer + shutdown snapshot deliberately skip USD subs to avoid
  // clobbering that newer durable head. So an increment applied here for a report
  // that will NOT be durably checkpointed (no lease → accountId 0, or no
  // modelKey → empty bucket) is memory-only and silently evaporates on the next
  // restart — resetting the customer's used-USD to the last checkpoint. Callers
  // pass false for such reports so we never book un-persistable consumption. This
  // matches the existing invariant that account-scoped state is not mutated
  // without a verified lease.
  recordUsage(cardId: string, status: number, usage: any = {}, modelKey = '', reportId = '', product = '', serviceTier = '', applyUsdConsumption = true): boolean {
    if (!cardId) return false;
    const record = this.findById(cardId);
    if (!record) return false;

    const now = this.now();
    const usdManaged = usesUsdQuotaForProduct(record, product);
    const productQuota = usdQuotaForProduct(record, product);
    const rawOccurredAt = Number(usage?.occurredAt);
    const occurredAt = Number.isFinite(rawOccurredAt) && rawOccurredAt > 0
      ? Math.min(now, rawOccurredAt)
      : now;
    if (!usdManaged) resetWindowIfExpired(record, now);
    else {
      if (productQuota.fiveHour > 0) expireUsd5hWindow(record, now, product);
      if (productQuota.weekly > 0) expireUsdWeeklyWindow(record, now, product);
    }
    const usd5hActive = productQuota.fiveHour > 0 && isUsdScopeActive(record, product, 'fiveHour');
    const usdWeeklyActive = productQuota.weekly > 0 && isUsdScopeActive(record, product, 'weekly');
    const trackUsd5h = usd5hActive
      && usdEventBelongsToCurrentScope(record, product, 'fiveHour', occurredAt, now);
    const trackUsdWeekly = usdWeeklyActive
      && usdEventBelongsToCurrentScope(record, product, 'weekly', occurredAt, now);
    if (usdManaged && !usd5hActive) {
      const state = usdProductUsage(record, product);
      if (state) {
        state.windowStartedAt5h = undefined;
        state.used5h = undefined;
      } else {
        record.usdWindowStartedAt5h = undefined;
        record.usdUsed5h = undefined;
      }
    }

    if (reportId) {
      let seen = this.reportDedup.get(cardId);
      if (!seen) { seen = new Map(); this.reportDedup.set(cardId, seen); }
      if (seen.has(reportId)) return false; // duplicate — already counted
      seen.set(reportId, now);
      // Bound memory: evict oldest (Map preserves insertion order).
      while (seen.size > MAX_RECENT_REPORT_IDS) {
        const oldest = seen.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    }

    const { inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens, rawTotalTokens, totalTokens } =
      this.computeUsageDetail(usage, modelKey, product);

    // 累计用量计数已下线:权威用量在 CardUsageHourly(DB)。这里只更新限流窗口事件
    // (下方)+ lastUsedAt;后台单卡「总Token/请求数」改读 CardUsageHourly。
    record.lastUsedAt = new Date(now).toISOString();
    if (totalTokens > 0) {
      const event = {
        at: occurredAt, occurredAt, status: Number(status || 0),
        inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens,
        cacheWrite5mTokens: Number(usage?.cacheWrite5mTokens ?? cacheCreationTokens ?? 0) || 0,
        cacheWrite1hTokens: Number(usage?.cacheWrite1hTokens ?? 0) || 0,
        contextTokens: Number(usage?.contextTokens ?? 0) || 0,
        rawTotalTokens, totalTokens, modelKey: modelKey || '', product: product || '',
        // 快速档:让 eventWeightedCost 对本次计费 ×1.5(fast 更快消耗卡额度);空=标准档。
        ...(serviceTier ? { serviceTier } : {}),
      };
      if (usdManaged && applyUsdConsumption) {
        let usd: number;
        try {
          usd = apiValueUsdForEvent(event);
        } catch (error) {
          // Valuation failures must be retryable: no quota was applied yet.
          this.forgetUsageReport(cardId, reportId);
          throw error;
        }
        if (trackUsd5h) {
          const usedBefore = usedUsd5hForProduct(record, product);
          openUsd5hWindow(record, occurredAt, product);
          const state = usdProductUsage(record, product, true);
          if (state) state.used5h = usedBefore + usd;
          else record.usdUsed5h = usedBefore + usd;
        }
        if (trackUsdWeekly) {
          const usedBefore = usedUsdWeeklyForProduct(record, product);
          openUsdWeeklyWindow(record, occurredAt, product);
          const state = usdProductUsage(record, product, true);
          if (state) state.usedWeekly = usedBefore + usd;
          else record.usdUsedWeekly = usedBefore + usd;
        } else if (!usdWeeklyActive) {
          const state = usdProductUsage(record, product);
          if (state) {
            state.windowStartedAtWeekly = undefined;
            state.usedWeekly = undefined;
          } else {
            record.usdWindowStartedAtWeekly = undefined;
            record.usdUsedWeekly = undefined;
          }
        }
      } else if (!usdManaged) {
        resetWeeklyWindowIfExpired(record, now);
        if (!record.tokenUsageEvents) record.tokenUsageEvents = [];
        record.tokenUsageEvents.push(event);
        if (!record.weeklyTokenUsageEvents) record.weeklyTokenUsageEvents = [];
        record.weeklyTokenUsageEvents.push(event);
      }
    }

    // 用量上报【一律不落 access-keys.json】(运行时不写文件):
    // 用量明细走 DB(CardUsageHourly,见 token-usage-tracker);订阅卡的 5h/周窗口走
    // Subscription.windowState(重启精准恢复);文件卡已退役、不再发号也不再持久化用量。
    // access-keys.json 仅作【卡密配置】存储,只在 admin 增删改卡 + 卡密转订阅删影子时写。
    // 此处只就地更新 record 内存计数,供本进程 publicStatus 展示。
    return true;
  }

  // ── Public status ────────────────────────────────────────────────────────
  // The per-card single-session machinery (validateSession/refreshSession) was
  // removed with the card-string runtime credential: session-JWT leases govern
  // multi-device via Device rows + Subscription.deviceLimit instead. The
  // record's session* fields remain as historical data; publicStatus still
  // surfaces hasActiveSession from them for old records.

  /** Get public-safe status for an access key. 周数据仅来自显式 weeklyTokenLimit/weeklyBucketLimits
   *  (决策5:cap5h×R 派生已删)。 */
  publicStatus(record: AccessKeyRecord, alignedResetAt = 0, product = ''): any {
    if (!record) return null;
    const now = this.now();
    const aligned = Number(alignedResetAt || 0) > 0;
    const configuredUsdProducts = record.usdQuotaByProduct
      ? Object.keys(record.usdQuotaByProduct).filter((key) => usesUsdQuotaForProduct(record, key))
      : Array.isArray(record.usdQuotaProducts)
        ? record.usdQuotaProducts.filter((key) => usesUsdQuotaForProduct(record, key))
        : [];
    const legacyAggregateUsd = !record.usdQuotaByProduct
      && !Array.isArray(record.usdQuotaProducts)
      && usesUsdQuota(record);
    const selectedUsdProduct = usdProductKey(product || (configuredUsdProducts.length === 1
      ? configuredUsdProducts[0]
      : legacyAggregateUsd ? '__legacy__' : ''));
    const selectedQuota = selectedUsdProduct === '__legacy__'
      ? { fiveHour: usdQuotaLimit(record.usdLimit5h), weekly: usdQuotaLimit(record.usdLimitWeekly) }
      : selectedUsdProduct
      ? usdQuotaForProduct(record, selectedUsdProduct)
      : { fiveHour: 0, weekly: 0 };
    const usd5hLimit = selectedQuota.fiveHour;
    const usdWeeklyLimit = selectedQuota.weekly;
    const usdManaged = product ? usesUsdQuotaForProduct(record, product) : usesUsdQuota(record);
    if (record.usdQuotaByProduct) {
      for (const quotaProduct of configuredUsdProducts) {
        const quota = usdQuotaForProduct(record, quotaProduct);
        if (quota.fiveHour > 0) expireUsd5hWindow(record, now, quotaProduct);
        if (quota.weekly > 0) expireUsdWeeklyWindow(record, now, quotaProduct);
      }
    } else if (usdManaged) {
      if (usd5hLimit > 0) expireUsd5hWindow(record, now, selectedUsdProduct);
      if (usdWeeklyLimit > 0) expireUsdWeeklyWindow(record, now, selectedUsdProduct);
    } else if (!aligned) {
      resetWindowIfExpired(record, now);
    }
    const recentTokens = aligned || usdManaged ? null : recentTokenUsage(record, now);
    // Bound cards align their window to the account's upstream reset; the client
    // back-derives its local-quota window end from this, so it must match the
    // server's aligned window rather than the global fixed-period one.
    const resetMs = usdManaged
      ? usd5hResetMs(record, now, selectedUsdProduct)
      : alignedResetAt > 0
        ? Math.max(0, alignedResetAt - now)
        : tokenWindowResetMs(record, now);
    const expiresAt = keyExpiresAt(record);

    // Weekly window【只认显式 weeklyTokenLimit / weeklyBucketLimits】(决策5);cap5h×R 派生已删。
    if (!usdManaged) resetWeeklyWindowIfExpired(record, now);
    const wkLimit = weeklyTokenLimit(record);
    const weeklyCapFor = (bucket: string): number => {
      return this.weeklyBucketCap(record, bucket);
    };

    // 是否设了每模型上限(bucketLimits 中有任何 >0 的桶)。
    const hasBucketCaps =
      !!record.bucketLimits &&
      typeof record.bucketLimits === 'object' &&
      Object.values(record.bucketLimits).some((v) => Number(v) > 0);

    // Products the card is sold for (bindings keys with a real account id,
    // or explicit products array for universal cards). Empty = pool card / all products.
    const products = record.bindings && typeof record.bindings === 'object'
      ? Object.keys(record.bindings).filter((p) => Number((record.bindings as Record<string, number>)[p]) > 0)
      : (Array.isArray((record as any).products) ? (record as any).products : []);

    // quotaMode tells the client which quota system to use:
    //   static    — card has per-model caps (bucketLimits), use localQuota
    //   dynamic   — bound card without caps, fair-share + upstream controls quota
    //   unlimited — no caps, no binding
    const quotaMode = usdManaged ? 'usd' : hasBucketCaps ? 'static' : (this.hasAnyBinding(record) ? 'dynamic' : 'unlimited');

    // Composite product-family buckets this card can use. Sum usage by family for
    // the legacy flat fields below (kept until clients consume `buckets` directly).
    const enumBuckets = bucketsForProducts(products);
    const bucketUsage = usdManaged
      ? new Map(enumBuckets.map((bucket) => [bucket, 0]))
      : aligned
      ? new Map(enumBuckets.map((bucket) => [bucket, bucketUsageInWindowReadonly(record, bucket, now, alignedResetAt)]))
      : recentBucketUsage(record, now);
    const recentTotalTokens = [...bucketUsage.values()].reduce((sum, v) => sum + v, 0);
    const familyUsed = (family: string): number => {
      let sum = 0;
      for (const [k, v] of bucketUsage) if (bucketFamily(k) === family) sum += v;
      return sum;
    };
    // 每家族的扁平上限(下发客户端):取 bucketLimits 中该家族各复合桶的最大值。
    // 服务端按复合桶精确兜底,扁平字段仅供客户端 localQuota 快速本地拦截。
    const familyLimit = (family: string): number => {
      let max = 0;
      const bl = (record.bucketLimits && typeof record.bucketLimits === 'object')
        ? (record.bucketLimits as Record<string, number>) : {};
      for (const [k, v] of Object.entries(bl)) {
        if (bucketFamily(k) === family) max = Math.max(max, Number(v) || 0);
      }
      return max;
    };

    // 周桶(显式或派生);任一桶有周上限即视为有周窗口,据此算用量与 reset。
    const weeklyBucketsOut = (usdManaged ? [] : enumBuckets)
      .map((bucket) => ({ bucket, limit: weeklyCapFor(bucket) }))
      .filter((b) => b.limit > 0);
    const hasWeekly = weeklyBucketsOut.length > 0;
    const wkBucketUsage = hasWeekly ? recentWeeklyBucketUsage(record, now) : new Map<string, number>();
    const wkResetMs = hasWeekly ? weeklyWindowResetMs(record, now) : 0;

    return {
      id: record.id,
      name: record.name || '',
      status: record.status || 'active',
      quotaMode,
      usdQuotaByProduct: Object.fromEntries(configuredUsdProducts.map((quotaProduct) => {
        const quota = usdQuotaForProduct(record, quotaProduct);
        const reset5h = usd5hResetMs(record, now, quotaProduct);
        const resetWeekly = usdWeeklyResetMs(record, now, quotaProduct);
        return [quotaProduct, {
          fiveHour: quota.fiveHour > 0 && isUsdScopeActive(record, quotaProduct, 'fiveHour') ? {
            used: usedUsd5hForProduct(record, quotaProduct), limit: quota.fiveHour,
            resetMs: reset5h,
            resetAt: reset5h > 0 ? new Date(now + reset5h).toISOString() : '',
          } : null,
          weekly: quota.weekly > 0 && isUsdScopeActive(record, quotaProduct, 'weekly') ? {
            used: usedUsdWeeklyForProduct(record, quotaProduct), limit: quota.weekly,
            resetMs: resetWeekly,
            resetAt: resetWeekly > 0 ? new Date(now + resetWeekly).toISOString() : '',
          } : null,
        }];
      })),
      // Single-product compatibility for older internal consumers. Multi-product
      // subscriptions intentionally have no aggregate shared pool.
      usdQuota: selectedUsdProduct ? {
        fiveHour: usd5hLimit > 0 && isUsdScopeActive(record, selectedUsdProduct, 'fiveHour') ? {
          used: usedUsd5hForProduct(record, selectedUsdProduct), limit: usd5hLimit,
          resetMs, resetAt: resetMs > 0 ? new Date(now + resetMs).toISOString() : '',
        } : null,
        weekly: usdWeeklyLimit > 0 && isUsdScopeActive(record, selectedUsdProduct, 'weekly') ? {
          used: usedUsdWeeklyForProduct(record, selectedUsdProduct), limit: usdWeeklyLimit,
          resetMs: usdWeeklyResetMs(record, now, selectedUsdProduct),
          resetAt: usdWeeklyResetMs(record, now, selectedUsdProduct) > 0
            ? new Date(now + usdWeeklyResetMs(record, now, selectedUsdProduct)).toISOString()
            : '',
        } : null,
      } : null,
      products,
      firstUsedAt: record.firstUsedAt || '',
      expiresAt,
      remainingMs: expiresAt ? Math.max(0, Date.parse(expiresAt) - now) : 0,
      // 累计计数已下线(权威用量在 CardUsageHourly)。recentWindowTokens 仍是限流窗口
      // 的当前用量(内存),客户端额度展示与限流判断都靠它,保留。
      recentWindowTokens: usdManaged ? 0 : aligned ? recentTotalTokens : recentTokens!.totalTokens,
      // Legacy flat fields (older client contract). Each is the sum across the
      // composite buckets of that family — kept until clients read `buckets`
      // directly. opus≈claude family, gemini, codex≈gpt family.
      opusTokensUsed: familyUsed('claude'),
      opusTokenLimit: familyLimit('claude'),
      geminiTokensUsed: familyUsed('gemini'),
      geminiTokenLimit: familyLimit('gemini'),
      codexTokensUsed: familyUsed('gpt'),
      codexTokenLimit: familyLimit('gpt'),
      // Composite product-family per-bucket view (the authoritative shape).
      buckets: enumBuckets.map((bucket) => ({
        bucket,
        used: bucketUsage.get(bucket) || 0,
        limit: this.billing.bucketLimit(0, bucket, record),
      })),
      tokenWindowMs: tokenWindowMs(record),
      tokenWindowResetMs: resetMs,
      tokenWindowResetAt: resetMs > 0 ? new Date(now + resetMs).toISOString() : '',
      // Weekly window status — 显式 weeklyTokenLimit 或派生(5h×R, anthropic/codex)时有数据。
      weeklyTokenLimit: wkLimit,
      weeklyWindowMs: hasWeekly ? weeklyWindowMsFn(record) : 0,
      weeklyWindowResetMs: wkResetMs,
      weeklyWindowResetAt: wkResetMs > 0 ? new Date(now + wkResetMs).toISOString() : '',
      weeklyBuckets: weeklyBucketsOut.map((b) => ({
        bucket: b.bucket,
        used: wkBucketUsage.get(b.bucket) || 0,
        limit: b.limit,
        weeklyWindowResetMs: wkResetMs,
        weeklyWindowResetAt: wkResetMs > 0 ? new Date(now + wkResetMs).toISOString() : '',
      })),
      hasActiveSession: Boolean(
        record.activeSessionId && !isAccessKeySessionExpired(record, now),
      ),
      lastUsedAt: record.lastUsedAt || '',
      // 卡级 fair-share 份额:weight = 这张卡占的份数,shareCapacity = 号总份数(默认 8)。
      // 客户端「我的卡 · 份额」条展开显示「份额 weight/shareCapacity」。
      weight: Math.max(1, Math.floor(Number((record as any).weight) || 1)),
      shareCapacity: ACCOUNT_SHARE_CAPACITY,
      // 独享:权威标志,客户端「尊贵·独享」badge 据此。与 isExclusiveCard 同口径
      // (显式 exclusive 或 weight≥号总份数),否则满容量卡血条走独享单层、badge 却消失。
      exclusive: this.isExclusiveRecord(record),
    };
  }
}

function isSoftAssignmentPolicy(policy: unknown): boolean {
  const normalized = String(policy || '').toLowerCase();
  return normalized === 'preferred-dynamic' || normalized === 'display-bound-pool';
}
