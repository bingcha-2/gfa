import { describe, expect, it } from "vitest";

import { estimateQuotaPool, type QuotaPoolSubscriptionInput } from "./quota-pool-estimate";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");
const account = {
  id: 7,
  email: "mother@example.com",
  planType: "max-20x",
  hourlyPercent: 70,
  weeklyPercent: 40,
  hourlyResetAt: "2026-07-17T15:00:00.000Z",
  weeklyResetAt: "2026-07-21T00:00:00.000Z",
  refreshedAt: NOW,
};

function subscription(overrides: Partial<QuotaPoolSubscriptionInput> = {}): QuotaPoolSubscriptionInput {
  return {
    id: "sub-1",
    customerEmail: "buyer@example.com",
    status: "ACTIVE",
    bindingAccountId: 7,
    weight: 1,
    exclusive: false,
    fiveHourLimit: 60,
    weeklyLimit: 300,
    usedFiveHour: 30,
    usedWeekly: 60,
    upstreamAccountId: 7,
    ...overrides,
  };
}

describe("estimateQuotaPool", () => {
  it("用订阅已用刀数除以母号已消耗比例，分别推算 5h 和周整池", () => {
    const pool = estimateQuotaPool("anthropic", account, [subscription()], NOW);

    expect(pool.fiveHour.inferredTotalUsd).toBe(100);
    expect(pool.fiveHour.inferredRemainingUsd).toBe(70);
    expect(pool.weekly.inferredTotalUsd).toBe(100);
    expect(pool.weekly.inferredRemainingUsd).toBe(40);
    expect(pool.fiveHour.soldLimitUsd).toBe(60);
    expect(pool.fiveHour.customerRemainingUsd).toBe(30);
    expect(pool.fiveHour.coverageRatio).toBeCloseTo(70 / 30);
    expect(pool.boundCustomerEmails).toEqual(["buyer@example.com"]);
  });

  it("仅暴露当前 ACTIVE 绑定订阅的去重客户邮箱，供母号搜索定位", () => {
    const pool = estimateQuotaPool("anthropic", account, [
      subscription({ id: "active-1", customerEmail: "Buyer@Example.com" }),
      subscription({ id: "active-2", customerEmail: "buyer@example.com" }),
      subscription({ id: "cancelled", status: "CANCELLED", customerEmail: "old@example.com" }),
      subscription({ id: "other-account", bindingAccountId: 8, customerEmail: "other@example.com" }),
    ], NOW);

    expect(pool.boundCustomerEmails).toEqual(["buyer@example.com"]);
  });

  it("已取消订阅只保留本窗口母号归因，不再计入已售额度", () => {
    const cancelled = subscription({
      id: "cancelled",
      status: "CANCELLED",
      fiveHourLimit: 500,
      usedFiveHour: 15,
    });
    const pool = estimateQuotaPool("anthropic", account, [subscription(), cancelled], NOW);

    expect(pool.fiveHour.trackedUsedUsd).toBe(45);
    expect(pool.fiveHour.soldLimitUsd).toBe(60);
    expect(pool.activeSubscriptionCount).toBe(1);
    expect(pool.accountingSubscriptionCount).toBe(2);
  });

  it("换绑后的旧母号用量不会计入当前母号推算", () => {
    const moved = subscription({ id: "moved", usedFiveHour: 90, upstreamAccountId: 8 });
    const pool = estimateQuotaPool("anthropic", account, [subscription(), moved], NOW);

    expect(pool.fiveHour.trackedUsedUsd).toBe(30);
    expect(pool.fiveHour.soldLimitUsd).toBe(120);
  });

  it("母号消耗不足 3% 时标记采样不足，不输出虚假的精确刀数", () => {
    const pool = estimateQuotaPool(
      "anthropic",
      { ...account, hourlyPercent: 98 },
      [subscription({ usedFiveHour: 2 })],
      NOW,
    );

    expect(pool.fiveHour.confidence).toBe("insufficient");
    expect(pool.fiveHour.inferredTotalUsd).toBeNull();
  });

  it("母号没有上报窗口时标记不可用", () => {
    const pool = estimateQuotaPool("codex", { ...account, hourlyPercent: -1 }, [subscription()], NOW);

    expect(pool.fiveHour.confidence).toBe("unavailable");
    expect(pool.fiveHour.remainingPercent).toBeNull();
  });
});
