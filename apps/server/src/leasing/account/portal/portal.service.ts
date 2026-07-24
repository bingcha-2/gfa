import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { calculateApiValue } from "@gfa/shared";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { rowToConfig } from "../../subscription/subscription-config";
import type { AccessKeyStore } from "../../token-server/access-key-store";

type PortalQuotaBucket = {
  bucket: string;
  used?: number;
  limit: number;
  resetMs?: number;
};

type PortalQuota = {
  quotaMode: "usd" | "static" | "dynamic" | "unlimited";
  usdQuotaByProduct: Record<string, {
    fiveHour: { used: number; limit: number; resetMs: number | null } | null;
    weekly: { used: number; limit: number; resetMs: number | null } | null;
  }>;
  buckets: PortalQuotaBucket[];
  weeklyBuckets: PortalQuotaBucket[];
  recentWindowTokens: number;
  tokenWindowResetMs: number | null;
  weeklyTokenLimit: number | null;
  weeklyWindowResetMs: number | null;
  weeklyWindowTokens: number;
  totalTokensUsed: number;
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 图表 X 轴桶标签:hour → "HH:00";day → "MM-DD"(均按服务器本地时区)。 */
function formatBucketLabel(start: Date, granularity: "hour" | "day"): string {
  if (granularity === "hour") return `${pad2(start.getHours())}:00`;
  return `${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
}

/**
 * 省钱折算价(美元/百万 token),与客户端 apps/app/pricing.json 同一份表。
 * USD 算法与客户端 estimateOfficialCostUSD 对齐(含缓存读/写单价):
 *   USD = 净输入·inPerM + 输出·outPerM + 缓存读·cacheReadPerM + 缓存写·cacheWritePerM(均 /1e6)。
 * CardUsageHourly 保存服务端归一化后的 gross input；缓存读写都是其子集。
 * family 取自 bucket 后缀(`<product>-<family>`,如 antigravity-claude);
 * 未知/缺失家族回退 gemini(与客户端 priceFor 一致)。
 */
// 与客户端 apps/app/pricing.json 同一份表(含缓存读/写单价)。
const FAMILY_PRICING: Record<string, { inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number }> = {
  claude: { inPerM: 5, outPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
  gemini: { inPerM: 2, outPerM: 12, cacheReadPerM: 0.5, cacheWritePerM: 2.5 },
  gpt: { inPerM: 1.25, outPerM: 10, cacheReadPerM: 0.125, cacheWritePerM: 1.25 },
};

function familyOfBucket(bucket: string): string {
  const i = bucket.indexOf("-");
  return i < 0 ? "" : bucket.slice(i + 1);
}

function cacheWriteForRow(row: any): number {
  const aggregate = Math.max(0, Number(row.cacheCreationTokens) || 0);
  if (aggregate > 0) return aggregate;
  return Math.max(0, Number(row.cacheWrite5mTokens) || 0) + Math.max(0, Number(row.cacheWrite1hTokens) || 0);
}

function netInputForRow(row: any): number {
  const input = Math.max(0, Number(row.inputTokens) || 0);
  const cached = Math.max(0, Number(row.cachedInputTokens) || 0);
  return Math.max(0, input - cached - cacheWriteForRow(row));
}

/**
 * 「官方 API 价估算」USD —— 与客户端 estimateOfficialCostUSD 同一算法(含缓存读/写)。
 * `input` 必须是 **净输入**(= gross − 缓存读 − 缓存写);缓存读/写从各自的列(cachedInputTokens /
 * cacheCreationTokens)取真实值。totals.savedUSD 与 per-model estimatedUSD 共用此函数,口径自洽。
 */
function officialCostFor(
  bucket: string, input: number, output: number, cacheRead: number, cacheWrite: number,
): number {
  const p = FAMILY_PRICING[familyOfBucket(bucket)] ?? FAMILY_PRICING.gemini;
  return (
    (input / 1_000_000) * p.inPerM +
    (output / 1_000_000) * p.outPerM +
    (cacheRead / 1_000_000) * p.cacheReadPerM +
    (cacheWrite / 1_000_000) * p.cacheWritePerM
  );
}

function modelAwareCostForRow(row: any, netInput: number, output: number, cacheRead: number, cacheWrite: number): number {
  const requests = Math.max(0, Number(row.requests || 0));
  const pricedRequests = Math.min(requests, Math.max(0, Number(row.apiPricedRequests || 0)));
  const frozen = Number(row.apiValueUsd);
  if (requests > 0 && pricedRequests === requests && Number.isFinite(frozen) && frozen >= 0) return frozen;
  const provider = String(row.bucket || "").startsWith("codex-")
    ? "codex"
    : String(row.bucket || "").startsWith("anthropic-") ? "anthropic" : null;
  if (!provider || !row.modelKey) return officialCostFor(row.bucket, netInput, output, cacheRead, cacheWrite);
  const totalRaw = Math.max(1, netInput + output + cacheRead + cacheWrite);
  const priorityRatio = Math.min(1, Math.max(0, Number(row.priorityTokens || 0) / totalRaw));
  const fast = (value: number) => Math.round(Math.max(0, value) * priorityRatio);
  const fi = fast(netInput), fo = fast(output), fr = fast(cacheRead), fw = fast(cacheWrite);
  const rawOccurredAt = row.hourStart instanceof Date
    ? row.hourStart.getTime()
    : Number(row.hourStart);
  const occurredAt = Number.isFinite(rawOccurredAt) && rawOccurredAt > 0 ? rawOccurredAt : Date.now();
  const value = (mode: "standard" | "priority", input: number, out: number, read: number, write: number) => calculateApiValue({
    provider, modelId: String(row.modelKey), pricingMode: mode,
    inputTokens: input, outputTokens: out, cachedInputTokens: read,
    cacheWrite5mTokens: write, cacheWrite1hTokens: 0,
    contextTokens: 0, occurredAt,
  }).usd;
  const estimated = value("standard", netInput - fi, output - fo, cacheRead - fr, cacheWrite - fw)
    + (priorityRatio > 0 ? value("priority", fi, fo, fr, fw) : 0);
  if (requests <= 0 || pricedRequests <= 0 || !Number.isFinite(frozen) || frozen < 0) return estimated;

  // A deployment can straddle one hourly aggregate: new requests already have
  // exact, occurrence-time values while legacy requests in the same row do not.
  // Never discard or reprice the frozen part. The old requests have no separate
  // token columns, so estimate only their proportional share of the row.
  return frozen + estimated * ((requests - pricedRequests) / requests);
}

function numericRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [bucket, raw] of Object.entries(value as Record<string, unknown>)) {
    const limit = Number(raw);
    if (Number.isFinite(limit) && limit > 0) out[bucket] = limit;
  }
  return out;
}

function mergeBucketLimits(
  configuredLimits: Record<string, number>,
  statusBuckets: unknown,
): PortalQuotaBucket[] {
  const byBucket = new Map<string, any>();
  if (Array.isArray(statusBuckets)) {
    for (const b of statusBuckets) {
      if (b && typeof b === "object" && typeof (b as any).bucket === "string") {
        byBucket.set((b as any).bucket, b);
      }
    }
  }

  const names = new Set([...Object.keys(configuredLimits), ...byBucket.keys()]);
  return [...names].sort().flatMap((bucket) => {
    const statusBucket = byBucket.get(bucket);
    const configuredLimit = configuredLimits[bucket];
    const statusLimit = Number(statusBucket?.limit);
    const limit =
      Number.isFinite(configuredLimit) && configuredLimit > 0
        ? configuredLimit
        : Number.isFinite(statusLimit) && statusLimit > 0
          ? statusLimit
          : null;
    if (limit == null) return [];

    const merged: PortalQuotaBucket = { bucket, limit };
    const used = Number(statusBucket?.used);
    if (Number.isFinite(used)) merged.used = used;
    const resetMs = Number(statusBucket?.resetMs);
    if (Number.isFinite(resetMs) && resetMs > 0) merged.resetMs = resetMs;
    return [merged];
  });
}

function mapQuota(
  status: any,
  configuredBucketLimits: Record<string, number> = {},
  configuredWeeklyBucketLimits: Record<string, number> = {},
): PortalQuota {
  const tokenWindowResetMs = status?.tokenWindowResetMs != null ? Number(status.tokenWindowResetMs) : null;
  const weeklyWindowResetMs = status?.weeklyWindowResetMs != null && Number(status.weeklyWindowResetMs) > 0
    ? Number(status.weeklyWindowResetMs)
    : null;
  const buckets = mergeBucketLimits(configuredBucketLimits, status?.buckets);
  const weeklyBuckets = mergeBucketLimits(configuredWeeklyBucketLimits, status?.weeklyBuckets);

  // Sum weekly bucket used values to get current weekly window consumption.
  // publicStatus exposes weeklyBuckets:[{bucket,used,limit}] when weeklyTokenLimit>0.
  const weeklyWindowTokens = weeklyBuckets.reduce((sum, b) => sum + (Number(b.used) || 0), 0);
  const configuredWeeklyLimit = weeklyBuckets.reduce((sum, b) => sum + (Number(b.limit) || 0), 0);

  return {
    quotaMode: status?.quotaMode ?? (buckets.length > 0 || weeklyBuckets.length > 0 ? "static" : "unlimited"),
    usdQuotaByProduct: mapUsdQuotaByProduct(status?.usdQuotaByProduct),
    buckets,
    weeklyBuckets,
    recentWindowTokens: Number(status?.recentWindowTokens ?? 0),
    tokenWindowResetMs,
    weeklyTokenLimit: status?.weeklyTokenLimit != null && Number(status.weeklyTokenLimit) > 0
      ? Number(status.weeklyTokenLimit)
      : configuredWeeklyLimit > 0
        ? configuredWeeklyLimit
      : null,
    weeklyWindowResetMs,
    weeklyWindowTokens,
    totalTokensUsed: Number(status?.totalTokensUsed ?? 0),
  };
}

function mapUsdQuotaByProduct(value: unknown): PortalQuota["usdQuotaByProduct"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, any>).flatMap(([product, quota]) => {
    const fiveHour = mapUsdWindow(quota?.fiveHour);
    const weekly = mapUsdWindow(quota?.weekly);
    return fiveHour || weekly ? [[product, { fiveHour, weekly }]] : [];
  }));
}

function mapUsdWindow(value: any): { used: number; limit: number; resetMs: number | null } | null {
  const limit = Number(value?.limit);
  if (!(limit > 0)) return null;
  const resetMs = Number(value?.resetMs);
  return {
    used: Math.max(0, Number(value?.used) || 0),
    limit,
    resetMs: Number.isFinite(resetMs) && resetMs > 0 ? resetMs : null,
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

@Injectable()
export class PortalService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject("SHARED_ACCESS_KEY_STORE")
    private readonly store: AccessKeyStore,
  ) {}

  // ── Overview (KPI + quota) ─────────────────────────────────────────────────

  async getOverview(customerId: string) {
    const [customer, rawSubs, rawDeviceCount, unreadNotifications] = await Promise.all([
      this.prisma.customer.findUniqueOrThrow({
        where: { id: customerId },
        select: {
          id: true,
          email: true,
          displayName: true,
          emailVerified: true,
          referralCode: true,
          creditCents: true,
          status: true,
          createdAt: true,
        },
      }),
      this.prisma.subscription.findMany({
        where: { customerId },
      }),
      this.prisma.device.count({
        where: { customerId, status: "ACTIVE" },
      }),
      this.prisma.notification.count({
        where: { customerId, readAt: null },
      }),
    ]);

    // Build subscription views with quota
    const subscriptions = rawSubs.map((sub) => {
      const config = rowToConfig(sub as any);
      const record = this.store.findById(sub.id);
      const status = record ? this.store.publicStatus(record) : null;
      const shareCapacity = positiveNumber(config.shareCapacity, 8);
      const shareSeats = positiveNumber(
        config.shareSeats ?? config.weight ?? sub.weight,
        1,
      );
      const quota = mapQuota(
        status,
        numericRecord(config.bucketLimits),
        numericRecord(config.weeklyBucketLimits),
      );

      let productEntitlements: string[] = [];
      try {
        productEntitlements = JSON.parse(sub.productEntitlements) as string[];
      } catch {
        productEntitlements = [];
      }
      if (productEntitlements.length === 0 && Array.isArray(config.products)) {
        productEntitlements = config.products.map(String);
      }

      return {
        id: sub.id,
        // The configurator has no single plan name; products[] carries the detail.
        planName: null,
        status: sub.status as string,
        isTrial: sub.isTrial,
        products: productEntitlements,
        expiresAt: sub.expiresAt ? sub.expiresAt.toISOString() : null,
        deviceLimit: sub.deviceLimit,
        weight: sub.weight,
        priority: sub.priority,
        migratedFromCard: sub.migratedFromKey != null,
        shareSeats,
        shareCapacity,
        seatsLabel: `${shareSeats}/${shareCapacity} 席`,
        quota,
      };
    });

    // Active subscriptions for device limit calculation
    const now = new Date();
    const activeSubs = rawSubs.filter(
      (s) =>
        s.status === "ACTIVE" &&
        (s.expiresAt === null || s.expiresAt > now),
    );
    const deviceLimit =
      activeSubs.length > 0
        ? Math.max(...activeSubs.map((s) => s.deviceLimit))
        : 1;

    return {
      customer: {
        id: customer.id,
        email: customer.email,
        displayName: customer.displayName ?? null,
        emailVerified: customer.emailVerified,
        referralCode: customer.referralCode,
        creditCents: customer.creditCents,
        status: customer.status as string,
        createdAt: customer.createdAt.toISOString(),
      },
      subscriptions,
      devices: {
        count: rawDeviceCount,
        limit: deviceLimit,
      },
      unreadNotifications,
    };
  }

  // ── Subscription priority ──────────────────────────────────────────────────

  /** 设置某订阅的优先级(账户内接力顺序)。校验订阅属于该 customer,update,返回重排后的概览订阅列表。 */
  async setSubscriptionPriority(customerId: string, subscriptionId: string, priority: number) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { id: true, customerId: true },
    });
    if (!sub || sub.customerId !== customerId) {
      throw new NotFoundException({ error: "SUBSCRIPTION_NOT_FOUND", message: "订阅不存在或不属于当前账户" });
    }
    const normalized = Math.max(0, Math.floor(Number(priority) || 0));
    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { priority: normalized },
    });
    // 写 DB(真相源)后立即刷新内存 subscriptionById —— 否则 SubscriptionScheduler 的
    // 账户内接力仍按旧 priority 走,直到重启/下次 resync(读后写陈旧)。
    this.store.setSubscriptionPriority(subscriptionId, normalized);
    const overview = await this.getOverview(customerId);
    return { ok: true, subscriptions: overview.subscriptions };
  }

  // ── Usage stats (aggregated for charts) ─────────────────────────────────────

  /**
   * 历史记录页统计图数据源。按窗口读取 CardUsageHourly 小时聚合:
   *   - points:   时间序列(days=1 → 24 个整点桶;7/30 → 按日历日分桶,含当天)
   *   - byModel:  各模型 Token 总量(降序)
   *   - status:   成功 / 失败(2xx vs 其余)请求数
   *   - totals:   窗口内 input/output/total/requests 合计
   */
  async getUsageStats(customerId: string, opts: { days?: number }) {
    const days = [1, 7, 30].includes(opts.days ?? 0) ? (opts.days ?? 7) : 7;
    const granularity: "hour" | "day" = days === 1 ? "hour" : "day";
    const stepMs = granularity === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const bucketCount = granularity === "hour" ? 24 : days;

    // 桶对齐:hour → 当前整点向前 24 个;day → 本地零点向前 days 天(含当天)。
    const anchor = new Date();
    if (granularity === "hour") anchor.setMinutes(0, 0, 0);
    else anchor.setHours(0, 0, 0, 0);
    const since = new Date(anchor.getTime() - (bucketCount - 1) * stepMs);

    // 读小时聚合(行数与请求次数脱钩);每行已是某小时的合计 + requests/failedRequests。
    // hour 粒度(days=1)每行恰好落一个桶;day 粒度按 hourStart 所属本地日归桶。
    const rows = await this.prisma.cardUsageHourly.findMany({
      where: { customerId, hourStart: { gte: since } },
      orderBy: { hourStart: "asc" },
      select: {
        hourStart: true,
        modelKey: true,
        bucket: true,
        requests: true,
        failedRequests: true,
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        cacheCreationTokens: true,
        cacheWrite5mTokens: true,
        cacheWrite1hTokens: true,
        apiValueUsd: true,
        apiPricedRequests: true,
        priorityTokens: true,
        totalTokens: true,
      },
    });

    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
      start: new Date(since.getTime() + i * stepMs),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requests: 0,
    }));

    const byModel = new Map<
      string,
      { totalTokens: number; requests: number; inputTokens: number; outputTokens: number; cachedTokens: number; savedUSD: number }
    >();
    const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, savedUSD: 0 };
    let success = 0;
    let failed = 0;

    for (const r of rows) {
      const input = Number(r.inputTokens) || 0;
      const output = Number(r.outputTokens) || 0;
      const total = Number(r.totalTokens) || 0;
      const reqs = Number(r.requests) || 0;
      const fails = Number(r.failedRequests) || 0;

      const idx = Math.min(
        bucketCount - 1,
        Math.max(0, Math.floor((r.hourStart.getTime() - since.getTime()) / stepMs)),
      );
      const b = buckets[idx];
      const netInput = netInputForRow(r);
      b.inputTokens += netInput;
      b.outputTokens += output;
      b.totalTokens += total;
      b.requests += reqs;

      const cached = Number(r.cachedInputTokens) || 0;
      const cacheCreation = cacheWriteForRow(r);
      const m = byModel.get(r.modelKey) ?? { totalTokens: 0, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, savedUSD: 0 };
      m.totalTokens += total;
      m.requests += reqs;
      m.inputTokens += netInput;
      m.outputTokens += output;
      m.cachedTokens += cached;
      // per-model 成本对齐客户端 estimateOfficialCostUSD(净输入 + 缓存读 + 缓存写)。
      m.savedUSD += modelAwareCostForRow(r, netInput, output, cached, cacheCreation);
      byModel.set(r.modelKey, m);

      success += reqs - fails;
      failed += fails;

      totals.inputTokens += netInput;
      totals.outputTokens += output;
      totals.totalTokens += total;
      totals.requests += reqs;
      totals.savedUSD += modelAwareCostForRow(r, netInput, output, cached, cacheCreation);
    }

    // 浮点累加去噪:保留到分以下 4 位,前端按 toFixed(2) 展示。
    totals.savedUSD = Math.round(totals.savedUSD * 10_000) / 10_000;

    return {
      granularity,
      points: buckets.map((b) => ({
        label: formatBucketLabel(b.start, granularity),
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        totalTokens: b.totalTokens,
        requests: b.requests,
      })),
      byModel: [...byModel.entries()]
        .map(([modelKey, v]) => ({
          modelKey,
          totalTokens: v.totalTokens,
          requests: v.requests,
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
          cachedTokens: v.cachedTokens,
          estimatedUSD: Math.round(v.savedUSD * 10_000) / 10_000,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
      status: { success, failed },
      totals,
    };
  }

  /** Desktop dashboard source of truth. Values are aggregated by authenticated
   * customer, so switching devices/accounts cannot inherit another local file. */
  async getClientUsageSummary(customerId: string) {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const historyStart = new Date(todayStart);
    historyStart.setDate(historyStart.getDate() - 29);
    const [rows, frozenAggregate, unpricedRows] = await Promise.all([
      this.prisma.cardUsageHourly.findMany({
        where: { customerId, hourStart: { gte: historyStart } },
        orderBy: { hourStart: "asc" },
      }),
      // New requests freeze their exact occurrence-time API value. Sum that
      // scalar in SQLite instead of loading a customer's permanent history into
      // Node on every heartbeat.
      this.prisma.cardUsageHourly.aggregate({
        where: { customerId },
        _sum: { apiValueUsd: true },
      }),
      // Only pre-rollout or mixed deployment rows still need token-based
      // estimation. This set is bounded: newly written rows are fully priced.
      this.prisma.$queryRaw<any[]>`
        SELECT
          "bucket", "modelKey", "hourStart", "requests",
          "inputTokens", "outputTokens", "cachedInputTokens",
          "cacheCreationTokens", "cacheWrite5mTokens", "cacheWrite1hTokens",
          "priorityTokens", "apiValueUsd", "apiPricedRequests"
        FROM "CardUsageHourly"
        WHERE "customerId" = ${customerId}
          AND "apiPricedRequests" < "requests"
      `,
    ]);
    const apiValue = (r: any) => {
      const input = netInputForRow(r);
      const cached = Number(r.cachedInputTokens) || 0;
      const write = cacheWriteForRow(r);
      return modelAwareCostForRow(r, input, Number(r.outputTokens) || 0, cached, write);
    };
    const blank = (date = "") => ({
      date, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
      billableTokens: 0, requests: 0, errors: 0, generations: 0, retries: 0,
      savedMoneyUSD: 0, byModel: {} as Record<string, any>,
    });
    const daily = new Map<string, ReturnType<typeof blank>>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(historyStart); d.setDate(d.getDate() + i);
      const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      daily.set(key, blank(key));
    }
    const hourly = Array.from({ length: 24 }, (_, hour) => ({
      hour: pad2(hour), inputTokens: 0, outputTokens: 0, cachedTokens: 0,
      cacheWriteTokens: 0, byModel: {} as Record<string, any>,
    }));
    for (const r of rows) {
      const local = r.hourStart as Date;
      const key = `${local.getFullYear()}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`;
      const day = daily.get(key); if (!day) continue;
      const input = netInputForRow(r);
      const cached = Number(r.cachedInputTokens) || 0;
      const write = cacheWriteForRow(r);
      const output = Number(r.outputTokens) || 0;
      const reqs = Number(r.requests) || 0;
      const fails = Number(r.failedRequests) || 0;
      const value = apiValue(r);
      day.inputTokens += input; day.outputTokens += output; day.cachedTokens += cached;
      day.cacheWriteTokens += write; day.billableTokens += Number(r.totalTokens) || 0;
      day.requests += reqs; day.errors += fails; day.generations += Math.max(0, reqs - fails); day.savedMoneyUSD += value;
      const modelKey = String(r.modelKey || "unknown");
      const m = day.byModel[modelKey] || { modelKey, displayName: modelKey, family: "", requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, estimatedCostUSD: 0, fastTokens: 0, pricingVersion: "server-frozen", pricingMode: "mixed", pricingQuality: "exact" };
      m.requests += reqs; m.inputTokens += input; m.outputTokens += output; m.cachedTokens += cached; m.cacheWriteTokens += write;
      m.totalTokens += input + output + cached + write; m.estimatedCostUSD += value; m.fastTokens += Number(r.priorityTokens) || 0;
      day.byModel[modelKey] = m;
      if (local >= todayStart) {
        const h = hourly[local.getHours()];
        h.inputTokens += input; h.outputTokens += output; h.cachedTokens += cached; h.cacheWriteTokens += write;
      }
    }
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    for (const day of daily.values()) {
      day.savedMoneyUSD = round(day.savedMoneyUSD);
      for (const m of Object.values(day.byModel)) m.estimatedCostUSD = round(m.estimatedCostUSD);
    }
    const todayKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    return {
      today: daily.get(todayKey) || blank(todayKey),
      dailyHistory: [...daily.values()],
      hourlyHistory: hourly,
      chartMode: rows.some((r: any) => r.hourStart < todayStart) ? "daily" : "hourly",
      cumulativeSaving: round(
        Math.max(0, Number(frozenAggregate._sum.apiValueUsd) || 0)
        + unpricedRows.reduce((sum: number, row: any) => {
          // apiValue(row) includes the row's frozen portion. It is already in
          // frozenAggregate, so add only the estimated unpriced remainder.
          const frozen = Math.max(0, Number(row.apiValueUsd) || 0);
          return sum + Math.max(0, apiValue(row) - frozen);
        }, 0),
      ),
      source: "CardUsageHourly",
    };
  }
}
