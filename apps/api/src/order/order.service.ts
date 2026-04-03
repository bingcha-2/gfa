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
import { QUEUE_NAMES, JOB_DEFAULTS } from "@gfa/shared";

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
    private readonly replaceQueue: Queue
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
   * Validate an ACCOUNT_SWAP or SUBSCRIPTION redeem code.
   */
  private async validateSwapCode(codeStr: string) {
    const normalizedCode = codeStr.trim().toUpperCase();
    const redeemCode = await this.prisma.redeemCode.findUnique({
      where: { code: normalizedCode }
    });

    const SWAP_TYPES = ["ACCOUNT_SWAP", "SUBSCRIPTION"];
    if (!redeemCode || !SWAP_TYPES.includes(redeemCode.codeType)) {
      throw new ForbiddenException("This code cannot be used for account swap");
    }

    const isSubscription = redeemCode.codeType === "SUBSCRIPTION";

    if (isSubscription) {
      if (redeemCode.status !== "UNUSED" && redeemCode.status !== "USED") {
        throw new BadRequestException("Invalid or expired subscription code");
      }
      if (redeemCode.expiresAt && redeemCode.expiresAt < new Date()) {
        throw new BadRequestException("This subscription code has expired");
      }
    } else {
      if (redeemCode.status !== "UNUSED") {
        throw new BadRequestException("Invalid or already used swap code");
      }
    }

    return redeemCode;
  }


  async findAll(status?: string) {
    const VALID_STATUSES = [
      "CREATED", "CODE_VERIFIED", "GROUP_ASSIGNED", "TASK_QUEUED", "TASK_RUNNING",
      "INVITE_SENT", "WAIT_USER_ACCEPT", "COMPLETED", "FAILED", "MANUAL_REVIEW", "EXPIRED"
    ];

    const where = (status && VALID_STATUSES.includes(status))
      ? { status: status as any }
      : {};

    return this.prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        familyGroup: { select: { id: true, groupName: true } },
        redeemCode: { select: { id: true, code: true } },
        _count: { select: { tasks: true } },
        swapRecords: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            oldEmail: true,
            newEmail: true,
            status: true,
            taskId: true,
            createdAt: true,
          },
        },
      }
    });
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
      { ...JOB_DEFAULTS }
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
      { ...JOB_DEFAULTS }
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
      { ...JOB_DEFAULTS }
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

    if (!newEmail) throw new BadRequestException("New email cannot be empty");
    if (!oldEmail) throw new BadRequestException("Old email cannot be empty");
    if (newEmail === oldEmail) throw new BadRequestException("New email is the same as old email");

    // 1. Validate swap code
    const redeemCode = await this.validateSwapCode(params.swapCode);
    const isSubscription = redeemCode.codeType === "SUBSCRIPTION";

    // 2. SUBSCRIPTION reuse: code already USED → delegate
    if (isSubscription && redeemCode.status === "USED") {
      return this.subscriptionReuse({ redeemCode, oldEmail, newEmail });
    }

    // 3. First-time use: find member by oldEmail
    const member = await this.findActiveMember(oldEmail);
    if (!member) {
      throw new NotFoundException(
        "No active member found for this email. The account may not be in any family group."
      );
    }

    const group = await this.prisma.familyGroup.findUnique({
      where: { id: member.familyGroupId },
    });
    if (!group) throw new BadRequestException("Family group not found");

    // 4. Atomic: lock code + create Order + SwapRecord + Task
    const orderType = isSubscription ? "SUBSCRIPTION" : "SWAP";
    const swapReason = isSubscription ? "SUBSCRIPTION_SWAP" : "SWAP_REQUEST";

    const { order, task } = await this.prisma.$transaction(async (tx) => {
      // Lock the redeem code
      if (isSubscription) {
        const locked = await tx.redeemCode.updateMany({
          where: { id: redeemCode.id, status: "UNUSED" },
          data: { status: "USED", usedAt: new Date() },
        });
        if (locked.count === 0) {
          throw new BadRequestException("Code already in use (concurrent request)");
        }
      } else {
        const locked = await tx.redeemCode.updateMany({
          where: { id: redeemCode.id, status: "UNUSED", codeType: "ACCOUNT_SWAP" },
          data: { status: "RESERVED" },
        });
        if (locked.count === 0) {
          throw new BadRequestException("Swap code already in use (concurrent request)");
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
          familyGroupId: member.familyGroupId,
          status: "TASK_QUEUED",
        },
      });

      // Create Task
      const task = await tx.task.create({
        data: {
          type: "REPLACE_MEMBER",
          orderId: order.id,
          familyGroupId: member.familyGroupId,
          accountId: group!.accountId,
          payload: JSON.stringify({
            orderId: order.id,
            familyGroupId: member.familyGroupId,
            accountId: group!.accountId,
            targetMemberEmail: oldEmail,
            newUserEmail: newEmail,
            reason: swapReason,
          }),
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
    try {
      await this.replaceQueue.add(
        "replace-member",
        {
          taskId: task.id,
          orderId: order.id,
          familyGroupId: member.familyGroupId,
          accountId: group!.accountId,
          targetMemberEmail: oldEmail,
          newUserEmail: newEmail,
          reason: swapReason,
        },
        { ...JOB_DEFAULTS, jobId: task.id }
      );
    } catch (error) {
      const existingJob = await this.replaceQueue.getJob(task.id).catch(() => null);
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

    return {
      orderNo: order.orderNo,
      taskId: task.id,
      status: "TASK_QUEUED",
      message: "Account swap task queued. Your new account will be invited shortly.",
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

    // 1. Find existing SUBSCRIPTION Order
    const order = await this.prisma.order.findUnique({
      where: { redeemCodeId: redeemCode.id },
      include: { familyGroup: true },
    });

    if (!order) {
      throw new NotFoundException("Subscription code has no associated order");
    }

    // 2. Binding check: last successful swap's newEmail must == oldEmail
    const lastSuccessSwap = await this.prisma.swapRecord.findFirst({
      where: { orderId: order.id, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
    });

    if (lastSuccessSwap) {
      if (lastSuccessSwap.newEmail.toLowerCase() !== oldEmail) {
        throw new ForbiddenException(
          "This subscription code is bound to a different account"
        );
      }
    } else {
      // No completed swap yet — check first swap record's oldEmail for binding
      const firstSwap = await this.prisma.swapRecord.findFirst({
        where: { orderId: order.id },
        orderBy: { createdAt: "asc" },
      });
      if (firstSwap && firstSwap.oldEmail.toLowerCase() !== oldEmail) {
        throw new ForbiddenException(
          "This subscription code is bound to a different account"
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
          `Swap rate limit exceeded: maximum ${swapLimit} swaps per ${swapWindowHours} hours.`
        );
      }
    }

    // 4. Verify oldEmail is still in a group
    const member = await this.findActiveMember(oldEmail);
    if (!member) {
      throw new NotFoundException("The account is not currently in any family group");
    }

    if (!order.familyGroupId || !order.familyGroup) {
      throw new BadRequestException("Order has no assigned family group");
    }
    const group = order.familyGroup;

    // 5. Atomic: CAS order + create SwapRecord + Task
    const { task, swapRecord } = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: {
          id: order.id,
          status: { in: ["COMPLETED", "INVITE_SENT", "WAIT_USER_ACCEPT", "FAILED"] as any },
        },
        data: {
          userEmail: newEmail,
          status: "TASK_QUEUED",
          swapCount: { increment: 1 },
          lastSwapAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        throw new BadRequestException("Order is already being swapped or not eligible");
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
        tasks: {
          where: { type: "REPLACE_MEMBER" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
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

    return {
      ...publicOrder,
      task: latestTask
        ? {
          status: latestTask.status,
          startedAt: latestTask.startedAt,
          finishedAt: latestTask.finishedAt,
          hasError: !!latestTask.lastErrorMessage
        }
        : null
    };
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

    if (!redeemCode) throw new NotFoundException("Code not found");
    if (redeemCode.codeType !== "SUBSCRIPTION") {
      throw new ForbiddenException("This code is not a subscription code");
    }
    if (redeemCode.status !== "USED") {
      throw new BadRequestException(
        redeemCode.status === "UNUSED"
          ? "This subscription code has not been used yet. Use swap-by-email for first use."
          : "Invalid or expired subscription code"
      );
    }
    if (redeemCode.expiresAt && redeemCode.expiresAt < new Date()) {
      throw new BadRequestException("This subscription code has expired");
    }

    // 2. Find the SUBSCRIPTION Order
    const order = await this.prisma.order.findUnique({
      where: { redeemCodeId: redeemCode.id },
    });
    if (!order) {
      throw new NotFoundException("No order found for this subscription code");
    }

    // 3. Get oldEmail from last successful swap
    const lastSwap = await this.prisma.swapRecord.findFirst({
      where: { orderId: order.id, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
    });
    if (!lastSwap) {
      throw new BadRequestException(
        "No successful swap found for this subscription. Contact support."
      );
    }

    const oldEmail = lastSwap.newEmail.toLowerCase();
    if (oldEmail === newEmail) {
      throw new BadRequestException("New email is the same as current email");
    }

    // 4. Delegate to subscriptionReuse
    return this.subscriptionReuse({ redeemCode, oldEmail, newEmail });
  }
}
