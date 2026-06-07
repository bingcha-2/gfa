import { Inject, Injectable } from "@nestjs/common";

import { getModelQuotaFraction, hasModelQuotaRemaining } from "../token-server/lease-scheduler";
import { normalizeModelKey } from "../token-server/token-billing";
import { TokenServerService } from "../token-server/token-server.service";
import { RemoteCodexService } from "../remote-codex/service/remote-codex.service";
import { RemoteAnthropicService } from "../remote-anthropic/service/remote-anthropic.service";
import { PrismaService } from "../prisma/prisma.service";
import { TokenUsageStatsService } from "../rosetta/token-usage-stats.service";

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
  /** Per-account count by water band (for the stacked supply bar). */
  distribution: { exhausted: number; warn: number; low: number; healthy: number; noData: number };
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

    const distribution = { exhausted: 0, warn: 0, low: 0, healthy: 0, noData: 0 };
    for (const acc of enabledAccounts) {
      if (canServeModel(acc, m.key, now)) available++;
      const f = getModelQuotaFraction(acc, m.key);
      if (f !== null && f >= 0) {
        fractions.push(f);
        best = best === null ? f : Math.max(best, f);
        lowest = lowest === null ? f : Math.min(lowest, f);
        if (f < LOW_REMAINING) lowCount++;
      }
      if (f === null || f < 0) distribution.noData++;
      else if (f < 0.05) distribution.exhausted++;
      else if (f < 0.20) distribution.warn++;
      else if (f < 0.50) distribution.low++;
      else distribution.healthy++;
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
      distribution,
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

/** Lease service surface the dashboard needs. The concrete services
 *  (TokenServerService / RemoteCodexService / RemoteAnthropicService) satisfy it. */
type DashboardProvider = {
  getStatus: () => any;
  getBoundCardsForAccount: (accountId: number) => Array<{
    id: string;
    name: string;
    weight: number;
    totalTokensUsed: number;
    totalRequests: number;
    fairShare: Record<string, { fraction: number; resetAt: number }>;
  }>;
};

export interface AccountWaterPoint {
  modelKey: string;
  hourlyPercent: number | null;
  weeklyPercent: number | null;
  hourlyResetAt: string | null;
  weeklyResetAt: string | null;
}

interface AccountSnapshots {
  current: AccountWaterPoint[]; // latest snapshot per modelKey
  history: Array<{ timestamp: string; modelKey: string; hourlyPercent: number | null; weeklyPercent: number | null }>;
}

/** Most history points to keep per account (sparse after on-change dedup). */
const MAX_HISTORY_POINTS = 300;

@Injectable()
export class RemoteStatsService {
  constructor(
    @Inject(TokenServerService) private readonly antigravity: DashboardProvider,
    @Inject(RemoteCodexService) private readonly codex: DashboardProvider,
    @Inject(RemoteAnthropicService) private readonly anthropic: DashboardProvider,
    private readonly prisma: PrismaService,
    private readonly tokenUsageStats: TokenUsageStatsService,
  ) {}

  /** Supply-side rollup for all three御三家 providers (health + per-model water). */
  getStats() {
    return {
      ok: true,
      providers: [
        rollupProviderStats("antigravity", this.antigravity.getStatus()),
        rollupProviderStats("codex", this.codex.getStatus()),
        rollupProviderStats("anthropic", this.anthropic.getStatus()),
      ],
    };
  }

  /**
   * One-page dashboard payload: per product → health rollup → accounts
   * (water level + reset + history) → bound cards (weight, usage trend, call
   * frequency, fair-share remaining). All three御三家 share this single shape.
   */
  async getDashboard(opts?: { days?: number }) {
    const days = Math.max(1, Math.min(30, opts?.days || 7));
    const products = await Promise.all([
      this.buildProduct("antigravity", this.antigravity, days),
      this.buildProduct("codex", this.codex, days),
      this.buildProduct("anthropic", this.anthropic, days),
    ]);
    return { ok: true, days, products };
  }

  private async buildProduct(id: string, service: DashboardProvider, days: number) {
    const status = service.getStatus();
    const health = rollupProviderStats(id, status);
    const snapshots = await this.loadAccountSnapshots(id, days);
    const statusAccounts: any[] = status?.quota?.accounts || [];

    // Only accounts with something to show: bound cards or water-level history.
    // Pool accounts with neither (often the bulk) would just be empty clutter.
    const candidates = statusAccounts
      .map((acc) => ({ acc, snap: snapshots.get(acc.id), boundBase: service.getBoundCardsForAccount(acc.id) }))
      .filter((c) => c.boundBase.length > 0 || c.snap);

    const accounts = await Promise.all(
      candidates.map(async ({ acc, snap, boundBase }) => {
        const boundCards = await Promise.all(boundBase.map((card) => this.decorateCard(card, days)));
        return {
          id: acc.id,
          email: acc.email || "",
          planType: acc.planType || "",
          quotaStatus: acc.quotaStatus || "ok",
          activeLeases: Number(acc.activeLeases || 0),
          water: snap?.current || [],
          waterHistory: snap?.history || [],
          boundCards,
        };
      }),
    );

    return { id, mode: String(status?.mode || ""), health, accounts, totalAccounts: statusAccounts.length };
  }

  private async decorateCard(
    card: ReturnType<DashboardProvider["getBoundCardsForAccount"]>[number],
    days: number,
  ) {
    const [summary, freq] = await Promise.all([
      this.tokenUsageStats.getCardUsageSummary({ accessKeyId: card.id, days }),
      this.tokenUsageStats.getHourlyFrequency({ accessKeyId: card.id, days }),
    ]);
    return {
      ...card,
      usageTrend: (summary as any)?.daily || [],
      usageTotals: (summary as any)?.totals || { totalTokens: 0, requests: 0 },
      hourlyFrequency: (freq as any)?.byHour || [],
    };
  }

  /** Latest + historical 5h/weekly water levels per account, from AccountQuotaSnapshot. */
  private async loadAccountSnapshots(provider: string, days: number): Promise<Map<number, AccountSnapshots>> {
    const out = new Map<number, AccountSnapshots>();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let rows: any[];
    try {
      rows = await this.prisma.accountQuotaSnapshot.findMany({
        where: { provider, timestamp: { gte: since } },
        orderBy: { timestamp: "asc" },
      });
    } catch {
      return out;
    }

    const latestByModel = new Map<number, Map<string, AccountWaterPoint>>();
    for (const r of rows) {
      const accountId = Number(r.accountId);
      let entry = out.get(accountId);
      if (!entry) out.set(accountId, (entry = { current: [], history: [] }));
      entry.history.push({
        timestamp: toIso(r.timestamp),
        modelKey: String(r.modelKey),
        hourlyPercent: numOrNull(r.hourlyPercent),
        weeklyPercent: numOrNull(r.weeklyPercent),
      });
      let models = latestByModel.get(accountId);
      if (!models) latestByModel.set(accountId, (models = new Map()));
      // rows are asc by timestamp → last write wins = latest snapshot.
      models.set(String(r.modelKey), {
        modelKey: String(r.modelKey),
        hourlyPercent: numOrNull(r.hourlyPercent),
        weeklyPercent: numOrNull(r.weeklyPercent),
        hourlyResetAt: r.hourlyResetAt ? toIso(r.hourlyResetAt) : null,
        weeklyResetAt: r.weeklyResetAt ? toIso(r.weeklyResetAt) : null,
      });
    }

    for (const [accountId, entry] of out) {
      entry.current = [...(latestByModel.get(accountId)?.values() || [])];
      if (entry.history.length > MAX_HISTORY_POINTS) {
        entry.history = entry.history.slice(-MAX_HISTORY_POINTS);
      }
    }
    return out;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toIso(v: any): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
