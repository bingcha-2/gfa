/**
 * API E2E Test: Replace Flow
 *
 * Verifies the replace-member lifecycle at the Service layer:
 * Existing order → replaceMember() → Task creation → BullMQ job enqueued.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  cleanDb,
  createTestAccount,
  createTestFamilyGroup,
  disconnectDb,
  getPrisma,
} from "../helpers";
import { OrderService } from "../../order/order.service";

describe("E2E: Replace Flow", () => {
  const db = getPrisma();

  let replaceQueueJobs: any[] = [];

  const mockInviteQueue = {
    add: async () => ({ id: "noop" }),
  };

  const mockReplaceQueue = {
    add: async (_name: string, data: any, _opts?: any) => {
      replaceQueueJobs.push(data);
      return { id: `replace-job-${Date.now()}` };
    },
  };

  let orderService: OrderService;

  beforeAll(() => {
    orderService = new OrderService(
      db as any,
      { verifyAndReserve: async () => null, markUsed: async () => {} } as any,
      { findAvailableGroup: async () => null } as any,
      mockInviteQueue as any,
      mockReplaceQueue as any
    );
  });

  afterEach(async () => {
    replaceQueueJobs = [];
    await cleanDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it("should create a REPLACE_MEMBER task and enqueue it", async () => {
    // Arrange: existing order with a group
    const account = await createTestAccount();
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 0,
    });

    const order = await db.order.create({
      data: {
        orderNo: "GFA-REPLACE-E2E-001",
        userEmail: "replace-buyer@gmail.com",
        familyGroupId: group.id,
        status: "INVITE_SENT",
      },
    });

    // Act
    const result = await orderService.replaceMember(
      order.id,
      "old-member@gmail.com",
      "new-member@gmail.com"
    );

    // Assert
    expect(result.queued).toBe(true);
    expect(result.taskId).toBeDefined();

    // Assert: Task in DB
    const task = await db.task.findUnique({ where: { id: result.taskId } });
    expect(task).not.toBeNull();
    expect(task!.type).toBe("REPLACE_MEMBER");
    expect(task!.orderId).toBe(order.id);
    expect(task!.familyGroupId).toBe(group.id);
    expect(task!.accountId).toBe(account.id);

    // Assert: Payload
    const payload = JSON.parse(task!.payload);
    expect(payload.targetMemberEmail).toBe("old-member@gmail.com");
    expect(payload.newUserEmail).toBe("new-member@gmail.com");

    // Assert: BullMQ job
    expect(replaceQueueJobs.length).toBe(1);
    expect(replaceQueueJobs[0].targetMemberEmail).toBe("old-member@gmail.com");
    expect(replaceQueueJobs[0].newUserEmail).toBe("new-member@gmail.com");
  });

  it("should reject replace when order has no family group", async () => {
    const order = await db.order.create({
      data: {
        orderNo: "GFA-REPLACE-E2E-002",
        userEmail: "no-group-replace@gmail.com",
        status: "MANUAL_REVIEW",
      },
    });

    await expect(
      orderService.replaceMember(order.id, "old@gmail.com", "new@gmail.com")
    ).rejects.toThrow("Order has no assigned family group");

    expect(replaceQueueJobs.length).toBe(0);
  });

  it("should reject replace for nonexistent order", async () => {
    await expect(
      orderService.replaceMember(
        "nonexistent-order-id",
        "old@gmail.com",
        "new@gmail.com"
      )
    ).rejects.toThrow("Order not found");
  });
});
