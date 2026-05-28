import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  ErrorRateTracker,
  EnterpriseProbeManager,
  accountWeight,
  scoreAccount,
  buildRetryPolicy,
} from '../lease-scheduler';

// ── ErrorRateTracker ─────────────────────────────────────────────────────────

describe('ErrorRateTracker', () => {
  let tracker: ErrorRateTracker;

  beforeEach(() => {
    tracker = new ErrorRateTracker();
  });

  it('should start with zero rates', () => {
    const rates = tracker.rates('gemini-pro');
    expect(rates.count503).toBe(0);
    expect(rates.count429).toBe(0);
  });

  it('should track error events', () => {
    const now = Date.now();
    tracker.record(503, 'gemini-pro', now);
    tracker.record(503, 'gemini-pro', now);
    tracker.record(429, 'gemini-pro', now);
    const rates = tracker.rates('gemini-pro', now);
    expect(rates.count503).toBe(2);
    expect(rates.count429).toBe(1);
    expect(rates.total).toBe(3);
  });

  it('should filter by model', () => {
    const now = Date.now();
    tracker.record(503, 'gemini-pro', now);
    tracker.record(503, 'opus', now);
    expect(tracker.rates('gemini-pro', now).count503).toBe(1);
    expect(tracker.rates('opus', now).count503).toBe(1);
  });

  it('should prune old events', () => {
    const old = Date.now() - 120_000; // 2 min ago — outside 60s window
    tracker.record(503, 'gemini-pro', old);
    const rates = tracker.rates('gemini-pro');
    expect(rates.count503).toBe(0);
  });
});

// ── EnterpriseProbeManager ───────────────────────────────────────────────────

describe('EnterpriseProbeManager', () => {
  let epm: EnterpriseProbeManager;
  const mockLog = vi.fn();

  beforeEach(() => {
    epm = new EnterpriseProbeManager({ log: mockLog });
    mockLog.mockClear();
  });

  it('should return null group for gmail accounts', () => {
    expect(epm.getGroup('alice@gmail.com')).toBeNull();
  });

  it('should return domain for non-gmail accounts', () => {
    expect(epm.getGroup('admin@yachts.io')).toBe('yachts.io');
  });

  it('should track success/failure', () => {
    epm.reportResult('admin@yachts.io', true);
    epm.reportResult('admin@yachts.io', true);
    epm.reportResult('admin@yachts.io', false);
    const status = epm.getStatus();
    expect(status['yachts.io']).toBeDefined();
    expect(status['yachts.io'].successes).toBe(2);
    expect(status['yachts.io'].failures).toBe(1);
  });

  it('should enter emergency on consecutive failures', () => {
    for (let i = 0; i < 5; i++) {
      epm.reportResult('admin@yachts.io', false);
    }
    const status = epm.getStatus();
    expect(status['yachts.io'].emergency).toBe(true);
    expect(status['yachts.io'].weight).toBe(0.5);
  });

  it('should adjust weight based on success rate', () => {
    // >50% success rate → weight 6
    for (let i = 0; i < 3; i++) epm.reportResult('admin@yachts.io', true);
    for (let i = 0; i < 1; i++) epm.reportResult('admin@yachts.io', false);
    const status = epm.getStatus();
    expect(status['yachts.io'].weight).toBe(6);
  });
});

// ── accountWeight ────────────────────────────────────────────────────────────

describe('accountWeight', () => {
  it('should return configured weight if set', () => {
    expect(accountWeight({ remoteWeight: 5 }, null)).toBe(5);
  });

  it('should return 3 for ultra plan', () => {
    expect(accountWeight({ planType: 'ultra' }, null)).toBe(3);
  });

  it('should return 2 for premium plan', () => {
    expect(accountWeight({ planType: 'premium' }, null)).toBe(2);
  });

  it('should return 1 for basic plan', () => {
    expect(accountWeight({ planType: 'basic' }, null)).toBe(1);
  });
});

// ── scoreAccount ─────────────────────────────────────────────────────────────

describe('scoreAccount', () => {
  it('should give affinity bonus to preferred account', () => {
    const account = { id: 1, planType: 'basic' };
    const scorePreferred = scoreAccount(account, {
      now: Date.now(),
      preferredAccountId: 1,
      modelKey: '',
      activeLeaseCount: () => 0,
      accountStats: { lastUsedAt: 0 },
      accountWeight: 1,
    });
    const scoreNonPreferred = scoreAccount(account, {
      now: Date.now(),
      preferredAccountId: 999,
      modelKey: '',
      activeLeaseCount: () => 0,
      accountStats: { lastUsedAt: 0 },
      accountWeight: 1,
    });
    expect(scorePreferred).toBeLessThan(scoreNonPreferred);
  });

  it('should penalize accounts with active leases', () => {
    const account = { id: 1, planType: 'basic' };
    const scoreFree = scoreAccount(account, {
      now: Date.now(),
      preferredAccountId: 0,
      modelKey: '',
      activeLeaseCount: () => 0,
      accountStats: { lastUsedAt: 0 },
      accountWeight: 1,
    });
    const scoreBusy = scoreAccount(account, {
      now: Date.now(),
      preferredAccountId: 0,
      modelKey: '',
      activeLeaseCount: () => 3,
      accountStats: { lastUsedAt: 0 },
      accountWeight: 1,
    });
    expect(scoreFree).toBeLessThan(scoreBusy);
  });
});

// ── buildRetryPolicy ─────────────────────────────────────────────────────────

describe('buildRetryPolicy', () => {
  it('should return massive_pool policy for 50+ healthy', () => {
    const policy = buildRetryPolicy({ healthyForModel: 50, total: 60 }, {});
    expect(policy.reason).toBe('massive_pool');
    expect(policy.maxAttempts).toBe(99);
  });

  it('should return degraded_pool policy for 0 healthy', () => {
    const policy = buildRetryPolicy({ healthyForModel: 0, total: 5 }, {});
    expect(policy.reason).toBe('degraded_pool');
    expect(policy.maxAttempts).toBe(3);
  });

  it('should apply pressure reason', () => {
    const policy = buildRetryPolicy(
      { healthyForModel: 10, total: 20 },
      { pressure: { blockedUntil: Date.now() + 60000 } },
    );
    expect(policy.reason).toBe('model_pressure');
  });

  it('should apply emergency override from throttle config', () => {
    const policy = buildRetryPolicy(
      { healthyForModel: 50, total: 100 },
      {},
      { emergency: { enabled: true, maxAttempts: 2, baseDelayMs: 5000 } },
    );
    expect(policy.reason).toBe('emergency');
    expect(policy.maxAttempts).toBe(2);
  });
});

// ── scoreAccount: quota-aware prioritization ─────────────────────────────────
// TDD: These tests define the desired behavior BEFORE implementation.
// They should FAIL until scoreAccount is updated with quotaPenalty logic.

describe('scoreAccount — quota priority (prefer 5h quota over credits)', () => {
  const baseOptions = {
    now: Date.now(),
    preferredAccountId: 0,
    modelKey: 'gemini-2.5-pro',
    activeLeaseCount: () => 0,
    accountStats: { lastUsedAt: 0 },
    accountWeight: 1,
  };

  it('should prefer account with remaining model quota over account with zero quota', () => {
    const withQuota = { id: 1, modelQuotaFractions: { 'gemini-2.5-pro': 0.72 } };
    const noQuota = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 0 } };

    const scoreWith = scoreAccount(withQuota, baseOptions);
    const scoreWithout = scoreAccount(noQuota, baseOptions);

    expect(scoreWith).toBeLessThan(scoreWithout);
  });

  it('should treat account with no modelQuotaFractions as neutral (no penalty)', () => {
    const noData = { id: 1 };
    const withQuota = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 0.5 } };

    const scoreNoData = scoreAccount(noData, baseOptions);
    const scoreWithQuota = scoreAccount(withQuota, baseOptions);

    // No data → no penalty, roughly same score as account with quota
    expect(Math.abs(scoreNoData - scoreWithQuota)).toBeLessThan(100);
  });

  it('should penalize exhausted account enough to break affinity bonus', () => {
    // Affinity account but with exhausted quota
    const affinityExhausted = { id: 1, modelQuotaFractions: { 'gemini-2.5-pro': 0 } };
    // Non-affinity account with remaining quota
    const freshWithQuota = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 0.8 } };

    const scoreAffinity = scoreAccount(affinityExhausted, {
      ...baseOptions,
      preferredAccountId: 1, // affinity for account 1
    });
    const scoreFresh = scoreAccount(freshWithQuota, baseOptions);

    // Fresh account with quota should beat affinity account without quota
    expect(scoreFresh).toBeLessThan(scoreAffinity);
  });

  it('should NOT break affinity when the affinity account still has quota', () => {
    const affinityWithQuota = { id: 1, modelQuotaFractions: { 'gemini-2.5-pro': 0.6 } };
    const freshWithQuota = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 0.8 } };

    const scoreAffinity = scoreAccount(affinityWithQuota, {
      ...baseOptions,
      preferredAccountId: 1,
    });
    const scoreFresh = scoreAccount(freshWithQuota, baseOptions);

    // Affinity with quota should still win
    expect(scoreAffinity).toBeLessThan(scoreFresh);
  });

  it('should handle mismatched model keys gracefully (no penalty for unrelated models)', () => {
    // Account has quota data but for a different model
    const differentModel = { id: 1, modelQuotaFractions: { 'claude-sonnet-4': 0 } };

    const score = scoreAccount(differentModel, {
      ...baseOptions,
      modelKey: 'gemini-2.5-pro',
    });
    const scoreBaseline = scoreAccount({ id: 1 }, baseOptions);

    // Should not be penalized for a different model being exhausted
    expect(Math.abs(score - scoreBaseline)).toBeLessThan(100);
  });

  it('should penalize when exact model key matches with zero fraction', () => {
    const exhausted = { id: 1, modelQuotaFractions: { 'claude-opus-4-6-thinking': 0 } };
    const hasQuota = { id: 2, modelQuotaFractions: { 'claude-opus-4-6-thinking': 0.3 } };

    const scoreExhausted = scoreAccount(exhausted, {
      ...baseOptions,
      modelKey: 'claude-opus-4-6-thinking',
    });
    const scoreHasQuota = scoreAccount(hasQuota, {
      ...baseOptions,
      modelKey: 'claude-opus-4-6-thinking',
    });

    expect(scoreHasQuota).toBeLessThan(scoreExhausted);
  });
});
