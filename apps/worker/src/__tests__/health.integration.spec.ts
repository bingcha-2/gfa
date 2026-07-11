/**
 * Integration tests for the health processor.
 *
 * Verifies account status updates plus subscription field refresh.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanDb,
  createMockJob,
  createTestAccount,
  createTestTask,
  disconnectDb,
  getPrisma,
} from "./helpers";
import { MockAdsPowerClient } from "./mock-adspower";
import { MockBrowserPool } from "./mock-browser-pool";

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
    const mkLoc = (selector = ""): any => ({
      count: async () => selector.includes("security") ? 0 : 1,
      first: () => mkLoc(selector),
      last: () => mkLoc(selector),
      nth: () => mkLoc(selector),
      waitFor: async () => {},
      click: async () => {},
      fill: async () => {},
      press: async () => {},
      textContent: async () => "",
      locator: (childSelector: string) => mkLoc(childSelector),
    });

    return {
      goto: async () => {},
      waitForLoadState: async () => {},
      waitForURL: async () => {},
      waitForTimeout: async () => {},
      url: () => "https://myaccount.google.com/",
      locator: (selector: string) => mkLoc(selector),
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

import { processHealth } from "../processors/health.processor";

describe("Health Processor Integration", () => {
  const db = getPrisma();
  const mockAdspower = new MockAdsPowerClient();
  const mockPool = new MockBrowserPool();
  const workerId = "test-worker-health";

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

  it("should clear subscription expiry when subscription becomes suspended", async () => {
    const account = await createTestAccount({
      adspowerProfileId: "profile-health-001",
    });
    await db.account.update({
      where: { id: account.id },
      data: {
        subscriptionExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
        subscriptionStatus: "ACTIVE",
      },
    });
    const task = await createTestTask("HEALTH_CHECK_ACCOUNT", {
      accountId: account.id,
    });

    const job = createMockJob(
      { accountId: account.id },
      { id: task.id }
    );

    const deps = {
      prisma: db,
      adspower: mockAdspower as any,
      pool: mockPool as any,
      workerId,
    };

    await processHealth(job, deps);

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("SUCCESS");

    const updatedAccount = await db.account.findUnique({
      where: { id: account.id },
      select: {
        status: true,
        subscriptionExpiresAt: true,
        subscriptionStatus: true,
      },
    });
    expect(updatedAccount!.status).toBe("HEALTHY");
    expect(updatedAccount!.subscriptionStatus).toBe("SUSPENDED");
    expect(updatedAccount!.subscriptionExpiresAt).toBeNull();
  });
});
