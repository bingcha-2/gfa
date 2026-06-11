import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException
} from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { nanoid } from "nanoid";

import { PrismaService } from "../prisma/prisma.service";
import { RedeemCodeService } from "../redeem-code/redeem-code.service";
import { FamilyGroupService } from "../family-group/family-group.service";
import { QUEUE_NAMES, TASK_TYPES, JOB_DEFAULTS, SyncFamilyGroupPayload } from "@gfa/shared";

type PublicOrderPayload = {
  orderNo: string;
  userEmail: string;
  status: string;
  resultMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};




@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redeemCodeService: RedeemCodeService,
    private readonly familyGroupService: FamilyGroupService,
    @InjectQueue(QUEUE_NAMES.invite)
    private readonly inviteQueue: Queue,
    @InjectQueue(QUEUE_NAMES.replace)
    private readonly replaceQueue: Queue,
    @InjectQueue(QUEUE_NAMES.sync)
    private readonly syncQueue: Queue
  ) { }

  private toPublicOrder(order: PublicOrderPayload) {
    const atIdx = order.userEmail.indexOf("@");
    const localPart = order.userEmail.substring(0, atIdx);
    const domainPart = order.userEmail.substring(atIdx);
    const masked =
      localPart.length <= 2
        ? localPart + "***" + domainPart
        : localPart.substring(0, 2) + "***" + domainPart;

    return { ...order, userEmail: masked };
  }

  /**
   * Find an active/pending family member by email.
   * Tries exact match first, then case-insensitive fallback.
   */
  private async findActiveMember(email: string) {
    const normalized = email.trim().toLowerCase();

    let member = await this.prisma.familyMember.findFirst({
      where: {
        email: normalized,
        status: { in: ["ACTIVE", "PENDING"] },
        familyGroup: { status: "ACTIVE" }
      },
      select: { familyGroupId: true, email: true },
      orderBy: { createdAt: "desc" }
    });

    if (!member) {
      // Case-insensitive fallback for legacy data
      const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT fm.id FROM FamilyMember fm
         JOIN FamilyGroup fg ON fm.familyGroupId = fg.id
         WHERE LOWER(fm.email) = ?
           AND fm.status IN ('ACTIVE','PENDING')
           AND fg.status = 'ACTIVE'
         ORDER BY fm.createdAt DESC LIMIT 1`,
        normalized
      );
      if (rows.length > 0) {
        member = await this.prisma.familyMember.findUnique({
          where: { id: rows[0].id },
          select: { familyGroupId: true, email: true }
        });
      }
    }

    return member;
  }

  /**
   * Guard: reject if email is already an ACTIVE/PENDING member in any group.
   * Prevents duplicate seat allocation across all entry points (join, swap, replace).
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

  /**
   * Validate an ACCOUNT_SWAP or SUBSCRIPTION redeem code.
   */
  private async validateSwapCode(codeStr: string) {
    const normalizedCode = codeStr.trim().toUpperCase();
    const redeemCode = await this.prisma.redeemCode.findUnique({
      where: { code: normalizedCode }
    });

    const SWAP_TYPES = ["ACCOUNT_SWAP", "SUBSCRIPTION"];
    if (!redeemCode || !SWAP_TYPES.includes(redeemCode.codeType)) {
      throw new ForbiddenException("该卡密无法用于换号操作，请确认卡密类型是否正确。");
    }

    const isSubscription = redeemCode.codeType === "SUBSCRIPTION";

    if (isSubscription) {
      if (redeemCode.status !== "UNUSED" && redeemCode.status !== "USED") {
        throw new BadRequestException("该长效卡密无效或已过期。");
      }
      if (redeemCode.expiresAt && redeemCode.expiresAt < new Date()) {
        throw new BadRequestException("该长效卡密已过期，请联系客服。");
      }
    } else {
      if (redeemCode.status !== "UNUSED") {
        throw new BadRequestException("该换号卡密无效或已使用过。");
      }
    }

    return redeemCode;
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

  async findByOrderNo(orderNo: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      select: {
        orderNo: true,
        userEmail: true,
        status: true,
        resultMessage: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!order) throw new NotFoundException("Order not found");

    return this.toPublicOrder(order);
  }

  async findByRedeemCode(code: string) {
    const normalizedCode = code.trim().toUpperCase();

    const redeemCode = await this.prisma.redeemCode.findUnique({
      where: { code: normalizedCode },
      select: {
        id: true,
        codeType: true,
        order: {
          select: {
            orderNo: true,
            userEmail: true,
            status: true,
            resultMessage: true,
            createdAt: true,
            updatedAt: true
          }
        }
      }
    });

    if (!redeemCode) {
      throw new NotFoundException("Order not found");
    }

    // All code types (JOIN_GROUP, ACCOUNT_SWAP, SUBSCRIPTION) now have
    // a direct Order linked via Order.redeemCodeId.
    if (redeemCode.order) {
      return this.toPublicOrder(redeemCode.order);
    }

    throw new NotFoundException("Order not found");
  }


  async redeem(code: string, email: string) {
    // 1. Verify redeem code
    const redeemCode = await this.redeemCodeService.verifyAndReserve(code);

    if (!redeemCode) {
      throw new BadRequestException(
        "Invalid or already used redeem code"
      );
    }

    // Guard: only JOIN_GROUP codes can be used in the redeem (join) flow
    // SUBSCRIPTION codes are restricted to member replacement only (subscriptionSwap / swapAccount)
    const JOINABLE_TYPES = ["JOIN_GROUP"];
    if (!JOINABLE_TYPES.includes(redeemCode.codeType)) {
      // Roll back the reservation — code is not meant for joining groups
      await this.prisma.redeemCode.updateMany({
        where: { id: redeemCode.id, status: "RESERVED" },
        data: { status: "UNUSED" }
      });
      throw new BadRequestException(
        "This code cannot be used for joining a group"
      );
    }

    // Normalize email to lowercase for consistent storage and lookup
    const normalizedEmail = email.trim().toLowerCase();

    // Cross-group duplicate check: reject if email is already in a group
    await this.guardDuplicateMember(normalizedEmail, "邮箱");

    // 2. Create order
    const orderNo = `GFA-${Date.now().toString(36).toUpperCase()}-${nanoid(4).toUpperCase()}`;

    const order = await this.prisma.order.create({
      data: {
        orderNo,
        orderType: "JOIN",
        redeemCodeId: redeemCode.id,
        userEmail: normalizedEmail,
        status: "CODE_VERIFIED"
      }
    });

    // 3. Auto-select family group
    const groupId = await this.familyGroupService.findAvailableGroup();

    if (!groupId) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: "MANUAL_REVIEW", resultMessage: "No available family group" }
      });

      return {
        orderNo: order.orderNo,
        status: "MANUAL_REVIEW",
        message: "All groups are full, pending manual assignment"
      };
    }

    // 4. Assign group
    const group = await this.prisma.familyGroup.findUnique({
      where: { id: groupId }
    });

    const assignedAt = new Date();
    // SUBSCRIPTION: use validDays from the code; default 30 days for JOIN_GROUP
    const rc = redeemCode as any;
    const validDays = (String(redeemCode.codeType) === "SUBSCRIPTION" && rc.validDays)
      ? rc.validDays as number
      : 30;
    const expiresAt = new Date(assignedAt.getTime() + validDays * 24 * 60 * 60 * 1000);

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        familyGroupId: groupId,
        status: "GROUP_ASSIGNED",
        assignedAt,
        expiresAt
      }
    });

    // Decrement available slots and increment pending invite count
    await this.prisma.familyGroup.update({
      where: { id: groupId },
      data: {
        availableSlots: { decrement: 1 },
        pendingInviteCount: { increment: 1 }
      }
    });

    // 5. Create task and enqueue
    const memberExpiresAt = expiresAt.toISOString();
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
          userEmail: normalizedEmail,
          memberExpiresAt
        })
      }
    });

    await this.prisma.order.update({
      where: { id: order.id },
      data: { status: "TASK_QUEUED" }
    });

    await this.inviteQueue.add(
      "invite-member",
      {
        taskId: task.id,
        orderId: order.id,
        familyGroupId: groupId,
        accountId: group!.accountId,
        userEmail: normalizedEmail,
        memberExpiresAt
      },
      { ...JOB_DEFAULTS, jobId: task.id }
    );

    return {
      orderNo: order.orderNo,
      status: "TASK_QUEUED",
      message: "Invite task queued"
    };
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

  /**
   * Customer self-service account swap.
   *
   * Creates an independent SWAP or SUBSCRIPTION Order (not linked to JOIN Order).
   * Locates the member by oldEmail via FamilyMember table.
   *
   * Flow:
   *   1. Validate swap/subscription code
   *   2. SUBSCRIPTION reuse: delegate to subscriptionReuse()
   *   3. First-time: find member in FamilyMember → create Order + SwapRecord + Task
   *   4. Enqueue REPLACE_MEMBER job
   */
  async swapAccount(params: {
    swapCode: string;
    oldEmail: string;
    newEmail: string;
  }) {
    const newEmail = params.newEmail.trim().toLowerCase();
    const oldEmail = params.oldEmail.trim().toLowerCase();

    if (!newEmail) throw new BadRequestException("新邮箱不能为空。");
    if (!oldEmail) throw new BadRequestException("原账号邮箱不能为空。");
    if (newEmail === oldEmail) throw new BadRequestException("新邮箱不能与原邮箱相同，请重新填写。");

    // Cross-group duplicate check: reject if newEmail is already in a group
    await this.guardDuplicateMember(newEmail, "新邮箱");

    // 1. Validate swap code
    const redeemCode = await this.validateSwapCode(params.swapCode);
    const isSubscription = redeemCode.codeType === "SUBSCRIPTION";

    // 2. SUBSCRIPTION reuse: code already USED → delegate
    if (isSubscription && redeemCode.status === "USED") {
      return this.subscriptionReuse({ redeemCode, oldEmail, newEmail });
    }

    // 3. First-time use: find member by oldEmail
    let member = await this.findActiveMember(oldEmail);

    // Retry scenario: if oldEmail was already removed by a previous failed swap
    // (removal succeeded but invite failed), findActiveMember returns null.
    // In that case, find the REMOVED record and its group, then create an
    // INVITE_MEMBER task instead of a full REPLACE_MEMBER.
    let isRetryAfterRemoval = false;
    let retryGroupId: string | null = null;

    if (!member) {
      // Check if oldEmail was recently removed with a failed swap record
      const removedMember = await this.prisma.familyMember.findFirst({
        where: { email: oldEmail, status: "REMOVED" },
        orderBy: { removedAt: "desc" },
        select: { familyGroupId: true, removedAt: true },
      });

      if (removedMember) {
        // Check if there's a recent failed swap for this email+code combination
        const failedSwap = await this.prisma.swapRecord.findFirst({
          where: {
            oldEmail,
            status: "FAILED",
            order: { redeemCodeId: redeemCode.id },
          },
          orderBy: { createdAt: "desc" },
        });

        if (failedSwap) {
          isRetryAfterRemoval = true;
          retryGroupId = removedMember.familyGroupId;
        }
      }

      if (!isRetryAfterRemoval) {
        throw new NotFoundException(
          "未找到该邮箱的活跃成员记录，该账号可能不在任何家庭组中。请确认邮箱是否正确。"
        );
      }
    }

    const groupId = member?.familyGroupId ?? retryGroupId!;
    const group = await this.prisma.familyGroup.findUnique({
      where: { id: groupId },
    });
    if (!group) throw new BadRequestException("未找到关联的家庭组，请联系客服。");

    // 4. Atomic: lock code + create Order + SwapRecord + Task
    const orderType = isSubscription ? "SUBSCRIPTION" : "SWAP";
    const swapReason = isSubscription ? "SUBSCRIPTION_SWAP" : "SWAP_REQUEST";
    const taskType = isRetryAfterRemoval ? "INVITE_MEMBER" : "REPLACE_MEMBER";

    const { order, task } = await this.prisma.$transaction(async (tx) => {
      // Lock the redeem code
      if (isSubscription) {
        const locked = await tx.redeemCode.updateMany({
          where: { id: redeemCode.id, status: "UNUSED" },
          data: { status: "USED", usedAt: new Date() },
        });
        if (locked.count === 0) {
          throw new BadRequestException("卡密正在被使用中（并发请求），请稍后重试。");
        }
      } else {
        const locked = await tx.redeemCode.updateMany({
          where: { id: redeemCode.id, status: "UNUSED", codeType: "ACCOUNT_SWAP" },
          data: { status: "RESERVED" },
        });
        if (locked.count === 0) {
          throw new BadRequestException("换号卡密正在被使用中（并发请求），请稍后重试。");
        }
      }

      // Create Order
      const orderNo = `GFA-${Date.now().toString(36).toUpperCase()}-${nanoid(4).toUpperCase()}`;
      const order = await tx.order.create({
        data: {
          orderNo,
          orderType: orderType as any,
          redeemCodeId: redeemCode.id,
          userEmail: newEmail,
          familyGroupId: groupId,
          status: "TASK_QUEUED",
        },
      });

      // Create Task (INVITE_MEMBER for retry-after-removal, REPLACE_MEMBER otherwise)
      const taskPayload = isRetryAfterRemoval
        ? {
            orderId: order.id,
            familyGroupId: groupId,
            accountId: group!.accountId,
            userEmail: newEmail,
          }
        : {
            orderId: order.id,
            familyGroupId: groupId,
            accountId: group!.accountId,
            targetMemberEmail: oldEmail,
            newUserEmail: newEmail,
            reason: swapReason,
          };

      const task = await tx.task.create({
        data: {
          type: taskType,
          orderId: order.id,
          familyGroupId: groupId,
          accountId: group!.accountId,
          payload: JSON.stringify(taskPayload),
        },
      });

      // Create SwapRecord
      await tx.swapRecord.create({
        data: {
          orderId: order.id,
          oldEmail,
          newEmail,
          taskId: task.id,
        },
      });

      return { order, task };
    });

    // 5. Enqueue — rollback if queue fails
    const targetQueue = isRetryAfterRemoval ? this.inviteQueue : this.replaceQueue;
    const jobName = isRetryAfterRemoval ? "invite-member" : "replace-member";
    const jobPayload = isRetryAfterRemoval
      ? {
          taskId: task.id,
          orderId: order.id,
          familyGroupId: groupId,
          accountId: group!.accountId,
          userEmail: newEmail,
        }
      : {
          taskId: task.id,
          orderId: order.id,
          familyGroupId: groupId,
          accountId: group!.accountId,
          targetMemberEmail: oldEmail,
          newUserEmail: newEmail,
          reason: swapReason,
        };

    try {
      await targetQueue.add(jobName, jobPayload, { ...JOB_DEFAULTS, jobId: task.id });
    } catch (error) {
      const existingJob = await targetQueue.getJob(task.id).catch(() => null);
      if (!existingJob) {
        await this.prisma.$transaction(async (tx) => {
          await tx.swapRecord.deleteMany({ where: { orderId: order.id } });
          await tx.task.deleteMany({ where: { id: task.id, status: "PENDING" } });
          await tx.order.delete({ where: { id: order.id } });
          if (isSubscription) {
            await tx.redeemCode.updateMany({
              where: { id: redeemCode.id, status: "USED" },
              data: { status: "UNUSED", usedAt: null },
            });
          } else {
            await tx.redeemCode.updateMany({
              where: { id: redeemCode.id, status: "RESERVED" },
              data: { status: "UNUSED" },
            });
          }
        });
      }
      throw error;
    }

    // 6. Mark ACCOUNT_SWAP code as USED (after queue success)
    if (!isSubscription) {
      await this.prisma.redeemCode.updateMany({
        where: { id: redeemCode.id, status: "RESERVED" },
        data: { status: "USED", usedAt: new Date() },
      });
    }

    // 7. Reserve slot for invite-only retry (removal already freed the slot earlier)
    if (isRetryAfterRemoval) {
      await this.prisma.familyGroup.update({
        where: { id: groupId },
        data: { availableSlots: { decrement: 1 } },
      }).catch(() => {});
    }

    return {
      orderNo: order.orderNo,
      taskId: task.id,
      status: "TASK_QUEUED",
      message: isRetryAfterRemoval
        ? "检测到上次换号已移除旧账号，系统将直接邀请新账号。"
        : "换号任务已排队，系统将自动为您的新账号发送邀请。",
    };
  }

  /**
   * Subscription reuse: existing SUBSCRIPTION Order + binding check.
   *
   * Verifies the last successful swap's newEmail matches the current oldEmail,
   * preventing code sharing between different users.
   */
  private async subscriptionReuse(params: {
    redeemCode: any;
    oldEmail: string;
    newEmail: string;
  }) {
    const { redeemCode, oldEmail, newEmail } = params;

    // Cross-group duplicate check: reject if newEmail is already in a group
    await this.guardDuplicateMember(newEmail, "新邮箱");

    // 1. Find existing SUBSCRIPTION Order
    const order = await this.prisma.order.findUnique({
      where: { redeemCodeId: redeemCode.id },
      include: { familyGroup: true },
    });

    if (!order) {
      throw new NotFoundException("未找到该长效卡密关联的订单。");
    }

    // 2. Binding check: last successful swap's newEmail must == oldEmail
    const lastSuccessSwap = await this.prisma.swapRecord.findFirst({
      where: { orderId: order.id, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
    });

    if (lastSuccessSwap) {
      if (lastSuccessSwap.newEmail.toLowerCase() !== oldEmail) {
        const boundEmail = this.maskEmail(lastSuccessSwap.newEmail);
        throw new ForbiddenException(
          `该长效卡密已绑定账号 ${boundEmail}，与您输入的原账号邮箱不匹配。请在「原账号邮箱」中填写 ${boundEmail} 对应的完整邮箱后重试。`
        );
      }
    } else {
      // No completed swap yet — check first swap record's oldEmail for binding
      const firstSwap = await this.prisma.swapRecord.findFirst({
        where: { orderId: order.id },
        orderBy: { createdAt: "asc" },
      });
      if (firstSwap && firstSwap.oldEmail.toLowerCase() !== oldEmail) {
        const boundEmail = this.maskEmail(firstSwap.oldEmail);
        throw new ForbiddenException(
          `该长效卡密已绑定账号 ${boundEmail}，与您输入的原账号邮箱不匹配。请在「原账号邮箱」中填写 ${boundEmail} 对应的完整邮箱后重试。`
        );
      }
    }

    // 3. Rate limit check
    const rcAny = redeemCode as any;
    const swapLimit: number = rcAny.swapLimit ?? 2;
    const swapWindowHours: number = rcAny.swapWindowHours ?? 5;

    if (swapLimit > 0) {
      const windowStart = new Date(Date.now() - swapWindowHours * 60 * 60 * 1000);
      const recentSwaps = await this.prisma.swapRecord.count({
        where: { orderId: order.id, createdAt: { gte: windowStart } },
      });
      if (recentSwaps >= swapLimit) {
        throw new BadRequestException(
          `换号频率超出限制：每 ${swapWindowHours} 小时最多换号 ${swapLimit} 次，请稍后再试。`
        );
      }
    }

    // 4. Verify oldEmail is still in a group
    const member = await this.findActiveMember(oldEmail);
    if (!member) {
      throw new NotFoundException("该账号当前不在任何家庭组中，无法执行换号。");
    }

    // ── BUG FIX: member may have been migrated to a different group ──
    // If admin migrated the member to a new group, order.familyGroupId is stale.
    // Always use the member's CURRENT group, and update the order if they differ.
    const actualGroupId = member.familyGroupId;
    const actualGroup = await this.prisma.familyGroup.findUnique({
      where: { id: actualGroupId },
    });
    if (!actualGroup) {
      throw new BadRequestException("未找到成员当前所在的家庭组，请联系客服。");
    }

    if (order.familyGroupId && order.familyGroupId !== actualGroupId) {
      console.warn(
        `[subscriptionReuse] Member ${oldEmail} migrated: order group=${order.familyGroupId} → actual group=${actualGroupId}. Updating order.`,
      );
    }

    const group = actualGroup;

    // 5. Atomic: CAS order + create SwapRecord + Task
    const { task, swapRecord } = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: {
          id: order.id,
          status: { in: ["COMPLETED", "INVITE_SENT", "WAIT_USER_ACCEPT", "FAILED", "MANUAL_REVIEW"] as any },
        },
        data: {
          userEmail: newEmail,
          familyGroupId: group.id,  // sync to member's actual group
          status: "TASK_QUEUED",
          swapCount: { increment: 1 },
          lastSwapAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException("该订单正在换号中或不符合换号条件，请稍后重试。");
      }

      const task = await tx.task.create({
        data: {
          type: "REPLACE_MEMBER",
          orderId: order.id,
          familyGroupId: group.id,
          accountId: group.accountId,
          payload: JSON.stringify({
            orderId: order.id,
            familyGroupId: group.id,
            accountId: group.accountId,
            targetMemberEmail: oldEmail,
            newUserEmail: newEmail,
            reason: "SUBSCRIPTION_SWAP",
          }),
        },
      });

      const swapRecord = await tx.swapRecord.create({
        data: { orderId: order.id, oldEmail, newEmail, taskId: task.id },
      });

      return { task, swapRecord };
    });

    // 6. Enqueue
    try {
      await this.replaceQueue.add(
        "replace-member",
        {
          taskId: task.id,
          orderId: order.id,
          familyGroupId: group.id,
          accountId: group.accountId,
          targetMemberEmail: oldEmail,
          newUserEmail: newEmail,
          reason: "SUBSCRIPTION_SWAP",
        },
        { ...JOB_DEFAULTS, jobId: task.id }
      );
    } catch (error) {
      const existingJob = await this.replaceQueue.getJob(task.id).catch(() => null);
      if (!existingJob) {
        await this.prisma.$transaction(async (tx) => {
          await tx.swapRecord.deleteMany({ where: { id: swapRecord.id } });
          await tx.task.deleteMany({ where: { id: task.id, status: "PENDING" } });
          await tx.order.updateMany({
            where: { id: order.id, status: "TASK_QUEUED", userEmail: newEmail },
            data: { userEmail: oldEmail, status: "COMPLETED", swapCount: { decrement: 1 } },
          });
        });
      }
      throw error;
    }

    return {
      orderNo: order.orderNo,
      taskId: task.id,
      status: "TASK_QUEUED",
      message: "Account swap task queued.",
      swapCount: (order.swapCount ?? 0) + 1,
    };
  }

  /**
   * Customer query for swap task status by orderNo.
   * Returns masked email, order status, and latest REPLACE_MEMBER task details.
   */
  async findSwapStatus(orderNo: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      select: {
        orderNo: true,
        userEmail: true,
        status: true,
        resultMessage: true,
        createdAt: true,
        updatedAt: true,
        orderType: true,
        tasks: {
          where: { type: "REPLACE_MEMBER" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            lastErrorCode: true,
            lastErrorMessage: true,
            startedAt: true,
            finishedAt: true
          }
        }
      }
    });

    if (!order) throw new NotFoundException("Order not found");

    const latestTask = order.tasks[0] ?? null;
    const publicOrder = this.toPublicOrder({
      orderNo: order.orderNo,
      userEmail: order.userEmail,
      status: order.status,
      resultMessage: order.resultMessage,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    });

    // Determine if the user can re-submit this swap
    // Only when order is FAILED (BullMQ exhausted all retries)
    const canRetry = order.status === "FAILED";

    // Task is still being retried by BullMQ (not yet given up)
    const isRetrying = latestTask
      && (latestTask.status === "FAILED_RETRYABLE" || latestTask.status === "PENDING" || latestTask.status === "RUNNING")
      && order.status !== "FAILED";

    return {
      ...publicOrder,
      task: latestTask
        ? {
          status: latestTask.status,
          startedAt: latestTask.startedAt,
          finishedAt: latestTask.finishedAt,
          hasError: !!latestTask.lastErrorMessage,
          errorHint: latestTask.lastErrorMessage
            ? this.humanizeTaskError(latestTask.lastErrorCode, latestTask.lastErrorMessage)
            : null,
        }
        : null,
      canRetry,
      isRetrying: !!isRetrying,
    };
  }

  /**
   * Convert internal error codes/messages to user-friendly Chinese hints.
   */
  private humanizeTaskError(code: string | null, message: string): string {
    if (code === "ACCOUNT_UNAVAILABLE") {
      return "系统账号暂时不可用，正在自动重试中，请稍候。";
    }
    if (message.includes("Target page, context or browser has been closed")) {
      return "浏览器连接意外中断，系统正在自动重试。";
    }
    if (message.includes("LOGIN_FAILED:TRANSIENT")) {
      return "登录暂时失败，系统将自动重试。";
    }
    if (message.includes("Cannot find member")) {
      return "未能在家庭组中找到指定成员，请确认邮箱是否正确。";
    }
    if (message.includes("MAX_RETRIES_EXCEEDED")) {
      return "自动重试次数已用完，您可以重新提交换号申请。";
    }
    return "任务执行遇到问题，您可以重新提交换号申请。";
  }

  /**
   * Customer swap by original email — primary swap endpoint.
   * Delegates to swapAccount() with oldEmail = originalEmail.
   */
  async swapAccountByEmail(params: {
    swapCode: string;
    originalEmail: string;
    newEmail: string;
  }) {
    return this.swapAccount({
      swapCode: params.swapCode,
      oldEmail: params.originalEmail,
      newEmail: params.newEmail,
    });
  }

  /**
   * Legacy endpoint: swap by orderNo.
   * Finds the order's userEmail and delegates to swapAccount().
   */
  async swapAccountByOrderNo(params: {
    swapCode: string;
    orderNo: string;
    newEmail: string;
  }) {
    const order = await this.prisma.order.findUnique({
      where: { orderNo: params.orderNo },
      select: { userEmail: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    return this.swapAccount({
      swapCode: params.swapCode,
      oldEmail: order.userEmail,
      newEmail: params.newEmail,
    });
  }

  /**
   * Subscription self-service swap — SUBSCRIPTION code holders can swap
   * using their original code (no extra swap code needed).
   *
   * Automatically determines oldEmail from the last successful SwapRecord.
   */
  async subscriptionSwap(params: {
    originalCode: string;
    newEmail: string;
  }) {
    const newEmail = params.newEmail.trim().toLowerCase();
    if (!newEmail) throw new BadRequestException("New email cannot be empty");

    // 1. Find the SUBSCRIPTION code
    const normalizedCode = params.originalCode.trim().toUpperCase();
    const redeemCode = await this.prisma.redeemCode.findUnique({
      where: { code: normalizedCode },
    });

    if (!redeemCode) throw new NotFoundException("未找到该卡密，请检查是否输入正确。");
    if (redeemCode.codeType !== "SUBSCRIPTION") {
      throw new ForbiddenException("该卡密不是长效卡密类型，无法使用此功能。");
    }
    if (redeemCode.status !== "USED") {
      throw new BadRequestException(
        redeemCode.status === "UNUSED"
          ? "该长效卡密尚未首次使用，请先通过换号页面完成首次绑定。"
          : "该长效卡密无效或已过期。"
      );
    }
    if (redeemCode.expiresAt && redeemCode.expiresAt < new Date()) {
      throw new BadRequestException("该长效卡密已过期，请联系客服。");
    }

    // 2. Find the SUBSCRIPTION Order
    const order = await this.prisma.order.findUnique({
      where: { redeemCodeId: redeemCode.id },
    });
    if (!order) {
      throw new NotFoundException("未找到该长效卡密关联的订单，请联系客服。");
    }

    // 3. Get oldEmail from last successful swap
    const lastSwap = await this.prisma.swapRecord.findFirst({
      where: { orderId: order.id, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
    });
    if (!lastSwap) {
      throw new BadRequestException(
        "该长效卡密尚未有成功的换号记录，请联系客服处理。"
      );
    }

    const oldEmail = lastSwap.newEmail.toLowerCase();
    if (oldEmail === newEmail) {
      throw new BadRequestException("新邮箱与当前绑定的邮箱相同，无需换号。");
    }

    // 4. Delegate to subscriptionReuse
    return this.subscriptionReuse({ redeemCode, oldEmail, newEmail });
  }

  // ========== Public Self-Service Migration ==========

  /**
   * Check whether a member's parent account is unhealthy and migration is available.
   *
   * Returns sanitised status info; never exposes account credentials or IDs.
   *
   * Business rules:
   *  - expiresAt === null OR expiresAt <= now → EXPIRED (ineligible)
   *  - subscriptionStatus SUSPENDED / syncError CAPTCHA / account VERIFICATION_REQUIRED → needsMigration
   *  - subscriptionStatus ACTIVE + synced < 5h → NORMAL
   *  - subscriptionStatus ACTIVE + synced >= 5h → trigger async sync, return needsSync
   */
  async checkMigration(email: string): Promise<{
    eligible: boolean;
    needsMigration: boolean;
    needsSync: boolean;
    syncTaskId?: string;
    reason: string;
    message: string;
    memberInfo?: {
      groupName: string;
      expiresAt: string | null;
      accountStatus: string;
    };
  }> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      return { eligible: false, needsMigration: false, needsSync: false, reason: "INVALID_EMAIL", message: "请输入有效的邮箱地址。" };
    }

    // 1. Lookup member
    const lookup = await this.familyGroupService.lookupByMemberEmail(normalizedEmail);

    if (!lookup.found) {
      return { eligible: false, needsMigration: false, needsSync: false, reason: "NOT_FOUND", message: "未查找到该邮箱的会员记录，请确认邮箱是否正确。如有疑问请联系客服。" };
    }

    // 1.5 Check if member has been REMOVED from the group
    if (lookup.memberStatus === "REMOVED") {
      const removalMessage = await this.determineRemovalReason(normalizedEmail, lookup.familyGroup?.id);
      return {
        eligible: false, needsMigration: false, needsSync: false,
        reason: "REMOVED",
        message: removalMessage,
      };
    }

    // 2. Determine expiry — null expiresAt = expired
    const memberExpiresAt = lookup.member?.expiresAt ?? lookup.order?.expiresAt ?? null;
    const now = new Date();

    if (!memberExpiresAt) {
      // No expiry set → treat as expired
      return {
        eligible: false, needsMigration: false, needsSync: false,
        reason: "EXPIRED_NO_DATE",
        message: "您的会员记录未设置有效期，无法使用迁移功能。如有疑问请联系客服确认。"
      };
    }

    if (new Date(memberExpiresAt) <= now) {
      const expDate = new Date(memberExpiresAt).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
      return {
        eligible: false, needsMigration: false, needsSync: false,
        reason: "EXPIRED",
        message: `您的会员权益已于 ${expDate} 到期，如需续费请前往冰茶商店购买。`
      };
    }

    // 3. Check parent account status
    if (!lookup.familyGroup || !lookup.account) {
      return { eligible: false, needsMigration: false, needsSync: false, reason: "NO_GROUP", message: "未找到关联的家庭组信息。如有疑问请联系客服。" };
    }

    const { account, familyGroup } = lookup;
    const subStatus = account.subscriptionStatus;
    const syncError = account.syncError;
    const acctStatus = account.status;

    // Determine whether account is "unhealthy"
    const isSuspended = subStatus === "SUSPENDED";
    const isExpired = subStatus === "EXPIRED";
    const isCaptcha = syncError === "CAPTCHA_REQUIRED";
    const isVerificationRequired = acctStatus === "VERIFICATION_REQUIRED";

    if (isSuspended || isExpired || isCaptcha || isVerificationRequired) {
      const reason = isSuspended ? "SUSPENDED" : isExpired ? "EXPIRED" : isCaptcha ? "CAPTCHA" : "VERIFICATION";
      return {
        eligible: true, needsMigration: true, needsSync: false,
        reason,
        message: "检测到您当前所在家庭组异常，建议立即迁移到正常组。迁移不会影响您的到期时间。",
        memberInfo: {
          groupName: familyGroup.groupName,
          expiresAt: memberExpiresAt,
          accountStatus: "异常",
        }
      };
    }

    // 4. Account looks ACTIVE — check sync freshness
    const SYNC_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
    const lastSyncedAt = familyGroup.lastSyncedAt ? new Date(familyGroup.lastSyncedAt) : null;
    const isFresh = lastSyncedAt && (now.getTime() - lastSyncedAt.getTime() < SYNC_WINDOW_MS);

    if (isFresh) {
      return {
        eligible: true, needsMigration: false, needsSync: false,
        reason: "NORMAL",
        message: `您的会员权益正常，当前无需操作。到期时间：${new Date(memberExpiresAt).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}。`,
        memberInfo: {
          groupName: familyGroup.groupName,
          expiresAt: memberExpiresAt,
          accountStatus: "正常",
        }
      };
    }

    // 5. Sync not fresh — trigger async sync and return needsSync
    // Find the account via family group to get accountId
    const group = await this.prisma.familyGroup.findUnique({
      where: { id: familyGroup.id },
      select: { accountId: true },
    });

    if (!group) {
      return { eligible: true, needsMigration: false, needsSync: false, reason: "NORMAL", message: "会员状态正常。" };
    }

    // Check if there's already a pending/running sync for this group (avoid duplicates during polling)
    const existingSync = await this.prisma.task.findFirst({
      where: {
        type: "SYNC_FAMILY_GROUP",
        familyGroupId: familyGroup.id,
        status: { in: ["PENDING", "RUNNING"] },
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });

    if (existingSync) {
      return {
        eligible: true, needsMigration: false, needsSync: true,
        syncTaskId: existingSync.id,
        reason: "SYNCING",
        message: "正在检测母号状态，请稍候...",
        memberInfo: {
          groupName: familyGroup.groupName,
          expiresAt: memberExpiresAt,
          accountStatus: "检测中",
        }
      };
    }

    // Create sync task
    const task = await this.prisma.task.create({
      data: {
        type: "SYNC_FAMILY_GROUP",
        familyGroupId: familyGroup.id,
        accountId: group.accountId,
        source: "public-migration-check",
        payload: JSON.stringify({
          familyGroupId: familyGroup.id,
          accountId: group.accountId,
          ignoreCooldown: true,
        }),
      },
    });

    const payload: SyncFamilyGroupPayload = {
      taskId: task.id,
      familyGroupId: familyGroup.id,
      accountId: group.accountId,
      ignoreCooldown: true,
    };

    try {
      await this.syncQueue.add(TASK_TYPES.syncFamilyGroup, payload, {
        ...JOB_DEFAULTS,
        jobId: `sync-${familyGroup.id}-${Date.now()}-migration-check`,
      });
    } catch {
      // Queue add failed — clean up task, return as normal to avoid blocking user
      await this.prisma.task.delete({ where: { id: task.id } }).catch(() => {});
      return {
        eligible: true, needsMigration: false, needsSync: false,
        reason: "NORMAL",
        message: "会员状态正常。",
        memberInfo: { groupName: familyGroup.groupName, expiresAt: memberExpiresAt, accountStatus: "正常" }
      };
    }

    return {
      eligible: true, needsMigration: false, needsSync: true,
      syncTaskId: task.id,
      reason: "SYNCING",
      message: "正在检测母号状态，请稍候...",
      memberInfo: {
        groupName: familyGroup.groupName,
        expiresAt: memberExpiresAt,
        accountStatus: "检测中",
      }
    };
  }

  /**
   * Determine why a member was removed from a family group.
   *
   * Checks task history to distinguish:
   *   1. REPLACE_MEMBER (swap) — removed as part of account replacement
   *   2. SYNC_FAMILY_GROUP — user left the group themselves, detected by sync
   *   3. REMOVE_MEMBER (manual) — admin manually removed
   *   4. Unknown — no matching task found
   *
   * Note: by the time this runs, lookupByMemberEmail already picked the "best"
   * record (ACTIVE > PENDING > latest). If the user was swapped out then swapped
   * back in, the ACTIVE record would be picked, so we'd never reach this code.
   * This only runs when *all* records for the user are REMOVED.
   */
  private async determineRemovalReason(email: string, familyGroupId?: string): Promise<string> {
    if (!familyGroupId) {
      return "您的账号已被移出家庭组。如有疑问请联系人工客服。";
    }

    // Find the most recent task that involved this email in this group.
    // Use createdAt DESC to get the latest action — handles swap-out then swap-in scenarios.
    const removalTask = await this.prisma.task.findFirst({
      where: {
        familyGroupId,
        type: { in: ["REMOVE_MEMBER", "REPLACE_MEMBER"] },
        payload: { contains: email },
        status: "SUCCESS",
      },
      orderBy: { createdAt: "desc" },
      select: { type: true, source: true, orderId: true, payload: true },
    });

    if (removalTask) {
      if (removalTask.type === "REPLACE_MEMBER") {
        // Parse payload to find who replaced this user
        try {
          const payload = JSON.parse(removalTask.payload ?? "{}");
          // Only show "replaced" if this email is the targetMemberEmail (the one being removed).
          // If this email is the newUserEmail, it means they were invited in by a replace but later removed.
          if (payload.targetMemberEmail?.toLowerCase() === email && payload.newUserEmail) {
            const masked = this.maskEmail(payload.newUserEmail);
            return `您的账号已通过换号操作被替换移出家庭组。请使用替换后的账号（${masked}）查询权益。`;
          }
        } catch { /* ignore parse error */ }
        return "您的账号已通过换号操作被替换移出家庭组。请使用替换后的账号查询权益。";
      }
      // REMOVE_MEMBER — manual admin removal
      return "您的账号已被管理员移出家庭组。如果是错误移除，请联系人工客服处理。";
    }

    // Check if a SYNC task detected the removal (user left themselves)
    const syncRemoval = await this.prisma.task.findFirst({
      where: {
        familyGroupId,
        type: "SYNC_FAMILY_GROUP",
        status: "SUCCESS",
        logs: { some: { message: { contains: `${email} as REMOVED` } } },
      },
      orderBy: { createdAt: "desc" },
      select: { type: true },
    });

    if (syncRemoval) {
      return "您的账号已退出家庭组（系统同步检测到）。如果您并未主动退出，请联系人工客服处理。";
    }

    // Fallback
    return "您的账号已被移出家庭组。如有疑问请联系人工客服。";
  }

  /** Mask email for display: show first 3 chars + ***@domain */
  private maskEmail(email: string): string {
    const [local, domain] = email.split("@");
    if (!domain) return "***";
    if (local.length <= 4) {
      // Short local part: show first 2 + mask rest
      return `${local.slice(0, 2)}***@${domain}`;
    }
    // Show first 4 and last 2 chars for better identification
    const head = local.slice(0, 4);
    const tail = local.slice(-2);
    return `${head}***${tail}@${domain}`;
  }

  /**
   * Public self-service migrate: re-validates all conditions, then delegates
   * to FamilyGroupService.migrateMember().
   *
   * Rate-limit: per-email 24h cooldown enforced via DB query.
   */
  async selfMigrate(email: string): Promise<{
    success: boolean;
    message: string;
    targetGroupName?: string;
    taskId?: string;
  }> {
    const normalizedEmail = email.trim().toLowerCase();

    // 1. Re-run full check (TOCTOU guard: never trust client-side check result)
    const check = await this.checkMigration(normalizedEmail);

    if (!check.eligible) {
      throw new BadRequestException(check.message);
    }

    if (!check.needsMigration) {
      // Also handle needsSync: user shouldn't call selfMigrate while sync is pending
      if (check.needsSync) {
        throw new BadRequestException("正在检测母号状态，请等待检测完成后再操作。");
      }
      throw new BadRequestException("会员状态正常，无需迁移。");
    }

    // (24h per-email cooldown removed — users can migrate again immediately if needed)

    // 3. Find the member's current group
    const lookup = await this.familyGroupService.lookupByMemberEmail(normalizedEmail);
    if (!lookup.found || !lookup.familyGroup) {
      throw new BadRequestException("未找到有效的会员记录。");
    }

    // 4. PRE-CHECK: verify there are available seats before removing the member.
    //    Without this, migrateMember() would remove first, then discover no slots,
    //    leaving the member orphaned (REMOVED but not re-invited).
    const now = new Date();
    const availableGroups = await this.prisma.familyGroup.count({
      where: {
        status: "ACTIVE",
        availableSlots: { gt: 0 },
        // Exclude the member's current group (they're migrating away from it)
        id: { not: lookup.familyGroup.id },
        account: {
          status: "HEALTHY",
          subscriptionStatus: { notIn: ["SUSPENDED", "EXPIRED"] },
          OR: [
            { subscriptionExpiresAt: null },
            { subscriptionExpiresAt: { gt: now } },
          ],
        },
      },
    });

    if (availableGroups === 0) {
      return {
        success: false,
        message: "当前暂无可用席位，请15分钟后再试或联系客服处理。",
      };
    }

    // 5. Execute migration via existing service
    const result = await this.familyGroupService.migrateMember(
      lookup.familyGroup.id,
      normalizedEmail
    );

    if (result.error) {
      return {
        success: false,
        message: result.error === "No available family group with open slots"
          ? "当前暂无可用位置，请稍后再试或联系客服。"
          : result.error,
      };
    }

    return {
      success: true,
      message: `迁移成功！已从「${result.removedFromGroupName}」迁移到「${result.inviteResult?.targetGroupName}」，请注意查收邀请邮件。`,
      targetGroupName: result.inviteResult?.targetGroupName,
      taskId: result.inviteResult?.taskId,
    };
  }
}
