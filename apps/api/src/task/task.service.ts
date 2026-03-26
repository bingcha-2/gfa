import {
  Injectable,
  NotFoundException,
  BadRequestException
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";

import { PrismaService } from "../prisma/prisma.service";
import { QUEUE_NAMES, TASK_TYPES } from "@gfa/shared";

@Injectable()
export class TaskService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.invite) private readonly inviteQueue: Queue,
    @InjectQueue(QUEUE_NAMES.remove) private readonly removeQueue: Queue,
    @InjectQueue(QUEUE_NAMES.replace) private readonly replaceQueue: Queue,
    @InjectQueue(QUEUE_NAMES.sync) private readonly syncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.health) private readonly healthQueue: Queue
  ) {}

  private getQueue(taskType: string): Queue | null {
    switch (taskType) {
      case TASK_TYPES.inviteMember: return this.inviteQueue;
      case TASK_TYPES.removeMember: return this.removeQueue;
      case TASK_TYPES.replaceMember: return this.replaceQueue;
      case TASK_TYPES.syncFamilyGroup: return this.syncQueue;
      case TASK_TYPES.healthCheckAccount: return this.healthQueue;
      default: return null;
    }
  }

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

    // Reset DB status
    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        status: "PENDING",
        retryCount: { increment: 1 },
        lastErrorCode: null,
        lastErrorMessage: null
      }
    });

    // Re-enqueue the BullMQ job so the worker picks it up
    const queue = this.getQueue(task.type);
    if (queue) {
      // Parse the original payload stored at task creation time
      // This contains task-specific fields like targetMemberEmail, newUserEmail, userEmail, etc.
      let storedPayload: Record<string, unknown> = {};
      try {
        storedPayload = JSON.parse((task as any).payload ?? "{}");
      } catch {
        // Non-fatal: if payload is malformed, fall back to base fields only
      }

      const payload: Record<string, unknown> = {
        // Merge stored payload fields (e.g. targetMemberEmail, newUserEmail, userEmail)
        ...storedPayload,
        // Base fields always override stored payload to ensure consistency
        taskId: task.id,
        familyGroupId: task.familyGroupId,
        accountId: task.accountId,
        orderId: task.orderId,
      };

      await queue.add(task.type, payload, {
        jobId: `retry-${task.id}-${Date.now()}`,
        attempts: 1,
        removeOnComplete: { count: 100 },
        removeOnFail: false,
      });
    }

    return updated;
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
