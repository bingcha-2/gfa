import { describe, expect, it } from "vitest";

import { legacyColumnsToConfig, planColumnsToInitialConfig, subscriptionToLimitRecord } from "./subscription-config";

describe("planColumnsToInitialConfig — 下单时按 plan 意图建初始 config(座位未分配前定 line)", () => {
  it("plan 配了 levels → 绑定线 line=bind,bindings 空(待座位分配),含 levels/weight", () => {
    const config = planColumnsToInitialConfig({
      productEntitlements: '["anthropic"]',
      bucketLimits: null,
      bindings: null, // 下单时尚未分配座位
      levels: '{"anthropic":"max-20x"}',
      weight: 8,
      deviceLimit: 1,
      weeklyTokenLimit: null,
      windowMs: 18000000,
    });
    expect(config).toEqual({
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      bindings: {},
      weight: 8,
      deviceLimit: 1,
      windowMs: 18000000,
    });
  });

  it("plan 无 levels(纯用量)→ 号池线 line=pool,含用量上限", () => {
    const config = planColumnsToInitialConfig({
      productEntitlements: '["anthropic"]',
      bucketLimits: '{"anthropic-claude":50000}',
      bindings: null,
      levels: null,
      weight: 1,
      deviceLimit: 2,
      weeklyTokenLimit: 250000,
      windowMs: 18000000,
    });
    expect(config).toEqual({
      line: "pool",
      products: ["anthropic"],
      bucketLimits: { "anthropic-claude": 50000 },
      weeklyTokenLimit: 250000,
      deviceLimit: 2,
      windowMs: 18000000,
    });
  });

  it("plan 配了 levels 但是空对象 → 视为号池(没有要绑的等级)", () => {
    const config = planColumnsToInitialConfig({
      productEntitlements: '["codex"]',
      bucketLimits: '{"codex-codex":40000}',
      bindings: null,
      levels: "{}",
      weight: 1,
      deviceLimit: 1,
      weeklyTokenLimit: 200000,
      windowMs: 18000000,
    });
    expect(config.line).toBe("pool");
  });
});

describe("legacyColumnsToConfig — 老订阅列收敛成 config", () => {
  it("号池(bindings 空)→ line=pool,含用量上限,不含 levels/bindings", () => {
    const config = legacyColumnsToConfig({
      productEntitlements: '["anthropic"]',
      bucketLimits: '{"anthropic-claude":50000}',
      bindings: null,
      levels: null,
      weight: 1,
      deviceLimit: 2,
      weeklyTokenLimit: 250000,
      windowMs: 18000000,
    });

    expect(config).toEqual({
      line: "pool",
      products: ["anthropic"],
      bucketLimits: { "anthropic-claude": 50000 },
      weeklyTokenLimit: 250000,
      deviceLimit: 2,
      windowMs: 18000000,
    });
  });

  it("绑定(bindings 有真实 accountId)→ line=bind,含 levels/bindings/weight,不含用量上限", () => {
    const config = legacyColumnsToConfig({
      productEntitlements: '["anthropic"]',
      bucketLimits: null,
      bindings: '{"anthropic":1234}',
      levels: '{"anthropic":"max-20x"}',
      weight: 8,
      deviceLimit: 1,
      weeklyTokenLimit: null,
      windowMs: 18000000,
    });

    expect(config).toEqual({
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      bindings: { anthropic: 1234 },
      weight: 8,
      deviceLimit: 1,
      windowMs: 18000000,
    });
  });

  it("bindings 全是 0(占位、未真正绑号)→ 视为号池 line=pool", () => {
    const config = legacyColumnsToConfig({
      productEntitlements: '["codex"]',
      bucketLimits: '{"codex-codex":40000}',
      bindings: '{"codex":0}',
      levels: null,
      weight: 1,
      deviceLimit: 1,
      weeklyTokenLimit: 200000,
      windowMs: 18000000,
    });

    expect(config.line).toBe("pool");
  });
});

describe("subscriptionToLimitRecord — config → 限额引擎 record(去影子)", () => {
  const expiresAt = new Date("2026-07-01T00:00:00.000Z");

  it("号池订阅 → record 含 bucketLimits/weeklyTokenLimit,status=active", () => {
    const record = subscriptionToLimitRecord({
      id: "sub-1",
      customerId: "cust-1",
      priority: 3,
      status: "ACTIVE",
      expiresAt,
      config: {
        line: "pool",
        products: ["anthropic"],
        bucketLimits: { "anthropic-claude": 50000 },
        weeklyTokenLimit: 250000,
        deviceLimit: 2,
        windowMs: 18000000,
      },
    });

    expect(record).toEqual({
      id: "sub-1",
      customerId: "cust-1",
      priority: 3,
      status: "active",
      products: ["anthropic"],
      bucketLimits: { "anthropic-claude": 50000 },
      weeklyTokenLimit: 250000,
      windowMs: 18000000,
      keyExpiresAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("绑定订阅 → record 含 bindings/weight、requiresBinding=true,不含用量上限", () => {
    const record = subscriptionToLimitRecord({
      id: "sub-2",
      customerId: "cust-2",
      priority: 0,
      status: "ACTIVE",
      expiresAt,
      config: {
        line: "bind",
        products: ["anthropic"],
        levels: { anthropic: "max-20x" },
        bindings: { anthropic: 1234 },
        weight: 8,
        deviceLimit: 1,
        windowMs: 18000000,
      },
    });

    expect(record).toEqual({
      id: "sub-2",
      customerId: "cust-2",
      priority: 0,
      status: "active",
      products: ["anthropic"],
      bindings: { anthropic: 1234 },
      weight: 8,
      requiresBinding: true,
      windowMs: 18000000,
      keyExpiresAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("非 ACTIVE 状态 → record.status 非 active(引擎据此拒绝)", () => {
    const record = subscriptionToLimitRecord({
      id: "sub-3",
      status: "EXPIRED",
      expiresAt,
      config: { line: "pool", products: ["anthropic"], bucketLimits: {}, weeklyTokenLimit: 0, deviceLimit: 1, windowMs: 18000000 },
    });

    expect(record.status).not.toBe("active");
  });
});
