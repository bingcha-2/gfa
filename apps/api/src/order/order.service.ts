import {
  Injectable,
  NotFoundException,
  BadRequestException
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { nanoid } from "nanoid";

import { PrismaService } from "../prisma/prisma.service";
import { RedeemCodeService } from "../redeem-code/redeem-code.service";
import { FamilyGroupService } from "../family-group/family-group.service";
import { QUEUE_NAMES } from "@gfa/shared";

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

  async findAll(status?: string) {
    const where = status ? { status: status as any } : {};

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

    if (!redeemCode?.order) {
      throw new NotFoundException("Order not found");
    }

    return this.toPublicOrder(redeemCode.order);
  }

  async redeem(code: string, email: string) {
    // 1. Verify redeem code
    const redeemCode = await this.redeemCodeService.verifyAndReserve(code);

    if (!redeemCode) {
      throw new BadRequestException(
        "Invalid or already used redeem code"
      );
    }

    // 2. Create order
    const orderNo = `GFA-${Date.now().toString(36).toUpperCase()}-${nanoid(4).toUpperCase()}`;

    const order = await this.prisma.order.create({
      data: {
        orderNo,
        redeemCodeId: redeemCode.id,
        userEmail: email,
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

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        familyGroupId: groupId,
        status: "GROUP_ASSIGNED",
        assignedAt: new Date()
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
          userEmail: email
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
        userEmail: email
      },
      { removeOnComplete: 100, removeOnFail: 500 }
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
          newUserEmail
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
      { removeOnComplete: 100, removeOnFail: 500 }
    );

    return { queued: true, taskId: task.id };
  }
}
