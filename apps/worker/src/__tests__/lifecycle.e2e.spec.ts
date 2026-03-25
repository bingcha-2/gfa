/**
 * Full Lifecycle E2E Test: Customer Redeem → Group Selection → Invite Automation
 *
 * Tests the REAL customer flow:
 *   1. Customer enters redeem code + their email
 *   2. System finds earliest created family group with available slots (Account HEALTHY)
 *   3. API creates Order + Task, enqueues invite job
 *   4. Worker processInvite executes browser automation (mocked)
 *   5. Final DB: Task=INVITE_SENT, Order=INVITE_SENT, Code=USED
 *
 * Located in Worker test directory for correct vi.mock resolution.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock browser-context (same pattern as other Worker specs)
vi.mock("../browser-context", () => {
  class InlineMockWorkerBrowser {
    async connect() { return createFakePage(); }
    getPage() { return createFakePage(); }
    async takeScreenshot() { return "/tmp/fake-screenshot.png"; }
    async navigateTo() {}
    async disconnect() {}
  }
  function createFakePage(): any {
    const mkLoc = (): any => ({
      count: async () => 1,
      first: () => mkLoc(),
      last: () => mkLoc(),
      nth: () => mkLoc(),
      click: async () => {},
      fill: async () => {},
      press: async () => {},
      textContent: async () => "",
      locator: () => mkLoc(),
    });
    return {
      goto: async () => {},
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      url: () => "https://myaccount.google.com/family/details",
      locator: () => mkLoc(),
      evaluate: async () => [],
      screenshot: async () => Buffer.from(""),
    };
  }
  return { WorkerBrowser: InlineMockWorkerBrowser };
});

import { processInvite } from "../processors/invite.processor";
import {
  cleanDb,
  disconnectDb,
  getPrisma,
  createTestAccount,
  createTestFamilyGroup,
  createMockJob,
} from "./helpers";
import { MockAdsPowerClient } from "./mock-adspower";
import { MockProfileLock } from "./mock-profile-lock";

describe("Customer Lifecycle: Redeem Code → Invite to Family Group", () => {
  const db = getPrisma();
  const mockAdspower = new MockAdsPowerClient();
  const mockLock = new MockProfileLock();
  const workerId = "e2e-lifecycle-worker";

  afterEach(async () => {
    mockAdspower.reset();
    mockLock.reset();
    await cleanDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  /**
   * Simulates the API-side of OrderService.redeem():
   * 1. RedeemCode: UNUSED → RESERVED
   * 2. Order: created with status TASK_QUEUED
   * 3. FamilyGroup: availableSlots decremented, pendingInviteCount incremented
   * 4. Task: INVITE_MEMBER, status PENDING
   * 5. Returns the queue payload that BullMQ would carry
   *
   * This mirrors the exact data contract of OrderService.redeem().
   */
  async function simulateApiRedeem(
    userEmail: string,
    account: { id: string },
    group: { id: string }
  ) {
    const ts = Date.now();

    // Step 1: Reserve code
    const redeemCode = await db.redeemCode.create({
      data: {
        code: `CODE-${ts}`,
        product: "GOOGLE_ONE",
        status: "RESERVED",
      },
    });

    // Step 2: Create order
    const order = await db.order.create({
      data: {
        orderNo: `GFA-${ts.toString(36).toUpperCase()}`,
        redeemCodeId: redeemCode.id,
        userEmail,
        familyGroupId: group.id,
        assignedAt: new Date(),
        status: "TASK_QUEUED",
      },
    });

    // Step 3: Decrement group slots
    await db.familyGroup.update({
      where: { id: group.id },
      data: {
        availableSlots: { decrement: 1 },
        pendingInviteCount: { increment: 1 },
      },
    });

    // Step 4: Create task
    const task = await db.task.create({
      data: {
        type: "INVITE_MEMBER",
        orderId: order.id,
        familyGroupId: group.id,
        accountId: account.id,
        payload: JSON.stringify({
          orderId: order.id,
          familyGroupId: group.id,
          accountId: account.id,
          userEmail,
        }),
      },
    });

    // Step 5: Queue payload (exact same shape as OrderService.redeem)
    const queuePayload = {
      taskId: task.id,
      orderId: order.id,
      familyGroupId: group.id,
      accountId: account.id,
      userEmail,
    };

    return { order, task, redeemCode, queuePayload };
  }

  it("Customer redeems code → system invites to group → all DB states correct", async () => {
    // ========================
    // Setup: 1 healthy account, 1 group with 5 available slots
    // ========================
    const account = await createTestAccount({
      adspowerProfileId: "profile-customer-001",
    });
    await db.account.update({
      where: { id: account.id },
      data: { status: "HEALTHY" },
    });
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 5,
      groupName: "Customer-Test-Group",
    });

    // ========================
    // Phase 1: API — customer enters code + email → simulateApiRedeem
    // ========================
    const { order, task, redeemCode, queuePayload } = await simulateApiRedeem(
      "customer@gmail.com",
      account,
      group
    );

    // Verify API-side state
    expect(order.status).toBe("TASK_QUEUED");
    expect(task.status).toBe("PENDING");
    expect(task.type).toBe("INVITE_MEMBER");

    // Group slots decremented
    const groupAfterApi = await db.familyGroup.findUnique({ where: { id: group.id } });
    expect(groupAfterApi!.availableSlots).toBe(4); // 5 - 1
    expect(groupAfterApi!.pendingInviteCount).toBe(1);

    // ========================
    // Phase 2: Worker — BullMQ delivers job, processInvite runs
    // ========================
    const mockJob = createMockJob(
      {
        orderId: queuePayload.orderId,
        familyGroupId: queuePayload.familyGroupId,
        accountId: queuePayload.accountId,
        userEmail: queuePayload.userEmail,
      },
      { id: queuePayload.taskId }
    );

    await processInvite(mockJob, {
      prisma: db,
      adspower: mockAdspower as any,
      lock: mockLock as any,
      workerId,
    });

    // ========================
    // Phase 3: Verify — full DB reconciliation
    // ========================

    // Task → INVITE_SENT
    const finalTask = await db.task.findUnique({ where: { id: task.id } });
    expect(finalTask!.status).toBe("INVITE_SENT");
    expect(finalTask!.workerId).toBe(workerId);
    expect(finalTask!.startedAt).not.toBeNull();
    expect(finalTask!.finishedAt).not.toBeNull();

    // Order → INVITE_SENT
    const finalOrder = await db.order.findUnique({ where: { id: order.id } });
    expect(finalOrder!.status).toBe("INVITE_SENT");

    // RedeemCode → USED
    const finalCode = await db.redeemCode.findUnique({ where: { id: redeemCode.id } });
    expect(finalCode!.status).toBe("USED");

    // FamilyGroup → slots still 4 (only API decrements, Worker doesn't change)
    const finalGroup = await db.familyGroup.findUnique({ where: { id: group.id } });
    expect(finalGroup!.availableSlots).toBe(4);

    // TaskLogs → audit trail
    const logs = await db.taskLog.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "asc" },
    });
    expect(logs.length).toBeGreaterThan(0);
    const messages = logs.map((l) => l.message);
    expect(messages.some((m) => m.includes("RUNNING"))).toBe(true);
    expect(messages.some((m) => m.includes("INVITE_SENT"))).toBe(true);

    // AdsPower lifecycle
    expect(mockAdspower.openCalls).toContain("profile-customer-001");
    expect(mockAdspower.closeCalls).toContain("profile-customer-001");
  });

  it("Group selection: picks earliest group with slots, skips full and unhealthy groups", async () => {
    // ========================
    // Setup: 3 accounts/groups with different conditions
    // ========================

    // Group A: HEALTHY but FULL (0 slots) — should be skipped
    const acctA = await createTestAccount({ adspowerProfileId: "profile-a" });
    await db.account.update({ where: { id: acctA.id }, data: { status: "HEALTHY" } });
    const groupA = await createTestFamilyGroup(acctA.id, {
      groupName: "GroupA-Full",
      availableSlots: 0,
    });

    // Group B: has slots but Account UNHEALTHY — should be skipped
    const acctB = await createTestAccount({ adspowerProfileId: "profile-b" });
    await db.account.update({ where: { id: acctB.id }, data: { status: "DISABLED" } });
    const groupB = await createTestFamilyGroup(acctB.id, {
      groupName: "GroupB-Unhealthy",
      availableSlots: 5,
    });

    // Small delay to ensure different createdAt timestamps
    await new Promise((r) => setTimeout(r, 10));

    // Group C: HEALTHY with 3 slots — should be selected
    const acctC = await createTestAccount({ adspowerProfileId: "profile-c" });
    await db.account.update({ where: { id: acctC.id }, data: { status: "HEALTHY" } });
    const groupC = await createTestFamilyGroup(acctC.id, {
      groupName: "GroupC-Available",
      availableSlots: 3,
    });

    // ========================
    // Simulate: findAvailableGroup (same logic as FamilyGroupService)
    // ========================
    const groups = await db.familyGroup.findMany({
      where: { status: "ACTIVE", availableSlots: { gt: 0 } },
      select: { id: true, accountId: true, groupName: true },
      orderBy: [{ createdAt: "asc" }],
    });

    let selectedGroupId: string | null = null;
    for (const g of groups) {
      const account = await db.account.findUnique({
        where: { id: g.accountId },
        select: { id: true, status: true },
      });
      if (account && account.status === "HEALTHY") {
        selectedGroupId = g.id;
        break;
      }
    }

    // Verify: GroupA skipped (full), GroupB skipped (unhealthy), GroupC selected
    expect(selectedGroupId).toBe(groupC.id);
    expect(selectedGroupId).not.toBe(groupA.id); // full
    expect(selectedGroupId).not.toBe(groupB.id); // unhealthy

    // ========================
    // Full lifecycle with selected group
    // ========================
    const { order, task, redeemCode, queuePayload } = await simulateApiRedeem(
      "test-customer@gmail.com",
      acctC,
      groupC
    );

    const mockJob = createMockJob(
      {
        orderId: queuePayload.orderId,
        familyGroupId: queuePayload.familyGroupId,
        accountId: queuePayload.accountId,
        userEmail: queuePayload.userEmail,
      },
      { id: queuePayload.taskId }
    );

    await processInvite(mockJob, {
      prisma: db,
      adspower: mockAdspower as any,
      lock: mockLock as any,
      workerId,
    });

    // Verify: task completed, assigned to correct group (C)
    const finalTask = await db.task.findUnique({ where: { id: task.id } });
    expect(finalTask!.status).toBe("INVITE_SENT");
    expect(finalTask!.familyGroupId).toBe(groupC.id);

    // GroupC slots: 3 → 2
    const finalGroup = await db.familyGroup.findUnique({ where: { id: groupC.id } });
    expect(finalGroup!.availableSlots).toBe(2);
  });

  it("Multiple customers redeem sequentially → each gets correct group and slots", async () => {
    // ========================
    // Setup: 1 group with 2 available slots
    // ========================
    const account = await createTestAccount({ adspowerProfileId: "profile-multi" });
    await db.account.update({ where: { id: account.id }, data: { status: "HEALTHY" } });
    const group = await createTestFamilyGroup(account.id, {
      groupName: "Multi-Customer-Group",
      availableSlots: 2,
    });

    // ========================
    // Customer 1: redeem + invite
    // ========================
    const c1 = await simulateApiRedeem("customer1@gmail.com", account, group);

    await processInvite(
      createMockJob(
        {
          orderId: c1.queuePayload.orderId,
          familyGroupId: c1.queuePayload.familyGroupId,
          accountId: c1.queuePayload.accountId,
          userEmail: c1.queuePayload.userEmail,
        },
        { id: c1.queuePayload.taskId }
      ),
      { prisma: db, adspower: mockAdspower as any, lock: mockLock as any, workerId }
    );

    // After customer 1: slots 2 → 1
    const afterC1 = await db.familyGroup.findUnique({ where: { id: group.id } });
    expect(afterC1!.availableSlots).toBe(1);

    mockAdspower.reset();
    mockLock.reset();

    // ========================
    // Customer 2: redeem + invite
    // ========================
    const c2 = await simulateApiRedeem("customer2@gmail.com", account, group);

    await processInvite(
      createMockJob(
        {
          orderId: c2.queuePayload.orderId,
          familyGroupId: c2.queuePayload.familyGroupId,
          accountId: c2.queuePayload.accountId,
          userEmail: c2.queuePayload.userEmail,
        },
        { id: c2.queuePayload.taskId }
      ),
      { prisma: db, adspower: mockAdspower as any, lock: mockLock as any, workerId }
    );

    // After customer 2: slots 1 → 0
    const afterC2 = await db.familyGroup.findUnique({ where: { id: group.id } });
    expect(afterC2!.availableSlots).toBe(0);

    // Both orders should be INVITE_SENT
    const order1 = await db.order.findUnique({ where: { id: c1.order.id } });
    const order2 = await db.order.findUnique({ where: { id: c2.order.id } });
    expect(order1!.status).toBe("INVITE_SENT");
    expect(order2!.status).toBe("INVITE_SENT");

    // Both codes should be USED
    const code1 = await db.redeemCode.findUnique({ where: { id: c1.redeemCode.id } });
    const code2 = await db.redeemCode.findUnique({ where: { id: c2.redeemCode.id } });
    expect(code1!.status).toBe("USED");
    expect(code2!.status).toBe("USED");
  });
});
