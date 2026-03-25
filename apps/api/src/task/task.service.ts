import {
  Injectable,
  NotFoundException,
  BadRequestException
} from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class TaskService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(params?: { status?: string; type?: string }) {
    const where: Record<string, unknown> = {};

    if (params?.status) where.status = params.status;
    if (params?.type) where.type = params.type;

    return this.prisma.task.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        order: { select: { id: true, orderNo: true, userEmail: true } },
        familyGroup: { select: { id: true, groupName: true } },
        account: { select: { id: true, name: true } }
      }
    });
  }

  async findOne(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: {
        order: true,
        familyGroup: true,
        account: true,
        logs: { orderBy: { createdAt: "desc" } }
      }
    });

    if (!task) throw new NotFoundException("Task not found");

    return task;
  }

  async retry(id: string) {
    const task = await this.findOne(id);

    if (
      task.status !== "FAILED_RETRYABLE" &&
      task.status !== "FAILED_FINAL" &&
      task.status !== "MANUAL_REVIEW"
    ) {
      throw new BadRequestException(
        `Cannot retry task in status: ${task.status}`
      );
    }

    return this.prisma.task.update({
      where: { id },
      data: {
        status: "PENDING",
        retryCount: { increment: 1 },
        lastErrorCode: null,
        lastErrorMessage: null
      }
    });
  }

  async manualComplete(id: string, resultMessage?: string) {
    const task = await this.findOne(id);

    if (task.status !== "MANUAL_REVIEW" && task.status !== "FAILED_FINAL") {
      throw new BadRequestException(
        `Cannot manual-complete task in status: ${task.status}`
      );
    }

    const finishedAt = new Date();

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id },
        data: {
          status: "SUCCESS",
          finishedAt
        }
      });

      // Update order status if linked
      if (task.orderId) {
        await tx.order.update({
          where: { id: task.orderId },
          data: {
            status: "COMPLETED",
            resultMessage: resultMessage ?? "Manually completed"
          }
        });
      }

      if (task.order?.redeemCodeId) {
        await tx.redeemCode.updateMany({
          where: {
            id: task.order.redeemCodeId,
            status: { not: "USED" }
          },
          data: {
            status: "USED",
            usedAt: finishedAt
          }
        });
      }

      return updated;
    });
  }

  async manualFail(id: string, reason?: string) {
    const task = await this.findOne(id);

    if (task.status !== "MANUAL_REVIEW") {
      throw new BadRequestException(
        `Cannot manual-fail task in status: ${task.status}`
      );
    }

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        status: "FAILED_FINAL",
        lastErrorMessage: reason ?? "Manually marked as failed",
        finishedAt: new Date()
      }
    });

    if (task.orderId) {
      await this.prisma.order.update({
        where: { id: task.orderId },
        data: {
          status: "FAILED",
          resultMessage: reason ?? "Manually marked as failed"
        }
      });
    }

    return updated;
  }
}
