/**
 * model-gates.ts — Model-level account gating, pressure tracking, and stats.
 *
 * Extracted from remote-token-server/index.js (L900-L1500).
 * Manages per-account per-model cooldowns, pressure detection,
 * and account-level statistics.
 */

import {
  normalizeModelKey,
  AUTO_RECHECK_AFTER_MS,
  MODEL_PRESSURE_BASE_MS,
  MODEL_PRESSURE_MAX_MS,
  MODEL_PRESSURE_UNIQUE_THRESHOLD,
  MODEL_PRESSURE_WINDOW_MS,
} from './token-billing';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AccountStats {
  successCount: number;
  errorCount: number;
  quota429Count: number;
  locationFailures: number;
  recentResults: any[];
  modelFailures: Map<string, number>;
  totalLeases: number;
  lastUsedAt: number;
  lastStatus: number;
  lastSuccessAt: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokensUsed: number;
}

export interface ModelGate {
  accountId: number;
  modelKey: string;
  state: 'healthy' | 'cooling' | 'probation';
  failCount: number;
  blockedUntil: number;
  blockedAt?: number;
  nextProbeAfter: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  reason: string;
}

export interface ModelPressureEntry {
  modelKey: string;
  failCount: number;
  uniqueAccountCount: number;
  recentFailures: Array<{ accountId: number; at: number }>;
  lastStatus: number;
  firstFailureAt: number;
  lastFailureAt: number;
  blockedUntil: number;
  lastProbationProbeAt: number;
}

export interface BlockInfo {
  reason: string;
  blockedAt: number;
  blockedUntil: number;
  modelKey?: string;
}

// ── ModelGateManager ─────────────────────────────────────────────────────────

export class ModelGateManager {
  private accountStats = new Map<number, AccountStats>();
  private gates = new Map<string, ModelGate>();
  private pressure = new Map<string, ModelPressureEntry>();
  private log: (...args: any[]) => void;

  constructor(options: { log?: (...args: any[]) => void } = {}) {
    this.log = options.log || console.log;
  }

  // ── Account stats ──────────────────────────────────────────────────────

  ensureAccountStats(accountId: number): AccountStats {
    const id = Number(accountId);
    if (!this.accountStats.has(id)) {
      this.accountStats.set(id, {
        successCount: 0, errorCount: 0, quota429Count: 0,
        locationFailures: 0, recentResults: [],
        modelFailures: new Map(), totalLeases: 0,
        lastUsedAt: 0, lastStatus: 0, lastSuccessAt: 0,
        totalInputTokens: 0, totalOutputTokens: 0, totalTokensUsed: 0,
      });
    }
    return this.accountStats.get(id)!;
  }

  getAccountStats(accountId: number): AccountStats | undefined {
    return this.accountStats.get(Number(accountId));
  }

  // ── Model gates ────────────────────────────────────────────────────────

  private gateKey(accountId: number, modelKey: string): string {
    return `${Number(accountId)}:${normalizeModelKey(modelKey)}`;
  }

  ensureModelGate(accountId: number, modelKey: string): ModelGate {
    const key = this.gateKey(accountId, modelKey);
    if (!this.gates.has(key)) {
      this.gates.set(key, {
        accountId: Number(accountId),
        modelKey: normalizeModelKey(modelKey),
        state: 'healthy', failCount: 0,
        blockedUntil: 0, nextProbeAfter: 0,
        lastFailureAt: 0, lastSuccessAt: 0, reason: '',
      });
    }
    return this.gates.get(key)!;
  }

  getModelGate(accountId: number, modelKey: string): ModelGate | null {
    return this.gates.get(this.gateKey(accountId, modelKey)) || null;
  }

  clearModelGate(accountId: number, modelKey: string): void {
    this.gates.delete(this.gateKey(accountId, modelKey));
  }

  /** Block an account for a specific model. Returns cooldown duration. */
  blockAccountForModel(
    accountId: number, modelKey: string,
    reason: string, durationMs: number,
  ): number {
    const normalized = normalizeModelKey(modelKey);
    if (!normalized) return 0;
    const cooldownMs = Math.max(60_000, Number(durationMs) || 0);
    const now = Date.now();
    const gate = this.ensureModelGate(accountId, normalized);
    gate.state = 'cooling';
    gate.failCount = Math.max(1, (gate.failCount || 0) + 1);
    gate.lastFailureAt = now;
    gate.blockedUntil = now + cooldownMs;
    gate.nextProbeAfter = now + Math.min(cooldownMs, AUTO_RECHECK_AFTER_MS);
    gate.reason = reason || 'model_unavailable';
    return cooldownMs;
  }

  // ── Gate reason classification ─────────────────────────────────────────

  isQuotaRecoverableGateReason(reason: string): boolean {
    const text = String(reason || '').toLowerCase();
    return !text || text === 'quota' || text === 'capacity' ||
      text === 'model_unavailable' ||
      text.includes('quota') || text.includes('capacity');
  }

  isAutoRecheckReason(reason: string): boolean {
    const text = String(reason || '').toLowerCase();
    return !text || text === 'quota' || text === 'capacity' ||
      text === 'model_unavailable' || text === 'location_probe' ||
      text.includes('quota') || text.includes('capacity');
  }

  // ── Account-level blocking ─────────────────────────────────────────────

  isAccountGloballyBlocked(account: any, now = Date.now()): BlockInfo | null {
    const blockedUntil = Number(account?.blockedUntil || 0);
    if (blockedUntil <= now) return null;
    return {
      reason: String(account?.quotaStatusReason || 'blocked'),
      blockedAt: Number(account?.exhaustedAt || 0),
      blockedUntil,
    };
  }

  getAccountModelBlock(account: any, modelKey: string, now = Date.now()): BlockInfo | null {
    const target = normalizeModelKey(modelKey);
    if (!account || !target) return null;
    const blockedModels = account?.blockedModels;
    const arr = blockedModels instanceof Map
      ? Array.from(blockedModels.values())
      : Array.isArray(blockedModels) ? blockedModels : [];
    const blocked = arr.find((item: any) => normalizeModelKey(item?.modelKey) === target);
    if (!blocked) return null;
    const blockedUntil = Number(blocked.blockedUntil || 0);
    if (blockedUntil > now || blockedUntil === 0) {
      return {
        modelKey: target,
        reason: String(blocked.reason || account.quotaStatusReason || 'model_unavailable'),
        blockedAt: Number(blocked.blockedAt || account.exhaustedAt || 0),
        blockedUntil,
      };
    }
    return null;
  }

  // ── Auto-recheck gate preparation ──────────────────────────────────────

  prepareAutoRecheckGate(
    account: any, modelKey: string,
    block: BlockInfo, now = Date.now(),
  ): ModelGate | null {
    const target = normalizeModelKey(modelKey);
    if (!account || !target || !block || !this.isAutoRecheckReason(block.reason)) return null;
    const gate = this.ensureModelGate(account.id, target);
    gate.reason = block.reason || gate.reason || 'quota';
    gate.blockedAt = Number(block.blockedAt || gate.blockedAt || now);
    gate.blockedUntil = Number(block.blockedUntil || gate.blockedUntil || 0);
    gate.lastFailureAt = Math.max(Number(gate.lastFailureAt || 0), gate.blockedAt!);
    const firstProbeAt = gate.blockedAt! > 0 ? gate.blockedAt! + AUTO_RECHECK_AFTER_MS : now;
    const existing = Number(gate.nextProbeAfter || 0);
    if (gate.state === 'cooling' && existing > now) return gate;
    gate.nextProbeAfter = existing > 0 ? existing : firstProbeAt;
    if (now < Number(gate.nextProbeAfter || 0)) {
      gate.state = 'cooling';
      return gate;
    }
    gate.state = 'probation';
    gate.nextProbeAfter = now;
    return gate;
  }

  // ── Model pressure tracking ────────────────────────────────────────────

  private pressureKey(modelKey: string): string {
    return normalizeModelKey(modelKey) || '(global)';
  }

  getModelPressure(modelKey: string, now = Date.now()): ModelPressureEntry | null {
    const key = this.pressureKey(modelKey);
    const p = this.pressure.get(key);
    if (!p) return null;
    if (Number(p.blockedUntil || 0) <= now) {
      this.pressure.delete(key);
      return null;
    }
    return p;
  }

  recordModelPressure(
    modelKey: string, status = 503,
    accountId = 0, now = Date.now(),
  ): ModelPressureEntry {
    const key = this.pressureKey(modelKey);
    const existing = this.pressure.get(key) || {
      modelKey: normalizeModelKey(modelKey),
      failCount: 0, uniqueAccountCount: 0,
      recentFailures: [], lastStatus: 0,
      firstFailureAt: now, lastFailureAt: 0,
      blockedUntil: 0, lastProbationProbeAt: 0,
    };
    if (!existing.recentFailures) existing.recentFailures = [];
    existing.recentFailures.push({ accountId: Number(accountId), at: now });
    existing.recentFailures = existing.recentFailures.filter(
      (f) => now - f.at < MODEL_PRESSURE_WINDOW_MS,
    );
    const uniqueAccounts = new Set(existing.recentFailures.map((f) => f.accountId));
    existing.failCount = existing.recentFailures.length;
    existing.uniqueAccountCount = uniqueAccounts.size;
    existing.lastFailureAt = now;
    existing.lastStatus = status;
    if (uniqueAccounts.size >= MODEL_PRESSURE_UNIQUE_THRESHOLD) {
      existing.blockedUntil = now + Math.min(MODEL_PRESSURE_BASE_MS, MODEL_PRESSURE_MAX_MS);
    }
    existing.lastProbationProbeAt = existing.lastProbationProbeAt || 0;
    this.pressure.set(key, existing);
    return existing;
  }

  clearModelPressure(modelKey: string): void {
    this.pressure.delete(this.pressureKey(modelKey));
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  cleanupExpiredGates(now = Date.now()): void {
    for (const [key, gate] of this.gates.entries()) {
      if (gate.state === 'healthy') this.gates.delete(key);
      else if (gate.state === 'cooling' && Number(gate.blockedUntil || 0) <= now) {
        this.gates.delete(key);
      }
    }
    for (const [key, p] of this.pressure.entries()) {
      if (Number(p.blockedUntil || 0) <= now) this.pressure.delete(key);
    }
  }

  // ── Serialization ──────────────────────────────────────────────────────

  serializeAccountStats(): Record<string, any> {
    return Object.fromEntries(
      Array.from(this.accountStats.entries()).map(([id, stats]) => [
        id,
        { ...stats, modelFailures: Object.fromEntries(stats.modelFailures.entries()) },
      ]),
    );
  }

  serializeModelGates(now = Date.now()): any[] {
    return Array.from(this.gates.values()).map((gate) => ({
      accountId: gate.accountId, modelKey: gate.modelKey,
      state: gate.state, reason: gate.reason || '',
      failCount: gate.failCount, blockedUntil: gate.blockedUntil,
      blockedForMs: Math.max(0, Number(gate.blockedUntil || 0) - now),
      nextProbeAfter: gate.nextProbeAfter,
      nextProbeInMs: Math.max(0, Number(gate.nextProbeAfter || 0) - now),
      lastFailureAt: gate.lastFailureAt, lastSuccessAt: gate.lastSuccessAt,
    }));
  }

  serializeModelPressure(now = Date.now()): any[] {
    return Array.from(this.pressure.values()).map((p) => ({
      modelKey: p.modelKey, failCount: p.failCount,
      uniqueAccountCount: p.uniqueAccountCount || 0,
      threshold: MODEL_PRESSURE_UNIQUE_THRESHOLD,
      lastStatus: p.lastStatus,
      firstFailureAt: p.firstFailureAt, lastFailureAt: p.lastFailureAt,
      blockedUntil: p.blockedUntil,
      blockedForMs: Math.max(0, Number(p.blockedUntil || 0) - now),
      activated: (p.uniqueAccountCount || 0) >= MODEL_PRESSURE_UNIQUE_THRESHOLD,
    }));
  }

  // ── Persistence export/import ──────────────────────────────────────────

  exportModelGates(): any[] {
    return Array.from(this.gates.values()).map((g) => ({
      accountId: g.accountId, modelKey: g.modelKey,
      state: g.state, failCount: g.failCount,
      blockedUntil: g.blockedUntil, nextProbeAfter: g.nextProbeAfter,
      lastFailureAt: g.lastFailureAt, lastSuccessAt: g.lastSuccessAt,
      reason: g.reason || '',
    }));
  }

  importModelGates(data: any[]): void {
    const now = Date.now();
    for (const saved of (Array.isArray(data) ? data : [])) {
      if (Number(saved.blockedUntil || 0) > 0 && Number(saved.blockedUntil || 0) <= now) continue;
      const key = this.gateKey(Number(saved.accountId), normalizeModelKey(saved.modelKey));
      this.gates.set(key, {
        accountId: Number(saved.accountId),
        modelKey: normalizeModelKey(saved.modelKey),
        state: saved.state || 'cooling',
        failCount: Number(saved.failCount || 0),
        blockedUntil: Number(saved.blockedUntil || 0),
        nextProbeAfter: Number(saved.nextProbeAfter || 0),
        lastFailureAt: Number(saved.lastFailureAt || 0),
        lastSuccessAt: Number(saved.lastSuccessAt || 0),
        reason: saved.reason || '',
      });
    }
  }

  exportAccountStats(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [id, stats] of this.accountStats.entries()) {
      result[String(id)] = {
        totalLeases: stats.totalLeases || 0,
        totalInputTokens: stats.totalInputTokens || 0,
        totalOutputTokens: stats.totalOutputTokens || 0,
        totalTokensUsed: stats.totalTokensUsed || 0,
        successCount: stats.successCount || 0,
        errorCount: stats.errorCount || 0,
        quota429Count: stats.quota429Count || 0,
        lastSuccessAt: stats.lastSuccessAt || 0,
        lastUsedAt: stats.lastUsedAt || 0,
      };
    }
    return result;
  }

  importAccountStats(data: Record<string, any>): void {
    for (const [id, saved] of Object.entries(data)) {
      const stats = this.ensureAccountStats(Number(id));
      stats.totalLeases = Number(saved.totalLeases || 0);
      stats.totalInputTokens = Number(saved.totalInputTokens || 0);
      stats.totalOutputTokens = Number(saved.totalOutputTokens || 0);
      stats.totalTokensUsed = Number(saved.totalTokensUsed || 0);
      stats.successCount = Number(saved.successCount || 0);
      stats.errorCount = Number(saved.errorCount || 0);
      stats.quota429Count = Number(saved.quota429Count || 0);
      stats.lastSuccessAt = Number(saved.lastSuccessAt || 0);
      stats.lastUsedAt = Number(saved.lastUsedAt || 0);
    }
  }
}
