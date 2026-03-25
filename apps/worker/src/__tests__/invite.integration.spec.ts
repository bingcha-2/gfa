/**
 * Integration tests for the invite processor.
 *
 * Uses MockAdsPowerClient / MockWorkerBrowser / MockProfileLock
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
import { MockProfileLock } from "./mock-profile-lock";

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

describe("Invite Processor Integration", () => {
  const db = getPrisma();
  const mockAdspower = new MockAdsPowerClient();
  const mockLock = new MockProfileLock();
  const workerId = "test-worker-1";

  beforeAll(async () => {
    await cleanDb();
  });

  beforeEach(async () => {
    mockAdspower.reset();
    mockLock.reset();
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
      lock: mockLock as any,
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
    expect(mockAdspower.openCalls).toContain("profile-invite-001");
    expect(mockAdspower.closeCalls).toContain("profile-invite-001");

    // Assert: Lock was acquired and released
    expect(mockLock.acquireCalls).toContain("profile-invite-001");
    expect(mockLock.releaseCalls).toContain("profile-invite-001");

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
      lock: mockLock as any,
      workerId,
    };

    await processInvite(job, deps);

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("FAILED_FINAL");
    expect(updatedTask!.lastErrorCode).toBe("ACCOUNT_NOT_FOUND");
  });

  it("should set Task to FAILED_RETRYABLE when profile is locked", async () => {
    const account = await createTestAccount({
      adspowerProfileId: "profile-locked-001",
    });
    const task = await createTestTask("INVITE_MEMBER", {
      accountId: account.id,
    });

    // Simulate lock contention
    mockLock.locked = true;

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
      lock: mockLock as any,
      workerId,
    };

    // Should throw to trigger BullMQ retry
    await expect(processInvite(job, deps)).rejects.toThrow("locked");

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("FAILED_RETRYABLE");
    expect(updatedTask!.lastErrorCode).toBe("PROFILE_LOCKED");
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
      lock: mockLock as any,
      workerId,
    };

    await expect(processInvite(job, deps)).rejects.toThrow("AdsPower connection refused");

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("FAILED_RETRYABLE");
    expect(updatedTask!.lastErrorCode).toBe("INVITE_ERROR");
  });
});
