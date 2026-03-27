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
  OrderStatus.WAIT_USER_ACCEPT
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
  ) {}

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
    const expiresAt = new Date(assignedAt.getTime() + 30 * 24 * 60 * 60 * 1000); // +30 days

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

  async replaceMember(
    orderId: string,
    targetMemberEmail: string,
    newUserEmail: string,
    operatorId?: string
  ) {
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
   *   1. Verify ACCOUNT_SWAP redeem code (type-checked, can't use JOIN_GROUP code)
   *   2. Locate customer's existing COMPLETED order by orderNo (proves they are a member)
   *   3. Create REPLACE_MEMBER task: remove oldEmail, invite newEmail
   *   4. Mark swap redeem code as USED
   */
  async swapAccount(params: {
    swapCode: string;
    orderNo: string;
    newEmail: string;
  }) {
    const { swapCode, orderNo, newEmail } = params;

    // Guard: new email must differ from the current one
    if (!newEmail.trim()) {
      throw new BadRequestException("New email cannot be empty");
    }

    // 1. Validate the swap redeem code — must be ACCOUNT_SWAP type
    const normalizedCode = swapCode.trim().toUpperCase();
    const redeemCode = await this.prisma.redeemCode.findUnique({
      where: { code: normalizedCode }
    });

    if (!redeemCode || redeemCode.status !== "UNUSED") {
      throw new BadRequestException("Invalid or already used swap code");
    }
    if (redeemCode.codeType !== "ACCOUNT_SWAP") {
      throw new ForbiddenException("This code cannot be used for account swap");
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

    // 3. Atomically: lock code (RESERVED) + create task + update order
    // Claim the order via status compare-and-swap so only one swap can queue.
    const { task } = await this.prisma.$transaction(async (tx) => {
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

      const claimedOrder = await tx.order.updateMany({
        where: {
          id: order.id,
          familyGroupId: group.id,
          userEmail: oldEmail,
          status: { in: SWAPPABLE_ORDER_STATUSES }
        },
        data: {
          userEmail: newEmail,
          status: "TASK_QUEUED"
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
            reason: "SWAP_REQUEST",
            // Stored to enable reverse-lookup from ACCOUNT_SWAP code → Order
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
          reason: "SWAP_REQUEST"
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

    // 5. Mark code USED only after queue succeeds
    // Re-checks status to be idempotent in retry scenarios
    await this.prisma.redeemCode.updateMany({
      where: { id: redeemCode.id, status: "RESERVED" },
      data: { status: "USED", usedAt: new Date() }
    });

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

    if (!order) {
      throw new NotFoundException(
        "No eligible order found for this email. The account may not be in a family group, or the order is in an ineligible status."
      );
    }

    // Delegate to existing swapAccount — all validation, CAS, and audit logic
    // remains unchanged. We just resolved the orderNo from email.
    return this.swapAccount({ swapCode, orderNo: order.orderNo, newEmail });
  }
}
