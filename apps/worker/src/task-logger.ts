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
    }

    await this.prisma.task.update({
      where: { id: this.taskId },
      data,
    });
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
      }
    });
  }

  /**
   * Record a screenshot path on the task.
   */
  async recordScreenshot(
    field: "beforeScreenshotPath" | "afterScreenshotPath" | "errorScreenshotPath",
    path: string
  ): Promise<void> {
    await this.prisma.task.update({
      where: { id: this.taskId },
      data: { [field]: path },
    });
  }
}
