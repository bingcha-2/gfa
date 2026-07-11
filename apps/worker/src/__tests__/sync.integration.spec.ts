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
import { MockBrowserPool } from "./mock-browser-pool";

// Mock the browser-context module
vi.mock("../browser-context", () => {
  class InlineMockWorkerBrowser {
    async connect() { return createFakePage(); }
    getPage() { return createFakePage(); }
    async takeScreenshot() { return "/tmp/fake-screenshot.png"; }
    async navigateTo() {}
    async safeGoto() {}
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

vi.mock("../scrape-subscription", () => ({
  scrapeSubscriptionInfo: vi.fn(async () => ({
    expiresAt: null,
    status: "SUSPENDED" as const,
  })),
}));

import { processSync } from "../processors/sync.processor";

describe("Sync Processor Integration", () => {
  const db = getPrisma();
  const mockAdspower = new MockAdsPowerClient();
  const mockPool = new MockBrowserPool();
  const workerId = "test-worker-3";

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

  it("should update Task to SUCCESS and update FamilyGroup counts", async () => {
    const account = await createTestAccount({
      adspowerProfileId: "profile-sync-001",
    });
    await db.account.update({
      where: { id: account.id },
      data: {
        subscriptionExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
        subscriptionStatus: "ACTIVE",
      },
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
      pool: mockPool as any,
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

    const updatedAccount = await db.account.findUnique({
      where: { id: account.id },
      select: {
        subscriptionExpiresAt: true,
        subscriptionStatus: true,
      },
    });
    expect(updatedAccount!.subscriptionStatus).toBe("SUSPENDED");
    expect(updatedAccount!.subscriptionExpiresAt).toBeNull();
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
      pool: mockPool as any,
      workerId,
    };

    await processSync(job, deps);

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("FAILED_FINAL");
    expect(updatedTask!.lastErrorCode).toBe("ACCOUNT_NOT_FOUND");
  });

  it("should throw when pool is exhausted", async () => {
    const account = await createTestAccount({
      adspowerProfileId: "profile-sync-pool-test",
    });
    const task = await createTestTask("SYNC_FAMILY_GROUP", {
      accountId: account.id,
    });

    mockPool.exhausted = true;

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
      pool: mockPool as any,
      workerId,
    };

    await expect(processSync(job, deps)).rejects.toThrow("No free profile available");
  });
});
