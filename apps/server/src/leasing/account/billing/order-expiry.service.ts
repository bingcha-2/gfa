/**
 * order-expiry.service.ts — cron job that marks PENDING PlanOrders as EXPIRED
 * when their expiresAt has passed.
 *
 * Before expiring, each order is checked against zhunfu's query API — if the
 * payment was actually captured (user paid but callback didn't reach us), the
 * order is routed through the normal activation flow instead of being expired.
 *
 * Runs every 5 minutes. Guarded against concurrent runs by a simple in-flight
 * flag — if a previous run is still in progress it is skipped.
 */
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { BillingService } from "./billing.service";

@Injectable()
export class OrderExpiryService {
  private readonly logger = new Logger(OrderExpiryService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async expirePendingOrders(): Promise<void> {
    if (this.running) {
      this.logger.debug("[order-expiry] skipping: previous run still in progress");
      return;
    }
    this.running = true;
    try {
      const expiredOrders = await this.prisma.planOrder.findMany({
        where: {
          status: "PENDING",
          expiresAt: { lt: new Date() },
        },
        select: { id: true, outTradeNo: true },
      });

      if (expiredOrders.length === 0) return;

      // Check each order against zhunfu before expiring — don't expire
      // orders that were actually paid (callback lost/delayed).
      let expiredCount = 0;
      for (const { id, outTradeNo } of expiredOrders) {
        const synced = await this.billing.queryAndSyncEpayOrder(outTradeNo);
        if (synced) {
          this.logger.log(`[order-expiry] order ${outTradeNo} was paid on zhunfu — activated instead of expiring`);
          continue;
        }
        // voidPendingOrder:CAS PENDING→EXPIRED 并回补本单抵扣的余额(只回补一次)。
        const voided = await this.billing.voidPendingOrder(id, "EXPIRED");
        if (voided) expiredCount++;
      }

      if (expiredCount > 0) {
        this.logger.log(`[order-expiry] expired ${expiredCount} pending order(s)`);
      }
    } catch (err: any) {
      this.logger.error(`[order-expiry] cron failed: ${err?.message || err}`);
    } finally {
      this.running = false;
    }
  }
}
