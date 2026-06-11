/**
 * billing-admin.service.ts — console-side subscription billing mutations:
 * refund a paid PlanOrder and revoke a Subscription.
 *
 * Scope note: "refund" here is the INTERNAL state flip (order → REFUNDED,
 * linked subscription → CANCELLED + shadow record expired, customer notified).
 * It does NOT call the epay refund API — the operator returns the money via
 * the epay merchant console; an automated gateway refund is out of scope.
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
} from "@nestjs/common";
import type { PlanOrder, Subscription } from "@prisma/client";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { SubscriptionService } from "../../subscription/subscription.service";

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
  ) {}

  /**
   * Refund a PAID plan order: order → REFUNDED, its subscription (if any) →
   * CANCELLED + shadow record expired, customer notified. The upstream seat is
   * released because share accounting ignores non-active records — the expired
   * record keeps its bindings as history.
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
}
