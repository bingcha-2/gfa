import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanDb,
  createTestAccount,
  createTestFamilyGroup,
  createTestOrder,
  createTestTask,
  createMockJob,
  disconnectDb,
  getPrisma,
} from "./helpers";
import { MockAdsPowerClient } from "./mock-adspower";
import { MockBrowserPool } from "./mock-browser-pool";
import { UnrecoverableError } from "bullmq";

// Mock the browser-context
vi.mock("../browser-context", () => {
  class InlineMockWorkerBrowser {
    async connect() { return { goto: async () => {}, waitForTimeout: async () => {}, disconnect: async () => {} }; }
    getPage() { return null; }
    async takeScreenshot() { return "/tmp/fake-screenshot.png"; }
    async disconnect() {}
  }
  return { WorkerBrowser: InlineMockWorkerBrowser };
});

// We want to force gmailLogin or handleLoginResult to throw MANUAL_REVIEW
vi.mock("../gmail-login", () => ({
  gmailLogin: async () => ({ success: false, reason: "ACCOUNT_LOCKED", detail: "Mock Locked" })
}));

vi.mock("../handle-login-result", () => ({
  handleLoginResult: async () => {
    throw new UnrecoverableError("MANUAL_REVIEW");
  }
}));

import { processInvite } from "../processors/invite.processor";

describe("Invite Failover Integration", () => {
  const db = getPrisma();
  const mockAdspower = new MockAdsPowerClient();
  const mockPool = new MockBrowserPool();
  const workerId = "test-worker-1";

  beforeAll(async () => {
    await cleanDb();
  });

  afterEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it("should auto-reassign to a new healthy group when invite task hits MANUAL_REVIEW", async () => {
    // 1. Create failing account and group
    const failedAccount = await createTestAccount({ name: "Failed Account", status: "HEALTHY" });
    const failedGroup = await createTestFamilyGroup(failedAccount.id, { availableSlots: 1, pendingInviteCount: 1 });
    
    // 2. Create healthy fallback account and group
    const healthyAccount = await createTestAccount({ name: "Healthy Account", status: "HEALTHY" });
    const healthyGroup = await createTestFamilyGroup(healthyAccount.id, { availableSlots: 3, pendingInviteCount: 0 });

    // 3. Create order assigned to failed group
    const order = await createTestOrder({
      userEmail: "reassign-target@example.com",
      familyGroupId: failedGroup.id,
      status: "TASK_QUEUED"
    });

    // 4. Create task assigned to failed group
    const task = await createTestTask("INVITE_MEMBER", {
      orderId: order.id,
      familyGroupId: failedGroup.id,
      accountId: failedAccount.id,
      payload: JSON.stringify({
        orderId: order.id,
        familyGroupId: failedGroup.id,
        accountId: failedAccount.id,
        userEmail: "reassign-target@example.com",
      }),
    });

    const job = createMockJob(
      {
        orderId: order.id,
        familyGroupId: failedGroup.id,
        accountId: failedAccount.id,
        userEmail: "reassign-target@example.com",
      },
      { id: task.id }
    );

    // Track queue items
    const queuedJobs: any[] = [];
    const mockInviteQueue = {
      add: async (name: string, data: any) => {
        queuedJobs.push({ name, data });
        return { id: "new-failover-job-id" };
      }
    };

    const deps = {
      prisma: db,
      adspower: mockAdspower as any,
      pool: mockPool as any,
      workerId,
      inviteQueue: mockInviteQueue as any
    };

    // Execute
    await processInvite(job, deps);

    // Assert: Old task should be FAILED_FINAL with AUTO_REASSIGNED
    const finalOldTask = await db.task.findUnique({ where: { id: task.id } });
    expect(finalOldTask!.status).toBe("FAILED_FINAL");
    expect(finalOldTask!.lastErrorCode).toBe("AUTO_REASSIGNED");

    // Assert: Order should be assigned to the new group
    const updatedOrder = await db.order.findUnique({ where: { id: order.id } });
    expect(updatedOrder!.familyGroupId).toBe(healthyGroup.id);
    expect(updatedOrder!.status).toBe("TASK_QUEUED");

    // Assert: Inventory should be correct
    const oldGroupAfter = await db.familyGroup.findUnique({ where: { id: failedGroup.id } });
    const newGroupAfter = await db.familyGroup.findUnique({ where: { id: healthyGroup.id } });
    
    // old group slots incremented (1 + 1 = 2)
    expect(oldGroupAfter!.availableSlots).toBe(2);
    // pending count decremented (1 - 1 = 0)
    expect(oldGroupAfter!.pendingInviteCount).toBe(0);
    
    // new group slots decremented (3 - 1 = 2)
    expect(newGroupAfter!.availableSlots).toBe(2);
    // new pending count incremented (0 + 1 = 1)
    expect(newGroupAfter!.pendingInviteCount).toBe(1);

    // Assert: A new task should be created
    const allTasks = await db.task.findMany({ where: { orderId: order.id } });
    expect(allTasks.length).toBe(2); // The old one and the new one
    const newTask = allTasks.find(t => t.id !== task.id);
    expect(newTask!.familyGroupId).toBe(healthyGroup.id);
    expect(newTask!.accountId).toBe(healthyAccount.id);
    expect(newTask!.status).toBe("PENDING");

    // Assert: New job should be enqueued
    expect(queuedJobs.length).toBe(1);
    expect(queuedJobs[0].data.familyGroupId).toBe(healthyGroup.id);
  });
});
