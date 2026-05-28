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

  it('should heavily penalize account with no modelQuotaFractions (unknown)', () => {
    const noData = { id: 1 };
    const fullQuota = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 1.0 } };

    const scoreNoData = scoreAccount(noData, baseOptions);
    const scoreFullQuota = scoreAccount(fullQuota, baseOptions);

    // No data → high penalty, confirmed quota always wins
    expect(scoreFullQuota).toBeLessThan(scoreNoData);
    expect(scoreNoData - scoreFullQuota).toBeGreaterThan(10000);
  });

  it('should penalize exhausted account enough to break affinity bonus', () => {
    // Affinity account but with exhausted quota
    const affinityExhausted = { id: 1, modelQuotaFractions: { 'gemini-2.5-pro': 0 } };
    // Non-affinity account with full quota
    const freshWithQuota = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 1.0 } };

    const scoreAffinity = scoreAccount(affinityExhausted, {
      ...baseOptions,
      preferredAccountId: 1, // affinity for account 1
    });
    const scoreFresh = scoreAccount(freshWithQuota, baseOptions);

    // Fresh account with full quota should beat affinity account without quota
    expect(scoreFresh).toBeLessThan(scoreAffinity);
  });

  it('should penalize UNKNOWN quota account enough to break affinity bonus (regression: was a tie before fix)', () => {
    // BUG: Before fix, affinity(-20000) + unknown(20000) = 0, which tied with
    // non-affinity + has-quota(0) = 0, allowing unknown-quota accounts to be selected.
    // This caused credit-bearing accounts without 5h quota to be picked over free accounts.
    const affinityUnknown = { id: 1 }; // no modelQuotaFractions at all
    const freshWithQuota = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 1.0 } };

    const scoreAffinity = scoreAccount(affinityUnknown, {
      ...baseOptions,
      preferredAccountId: 1,
    });
    const scoreFresh = scoreAccount(freshWithQuota, baseOptions);

    // Account with confirmed 5h quota MUST beat affinity account with unknown quota
    expect(scoreFresh).toBeLessThan(scoreAffinity);
    // Gap must be large enough that no other factor can bridge it
    expect(scoreAffinity - scoreFresh).toBeGreaterThan(50000);
  });

  it('should never select unknown-quota account over has-quota account even in worst case scenario', () => {
    // Worst case: unknown account has affinity + ultra weight + zero load
    // vs has-quota account with no affinity + basic weight + heavy load
    const unknownIdeal = { id: 1 }; // unknown quota, zero load, affinity
    const hasQuotaWorstCase = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 0.01 } }; // barely any quota left

    const scoreUnknown = scoreAccount(unknownIdeal, {
      ...baseOptions,
      preferredAccountId: 1, // affinity
      accountWeight: 3,      // ultra
      activeLeaseCount: () => 0,
    });
    const scoreHasQuota = scoreAccount(hasQuotaWorstCase, {
      ...baseOptions,
      preferredAccountId: 0, // no affinity
      accountWeight: 1,      // basic
      activeLeaseCount: (id) => id === 2 ? 5 : 0, // heavily loaded
    });

    // Has-quota MUST still win despite all disadvantages
    expect(scoreHasQuota).toBeLessThan(scoreUnknown);
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

  it('should handle mismatched model keys gracefully (moderate penalty, not full exhaustion)', () => {
    // Account has quota data but for a different model
    const differentModel = { id: 1, modelQuotaFractions: { 'claude-sonnet-4': 0 } };

    const score = scoreAccount(differentModel, {
      ...baseOptions,
      modelKey: 'gemini-2.5-pro',
    });
    const scoreExhausted = scoreAccount(
      { id: 1, modelQuotaFractions: { 'gemini-2.5-pro': 0 } },
      baseOptions,
    );

    // Should get moderate penalty (暂无), not full exhaustion penalty
    expect(score).toBeLessThan(scoreExhausted);
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

  // ── Gradient scoring: prefer higher remainingFraction ──────────────────

  it('should prefer account with 100% quota over account with 20% quota', () => {
    const full = { id: 1, modelQuotaFractions: { 'gemini-2.5-pro': 1.0 } };
    const low = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 0.2 } };

    const scoreFull = scoreAccount(full, baseOptions);
    const scoreLow = scoreAccount(low, baseOptions);

    expect(scoreFull).toBeLessThan(scoreLow);
  });

  it('should score accounts monotonically by remainingFraction', () => {
    const fractions = [1.0, 0.8, 0.5, 0.2, 0.0];
    const scores = fractions.map((f, i) =>
      scoreAccount(
        { id: i + 1, modelQuotaFractions: { 'gemini-2.5-pro': f } },
        baseOptions,
      ),
    );

    // Each score should be <= the next (lower fraction → higher penalty)
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i + 1]);
    }
  });

  it('should produce meaningful score difference between 100% and 20% quota', () => {
    const full = { id: 1, modelQuotaFractions: { 'gemini-2.5-pro': 1.0 } };
    const low = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 0.2 } };

    const scoreFull = scoreAccount(full, baseOptions);
    const scoreLow = scoreAccount(low, baseOptions);

    // Difference should be significant enough to influence selection (> 100 points)
    expect(scoreLow - scoreFull).toBeGreaterThan(100);
  });

  it('should NOT break affinity when affinity account still has confirmed quota (even low)', () => {
    // With the new scale (0-5000 for confirmed quota), affinity (-20000) always wins
    const affinityLow = { id: 1, modelQuotaFractions: { 'gemini-2.5-pro': 0.1 } };
    const freshFull = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 1.0 } };

    const scoreAffinity = scoreAccount(affinityLow, {
      ...baseOptions,
      preferredAccountId: 1,
    });
    const scoreFresh = scoreAccount(freshFull, baseOptions);

    // Affinity with ANY confirmed quota should still win (penalty gap is only 0-5000)
    expect(scoreAffinity).toBeLessThan(scoreFresh);
  });

  it('should NOT break affinity when both accounts have similar quota', () => {
    const affinityAccount = { id: 1, modelQuotaFractions: { 'gemini-2.5-pro': 0.6 } };
    const freshAccount = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 0.8 } };

    const scoreAffinity = scoreAccount(affinityAccount, {
      ...baseOptions,
      preferredAccountId: 1,
    });
    const scoreFresh = scoreAccount(freshAccount, baseOptions);

    // Affinity bonus (-20000) should still dominate small quota difference
    expect(scoreAffinity).toBeLessThan(scoreFresh);
  });

  // ── "暂无" handling: has fractions for other models but not the target ──

  it('should give moderate penalty when account has fractions but lacks data for target model', () => {
    // Account has Gemini fractions but no Claude data (Google API didn't return Claude)
    const hasGeminiOnly = { id: 1, modelQuotaFractions: { 'gemini-2.5-pro': 1.0, 'gemini-3-flash': 0.8 } };
    // Account has explicit Claude quota data
    const hasClaudeQuota = { id: 2, modelQuotaFractions: { 'claude-sonnet-4-6': 0.7 } };

    const scoreNoClaudeData = scoreAccount(hasGeminiOnly, {
      ...baseOptions,
      modelKey: 'claude-sonnet-4-6',
    });
    const scoreHasClaudeData = scoreAccount(hasClaudeQuota, {
      ...baseOptions,
      modelKey: 'claude-sonnet-4-6',
    });

    // Account with explicit quota data should be preferred over "暂无" account
    expect(scoreHasClaudeData).toBeLessThan(scoreNoClaudeData);
  });

  it('should rank "暂无" (missing model data) between has-quota and exhausted', () => {
    // 3 accounts for claude-sonnet-4-6:
    const hasQuota = { id: 1, modelQuotaFractions: { 'claude-sonnet-4-6': 0.8 } };
    const missingData = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 1.0 } }; // has fracs but not claude
    const exhausted = { id: 3, modelQuotaFractions: { 'claude-sonnet-4-6': 0 } };

    const opts = { ...baseOptions, modelKey: 'claude-sonnet-4-6' };
    const scoreHas = scoreAccount(hasQuota, opts);
    const scoreMissing = scoreAccount(missingData, opts);
    const scoreExhausted = scoreAccount(exhausted, opts);

    // has-quota < missing-data < exhausted
    expect(scoreHas).toBeLessThan(scoreMissing);
    expect(scoreMissing).toBeLessThan(scoreExhausted);
  });

  it('should heavily penalize accounts with no modelQuotaFractions (never refreshed)', () => {
    // Truly unknown account (never had any quota data)
    const neverRefreshed = { id: 1 };
    const fullQuota = { id: 2, modelQuotaFractions: { 'gemini-2.5-pro': 1.0 } };

    const scoreUnknown = scoreAccount(neverRefreshed, baseOptions);
    const scoreFull = scoreAccount(fullQuota, baseOptions);

    // Confirmed quota always beats unknown
    expect(scoreFull).toBeLessThan(scoreUnknown);
    expect(scoreUnknown - scoreFull).toBeGreaterThan(10000);
  });

  // ── Reset time: prefer accounts whose quota resets sooner ──────────────

  it('should prefer account resetting in 30min over account resetting in 4h', () => {
    const now = Date.now();
    const resetsSoon = {
      id: 1,
      modelQuotaFractions: { 'gemini-2.5-pro': 0.5 },
      modelQuotaResetTimes: { 'gemini-2.5-pro': new Date(now + 30 * 60_000).toISOString() }, // 30 min
    };
    const resetsLater = {
      id: 2,
      modelQuotaFractions: { 'gemini-2.5-pro': 0.5 },
      modelQuotaResetTimes: { 'gemini-2.5-pro': new Date(now + 4 * 3600_000).toISOString() }, // 4h
    };

    const opts = { ...baseOptions, now };
    const scoreSoon = scoreAccount(resetsSoon, opts);
    const scoreLater = scoreAccount(resetsLater, opts);

    // Sooner reset = lower score = preferred
    expect(scoreSoon).toBeLessThan(scoreLater);
  });

  it('should not let resetTime override the tier gap (confirmed > unknown)', () => {
    const now = Date.now();
    const confirmedLateReset = {
      id: 1,
      modelQuotaFractions: { 'gemini-2.5-pro': 0.8 },
      modelQuotaResetTimes: { 'gemini-2.5-pro': new Date(now + 5 * 3600_000).toISOString() }, // 5h
    };
    const unknown = { id: 2 }; // no data

    const opts = { ...baseOptions, now };
    const scoreConfirmed = scoreAccount(confirmedLateReset, opts);
    const scoreUnknown = scoreAccount(unknown, opts);

    // Confirmed with late reset still beats unknown
    expect(scoreConfirmed).toBeLessThan(scoreUnknown);
  });

  it('should give maximum bonus when resetTime is already past', () => {
    const now = Date.now();
    const pastReset = {
      id: 1,
      modelQuotaFractions: { 'gemini-2.5-pro': 0.3 },
      modelQuotaResetTimes: { 'gemini-2.5-pro': new Date(now - 60_000).toISOString() }, // 1 min ago
    };
    const futureReset = {
      id: 2,
      modelQuotaFractions: { 'gemini-2.5-pro': 0.3 },
      modelQuotaResetTimes: { 'gemini-2.5-pro': new Date(now + 3 * 3600_000).toISOString() }, // 3h
    };

    const opts = { ...baseOptions, now };
    const scorePast = scoreAccount(pastReset, opts);
    const scoreFuture = scoreAccount(futureReset, opts);

    // Past reset = imminent refresh = most preferred
    expect(scorePast).toBeLessThan(scoreFuture);
  });

  it('should give zero bonus when resetTime is >= 5h away', () => {
    const now = Date.now();
    const farReset = {
      id: 1,
      modelQuotaFractions: { 'gemini-2.5-pro': 0.5 },
      modelQuotaResetTimes: { 'gemini-2.5-pro': new Date(now + 6 * 3600_000).toISOString() }, // 6h
    };
    const noResetData = {
      id: 2,
      modelQuotaFractions: { 'gemini-2.5-pro': 0.5 },
      // no resetTimes
    };

    const opts = { ...baseOptions, now };
    const scoreFar = scoreAccount(farReset, opts);
    const scoreNoData = scoreAccount(noResetData, opts);

    // Both should have 0 reset bonus → same score
    expect(scoreFar).toBe(scoreNoData);
  });

  it('should produce monotonically decreasing scores as resetTime gets closer', () => {
    const now = Date.now();
    const resetOffsets = [4 * 3600_000, 2 * 3600_000, 60 * 60_000, 10 * 60_000]; // 4h, 2h, 1h, 10min
    const scores = resetOffsets.map((offset, i) =>
      scoreAccount(
        {
          id: i + 1,
          modelQuotaFractions: { 'gemini-2.5-pro': 0.5 },
          modelQuotaResetTimes: { 'gemini-2.5-pro': new Date(now + offset).toISOString() },
        },
        { ...baseOptions, now },
      ),
    );

    // Closer reset → lower score
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i + 1]);
    }
  });

  it('should not give reset bonus when resetTimes has no entry for target model', () => {
    const now = Date.now();
    const wrongModel = {
      id: 1,
      modelQuotaFractions: { 'claude-sonnet-4-6': 0.5 },
      modelQuotaResetTimes: { 'gemini-2.5-pro': new Date(now + 10 * 60_000).toISOString() }, // reset data for wrong model
    };
    const noResetData = {
      id: 2,
      modelQuotaFractions: { 'claude-sonnet-4-6': 0.5 },
    };

    const opts = { ...baseOptions, now, modelKey: 'claude-sonnet-4-6' };
    const scoreWrong = scoreAccount(wrongModel, opts);
    const scoreNone = scoreAccount(noResetData, opts);

    // No matching reset data → same score
    expect(scoreWrong).toBe(scoreNone);
  });

  it('should combine quota fraction and resetTime correctly: low quota + soon reset beats high quota + far reset', () => {
    const now = Date.now();
    const lowQuotaSoonReset = {
      id: 1,
      modelQuotaFractions: { 'gemini-2.5-pro': 0.2 },
      modelQuotaResetTimes: { 'gemini-2.5-pro': new Date(now + 5 * 60_000).toISOString() }, // 5min
    };
    const highQuotaFarReset = {
      id: 2,
      modelQuotaFractions: { 'gemini-2.5-pro': 0.9 },
      modelQuotaResetTimes: { 'gemini-2.5-pro': new Date(now + 4.5 * 3600_000).toISOString() }, // 4.5h
    };

    const opts = { ...baseOptions, now };
    const scoreLow = scoreAccount(lowQuotaSoonReset, opts);
    const scoreHigh = scoreAccount(highQuotaFarReset, opts);

    // Low quota (penalty ~4000) + soon reset (bonus ~-3960) ≈ 40
    // High quota (penalty ~500) + far reset (bonus ~-400) ≈ 100
    // Low+soon should win
    expect(scoreLow).toBeLessThan(scoreHigh);
  });
});
