import { describe, expect, it, vi } from "vitest";

import { CodexOverflowRouter } from "../service/codex-overflow-router";

const NOW = Date.parse("2036-01-01T00:00:00Z");
const RESET = new Date(NOW + 24 * 60 * 60_000).toISOString();

function account(id: number, weeklyPercent: number) {
  return {
    id,
    email: `account-${id}@example.test`,
    refreshToken: `rt-${id}`,
    enabled: true,
    planType: "pro",
    codexWeeklyPercent: weeklyPercent,
    codexWeeklyResetTime: RESET,
    codexQuotaObservedAt: NOW,
  };
}

function subscription(
  id: string,
  accountId: number,
  weekly: number,
  usedWeekly = 0,
) {
  return {
    id,
    config: JSON.stringify({
      levels: { codex: "pro" },
      usdQuotaByProduct: { codex: { fiveHour: 0, weekly } },
    }),
    bindings: JSON.stringify({ codex: accountId }),
    levels: JSON.stringify({ codex: "pro" }),
    windowState: JSON.stringify({
      usdUsageByProduct: { codex: { usedWeekly } },
    }),
  };
}

function mockPrisma(subscriptions: any[]) {
  const routes: any[] = [];
  const subscriptionUpdate = vi.fn();
  const db: any = {
    subscription: {
      findMany: vi.fn(async () => subscriptions),
      update: subscriptionUpdate,
      updateMany: subscriptionUpdate,
    },
    codexOverflowRoute: {
      findMany: vi.fn(async ({ where }: any) =>
        routes.filter((route) =>
          route.status === where.status && route.expiresAt > where.expiresAt.gt,
        ),
      ),
      findFirst: vi.fn(async ({ where }: any) =>
        routes.find((route) =>
          route.subscriptionId === where.subscriptionId
          && route.status === where.status
          && route.expiresAt > where.expiresAt.gt,
        ) || null,
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const index = routes.findIndex((route) => route.subscriptionId === where.subscriptionId);
        const next = index >= 0
          ? { ...routes[index], ...update, updatedAt: new Date(NOW) }
          : { ...create, createdAt: new Date(NOW), updatedAt: new Date(NOW) };
        if (index >= 0) routes[index] = next;
        else routes.push(next);
        return next;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const route of routes) {
          const matchesSubscription = where.subscriptionId === undefined
            || route.subscriptionId === where.subscriptionId;
          const matchesStatus = where.status === undefined || route.status === where.status;
          const matchesExpiry = !where.expiresAt?.lte || route.expiresAt <= where.expiresAt.lte;
          if (matchesSubscription && matchesStatus && matchesExpiry) {
            Object.assign(route, data);
            count++;
          }
        }
        return { count };
      }),
    },
  };
  db.$transaction = vi.fn(async (work: any) => work(db));
  return { db, routes, subscriptionUpdate };
}

function context(accounts: any[], eligible: number[], signalAccountId = 0) {
  return {
    subscriptionId: "home-sub",
    record: {},
    homeAccountId: 1,
    modelKey: "gpt-5.4",
    accounts,
    eligibleAccountIds: new Set(eligible),
    ...(signalAccountId > 0 ? {
      overflowSignal: {
        accountId: signalAccountId,
        leaseId: `lease-${signalAccountId}`,
        reason: "quota_exhausted" as const,
      },
    } : {}),
    activeLeaseCount: () => 0,
  };
}

function routerFor(subscriptions: any[]) {
  const state = mockPrisma(subscriptions);
  const router = new CodexOverflowRouter({
    prisma: state.db,
    now: () => NOW,
    getPublishedCatalog: async () => ({
      config: {
        accountCapacity: 1,
        oversellFactor: 1,
        shareCapacity: 1,
        pricing: {
          bind: {
            usdQuotaPerSeat: {
              codex: { pro: { fiveHour: 0, weekly: 100 } },
            },
          },
        },
      },
    }),
  });
  return { router, ...state };
}

describe("CodexOverflowRouter", () => {
  it("chooses the lowest projected coverage before the higher remaining ratio", async () => {
    const { router, subscriptionUpdate } = routerFor([
      subscription("home-sub", 1, 10),
      subscription("native-b", 2, 80),
      subscription("native-c", 3, 0),
    ]);
    const decision = await router.resolve(context([
      account(1, 0),
      account(2, 100),
      account(3, 50),
    ], [1, 2, 3]));

    expect(decision).toMatchObject({ servingAccountId: 3, overflow: true });
    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });

  it("uses weekly remaining ratio as the next tie-breaker", async () => {
    const { router } = routerFor([
      subscription("home-sub", 1, 10),
      // B: (40 + 10) / (100 * 100%) = 0.5
      subscription("native-b", 2, 40),
      // C: (15 + 10) / (100 * 50%) = 0.5
      subscription("native-c", 3, 15),
    ]);
    const decision = await router.resolve(context([
      account(1, 0),
      account(2, 100),
      account(3, 50),
    ], [1, 2, 3]));

    expect(decision.servingAccountId).toBe(2);
  });

  it("can continue A to B to C and automatically returns to recovered A", async () => {
    const { router, routes } = routerFor([
      subscription("home-sub", 1, 10),
    ]);
    const accounts = [account(1, 0), account(2, 90), account(3, 80)];

    const first = await router.resolve(context(accounts, [1, 2], 1));
    expect(first).toMatchObject({ servingAccountId: 2, overflow: true });

    const second = await router.resolve(context(accounts, [1, 2, 3], 2));
    expect(second).toMatchObject({ servingAccountId: 3, overflow: true });
    expect(routes[0]).toMatchObject({
      subscriptionId: "home-sub",
      homeAccountId: 1,
      servingAccountId: 3,
      status: "ACTIVE",
    });

    accounts[0].codexWeeklyPercent = 10;
    const recovered = await router.resolve(context(accounts, [1, 2, 3]));
    expect(recovered).toEqual({ servingAccountId: 1, overflow: false });
    expect(routes[0].status).toBe("HOME_RECOVERED");
  });

  it("does not route on an unknown/stale snapshot without a signed failure signal", async () => {
    const { router, routes } = routerFor([
      subscription("home-sub", 1, 10),
    ]);
    const home = account(1, 0);
    home.codexQuotaObservedAt = NOW - 31 * 60_000;
    const decision = await router.resolve(context([
      home,
      account(2, 100),
    ], [1, 2]));

    expect(decision).toEqual({ servingAccountId: 1, overflow: false });
    expect(routes).toHaveLength(0);
  });
});
