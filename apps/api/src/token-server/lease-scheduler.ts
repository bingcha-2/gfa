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
  MIN_HEALTHY_CANDIDATES,
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

// ── Account scoring for candidate selection ──────────────────────────────────

/**
 * Check if an account has remaining 5h model quota for a given model key.
 * Returns true (no penalty) when:
 *   - No modelQuotaFractions data exists (unknown → assume has quota)
 *   - The requested model is not in the fractions map (no data for this model)
 *   - The fraction is > 0 (has remaining quota)
 * Returns false (should penalize) only when fraction === 0 for the exact model.
 */
export function hasModelQuotaRemaining(account: any, modelKey: string): boolean {
  const fractions = account?.modelQuotaFractions;
  if (!fractions || typeof fractions !== 'object') return true;

  const normalized = normalizeModelKey(modelKey);
  if (!normalized) return true;

  // Exact match
  if (normalized in fractions) {
    return Number(fractions[normalized]) > 0;
  }

  // Fuzzy match (e.g. "gemini-2.5-pro" ↔ "gemini-2.5-pro-preview")
  for (const key of Object.keys(fractions)) {
    if (key.includes(normalized) || normalized.includes(key)) {
      return Number(fractions[key]) > 0;
    }
  }

  return true; // model not found in quota data → no penalty
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
  },
): number {
  const totalActive = options.activeLeaseCount(account.id, '');
  const modelActive = options.activeLeaseCount(account.id, options.modelKey);
  const affinity = options.preferredAccountId === account.id ? -20000 : 0;
  const recentlyUsedMs = options.accountStats.lastUsedAt
    ? Math.max(0, 60_000 - (options.now - options.accountStats.lastUsedAt))
    : 0;
  const recentUsePenalty = Math.ceil(recentlyUsedMs / 1000);

  // Quota priority: penalize accounts with exhausted 5h model quota.
  // 25000 > 20000 affinity bonus → breaks affinity to save credits.
  const quotaPenalty = hasModelQuotaRemaining(account, options.modelKey) ? 0 : 25000;

  return (
    modelActive * 2000 +
    totalActive * 1000 +
    recentUsePenalty -
    options.accountWeight * 20 +
    affinity +
    quotaPenalty
  );
}

// ── Retry policy builder ─────────────────────────────────────────────────────

/**
 * Build a retry policy based on pool health, pressure, and throttle config.
 */
export function buildRetryPolicy(
  candidateStats: { healthyForModel?: number; healthy?: number; total?: number; probationForModel?: number } = {},
  options: { pressure?: any; probation?: boolean; modelKey?: string; errorRates?: any } = {},
  throttleConfig: any = null,
): any {
  const healthy = Math.max(0, Number(candidateStats.healthyForModel || candidateStats.healthy || 0));
  const total = Math.max(0, Number(candidateStats.total || 0));
  const pressure = options.pressure || null;
  const probation = Boolean(options.probation);
  const modelKey = normalizeModelKey(options.modelKey || '');
  const config = throttleConfig;
  const globalCfg = config?.global || {};
  const modelCfg = (modelKey && config?.models?.[modelKey]) || {};
  const escalation = config?.autoEscalation || {};
  const emergency = config?.emergency || {};

  const rates = options.errorRates || { rate503: 0, rate429: 0, count503: 0, count429: 0, total: 0 };

  // Emergency mode
  if (emergency.enabled) {
    return {
      maxAttempts: Number(emergency.maxAttempts || 3),
      baseDelayMs: Number(emergency.baseDelayMs || 5000),
      maxDelayMs: Number(emergency.maxDelayMs || 15000),
      backoffMultiplier: 1.5,
      capacityWaitMs: Number(emergency.capacityWaitMs || 10000),
      quotaWaitMs: Number(emergency.quotaWaitMs || 5000),
      jitterMs: 1000,
      retryableStatuses: [429, 503],
      statusMaxAttempts: { 429: 2, 503: 2 },
      reason: 'emergency',
      message: emergency.message || '',
      pressureUntil: 0,
      poolHealthy: healthy, poolTotal: total, poolPressure: Boolean(pressure),
      recent503Rate: Math.round(rates.rate503 * 100) / 100,
      recent429Rate: Math.round(rates.rate429 * 100) / 100,
    };
  }

  let maxAttempts: number, baseDelayMs: number, maxDelayMs: number;
  let backoffMultiplier: number, capacityWaitMs: number;
  let quotaWaitMs: number, jitterMs: number;

  if (healthy >= 50) maxAttempts = 99;
  else if (healthy >= 20) maxAttempts = Math.min(healthy * 2, 60);
  else if (healthy >= 5) maxAttempts = Math.max(8, healthy * 2);
  else if (healthy >= 2) maxAttempts = 5;
  else maxAttempts = 3;

  if (pressure) baseDelayMs = 1500;
  else if (healthy >= 50) baseDelayMs = 100;
  else if (healthy >= 20) baseDelayMs = 200;
  else if (healthy >= 5) baseDelayMs = 400;
  else if (healthy >= 2) baseDelayMs = 800;
  else baseDelayMs = 2000;

  maxDelayMs = healthy >= 20 ? 5000 : healthy >= 5 ? 8000 : 15000;
  backoffMultiplier = healthy >= 20 ? 1.2 : healthy >= 5 ? 1.3 : 1.5;
  capacityWaitMs = pressure ? 5000 : healthy >= 10 ? 1000 : 3000;
  quotaWaitMs = healthy >= 10 ? 500 : 1500;
  jitterMs = Math.min(500, baseDelayMs);

  // 503 rate auto-escalation
  const defaultThresholds = [
    { rate503: 0.3, addDelayMs: 500 },
    { rate503: 0.5, addDelayMs: 1500 },
    { rate503: 0.8, addDelayMs: 3000 },
  ];
  const thresholds = (escalation.enabled === false)
    ? []
    : (Array.isArray(escalation.thresholds) ? escalation.thresholds : defaultThresholds);
  for (const t of thresholds) {
    if (rates.rate503 >= (t.rate503 || 1)) {
      baseDelayMs += Number(t.addDelayMs || 0);
      capacityWaitMs += Number(t.addDelayMs || 0);
    }
  }

  // Manual overrides (per-model first, then global)
  const override = (key: string) => {
    if (modelCfg[key] != null) return modelCfg[key];
    if (globalCfg[key] != null) return globalCfg[key];
    return null;
  };
  if (override('maxAttempts') != null) maxAttempts = override('maxAttempts');
  if (override('baseDelayMs') != null) baseDelayMs = override('baseDelayMs');
  if (override('maxDelayMs') != null) maxDelayMs = override('maxDelayMs');
  if (override('backoffMultiplier') != null) backoffMultiplier = override('backoffMultiplier');
  if (override('capacityWaitMs') != null) capacityWaitMs = override('capacityWaitMs');
  if (override('quotaWaitMs') != null) quotaWaitMs = override('quotaWaitMs');
  if (override('jitterMs') != null) jitterMs = override('jitterMs');

  let reason: string;
  if (pressure) reason = 'model_pressure';
  else if (probation) reason = 'probation_probe';
  else if (healthy >= 50) reason = 'massive_pool';
  else if (healthy >= 20) reason = 'healthy_pool';
  else if (healthy >= 5) reason = 'moderate_pool';
  else if (healthy >= 2) reason = 'limited_pool';
  else reason = 'degraded_pool';

  return {
    maxAttempts, baseDelayMs, maxDelayMs, backoffMultiplier,
    capacityWaitMs, quotaWaitMs, jitterMs,
    retryableStatuses: [401, 403, 429, 503],
    statusMaxAttempts: {
      401: Math.min(maxAttempts, 3), 403: Math.min(maxAttempts, 5),
      429: maxAttempts, 503: maxAttempts,
    },
    reason,
    pressureUntil: pressure ? Number(pressure.blockedUntil || 0) : 0,
    poolHealthy: healthy, poolTotal: total, poolPressure: Boolean(pressure),
    recent503Rate: Math.round(rates.rate503 * 100) / 100,
    recent429Rate: Math.round(rates.rate429 * 100) / 100,
  };
}
