/**
 * lease-scheduler.ts — Account selection, retry policy, enterprise probing, error rate tracking.
 *
 * Extracted from remote-token-server/index.js (L1591-L1895).
 * Contains the pure/testable parts of lease scheduling.
 * The stateful orchestration (leases Map, clientAffinity Map, tokenManager calls)
 * remains in the controller/server module.
 */

import {
  normalizeModelKey,
} from './token-billing';

// ── Error rate tracking (sliding 60s window) ─────────────────────────────────

const ERROR_RATE_WINDOW_MS = 60 * 1000;

interface ErrorEvent {
  status: number;
  modelKey: string;
  at: number;
}

export class ErrorRateTracker {
  private events: ErrorEvent[] = [];

  record(status: number, modelKey: string, at = Date.now()): void {
    this.events.push({ status, modelKey: normalizeModelKey(modelKey), at });
  }

  prune(now = Date.now()): void {
    this.events = this.events.filter((e) => now - e.at < ERROR_RATE_WINDOW_MS);
  }

  rates(modelKey: string, now = Date.now()) {
    this.prune(now);
    const model = normalizeModelKey(modelKey);
    const relevant = model
      ? this.events.filter((e) => e.modelKey === model)
      : this.events;
    const total = relevant.length || 1;
    return {
      count503: relevant.filter((e) => e.status === 503).length,
      count429: relevant.filter((e) => e.status === 429).length,
      total: relevant.length,
      rate503: relevant.filter((e) => e.status === 503).length / total,
      rate429: relevant.filter((e) => e.status === 429).length / total,
    };
  }
}

// ── Enterprise adaptive probing ──────────────────────────────────────────────

const ENTERPRISE_CYCLE_MS = 10 * 60 * 1000;
const ENTERPRISE_PROBE_PHASE_MS = 3 * 60 * 1000;
const ENTERPRISE_MIN_SAMPLES = 4;
const ENTERPRISE_EMERGENCY_THRESHOLD = 5;

interface EnterpriseGroup {
  cycleStart: number;
  successes: number;
  failures: number;
  consecutiveFails: number;
  weight: number;
  emergency: boolean;
}

export class EnterpriseProbeManager {
  private groups: Record<string, EnterpriseGroup> = {};
  private log: (...args: any[]) => void;

  constructor(options: { log?: (...args: any[]) => void } = {}) {
    this.log = options.log || console.log;
  }

  getGroup(email: string): string | null {
    const e = String(email || '').toLowerCase();
    if (e.endsWith('@gmail.com')) return null;
    const atIdx = e.indexOf('@');
    if (atIdx < 0) return null;
    return e.substring(atIdx + 1);
  }

  private ensureCycle(group: string): EnterpriseGroup {
    if (!this.groups[group]) {
      this.groups[group] = {
        cycleStart: Date.now(), successes: 0, failures: 0,
        consecutiveFails: 0, weight: 3, emergency: false,
      };
    }
    const g = this.groups[group];
    const now = Date.now();
    if (now - g.cycleStart >= ENTERPRISE_CYCLE_MS) {
      const oldRate = (g.successes + g.failures) > 0
        ? Math.round(g.successes / (g.successes + g.failures) * 100) : -1;
      this.log(`[enterprise-probe] ${group} cycle reset (prev: ${g.successes}ok/${g.failures}fail=${oldRate}% → weight was ${g.weight.toFixed(1)})`);
      g.cycleStart = now;
      g.successes = 0;
      g.failures = 0;
      g.consecutiveFails = 0;
      g.weight = 3;
      g.emergency = false;
    }
    return g;
  }

  reportResult(email: string, success: boolean): void {
    const group = this.getGroup(email);
    if (!group) return;
    const g = this.ensureCycle(group);

    if (success) {
      g.successes++;
      g.consecutiveFails = 0;
      g.emergency = false;
    } else {
      g.failures++;
      g.consecutiveFails++;
    }

    const total = g.successes + g.failures;
    if (total >= ENTERPRISE_MIN_SAMPLES) {
      const rate = g.successes / total;
      if (rate > 0.5) g.weight = 6;
      else if (rate > 0.3) g.weight = 3;
      else if (rate > 0.15) g.weight = 1.5;
      else g.weight = 0.5;
    }

    if (g.consecutiveFails >= ENTERPRISE_EMERGENCY_THRESHOLD && !g.emergency) {
      g.emergency = true;
      g.weight = 0.5;
      this.log(`[enterprise-probe] ${group} EMERGENCY: ${g.consecutiveFails} consecutive failures → weight 0.5`);
    }
  }

  getWeight(email: string): number | null {
    const group = this.getGroup(email);
    if (!group) return null;
    const g = this.ensureCycle(group);
    const inProbePhase = (Date.now() - g.cycleStart) < ENTERPRISE_PROBE_PHASE_MS;
    if (inProbePhase) return Math.max(3, g.weight);
    if (g.weight <= 1.5) return Math.max(0.3, g.weight);
    return g.weight;
  }

  getStatus(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [group, g] of Object.entries(this.groups)) {
      this.ensureCycle(group);
      const total = g.successes + g.failures;
      result[group] = {
        weight: g.weight,
        successes: g.successes,
        failures: g.failures,
        rate: total > 0 ? Math.round(g.successes / total * 100) : null,
        emergency: g.emergency,
        cycleMinutesLeft: Math.max(0, Math.round((ENTERPRISE_CYCLE_MS - (Date.now() - g.cycleStart)) / 60000)),
      };
    }
    return result;
  }
}

// ── Account weight calculation ───────────────────────────────────────────────

/**
 * Calculate an account's selection weight based on plan type and enterprise status.
 */
export function accountWeight(
  account: any,
  enterpriseProbe: EnterpriseProbeManager | null,
): number {
  const configured = Number(account.remoteWeight ?? account.weight ?? 0);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const plan = String(account.planType || '').toLowerCase();
  const baseWeight = plan.includes('ultra') ? 3
    : (plan.includes('premium') || plan.includes('pro')) ? 2
    : 1;

  if (enterpriseProbe) {
    const enterpriseWeight = enterpriseProbe.getWeight(account.email);
    if (enterpriseWeight !== null) return enterpriseWeight;
  }

  return baseWeight;
}

/**
 * Check if an account has remaining 5h model quota for a given model key.
 * Returns true (no penalty) when:
 *   - No modelQuotaFractions data exists (unknown → assume has quota)
 *   - The requested model is not in the fractions map (no data for this model)
 *   - The fraction is > 0 (has remaining quota)
 * Returns false (should penalize) only when fraction === 0 for the exact model.
 */
export function hasModelQuotaRemaining(account: any, modelKey: string): boolean {
  const f = getModelQuotaFraction(account, modelKey);
  return f === null || f === -1 || f > 0;
}

/**
 * Get the remaining 5h model quota fraction for a given model key.
 * Returns:
 *   - null:  no fractions data at all (truly unknown → no penalty)
 *   - -1:   fractions exist for other models but not the target (暂无 → moderate penalty)
 *   - 0..1: the remaining fraction (0 = exhausted, 1 = full)
 */
/**
 * Resolve a model key against a per-model map (modelQuotaFractions /
 * modelQuotaResetTimes), with exact then fuzzy matching
 * (e.g. "gemini-2.5-pro" ↔ "gemini-2.5-pro-preview"). Returns the matched map
 * key, or null if no match. Shared by getModelQuotaFraction/getModelQuotaResetAt.
 */
export function resolveModelQuotaKey(
  map: Record<string, any> | undefined | null,
  modelKey: string,
): string | null {
  if (!map || typeof map !== 'object') return null;
  const normalized = normalizeModelKey(modelKey);
  if (!normalized) return null;
  if (normalized in map) return normalized;
  for (const key of Object.keys(map)) {
    if (key.includes(normalized) || normalized.includes(key)) return key;
  }
  return null;
}

export function getModelQuotaFraction(account: any, modelKey: string, now: number = Date.now()): number | null {
  const fractions = account?.modelQuotaFractions;
  if (!fractions || typeof fractions !== 'object') return null;
  if (!normalizeModelKey(modelKey)) return null;

  const key = resolveModelQuotaKey(fractions, modelKey);
  if (key) {
    // Stale-after-reset guard: once this window's reset time has passed, the
    // stored fraction reflects the PRE-reset window — the upstream window has
    // since rolled over and refilled, but no fresh client snapshot has arrived
    // yet (idle accounts may never get one until they're leased). Trusting the
    // pre-reset value would pin a reset-but-stale-0 account to Tier 3 (last
    // resort) indefinitely. Treat the window as refilled (full) instead — which
    // is what a passed reset means — so the account returns to normal priority
    // and self-corrects on the next usage report (a 429 re-parks it). This is
    // consistent with getModelResetBonus, which already treats a passed reset
    // as the most-preferred case. Applies to BOTH providers: codex
    // (account-level "codex" key) and antigravity (per-model keys) store reset
    // times identically.
    const resetAt = getModelQuotaResetAt(account, modelKey);
    if (resetAt > 0 && resetAt <= now) return 1;
    return Math.max(0, Math.min(1, Number(fractions[key]) || 0));
  }

  // Has fractions for other models but not this one → 暂无
  if (Object.keys(fractions).length > 0) return -1;

  return null; // empty object → same as no data
}

/**
 * Resolve when a model's 5h rolling quota next refreshes, as an epoch-ms
 * timestamp. Returns 0 if unknown / unparseable. Used to park a 429-exhausted
 * account until its quota actually resets instead of a flat cooldown.
 */
export function getModelQuotaResetAt(account: any, modelKey: string): number {
  const resets = account?.modelQuotaResetTimes;
  const key = resolveModelQuotaKey(resets, modelKey);
  if (!key) return 0;
  const t = Date.parse(String(resets[key]));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Score an account for lease candidate selection. Lower score = better candidate.
 */
export function scoreAccount(
  account: any,
  options: {
    now: number;
    preferredAccountId: number;
    modelKey: string;
    activeLeaseCount: (accountId: number, modelKey: string) => number;
    accountStats: { lastUsedAt: number };
    accountWeight: number;
    /** Precomputed 5h quota fraction (provider override). When undefined,
     * falls back to per-model getModelQuotaFraction(account, modelKey). */
    modelQuotaFraction?: number | null;
  },
): number {
  const totalActive = options.activeLeaseCount(account.id, '');
  const modelActive = options.activeLeaseCount(account.id, options.modelKey);
  const affinity = options.preferredAccountId === account.id ? -20000 : 0;
  const recentlyUsedMs = options.accountStats.lastUsedAt
    ? Math.max(0, 60_000 - (options.now - options.accountStats.lastUsedAt))
    : 0;
  const recentUsePenalty = Math.ceil(recentlyUsedMs / 1000);

  // Quota priority — confirmed 5h remaining quota = ABSOLUTE HIGHEST priority.
  //
  // Three tiers with UNCROSSABLE gaps — no combination of affinity, accountWeight,
  // active leases, or other factors can bridge the tier boundaries:
  //   Tier 1: Confirmed has quota (fraction > 0) → 0~5000 penalty (always selected first)
  //   Tier 2: Unknown / 暂无 (null or -1)        → 100000 penalty (deprioritized)
  //   Tier 3: Confirmed exhausted (fraction = 0)  → 200000 penalty (last resort)
  //
  // Previously Tier 2 was 20000, which affinity (-20000) could cancel out,
  // causing accounts WITHOUT 5h quota to be selected over accounts WITH quota.
  // This led to unnecessary credit consumption on accounts that lack free 5h quota.
  const fraction = options.modelQuotaFraction !== undefined
    ? options.modelQuotaFraction
    : getModelQuotaFraction(account, options.modelKey, options.now);
  let quotaPenalty: number;
  if (fraction !== null && fraction >= 0) {
    // Confirmed data: gradient within 0-5000 (small spread, keeps confirmed accounts together)
    if (fraction === 0) {
      quotaPenalty = 200_000;      // Tier 3: confirmed exhausted — absolute last resort
    } else {
      quotaPenalty = Math.round((1 - fraction) * 5000);  // Tier 1: 1.0→0, 0.5→2500, 0.01→4950
    }
  } else {
    quotaPenalty = 100_000;        // Tier 2: null (unknown) or -1 (暂无)
  }

  // Reset-time bonus: prefer accounts whose 5h quota resets sooner.
  // Accounts resetting soon → negative bonus (preferred, use them up before reset).
  // Range: 0 (reset >5h away or unknown) to -4000 (reset imminent).
  // Stays within Tier 1 range so it never crosses tier boundaries.
  const resetBonus = getModelResetBonus(account, options.modelKey, options.now);

  return (
    modelActive * 2000 +
    totalActive * 1000 +
    recentUsePenalty -
    options.accountWeight * 20 +
    affinity +
    quotaPenalty +
    resetBonus
  );
}

/**
 * Calculate a bonus (negative = preferred) based on how soon the model quota resets.
 * Accounts resetting sooner should be used first (their quota refreshes soon anyway).
 * Returns 0 when no reset time data, or value between -4000 (imminent) and 0 (>5h away).
 */
function getModelResetBonus(account: any, modelKey: string, now: number): number {
  const resetTimes = account?.modelQuotaResetTimes;
  if (!resetTimes || typeof resetTimes !== 'object') return 0;

  const normalized = normalizeModelKey(modelKey);
  let resetTimeStr: string | undefined;

  // Exact match first
  if (resetTimes[modelKey]) {
    resetTimeStr = resetTimes[modelKey];
  } else if (normalized) {
    // Fuzzy match
    for (const key of Object.keys(resetTimes)) {
      if (normalizeModelKey(key) === normalized) {
        resetTimeStr = resetTimes[key];
        break;
      }
    }
  }

  if (!resetTimeStr) return 0;

  const resetMs = new Date(resetTimeStr).getTime();
  if (!Number.isFinite(resetMs)) return 0;

  const msUntilReset = resetMs - now;
  if (msUntilReset <= 0) return -4000; // already past reset → imminent refresh, most preferred

  const MAX_WINDOW_MS = 5 * 3600_000; // 5 hours
  if (msUntilReset >= MAX_WINDOW_MS) return 0; // too far away, no bonus

  // Linear: 0ms → -4000, 5h → 0
  return Math.round(-4000 * (1 - msUntilReset / MAX_WINDOW_MS));
}

