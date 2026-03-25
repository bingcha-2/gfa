/**
 * API E2E Test: Redeem Flow
 *
 * Verifies the full redeem lifecycle at the Service layer:
 * RedeemCode → Order creation → FamilyGroup assignment →
 * Task creation → BullMQ job enqueued.
 *
 * Uses real SQLite DB. BullMQ Queues are mocked (no Redis needed).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  cleanDb,
  createTestAccount,
  createTestFamilyGroup,
  createTestRedeemCode,
  disconnectDb,
  getPrisma,
} from "../helpers";
import { OrderService } from "../../order/order.service";
import { RedeemCodeService } from "../../redeem-code/redeem-code.service";
import { FamilyGroupService } from "../../family-group/family-group.service";

describe("E2E: Redeem Flow", () => {
  const db = getPrisma();

  // Track mock queue calls
  let inviteQueueJobs: any[] = [];
  let replaceQueueJobs: any[] = [];

  const mockInviteQueue = {
    add: async (_name: string, data: any, _opts?: any) => {
      inviteQueueJobs.push(data);
      return { id: `invite-job-${Date.now()}` };
    },
  };

  const mockReplaceQueue = {
    add: async (_name: string, data: any, _opts?: any) => {
      replaceQueueJobs.push(data);
      return { id: `replace-job-${Date.now()}` };
    },
  };

  let orderService: OrderService;
  let redeemCodeService: RedeemCodeService;
  let familyGroupService: FamilyGroupService;

  beforeAll(() => {
    redeemCodeService = new RedeemCodeService(db as any);
    const mockSyncQueue = { add: async () => ({ id: "noop" }) };
    const mockRemoveQueue = { add: async () => ({ id: "noop" }) };
    familyGroupService = new FamilyGroupService(db as any, mockSyncQueue as any, mockRemoveQueue as any);
    orderService = new OrderService(
      db as any,
      redeemCodeService,
      familyGroupService,
      mockInviteQueue as any,
      mockReplaceQueue as any
    );
  });

  afterEach(async () => {
    inviteQueueJobs = [];
    replaceQueueJobs = [];
    await cleanDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it("should complete full redeem flow: code → order → group assign → task → queue", async () => {
    // Arrange
    const account = await createTestAccount();
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 3,
    });
    const code = await createTestRedeemCode(undefined, {
      code: "E2E-REDEEM-001",
    });

    // Act
    const result = await orderService.redeem("E2E-REDEEM-001", "e2e-buyer@gmail.com");

    // Assert: result
    expect(result.status).toBe("TASK_QUEUED");
    expect(result.orderNo).toMatch(/^GFA-/);

    // Assert: Order in DB
    const orders = await db.order.findMany({
      where: { userEmail: "e2e-buyer@gmail.com" },
      include: { tasks: true },
    });
    expect(orders.length).toBe(1);
    expect(orders[0].status).toBe("TASK_QUEUED");
    expect(orders[0].familyGroupId).toBe(group.id);
    expect(orders[0].redeemCodeId).toBe(code.id);

    // Assert: Task created
    expect(orders[0].tasks.length).toBe(1);
    expect(orders[0].tasks[0].type).toBe("INVITE_MEMBER");
    expect(orders[0].tasks[0].status).toBe("PENDING");
    expect(orders[0].tasks[0].familyGroupId).toBe(group.id);
    expect(orders[0].tasks[0].accountId).toBe(account.id);

    // Assert: Task payload
    const payload = JSON.parse(orders[0].tasks[0].payload);
    expect(payload.userEmail).toBe("e2e-buyer@gmail.com");
    expect(payload.familyGroupId).toBe(group.id);

    // Assert: BullMQ job was enqueued
    expect(inviteQueueJobs.length).toBe(1);
    expect(inviteQueueJobs[0].userEmail).toBe("e2e-buyer@gmail.com");
    expect(inviteQueueJobs[0].taskId).toBe(orders[0].tasks[0].id);

    // Assert: FamilyGroup slots decremented
    const updatedGroup = await db.familyGroup.findUnique({
      where: { id: group.id },
    });
    expect(updatedGroup!.availableSlots).toBe(2);
    expect(updatedGroup!.pendingInviteCount).toBe(1);

    // Assert: RedeemCode status is RESERVED (not USED yet)
    const updatedCode = await db.redeemCode.findUnique({
      where: { id: code.id },
    });
    expect(updatedCode!.status).toBe("RESERVED");
  });

  it("should set order to MANUAL_REVIEW when no groups available", async () => {
    // No accounts/groups — nothing available
    const code = await createTestRedeemCode(undefined, {
      code: "E2E-NO-GROUP-001",
    });

    const result = await orderService.redeem("E2E-NO-GROUP-001", "no-group@gmail.com");

    expect(result.status).toBe("MANUAL_REVIEW");
    expect(inviteQueueJobs.length).toBe(0);

    const order = await db.order.findFirst({
      where: { userEmail: "no-group@gmail.com" },
    });
    expect(order!.status).toBe("MANUAL_REVIEW");
    expect(order!.familyGroupId).toBeNull();
  });

  it("should reject an already used redeem code", async () => {
    await createTestRedeemCode(undefined, {
      code: "E2E-USED-001",
      status: "USED",
    });

    await expect(
      orderService.redeem("E2E-USED-001", "reuse@gmail.com")
    ).rejects.toThrow("Invalid or already used redeem code");
  });

  it("should reject a nonexistent redeem code", async () => {
    await expect(
      orderService.redeem("NONEXISTENT-CODE", "fake@gmail.com")
    ).rejects.toThrow("Invalid or already used redeem code");
  });

  it("should correctly select from multiple groups (picks one with available slots)", async () => {
    const account = await createTestAccount();
    // Group with 0 slots (full)
    await createTestFamilyGroup(account.id, {
      groupName: "Full Group",
      availableSlots: 0,
    });
    // Group with available slots
    const availableGroup = await createTestFamilyGroup(account.id, {
      groupName: "Available Group",
      availableSlots: 3,
    });

    const code = await createTestRedeemCode(undefined, {
      code: "E2E-MULTI-GROUP-001",
    });

    const result = await orderService.redeem("E2E-MULTI-GROUP-001", "multi@gmail.com");

    expect(result.status).toBe("TASK_QUEUED");

    const order = await db.order.findFirst({
      where: { userEmail: "multi@gmail.com" },
    });
    expect(order!.familyGroupId).toBe(availableGroup.id);
  });
});
