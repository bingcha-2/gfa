import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { PrismaService } from "../prisma/prisma.service";
import { beijingDayKey, beijingDayKeysSince, beijingDayStart } from "../common/beijing-time";
import { productOfBucket } from "../lease-core/product-bucket";

/** Product a usage row's bucket belongs to. Composite `<product>-<family>` →
 *  product; legacy bare buckets (gemini/opus/codex) map to their old provider. */
function bucketProduct(bucket: string): "antigravity" | "codex" | "anthropic" {
  if (bucket && bucket.includes("-")) {
    const p = productOfBucket(bucket);
    if (p === "codex" || p === "anthropic") return p;
    return "antigravity";
  }
  return bucket === "codex" ? "codex" : "antigravity"; // legacy bare: opus/gemini → antigravity
}

/**
 * Query + maintenance side of the per-card token usage log (CardTokenUsage).
 * The write side lives in token-server/token-usage-tracker.ts. Mirrors
 * CreditStatsService: paginated records, day/model aggregation, retention cron.
 */
@Injectable()
export class TokenUsageStatsService {
  private readonly logger = new Logger(TokenUsageStatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Paginated per-call records for one card ─────────────────────────────

  async getCardUsageRecords(opts: {
    accessKeyId: string;
    page?: number;
    pageSize?: number;
    days?: number;
  }) {
    const accessKeyId = String(opts.accessKeyId || "").trim();
    if (!accessKeyId) {
      return { records: [], total: 0, page: 1, pageSize: 0, totalPages: 0 };
    }

    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(200, Math.max(1, opts.pageSize || 30));
    const days = Math.max(1, opts.days || 30);

    const since = beijingDayStart(days);

    const where = { accessKeyId, timestamp: { gte: since } };

    const [records, total] = await Promise.all([
      this.prisma.cardTokenUsage.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.cardTokenUsage.count({ where }),
    ]);

    return {
      records: records.map((r: any) => ({
        id: r.id,
        accountId: r.accountId,
        modelKey: r.modelKey,
        bucket: r.bucket,
        status: r.status,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cachedInputTokens: r.cachedInputTokens,
        rawTotalTokens: r.rawTotalTokens,
        totalTokens: r.totalTokens,
        timestamp: r.timestamp.toISOString(),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  // ── Aggregated view for one card: by day + by model ─────────────────────

  async getCardUsageSummary(opts: { accessKeyId: string; days?: number }) {
    const accessKeyId = String(opts.accessKeyId || "").trim();
    const days = Math.max(1, opts.days || 30);
    if (!accessKeyId) {
      return { totals: emptyTotals(), daily: [], byModel: [] };
    }

    const since = beijingDayStart(days);

    const rows = await this.prisma.cardTokenUsage.findMany({
      where: { accessKeyId, timestamp: { gte: since } },
      select: {
        modelKey: true,
        bucket: true,
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        rawTotalTokens: true,
        totalTokens: true,
        timestamp: true,
      },
      orderBy: { timestamp: "asc" },
    });

    const totals = emptyTotals();
    const dailyMap = new Map<string, { totalTokens: number; requests: number }>();
    const modelMap = new Map<
      string,
      { modelKey: string; bucket: string; totalTokens: number; inputTokens: number; outputTokens: number; requests: number }
    >();

    for (const r of rows) {
      totals.requests += 1;
      totals.inputTokens += r.inputTokens;
      totals.outputTokens += r.outputTokens;
      totals.cachedInputTokens += r.cachedInputTokens;
      totals.rawTotalTokens += r.rawTotalTokens;
      totals.totalTokens += r.totalTokens;

      const dateKey = beijingDayKey(r.timestamp);
      const d = dailyMap.get(dateKey) || { totalTokens: 0, requests: 0 };
      d.totalTokens += r.totalTokens;
      d.requests += 1;
      dailyMap.set(dateKey, d);

      const m = modelMap.get(r.modelKey) || {
        modelKey: r.modelKey,
        bucket: r.bucket,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
      };
      m.totalTokens += r.totalTokens;
      m.inputTokens += r.inputTokens;
      m.outputTokens += r.outputTokens;
      m.requests += 1;
      modelMap.set(r.modelKey, m);
    }

    // Fill all Beijing days (including zeros) for a continuous chart.
    const daily = beijingDayKeysSince(days).map((dateKey) => {
      const d = dailyMap.get(dateKey) || { totalTokens: 0, requests: 0 };
      return { date: dateKey, totalTokens: d.totalTokens, requests: d.requests };
    });

    const byModel = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);

    return { totals, daily, byModel };
  }

  // ── Today's total token consumption (persisted, Beijing day) ────────────

  /**
   * Sum of billable tokens consumed so far today (Beijing calendar day) across
   * all cards, broken down by provider. Persisted + restart-safe — replaces the
   * in-memory daily counter on the usage dashboard. Codex bucket → codex
   * provider; gemini/opus (and anything else) → antigravity.
   */
  async getTodayUsage() {
    const start = beijingDayStart(0);
    const rows = await this.prisma.cardTokenUsage.findMany({
      where: { timestamp: { gte: start } },
      select: { bucket: true, totalTokens: true },
    });

    let totalTokens = 0;
    let requests = 0;
    const byProvider = {
      antigravity: { tokens: 0, requests: 0 },
      codex: { tokens: 0, requests: 0 },
      anthropic: { tokens: 0, requests: 0 },
    };
    for (const r of rows) {
      totalTokens += r.totalTokens;
      requests += 1;
      const target = byProvider[bucketProduct(r.bucket)];
      target.tokens += r.totalTokens;
      target.requests += 1;
    }

    return {
      date: beijingDayKey(new Date()),
      totalTokens,
      requests,
      byProvider,
    };
  }

  // ── Global token usage trend (all cards, Beijing days, by provider) ─────

  /**
   * Daily billable-token trend across all cards for the last N Beijing days,
   * split by provider (codex bucket → codex; gemini/opus/other → antigravity).
   * Powers the 用量剩余 dashboard's 7/30-day chart. Persisted + restart-safe.
   */
  async getUsageTrend(opts: { days?: number }) {
    const days = Math.max(1, Math.min(90, opts.days || 7));
    const since = beijingDayStart(days);

    const rows = await this.prisma.cardTokenUsage.findMany({
      where: { timestamp: { gte: since } },
      select: { bucket: true, totalTokens: true, timestamp: true },
    });

    const map = new Map<
      string,
      { antigravity: number; codex: number; anthropic: number; totalTokens: number; requests: number }
    >();
    for (const r of rows) {
      const key = beijingDayKey(r.timestamp);
      const d = map.get(key) || { antigravity: 0, codex: 0, anthropic: 0, totalTokens: 0, requests: 0 };
      d.totalTokens += r.totalTokens;
      d.requests += 1;
      d[bucketProduct(r.bucket)] += r.totalTokens;
      map.set(key, d);
    }

    const daily = beijingDayKeysSince(days).map((date) => {
      const d = map.get(date) || { antigravity: 0, codex: 0, anthropic: 0, totalTokens: 0, requests: 0 };
      return { date, ...d };
    });

    const totals = daily.reduce(
      (a, d) => ({ totalTokens: a.totalTokens + d.totalTokens, requests: a.requests + d.requests }),
      { totalTokens: 0, requests: 0 },
    );

    return { days, daily, totals };
  }

  // ── Delete all usage rows for a card (called on card deletion) ──────────

  async deleteCardUsage(accessKeyId: string): Promise<number> {
    const id = String(accessKeyId || "").trim();
    if (!id) return 0;
    try {
      const result = await this.prisma.cardTokenUsage.deleteMany({ where: { accessKeyId: id } });
      return result.count;
    } catch (err) {
      this.logger.error(
        `deleteCardUsage failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  // ── Cleanup: retain only 90 days of data ────────────────────────────────

  @Cron("15 3 * * *") // 3:15 AM daily (offset from credit-stats cleanup)
  async cleanupOldData() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    try {
      const deleted = await this.prisma.cardTokenUsage.deleteMany({
        where: { timestamp: { lt: cutoff } },
      });
      if (deleted.count > 0) {
        this.logger.log(`Cleaned up ${deleted.count} card token usage records older than 90 days`);
      }
    } catch (err) {
      this.logger.error(
        `Card token usage cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function emptyTotals() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    rawTotalTokens: 0,
    totalTokens: 0,
  };
}
