import { Inject, Injectable, NotFoundException } from "@nestjs/common";

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
  quotaMode: "static" | "dynamic" | "unlimited";
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
 * ⚠️ 服务端 CardUsageHourly.inputTokens 是 **gross**(= 净输入 + 缓存读 + 缓存写,见
 *    normalizeUsageToGross);缓存读/写分别落在 cachedInputTokens / cacheCreationTokens 列。
 *    故计 USD 前必须先还原 netInput = gross − 缓存读 − 缓存写,缓存读/写各按自己单价计。
 *    直接拿 gross 算会把缓存读按满额 input 单价计(10× 偏高)。
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
   * 历史记录页统计图数据源。按窗口聚合 cardTokenUsage:
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
      take: 100_000,
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
      b.inputTokens += input;
      b.outputTokens += output;
      b.totalTokens += total;
      b.requests += reqs;

      const cached = Number(r.cachedInputTokens) || 0;
      const cacheCreation = Number(r.cacheCreationTokens) || 0;
      // stored input 是 gross(= 净输入 + 缓存读 + 缓存写);计 USD 先还原净输入,缓存读/写各按自己单价计。
      const netInput = Math.max(0, input - cached - cacheCreation);
      const m = byModel.get(r.modelKey) ?? { totalTokens: 0, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, savedUSD: 0 };
      m.totalTokens += total;
      m.requests += reqs;
      m.inputTokens += input;
      m.outputTokens += output;
      m.cachedTokens += cached;
      // per-model 成本对齐客户端 estimateOfficialCostUSD(净输入 + 缓存读 + 缓存写)。
      m.savedUSD += officialCostFor(r.bucket, netInput, output, cached, cacheCreation);
      byModel.set(r.modelKey, m);

      success += reqs - fails;
      failed += fails;

      totals.inputTokens += input;
      totals.outputTokens += output;
      totals.totalTokens += total;
      totals.requests += reqs;
      totals.savedUSD += officialCostFor(r.bucket, netInput, output, cached, cacheCreation);
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
}
