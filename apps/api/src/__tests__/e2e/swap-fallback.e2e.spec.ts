/**
 * E2E Test: swap-by-email FamilyMember fallback
 *
 * Verifies that members added via admin bulkInvite (no Order record)
 * can still use the swap-by-email endpoint. The system should:
 * 1. Fall back to FamilyMember table when no Order is found
 * 2. Auto-create a bridge Order with correct status
 * 3. Proceed with normal swap flow
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

describe("E2E: swap-by-email FamilyMember fallback", () => {
  const db = getPrisma();

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
    getJob: async () => null,
  };

  let orderService: OrderService;

  beforeAll(() => {
    const redeemCodeService = new RedeemCodeService(db as any);
    const mockSyncQueue = { add: async () => ({ id: "noop" }) };
    const mockRemoveQueue = { add: async () => ({ id: "noop" }) };
    const familyGroupService = new FamilyGroupService(
      db as any,
      mockSyncQueue as any,
      mockRemoveQueue as any,
      mockInviteQueue as any,
      mockReplaceQueue as any
    );
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

  it("should swap an ACTIVE member added via admin (no Order) using FamilyMember fallback", async () => {
    // Arrange: create account + group + member (simulating admin bulkInvite)
    const account = await createTestAccount();
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 3,
    });

    // Directly insert FamilyMember (as admin bulkInvite does — no Order record)
    await db.familyMember.create({
      data: {
        familyGroupId: group.id,
        email: "admin-invited@gmail.com",
        displayName: "Admin Invited",
        role: "member",
        status: "ACTIVE",
      },
    });

    // Create a valid ACCOUNT_SWAP code
    await createTestRedeemCode(undefined, {
      code: "HH-SWAP-FALLBACK-001",
      codeType: "ACCOUNT_SWAP",
    });

    // Act: swap-by-email should find member via FamilyMember fallback
    const result = await orderService.swapAccountByEmail({
      swapCode: "HH-SWAP-FALLBACK-001",
      originalEmail: "admin-invited@gmail.com",
      newEmail: "new-account@gmail.com",
    });

    // Assert: swap task was queued
    expect(result.status).toBe("TASK_QUEUED");
    expect(result.orderNo).toMatch(/^GFA-/);
    expect(result.taskId).toBeTruthy();

    // Assert: bridge Order was auto-created
    const orders = await db.order.findMany({
      where: { orderNo: result.orderNo },
    });
    expect(orders.length).toBe(1);
    // After swapAccount CAS, userEmail should be updated to newEmail
    expect(orders[0].userEmail).toBe("new-account@gmail.com");
    expect(orders[0].familyGroupId).toBe(group.id);

    // Assert: replace task enqueued
    expect(replaceQueueJobs.length).toBe(1);
    expect(replaceQueueJobs[0].targetMemberEmail).toBe("admin-invited@gmail.com");
    expect(replaceQueueJobs[0].newUserEmail).toBe("new-account@gmail.com");

    // Assert: swap code is now USED
    const code = await db.redeemCode.findUnique({
      where: { code: "HH-SWAP-FALLBACK-001" },
    });
    expect(code!.status).toBe("USED");
  });

  it("should swap a PENDING member added via admin (no Order) with INVITE_SENT bridge status", async () => {
    // Arrange: PENDING member (invited but not yet accepted)
    const account = await createTestAccount();
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 3,
    });

    await db.familyMember.create({
      data: {
        familyGroupId: group.id,
        email: "pending-member@gmail.com",
        displayName: "Pending User",
        role: "member",
        status: "PENDING",
      },
    });

    await createTestRedeemCode(undefined, {
      code: "HH-SWAP-PENDING-001",
      codeType: "ACCOUNT_SWAP",
    });

    // Act
    const result = await orderService.swapAccountByEmail({
      swapCode: "HH-SWAP-PENDING-001",
      originalEmail: "pending-member@gmail.com",
      newEmail: "replacement@gmail.com",
    });

    // Assert
    expect(result.status).toBe("TASK_QUEUED");
    expect(replaceQueueJobs.length).toBe(1);
  });

  it("should still fail for emails not in any family group", async () => {
    await createTestRedeemCode(undefined, {
      code: "HH-SWAP-NOGROUP-001",
      codeType: "ACCOUNT_SWAP",
    });

    // No FamilyMember record exists for this email
    await expect(
      orderService.swapAccountByEmail({
        swapCode: "HH-SWAP-NOGROUP-001",
        originalEmail: "nonexistent@gmail.com",
        newEmail: "new@gmail.com",
      })
    ).rejects.toThrow("No eligible order found");
  });

  it("should not fallback to REMOVED members", async () => {
    const account = await createTestAccount();
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 3,
    });

    // Member was removed — should NOT be eligible for swap
    await db.familyMember.create({
      data: {
        familyGroupId: group.id,
        email: "removed-member@gmail.com",
        displayName: "Removed User",
        role: "member",
        status: "REMOVED",
        removedAt: new Date(),
      },
    });

    await createTestRedeemCode(undefined, {
      code: "HH-SWAP-REMOVED-001",
      codeType: "ACCOUNT_SWAP",
    });

    await expect(
      orderService.swapAccountByEmail({
        swapCode: "HH-SWAP-REMOVED-001",
        originalEmail: "removed-member@gmail.com",
        newEmail: "new@gmail.com",
      })
    ).rejects.toThrow("No eligible order found");
  });

  it("should prefer existing Order over FamilyMember fallback", async () => {
    const account = await createTestAccount();
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 3,
    });

    // Create both: FamilyMember record AND an Order record
    await db.familyMember.create({
      data: {
        familyGroupId: group.id,
        email: "has-order@gmail.com",
        displayName: "Has Order",
        role: "member",
        status: "ACTIVE",
      },
    });

    const existingOrder = await db.order.create({
      data: {
        orderNo: "GFA-EXISTING-001",
        userEmail: "has-order@gmail.com",
        familyGroupId: group.id,
        status: "COMPLETED",
      },
    });

    await createTestRedeemCode(undefined, {
      code: "HH-SWAP-HASORDER-001",
      codeType: "ACCOUNT_SWAP",
    });

    const result = await orderService.swapAccountByEmail({
      swapCode: "HH-SWAP-HASORDER-001",
      originalEmail: "has-order@gmail.com",
      newEmail: "new-has-order@gmail.com",
    });

    // Should use the existing order, not create a new bridge order
    expect(result.orderNo).toBe("GFA-EXISTING-001");
    expect(result.status).toBe("TASK_QUEUED");

    // Verify no extra orders were created
    const allOrders = await db.order.findMany({
      where: { familyGroupId: group.id },
    });
    expect(allOrders.length).toBe(1);
    expect(allOrders[0].id).toBe(existingOrder.id);
  });
  it("should match FamilyMember email case-insensitively", async () => {
    const account = await createTestAccount();
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 3,
    });

    // FamilyMember stored with mixed-case email
    await db.familyMember.create({
      data: {
        familyGroupId: group.id,
        email: "MixedCase@Gmail.COM",
        displayName: "Mixed Case",
        role: "member",
        status: "ACTIVE",
      },
    });

    await createTestRedeemCode(undefined, {
      code: "HH-SWAP-CASE-001",
      codeType: "ACCOUNT_SWAP",
    });

    // Swap request uses lowercase
    const result = await orderService.swapAccountByEmail({
      swapCode: "HH-SWAP-CASE-001",
      originalEmail: "mixedcase@gmail.com",
      newEmail: "new-case@gmail.com",
    });

    expect(result.status).toBe("TASK_QUEUED");
    expect(replaceQueueJobs.length).toBe(1);
  });

  it("should NOT fallback to members in DISABLED groups", async () => {
    const account = await createTestAccount();
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 3,
      status: "DISABLED",
    });

    await db.familyMember.create({
      data: {
        familyGroupId: group.id,
        email: "disabled-group@gmail.com",
        displayName: "In Disabled Group",
        role: "member",
        status: "ACTIVE",
      },
    });

    await createTestRedeemCode(undefined, {
      code: "HH-SWAP-DISABLED-001",
      codeType: "ACCOUNT_SWAP",
    });

    await expect(
      orderService.swapAccountByEmail({
        swapCode: "HH-SWAP-DISABLED-001",
        originalEmail: "disabled-group@gmail.com",
        newEmail: "new@gmail.com",
      })
    ).rejects.toThrow("No eligible order found");
  });

  it("should persist bridge Order when swap code is invalid (self-healing)", async () => {
    const account = await createTestAccount();
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 3,
    });

    await db.familyMember.create({
      data: {
        familyGroupId: group.id,
        email: "bridge-persist@gmail.com",
        displayName: "Bridge Persist",
        role: "member",
        status: "ACTIVE",
      },
    });

    // Invalid code — not ACCOUNT_SWAP type
    await createTestRedeemCode(undefined, {
      code: "HH-JOINONLY-001",
      codeType: "JOIN_GROUP",
    });

    // First attempt: should fail because code type is wrong
    await expect(
      orderService.swapAccountByEmail({
        swapCode: "HH-JOINONLY-001",
        originalEmail: "bridge-persist@gmail.com",
        newEmail: "new@gmail.com",
      })
    ).rejects.toThrow(); // ForbiddenException from swapAccount

    // Bridge Order should have been created and persisted
    const bridgeOrders = await db.order.findMany({
      where: { userEmail: "bridge-persist@gmail.com" },
    });
    expect(bridgeOrders.length).toBe(1);
    expect(bridgeOrders[0].resultMessage).toContain("Auto-created");
    // Status should be COMPLETED (member is ACTIVE)
    expect(bridgeOrders[0].status).toBe("COMPLETED");

    // Second attempt with valid code: should use existing bridge Order (no fallback needed)
    await createTestRedeemCode(undefined, {
      code: "HH-SWAP-RETRY-001",
      codeType: "ACCOUNT_SWAP",
    });

    const result = await orderService.swapAccountByEmail({
      swapCode: "HH-SWAP-RETRY-001",
      originalEmail: "bridge-persist@gmail.com",
      newEmail: "new-retry@gmail.com",
    });

    expect(result.status).toBe("TASK_QUEUED");
    // Should reuse the bridge Order, NOT create a second one
    expect(result.orderNo).toBe(bridgeOrders[0].orderNo);
  });

  it("should pick the most recent group when same email exists in multiple groups", async () => {
    const account = await createTestAccount();
    const oldGroup = await createTestFamilyGroup(account.id, {
      groupName: "Old Group",
      availableSlots: 3,
    });

    // Small delay to ensure different createdAt
    await new Promise((r) => setTimeout(r, 50));

    const newGroup = await createTestFamilyGroup(account.id, {
      groupName: "New Group",
      availableSlots: 3,
    });

    // Same email in both groups — REMOVED in old, ACTIVE in new
    await db.familyMember.create({
      data: {
        familyGroupId: oldGroup.id,
        email: "multi-group@gmail.com",
        displayName: "Old Member",
        role: "member",
        status: "REMOVED",
        removedAt: new Date(),
      },
    });

    await db.familyMember.create({
      data: {
        familyGroupId: newGroup.id,
        email: "multi-group@gmail.com",
        displayName: "New Member",
        role: "member",
        status: "ACTIVE",
      },
    });

    await createTestRedeemCode(undefined, {
      code: "HH-SWAP-MULTI-001",
      codeType: "ACCOUNT_SWAP",
    });

    const result = await orderService.swapAccountByEmail({
      swapCode: "HH-SWAP-MULTI-001",
      originalEmail: "multi-group@gmail.com",
      newEmail: "new-multi@gmail.com",
    });

    expect(result.status).toBe("TASK_QUEUED");

    // Bridge Order should be linked to the NEW group (ACTIVE member)
    const bridgeOrder = await db.order.findFirst({
      where: { orderNo: result.orderNo },
    });
    expect(bridgeOrder!.familyGroupId).toBe(newGroup.id);
  });
});
