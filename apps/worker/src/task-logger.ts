/**
 * Structured task logger and status updater.
 *
 * Each processor creates a TaskLogger instance bound to a specific task ID.
 * It writes structured logs to the TaskLog table and updates Task status
 * in the database.
 */

import { PrismaClient } from "@prisma/client";
import type { TaskStatusValue } from "@gfa/shared";

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

export class TaskLogger {
  constructor(
    private prisma: PrismaClient,
    private taskId: string,
    private workerId: string
  ) {}

  getTaskId(): string {
    return this.taskId;
  }

  /**
   * Write a log entry to the TaskLog table.
   */
  async log(level: LogLevel, message: string, extra?: unknown): Promise<void> {
    const extraStr = extra ? JSON.stringify(extra) : undefined;
    const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
    const prefix = `[${ts}][worker:${this.workerId}][task:${this.taskId}]`;
    const consoleMsg = `${prefix} ${level}: ${message}`;

    if (level === "ERROR") {
      console.error(consoleMsg);
    } else if (level === "DEBUG") {
      console.debug(consoleMsg);
    } else {
      console.log(consoleMsg);
    }


    try {
      await this.prisma.taskLog.create({
        data: {
          taskId: this.taskId,
          level,
          message,
          extra: extraStr,
        },
      });
    } catch (err) {
      // Don't let logging failures crash the processor
      console.error(`${prefix} Failed to write TaskLog:`, err);
    }
  }

  /**
   * Update the task's status and optionally record an error.
   */
  async updateStatus(
    status: TaskStatusValue,
    error?: { code?: string; message?: string }
  ): Promise<void> {
    await this.log("INFO", `Status → ${status}`);

    const data: Record<string, unknown> = {
      status,
      workerId: this.workerId,
    };

    if (status === "RUNNING") {
      data.startedAt = new Date();
    }

    if (status !== "PENDING" && status !== "RUNNING") {
      data.finishedAt = new Date();
    }

    if (error) {
      data.lastErrorCode = error.code ?? null;
      data.lastErrorMessage = error.message ?? null;
    } else if (status === "SUCCESS") {
      // Clear stale error fields from previous failed attempts
      data.lastErrorCode = null;
      data.lastErrorMessage = null;
    }

    await this.prisma.task.update({
      where: { id: this.taskId },
      data,
    });

    // When a task succeeds, auto-cancel older failed siblings of the same
    // type + familyGroupId so the dashboard stays clean.
    const SUCCESS_STATUSES: TaskStatusValue[] = [
      "SUCCESS", "INVITE_SENT", "REPLACED_AND_INVITE_SENT",
    ];
    if (SUCCESS_STATUSES.includes(status)) {
      await this.supersedeSiblingTasks().catch((err) => {
        console.warn(
          `[task:${this.taskId}] supersedeSiblingTasks failed (non-fatal):`,
          err instanceof Error ? err.message : String(err)
        );
      });
    }
  }

  /**
   * Cancel older sibling tasks (same type + familyGroupId) that are stuck
   * in a failed/retryable/manual-review state. Called automatically when
   * this task succeeds.
   */
  private async supersedeSiblingTasks(): Promise<void> {
    // Fetch this task's metadata to know what to match against
    const self = await this.prisma.task.findUnique({
      where: { id: this.taskId },
      select: { type: true, familyGroupId: true, payload: true },
    });

    if (!self?.familyGroupId) return; // nothing to supersede without a group

    const where: Record<string, unknown> = {
      type: self.type,
      familyGroupId: self.familyGroupId,
      id: { not: this.taskId },
      status: {
        in: ["FAILED_RETRYABLE", "FAILED_FINAL", "MANUAL_REVIEW"],
      },
    };

    // For member-specific tasks, scope the cleanup to the same member email
    try {
      const payload = JSON.parse(self.payload ?? "{}");
      const memberEmail =
        payload.memberEmail || payload.targetMemberEmail || payload.userEmail;
      if (memberEmail) {
        where.payload = { contains: memberEmail };
      }
    } catch { /* ignore parse errors */ }

    const now = new Date();
    const obsolete = await this.prisma.task.findMany({
      where,
      select: { id: true, orderId: true },
    });

    if (obsolete.length === 0) return;

    await this.prisma.task.updateMany({
      where: { id: { in: obsolete.map((t) => t.id) } },
      data: {
        status: "CANCELLED",
        lastErrorCode: "SUPERSEDED",
        lastErrorMessage: `被新的成功任务取代 (${this.taskId.slice(0, 12)})`,
        finishedAt: now,
      },
    });

    // Fail linked orders that are still in non-terminal states
    const orderIds = obsolete
      .map((t) => t.orderId)
      .filter((id): id is string => !!id);
    if (orderIds.length > 0) {
      await this.prisma.order.updateMany({
        where: {
          id: { in: orderIds },
          status: {
            in: [
              "CREATED", "CODE_VERIFIED", "GROUP_ASSIGNED",
              "TASK_QUEUED", "TASK_RUNNING", "MANUAL_REVIEW",
            ],
          },
        },
        data: {
          status: "FAILED",
          resultMessage: "任务已被新的成功执行取代",
        },
      });
    }

    console.log(
      `[task:${this.taskId}] Superseded ${obsolete.length} obsolete sibling task(s)`
    );
  }

  /**
   * Update the linked order status (if orderId provided).
   */
  async updateOrderStatus(
    orderId: string,
    status: string,
    resultMessage?: string
  ): Promise<void> {
    const updatedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.update({
        where: { id: orderId },
        data: {
          status: status as any,
          resultMessage
        },
        select: {
          redeemCodeId: true
        }
      });

      if (
        order.redeemCodeId &&
        (status === "INVITE_SENT" || status === "COMPLETED")
      ) {
        // Success: mark the redeem code as USED
        await tx.redeemCode.updateMany({
          where: {
            id: order.redeemCodeId,
            status: { not: "USED" }
          },
          data: {
            status: "USED",
            usedAt: updatedAt
          }
        });
      } else if (
        order.redeemCodeId &&
        status === "FAILED"
      ) {
        // Failure: roll RESERVED code back to UNUSED so the customer can reuse it
        await tx.redeemCode.updateMany({
          where: {
            id: order.redeemCodeId,
            status: "RESERVED"
          },
          data: {
            status: "UNUSED",
            usedAt: null
          }
        });
      }
    });
  }

  /**
   * Record a screenshot path on the task.
   */
  async recordScreenshot(
    field: "beforeScreenshotPath" | "afterScreenshotPath" | "errorScreenshotPath",
    path: string | null
  ): Promise<void> {
    if (!path) return;
    await this.prisma.task.update({
      where: { id: this.taskId },
      data: { [field]: path },
    });
  }
}
