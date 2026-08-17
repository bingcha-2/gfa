import * as crypto from "crypto";

import type { ProviderQuotaSnapshotInput } from "../lease-core/provider";

export type QuotaEstimatorProvider = "codex" | "anthropic";
export type QuotaEstimatorConfidence = "insufficient" | "low" | "medium" | "high";

export type QuotaEstimatorSnapshot = {
  observedAt: number;
  fiveHourRemainingBps: number | null;
  fiveHourResetAt: number;
  weeklyRemainingBps: number | null;
  weeklyResetAt: number;
  forceFiveHourReset?: boolean;
  forceWeeklyReset?: boolean;
  fiveHourResetOccurredAt?: number;
  weeklyResetOccurredAt?: number;
};

export type QuotaEstimatorScopeState = {
  epoch: number;
  remainingPercent: number | null;
  resetAt: number;
  trackedUsedUsd: number;
  inferredTotalUsd: number | null;
  sampleCount: number;
  sampleBurnBps: number;
  lastSnapshotAt: number;
  lastSampleAt: number;
  confidence: QuotaEstimatorConfidence;
};

export type QuotaEstimatorAccountState = {
  fiveHour?: QuotaEstimatorScopeState;
  weekly?: QuotaEstimatorScopeState;
};

type PendingObservation = {
  provider: QuotaEstimatorProvider;
  accountKey: string;
  accountId: number;
  usageBuckets: Array<{ bucketStartAt: number; maxOccurredAt: number; micros: number }>;
  snapshot?: QuotaEstimatorSnapshot;
};

type EpochCache = { fiveHour: number; weekly: number };
type PendingReset = {
  fiveHourNotBefore?: number;
  weeklyNotBefore?: number;
  fiveHourDeferredMicros?: number;
  weeklyDeferredMicros?: number;
};

const DEFAULT_FLUSH_INTERVAL_MS = 3_000;
const DEFAULT_MAX_ACCOUNTS = 10_000;
const MAX_PIPELINE_ACCOUNTS = 250;
const USAGE_BUCKET_MS = 50;
const MAX_USAGE_BUCKETS_PER_ACCOUNT = 64;
const REDUCE_COMMAND = "gfaQuotaEstimatorReduceV1";
export const ACCOUNT_QUOTA_ESTIMATOR_TTL_SECONDS = 8 * 24 * 60 * 60;
export const ACCOUNT_QUOTA_ESTIMATOR_TOMBSTONE_TTL_SECONDS = 24 * 60 * 60;
const USD_MICROS = 1_000_000;

// One key owns both scopes. A usage-only command never creates the key: only a
// live quota snapshot is allowed to initialize estimator state. This makes DEL
// final for removed accounts even when an old lease reports after deletion.
const REDUCE_LUA = String.raw`
local key = KEYS[1]
local tombstone_key = KEYS[2]
local ttl = tonumber(ARGV[1]) or 691200
local account_id = ARGV[2]
local updated_at = tonumber(ARGV[3]) or 0
local through = tonumber(ARGV[4]) or 0
local after = tonumber(ARGV[5]) or 0
local expected_h = tonumber(ARGV[6]) or 0
local expected_w = tonumber(ARGV[7]) or 0
local h_rem = tonumber(ARGV[8]) or -1
local h_reset = tonumber(ARGV[9]) or 0
local h_observed = tonumber(ARGV[10]) or 0
local h_force_reset = tonumber(ARGV[11]) or 0
local w_rem = tonumber(ARGV[12]) or -1
local w_reset = tonumber(ARGV[13]) or 0
local w_observed = tonumber(ARGV[14]) or 0
local w_force_reset = tonumber(ARGV[15]) or 0
local h_force_anchor = tonumber(ARGV[16]) or 0
local w_force_anchor = tonumber(ARGV[17]) or 0
local h_reset_excluded = tonumber(ARGV[18]) or 0
local w_reset_excluded = tonumber(ARGV[19]) or 0
local h_held = tonumber(ARGV[20]) or 0
local w_held = tonumber(ARGV[21]) or 0
local h_reset_carry = tonumber(ARGV[22]) or 0
local w_reset_carry = tonumber(ARGV[23]) or 0

local MIN_SAMPLE_BPS = 300
local REBOUND_RESET_BPS = 1000
local RESET_BOUNDARY_SKEW_MS = 60000

if redis.call('EXISTS', tombstone_key) == 1 then
  return {0, 0, 0, 0, 0}
end

local exists = redis.call('EXISTS', key) == 1
if not exists and h_rem < 0 and w_rem < 0 then
  return {0, 0, 0, 0, 0}
end
if not exists then
  redis.call('HSET', key, 'version', '1')
end

local function hnum(field, fallback)
  local value = redis.call('HGET', key, field)
  if not value then return fallback end
  return tonumber(value) or fallback
end

local function apply_scope(prefix, incoming_rem, incoming_reset, incoming_observed, force_reset, expected_epoch, force_anchor, reset_excluded, held, reset_carry)
  local epoch_field = prefix .. '_epoch'
  local epoch = hnum(epoch_field, 0)
  local scope_after = math.max(0, after - held)
  local scope_total_usage = through + scope_after

  if epoch <= 0 then
    if incoming_rem < 0 or incoming_observed <= 0 then
      return {0, 0}
    end
    epoch = 1
    redis.call('HSET', key,
      epoch_field, epoch,
      prefix .. '_anchor_remaining_bps', incoming_rem,
      prefix .. '_last_remaining_bps', incoming_rem,
      prefix .. '_reset_at', incoming_reset,
      prefix .. '_observed_at', incoming_observed,
      prefix .. '_pending_micros', scope_after,
      prefix .. '_epoch_used_micros', math.max(0, through + after - reset_excluded) + reset_carry)
    return {epoch, 1}
  end

  local old_observed = hnum(prefix .. '_observed_at', 0)
  local has_new_snapshot = incoming_rem >= 0
    and (incoming_observed > old_observed or force_reset == 1)
  if has_new_snapshot then
    local old_anchor = hnum(prefix .. '_anchor_remaining_bps', incoming_rem)
    local old_last = hnum(prefix .. '_last_remaining_bps', old_anchor)
    local old_reset = hnum(prefix .. '_reset_at', 0)
    local reset_boundary = old_reset > 0
      and incoming_observed >= old_reset - RESET_BOUNDARY_SKEW_MS
      and incoming_reset > old_reset
    local rebound_reset = incoming_rem - old_last >= REBOUND_RESET_BPS
    local is_reset = force_reset == 1 or reset_boundary or rebound_reset

    if is_reset then
      epoch = epoch + 1
      redis.call('HDEL', key,
        prefix .. '_estimate_micros',
        prefix .. '_sample_count',
        prefix .. '_sample_burn_bps',
        prefix .. '_last_sample_at')
      redis.call('HSET', key,
        epoch_field, epoch,
        prefix .. '_anchor_remaining_bps', incoming_rem,
        prefix .. '_last_remaining_bps', incoming_rem,
        prefix .. '_reset_at', incoming_reset,
        prefix .. '_observed_at', incoming_observed,
        prefix .. '_pending_micros', scope_after,
        prefix .. '_epoch_used_micros', math.max(0, through + after - reset_excluded) + reset_carry)
      return {epoch, 1}
    end

    local old_pending = hnum(prefix .. '_pending_micros', 0)
    local old_epoch_used = hnum(prefix .. '_epoch_used_micros', 0)
    local segment_usage = old_pending + through
    redis.call('HSET', key,
      prefix .. '_last_remaining_bps', incoming_rem,
      prefix .. '_reset_at', incoming_reset,
      prefix .. '_observed_at', incoming_observed,
      prefix .. '_epoch_used_micros', old_epoch_used + scope_total_usage)

    if force_anchor == 1 then
      redis.call('HSET', key,
        prefix .. '_anchor_remaining_bps', incoming_rem,
        prefix .. '_pending_micros', scope_after)
      return {epoch, 1}
    end

    local burn = old_anchor - incoming_rem
    if burn >= MIN_SAMPLE_BPS and segment_usage > 0 then
      local candidate = math.floor(segment_usage * 10000 / burn + 0.5)
      local count = hnum(prefix .. '_sample_count', 0)
      local old_estimate = hnum(prefix .. '_estimate_micros', 0)
      local weight = math.min(count, 4)
      local estimate = candidate
      if old_estimate > 0 and weight > 0 then
        estimate = math.floor((old_estimate * weight + candidate) / (weight + 1) + 0.5)
      end
      redis.call('HSET', key,
        prefix .. '_estimate_micros', estimate,
        prefix .. '_sample_count', count + 1,
        prefix .. '_sample_burn_bps', hnum(prefix .. '_sample_burn_bps', 0) + burn,
        prefix .. '_last_sample_at', incoming_observed,
        prefix .. '_anchor_remaining_bps', incoming_rem,
        prefix .. '_pending_micros', scope_after)
    else
      redis.call('HSET', key, prefix .. '_pending_micros', segment_usage + scope_after)
    end
    return {epoch, 1}
  end

  if scope_total_usage > 0 and expected_epoch == epoch then
    redis.call('HINCRBY', key, prefix .. '_pending_micros', scope_total_usage)
    redis.call('HINCRBY', key, prefix .. '_epoch_used_micros', scope_total_usage)
    return {epoch, 1}
  end
  return {epoch, 0}
end

local h = apply_scope('h', h_rem, h_reset, h_observed, h_force_reset, expected_h, h_force_anchor, h_reset_excluded, h_held, h_reset_carry)
local w = apply_scope('w', w_rem, w_reset, w_observed, w_force_reset, expected_w, w_force_anchor, w_reset_excluded, w_held, w_reset_carry)
local touched = h[2] == 1 or w[2] == 1
if touched then
  redis.call('HSET', key, 'account_id', account_id, 'updated_at', updated_at)
  redis.call('EXPIRE', key, ttl)
end
return {1, h[1], w[1], h[2], w[2]}
`;

const DELETE_LUA = String.raw`
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], '1', 'EX', ARGV[1])
return 1
`;

function estimatorSecret(): string {
  return String(
    process.env.LEASE_PROOF_SECRET
    || process.env.CUSTOMER_JWT_SECRET
    || process.env.JWT_SECRET
    || "",
  );
}

/** Privacy-safe, deterministic mother-account identity. Email is deliberately
 * used for v1 because it exists for both providers before their optional
 * upstream UUID has been discovered; switching identity sources later would
 * split one account into two Redis histories. */
export function quotaEstimatorAccountKey(
  provider: string,
  email: unknown,
  secret = estimatorSecret(),
): string {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedProvider || !normalizedEmail) return "";
  const identity = `${normalizedProvider}\0email\0${normalizedEmail}`;
  const digest = secret
    ? crypto.createHmac("sha256", secret).update(identity).digest("hex")
    : crypto.createHash("sha256").update(identity).digest("hex");
  return digest.slice(0, 32);
}

function percentToBps(value: unknown, present: boolean | undefined): number | null {
  if (present === false || value === null || value === undefined) return null;
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Math.round(percent * 100);
}

function dateMs(value: Date | null | undefined): number {
  const ms = value instanceof Date ? value.getTime() : 0;
  return Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : 0;
}

export function quotaEstimatorSnapshotFromInputs(
  inputs: ProviderQuotaSnapshotInput[] | null | undefined,
  observedAt: unknown,
  reset: { fiveHour?: boolean; weekly?: boolean } = {},
): QuotaEstimatorSnapshot | undefined {
  const input = (inputs || []).find((candidate) => (
    percentToBps(candidate.hourlyPercent, candidate.hourlyPresent) !== null
    || percentToBps(candidate.weeklyPercent, candidate.weeklyPresent) !== null
  ));
  if (!input) return undefined;
  const parsedObservedAt = Number(observedAt);
  const at = Number.isFinite(parsedObservedAt) && parsedObservedAt > 0
    ? Math.trunc(parsedObservedAt)
    : Date.now();
  return {
    observedAt: at,
    fiveHourRemainingBps: percentToBps(input.hourlyPercent, input.hourlyPresent),
    fiveHourResetAt: dateMs(input.hourlyResetAt),
    weeklyRemainingBps: percentToBps(input.weeklyPercent, input.weeklyPresent),
    weeklyResetAt: dateMs(input.weeklyResetAt),
    ...(reset.fiveHour ? { forceFiveHourReset: true } : {}),
    ...(reset.weekly ? { forceWeeklyReset: true } : {}),
  };
}

function redisKey(provider: QuotaEstimatorProvider, accountKey: string): string {
  return `gfa:quota-estimator:v1:{${provider}:${accountKey}}`;
}

function tombstoneKey(provider: QuotaEstimatorProvider, accountKey: string): string {
  return `gfa:quota-estimator-deleted:v1:{${provider}:${accountKey}}`;
}

function safeMicros(usd: unknown): number {
  const value = Number(usd);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value * USD_MICROS));
}

function addUsageBucket(pending: PendingObservation, micros: number, occurredAt: number): void {
  if (micros <= 0) return;
  const at = occurredAt > 0 ? occurredAt : Number.MAX_SAFE_INTEGER;
  const bucketStartAt = at === Number.MAX_SAFE_INTEGER
    ? at
    : Math.floor(at / USAGE_BUCKET_MS) * USAGE_BUCKET_MS;
  const existing = pending.usageBuckets.find((bucket) => bucket.bucketStartAt === bucketStartAt);
  if (existing) {
    existing.micros += micros;
    existing.maxOccurredAt = Math.max(existing.maxOccurredAt, at);
    return;
  }
  pending.usageBuckets.push({ bucketStartAt, maxOccurredAt: at, micros });
  if (pending.usageBuckets.length <= MAX_USAGE_BUCKETS_PER_ACCOUNT) return;
  pending.usageBuckets.sort((left, right) => left.maxOccurredAt - right.maxOccurredAt);
  const first = pending.usageBuckets.shift()!;
  const second = pending.usageBuckets.shift()!;
  pending.usageBuckets.unshift({
    bucketStartAt: second.bucketStartAt,
    maxOccurredAt: second.maxOccurredAt,
    micros: first.micros + second.micros,
  });
}

function partitionUsage(item: PendingObservation): {
  through: number;
  after: number;
  fiveHourResetExcluded: number;
  weeklyResetExcluded: number;
} {
  let through = 0;
  let after = 0;
  let fiveHourResetExcluded = 0;
  let weeklyResetExcluded = 0;
  const snapshotAt = item.snapshot?.observedAt || 0;
  const fiveHourResetAt = item.snapshot?.fiveHourResetOccurredAt || 0;
  const weeklyResetAt = item.snapshot?.weeklyResetOccurredAt || 0;
  for (const bucket of item.usageBuckets) {
    if (snapshotAt > 0 && bucket.maxOccurredAt <= snapshotAt) through += bucket.micros;
    else after += bucket.micros;
    if (fiveHourResetAt > 0 && bucket.maxOccurredAt < fiveHourResetAt) {
      fiveHourResetExcluded += bucket.micros;
    }
    if (weeklyResetAt > 0 && bucket.maxOccurredAt < weeklyResetAt) {
      weeklyResetExcluded += bucket.micros;
    }
  }
  return { through, after, fiveHourResetExcluded, weeklyResetExcluded };
}

function usageAtOrAfter(item: PendingObservation, cutoff: number): number {
  if (cutoff <= 0) return 0;
  return item.usageBuckets.reduce(
    (sum, bucket) => sum + (bucket.maxOccurredAt >= cutoff ? bucket.micros : 0),
    0,
  );
}

function scopeConfidence(sampleCount: number, sampleBurnBps: number): QuotaEstimatorConfidence {
  if (sampleCount <= 0) return "insufficient";
  if (sampleCount >= 3 && sampleBurnBps >= 3_000) return "high";
  if (sampleCount >= 2 && sampleBurnBps >= 1_000) return "medium";
  return "low";
}

function hashNumber(hash: Record<string, string>, field: string): number {
  const value = Number(hash[field]);
  return Number.isFinite(value) ? value : 0;
}

function parseScope(hash: Record<string, string>, prefix: "h" | "w"): QuotaEstimatorScopeState | undefined {
  const epoch = hashNumber(hash, `${prefix}_epoch`);
  if (epoch <= 0) return undefined;
  const remainingBps = hashNumber(hash, `${prefix}_last_remaining_bps`);
  const estimateMicros = hashNumber(hash, `${prefix}_estimate_micros`);
  const sampleCount = hashNumber(hash, `${prefix}_sample_count`);
  const sampleBurnBps = hashNumber(hash, `${prefix}_sample_burn_bps`);
  return {
    epoch,
    remainingPercent: remainingBps >= 0 ? remainingBps / 100 : null,
    resetAt: hashNumber(hash, `${prefix}_reset_at`),
    trackedUsedUsd: hashNumber(hash, `${prefix}_epoch_used_micros`) / USD_MICROS,
    inferredTotalUsd: estimateMicros > 0 ? estimateMicros / USD_MICROS : null,
    sampleCount,
    sampleBurnBps,
    lastSnapshotAt: hashNumber(hash, `${prefix}_observed_at`),
    lastSampleAt: hashNumber(hash, `${prefix}_last_sample_at`),
    confidence: scopeConfidence(sampleCount, sampleBurnBps),
  };
}

export class AccountQuotaEstimator {
  private pending = new Map<string, PendingObservation>();
  private readonly epochs = new Map<string, EpochCache>();
  /** Bitmask per account: 1 = five-hour, 2 = weekly. */
  private readonly needsAnchor = new Map<string, number>();
  /** Successful manual resets waiting for the next valid scope snapshot. */
  private readonly pendingResets = new Map<string, PendingReset>();
  private readonly deleting = new Set<string>();
  private readonly flushIntervalMs: number;
  private readonly maxAccounts: number;
  private readonly ttlSeconds: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushPromise: Promise<void> | null = null;
  private destroyed = false;
  private droppedBatches = 0;
  private epochMismatches = 0;

  constructor(
    private readonly redis: any,
    options: {
      autoStart?: boolean;
      flushIntervalMs?: number;
      maxAccounts?: number;
      ttlSeconds?: number;
    } = {},
  ) {
    this.flushIntervalMs = Math.max(250, Number(options.flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS));
    this.maxAccounts = Math.max(1, Math.trunc(Number(options.maxAccounts || DEFAULT_MAX_ACCOUNTS)));
    this.ttlSeconds = Math.max(60, Math.trunc(Number(options.ttlSeconds || ACCOUNT_QUOTA_ESTIMATOR_TTL_SECONDS)));
    this.redis?.on?.("error", () => undefined);
    this.redis?.defineCommand?.(REDUCE_COMMAND, { numberOfKeys: 2, lua: REDUCE_LUA });
    if (options.autoStart !== false) {
      this.flushTimer = setInterval(() => void this.flush(), this.flushIntervalMs);
      (this.flushTimer as any)?.unref?.();
    }
  }

  recordReport(input: {
    provider: QuotaEstimatorProvider;
    accountKey: string;
    accountId: number;
    apiValueUsd?: number;
    usageOccurredAt?: number;
    snapshot?: QuotaEstimatorSnapshot;
  }): void {
    const provider = input.provider;
    const accountKey = String(input.accountKey || "");
    if ((provider !== "codex" && provider !== "anthropic") || !accountKey) return;
    const micros = safeMicros(input.apiValueUsd);
    if (micros <= 0 && !input.snapshot) return;
    const mapKey = `${provider}:${accountKey}`;
    if (this.destroyed || this.deleting.has(mapKey)) return;
    const pendingReset = this.pendingResets.get(mapKey);
    const snapshotObservedAt = Number(input.snapshot?.observedAt || 0);
    const resetMask = (
      pendingReset?.fiveHourNotBefore !== undefined
      && snapshotObservedAt >= pendingReset.fiveHourNotBefore
        ? 1
        : 0
    ) | (
      pendingReset?.weeklyNotBefore !== undefined
      && snapshotObservedAt >= pendingReset.weeklyNotBefore
        ? 2
        : 0
    );
    const snapshot = input.snapshot ? {
      ...input.snapshot,
      ...((resetMask & 1) ? {
        forceFiveHourReset: true,
        fiveHourResetOccurredAt: pendingReset?.fiveHourNotBefore,
      } : {}),
      ...((resetMask & 2) ? {
        forceWeeklyReset: true,
        weeklyResetOccurredAt: pendingReset?.weeklyNotBefore,
      } : {}),
    } : undefined;
    let pending = this.pending.get(mapKey);
    if (!pending) {
      if (this.pending.size >= this.maxAccounts) {
        this.droppedBatches++;
        return;
      }
      pending = {
        provider,
        accountKey,
        accountId: Math.max(0, Math.trunc(Number(input.accountId) || 0)),
        usageBuckets: [],
      };
      this.pending.set(mapKey, pending);
    }
    pending.accountId = Math.max(0, Math.trunc(Number(input.accountId) || pending.accountId));
    const usageOccurredAt = Math.max(0, Math.trunc(Number(input.usageOccurredAt) || 0));
    addUsageBucket(pending, micros, usageOccurredAt);
    if (snapshot) {
      const existingSnapshot = pending.snapshot;
      const replacesSnapshot = !existingSnapshot
        || snapshot.observedAt >= existingSnapshot.observedAt
        || snapshot.forceFiveHourReset
        || snapshot.forceWeeklyReset;
      if (!replacesSnapshot) {
        return;
      }
      pending.snapshot = snapshot;
    }
  }

  markReset(input: {
    provider: QuotaEstimatorProvider;
    accountKey: string;
    fiveHour?: boolean;
    weekly?: boolean;
    /** Reject cached snapshots captured before the upstream reset succeeded. */
    resetOccurredAt?: number;
  }): void {
    const accountKey = String(input.accountKey || "");
    if (!accountKey || this.destroyed) return;
    const mapKey = `${input.provider}:${accountKey}`;
    const mask = (input.fiveHour ? 1 : 0) | (input.weekly ? 2 : 0);
    if (!mask || this.deleting.has(mapKey)) return;
    if (this.pendingResets.size < this.maxAccounts || this.pendingResets.has(mapKey)) {
      const resetOccurredAt = Math.max(0, Math.trunc(Number(input.resetOccurredAt) || 0));
      const pending = this.pendingResets.get(mapKey) || {};
      if (mask & 1) {
        if (resetOccurredAt > (pending.fiveHourNotBefore || 0)) pending.fiveHourDeferredMicros = 0;
        pending.fiveHourNotBefore = Math.max(pending.fiveHourNotBefore || 0, resetOccurredAt);
      }
      if (mask & 2) {
        if (resetOccurredAt > (pending.weeklyNotBefore || 0)) pending.weeklyDeferredMicros = 0;
        pending.weeklyNotBefore = Math.max(pending.weeklyNotBefore || 0, resetOccurredAt);
      }
      this.pendingResets.set(mapKey, pending);
    }
  }

  recordSnapshot(input: {
    provider: QuotaEstimatorProvider;
    accountKey: string;
    accountId: number;
    snapshot: QuotaEstimatorSnapshot;
  }): void {
    this.recordReport({ ...input, apiValueUsd: 0 });
  }

  async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    if (this.pending.size === 0 || this.destroyed) return;
    const batch = this.pending;
    this.pending = new Map();
    const run = this.flushBatch(batch).finally(() => {
      this.flushPromise = null;
    });
    this.flushPromise = run;
    return run;
  }

  private async flushBatch(batch: Map<string, PendingObservation>): Promise<void> {
    const items = [...batch.entries()];
    for (let offset = 0; offset < items.length; offset += MAX_PIPELINE_ACCOUNTS) {
      await this.flushItems(items.slice(offset, offset + MAX_PIPELINE_ACCOUNTS));
    }
  }

  private async flushItems(items: Array<[string, PendingObservation]>): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const [mapKey, item] of items) {
      const epoch = this.epochs.get(mapKey) || { fiveHour: 0, weekly: 0 };
      const snapshot = item.snapshot;
      const pendingReset = this.pendingResets.get(mapKey);
      // A reset callback can run after a fresh snapshot was already queued but
      // before this batch flushes. Promote that queued post-reset snapshot here
      // so the marker cannot wait for an unnecessary later observation.
      if (
        snapshot
        && pendingReset?.fiveHourNotBefore !== undefined
        && snapshot.observedAt >= pendingReset.fiveHourNotBefore
      ) {
        snapshot.forceFiveHourReset = true;
        snapshot.fiveHourResetOccurredAt = pendingReset.fiveHourNotBefore;
      }
      if (
        snapshot
        && pendingReset?.weeklyNotBefore !== undefined
        && snapshot.observedAt >= pendingReset.weeklyNotBefore
      ) {
        snapshot.forceWeeklyReset = true;
        snapshot.weeklyResetOccurredAt = pendingReset.weeklyNotBefore;
      }
      const usage = partitionUsage(item);
      const currentFiveHourDeferred = usageAtOrAfter(item, pendingReset?.fiveHourNotBefore || 0);
      const currentWeeklyDeferred = usageAtOrAfter(item, pendingReset?.weeklyNotBefore || 0);
      const previousFiveHourDeferred = pendingReset?.fiveHourDeferredMicros || 0;
      const previousWeeklyDeferred = pendingReset?.weeklyDeferredMicros || 0;
      if (pendingReset?.fiveHourNotBefore !== undefined) {
        pendingReset.fiveHourDeferredMicros = previousFiveHourDeferred + currentFiveHourDeferred;
      }
      if (pendingReset?.weeklyNotBefore !== undefined) {
        pendingReset.weeklyDeferredMicros = previousWeeklyDeferred + currentWeeklyDeferred;
      }
      const forceFiveHourReset = snapshot?.forceFiveHourReset === true;
      const forceWeeklyReset = snapshot?.forceWeeklyReset === true;
      const args = [
        redisKey(item.provider, item.accountKey),
        tombstoneKey(item.provider, item.accountKey),
        String(this.ttlSeconds),
        String(item.accountId),
        String(Date.now()),
        String(usage.through),
        String(usage.after),
        String(epoch.fiveHour),
        String(epoch.weekly),
        String(snapshot?.fiveHourRemainingBps ?? -1),
        String(snapshot?.fiveHourResetAt ?? 0),
        String(snapshot?.observedAt ?? 0),
        snapshot?.forceFiveHourReset ? "1" : "0",
        String(snapshot?.weeklyRemainingBps ?? -1),
        String(snapshot?.weeklyResetAt ?? 0),
        String(snapshot?.observedAt ?? 0),
        snapshot?.forceWeeklyReset ? "1" : "0",
        (this.needsAnchor.get(mapKey) || 0) & 1 ? "1" : "0",
        (this.needsAnchor.get(mapKey) || 0) & 2 ? "1" : "0",
        String(usage.fiveHourResetExcluded),
        String(usage.weeklyResetExcluded),
        String(forceFiveHourReset ? 0 : currentFiveHourDeferred),
        String(forceWeeklyReset ? 0 : currentWeeklyDeferred),
        String(forceFiveHourReset ? previousFiveHourDeferred : 0),
        String(forceWeeklyReset ? previousWeeklyDeferred : 0),
      ];
      if (typeof pipeline[REDUCE_COMMAND] === "function") {
        pipeline[REDUCE_COMMAND](...args);
      } else {
        pipeline.eval(REDUCE_LUA, 2, ...args);
      }
    }

    let results: Array<[Error | null, unknown]> | null = null;
    try {
      results = await pipeline.exec();
    } catch {
      results = null;
    }
    if (!results) {
      this.droppedBatches += items.length;
      for (const [mapKey] of items) this.rememberNeedsAnchor(mapKey, 3);
      return;
    }
    for (let index = 0; index < items.length; index++) {
      const [mapKey, item] = items[index];
      const [error, raw] = results[index] || [new Error("missing pipeline result"), null];
      if (error || !Array.isArray(raw)) {
        this.droppedBatches++;
        this.rememberNeedsAnchor(mapKey, 3);
        continue;
      }
      const hEpoch = Number(raw[1] || 0);
      const wEpoch = Number(raw[2] || 0);
      if (hEpoch > 0 || wEpoch > 0) {
        if (this.epochs.size < this.maxAccounts || this.epochs.has(mapKey)) {
          this.epochs.set(mapKey, { fiveHour: hEpoch, weekly: wEpoch });
        }
      }
      const totalUsage = item.usageBuckets.reduce((sum, bucket) => sum + bucket.micros, 0);
      let mismatchMask = 0;
      if (totalUsage > 0 && hEpoch > 0 && Number(raw[3] || 0) === 0) {
        this.epochMismatches++;
        mismatchMask |= 1;
      }
      if (totalUsage > 0 && wEpoch > 0 && Number(raw[4] || 0) === 0) {
        this.epochMismatches++;
        mismatchMask |= 2;
      }
      this.rememberNeedsAnchor(mapKey, mismatchMask);
      if (item.snapshot) {
        let anchoredMask = 0;
        if (item.snapshot.fiveHourRemainingBps !== null && Number(raw[3] || 0) === 1) anchoredMask |= 1;
        if (item.snapshot.weeklyRemainingBps !== null && Number(raw[4] || 0) === 1) anchoredMask |= 2;
        this.clearNeedsAnchor(mapKey, anchoredMask);
        let resetMask = 0;
        if (item.snapshot.forceFiveHourReset && Number(raw[3] || 0) === 1) resetMask |= 1;
        if (item.snapshot.forceWeeklyReset && Number(raw[4] || 0) === 1) resetMask |= 2;
        this.clearPendingReset(mapKey, resetMask);
      }
    }
  }

  private rememberNeedsAnchor(mapKey: string, scopeMask: number): void {
    if (!scopeMask) return;
    if (this.needsAnchor.size < this.maxAccounts || this.needsAnchor.has(mapKey)) {
      this.needsAnchor.set(mapKey, (this.needsAnchor.get(mapKey) || 0) | scopeMask);
    }
  }

  private clearNeedsAnchor(mapKey: string, scopeMask: number): void {
    if (!scopeMask) return;
    const remaining = (this.needsAnchor.get(mapKey) || 0) & ~scopeMask;
    if (remaining) this.needsAnchor.set(mapKey, remaining);
    else this.needsAnchor.delete(mapKey);
  }

  private clearPendingReset(mapKey: string, scopeMask: number): void {
    if (!scopeMask) return;
    const pending = this.pendingResets.get(mapKey);
    if (!pending) return;
    if (scopeMask & 1) {
      delete pending.fiveHourNotBefore;
      delete pending.fiveHourDeferredMicros;
    }
    if (scopeMask & 2) {
      delete pending.weeklyNotBefore;
      delete pending.weeklyDeferredMicros;
    }
    if (pending.fiveHourNotBefore !== undefined || pending.weeklyNotBefore !== undefined) {
      this.pendingResets.set(mapKey, pending);
    } else {
      this.pendingResets.delete(mapKey);
    }
  }

  async readMany(
    accounts: Array<{ provider: QuotaEstimatorProvider; accountKey: string }>,
  ): Promise<Map<string, QuotaEstimatorAccountState>> {
    const unique = [...new Map(
      accounts
        .filter((item) => item.accountKey && (item.provider === "codex" || item.provider === "anthropic"))
        .map((item) => [`${item.provider}:${item.accountKey}`, item]),
    ).entries()].slice(0, this.maxAccounts);
    const output = new Map<string, QuotaEstimatorAccountState>();
    if (unique.length === 0) return output;
    for (let offset = 0; offset < unique.length; offset += MAX_PIPELINE_ACCOUNTS) {
      const items = unique.slice(offset, offset + MAX_PIPELINE_ACCOUNTS);
      const pipeline = this.redis.pipeline();
      for (const [, item] of items) pipeline.hgetall(redisKey(item.provider, item.accountKey));
      let results: Array<[Error | null, unknown]> | null = null;
      try {
        results = await pipeline.exec();
      } catch {
        continue;
      }
      if (!results) continue;
      for (let index = 0; index < items.length; index++) {
        const [mapKey] = items[index];
        const [error, raw] = results[index] || [new Error("missing pipeline result"), null];
        if (error || !raw || typeof raw !== "object") continue;
        const hash = raw as Record<string, string>;
        const state: QuotaEstimatorAccountState = {
          fiveHour: parseScope(hash, "h"),
          weekly: parseScope(hash, "w"),
        };
        if (state.fiveHour || state.weekly) output.set(mapKey, state);
      }
    }
    return output;
  }

  async deleteAccount(provider: QuotaEstimatorProvider, accountKey: string): Promise<void> {
    if (!accountKey) return;
    const mapKey = `${provider}:${accountKey}`;
    this.deleting.add(mapKey);
    this.pending.delete(mapKey);
    this.epochs.delete(mapKey);
    this.needsAnchor.delete(mapKey);
    this.pendingResets.delete(mapKey);
    try {
      await this.flushPromise?.catch(() => undefined);
      this.pending.delete(mapKey);
      await this.redis.eval(
        DELETE_LUA,
        2,
        redisKey(provider, accountKey),
        tombstoneKey(provider, accountKey),
        String(ACCOUNT_QUOTA_ESTIMATOR_TOMBSTONE_TTL_SECONDS),
      );
    } catch {
      // Best-effort estimator cleanup; the fixed key also has an 8-day TTL.
    } finally {
      // A report that raced the DEL was rejected while this marker was present.
      this.pending.delete(mapKey);
      this.deleting.delete(mapKey);
    }
  }

  diagnostics(): { pendingAccounts: number; droppedBatches: number; epochMismatches: number } {
    return {
      pendingAccounts: this.pending.size,
      droppedBatches: this.droppedBatches,
      epochMismatches: this.epochMismatches,
    };
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await this.flush().catch(() => undefined);
    this.destroyed = true;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect?.();
    }
  }
}
