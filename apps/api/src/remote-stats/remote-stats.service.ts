import { Inject, Injectable } from "@nestjs/common";

import { getModelQuotaFraction, hasModelQuotaRemaining } from "../token-server/lease-scheduler";
import { normalizeModelKey } from "../token-server/token-billing";
import { TokenServerService } from "../token-server/token-server.service";
import { RemoteCodexService } from "../remote-codex/service/remote-codex.service";

/** Remaining fraction below this is treated as "near-exhausted" (warning). */
const LOW_REMAINING = 0.2;

export interface ProviderModelStat {
  key: string;
  displayName: string;
  bucket: string;
  /** Enabled accounts in the pool (N). */
  poolSize: number;
  /** Accounts that can currently serve this model — enabled, not cooling/exhausted/errored,
   *  not model-blocked, and with quota remaining (X in "X/N"). */
  available: number;
  /** Accounts that report a numeric remaining fraction for this model. */
  withData: number;
  /** Lowest remaining fraction across accounts-with-data — the real water level. */
  lowestRemaining: number | null;
  /** Median remaining fraction across accounts-with-data. */
  medianRemaining: number | null;
  /** Highest remaining fraction (kept as secondary; misleading on its own). */
  bestRemaining: number | null;
  /** Accounts-with-data whose remaining fraction is below LOW_REMAINING. */
  lowCount: number;
}

export interface ProviderStats {
  id: string;
  mode: string;
  accounts: { total: number; enabled: number; ok: number; cooling: number; exhausted: number; error: number };
  usage: { dailyTokensUsed: number; activeLeases: number; totalLeases: number; totalReports: number };
  models: ProviderModelStat[];
}

/** Whether a model is currently blocked for an account (per-model cooldown still active). */
function isModelBlocked(acc: any, modelKey: string, now: number): boolean {
  const blocked = acc?.blockedModels;
  if (!Array.isArray(blocked) || blocked.length === 0) return false;
  const target = normalizeModelKey(modelKey);
  return blocked.some(
    (b: any) => normalizeModelKey(b?.modelKey) === target && Number(b?.blockedUntil || 0) > now,
  );
}

/** Whether an account can serve `modelKey` right now. */
function canServeModel(acc: any, modelKey: string, now: number): boolean {
  if (acc?.enabled === false) return false;
  const s = String(acc?.quotaStatus || "ok");
  if (s !== "ok") return false; // cooling / exhausted / error
  if (isModelBlocked(acc, modelKey, now)) return false;
  return hasModelQuotaRemaining(acc, modelKey);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Normalize one provider's getStatus() output into a stats rollup. */
export function rollupProviderStats(id: string, status: any, now = Date.now()): ProviderStats {
  const quotaAccounts: any[] = status?.quota?.accounts || [];
  const health = { ok: 0, cooling: 0, exhausted: 0, error: 0 };
  for (const acc of quotaAccounts) {
    const s = String(acc?.quotaStatus || "ok");
    if (s === "ok") health.ok++;
    else if (s === "cooling") health.cooling++;
    else if (s === "exhausted") health.exhausted++;
    else if (s === "error") health.error++;
  }

  const enabledAccounts = quotaAccounts.filter((a) => a?.enabled !== false);
  const models: ProviderModelStat[] = (status?.models || []).map((m: any) => {
    const fractions: number[] = [];
    let best: number | null = null;
    let lowest: number | null = null;
    let available = 0;
    let lowCount = 0;

    for (const acc of enabledAccounts) {
      if (canServeModel(acc, m.key, now)) available++;
      const f = getModelQuotaFraction(acc, m.key);
      if (f !== null && f >= 0) {
        fractions.push(f);
        best = best === null ? f : Math.max(best, f);
        lowest = lowest === null ? f : Math.min(lowest, f);
        if (f < LOW_REMAINING) lowCount++;
      }
    }

    return {
      key: m.key,
      displayName: m.displayName,
      bucket: m.bucket,
      poolSize: enabledAccounts.length,
      available,
      withData: fractions.length,
      lowestRemaining: lowest,
      medianRemaining: median(fractions),
      bestRemaining: best,
      lowCount,
    };
  });

  return {
    id,
    mode: String(status?.mode || ""),
    accounts: {
      total: Number(status?.accounts?.total || quotaAccounts.length || 0),
      enabled: Number(status?.accounts?.enabled || enabledAccounts.length || 0),
      ...health,
    },
    usage: {
      dailyTokensUsed: Number(status?.daily?.tokensUsed || 0),
      activeLeases: Number(status?.activeLeases || 0),
      totalLeases: Number(status?.totalLeases || 0),
      totalReports: Number(status?.totalReports || 0),
    },
    models,
  };
}

type StatusProvider = { getStatus: () => any };

@Injectable()
export class RemoteStatsService {
  constructor(
    @Inject(TokenServerService) private readonly antigravity: StatusProvider,
    @Inject(RemoteCodexService) private readonly codex: StatusProvider,
  ) {}

  getStats() {
    return {
      ok: true,
      providers: [
        rollupProviderStats("antigravity", this.antigravity.getStatus()),
        rollupProviderStats("codex", this.codex.getStatus()),
      ],
    };
  }
}
