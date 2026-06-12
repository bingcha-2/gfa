import {
  Injectable,
  NotFoundException,
  BadRequestException
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { FamilyGroupService } from "../family-group/family-group.service";
import { QUEUE_NAMES, JOB_DEFAULTS } from "@gfa/shared";

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly familyGroupService: FamilyGroupService,
    @InjectQueue(QUEUE_NAMES.invite)
    private readonly inviteQueue: Queue,
    @InjectQueue(QUEUE_NAMES.replace)
    private readonly replaceQueue: Queue
  ) { }

  /**
   * Guard: reject if email is already an ACTIVE/PENDING member in any group.
   * Prevents duplicate seat allocation when replacing members.
   *
   * Exception: members whose expiresAt has passed, or who are in groups with
   * SUSPENDED/EXPIRED subscriptions, are NOT considered duplicates (renewal scenario).
   */
  private async guardDuplicateMember(email: string, label: string = "该邮箱") {
    const normalized = email.trim().toLowerCase();
    const now = new Date();
    const existing = await this.prisma.familyMember.findFirst({
      where: {
        email: normalized,
        status: { in: ["ACTIVE", "PENDING"] },
      },
      select: {
        email: true,
        status: true,
        expiresAt: true,
        familyGroup: {
          select: {
            groupName: true,
            account: { select: { subscriptionStatus: true, subscriptionExpiresAt: true } },
          },
        },
      },
    });
    if (!existing) return;

    // Allow re-invite if member's own subscription has expired
    if (existing.expiresAt && existing.expiresAt <= now) return;

    // Allow re-invite if the group's account subscription is suspended or expired
    const subStatus = existing.familyGroup?.account?.subscriptionStatus;
    const subExpiresAt = existing.familyGroup?.account?.subscriptionExpiresAt;
    if (subStatus === "SUSPENDED" || subStatus === "EXPIRED") return;
    if (subExpiresAt && new Date(subExpiresAt) <= now) return;

    throw new BadRequestException(
      `${label} ${normalized} 已在组 ${existing.familyGroup?.groupName ?? '未知'} 中（状态: ${existing.status}），不能重复邀请。`
    );
  }


  async findAll(status?: string, page = 1, pageSize = 50) {
    const VALID_STATUSES = [
      "CREATED", "CODE_VERIFIED", "GROUP_ASSIGNED", "TASK_QUEUED", "TASK_RUNNING",
      "INVITE_SENT", "WAIT_USER_ACCEPT", "COMPLETED", "FAILED", "MANUAL_REVIEW", "EXPIRED"
    ];

    const where = (status && VALID_STATUSES.includes(status))
      ? { status: status as any }
      : {};

    const safePage = Math.max(page, 1);
    const safeSize = Math.min(Math.max(pageSize, 1), 200);

    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (safePage - 1) * safeSize,
        take: safeSize,
        include: {
          familyGroup: { select: { id: true, groupName: true } },
          redeemCode: { select: { id: true, code: true } },
          _count: { select: { tasks: true } },
        }
      }),
      this.prisma.order.count({ where }),
    ]);

    return { items, total };
  }

  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        familyGroup: true,
        redeemCode: true,
        tasks: { orderBy: { createdAt: "desc" }, take: 10 }
      }
    });

    if (!order) throw new NotFoundException("Order not found");

    return order;
  }

  /**
   * Retry a MANUAL_REVIEW order: re-attempt group assignment + create invite task.
   * Also supports FAILED orders.
   */
  async retryOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException("Order not found");
    }

    if (order.status !== "MANUAL_REVIEW" && order.status !== "FAILED") {
      throw new BadRequestException(
        `Order status is ${order.status}, only MANUAL_REVIEW or FAILED orders can be retried`
      );
    }

    // Try to find an available group
    const groupId = await this.familyGroupService.findAvailableGroup();

    if (!groupId) {
      throw new BadRequestException("Still no available family group");
    }

    const group = await this.prisma.familyGroup.findUnique({
      where: { id: groupId },
    });

    const assignedAt = new Date();
    const expiresAt = new Date(assignedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const memberExpiresAt = expiresAt.toISOString();

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        familyGroupId: groupId,
        status: "GROUP_ASSIGNED",
        assignedAt,
        expiresAt,
        resultMessage: null,
      },
    });

    await this.prisma.familyGroup.update({
      where: { id: groupId },
      data: {
        availableSlots: { decrement: 1 },
        pendingInviteCount: { increment: 1 },
      },
    });

    const task = await this.prisma.task.create({
      data: {
        type: "INVITE_MEMBER",
        orderId: order.id,
        familyGroupId: groupId,
        accountId: group!.accountId,
        payload: JSON.stringify({
          orderId: order.id,
          familyGroupId: groupId,
          accountId: group!.accountId,
          userEmail: order.userEmail,
          memberExpiresAt,
        }),
      },
    });

    await this.prisma.order.update({
      where: { id: order.id },
      data: { status: "TASK_QUEUED" },
    });

    await this.inviteQueue.add(
      "invite-member",
      {
        taskId: task.id,
        orderId: order.id,
        familyGroupId: groupId,
        accountId: group!.accountId,
        userEmail: order.userEmail,
        memberExpiresAt,
      },
      { ...JOB_DEFAULTS, jobId: task.id }
    );

    return {
      orderNo: order.orderNo,
      status: "TASK_QUEUED",
      message: `Assigned to group ${group!.groupName}, invite task queued`,
    };
  }

  async replaceMember(
    orderId: string,
    targetMemberEmail: string,
    newUserEmail: string,
    operatorId?: string
  ) {
    // Normalize emails to lowercase — Gmail is case-insensitive
    targetMemberEmail = targetMemberEmail.trim().toLowerCase();
    newUserEmail = newUserEmail.trim().toLowerCase();
    const order = await this.findOne(orderId);

    // Cross-group duplicate check
    await this.guardDuplicateMember(newUserEmail, "新邮箱");

    if (!order.familyGroupId) {
      throw new BadRequestException("Order has no assigned family group");
    }

    const group = await this.prisma.familyGroup.findUnique({
      where: { id: order.familyGroupId }
    });

    if (!group) {
      throw new BadRequestException("Family group not found");
    }

    const task = await this.prisma.task.create({
      data: {
        type: "REPLACE_MEMBER",
        orderId: order.id,
        familyGroupId: group.id,
        accountId: group.accountId,
        payload: JSON.stringify({
          orderId: order.id,
          familyGroupId: group.id,
          accountId: group.accountId,
          targetMemberEmail,
          newUserEmail,
          reason: "ADMIN_REPLACE"
        })
      }
    });

    await this.replaceQueue.add(
      "replace-member",
      {
        taskId: task.id,
        orderId: order.id,
        familyGroupId: group.id,
        accountId: group.accountId,
        targetMemberEmail,
        newUserEmail
      },
      { ...JOB_DEFAULTS, jobId: task.id }
    );

    return { queued: true, taskId: task.id };
  }
}
