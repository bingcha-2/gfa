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
import { BillingService } from "../../account/billing/billing.service";

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
        include: {
          customer: { select: { email: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.subscription.count({ where }),
    ]);

    // 附带「线路」标识(号池 / 绑定),供后台区分订阅模式。config 空(卡迁移订阅)时
    // rowToConfig 回退 legacy 列推断,所以卡订阅也能正确显示为绑定模式。
    const withLine = subscriptions.map((s) => ({
      ...s,
      line: String(rowToConfig(s as any).line || "pool") === "bind" ? "bind" : "pool",
    }));

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
      include: { customer: { select: { email: true } } },
    });
    if (!sub) throw new NotFoundException(`Subscription "${id}" not found`);
    return { ...sub, line: String(rowToConfig(sub as any).line || "pool") === "bind" ? "bind" : "pool" };
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
    // 查小时聚合表(保留 ~60 天，覆盖任意订阅期)；原始流水只留 2 天、不能判老订单。
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
