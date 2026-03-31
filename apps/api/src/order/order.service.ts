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

const SWAPPABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.COMPLETED,
  OrderStatus.INVITE_SENT,
  OrderStatus.WAIT_USER_ACCEPT,
  // Safety net: allow re-swap when a previous replace task failed and left the
  // order stuck at TASK_QUEUED or FAILED. The CAS in swapAccount() prevents
  // double-processing if a task is still running.
  OrderStatus.TASK_QUEUED,
  OrderStatus.FAILED,
];

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

  private async rollbackSwapPreparation(params: {
    swapCodeId: string;
    taskId: string;
    orderId: string;
    originalEmail: string;
    originalStatus: OrderStatus;
    newEmail: string;
  }) {
    const {
      swapCodeId,
      taskId,
      orderId,
      originalEmail,
      originalStatus,
      newEmail
    } = params;

    await this.prisma.$transaction(async (tx) => {
      await tx.task.deleteMany({
        where: { id: taskId, status: "PENDING" }
      });

      await tx.order.updateMany({
        where: {
          id: orderId,
          status: "TASK_QUEUED",
          userEmail: newEmail
        },
        data: {
          userEmail: originalEmail,
          status: originalStatus
        }
      });

      await tx.redeemCode.updateMany({
        where: { id: swapCodeId, status: "RESERVED" },
        data: { status: "UNUSED", usedAt: null }
      });
    });
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
        _count: { select: { tasks: true } }
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

    // Primary path: JOIN_GROUP code — order linked directly via Order.redeemCodeId
    if (redeemCode.order) {
      return this.toPublicOrder(redeemCode.order);
    }

    // Fallback: ACCOUNT_SWAP code — find the REPLACE_MEMBER task whose payload
    // contains the swap code's id (written by swapAccount at queue time)
    if (redeemCode.codeType === "ACCOUNT_SWAP") {
      // Prisma (SQLite) does not support native JSON filtering;
      // we read recent REPLACE_MEMBER tasks and match in JS.
      // This is safe because ACCOUNT_SWAP codes are used infrequently.
      const tasks = await this.prisma.task.findMany({
        where: { type: "REPLACE_MEMBER" },
        select: { payload: true, orderId: true },
        orderBy: { createdAt: "desc" },
        take: 500  // bounded scan — swap tasks are rare
      });

      const matched = tasks.find((t) => {
        try {
          const p = JSON.parse(t.payload);
          return p.swapRedeemCodeId === redeemCode.id;
        } catch {
          return false;
        }
      });

      if (matched?.orderId) {
        const order = await this.prisma.order.findUnique({
          where: { id: matched.orderId },
          select: {
            orderNo: true,
            userEmail: true,
            status: true,
            resultMessage: true,
            createdAt: true,
            updatedAt: true
          }
        });
        if (order) return this.toPublicOrder(order);
      }
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
          userEmail: normalizedEmail
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
        userEmail: normalizedEmail
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
   * Flow:
   *   1. Verify ACCOUNT_SWAP or SUBSCRIPTION redeem code
   *   2. Locate customer's existing COMPLETED order by orderNo (proves they are a member)
   *   3. For SUBSCRIPTION: apply rate-limit check
   *   4. Create REPLACE_MEMBER task: remove oldEmail, invite newEmail
   *   5. Mark swap redeem code as USED (SUBSCRIPTION stays USED for reuse)
   */
  async swapAccount(params: {
    swapCode: string;
    orderNo: string;
    newEmail: string;
  }) {
    const { swapCode, orderNo } = params;
    // Normalize email to lowercase — Gmail is case-insensitive
    const newEmail = params.newEmail.trim().toLowerCase();

    // Guard: new email must differ from the current one
    if (!newEmail.trim()) {
      throw new BadRequestException("New email cannot be empty");
    }

    // 1. Validate the swap redeem code — must be ACCOUNT_SWAP or SUBSCRIPTION type
    const normalizedCode = swapCode.trim().toUpperCase();
    const redeemCode = await this.prisma.redeemCode.findUnique({
      where: { code: normalizedCode }
    });

    const SWAP_TYPES = ["ACCOUNT_SWAP", "SUBSCRIPTION"];
    if (!redeemCode || !SWAP_TYPES.includes(redeemCode.codeType)) {
      throw new ForbiddenException("This code cannot be used for account swap");
    }

    const isSubscription = redeemCode.codeType === "SUBSCRIPTION";

    // ACCOUNT_SWAP: must be UNUSED (one-time use)
    // SUBSCRIPTION: accept UNUSED (first use) or USED (reuse)
    if (isSubscription) {
      if (redeemCode.status !== "UNUSED" && redeemCode.status !== "USED") {
        throw new BadRequestException("Invalid or expired subscription code");
      }
      // Check expiry for SUBSCRIPTION codes
      if (redeemCode.expiresAt && redeemCode.expiresAt < new Date()) {
        throw new BadRequestException("This subscription code has expired");
      }
    } else {
      if (redeemCode.status !== "UNUSED") {
        throw new BadRequestException("Invalid or already used swap code");
      }
    }

    // 2. Locate the original order — allow COMPLETED / INVITE_SENT / WAIT_USER_ACCEPT
    // (account can be banned at any terminal stage before the new user accepts)
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      include: { familyGroup: true }
    });

    if (!order) throw new NotFoundException("Order not found");

    if (!SWAPPABLE_ORDER_STATUSES.includes(order.status as OrderStatus)) {
      throw new BadRequestException(
        `Order status "${order.status}" does not allow account swap`
      );
    }
    if (!order.familyGroupId || !order.familyGroup) {
      throw new BadRequestException("Order has no assigned family group");
    }

    const oldEmail = order.userEmail;
    const group = order.familyGroup;
    const originalStatus = order.status;

    // SUBSCRIPTION: rate-limit check before proceeding
    if (isSubscription) {
      const rcAny = redeemCode as any;
      const swapLimit: number = rcAny.swapLimit ?? 2;
      const swapWindowHours: number = rcAny.swapWindowHours ?? 5;

      if (swapLimit > 0) {
        const windowStart = new Date(Date.now() - swapWindowHours * 60 * 60 * 1000);
        const recentSwaps = await this.prisma.task.count({
          where: {
            orderId: order.id,
            type: "REPLACE_MEMBER",
            createdAt: { gte: windowStart }
          }
        });
        if (recentSwaps >= swapLimit) {
          throw new BadRequestException(
            `Swap rate limit exceeded: maximum ${swapLimit} swaps per ${swapWindowHours} hours. Please try again later.`
          );
        }
      }
    }

    // 3. Atomically: lock code (RESERVED) + create task + update order
    // Claim the order via status compare-and-swap so only one swap can queue.
    const swapReason = isSubscription ? "SUBSCRIPTION_SWAP" : "SWAP_REQUEST";
    const { task } = await this.prisma.$transaction(async (tx) => {
      // ACCOUNT_SWAP: lock UNUSED → RESERVED (one-time)
      // SUBSCRIPTION: mark UNUSED → USED on first use, skip lock if already USED
      if (isSubscription) {
        if (redeemCode.status === "UNUSED") {
          const locked = await tx.redeemCode.updateMany({
            where: { id: redeemCode.id, status: "UNUSED" },
            data: { status: "USED", usedAt: new Date() }
          });
          if (locked.count === 0) {
            throw new BadRequestException("Subscription code already in use (concurrent request)");
          }
        }
      } else {
        // Guard against double-use — updateMany returns count
        const locked = await tx.redeemCode.updateMany({
          where: {
            id: redeemCode.id,
            status: "UNUSED",
            codeType: "ACCOUNT_SWAP"
          },
          data: { status: "RESERVED" }
        });
        if (locked.count === 0) {
          throw new BadRequestException("Swap code already in use (concurrent request)");
        }
      }

      const claimedOrder = await tx.order.updateMany({
        where: {
          id: order.id,
          familyGroupId: group.id,
          userEmail: oldEmail,
          status: { in: SWAPPABLE_ORDER_STATUSES }
        },
        data: {
          userEmail: newEmail,
          status: "TASK_QUEUED",
          ...(isSubscription ? { swapCount: { increment: 1 }, lastSwapAt: new Date() } : {})
        }
      });
      if (claimedOrder.count === 0) {
        throw new BadRequestException(
          "Order is already being swapped or no longer eligible for swap"
        );
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
            reason: swapReason,
            swapRedeemCodeId: redeemCode.id
          })
        }
      });

      return { task };
    });

    // 4. Enqueue — compensate the DB state if the job was not persisted.
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
          reason: swapReason
        },
        {
          ...JOB_DEFAULTS,
          jobId: task.id,
        }
      );
    } catch (error) {
      const existingJob = await this.replaceQueue.getJob(task.id).catch(() => null);
      if (!existingJob) {
        await this.rollbackSwapPreparation({
          swapCodeId: redeemCode.id,
          taskId: task.id,
          orderId: order.id,
          originalEmail: oldEmail,
          originalStatus,
          newEmail
        });
      }
      throw error;
    }

    // 5. Mark ACCOUNT_SWAP code USED only after queue succeeds
    // SUBSCRIPTION codes were already marked USED in the transaction
    if (!isSubscription) {
      await this.prisma.redeemCode.updateMany({
        where: { id: redeemCode.id, status: "RESERVED" },
        data: { status: "USED", usedAt: new Date() }
      });
    }

    return {
      orderNo: order.orderNo,
      taskId: task.id,
      status: "TASK_QUEUED",
      message: "Account swap task queued. Your new account will be invited shortly."
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
          // R4-D: Do not expose internal error messages to public endpoint
          hasError: !!latestTask.lastErrorMessage
        }
        : null
    };
  }

  /**
   * Customer self-service account swap by original email.
   * Automatically locates the most recent eligible order for the given email,
   * removing the need for customers to know their order number.
   */
  async swapAccountByEmail(params: {
    swapCode: string;
    originalEmail: string;
    newEmail: string;
  }) {
    const { swapCode, originalEmail, newEmail } = params;
    const normalized = originalEmail.trim().toLowerCase();

    if (!normalized) {
      throw new BadRequestException("Original email cannot be empty");
    }

    // Find the most recent swappable order for this email.
    // We do NOT filter by redeemCode.codeType here because the order may have been
    // created from any code type (including ACCOUNT_SWAP from a prior swap operation).
    // Eligibility is determined by order status and group assignment, not code type.
    // Email is normalized to lowercase for consistent lookup (and stored lowercase since this fix).
    let order = await this.prisma.order.findFirst({
      where: {
        userEmail: normalized,
        status: { in: SWAPPABLE_ORDER_STATUSES },
        familyGroupId: { not: null }
      },
      orderBy: { createdAt: "desc" }
    });

    if (!order) {
      // Fallback: case-insensitive lookup for legacy records stored with mixed-case email.
      // statusList is a compile-time constant (not user input) so $queryRawUnsafe is safe here.
      const statusList = SWAPPABLE_ORDER_STATUSES.map((s) => `'${s}'`).join(",");
      const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT o.id
         FROM "Order" o
         WHERE LOWER(o.userEmail) = ?
           AND o.status IN (${statusList})
           AND o.familyGroupId IS NOT NULL
         ORDER BY o.createdAt DESC
         LIMIT 1`,
        normalized
      );
      if (rows.length > 0) {
        order = await this.prisma.order.findUnique({ where: { id: rows[0].id } });
      }
    }

    // Fallback: member may have been added via admin bulkInvite (no Order record).
    // Look up FamilyMember table and auto-create a bridge Order if member exists in a group.
    if (!order) {
      let fallbackMember: { familyGroupId: string; status: string } | null = null;

      // Exact match
      const member = await this.prisma.familyMember.findFirst({
        where: {
          email: normalized,
          status: { in: ["ACTIVE", "PENDING"] },
          familyGroup: { status: "ACTIVE" }
        },
        select: { familyGroupId: true, status: true },
        orderBy: { createdAt: "desc" }
      });

      if (member) {
        fallbackMember = member;
      } else {
        // Case-insensitive fallback for FamilyMember
        const memberRows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
          `SELECT fm.id FROM FamilyMember fm
           JOIN FamilyGroup fg ON fm.familyGroupId = fg.id
           WHERE LOWER(fm.email) = ?
             AND fm.status IN ('ACTIVE','PENDING')
             AND fg.status = 'ACTIVE'
           ORDER BY fm.createdAt DESC LIMIT 1`,
          normalized
        );
        if (memberRows.length > 0) {
          const record = await this.prisma.familyMember.findUnique({
            where: { id: memberRows[0].id },
            select: { familyGroupId: true, status: true }
          });
          if (record) fallbackMember = record;
        }
      }

      if (fallbackMember) {
        // Before creating a bridge Order, check if there's an existing Order in the
        // same family group that was left in TASK_QUEUED or FAILED by a previous failed
        // swap (its userEmail was changed to the new email during the swap transaction).\n        // If found, correct the email back and reuse it instead of creating a duplicate.
        const stuckOrder = await this.prisma.order.findFirst({
          where: {
            familyGroupId: fallbackMember.familyGroupId,
            status: { in: ["TASK_QUEUED", "FAILED"] },
          },
          orderBy: { updatedAt: "desc" },
        });

        if (stuckOrder) {
          // Restore the original email so the swap can proceed
          await this.prisma.order.update({
            where: { id: stuckOrder.id },
            data: {
              userEmail: normalized,
              status: fallbackMember.status === "ACTIVE"
                ? OrderStatus.COMPLETED
                : OrderStatus.INVITE_SENT,
            },
          });
          order = await this.prisma.order.findUnique({ where: { id: stuckOrder.id } });
        } else {
          // No stuck order — create bridge Order (admin invite scenario)
          const bridgeStatus: OrderStatus =
            fallbackMember.status === "ACTIVE" ? OrderStatus.COMPLETED : OrderStatus.INVITE_SENT;

          const orderNo = `GFA-${Date.now().toString(36).toUpperCase()}-${nanoid(4).toUpperCase()}`;
          order = await this.prisma.order.create({
            data: {
              orderNo,
              userEmail: normalized,
              familyGroupId: fallbackMember.familyGroupId,
              status: bridgeStatus,
              resultMessage: "Auto-created from FamilyMember record (admin invite)"
            }
          });
        }
      }
    }

    if (!order) {
      throw new NotFoundException(
        "No eligible order found for this email. The account may not be in a family group, or the order is in an ineligible status."
      );
    }

    // Delegate to existing swapAccount — all validation, CAS, and audit logic
    // remains unchanged. We just resolved the orderNo from email.
    return this.swapAccount({ swapCode, orderNo: order.orderNo, newEmail });
  }

  /**
   * Subscription self-service swap — long-term (SUBSCRIPTION) code holders
   * can swap their account using the ORIGINAL redeem code (no extra swap code needed).
   *
   * Rate-limited by the code's swapLimit / swapWindowHours settings.
   * Tracked via Order.swapCount and Order.lastSwapAt.
   *
   * Flow:
   *   1. Validate original code is SUBSCRIPTION type and USED status
   *   2. Find the order linked to that code
   *   3. Rate-limit check: count swaps in the rolling window
   *   4. Create REPLACE_MEMBER task
   *   5. Atomically increment swap counter on Order
   */
  async subscriptionSwap(params: {
    originalCode: string;
    newEmail: string;
  }) {
    const { originalCode, newEmail } = params;

    if (!newEmail.trim()) {
      throw new BadRequestException("New email cannot be empty");
    }

    // 1. Find the SUBSCRIPTION code — accept UNUSED (first use) or USED (reuse)
    const normalizedCode = originalCode.trim().toUpperCase();
    const redeemCode = await this.prisma.redeemCode.findUnique({
      where: { code: normalizedCode }
    });

    if (!redeemCode) {
      throw new NotFoundException("Code not found");
    }
    if (String(redeemCode.codeType) !== "SUBSCRIPTION") {
      throw new ForbiddenException("This code is not a subscription code");
    }
    if (redeemCode.status !== "USED" && redeemCode.status !== "UNUSED") {
      throw new BadRequestException(
        "Invalid or expired subscription code"
      );
    }

    // Check code expiry
    if (redeemCode.expiresAt && redeemCode.expiresAt < new Date()) {
      throw new BadRequestException("This subscription code has expired");
    }

    // 2. Find linked order (only exists if the code was previously used via swapAccount)
    const order = await this.prisma.order.findUnique({
      where: { redeemCodeId: redeemCode.id },
      include: { familyGroup: true }
    });

    if (!order) {
      throw new NotFoundException(
        redeemCode.status === "UNUSED"
          ? "This subscription code has not been used yet. Please use swap-account or swap-by-email endpoint for first-time swap."
          : "No order found for this code"
      );
    }

    if (!SWAPPABLE_ORDER_STATUSES.includes(order.status as OrderStatus)) {
      throw new BadRequestException(
        `Order status "${order.status}" does not allow account swap`
      );
    }
    if (!order.familyGroupId || !order.familyGroup) {
      throw new BadRequestException("Order has no assigned family group");
    }

    const normalizedNewEmail = newEmail.trim().toLowerCase();
    if (normalizedNewEmail === order.userEmail.toLowerCase()) {
      throw new BadRequestException("New email is the same as current email");
    }

    // 3. Rate-limit check — rolling window
    const rcAny = redeemCode as any;
    const swapLimit: number = rcAny.swapLimit ?? 2;
    const swapWindowHours: number = rcAny.swapWindowHours ?? 5;

    if (swapLimit > 0) {
      // Count REPLACE_MEMBER tasks in the rolling window
      const windowStart = new Date(Date.now() - swapWindowHours * 60 * 60 * 1000);
      const recentSwaps = await this.prisma.task.count({
        where: {
          orderId: order.id,
          type: "REPLACE_MEMBER",
          createdAt: { gte: windowStart }
        }
      });

      if (recentSwaps >= swapLimit) {
        const nextWindowEnd = new Date(windowStart.getTime() + swapWindowHours * 60 * 60 * 1000 * 2);
        throw new BadRequestException(
          `Swap rate limit exceeded: maximum ${swapLimit} swaps per ${swapWindowHours} hours. Please try again later.`
        );
      }
    }

    // 4. Create swap task atomically
    const group = order.familyGroup;
    const oldEmail = order.userEmail;
    const originalStatus = order.status;

    const { task } = await this.prisma.$transaction(async (tx) => {
      // Update order: new email, increment swap counter
      const claimedOrder = await tx.order.updateMany({
        where: {
          id: order.id,
          familyGroupId: group.id,
          userEmail: oldEmail,
          status: { in: SWAPPABLE_ORDER_STATUSES }
        },
        data: {
          userEmail: normalizedNewEmail,
          status: "TASK_QUEUED",
          swapCount: { increment: 1 },
          lastSwapAt: new Date()
        }
      });

      if (claimedOrder.count === 0) {
        throw new BadRequestException(
          "Order is already being swapped or no longer eligible"
        );
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
            newUserEmail: normalizedNewEmail,
            reason: "SUBSCRIPTION_SWAP"
          })
        }
      });

      return { task };
    });

    // 5. Enqueue — compensate if queue fails
    try {
      await this.replaceQueue.add(
        "replace-member",
        {
          taskId: task.id,
          orderId: order.id,
          familyGroupId: group.id,
          accountId: group.accountId,
          targetMemberEmail: oldEmail,
          newUserEmail: normalizedNewEmail,
          reason: "SUBSCRIPTION_SWAP"
        },
        {
          ...JOB_DEFAULTS,
          jobId: task.id
        }
      );
    } catch (error) {
      const existingJob = await this.replaceQueue.getJob(task.id).catch(() => null);
      if (!existingJob) {
        // Rollback
        await this.prisma.$transaction(async (tx) => {
          await tx.task.deleteMany({ where: { id: task.id, status: "PENDING" } });
          await tx.order.updateMany({
            where: { id: order.id, status: "TASK_QUEUED", userEmail: normalizedNewEmail },
            data: {
              userEmail: oldEmail,
              status: originalStatus as any,
              swapCount: { decrement: 1 }
            }
          });
        });
      }
      throw error;
    }

    return {
      orderNo: order.orderNo,
      taskId: task.id,
      status: "TASK_QUEUED",
      message: "Account swap task queued. Your new account will be invited shortly.",
      swapCount: (order as any).swapCount + 1,
      swapLimit,
      swapWindowHours
    };
  }
}
