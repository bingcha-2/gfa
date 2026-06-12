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
 * Idempotency (exact since M13a/M13b):
 *   Subscription.activatedFromOrderId records the order that created or last
 *   extended a subscription — activateOrExtend persists it on BOTH paths, and
 *   every order-driven activation (epay callback Phase 2, this cron) passes
 *   the orderId. That makes disambiguation exact:
 *
 *     1. Some subscription has activatedFromOrderId == order.id
 *          → activation for THIS order already happened (whatever the sub's
 *            current status — a later refund/revoke doesn't un-happen it);
 *            ONLY the linkage failed. Set order.subscriptionId, DO NOT
 *            re-activate (re-activating would extend by another durationDays
 *            — a free month).
 *     2. Otherwise, LEGACY fallback for activations that predate the link
 *        column: an ACTIVE (customerId, planId) sub touched at/after paidAt
 *        AND carrying NO order link at all (activatedFromOrderId null). A sub
 *        linked to a DIFFERENT order is deliberately NOT evidence for this
 *        one — that was the old heuristic's false positive (the stranded
 *        order got "re-linked" to a same-plan sub it never paid for, and the
 *        customer's purchase silently evaporated).
 *     3. No evidence at all → activation never durably ran. Call
 *        activateOrExtend (which syncs the shadow record), then link.
 *
 *   Known residual edge (errs in the CUSTOMER's favor, accepted): order O1
 *   activates a sub but its linkage write fails; before the cron runs, the
 *   customer buys O2 for the same plan, moving activatedFromOrderId to O2.
 *   O1 then matches neither rule 1 nor 2 and is re-activated — an extra
 *   extension for an order the customer DID pay. The alternative (treating a
 *   later-order link as evidence) would swallow genuinely-unactivated orders,
 *   which is the worse failure.
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

import { PrismaService } from "../../../shared/prisma/prisma.service";
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
    planId: string | null;
    config: string | null;
    catalogVersion: number | null;
    paidAt: Date | null;
  }): Promise<void> {
    if (!order.paidAt) {
      // Shouldn't happen given the query filter, but guard anyway.
      this.logger.warn(`[billing-reconcile] order ${order.id} has no paidAt — skipping`);
      return;
    }

    // 1) EXACT evidence: a subscription that recorded THIS order as its
    //    activator (activatedFromOrderId, set by activateOrExtend on both the
    //    create and extend paths). Authoritative regardless of sub status.
    const exact = await this.prisma.subscription.findFirst({
      where: { activatedFromOrderId: order.id },
    });
    if (exact) {
      await this.prisma.planOrder.update({
        where: { id: order.id },
        data: { subscriptionId: exact.id },
      });
      this.logger.log(
        `[billing-reconcile] order ${order.id}: re-linked to subscription ${exact.id} via activatedFromOrderId (activation had already run; no re-extend)`,
      );
      return;
    }

    // 2) LEGACY fallback — pre-link-column activations only: an ACTIVE
    //    (customer, plan) sub touched at/after paidAt that carries NO order
    //    link at all. Subs linked to a DIFFERENT order are NOT evidence for
    //    this one (see module doc). Catalog orders (planId null) post-date the
    //    link column entirely, so this heuristic never applies to them.
    const legacy = order.planId
      ? await this.prisma.subscription.findFirst({
          where: {
            customerId: order.customerId,
            planId: order.planId,
            status: "ACTIVE",
            updatedAt: { gte: order.paidAt },
            activatedFromOrderId: null,
          },
          orderBy: { updatedAt: "desc" },
        })
      : null;
    if (legacy) {
      await this.prisma.planOrder.update({
        where: { id: order.id },
        data: { subscriptionId: legacy.id },
      });
      this.logger.log(
        `[billing-reconcile] order ${order.id}: re-linked to pre-link-column subscription ${legacy.id} (legacy heuristic; no re-extend)`,
      );
      return;
    }

    // 3) No activation evidence → drive it now, then link. activateForOrder
    //    branches on plan vs catalog (config snapshot) internally.
    const sub = await this.subscriptionService.activateForOrder(order);
    await this.prisma.planOrder.update({
      where: { id: order.id },
      data: { subscriptionId: sub.id },
    });
    this.logger.log(`[billing-reconcile] order ${order.id}: activated subscription ${sub.id} and linked`);
  }
}
