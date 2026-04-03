import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { OrderStatus } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { QUEUE_NAMES, JOB_DEFAULTS } from "@gfa/shared";

export type ExpiredOrderResult = {
  orderId: string;
  orderNo: string;
  userEmail: string;
  familyGroupId: string | null;
};

export type ScanStatus = {
  pendingCount: number;
  lastRunAt: Date | null;
  lastRunCount: number;
};

// Non-terminal statuses that qualify an order for expiry removal
const ACTIVE_STATUSES: OrderStatus[] = [
  OrderStatus.CODE_VERIFIED,
  OrderStatus.GROUP_ASSIGNED,
  OrderStatus.TASK_QUEUED,
  OrderStatus.TASK_RUNNING,
  OrderStatus.INVITE_SENT,
  OrderStatus.WAIT_USER_ACCEPT,
  OrderStatus.COMPLETED
];

@Injectable()
export class ExpireScanService {
  private readonly logger = new Logger(ExpireScanService.name);
  private lastRunAt: Date | null = null;
  private lastRunCount = 0;
  // Soft guard: prevents cron + manual-API double-scan within the same process.
  // For multi-pod safety, the CAS updateMany below is the actual race-free lock.
  private scanning = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.remove)
    private readonly removeQueue: Queue
  ) {}

  /** Hourly cron: auto-scan and remove expired orders. */
  @Cron(CronExpression.EVERY_HOUR)
  async handleCron(): Promise<void> {
    this.logger.log("Cron: scanning expired orders");
    const results = await this.scanExpiredOrders();
    this.logger.log(`Cron: processed ${results.length} expired orders`);
  }

  /**
   * Scan all orders where expiresAt <= now and status is still active.
   *
   * Multi-pod safety: each order is atomically claimed via a CAS `updateMany`
   * (status IN ACTIVE_STATUSES → EXPIRED) before Task creation. If two API
   * pods race, only the one whose `updateMany` returns count=1 proceeds.
   * BullMQ `jobId` deduplication is a secondary guard only.
   *
   * Flow per order:
   *   1. CAS: try to atomically mark status → EXPIRED (skips if already claimed)
   *   2. Create Task DB record (REMOVE_MEMBER) so worker's TaskLogger can look it up
   *   3. Enqueue remove job on family-remove-queue with taskId from step 2
   */
  async scanExpiredOrders(): Promise<ExpiredOrderResult[]> {
    if (this.scanning) {
      this.logger.warn("scanExpiredOrders: already running, skipping concurrent invocation");
      return [];
    }

    this.scanning = true;
    const now = new Date();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const candidates: any[] = await (this.prisma.order.findMany as any)({
        where: {
          expiresAt: { lte: now },
          status: { in: ACTIVE_STATUSES }
        },
        select: {
          id: true,
          orderNo: true,
          userEmail: true,
          familyGroupId: true,
          status: true,
          familyGroup: {
            select: { accountId: true }
          }
        }
      });

      const results: ExpiredOrderResult[] = [];

      for (const order of candidates) {
        try {
          // --- CAS: atomically claim this order ---
          // updateMany returns { count: N }; N=0 means another pod already claimed it.
          const claimed = await (this.prisma.order.updateMany as any)({
            where: {
              id: order.id,
              status: { in: ACTIVE_STATUSES }
            },
            data: {
              status: "EXPIRED",
              expiredAt: now,
              resultMessage: "Membership expired — member removal task queued"
            }
          });

          if (claimed.count === 0) {
            this.logger.debug(`Order ${order.id} already claimed by another pod, skipping`);
            continue;
          }

          // Only create Task + enqueue if there is a family group to remove from
          if (order.familyGroupId && order.familyGroup?.accountId) {
            const task = await this.prisma.task.create({
              data: {
                type: "REMOVE_MEMBER",
                orderId: order.id,
                familyGroupId: order.familyGroupId,
                accountId: order.familyGroup.accountId,
                source: "expire-scan",
                payload: JSON.stringify({
                  orderId: order.id,
                  familyGroupId: order.familyGroupId,
                  accountId: order.familyGroup.accountId,
                  memberEmail: order.userEmail,
                  reason: "EXPIRED"
                })
              }
            });

            await this.removeQueue.add(
              "remove-expired-member",
              {
                taskId: task.id,
                familyGroupId: order.familyGroupId,
                accountId: order.familyGroup.accountId,
                memberEmail: order.userEmail,
                orderId: order.id,
                reason: "EXPIRED"
              },
              {
                ...JOB_DEFAULTS,
                // Secondary deduplication guard
                jobId: `expire-${order.id}`,
              }
            );
          }

          results.push({
            orderId: order.id,
            orderNo: order.orderNo,
            userEmail: order.userEmail,
            familyGroupId: order.familyGroupId
          });
        } catch (err) {
          this.logger.error(`Failed to expire order ${order.id}: ${String(err)}`);
        }
      }

      this.lastRunAt = now;
      this.lastRunCount = results.length;

      // --- Phase 2: Scan FamilyMember-level expiry (direct member expiresAt) ---
      // These are members invited via console batch ops that don't have an Order record.
      try {
        const expiredMembers = await this.prisma.familyMember.findMany({
          where: {
            expiresAt: { lte: now },
            status: { in: ["ACTIVE", "PENDING"] },
          },
          select: {
            id: true,
            email: true,
            familyGroupId: true,
            familyGroup: { select: { accountId: true } },
          },
        });

        for (const member of expiredMembers) {
          try {
            if (!member.familyGroup?.accountId) continue;

            // Skip if a pending/running/failed removal task already exists for this member.
            // Including FAILED_RETRYABLE and MANUAL_REVIEW prevents creating orphan Task
            // records that can never enter the queue (BullMQ dedup on old jobId).
            const existingTask = await this.prisma.task.findFirst({
              where: {
                type: "REMOVE_MEMBER",
                familyGroupId: member.familyGroupId,
                status: { in: ["PENDING", "RUNNING", "FAILED_RETRYABLE", "MANUAL_REVIEW"] },
                payload: { contains: member.email },
              },
            });
            if (existingTask) continue;

            const task = await this.prisma.task.create({
              data: {
                type: "REMOVE_MEMBER",
                familyGroupId: member.familyGroupId,
                accountId: member.familyGroup.accountId,
                source: "expire-scan",
                payload: JSON.stringify({
                  familyGroupId: member.familyGroupId,
                  accountId: member.familyGroup.accountId,
                  memberEmail: member.email,
                  reason: "MEMBER_EXPIRED",
                }),
              },
            });

            await this.removeQueue.add(
              "remove-expired-member",
              {
                taskId: task.id,
                familyGroupId: member.familyGroupId,
                accountId: member.familyGroup.accountId,
                memberEmail: member.email,
                reason: "MEMBER_EXPIRED",
              },
              {
                ...JOB_DEFAULTS,
                jobId: `member-expire-${member.id}-${task.id}`,
              }
            );

            this.lastRunCount++;
          } catch (err) {
            this.logger.error(`Failed to expire member ${member.id}: ${String(err)}`);
          }
        }

        this.logger.log(`Phase 2: processed ${expiredMembers.length} expired member(s), queued removal tasks`);
      } catch (err) {
        this.logger.error(`Phase 2 member expiry scan failed: ${String(err)}`);
      }

      return results;
    } finally {
      this.scanning = false;
    }
  }

  /** Return current scan statistics for the admin API. */
  async getStatus(): Promise<ScanStatus> {
    const pendingCount = await (this.prisma.order.count as any)({
      where: {
        expiresAt: { lte: new Date() },
        status: { in: ACTIVE_STATUSES }
      }
    });

    return {
      pendingCount,
      lastRunAt: this.lastRunAt,
      lastRunCount: this.lastRunCount
    };
  }
}
