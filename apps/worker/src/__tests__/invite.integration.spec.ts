/**
 * Integration tests for the invite processor.
 *
 * Uses MockAdsPowerClient / MockWorkerBrowser / MockBrowserPool
 * with a real SQLite PrismaClient to verify the full processor flow:
 * Task creation → processInvite() → Task/Order status update.
 */


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
import { MockWorkerBrowser } from "./mock-browser";
import { MockBrowserPool } from "./mock-browser-pool";

// Mock the browser-context module so WorkerBrowser is replaced
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
      waitFor: async () => {},
      click: async () => {},
      fill: async () => {},
      press: async () => {},
      textContent: async () => "",
      locator: () => mkLoc(),
    });
    return {
      goto: async () => {},
      waitForLoadState: async () => {},
      waitForURL: async () => {},
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

describe("Invite Processor Integration", () => {
  const db = getPrisma();
  const mockAdspower = new MockAdsPowerClient();
  const mockPool = new MockBrowserPool();
  const workerId = "test-worker-1";

  beforeAll(async () => {
    await cleanDb();
  });

  beforeEach(async () => {
    await cleanDb();
    mockAdspower.reset();
    mockPool.reset();
  });

  afterEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it("should update Task to INVITE_SENT and Order to INVITE_SENT on success", async () => {
    // Arrange: create Account + FamilyGroup + Order + Task
    const account = await createTestAccount({
      adspowerProfileId: "profile-invite-001",
    });
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 5,
    });
    const order = await createTestOrder({
      userEmail: "buyer@example.com",
      familyGroupId: group.id,
      status: "TASK_QUEUED",
    });
    const task = await createTestTask("INVITE_MEMBER", {
      orderId: order.id,
      familyGroupId: group.id,
      accountId: account.id,
      payload: JSON.stringify({
        orderId: order.id,
        familyGroupId: group.id,
        accountId: account.id,
        userEmail: "buyer@example.com",
      }),
    });

    const job = createMockJob(
      {
        orderId: order.id,
        familyGroupId: group.id,
        accountId: account.id,
        userEmail: "buyer@example.com",
      },
      { id: task.id }
    );

    const deps = {
      prisma: db,
      adspower: mockAdspower as any,
      pool: mockPool as any,
      workerId,
    };

    // Act
    await processInvite(job, deps);

    // Assert: Task status
    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask).not.toBeNull();
    expect(updatedTask!.status).toBe("INVITE_SENT");
    expect(updatedTask!.workerId).toBe(workerId);
    expect(updatedTask!.startedAt).not.toBeNull();
    expect(updatedTask!.finishedAt).not.toBeNull();

    // Assert: Order status
    const updatedOrder = await db.order.findUnique({ where: { id: order.id } });
    expect(updatedOrder).not.toBeNull();
    expect(updatedOrder!.status).toBe("INVITE_SENT");

    // Assert: AdsPower was called
    expect(mockAdspower.openCalls).toContain(mockPool.profileId);
    expect(mockAdspower.closeCalls).toContain(mockPool.profileId);

    // Assert: Pool was acquired and released
    expect(mockPool.acquireCalls.length).toBeGreaterThan(0);
    expect(mockPool.releaseCalls.length).toBeGreaterThan(0);

    // Assert: TaskLogs were written
    const logs = await db.taskLog.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "asc" },
    });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.message.includes("INVITE_SENT"))).toBe(true);
  });

  it("should set Task to FAILED_FINAL when Account is not found", async () => {
    const task = await createTestTask("INVITE_MEMBER", {});

    const job = createMockJob(
      {
        orderId: undefined,
        familyGroupId: "fake-group",
        accountId: "nonexistent-account-id",
        userEmail: "buyer@example.com",
      },
      { id: task.id }
    );

    const deps = {
      prisma: db,
      adspower: mockAdspower as any,
      pool: mockPool as any,
      workerId,
    };

    await processInvite(job, deps);

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("FAILED_FINAL");
    expect(updatedTask!.lastErrorCode).toBe("ACCOUNT_NOT_FOUND");
  });

  it("should throw when pool is exhausted", async () => {
    const account = await createTestAccount({
      adspowerProfileId: "profile-pool-test",
    });
    const task = await createTestTask("INVITE_MEMBER", {
      accountId: account.id,
    });

    // Simulate pool exhaustion
    mockPool.exhausted = true;

    const job = createMockJob(
      {
        orderId: undefined,
        familyGroupId: "fake-group",
        accountId: account.id,
        userEmail: "buyer@example.com",
      },
      { id: task.id }
    );

    const deps = {
      prisma: db,
      adspower: mockAdspower as any,
      pool: mockPool as any,
      workerId,
    };

    // Should throw to trigger BullMQ retry
    await expect(processInvite(job, deps)).rejects.toThrow("No free profile available");

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("FAILED_RETRYABLE");
    expect(updatedTask!.lastErrorCode).toBe("PROFILE_ACQUIRE_FAILED");
  });

  it("should set Task to FAILED_RETRYABLE when AdsPower fails", async () => {
    const account = await createTestAccount({
      adspowerProfileId: "profile-fail-001",
    });
    const task = await createTestTask("INVITE_MEMBER", {
      accountId: account.id,
    });

    // Simulate AdsPower error
    mockAdspower.openError = new Error("AdsPower connection refused");

    const job = createMockJob(
      {
        orderId: undefined,
        familyGroupId: "fake-group",
        accountId: account.id,
        userEmail: "buyer@example.com",
      },
      { id: task.id }
    );

    const deps = {
      prisma: db,
      adspower: mockAdspower as any,
      pool: mockPool as any,
      workerId,
    };

    await expect(processInvite(job, deps)).rejects.toThrow("AdsPower connection refused");

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("FAILED_RETRYABLE");
    expect(updatedTask!.lastErrorCode).toBe("INVITE_ERROR");
  });
});
