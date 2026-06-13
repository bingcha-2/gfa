/**
 * portal.service.spec.ts — unit tests for PortalService
 *
 * Coverage:
 *   1. overview: assembles customer + subscriptions with quota; quota from store
 *      publicStatus mapped correctly (including weeklyWindowTokens); missing
 *      record → unlimited fallback; devices count = ACTIVE only;
 *      unreadNotifications correct; planName always null;
 *      migratedFromCard from migratedFromKey.
 *   2. usage: scoped to customer's sub ids ONLY (another customer's rows excluded);
 *      days filter applied; pagination total correct.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PortalService } from "../portal.service";

// ── helpers ───────────────────────────────────────────────────────────────────

function makePrisma(opts: {
  customer?: any;
  subscriptions?: any[];
  deviceCount?: number;
  notificationCount?: number;
  usageRecords?: any[];
  usageCount?: number;
} = {}) {
  const customer = opts.customer ?? {
    id: "cust-1",
    email: "test@test.com",
    displayName: "Test User",
    emailVerified: true,
    referralCode: "REF123",
    creditCents: 500,
    status: "ACTIVE",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  const subscriptions = opts.subscriptions ?? [];

  return {
    customer: {
      findUniqueOrThrow: vi.fn(async () => customer),
    },
    subscription: {
      findMany: vi.fn(async () => subscriptions),
    },
    device: {
      count: vi.fn(async () => opts.deviceCount ?? 0),
    },
    notification: {
      count: vi.fn(async () => opts.notificationCount ?? 0),
    },
    cardTokenUsage: {
      findMany: vi.fn(async () => opts.usageRecords ?? []),
      count: vi.fn(async () => opts.usageCount ?? 0),
    },
  };
}

function makeStore(recordById: Record<string, any> = {}) {
  return {
    findById: vi.fn((id: string) => recordById[id] ?? null),
    publicStatus: vi.fn((record: any) => record._publicStatus ?? null),
  };
}

// ── 1. overview ───────────────────────────────────────────────────────────────

describe("PortalService.getOverview", () => {
  it("returns customer fields correctly", async () => {
    const prisma = makePrisma({});
    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");

    expect(result.customer).toMatchObject({
      id: "cust-1",
      email: "test@test.com",
      displayName: "Test User",
      emailVerified: true,
      referralCode: "REF123",
      creditCents: 500,
      status: "ACTIVE",
    });
    expect(typeof result.customer.createdAt).toBe("string");
  });

  it("planName is always null and migratedFromCard false for a catalog purchase (no migratedFromKey)", async () => {
    const prisma = makePrisma({
      subscriptions: [
        {
          id: "sub-1",
          migratedFromKey: null,
          status: "ACTIVE",
          productEntitlements: '["antigravity"]',
          expiresAt: null,
          deviceLimit: 3,
          weight: 1,
        },
      ],
    });
    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");

    expect(result.subscriptions[0].planName).toBeNull();
    expect(result.subscriptions[0].migratedFromCard).toBe(false);
  });

  it("planName is null and migratedFromCard is true for a card-migrated sub (migratedFromKey set)", async () => {
    const prisma = makePrisma({
      subscriptions: [
        {
          id: "sub-2",
          migratedFromKey: "BCAI-AAAA-BBBB",
          status: "ACTIVE",
          productEntitlements: '["antigravity"]',
          expiresAt: null,
          deviceLimit: 1,
          weight: 2,
        },
      ],
    });
    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");

    expect(result.subscriptions[0].planName).toBeNull();
    expect(result.subscriptions[0].migratedFromCard).toBe(true);
  });

  it("maps quota from store.publicStatus correctly (static mode with buckets)", async () => {
    const publicStatus = {
      quotaMode: "static",
      buckets: [{ bucket: "antigravity-claude", used: 200, limit: 1000 }],
      recentWindowTokens: 200,
      tokenWindowResetMs: 3600000,
      weeklyTokenLimit: 5000000,
      weeklyWindowResetMs: 86400000,
      weeklyBuckets: [{ bucket: "antigravity-claude", used: 1500, limit: 5000000 }],
      totalTokensUsed: 9999,
    };

    const prisma = makePrisma({
      subscriptions: [
        {
          id: "sub-1",
          planId: "plan-1",
          plan: { name: "Pro" },
          status: "ACTIVE",
          productEntitlements: '["antigravity"]',
          expiresAt: null,
          deviceLimit: 3,
          weight: 1,
        },
      ],
    });
    const store = makeStore({
      "sub-1": { _publicStatus: publicStatus },
    });
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");
    const quota = result.subscriptions[0].quota;

    expect(quota.quotaMode).toBe("static");
    expect(quota.buckets).toHaveLength(1);
    expect(quota.buckets[0]).toEqual({ bucket: "antigravity-claude", used: 200, limit: 1000 });
    expect(quota.recentWindowTokens).toBe(200);
    expect(quota.tokenWindowResetMs).toBe(3600000);
    expect(quota.weeklyTokenLimit).toBe(5000000);
    expect(quota.weeklyWindowResetMs).toBe(86400000);
    expect(quota.totalTokensUsed).toBe(9999);
  });

  it("weeklyWindowTokens sums the weeklyBuckets.used values (NOT totalTokensUsed)", async () => {
    const publicStatus = {
      quotaMode: "static",
      buckets: [],
      recentWindowTokens: 0,
      tokenWindowResetMs: null,
      weeklyTokenLimit: 5000000,
      weeklyWindowResetMs: 86400000,
      weeklyBuckets: [
        { bucket: "antigravity-claude", used: 1200, limit: 5000000 },
        { bucket: "antigravity-gemini", used: 800, limit: 5000000 },
      ],
      totalTokensUsed: 99999, // deliberately different from weekly sum
    };

    const prisma = makePrisma({
      subscriptions: [
        {
          id: "sub-1",
          planId: "plan-1",
          plan: { name: "Pro" },
          status: "ACTIVE",
          productEntitlements: '["antigravity"]',
          expiresAt: null,
          deviceLimit: 3,
          weight: 1,
        },
      ],
    });
    const store = makeStore({ "sub-1": { _publicStatus: publicStatus } });
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");
    const quota = result.subscriptions[0].quota;

    // weeklyWindowTokens = sum of weekly bucket used (1200 + 800 = 2000), NOT totalTokensUsed (99999)
    expect(quota.weeklyWindowTokens).toBe(2000);
    expect(quota.weeklyWindowTokens).not.toBe(99999);
  });

  it("falls back to unlimited quota when store has no shadow record for sub", async () => {
    const prisma = makePrisma({
      subscriptions: [
        {
          id: "sub-unknown",
          planId: "plan-1",
          plan: { name: "Plan" },
          status: "ACTIVE",
          productEntitlements: '[]',
          expiresAt: null,
          deviceLimit: 1,
          weight: 1,
        },
      ],
    });
    const store = makeStore({}); // empty — no record
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");
    const quota = result.subscriptions[0].quota;

    expect(quota.quotaMode).toBe("unlimited");
    expect(quota.buckets).toHaveLength(0);
    expect(quota.recentWindowTokens).toBe(0);
    expect(quota.tokenWindowResetMs).toBeNull();
    expect(quota.weeklyTokenLimit).toBeNull();
    expect(quota.weeklyWindowResetMs).toBeNull();
    expect(quota.weeklyWindowTokens).toBe(0);
    expect(quota.totalTokensUsed).toBe(0);
  });

  it("devices.count uses only ACTIVE devices (count from prisma)", async () => {
    const prisma = makePrisma({ deviceCount: 4 });
    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");

    expect(result.devices.count).toBe(4);
    // Verify the prisma call scoped to ACTIVE
    expect(prisma.device.count).toHaveBeenCalledWith({
      where: { customerId: "cust-1", status: "ACTIVE" },
    });
  });

  it("devices.limit is max deviceLimit across active non-expired subscriptions", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const past = new Date(now.getTime() - 1000);

    const prisma = makePrisma({
      subscriptions: [
        { id: "s1", planId: "p1", plan: { name: "A" }, status: "ACTIVE", productEntitlements: '[]', expiresAt: null, deviceLimit: 3, weight: 1 },
        { id: "s2", planId: "p2", plan: { name: "B" }, status: "ACTIVE", productEntitlements: '[]', expiresAt: future, deviceLimit: 7, weight: 1 },
        { id: "s3", planId: "p3", plan: { name: "C" }, status: "ACTIVE", productEntitlements: '[]', expiresAt: past, deviceLimit: 99, weight: 1 },  // expired
        { id: "s4", planId: "p4", plan: { name: "D" }, status: "EXPIRED", productEntitlements: '[]', expiresAt: null, deviceLimit: 50, weight: 1 }, // inactive
      ],
    });
    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");

    // max of [3, 7] from s1 and s2; expired/inactive ignored
    expect(result.devices.limit).toBe(7);
  });

  it("devices.limit defaults to 1 when no active non-expired subscriptions", async () => {
    const prisma = makePrisma({ subscriptions: [] });
    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");

    expect(result.devices.limit).toBe(1);
  });

  it("unreadNotifications returns the unread count from prisma", async () => {
    const prisma = makePrisma({ notificationCount: 5 });
    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");

    expect(result.unreadNotifications).toBe(5);
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { customerId: "cust-1", readAt: null },
    });
  });

  it("products parsed correctly from productEntitlements JSON", async () => {
    const prisma = makePrisma({
      subscriptions: [
        {
          id: "sub-1",
          planId: "plan-1",
          plan: { name: "Multi" },
          status: "ACTIVE",
          productEntitlements: '["antigravity","codex","anthropic"]',
          expiresAt: null,
          deviceLimit: 1,
          weight: 1,
        },
      ],
    });
    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");

    expect(result.subscriptions[0].products).toEqual(["antigravity", "codex", "anthropic"]);
  });
});

// ── 2. setSubscriptionPriority ────────────────────────────────────────────────

describe("PortalService.setSubscriptionPriority", () => {
  it("改自己订阅的 priority → update 并返回重排后的 subscriptions", async () => {
    const prisma = makePrisma({
      subscriptions: [
        {
          id: "s1",
          customerId: "cust-1",
          migratedFromKey: null,
          status: "ACTIVE",
          productEntitlements: '["antigravity"]',
          expiresAt: null,
          deviceLimit: 3,
          weight: 1,
        },
      ],
    });
    // add findUnique + update to subscription mock
    (prisma.subscription as any).findUnique = vi.fn(async () => ({
      id: "s1",
      customerId: "cust-1",
    }));
    (prisma.subscription as any).update = vi.fn(async () => ({}));

    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const res = await service.setSubscriptionPriority("cust-1", "s1", 1);

    expect(res.ok).toBe(true);
    expect(Array.isArray(res.subscriptions)).toBe(true);
    expect((prisma.subscription as any).update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s1" },
        data: { priority: 1 },
      }),
    );
  });

  it("改不属于自己的订阅 → 抛错,不 update", async () => {
    const prisma = makePrisma({});
    (prisma.subscription as any).findUnique = vi.fn(async () => ({
      id: "s1",
      customerId: "OTHER",
    }));
    (prisma.subscription as any).update = vi.fn(async () => ({}));

    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    await expect(service.setSubscriptionPriority("cust-1", "s1", 1)).rejects.toBeTruthy();
    expect((prisma.subscription as any).update).not.toHaveBeenCalled();
  });

  it("找不到订阅 → 抛错,不 update", async () => {
    const prisma = makePrisma({});
    (prisma.subscription as any).findUnique = vi.fn(async () => null);
    (prisma.subscription as any).update = vi.fn(async () => ({}));

    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    await expect(service.setSubscriptionPriority("cust-1", "s-nonexistent", 2)).rejects.toBeTruthy();
    expect((prisma.subscription as any).update).not.toHaveBeenCalled();
  });
});

// ── 3. getUsage ───────────────────────────────────────────────────────────────

describe("PortalService.getUsage", () => {
  it("scopes usage directly to the customer's customerId", async () => {
    const prisma = makePrisma({
      usageRecords: [
        {
          id: "rec-1",
          timestamp: new Date("2026-06-10T10:00:00Z"),
          modelKey: "claude-3-5-sonnet",
          bucket: "antigravity-claude",
          status: 0,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      ],
      usageCount: 1,
    });

    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getUsage("cust-1", { days: 7 });

    expect(result.records).toHaveLength(1);
    expect(result.records[0].id).toBe("rec-1");
    expect(result.total).toBe(1);

    // Verify the cardTokenUsage query uses customerId directly (not accessKeyId)
    const callArgs = (prisma.cardTokenUsage.findMany as any).mock.calls[0][0];
    expect(callArgs.where).toEqual(
      expect.objectContaining({ customerId: "cust-1" }),
    );
    expect(callArgs.where.accessKeyId).toBeUndefined();
  });

  it("excludes another customer's usage rows by querying with customerId", async () => {
    // Direct customerId filter ensures only cust-1's rows are returned
    const prisma = makePrisma({
      usageRecords: [], // DB returns empty for cust-1
      usageCount: 0,
    });

    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getUsage("cust-1", { days: 7 });

    expect(result.records).toHaveLength(0);
    const callArgs = (prisma.cardTokenUsage.findMany as any).mock.calls[0][0];
    // customerId filter ensures cust-OTHER rows are never returned
    expect(callArgs.where).toEqual(
      expect.objectContaining({ customerId: "cust-1" }),
    );
    expect(callArgs.where.accessKeyId).toBeUndefined();
  });

  it("returns empty result when no usage records exist for the customer", async () => {
    const prisma = makePrisma({ usageRecords: [], usageCount: 0 });

    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getUsage("cust-1", {});

    expect(result.records).toHaveLength(0);
    expect(result.total).toBe(0);
    // customerId query always runs; empty result comes naturally from DB
    expect(prisma.cardTokenUsage.findMany).toHaveBeenCalled();
    const callArgs = (prisma.cardTokenUsage.findMany as any).mock.calls[0][0];
    expect(callArgs.where).toEqual(
      expect.objectContaining({ customerId: "cust-1" }),
    );
  });

  it("applies days filter: timestamp >= now - days*24h", async () => {
    const prisma = makePrisma({ usageRecords: [], usageCount: 0 });

    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const before = Date.now();
    await service.getUsage("cust-1", { days: 1 });
    const after = Date.now();

    const callArgs = (prisma.cardTokenUsage.findMany as any).mock.calls[0][0];
    const since: Date = callArgs.where.timestamp.gte;
    const sinceMs = since.getTime();

    // since should be ~1 day ago
    const expectedMin = before - 1 * 24 * 60 * 60 * 1000 - 100;
    const expectedMax = after - 1 * 24 * 60 * 60 * 1000 + 100;
    expect(sinceMs).toBeGreaterThan(expectedMin);
    expect(sinceMs).toBeLessThan(expectedMax);
  });

  it("pagination: skip and take are calculated correctly", async () => {
    const prisma = makePrisma({ usageRecords: [], usageCount: 100 });

    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    await service.getUsage("cust-1", { page: 3, pageSize: 20, days: 7 });

    const callArgs = (prisma.cardTokenUsage.findMany as any).mock.calls[0][0];
    expect(callArgs.skip).toBe(40); // (3-1) * 20
    expect(callArgs.take).toBe(20);
  });

  it("pageSize is capped at 100", async () => {
    const prisma = makePrisma({ usageRecords: [], usageCount: 0 });

    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getUsage("cust-1", { pageSize: 999, days: 7 });

    const callArgs = (prisma.cardTokenUsage.findMany as any).mock.calls[0][0];
    expect(callArgs.take).toBe(100);
    expect(result.pageSize).toBe(100);
  });

  it("invalid days falls back to 7", async () => {
    const prisma = makePrisma({ usageRecords: [], usageCount: 0 });

    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const before = Date.now();
    await service.getUsage("cust-1", { days: 99 }); // not in {1,7,30}
    const after = Date.now();

    const callArgs = (prisma.cardTokenUsage.findMany as any).mock.calls[0][0];
    const since: Date = callArgs.where.timestamp.gte;
    const sinceMs = since.getTime();

    // Should be ~7 days ago
    const expectedMin = before - 7 * 24 * 60 * 60 * 1000 - 100;
    const expectedMax = after - 7 * 24 * 60 * 60 * 1000 + 100;
    expect(sinceMs).toBeGreaterThan(expectedMin);
    expect(sinceMs).toBeLessThan(expectedMax);
  });

  it("record shape includes id, timestamp (ISO), modelKey, bucket, status, inputTokens, outputTokens, totalTokens", async () => {
    const ts = new Date("2026-06-10T12:00:00Z");
    const prisma = makePrisma({
      usageRecords: [
        {
          id: "rec-1",
          timestamp: ts,
          modelKey: "gpt-4o",
          bucket: "codex-gpt",
          status: 200,
          inputTokens: 300,
          outputTokens: 120,
          totalTokens: 420,
        },
      ],
      usageCount: 1,
    });

    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getUsage("cust-1", { days: 7 });

    expect(result.records[0]).toEqual({
      id: "rec-1",
      timestamp: ts.toISOString(),
      modelKey: "gpt-4o",
      bucket: "codex-gpt",
      status: 200,
      inputTokens: 300,
      outputTokens: 120,
      totalTokens: 420,
    });
  });
});
