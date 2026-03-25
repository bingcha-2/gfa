/**
 * Comprehensive tests for TaskService
 *
 * Covers: findAll, findOne, retry, manualComplete, manualFail
 * Edge cases: status validation, order cascade, retry from various states
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  getPrisma,
  cleanDb,
  disconnectDb,
  createTestRedeemCode
} from "../__tests__/helpers";
import { TaskService } from "./task.service";

describe("TaskService", () => {
  let service: TaskService;
  const db = getPrisma();

  beforeAll(() => {
    service = new TaskService(db as any);
  });

  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
    await disconnectDb();
  });

  async function createTask(overrides: Record<string, any> = {}) {
    return db.task.create({
      data: {
        type: "INVITE_MEMBER",
        status: "PENDING",
        payload: "{}",
        ...overrides
      }
    });
  }

  async function createOrderWithTask(
    taskStatus: string,
    orderStatus = "TASK_QUEUED",
    options: {
      redeemCodeId?: string;
    } = {}
  ) {
    const order = await db.order.create({
      data: {
        orderNo: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        userEmail: "test@example.com",
        status: orderStatus as any,
        redeemCodeId: options.redeemCodeId
      }
    });

    const task = await db.task.create({
      data: {
        type: "INVITE_MEMBER",
        orderId: order.id,
        status: taskStatus as any,
        payload: "{}"
      }
    });

    return { order, task };
  }

  describe("findAll", () => {
    it("should filter by status", async () => {
      await createTask({ status: "PENDING" });
      await createTask({ status: "SUCCESS" });
      await createTask({ status: "PENDING" });

      const pending = await service.findAll({ status: "PENDING" });
      expect(pending).toHaveLength(2);
    });

    it("should filter by type", async () => {
      await createTask({ type: "INVITE_MEMBER" });
      await createTask({ type: "SYNC_FAMILY_GROUP" });

      const invites = await service.findAll({ type: "INVITE_MEMBER" });
      expect(invites).toHaveLength(1);
    });
  });

  describe("findOne", () => {
    it("should include logs", async () => {
      const task = await createTask();
      await db.taskLog.create({
        data: {
          taskId: task.id,
          level: "INFO",
          message: "Started"
        }
      });

      const found = await service.findOne(task.id);
      expect(found.logs).toHaveLength(1);
      expect(found.logs[0].message).toBe("Started");
    });

    it("should throw for nonexistent task", async () => {
      await expect(service.findOne("nonexistent")).rejects.toThrow(
        "Task not found"
      );
    });
  });

  // ---- retry ----

  describe("retry", () => {
    it("should retry FAILED_RETRYABLE task", async () => {
      const task = await createTask({
        status: "FAILED_RETRYABLE",
        lastErrorMessage: "timeout"
      });

      const result = await service.retry(task.id);
      expect(result.status).toBe("PENDING");
      expect(result.retryCount).toBe(1);
      expect(result.lastErrorMessage).toBeNull();
    });

    it("should retry MANUAL_REVIEW task", async () => {
      const task = await createTask({ status: "MANUAL_REVIEW" });
      const result = await service.retry(task.id);
      expect(result.status).toBe("PENDING");
    });

    it("should retry FAILED_FINAL task", async () => {
      const task = await createTask({ status: "FAILED_FINAL" });
      const result = await service.retry(task.id);
      expect(result.status).toBe("PENDING");
    });

    it("should reject retry for PENDING task", async () => {
      const task = await createTask({ status: "PENDING" });
      await expect(service.retry(task.id)).rejects.toThrow(
        "Cannot retry task in status: PENDING"
      );
    });

    it("should reject retry for RUNNING task", async () => {
      const task = await createTask({ status: "RUNNING" });
      await expect(service.retry(task.id)).rejects.toThrow(
        "Cannot retry task in status: RUNNING"
      );
    });

    it("should reject retry for SUCCESS task", async () => {
      const task = await createTask({ status: "SUCCESS" });
      await expect(service.retry(task.id)).rejects.toThrow(
        "Cannot retry task in status: SUCCESS"
      );
    });

    it("should increment retryCount each time", async () => {
      const task = await createTask({
        status: "FAILED_RETRYABLE",
        retryCount: 2
      });

      const result = await service.retry(task.id);
      expect(result.retryCount).toBe(3);
    });
  });

  // ---- manualComplete ----

  describe("manualComplete", () => {
    it("should complete MANUAL_REVIEW task", async () => {
      const task = await createTask({ status: "MANUAL_REVIEW" });
      const result = await service.manualComplete(task.id);
      expect(result.status).toBe("SUCCESS");
      expect(result.finishedAt).not.toBeNull();
    });

    it("should complete FAILED_FINAL task", async () => {
      const task = await createTask({ status: "FAILED_FINAL" });
      const result = await service.manualComplete(task.id);
      expect(result.status).toBe("SUCCESS");
    });

    it("should cascade to order when linked", async () => {
      const { order, task } = await createOrderWithTask("MANUAL_REVIEW");

      await service.manualComplete(task.id, "Resolved manually");

      const updatedOrder = await db.order.findUnique({
        where: { id: order.id }
      });
      expect(updatedOrder!.status).toBe("COMPLETED");
      expect(updatedOrder!.resultMessage).toBe("Resolved manually");
    });

    it("should mark linked redeem code as USED when completing order", async () => {
      const redeemCode = await createTestRedeemCode(undefined, {
        status: "RESERVED"
      });
      const { task } = await createOrderWithTask("MANUAL_REVIEW", "TASK_QUEUED", {
        redeemCodeId: redeemCode.id
      });

      await service.manualComplete(task.id, "Invite sent");

      const updatedCode = await db.redeemCode.findUnique({
        where: { id: redeemCode.id }
      });

      expect(updatedCode!.status).toBe("USED");
      expect(updatedCode!.usedAt).not.toBeNull();
    });

    it("should reject for PENDING task", async () => {
      const task = await createTask({ status: "PENDING" });
      await expect(service.manualComplete(task.id)).rejects.toThrow(
        "Cannot manual-complete task in status: PENDING"
      );
    });

    it("should reject for SUCCESS task", async () => {
      const task = await createTask({ status: "SUCCESS" });
      await expect(service.manualComplete(task.id)).rejects.toThrow(
        "Cannot manual-complete task in status: SUCCESS"
      );
    });
  });

  // ---- manualFail ----

  describe("manualFail", () => {
    it("should fail MANUAL_REVIEW task", async () => {
      const task = await createTask({ status: "MANUAL_REVIEW" });
      const result = await service.manualFail(task.id, "Customer cancelled");
      expect(result.status).toBe("FAILED_FINAL");
      expect(result.lastErrorMessage).toBe("Customer cancelled");
      expect(result.finishedAt).not.toBeNull();
    });

    it("should cascade to order when linked", async () => {
      const { order, task } = await createOrderWithTask("MANUAL_REVIEW");

      await service.manualFail(task.id, "Unreachable user");

      const updatedOrder = await db.order.findUnique({
        where: { id: order.id }
      });
      expect(updatedOrder!.status).toBe("FAILED");
      expect(updatedOrder!.resultMessage).toBe("Unreachable user");
    });

    it("should reject for PENDING task", async () => {
      const task = await createTask({ status: "PENDING" });
      await expect(service.manualFail(task.id)).rejects.toThrow(
        "Cannot manual-fail task in status: PENDING"
      );
    });

    it("should reject for FAILED_FINAL (already failed)", async () => {
      const task = await createTask({ status: "FAILED_FINAL" });
      await expect(service.manualFail(task.id)).rejects.toThrow(
        "Cannot manual-fail task in status: FAILED_FINAL"
      );
    });

    it("should use default message when reason not provided", async () => {
      const task = await createTask({ status: "MANUAL_REVIEW" });
      const result = await service.manualFail(task.id);
      expect(result.lastErrorMessage).toBe("Manually marked as failed");
    });
  });
});
