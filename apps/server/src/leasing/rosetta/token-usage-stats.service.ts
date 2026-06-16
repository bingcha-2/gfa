import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { beijingDayKey, beijingDayKeysSince, beijingDayStart, beijingHourOfDay } from "../../shared/common/beijing-time";
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
 * CardUsageHourly account-scope WHERE fragment. The hourly table is keyed by the
 * stable accountEmail (no volatile accountId column, no legacy null rows), so
 * scoping a card to one provider-binding is just an accountEmail match when given.
 */
function hourlyAccountScope(opts: { accountEmail?: string }): Record<string, unknown> {
  const email = (opts.accountEmail || "").trim();
  return email ? { accountEmail: email } : {};
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

  // ── Aggregated view for one card: by day + by model ─────────────────────

  async getCardUsageSummary(opts: { accessKeyId: string; accountId?: number; accountEmail?: string; days?: number }) {
    const accessKeyId = String(opts.accessKeyId || "").trim();
    const days = Math.max(1, opts.days || 30);
    if (!accessKeyId) {
      return { totals: emptyTotals(), daily: [], byModel: [] };
    }

    const since = beijingDayStart(days);

    // Read the hourly aggregate (rows already carry summed tokens + requests).
    // Scope to one provider-binding via the stable accountEmail when provided.
    const rows = await this.prisma.cardUsageHourly.findMany({
      where: { accessKeyId, ...hourlyAccountScope(opts), hourStart: { gte: since } },
      select: {
        modelKey: true,
        bucket: true,
        requests: true,
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        rawTotalTokens: true,
        totalTokens: true,
        hourStart: true,
      },
      orderBy: { hourStart: "asc" },
    });

    const totals = emptyTotals();
    const dailyMap = new Map<string, { totalTokens: number; requests: number }>();
    const modelMap = new Map<
      string,
      { modelKey: string; bucket: string; totalTokens: number; inputTokens: number; outputTokens: number; requests: number }
    >();

    for (const r of rows) {
      totals.requests += r.requests;
      totals.inputTokens += r.inputTokens;
      totals.outputTokens += r.outputTokens;
      totals.cachedInputTokens += r.cachedInputTokens;
      totals.rawTotalTokens += r.rawTotalTokens;
      totals.totalTokens += r.totalTokens;

      const dateKey = beijingDayKey(r.hourStart);
      const d = dailyMap.get(dateKey) || { totalTokens: 0, requests: 0 };
      d.totalTokens += r.totalTokens;
      d.requests += r.requests;
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
      m.requests += r.requests;
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
    const rows = await this.prisma.cardUsageHourly.findMany({
      where: { hourStart: { gte: start } },
      select: {
        bucket: true,
        requests: true,
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        rawTotalTokens: true,
        totalTokens: true,
      },
    });

    // `tokens` 是计费口径(billable,缓存读已 1/10 折);拆分出净输入 / 输出 /
    // 缓存写入(cache_creation,= rawTotal − 净输入 − 输出 − 缓存读,无此项的家族 clamp 到 0) /
    // 缓存读,让前端能解释"为什么计费 token 比净对话大"。
    const empty = () => ({
      tokens: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    const totals = empty();
    const byProvider = {
      antigravity: empty(),
      codex: empty(),
      anthropic: empty(),
    };
    for (const r of rows) {
      const cacheWrite = Math.max(0, r.rawTotalTokens - r.inputTokens - r.outputTokens - r.cachedInputTokens);
      for (const t of [totals, byProvider[bucketProduct(r.bucket)]]) {
        t.tokens += r.totalTokens;
        t.requests += r.requests;
        t.inputTokens += r.inputTokens;
        t.outputTokens += r.outputTokens;
        t.cacheWriteTokens += cacheWrite;
        t.cacheReadTokens += r.cachedInputTokens;
      }
    }

    return {
      date: beijingDayKey(new Date()),
      totalTokens: totals.tokens,
      requests: totals.requests,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      cacheReadTokens: totals.cacheReadTokens,
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

    const rows = await this.prisma.cardUsageHourly.findMany({
      where: { hourStart: { gte: since } },
      select: { bucket: true, totalTokens: true, requests: true, hourStart: true },
    });

    const map = new Map<
      string,
      { antigravity: number; codex: number; anthropic: number; totalTokens: number; requests: number }
    >();
    for (const r of rows) {
      const key = beijingDayKey(r.hourStart);
      const d = map.get(key) || { antigravity: 0, codex: 0, anthropic: 0, totalTokens: 0, requests: 0 };
      d.totalTokens += r.totalTokens;
      d.requests += r.requests;
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

  // ── Per-card call frequency by Beijing hour-of-day ──────────────────────

  /**
   * How often a card is called across the 24 Beijing hours of the day, over the
   * last N days. Powers a per-card "调用频率" mini-histogram on the dashboard.
   * Always returns 24 buckets (zero-filled) so the chart axis is stable.
   */
  async getHourlyFrequency(opts: { accessKeyId: string; accountId?: number; accountEmail?: string; days?: number }) {
    const accessKeyId = String(opts.accessKeyId || "").trim();
    if (!accessKeyId) return { days: 0, byHour: [], totalRequests: 0 };

    const days = Math.max(1, Math.min(90, opts.days || 7));
    const since = beijingDayStart(days);

    // Scope to one provider-binding (see getCardUsageSummary).
    const rows = await this.prisma.cardUsageHourly.findMany({
      where: { accessKeyId, ...hourlyAccountScope(opts), hourStart: { gte: since } },
      select: { requests: true, totalTokens: true, hourStart: true },
    });

    const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 0, totalTokens: 0 }));
    let totalRequests = 0;
    for (const r of rows) {
      const h = beijingHourOfDay(r.hourStart);
      byHour[h].requests += r.requests;
      byHour[h].totalTokens += r.totalTokens;
      totalRequests += r.requests;
    }

    return { days, byHour, totalRequests };
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  /** Hourly aggregate retention — covers the 30-day dashboards + refund "used since
   *  paid" checks (subscriptions ≤30d) with buffer. Tiny (rows track cards×hours). */
  static readonly HOURLY_RETENTION_DAYS = 60;

  @Cron("25 3 * * *") // 3:25 AM daily — prune hourly aggregate
  async cleanupHourly() {
    const cutoff = beijingDayStart(TokenUsageStatsService.HOURLY_RETENTION_DAYS);
    try {
      const deleted = await this.prisma.cardUsageHourly.deleteMany({
        where: { hourStart: { lt: cutoff } },
      });
      if (deleted.count > 0) {
        this.logger.log(`Pruned ${deleted.count} hourly usage rows older than ${TokenUsageStatsService.HOURLY_RETENTION_DAYS} days`);
      }
    } catch (err) {
      this.logger.error(
        `Hourly usage cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
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
