import { Controller, Get } from "@nestjs/common";
import { Roles } from "./auth/roles.decorator";
import { PrismaService } from "./prisma/prisma.service";

@Controller("stats")
export class StatsController {
  constructor(private readonly prisma: PrismaService) {}

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
