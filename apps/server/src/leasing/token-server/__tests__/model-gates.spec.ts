import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ModelGateManager } from '../model-gates';

let mgr: ModelGateManager;
const mockLog = vi.fn();

beforeEach(() => {
  mgr = new ModelGateManager({ log: mockLog });
  mockLog.mockClear();
});

// ── Account stats ────────────────────────────────────────────────────────────

describe('account stats', () => {
  it('should create default stats for new account', () => {
    const stats = mgr.ensureAccountStats(1);
    expect(stats.successCount).toBe(0);
    expect(stats.errorCount).toBe(0);
    expect(stats.totalLeases).toBe(0);
  });

  it('should return same object on repeated calls', () => {
    const a = mgr.ensureAccountStats(1);
    const b = mgr.ensureAccountStats(1);
    expect(a).toBe(b);
  });
});

// ── Model gates ──────────────────────────────────────────────────────────────

describe('model gates', () => {
  it('should create healthy gate', () => {
    const gate = mgr.ensureModelGate(1, 'gemini-pro');
    expect(gate.state).toBe('healthy');
    expect(gate.failCount).toBe(0);
  });

  it('should get existing gate', () => {
    mgr.ensureModelGate(1, 'gemini-pro');
    expect(mgr.getModelGate(1, 'gemini-pro')).not.toBeNull();
  });

  it('should return null for non-existent gate', () => {
    expect(mgr.getModelGate(999, 'unknown')).toBeNull();
  });

  it('should clear gate', () => {
    mgr.ensureModelGate(1, 'gemini-pro');
    mgr.clearModelGate(1, 'gemini-pro');
    expect(mgr.getModelGate(1, 'gemini-pro')).toBeNull();
  });
});

// ── isQuotaRecoverableGateReason ─────────────────────────────────────────────

describe('isQuotaRecoverableGateReason', () => {
  it('should return true for quota/capacity reasons', () => {
    expect(mgr.isQuotaRecoverableGateReason('quota')).toBe(true);
    expect(mgr.isQuotaRecoverableGateReason('capacity')).toBe(true);
    expect(mgr.isQuotaRecoverableGateReason('model_unavailable')).toBe(true);
    expect(mgr.isQuotaRecoverableGateReason('')).toBe(true);
  });

  it('should return false for non-recoverable reasons', () => {
    expect(mgr.isQuotaRecoverableGateReason('verification_required')).toBe(false);
    expect(mgr.isQuotaRecoverableGateReason('auth_failure')).toBe(false);
  });
});

// ── Model pressure ───────────────────────────────────────────────────────────

describe('model pressure', () => {
  it('should return null when no pressure recorded', () => {
    expect(mgr.getModelPressure('gemini-pro')).toBeNull();
  });

  it('should record pressure events', () => {
    mgr.recordModelPressure('gemini-pro', 503, 1);
    // Not enough unique accounts to activate
    expect(mgr.getModelPressure('gemini-pro')).toBeNull();
  });

  it('should activate pressure when threshold unique accounts fail', () => {
    const now = Date.now();
    // Simulate 8 unique accounts failing
    for (let i = 1; i <= 8; i++) {
      mgr.recordModelPressure('gemini-pro', 503, i, now);
    }
    const pressure = mgr.getModelPressure('gemini-pro', now);
    expect(pressure).not.toBeNull();
    expect(pressure!.failCount).toBe(8);
  });

  it('should clear pressure', () => {
    for (let i = 1; i <= 8; i++) {
      mgr.recordModelPressure('gemini-pro', 503, i);
    }
    mgr.clearModelPressure('gemini-pro');
    expect(mgr.getModelPressure('gemini-pro')).toBeNull();
  });
});

// ── isAccountGloballyBlocked ─────────────────────────────────────────────────

describe('isAccountGloballyBlocked', () => {
  it('should return null for unblocked account', () => {
    expect(mgr.isAccountGloballyBlocked({})).toBeNull();
  });

  it('should return block info for blocked account', () => {
    const block = mgr.isAccountGloballyBlocked({
      blockedUntil: Date.now() + 60000,
      quotaStatusReason: 'quota',
    });
    expect(block).not.toBeNull();
    expect(block!.reason).toBe('quota');
  });

  it('should return null for expired block', () => {
    expect(mgr.isAccountGloballyBlocked({
      blockedUntil: Date.now() - 1000,
    })).toBeNull();
  });
});

// ── Serialization ────────────────────────────────────────────────────────────

describe('serialization', () => {
  it('should serialize account stats', () => {
    const stats = mgr.ensureAccountStats(1);
    stats.successCount = 5;
    const result = mgr.serializeAccountStats();
    expect(result['1'].successCount).toBe(5);
  });

  it('should serialize model gates', () => {
    const gate = mgr.ensureModelGate(1, 'gemini-pro');
    gate.state = 'cooling';
    gate.blockedUntil = Date.now() + 60000;
    const result = mgr.serializeModelGates();
    expect(result).toHaveLength(1);
    expect(result[0].state).toBe('cooling');
  });

  it('should serialize model pressure', () => {
    for (let i = 1; i <= 8; i++) {
      mgr.recordModelPressure('gemini-pro', 503, i);
    }
    const result = mgr.serializeModelPressure();
    expect(result).toHaveLength(1);
    expect(result[0].modelKey).toBe('gemini-pro');
  });
});

// ── Persistence ──────────────────────────────────────────────────────────────

describe('persistence', () => {
  it('should export and import model gates', () => {
    const gate = mgr.ensureModelGate(1, 'opus');
    gate.state = 'cooling';
    gate.blockedUntil = Date.now() + 600000;
    gate.reason = 'quota';

    const exported = mgr.exportModelGates();
    const mgr2 = new ModelGateManager({ log: mockLog });
    mgr2.importModelGates(exported);

    const restored = mgr2.getModelGate(1, 'opus');
    expect(restored).not.toBeNull();
    expect(restored!.state).toBe('cooling');
    expect(restored!.reason).toBe('quota');
  });

  it('should skip expired gates on import', () => {
    const mgr2 = new ModelGateManager({ log: mockLog });
    mgr2.importModelGates([
      { accountId: 1, modelKey: 'opus', state: 'cooling', blockedUntil: Date.now() - 1000 },
    ]);
    expect(mgr2.getModelGate(1, 'opus')).toBeNull();
  });
});
