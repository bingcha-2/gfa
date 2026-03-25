/**
 * Integration tests for the replace processor.
 *
 * Verifies the full replace flow: remove old member + invite new member.
 * Uses mocked browser/AdsPower with real SQLite DB.
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

// Mock the browser-context module
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

import { processReplace } from "../processors/replace.processor";

describe("Replace Processor Integration", () => {
  const db = getPrisma();
  const mockAdspower = new MockAdsPowerClient();
  const mockLock = new MockProfileLock();
  const workerId = "test-worker-2";

  beforeAll(async () => {
    await cleanDb();
  });

  beforeEach(() => {
    mockAdspower.reset();
    mockLock.reset();
  });

  afterEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it("should update Task to REPLACED_AND_INVITE_SENT and Order to INVITE_SENT", async () => {
    const account = await createTestAccount({
      adspowerProfileId: "profile-replace-001",
      loginPassword: "test-password-123",
    });
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 0,
    });

    // Create a pre-existing member to be removed
    await db.familyMember.create({
      data: {
        familyGroupId: group.id,
        email: "old-member@gmail.com",
        displayName: "Old Member",
        role: "member",
        status: "ACTIVE",
      },
    });

    const order = await createTestOrder({
      userEmail: "new-buyer@example.com",
      familyGroupId: group.id,
      status: "TASK_QUEUED",
    });
    const task = await createTestTask("REPLACE_MEMBER", {
      orderId: order.id,
      familyGroupId: group.id,
      accountId: account.id,
      payload: JSON.stringify({
        orderId: order.id,
        familyGroupId: group.id,
        accountId: account.id,
        targetMemberEmail: "old-member@gmail.com",
        newUserEmail: "new-buyer@example.com",
      }),
    });

    const job = createMockJob(
      {
        orderId: order.id,
        familyGroupId: group.id,
        accountId: account.id,
        targetMemberEmail: "old-member@gmail.com",
        newUserEmail: "new-buyer@example.com",
      },
      { id: task.id }
    );

    const deps = {
      prisma: db,
      adspower: mockAdspower as any,
      lock: mockLock as any,
      workerId,
    };

    await processReplace(job, deps);

    // Assert: Task status
    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("REPLACED_AND_INVITE_SENT");
    expect(updatedTask!.workerId).toBe(workerId);

    // Assert: Order status
    const updatedOrder = await db.order.findUnique({ where: { id: order.id } });
    expect(updatedOrder!.status).toBe("INVITE_SENT");

    // Assert: Old member marked as REMOVED in DB
    const members = await db.familyMember.findMany({
      where: { familyGroupId: group.id, email: "old-member@gmail.com" },
    });
    expect(members.length).toBe(1);
    expect(members[0].status).toBe("REMOVED");
    expect(members[0].removedAt).not.toBeNull();

    // Assert: AdsPower interactions
    expect(mockAdspower.openCalls).toContain("profile-replace-001");
    expect(mockAdspower.closeCalls).toContain("profile-replace-001");
  });

  it("should set Task to FAILED_FINAL when Account is not found", async () => {
    const task = await createTestTask("REPLACE_MEMBER", {});

    const job = createMockJob(
      {
        orderId: undefined,
        familyGroupId: "fake-group",
        accountId: "nonexistent-replace-account",
        targetMemberEmail: "old@example.com",
        newUserEmail: "new@example.com",
      },
      { id: task.id }
    );

    const deps = {
      prisma: db,
      adspower: mockAdspower as any,
      lock: mockLock as any,
      workerId,
    };

    await processReplace(job, deps);

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("FAILED_FINAL");
    expect(updatedTask!.lastErrorCode).toBe("ACCOUNT_NOT_FOUND");
  });

  it("should set Task to FAILED_RETRYABLE when profile is locked", async () => {
    const account = await createTestAccount({
      adspowerProfileId: "profile-replace-locked",
    });
    const task = await createTestTask("REPLACE_MEMBER", {
      accountId: account.id,
    });

    mockLock.locked = true;

    const job = createMockJob(
      {
        orderId: undefined,
        familyGroupId: "fake-group",
        accountId: account.id,
        targetMemberEmail: "old@example.com",
        newUserEmail: "new@example.com",
      },
      { id: task.id }
    );

    const deps = {
      prisma: db,
      adspower: mockAdspower as any,
      lock: mockLock as any,
      workerId,
    };

    await expect(processReplace(job, deps)).rejects.toThrow("locked");

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("FAILED_RETRYABLE");
    expect(updatedTask!.lastErrorCode).toBe("PROFILE_LOCKED");
  });
});
