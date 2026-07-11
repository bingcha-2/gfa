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

import { describe, it, expect, vi } from "vitest";
import { PortalService } from "../portal.service";

// ── helpers ───────────────────────────────────────────────────────────────────

function makePrisma(opts: {
  customer?: any;
  subscriptions?: any[];
  deviceCount?: number;
  notificationCount?: number;
  usageRecords?: any[];
  usageCount?: number;
  hourlyRecords?: any[];
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
    cardUsageHourly: {
      findMany: vi.fn(async () => opts.hourlyRecords ?? []),
    },
  };
}

function makeStore(recordById: Record<string, any> = {}) {
  return {
    findById: vi.fn((id: string) => recordById[id] ?? null),
    publicStatus: vi.fn((record: any) => record._publicStatus ?? null),
    setSubscriptionPriority: vi.fn(() => true),
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
          priority: 2,
        },
      ],
    });
    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");

    expect(result.subscriptions[0].planName).toBeNull();
    expect(result.subscriptions[0].migratedFromCard).toBe(false);
    expect(result.subscriptions[0].priority).toBe(2);
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

  it("returns bind-line seats label and configured 5h/weekly bucket limits even without a shadow record", async () => {
    const prisma = makePrisma({
      subscriptions: [
        {
          id: "sub-bind",
          migratedFromKey: null,
          status: "ACTIVE",
          productEntitlements: '["anthropic"]',
          expiresAt: null,
          deviceLimit: 2,
          weight: 2,
          priority: 0,
          config: JSON.stringify({
            line: "bind",
            products: ["anthropic"],
            shareSeats: 2,
            shareCapacity: 8,
            bucketLimits: { "anthropic-claude": 20_000_000 },
            weeklyBucketLimits: { "anthropic-claude": 100_000_000 },
          }),
        },
      ],
    });
    const store = makeStore();
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");
    const subscription = result.subscriptions[0];

    expect(subscription).toMatchObject({
      shareSeats: 2,
      shareCapacity: 8,
      seatsLabel: "2/8 席",
      quota: {
        buckets: [{ bucket: "anthropic-claude", limit: 20_000_000 }],
        weeklyBuckets: [{ bucket: "anthropic-claude", limit: 100_000_000 }],
      },
    });
  });

  it("merges publicStatus usage/reset into configured buckets while keeping configured limits", async () => {
    const publicStatus = {
      quotaMode: "static",
      buckets: [{ bucket: "anthropic-claude", used: 5_000_000, limit: 1, resetMs: 1234 }],
      tokenWindowResetMs: 1234,
      weeklyBuckets: [{ bucket: "anthropic-claude", used: 25_000_000, limit: 1, resetMs: 5678 }],
      weeklyWindowResetMs: 5678,
      totalTokensUsed: 30_000_000,
    };
    const prisma = makePrisma({
      subscriptions: [
        {
          id: "sub-bind",
          migratedFromKey: null,
          status: "ACTIVE",
          productEntitlements: '["anthropic"]',
          expiresAt: null,
          deviceLimit: 2,
          weight: 2,
          priority: 0,
          config: JSON.stringify({
            line: "bind",
            products: ["anthropic"],
            shareSeats: 2,
            shareCapacity: 8,
            bucketLimits: { "anthropic-claude": 20_000_000 },
            weeklyBucketLimits: { "anthropic-claude": 100_000_000 },
          }),
        },
      ],
    });
    const store = makeStore({ "sub-bind": { _publicStatus: publicStatus } });
    const service = new PortalService(prisma as any, store as any);

    const result = await service.getOverview("cust-1");
    const quota = result.subscriptions[0].quota;

    expect(quota.buckets).toEqual([
      { bucket: "anthropic-claude", used: 5_000_000, limit: 20_000_000, resetMs: 1234 },
    ]);
    expect(quota.weeklyBuckets).toEqual([
      { bucket: "anthropic-claude", used: 25_000_000, limit: 100_000_000, resetMs: 5678 },
    ]);
    expect(quota.weeklyWindowTokens).toBe(25_000_000);
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
    // 写 DB 后必须刷新内存 subscriptionById,否则调度仍按旧 priority 接力。
    expect(store.setSubscriptionPriority).toHaveBeenCalledWith("s1", 1);
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

// ── 4. getUsageStats ──────────────────────────────────────────────────────────

describe("PortalService.getUsageStats", () => {
  // getUsageStats reads the hourly aggregate: each row carries requests +
  // failedRequests + summed tokens, keyed by hourStart. `status` here is sugar —
  // a non-2xx status maps to failedRequests:1 (one failed call in that hour row).
  function recentRow(over: Record<string, any> = {}) {
    const status = over.status ?? 200;
    const requests = over.requests ?? 1;
    const failedRequests = over.failedRequests ?? (status >= 200 && status < 300 ? 0 : requests);
    return {
      hourStart: over.hourStart ?? new Date(Date.now() - 60 * 1000), // ~1 min ago → lands in last bucket
      modelKey: "claude-sonnet-4",
      bucket: "antigravity-claude",
      requests,
      failedRequests,
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      totalTokens: 150,
      ...over,
    };
  }

  it("day window (7) → 7 daily points; hour window (1) → 24 hourly points", async () => {
    const store = makeStore();

    const week = new PortalService(makePrisma({ usageRecords: [] }) as any, store as any);
    const r7 = await week.getUsageStats("cust-1", { days: 7 });
    expect(r7.granularity).toBe("day");
    expect(r7.points).toHaveLength(7);

    const day = new PortalService(makePrisma({ usageRecords: [] }) as any, store as any);
    const r1 = await day.getUsageStats("cust-1", { days: 1 });
    expect(r1.granularity).toBe("hour");
    expect(r1.points).toHaveLength(24);
  });

  it("invalid days falls back to 7", async () => {
    const service = new PortalService(makePrisma({ usageRecords: [] }) as any, makeStore() as any);
    const r = await service.getUsageStats("cust-1", { days: 99 });
    expect(r.granularity).toBe("day");
    expect(r.points).toHaveLength(7);
  });

  it("scopes the query to the customer and the window (hourStart gte)", async () => {
    const prisma = makePrisma({ hourlyRecords: [] });
    const service = new PortalService(prisma as any, makeStore() as any);

    const before = Date.now();
    await service.getUsageStats("cust-1", { days: 7 });

    const callArgs = (prisma.cardUsageHourly.findMany as any).mock.calls[0][0];
    expect(callArgs.where.customerId).toBe("cust-1");
    expect(callArgs.where.hourStart.gte).toBeInstanceOf(Date);
    // since ≈ 6 full days before today's local midnight → at least 5 days ago.
    expect((callArgs.where.hourStart.gte as Date).getTime()).toBeLessThan(
      before - 5 * 24 * 60 * 60 * 1000,
    );
  });

  it("aggregates totals, byModel (desc), and status; points sum equals totals", async () => {
    const prisma = makePrisma({
      hourlyRecords: [
        recentRow({ modelKey: "claude-sonnet-4", status: 200, inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
        recentRow({ modelKey: "claude-sonnet-4", status: 429, inputTokens: 10, outputTokens: 0, totalTokens: 10 }),
        recentRow({ modelKey: "gpt-4o", status: 200, inputTokens: 300, outputTokens: 200, totalTokens: 500 }),
      ],
    });
    const service = new PortalService(prisma as any, makeStore() as any);

    const r = await service.getUsageStats("cust-1", { days: 7 });

    expect(r.totals).toMatchObject({
      inputTokens: 410,
      outputTokens: 250,
      totalTokens: 660,
      requests: 3,
    });

    // byModel sorted by totalTokens desc: gpt-4o (500) before claude-sonnet-4 (160)
    expect(r.byModel.map((m) => m.modelKey)).toEqual(["gpt-4o", "claude-sonnet-4"]);
    // byModel 现含 input/output/cached/estimatedUSD,断言关键字段即可。
    expect(r.byModel[1]).toMatchObject({ modelKey: "claude-sonnet-4", totalTokens: 160, requests: 2 });
    expect(typeof r.byModel[1].estimatedUSD).toBe("number");

    // status: 200/200 success, 429 failed
    expect(r.status).toEqual({ success: 2, failed: 1 });

    // every record landed inside the window → points sum reconstructs the token/request totals
    const sum = r.points.reduce(
      (acc, p) => ({
        inputTokens: acc.inputTokens + p.inputTokens,
        outputTokens: acc.outputTokens + p.outputTokens,
        totalTokens: acc.totalTokens + p.totalTokens,
        requests: acc.requests + p.requests,
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
    );
    expect(sum).toEqual({
      inputTokens: r.totals.inputTokens,
      outputTokens: r.totals.outputTokens,
      totalTokens: r.totals.totalTokens,
      requests: r.totals.requests,
    });
  });

  it("empty usage → zeroed totals, empty byModel, full set of zero points", async () => {
    const service = new PortalService(makePrisma({ usageRecords: [] }) as any, makeStore() as any);
    const r = await service.getUsageStats("cust-1", { days: 30 });

    expect(r.points).toHaveLength(30);
    expect(r.points.every((p) => p.totalTokens === 0 && p.requests === 0)).toBe(true);
    expect(r.byModel).toEqual([]);
    expect(r.status).toEqual({ success: 0, failed: 0 });
    expect(r.totals).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, savedUSD: 0 });
  });

  it("savedUSD uses the client per-family pricing (claude 5/25, gemini 2/12, gpt 1.25/10), family from bucket suffix", async () => {
    const prisma = makePrisma({
      hourlyRecords: [
        // claude 1M in + 0.2M out → 1*5 + 0.2*25 = $10 (mirrors apps/app usage_stats_test)
        recentRow({ bucket: "antigravity-claude", inputTokens: 1_000_000, outputTokens: 200_000, totalTokens: 1_200_000 }),
        // gpt 1M in + 0 out → 1*1.25 = $1.25
        recentRow({ bucket: "codex-gpt", inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }),
        // gemini 1M in + 1M out → 1*2 + 1*12 = $14
        recentRow({ bucket: "antigravity-gemini", inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }),
      ],
    });
    const service = new PortalService(prisma as any, makeStore() as any);

    const r = await service.getUsageStats("cust-1", { days: 7 });

    // 10 + 1.25 + 14 = 25.25
    expect(r.totals.savedUSD).toBe(25.25);
  });

  it("prices cache-read at the cache rate (server input is gross → netInput excludes cache_read)", async () => {
    // claude 行:stored inputTokens 是 gross(= net 200k + cache_read 800k),output 0。
    // 正确 USD = net 200k·5/M + cache_read 800k·0.5/M = 1.0 + 0.4 = $1.40
    // (与客户端 estimateOfficialCostUSD 同口径;此处 cache_creation=0 故精确一致)。
    // 旧实现 savedUSDFor(gross,output) 会把 cache_read 按满额 input 单价计 → $5.00(10× 偏高)。
    const prisma = makePrisma({
      hourlyRecords: [
        recentRow({ bucket: "antigravity-claude", inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 800_000, totalTokens: 200_000 }),
      ],
    });
    const service = new PortalService(prisma as any, makeStore() as any);

    const r = await service.getUsageStats("cust-1", { days: 7 });
    expect(r.totals.savedUSD).toBe(1.4);
  });

  it("per-model estimatedUSD does not double-count cache-read", async () => {
    // 旧实现 officialCostFor(gross,output,cached,0) 把 cache_read 既算进 gross·inP 又 +cached·cacheReadP。
    // 修正后用 netInput → estimatedUSD = 1.40,与 totals.savedUSD 一致。
    const prisma = makePrisma({
      hourlyRecords: [
        recentRow({ bucket: "antigravity-claude", inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 800_000, totalTokens: 200_000 }),
      ],
    });
    const service = new PortalService(prisma as any, makeStore() as any);

    const r = await service.getUsageStats("cust-1", { days: 7 });
    expect(r.byModel[0].estimatedUSD).toBe(1.4);
    expect(r.byModel[0].estimatedUSD).toBe(r.totals.savedUSD);
  });

  it("bills cache-write (cache_creation) at its own rate from the cacheCreationTokens column", async () => {
    // claude gross input = 1M(= net 100k + cache_read 800k + cache_write 100k),output 0。
    // USD = net 100k·5/M + cache_read 800k·0.5/M + cache_write 100k·6.25/M = 0.5 + 0.4 + 0.625 = $1.525
    // (与客户端 estimateOfficialCostUSD 完全一致)。
    const prisma = makePrisma({
      hourlyRecords: [
        recentRow({
          bucket: "antigravity-claude",
          inputTokens: 1_000_000,
          outputTokens: 0,
          cachedInputTokens: 800_000,
          cacheCreationTokens: 100_000,
          totalTokens: 200_000,
        }),
      ],
    });
    const service = new PortalService(prisma as any, makeStore() as any);

    const r = await service.getUsageStats("cust-1", { days: 7 });
    expect(r.totals.savedUSD).toBe(1.525);
    expect(r.byModel[0].estimatedUSD).toBe(1.525);
  });

  it("savedUSD falls back to gemini pricing for an unknown/empty bucket family (matches client priceFor)", async () => {
    const prisma = makePrisma({
      hourlyRecords: [
        // no family suffix → gemini fallback: 1M in * 2 = $2
        recentRow({ bucket: "weirdbucket", inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }),
      ],
    });
    const service = new PortalService(prisma as any, makeStore() as any);

    const r = await service.getUsageStats("cust-1", { days: 7 });
    expect(r.totals.savedUSD).toBe(2);
  });
});
