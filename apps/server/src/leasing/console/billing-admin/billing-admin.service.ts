/**
 * billing-admin.service.ts — console-side subscription billing mutations:
 * refund a paid PlanOrder and revoke a Subscription.
 *
 * Refund flow: (1) call the epay gateway refund API to actually return the money
 * to the customer (BillingService.refundEpayOrder); only on gateway success do we
 * (2) flip order → REFUNDED, (3) cancel the linked subscription + expire its shadow
 * record, (4) notify the customer. Money first, state second — a gateway failure
 * leaves the order PAID (no false "refunded" state). GRANT / ¥0 orders skip the
 * gateway (no real payment) and only do the internal flip.
 *
 * Idempotency: refunding an already-REFUNDED order and revoking an
 * already-CANCELLED subscription are no-op successes (no duplicate
 * notification, no second shadow-record write).
 */
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PlanOrder, Subscription } from "@prisma/client";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { SubscriptionService } from "../../subscription/subscription.service";
import { EntitlementSyncService } from "../../subscription/entitlement-sync.service";
import { rowToConfig } from "../../subscription/subscription-config";
import { SUBSCRIPTION_USD_MIGRATION_VERSION } from "../../subscription/subscription-usd-migration";
import { BillingService } from "../../account/billing/billing.service";
import { supportsApiUsdProduct } from "../../token-server/api-usd-quota";

export interface RefundResult {
  order: PlanOrder;
  alreadyRefunded: boolean;
  /** Subscription id cancelled as part of this refund (null when the order
   * never activated one, or it was already terminal). */
  cancelledSubscriptionId: string | null;
}

export interface RevokeResult {
  subscription: Subscription;
  alreadyCancelled: boolean;
}

export interface UpdateSubscriptionResult {
  subscription: Subscription;
  previousExpiresAt: Date | null;
  previousDeviceLimit: number;
  previousUsdQuotaByProduct: Record<string, { fiveHour: number; weekly: number }>;
}

/**
 * Console subscription reads must stay deliberately narrow. In particular,
 * never select `windowState` (a potentially multi-megabyte runtime snapshot)
 * or `backingKeyValue` (an opaque credential) for browser-facing responses.
 */
const CONSOLE_SUBSCRIPTION_SELECT = {
  id: true,
  customerId: true,
  status: true,
  startsAt: true,
  expiresAt: true,
  config: true,
  productEntitlements: true,
  bucketLimits: true,
  bindings: true,
  levels: true,
  weight: true,
  deviceLimit: true,
  weeklyTokenLimit: true,
  windowMs: true,
  createdAt: true,
  customer: { select: { email: true } },
} satisfies Prisma.SubscriptionSelect;

@Injectable()
export class BillingAdminService {
  private readonly logger = new Logger(BillingAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionService: SubscriptionService,
    private readonly billing: BillingService,
    private readonly entitlementSync: EntitlementSyncService,
  ) {}

  /** 换绑/加绑:把某订阅在某产品上的绑定切到指定上游号。失败抛 400(供前端展示文案)。 */
  async rebindSubscription(id: string, product: string, accountId: number, force: boolean) {
    const result = await this.entitlementSync.rebindProduct(id, String(product), Number(accountId), { force });
    if (!result.ok) throw new ConflictException({ error: "REBIND_FAILED", message: result.error });
    return result;
  }

  async resetBoundAccountQuotas(product: string, accountId: number) {
    if (product !== "codex" && product !== "anthropic") throw new ConflictException(`Product ${product} does not support account quota reset`);
    return this.entitlementSync.resetBoundAccountUsdQuotas(product, Number(accountId));
  }

  async rebindBoundAccountSubscriptions(product: string, accountId: number, force: boolean) {
    if (product !== "codex" && product !== "anthropic") throw new ConflictException(`Product ${product} does not support account rebinding`);
    const result = await this.entitlementSync.rebindBoundAccountSubscriptions(product, Number(accountId), { force });
    if (!result.ok) throw new ConflictException({ error: "ACCOUNT_REBIND_FAILED", message: result.error });
    return result;
  }

  async upgradeSubscriptionSeats(subscriptionId: string, shareSeats: number) {
    const result = await this.entitlementSync.upgradeSubscriptionSeats(subscriptionId, Number(shareSeats));
    if (!result.ok) {
      throw new ConflictException({ error: "SEAT_UPGRADE_FAILED", message: result.error });
    }
    return result;
  }

  /**
   * Admin plan-order list: paginated, filterable by status/payChannel and
   * searchable by outTradeNo or customer email. Joins plan name + customer
   * email for display.
   */
  async listOrders(params: {
    page: number;
    pageSize: number;
    status?: string;
    payChannel?: string;
    search?: string;
  }) {
    const page = Number.isFinite(params.page) ? Math.max(1, Math.floor(params.page)) : 1;
    const pageSize = Number.isFinite(params.pageSize)
      ? Math.min(100, Math.max(1, Math.floor(params.pageSize)))
      : 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.PlanOrderWhereInput = {};
    const status = params.status?.trim();
    if (status) where.status = status as Prisma.PlanOrderWhereInput["status"];
    const payChannel = params.payChannel?.trim();
    if (payChannel) where.payChannel = payChannel as Prisma.PlanOrderWhereInput["payChannel"];
    const search = params.search?.trim();
    if (search) {
      where.OR = [
        { outTradeNo: { contains: search } },
        { customer: { email: { contains: search } } },
      ];
    }

    const [orders, total] = await Promise.all([
      this.prisma.planOrder.findMany({
        where,
        include: {
          customer: { select: { email: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.planOrder.count({ where }),
    ]);

    return { orders, total, page, pageSize };
  }

  /**
   * Admin subscription list: paginated, filterable by status, searchable by
   * customer email. Joins plan name + customer email for display.
   */
  async listSubscriptions(params: {
    page: number;
    pageSize: number;
    status?: string;
    search?: string;
  }) {
    const page = Number.isFinite(params.page) ? Math.max(1, Math.floor(params.page)) : 1;
    const pageSize = Number.isFinite(params.pageSize)
      ? Math.min(100, Math.max(1, Math.floor(params.pageSize)))
      : 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.SubscriptionWhereInput = {};
    const status = params.status?.trim();
    if (status) where.status = status as Prisma.SubscriptionWhereInput["status"];
    const search = params.search?.trim();
    if (search) where.customer = { email: { contains: search } };

    const [subscriptions, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where,
        select: CONSOLE_SUBSCRIPTION_SELECT,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.subscription.count({ where }),
    ]);

    // 附带「线路」标识(号池 / 绑定)+ 绑定号详情,供后台区分订阅模式并内联展示绑定号邮箱。
    // config 空(卡迁移订阅)时 rowToConfig 回退 legacy 列推断,所以卡订阅也能正确显示为绑定模式。
    const withLine = subscriptions.map((s) => ({ ...s, ...this.subscriptionViewFields(s as any) }));

    return { subscriptions: withLine, total, page, pageSize };
  }

  /**
   * Single subscription fetch for the console detail drawer. The list is
   * paginated, so a `?sub=<id>` deep-link may target a row not on the loaded
   * page — this fetch backs that jump. Mirrors listSubscriptions' customer
   * include and line derivation.
   */
  async getSubscription(id: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id },
      select: CONSOLE_SUBSCRIPTION_SELECT,
    });
    if (!sub) throw new NotFoundException(`Subscription "${id}" not found`);
    return { ...sub, ...this.subscriptionViewFields(sub as any) };
  }

  /**
   * 把一行订阅解析成后台展示用的「线路 + 绑定号详情」。config 空(卡迁移)时 rowToConfig
   * 回退 legacy 列;绑定线再按 bindings 的 accountId 解析每个产品的绑定号邮箱(池中已删/不存在
   * → 仅保留 id、email 为 null),供详情面板内联展示,不用跳去账号池页才知道绑的是哪个号。
   */
  private subscriptionViewFields(s: { config?: string | null } & Record<string, any>): {
    line: "bind" | "pool";
    shareSeats: number;
    usdQuotaByProduct: Record<string, { fiveHour: number; weekly: number }>;
    usdQuotaUsageByProduct: Record<string, {
      fiveHour: { used: number; limit: number; resetAt: string } | null;
      weekly: { used: number; limit: number; resetAt: string } | null;
    }>;
    boundAccounts?: Record<string, { id: number; email: string | null }>;
  } {
    const config = rowToConfig(s as any);
    const line = String(config.line || "pool") === "bind" ? "bind" : "pool";
    const shareSeats = Math.max(1, Math.floor(Number(config.shareSeats ?? config.weight ?? s.weight) || 1));
    const usdQuotaByProduct = Object.fromEntries(Object.entries(
      config.usdQuotaByProduct && typeof config.usdQuotaByProduct === "object" ? config.usdQuotaByProduct : {},
    ).map(([product, quota]: [string, any]) => [product, {
      fiveHour: displayUsdLimit(quota?.fiveHour),
      weekly: displayUsdLimit(quota?.weekly),
    }]));
    const usdQuotaUsageByProduct = this.entitlementSync.subscriptionUsdQuotaUsage?.(s.id) ?? {};
    if (line !== "bind") return { line, shareSeats, usdQuotaByProduct, usdQuotaUsageByProduct };
    const bindings = config.bindings && typeof config.bindings === "object" ? config.bindings : {};
    const boundAccounts: Record<string, { id: number; email: string | null }> = {};
    for (const [product, raw] of Object.entries(bindings)) {
      const accountId = Number(raw);
      if (!(accountId > 0)) continue;
      boundAccounts[product] = this.entitlementSync.lookupPoolAccount(product, accountId) ?? { id: accountId, email: null };
    }
    return {
      line,
      shareSeats,
      usdQuotaByProduct,
      usdQuotaUsageByProduct,
      boundAccounts: Object.keys(boundAccounts).length ? boundAccounts : undefined,
    };
  }

  /**
   * Customer-business dashboard KPIs: today's new customers, active
   * subscriptions, today's paid revenue + count, 30-day refund rate, and the
   * paid-order distribution. Catalog-only: every paid order is a 目录套餐 (no
   * Plan rows), so the distribution is a single collective bucket.
   */
  async billingStats() {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      todayNewCustomers,
      activeSubscriptions,
      todayPaidAgg,
      paidOrRefunded30,
      refunded30,
      paidOrderCount,
    ] = await Promise.all([
      this.prisma.customer.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.subscription.count({ where: { status: "ACTIVE" } }),
      this.prisma.planOrder.aggregate({
        where: { status: "PAID", paidAt: { gte: startOfToday } },
        _sum: { amountCents: true },
        _count: true,
      }),
      this.prisma.planOrder.count({
        where: { status: { in: ["PAID", "REFUNDED"] }, createdAt: { gte: thirtyDaysAgo } },
      }),
      this.prisma.planOrder.count({
        where: { status: "REFUNDED", createdAt: { gte: thirtyDaysAgo } },
      }),
      this.prisma.planOrder.count({ where: { status: "PAID" } }),
    ]);

    // Catalog-only: all paid orders are selection-driven (no Plan row) — report
    // them as one collective 目录套餐 bucket.
    const planDistribution =
      paidOrderCount > 0
        ? [{ planId: null, planName: "目录套餐", count: paidOrderCount }]
        : [];

    return {
      todayNewCustomers,
      activeSubscriptions,
      todayPaidCents: todayPaidAgg._sum.amountCents ?? 0,
      todayPaidCount: todayPaidAgg._count,
      refundRate30d: paidOrRefunded30 > 0 ? refunded30 / paidOrRefunded30 : 0,
      planDistribution,
    };
  }

  /**
   * Refund a PAID plan order: call the gateway refund API to return the money,
   * then order → REFUNDED, its subscription (if any) → CANCELLED + shadow record
   * expired, customer notified. Gateway refund runs first — on failure we throw and
   * leave the order PAID (never a "refunded" state without the money back). The
   * upstream seat is released because share accounting ignores non-active records —
   * the expired record keeps its bindings as history.
   */
  async refundOrder(orderId: string): Promise<RefundResult> {
    const order = await this.prisma.planOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException(`PlanOrder "${orderId}" not found`);

    if (order.status === "REFUNDED") {
      return { order, alreadyRefunded: true, cancelledSubscriptionId: null };
    }
    if (order.status !== "PAID") {
      throw new ConflictException(`只有已支付订单可退款（当前状态 ${order.status}）`);
    }

    // 使用检测：订单支付后如果该客户产生过 token 用量，不允许退款。
    // 查永久保留的小时聚合表 CardUsageHourly；请求级流水已经退役。
    // 下界按 paidAt 所在整点向下取整(保守：含该小时全部用量)。
    const since = order.paidAt ?? order.createdAt;
    const hourFloor = new Date(Math.floor(since.getTime() / 3_600_000) * 3_600_000);
    const usedHours = await this.prisma.cardUsageHourly.count({
      where: { customerId: order.customerId, hourStart: { gte: hourFloor } },
    });
    if (usedHours > 0) {
      throw new ConflictException(`该客户在订单支付后已产生使用记录，不可退款`);
    }

    // 实际打款:先调网关退款 API 把钱退回客户,成功(code=0)后才往下翻状态 —— 钱→状态,绝不反过来,
    // 杜绝「标了 REFUNDED 但客户没真收到钱」。网关失败 → 抛错、订单保持 PAID,运营可重试或查商户后台。
    // GRANT / ¥0 单无真实支付(管理员授予),跳过网关,只做内部状态流转。
    if (order.payChannel !== "GRANT" && order.amountCents > 0) {
      const refund = await this.billing.refundEpayOrder(order.outTradeNo, order.amountCents);
      if (!refund.ok) {
        throw new ServiceUnavailableException(`网关退款失败，订单状态未变更：${refund.msg ?? "未知错误"}`);
      }
    }

    // CAS PAID→REFUNDED: concurrent refund calls collapse to one winner; the
    // loser re-reads and reports the idempotent outcome.
    const cas = await this.prisma.planOrder.updateMany({
      where: { id: orderId, status: "PAID" },
      data: { status: "REFUNDED" },
    });
    if (cas.count !== 1) {
      const again = await this.prisma.planOrder.findUnique({ where: { id: orderId } });
      if (again?.status === "REFUNDED") {
        return { order: again, alreadyRefunded: true, cancelledSubscriptionId: null };
      }
      throw new ConflictException(`订单状态已变化，退款未执行（当前状态 ${again?.status ?? "UNKNOWN"}）`);
    }

    // TODO(known minor non-atomicity): the CAS above and the cancellation below
    // are two separate writes. If the CAS succeeds and cancelOrderSubscription
    // then throws, the order is already REFUNDED — a retried refund call returns
    // alreadyRefunded WITHOUT cancelling the subscription. Remediation: the
    // operator cancels the leftover subscription via the revoke endpoint.
    const cancelledSubscriptionId = await this.cancelOrderSubscription(order);

    // 退款回补本单抵扣的余额(现金按渠道退,余额是站内额度 → 全额还回)。CAS 赢家才到这,不会重复回补。
    if (order.creditAppliedCents > 0) {
      await this.prisma.customer.update({
        where: { id: order.customerId },
        data: { creditCents: { increment: order.creditAppliedCents } },
      });
    }
    // 回收该单触发的推广人返点(防套利);与 toC refundOwnOrder 同一口径。
    await this.billing.revokeReferralRewardForOrder(order.id);

    await this.prisma.notification.create({
      data: {
        customerId: order.customerId,
        type: "BILLING",
        title: "订单已退款",
        body: `您的订单（单号 ${order.outTradeNo}）已退款${cancelledSubscriptionId ? "，对应订阅已取消" : ""}。如有疑问请联系客服。`,
      },
    });

    this.logger.log(
      `[billing-admin] order ${orderId} refunded (customer ${order.customerId}, subscription ${cancelledSubscriptionId ?? "none"})`,
    );
    const refreshed = await this.prisma.planOrder.findUnique({ where: { id: orderId } });
    return { order: refreshed!, alreadyRefunded: false, cancelledSubscriptionId };
  }

  /**
   * Revoke a subscription: status CANCELLED + shadow record expired + customer
   * notified. The upstream seat is released because share accounting ignores
   * non-active records — the expired record keeps its bindings as history.
   */
  async revokeSubscription(subscriptionId: string): Promise<RevokeResult> {
    const sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new NotFoundException(`Subscription "${subscriptionId}" not found`);

    if (sub.status === "CANCELLED") {
      return { subscription: sub, alreadyCancelled: true };
    }

    const cancelled = await this.subscriptionService.cancelSubscription(subscriptionId);
    await this.prisma.notification.create({
      data: {
        customerId: sub.customerId,
        type: "BILLING",
        title: "订阅已取消",
        body: "您的订阅已被管理员取消。如有疑问请联系客服。",
      },
    });

    this.logger.log(`[billing-admin] subscription ${subscriptionId} revoked (customer ${sub.customerId})`);
    return { subscription: cancelled, alreadyCancelled: false };
  }

  async updateSubscription(
    subscriptionId: string,
    dto: { expiresAt?: string; deviceLimit?: number; usdQuotaPerSeatByProduct?: Record<string, { fiveHour?: number; weekly?: number }> },
  ): Promise<UpdateSubscriptionResult> {
    const sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new NotFoundException(`Subscription "${subscriptionId}" not found`);

    const config = rowToConfig(sub as any) as Record<string, any>;
    const previousUsdQuotaByProduct = structuredClone(config.usdQuotaByProduct || {});
    if (dto.deviceLimit !== undefined) {
      if (typeof dto.deviceLimit !== "number" || !Number.isInteger(dto.deviceLimit)
        || dto.deviceLimit < 1 || dto.deviceLimit > 2_147_483_647) {
        throw new ConflictException("可用设备数必须是大于等于 1 的有效整数");
      }
      config.deviceLimit = dto.deviceLimit;
    }
    if (dto.usdQuotaPerSeatByProduct !== undefined) {
      config.quotaAlgorithm = "usd";
      config.usdQuotaSource = "manual";
      config.usdQuotaMigrationVersion = SUBSCRIPTION_USD_MIGRATION_VERSION;
      const allowed = new Set((Array.isArray(config.products) ? config.products : []).map(String).filter(supportsApiUsdProduct));
      const seats = Math.max(1, Math.floor(Number(config.shareSeats ?? config.weight) || 1));
      const next: Record<string, { fiveHour: number; weekly: number }> = {};
      for (const [product, quota] of Object.entries(dto.usdQuotaPerSeatByProduct)) {
        if (!allowed.has(product)) throw new ConflictException(`产品 ${product} 不支持美元额度或不属于该订阅`);
        const fiveHour = parseUsdLimit(quota?.fiveHour ?? 0, `${product}.fiveHour`);
        const weekly = parseUsdLimit(quota?.weekly ?? 0, `${product}.weekly`);
        if (fiveHour <= 0 && weekly <= 0) throw new ConflictException(`${product} 的 5 小时和每周额度不能同时为 0`);
        next[product] = {
          fiveHour: Math.round(fiveHour * seats * 1_000_000) / 1_000_000,
          weekly: Math.round(weekly * seats * 1_000_000) / 1_000_000,
        };
      }
      if (allowed.size === 0) throw new ConflictException("该订阅没有可配置美元额度的 Codex 或 Anthropic 产品");
      const missing = [...allowed].filter((product) => !next[product]);
      if (missing.length > 0) throw new ConflictException(`缺少产品额度配置: ${missing.join(", ")}`);
      config.usdQuotaByProduct = next;
      delete config.usdLimit5h;
      delete config.usdLimitWeekly;
      delete config.usdQuotaProducts;
    }
    const expiresAt = dto.expiresAt === undefined ? sub.expiresAt : parseExpiresAt(dto.expiresAt);
    const updated = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { expiresAt, config: JSON.stringify(config), ...(dto.deviceLimit !== undefined ? { deviceLimit: dto.deviceLimit } : {}) },
    });
    try {
      await this.entitlementSync.syncSubscription(updated);
    } catch (error) {
      // The database is the source of truth, but the active in-memory record
      // must change in the same operator action. Restore both sides if runtime
      // refresh fails instead of returning an error after a half-applied edit.
      const restored = await this.prisma.subscription.update({
        where: { id: subscriptionId },
        data: { expiresAt: sub.expiresAt, config: sub.config, deviceLimit: sub.deviceLimit },
      });
      try {
        await this.entitlementSync.syncSubscription(restored);
      } catch (restoreError) {
        this.logger.error(
          `[billing-admin] failed to restore runtime subscription ${subscriptionId}: ${String(restoreError)}`,
        );
      }
      throw error;
    }

    this.logger.log(`[billing-admin] subscription ${subscriptionId} configuration updated`);
    return { subscription: updated, previousExpiresAt: sub.expiresAt, previousDeviceLimit: sub.deviceLimit, previousUsdQuotaByProduct };
  }

  async resetSubscriptionUsdQuotaUsage(
    subscriptionId: string,
    product: string,
    scope: 'fiveHour' | 'weekly',
  ) {
    const sub = await this.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new NotFoundException(`Subscription "${subscriptionId}" not found`);
    if (!supportsApiUsdProduct(product)) throw new ConflictException(`产品 ${product} 不支持美元额度`);
    if (scope !== 'fiveHour' && scope !== 'weekly') throw new ConflictException(`未知额度窗口 ${scope}`);
    const result = await this.entitlementSync.resetSubscriptionUsdQuotaUsage(subscriptionId, product, scope);
    if (!result) throw new ConflictException(`${product} 的${scope === 'fiveHour' ? ' 5 小时' : '每周'}额度未启用`);
    this.logger.warn(
      `[billing-admin] reset ${subscriptionId} ${product}.${scope} USD usage $${result.previousUsed}`,
    );
    return { ...result, subscriptionId, customerId: sub.customerId, product, scope };
  }

  /**
   * Cancel the subscription a refunded order activated. Resolved via the
   * order's subscriptionId link (or the reverse activatedFromOrderId link as a
   * fallback for orders whose linkage write failed). Already-terminal
   * (CANCELLED) and missing subscriptions are skipped — the refund itself must
   * never fail on subscription drift.
   */
  private async cancelOrderSubscription(order: PlanOrder): Promise<string | null> {
    const sub = order.subscriptionId
      ? await this.prisma.subscription.findUnique({ where: { id: order.subscriptionId } })
      : await this.prisma.subscription.findFirst({ where: { activatedFromOrderId: order.id } });
    if (!sub) {
      if (order.subscriptionId) {
        this.logger.warn(
          `[billing-admin] refund ${order.id}: linked subscription ${order.subscriptionId} not found — nothing to cancel`,
        );
      }
      return null;
    }
    if (sub.status === "CANCELLED") return null;

    // cancelSubscription = status CANCELLED + shadow record expired. The seat
    // is released by share accounting ignoring non-active records (bindings on
    // the expired record are kept as history, not cleared).
    await this.subscriptionService.cancelSubscription(sub.id);
    return sub.id;
  }

  /**
   * 主动同步单笔订单的支付状态：查 zhunfu，如已支付则激活。
   * 返回同步后的订单快照。
   */
  async syncOrderPayment(orderId: string) {
    const order = await this.prisma.planOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException(`PlanOrder "${orderId}" not found`);

    if (order.status !== "PENDING" && order.status !== "EXPIRED") {
      return { order, synced: false, message: `订单状态为 ${order.status}，无需同步` };
    }

    const synced = await this.billing.queryAndSyncEpayOrder(order.outTradeNo);
    const refreshed = synced
      ? await this.prisma.planOrder.findUnique({ where: { id: orderId } })
      : order;

    return {
      order: refreshed ?? order,
      synced,
      message: synced ? "支付已确认，订阅已激活" : "支付平台未确认付款",
    };
  }
}

function parseExpiresAt(value: string | undefined): Date {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConflictException("expiresAt is required");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ConflictException("expiresAt must be a valid date");
  }
  return date;
}

function parseUsdLimit(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConflictException(`${field} must be a non-negative finite USD amount`);
  }
  return Math.round(n * 1_000_000) / 1_000_000;
}

function displayUsdLimit(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
