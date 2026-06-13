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

    // Get the customer's subscription ids to scope usage
    const subs = await this.prisma.subscription.findMany({
      where: { customerId },
      select: { id: true },
    });
    const subIds = subs.map((s) => s.id);

    if (subIds.length === 0) {
      return { records: [], total: 0, page, pageSize };
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const where = {
      accessKeyId: { in: subIds },
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
}
