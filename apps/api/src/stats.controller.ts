import { Controller, Get, Query as QueryParam } from "@nestjs/common";
import { Roles } from "./auth/roles.decorator";
import { PrismaService } from "./prisma/prisma.service";

@Controller("stats")
export class StatsController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /stats/daily?date=YYYY-MM-DD
   * Returns daily operational metrics for the specified date (defaults to today).
   */
  @Get("daily")
  @Roles("ADMIN", "OPERATIONS", "SUPPORT")
  async getDailyStats(@QueryParam("date") dateStr?: string) {
    // Parse the target date — default to today (server local time, UTC+8)
    const now = new Date();
    let year: number, month: number, day: number;

    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const parts = dateStr.split("-").map(Number);
      year = parts[0];
      month = parts[1] - 1;
      day = parts[2];
    } else {
      // Use UTC+8 for "today"
      const offset = now.getTime() + 8 * 60 * 60 * 1000;
      const local = new Date(offset);
      year = local.getUTCFullYear();
      month = local.getUTCMonth();
      day = local.getUTCDate();
    }

    // Build day range in UTC+8 → convert to UTC for queries.
    // Use Date.UTC() (always UTC, never affected by server local TZ) to avoid
    // a double-offset bug when the server runs in UTC+8: new Date(y,m,d) would
    // interpret the args as local time (UTC+8 midnight = 16:00 UTC-prev-day),
    // and subtracting another 8 h shifts the window 8 h too early.
    const gte = new Date(Date.UTC(year, month, day,     0, 0, 0) - 8 * 60 * 60 * 1000);
    const lt  = new Date(Date.UTC(year, month, day + 1, 0, 0, 0) - 8 * 60 * 60 * 1000);

    const [
      importedAccounts,
      suspendedAccounts,
      verificationAccounts,
      transferredMembersAgg,
      redeemInvites,
      consoleInvites,
    ] = await Promise.all([
      // 1. Accounts imported today
      this.prisma.account.count({
        where: { createdAt: { gte, lt } },
      }),
      // 2. Accounts whose subscription was suspended today
      this.prisma.account.count({
        where: {
          subscriptionStatus: "SUSPENDED",
          subscriptionStatusUpdatedAt: { gte, lt },
        },
      }),
      // 3. Accounts that require verification (Phone or CAPTCHA) updated today
      this.prisma.account.count({
        where: {
          OR: [
            { status: "VERIFICATION_REQUIRED" },
            { syncError: "CAPTCHA_REQUIRED" },
          ],
          updatedAt: { gte, lt },
        },
      }),
      // 4. Members transferred today (sum of totalMembers in TransferBatch)
      this.prisma.transferBatch.aggregate({
        _sum: { totalMembers: true },
        where: { createdAt: { gte, lt } },
      }),
      // 5. Redeem-code (卡密) invite orders today
      // NOTE: all JOIN orders originate from redeem codes, so orderType alone
      // is sufficient. Previously we also required redeemCodeId != null, but
      // deleting a RedeemCode sets Order.redeemCodeId to NULL (onDelete: SetNull),
      // which caused the count to drop unexpectedly.
      this.prisma.order.count({
        where: {
          orderType: "JOIN",
          createdAt: { gte, lt },
        },
      }),
      // 6. Console (manual) invites today — INVITE_MEMBER tasks with no order and no transfer batch
      this.prisma.task.count({
        where: {
          type: "INVITE_MEMBER",
          orderId: null,
          transferBatchId: null,
          createdAt: { gte, lt },
        },
      }),
    ]);

    const dateLabel = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    return {
      date: dateLabel,
      importedAccounts,
      suspendedAccounts,
      verificationAccounts,
      transferredMembers: transferredMembersAgg._sum.totalMembers ?? 0,
      redeemInvites,
      consoleInvites,
    };
  }

  @Get()
  @Roles("ADMIN", "OPERATIONS", "SUPPORT")
  async getOverviewStats() {
    const [
      availableSlotsSum,
      pendingInvitesSum,
      manualReviewTasks,
      disabledAccounts,
      activeOrders,
      unusedCodes,
      recentOrders,
      reviewQueue,
      totalAccounts,
      totalGroups,
      totalOrders,
      expiredOrders
    ] = await Promise.all([
      // availableSlots Sum for active/healthy groups
      this.prisma.familyGroup.aggregate({
        _sum: { availableSlots: true },
        where: {
          status: "ACTIVE",
          account: {
            status: "HEALTHY",
            subscriptionStatus: { not: "SUSPENDED" }
          }
        }
      }).then(r => r._sum.availableSlots ?? 0),
      // pendingInviteCount sum
      this.prisma.familyGroup.aggregate({
        _sum: { pendingInviteCount: true }
      }).then(r => r._sum.pendingInviteCount ?? 0),
      // manual review tasks
      this.prisma.task.count({ where: { status: "MANUAL_REVIEW" } }),
      // disabled accounts
      this.prisma.account.count({ where: { status: { not: "HEALTHY" } } }),
      // active orders (not in terminal states)
      this.prisma.order.count({
        where: { status: { notIn: ["INVITE_SENT", "COMPLETED", "FAILED"] } }
      }),
      // unused codes
      this.prisma.redeemCode.count({ where: { status: "UNUSED" } }),
      // recent orders
      this.prisma.order.findMany({
        take: 5,
        orderBy: { createdAt: "desc" }
      }),
      // review queue
      this.prisma.task.findMany({
        where: { status: "MANUAL_REVIEW" },
        take: 5,
        orderBy: { createdAt: "desc" },
        include: { order: true, familyGroup: true }
      }),
      // totals for navigation menu
      this.prisma.account.count(),
      this.prisma.familyGroup.count(),
      this.prisma.order.count(),
      this.prisma.order.count({ where: { status: "EXPIRED" } })
    ]);

    return {
      availableSlots: availableSlotsSum,
      pendingInvites: pendingInvitesSum,
      manualReviewTasks,
      disabledAccounts,
      activeOrders,
      unusedCodes,
      recentOrders,
      reviewQueue,
      totals: {
        accounts: totalAccounts,
        groups: totalGroups,
        orders: totalOrders,
        expiredOrders
      }
    };
  }
}
