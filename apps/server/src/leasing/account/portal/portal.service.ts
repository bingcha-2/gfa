import { Inject, Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import type { AccessKeyStore } from "../../token-server/access-key-store";

/** Fallback quota for a subscription whose shadow record doesn't exist in the store. */
const UNLIMITED_QUOTA = {
  quotaMode: "unlimited" as const,
  buckets: [],
  recentWindowTokens: 0,
  tokenWindowResetMs: null as number | null,
  weeklyTokenLimit: null as number | null,
  weeklyWindowResetMs: null as number | null,
  weeklyWindowTokens: 0,
  totalTokensUsed: 0,
};

/**
 * 与前端 usage 表 isSuccessStatus 同义:status 是 HTTP 码(200/429…),
 * 旧数据可能是字符串。2xx → 成功,其余(含 0/未知)→ 失败。
 */
function isSuccessStatus(status: number | string): boolean {
  const n = Number(status);
  if (Number.isFinite(n) && n > 0) return n >= 200 && n < 300;
  const s = String(status).toLowerCase();
  return s === "success" || s === "ok";
}

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
 * 节省金额算法与客户端 UsageStatsStore.AddTokens 一致:
 *   savedUSD += 净输入/1e6 * inPerM + 输出/1e6 * outPerM(不含缓存)。
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

/** 累计节省(不含缓存)—— 与客户端 UsageStatsStore.AddTokens 的 SavedMoneyUSD 同口径。勿动。 */
function savedUSDFor(bucket: string, input: number, output: number): number {
  const p = FAMILY_PRICING[familyOfBucket(bucket)] ?? FAMILY_PRICING.gemini;
  return (input / 1_000_000) * p.inPerM + (output / 1_000_000) * p.outPerM;
}

/**
 * 按模型「官方 API 价估算」—— 与客户端 estimateOfficialCostUSD 同一算法(含缓存读/写)。
 * 注:服务端 CardTokenUsage 未单独记录缓存写,故 cacheWrite 入参恒为 0;其余口径一致。
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

function mapQuota(status: any): typeof UNLIMITED_QUOTA {
  if (!status) return UNLIMITED_QUOTA;

  // Sum weekly bucket used values to get current weekly window consumption.
  // publicStatus exposes weeklyBuckets:[{bucket,used,limit}] when weeklyTokenLimit>0.
  const weeklyBuckets: Array<{ bucket: string; used: number; limit: number }> =
    Array.isArray(status.weeklyBuckets) ? status.weeklyBuckets : [];
  const weeklyWindowTokens = weeklyBuckets.reduce((sum, b) => sum + (Number(b.used) || 0), 0);

  return {
    quotaMode: status.quotaMode ?? "unlimited",
    buckets: Array.isArray(status.buckets) ? status.buckets : [],
    recentWindowTokens: Number(status.recentWindowTokens ?? 0),
    tokenWindowResetMs: status.tokenWindowResetMs != null ? Number(status.tokenWindowResetMs) : null,
    weeklyTokenLimit: status.weeklyTokenLimit != null && Number(status.weeklyTokenLimit) > 0
      ? Number(status.weeklyTokenLimit)
      : null,
    weeklyWindowResetMs: status.weeklyWindowResetMs != null && Number(status.weeklyWindowResetMs) > 0
      ? Number(status.weeklyWindowResetMs)
      : null,
    weeklyWindowTokens,
    totalTokensUsed: Number(status.totalTokensUsed ?? 0),
  };
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
      const record = this.store.findById(sub.id);
      const status = record ? this.store.publicStatus(record) : null;
      const quota = mapQuota(status);

      let productEntitlements: string[] = [];
      try {
        productEntitlements = JSON.parse(sub.productEntitlements) as string[];
      } catch {
        productEntitlements = [];
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
    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { priority: Math.max(0, Math.floor(Number(priority) || 0)) },
    });
    const overview = await this.getOverview(customerId);
    return { ok: true, subscriptions: overview.subscriptions };
  }

  // ── Usage history (paginated) ───────────────────────────────────────────────

  async getUsage(
    customerId: string,
    opts: { page?: number; pageSize?: number; days?: number },
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const days = [1, 7, 30].includes(opts.days ?? 0) ? (opts.days ?? 7) : 7;

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const where = {
      customerId,
      timestamp: { gte: since },
    };

    const [records, total] = await Promise.all([
      this.prisma.cardTokenUsage.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          timestamp: true,
          modelKey: true,
          bucket: true,
          status: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
        },
      }),
      this.prisma.cardTokenUsage.count({ where }),
    ]);

    return {
      records: records.map((r) => ({
        id: r.id,
        timestamp: r.timestamp.toISOString(),
        modelKey: r.modelKey,
        bucket: r.bucket,
        status: r.status,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        totalTokens: r.totalTokens,
      })),
      total,
      page,
      pageSize,
    };
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

    const rows = await this.prisma.cardTokenUsage.findMany({
      where: { customerId, timestamp: { gte: since } },
      orderBy: { timestamp: "asc" },
      take: 100_000,
      select: {
        timestamp: true,
        modelKey: true,
        bucket: true,
        status: true,
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
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

      const idx = Math.min(
        bucketCount - 1,
        Math.max(0, Math.floor((r.timestamp.getTime() - since.getTime()) / stepMs)),
      );
      const b = buckets[idx];
      b.inputTokens += input;
      b.outputTokens += output;
      b.totalTokens += total;
      b.requests += 1;

      const cached = Number(r.cachedInputTokens) || 0;
      const m = byModel.get(r.modelKey) ?? { totalTokens: 0, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, savedUSD: 0 };
      m.totalTokens += total;
      m.requests += 1;
      m.inputTokens += input;
      m.outputTokens += output;
      m.cachedTokens += cached;
      // per-model 成本对齐客户端 estimateOfficialCostUSD(含缓存读;服务端无缓存写→0)。
      m.savedUSD += officialCostFor(r.bucket, input, output, cached, 0);
      byModel.set(r.modelKey, m);

      if (isSuccessStatus(r.status)) success += 1;
      else failed += 1;

      totals.inputTokens += input;
      totals.outputTokens += output;
      totals.totalTokens += total;
      totals.requests += 1;
      totals.savedUSD += savedUSDFor(r.bucket, input, output);
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
