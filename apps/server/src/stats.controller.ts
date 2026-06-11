import { Controller, Get, Query as QueryParam } from "@nestjs/common";
import { Roles } from "./auth/roles.decorator";
import { PrismaService } from "./prisma/prisma.service";

@Controller(["stats", "console/stats"])
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

  /**
   * GET /stats/daily-detail?date=YYYY-MM-DD
   * Returns per-operation breakdown with operator info. SUPER_ADMIN only.
   */
  @Get("daily-detail")
  @Roles("SUPER_ADMIN")
  async getDailyDetail(@QueryParam("date") dateStr?: string) {
    const now = new Date();
    let year: number, month: number, day: number;

    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const parts = dateStr.split("-").map(Number);
      year = parts[0]; month = parts[1] - 1; day = parts[2];
    } else {
      const offset = now.getTime() + 8 * 60 * 60 * 1000;
      const local = new Date(offset);
      year = local.getUTCFullYear(); month = local.getUTCMonth(); day = local.getUTCDate();
    }

    const gte = new Date(Date.UTC(year, month, day,     0, 0, 0) - 8 * 60 * 60 * 1000);
    const lt  = new Date(Date.UTC(year, month, day + 1, 0, 0, 0) - 8 * 60 * 60 * 1000);

    // 1. Console invites with source info
    const consoleInviteTasks = await this.prisma.task.findMany({
      where: {
        type: "INVITE_MEMBER",
        orderId: null,
        transferBatchId: null,
        createdAt: { gte, lt },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        status: true,
        payload: true,
        source: true,
        createdAt: true,
        finishedAt: true,
        familyGroup: { select: { groupName: true } },
        account: { select: { loginEmail: true } },
      },
    });

    // 2. Transfer batches
    const transfers = await this.prisma.transferBatch.findMany({
      where: { createdAt: { gte, lt } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        phase: true,
        totalMembers: true,
        memberEmails: true,
        removedCount: true,
        invitedCount: true,
        createdAt: true,
        sourceGroup: { select: { groupName: true } },
        targetGroup: { select: { groupName: true } },
      },
    });

    // 3. Redeem orders (front-end user self-service)
    const redeemOrders = await this.prisma.order.findMany({
      where: {
        orderType: "JOIN",
        createdAt: { gte, lt },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        orderNo: true,
        userEmail: true,
        status: true,
        createdAt: true,
        familyGroup: { select: { groupName: true } },
      },
    });

    // 4. Audit logs for the day — to attribute operations to operators
    const auditLogs = await this.prisma.auditLog.findMany({
      where: { createdAt: { gte, lt } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        action: true,
        targetType: true,
        targetId: true,
        detail: true,
        createdAt: true,
        operator: { select: { displayName: true, email: true, role: true } },
      },
    });

    // Parse audit log details
    const parsedAuditLogs = auditLogs.map((a) => ({
      ...a,
      detail: a.detail ? (() => { try { return JSON.parse(a.detail!); } catch { return a.detail; } })() : null,
      operatorName: a.operator?.displayName ?? "系统",
      operatorEmail: a.operator?.email ?? null,
      operatorRole: a.operator?.role ?? null,
    }));

    // Build console invite detail — match audit logs to tasks for operator attribution
    const consoleInviteDetail = consoleInviteTasks.map((t) => {
      const payload = t.payload ? (() => { try { return JSON.parse(t.payload); } catch { return {}; } })() : {};
      const userEmail = payload.userEmail ?? "";
      const groupId = payload.familyGroupId ?? t.familyGroup?.groupName ?? "";
      const taskTime = new Date(t.createdAt).getTime();

      // Strategy 1: Find audit log that references this task ID directly in its detail
      //   (MIGRATE_MEMBER stores taskId in detail JSON)
      let matchingAudit = parsedAuditLogs.find((a) => {
        if (!a.detail || typeof a.detail !== "object") return false;
        return a.detail.taskId === t.id;
      });

      // Strategy 2: Match BULK_INVITE by targetId (groupId) + time window
      if (!matchingAudit) {
        matchingAudit = parsedAuditLogs.find(
          (a) => (a.action === "BULK_INVITE") &&
          a.targetId === (payload.familyGroupId ?? "") &&
          Math.abs(new Date(a.createdAt).getTime() - taskTime) < 10000
        );
      }

      // Strategy 3: Match CROSS_BULK_INVITE by time window (targetId is "*")
      if (!matchingAudit) {
        matchingAudit = parsedAuditLogs.find(
          (a) => a.action === "CROSS_BULK_INVITE" &&
          Math.abs(new Date(a.createdAt).getTime() - taskTime) < 10000
        );
      }

      // Strategy 4: Match any invite-related audit that mentions this email in detail
      if (!matchingAudit && userEmail) {
        matchingAudit = parsedAuditLogs.find(
          (a) => (a.action === "MIGRATE_MEMBER" || a.action === "INVITE_MEMBER" || a.action === "REPLACE_MEMBER") &&
          a.detail && typeof a.detail === "object" && a.detail.memberEmail === userEmail &&
          Math.abs(new Date(a.createdAt).getTime() - taskTime) < 30000
        );
      }

      return {
        taskId: t.id,
        status: t.status,
        userEmail,
        groupName: t.familyGroup?.groupName ?? "",
        account: t.account?.loginEmail ?? "",
        createdAt: t.createdAt,
        finishedAt: t.finishedAt,
        source: t.source,
        operator: matchingAudit?.operatorName ?? "未知",
        operatorEmail: matchingAudit?.operatorEmail ?? null,
      };
    });

    return {
      date: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      consoleInvites: consoleInviteDetail,
      transfers: transfers.map((t) => ({
        ...t,
        memberEmails: t.memberEmails ? (() => { try { return JSON.parse(t.memberEmails); } catch { return []; } })() : [],
      })),
      redeemOrders,
      auditLogs: parsedAuditLogs,
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
