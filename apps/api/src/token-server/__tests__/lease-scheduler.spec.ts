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
