/**
 * order-expiry.service.ts — cron job that marks PENDING PlanOrders as EXPIRED
 * when their expiresAt has passed.
 *
 * Runs every 5 minutes. Guarded against concurrent runs by a simple in-flight
 * flag — if a previous run is still in progress it is skipped.
 */
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class OrderExpiryService {
  private readonly logger = new Logger(OrderExpiryService.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async expirePendingOrders(): Promise<void> {
    if (this.running) {
      this.logger.debug("[order-expiry] skipping: previous run still in progress");
      return;
    }
    this.running = true;
    try {
      const result = await this.prisma.planOrder.updateMany({
        where: {
          status: "PENDING",
          expiresAt: { lt: new Date() },
        },
        data: { status: "EXPIRED" },
      });
      if (result.count > 0) {
        this.logger.log(`[order-expiry] expired ${result.count} pending order(s)`);
      }
    } catch (err: any) {
      this.logger.error(`[order-expiry] cron failed: ${err?.message || err}`);
    } finally {
      this.running = false;
    }
  }
}
