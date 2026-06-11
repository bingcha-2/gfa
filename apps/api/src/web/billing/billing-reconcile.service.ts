/**
 * billing-reconcile.service.ts — recover stranded paid orders.
 *
 * Why this exists:
 *   The epay callback captures payment (order → PAID) in a fast Prisma tx, then
 *   activates the subscription OUTSIDE that tx (activation does file I/O that is
 *   too slow to hold an interactive transaction open). If that Phase-2
 *   activation throws — seat exhaustion, a transient file write error, a crash
 *   between PAID and linkage — the order is left status=PAID with
 *   subscriptionId=null and the customer is stranded with only a log line.
 *
 *   This cron finds those orders and re-drives activation IDEMPOTENTLY.
 *
 * Idempotency without a schema migration:
 *   We can't tell "activation never ran" from "activation ran but only the
 *   order.subscriptionId linkage failed" by looking at the order alone. So we
 *   disambiguate via the Subscription side:
 *
 *     Look for an ACTIVE subscription for (customerId, planId) that was created
 *     OR extended at/after order.paidAt (updatedAt >= paidAt — this catches both
 *     the create-new and the extend-existing paths, since Prisma @updatedAt
 *     bumps on the extend update too).
 *
 *       • found  → activation already happened; ONLY the linkage failed.
 *                  Just set order.subscriptionId to it. DO NOT re-activate
 *                  (re-activating would extend by another durationDays — a
 *                  free month).
 *       • none   → activation never durably ran. Call activateOrExtend (which
 *                  syncs the shadow record), then link.
 *
 * Guards:
 *   - Only orders whose paidAt is older than RECONCILE_MIN_AGE_MS are touched,
 *     so we never race the live callback's own Phase 2.
 *   - An in-flight flag prevents overlapping cron runs.
 *   - Per-order failures are logged LOUDLY and do not abort the batch; the
 *     order stays unlinked and is retried next tick (capped log volume via the
 *     natural cron cadence).
 */
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { PrismaService } from "../../prisma/prisma.service";
import { SubscriptionService } from "../../subscription/subscription.service";

/** Don't touch a PAID order until its callback's Phase 2 has had time to run. */
const RECONCILE_MIN_AGE_MS = 2 * 60 * 1000; // 2 minutes
/** Safety cap on how many stranded orders we process per tick. */
const RECONCILE_BATCH_LIMIT = 50;

@Injectable()
export class BillingReconcileService {
  private readonly logger = new Logger(BillingReconcileService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcileStrandedOrders(): Promise<void> {
    if (this.running) {
      this.logger.debug("[billing-reconcile] skipping: previous run still in progress");
      return;
    }
    this.running = true;
    try {
      const cutoff = new Date(Date.now() - RECONCILE_MIN_AGE_MS);
      const stranded = await this.prisma.planOrder.findMany({
        where: {
          status: "PAID",
          subscriptionId: null,
          paidAt: { lt: cutoff, not: null },
        },
        orderBy: { paidAt: "asc" },
        take: RECONCILE_BATCH_LIMIT,
      });

      if (stranded.length === 0) return;

      this.logger.warn(`[billing-reconcile] found ${stranded.length} stranded paid order(s) — re-driving activation`);

      for (const order of stranded) {
        await this.reconcileOne(order).catch((err: any) => {
          this.logger.error(
            `[billing-reconcile] PERMANENT-ish failure reconciling order ${order.id} (outTradeNo=${order.outTradeNo}): ${err?.message || err} — will retry next tick`,
          );
        });
      }
    } catch (err: any) {
      this.logger.error(`[billing-reconcile] cron failed: ${err?.message || err}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Reconcile a single stranded PAID order. Idempotent: never double-extends.
   * Exposed for direct invocation in tests.
   */
  async reconcileOne(order: {
    id: string;
    outTradeNo: string;
    customerId: string;
    planId: string;
    paidAt: Date | null;
  }): Promise<void> {
    if (!order.paidAt) {
      // Shouldn't happen given the query filter, but guard anyway.
      this.logger.warn(`[billing-reconcile] order ${order.id} has no paidAt — skipping`);
      return;
    }

    // Did activation already happen (only the linkage failed)?
    // An ACTIVE sub for this (customer, plan) touched at/after paidAt means yes.
    const existing = await this.prisma.subscription.findFirst({
      where: {
        customerId: order.customerId,
        planId: order.planId,
        status: "ACTIVE",
        updatedAt: { gte: order.paidAt },
      },
      orderBy: { updatedAt: "desc" },
    });

    if (existing) {
      // Linkage-only failure → re-link WITHOUT re-activating (no double-extend).
      await this.prisma.planOrder.update({
        where: { id: order.id },
        data: { subscriptionId: existing.id },
      });
      this.logger.log(
        `[billing-reconcile] order ${order.id}: re-linked to existing subscription ${existing.id} (activation had already run; no re-extend)`,
      );
      return;
    }

    // No activation evidence → drive it now, then link.
    const sub = await this.subscriptionService.activateOrExtend(
      order.customerId,
      order.planId,
      { orderId: order.id },
    );
    await this.prisma.planOrder.update({
      where: { id: order.id },
      data: { subscriptionId: sub.id },
    });
    this.logger.log(`[billing-reconcile] order ${order.id}: activated subscription ${sub.id} and linked`);
  }
}
