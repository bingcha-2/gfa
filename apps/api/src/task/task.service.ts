import {
  Injectable,
  NotFoundException,
  BadRequestException
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";

import { PrismaService } from "../prisma/prisma.service";
import { QUEUE_NAMES, TASK_TYPES, JOB_DEFAULTS } from "@gfa/shared";

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

  async findAll(params?: { status?: string; type?: string; search?: string; page?: number; pageSize?: number }) {
    const where: Record<string, unknown> = {
      // Exclude scheduler and expire-scan tasks from regular task list
      source: { notIn: ["scheduler", "expire-scan"] },
    };

    if (params?.status) where.status = params.status;
    if (params?.type) where.type = params.type;

    // Server-side fuzzy search across key fields
    if (params?.search?.trim()) {
      const q = params.search.trim();
      where.OR = [
        { id: { contains: q } },
        { payload: { contains: q } },
        { lastErrorCode: { contains: q } },
        { lastErrorMessage: { contains: q } },
        { order: { orderNo: { contains: q } } },
        { order: { userEmail: { contains: q } } },
        { account: { name: { contains: q } } },
        { account: { loginEmail: { contains: q } } },
        { familyGroup: { groupName: { contains: q } } },
      ];
    }

    const page = Math.max(params?.page ?? 1, 1);
    const pageSize = Math.min(Math.max(params?.pageSize ?? 50, 1), 200);

    const [items, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          type: true,
          status: true,
          priority: true,
          retryCount: true,
          maxRetryCount: true,
          payload: true,
          lastErrorCode: true,
          lastErrorMessage: true,
          startedAt: true,
          finishedAt: true,
          createdAt: true,
          updatedAt: true,
          order: { select: { id: true, orderNo: true, userEmail: true } },
          familyGroup: { select: { id: true, groupName: true } },
          account: { select: { id: true, name: true } },
        }
      }),
      this.prisma.task.count({ where }),
    ]);

    return { items, total };
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
      task.status !== "PENDING" &&
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
        ...JOB_DEFAULTS,
        jobId: `retry-${task.id}-${Date.now()}`,
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

  /**
   * Cancel a task that is stuck retrying or waiting.
   * Marks DB status as CANCELLED and attempts to remove pending BullMQ jobs.
   */
  async cancel(id: string, reason?: string) {
    const task = await this.findOne(id);

    // Allow cancelling tasks that are still active (not yet succeeded or already cancelled)
    const cancellableStatuses = [
      "PENDING", "RUNNING", "FAILED_RETRYABLE", "FAILED_FINAL", "MANUAL_REVIEW",
    ];
    if (!cancellableStatuses.includes(task.status)) {
      throw new BadRequestException(
        `Cannot cancel task in status: ${task.status}`
      );
    }

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        status: "CANCELLED",
        lastErrorCode: "CANCELLED",
        lastErrorMessage: reason ?? "Cancelled by operator",
        finishedAt: new Date(),
      },
    });

    // Mark linked order as FAILED so it doesn't remain stuck
    if (task.orderId) {
      await this.prisma.order.update({
        where: { id: task.orderId },
        data: {
          status: "FAILED",
          resultMessage: reason ?? "Task cancelled by operator",
        },
      });
    }

    // Best-effort: remove any pending/delayed BullMQ jobs for this task
    const queue = this.getQueue(task.type);
    if (queue) {
      try {
        // Check waiting and delayed jobs for any that reference this taskId
        const [waiting, delayed] = await Promise.all([
          queue.getJobs(["waiting", "wait"]),
          queue.getJobs(["delayed"]),
        ]);
        const allJobs = [...waiting, ...delayed].filter(Boolean);
        for (const job of allJobs) {
          if (job.data?.taskId === id) {
            await job.remove().catch(() => {});
          }
        }
      } catch {
        // Non-fatal: if BullMQ cleanup fails, DB status is already CANCELLED
      }
    }

    return updated;
  }
}
