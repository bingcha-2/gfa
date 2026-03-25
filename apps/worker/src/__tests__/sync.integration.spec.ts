/**
 * Integration tests for the sync processor.
 *
 * Verifies syncing family members from page to DB.
 * Uses mocked browser/AdsPower with real SQLite DB.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanDb,
  createTestAccount,
  createTestFamilyGroup,
  createTestTask,
  createMockJob,
  disconnectDb,
  getPrisma,
} from "./helpers";
import { MockAdsPowerClient } from "./mock-adspower";
import { MockWorkerBrowser, createMockPage } from "./mock-browser";
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

import { processSync } from "../processors/sync.processor";

describe("Sync Processor Integration", () => {
  const db = getPrisma();
  const mockAdspower = new MockAdsPowerClient();
  const mockLock = new MockProfileLock();
  const workerId = "test-worker-3";

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

  it("should update Task to SUCCESS and update FamilyGroup counts", async () => {
    const account = await createTestAccount({
      adspowerProfileId: "profile-sync-001",
    });
    const group = await createTestFamilyGroup(account.id, {
      availableSlots: 5,
    });
    const task = await createTestTask("SYNC_FAMILY_GROUP", {
      familyGroupId: group.id,
      accountId: account.id,
    });

    const job = createMockJob(
      {
        familyGroupId: group.id,
        accountId: account.id,
      },
      { id: task.id }
    );

    const deps = {
      prisma: db,
      adspower: mockAdspower as any,
      lock: mockLock as any,
      workerId,
    };

    await processSync(job, deps);

    // Assert: Task status
    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("SUCCESS");
    expect(updatedTask!.workerId).toBe(workerId);

    // Assert: FamilyGroup updated (mock page returns empty array → 0 members)
    const updatedGroup = await db.familyGroup.findUnique({
      where: { id: group.id },
    });
    expect(updatedGroup!.memberCount).toBe(0);
    expect(updatedGroup!.availableSlots).toBe(6);
    expect(updatedGroup!.lastSyncedAt).not.toBeNull();
  });

  it("should set Task to FAILED_FINAL when Account is not found", async () => {
    const task = await createTestTask("SYNC_FAMILY_GROUP", {});

    const job = createMockJob(
      {
        familyGroupId: "fake-group",
        accountId: "nonexistent-sync-account",
      },
      { id: task.id }
    );

    const deps = {
      prisma: db,
      adspower: mockAdspower as any,
      lock: mockLock as any,
      workerId,
    };

    await processSync(job, deps);

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("FAILED_FINAL");
    expect(updatedTask!.lastErrorCode).toBe("ACCOUNT_NOT_FOUND");
  });

  it("should set Task to FAILED_RETRYABLE when profile is locked", async () => {
    const account = await createTestAccount({
      adspowerProfileId: "profile-sync-locked",
    });
    const task = await createTestTask("SYNC_FAMILY_GROUP", {
      accountId: account.id,
    });

    mockLock.locked = true;

    const job = createMockJob(
      {
        familyGroupId: "fake-group",
        accountId: account.id,
      },
      { id: task.id }
    );

    const deps = {
      prisma: db,
      adspower: mockAdspower as any,
      lock: mockLock as any,
      workerId,
    };

    await expect(processSync(job, deps)).rejects.toThrow("locked");

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("FAILED_RETRYABLE");
    expect(updatedTask!.lastErrorCode).toBe("PROFILE_LOCKED");
  });
});
