import { describe, expect, it } from "vitest";

import { legacyColumnsToConfig, planColumnsToInitialConfig, rowToConfig, subscriptionToLimitRecord } from "./subscription-config";
import { occupiedSharesByAccount } from "./seat";

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
        displayBindings: { anthropic: "team-seat-a" },
        assignmentPolicy: "balanced",
        shareSeats: 6,
        shareCapacity: 12,
        weight: 8,
        bucketLimits: { "anthropic-claude": 50000 },
        weeklyBucketLimits: { "anthropic-claude": 250000 },
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
      displayBindings: { anthropic: "team-seat-a" },
      assignmentPolicy: "balanced",
      levels: { anthropic: "max-20x" },
      shareSeats: 6,
      shareCapacity: 12,
      weight: 8,
      bucketLimits: { "anthropic-claude": 50000 },
      weeklyBucketLimits: { "anthropic-claude": 250000 },
      requiresBinding: true,
      windowMs: 18000000,
      keyExpiresAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("bind record falls back to legacy bindings and weight defaults when new fields are absent", () => {
    const record = subscriptionToLimitRecord({
      id: "sub-legacy",
      status: "ACTIVE",
      expiresAt,
      config: {
        line: "bind",
        products: ["anthropic"],
        bindings: { anthropic: 1234 },
        weight: 8,
        windowMs: 18000000,
      },
    });

    expect(record).toMatchObject({
      bindings: { anthropic: 1234 },
      displayBindings: { anthropic: 1234 },
      assignmentPolicy: "pinned",
      levels: {},
      shareSeats: 8,
      shareCapacity: 8,
      weight: 8,
      bucketLimits: {},
      weeklyBucketLimits: {},
      requiresBinding: true,
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

describe("rowToConfig — config 列优先,空则回退 legacy 列(卡迁移订阅修复)", () => {
  const legacyBound = {
    productEntitlements: '["anthropic"]',
    bucketLimits: null,
    bindings: '{"anthropic":11}',
    levels: null,
    weight: 2,
    deviceLimit: 3,
    weeklyTokenLimit: null,
    windowMs: 18000000,
  };

  it("有显式 config → 直接用它", () => {
    const explicit = { line: "bind", products: ["codex"], bindings: { codex: 7 }, weight: 1 };
    const out = rowToConfig({ config: JSON.stringify(explicit), ...legacyBound } as any);
    expect(out.line).toBe("bind");
    expect((out.bindings as any).codex).toBe(7); // 用了 config,不是 legacy 的 anthropic:11
  });

  it("config 空(卡迁移订阅)→ 回退 legacy:line=bind + 原 bindings", () => {
    const out = rowToConfig({ config: null, ...legacyBound } as any);
    expect(out.line).toBe("bind");
    expect((out.bindings as any).anthropic).toBe(11); // 保住原账号绑定
    expect(out.weight).toBe(2);
  });

  it("回归:config 空的卡订阅,其份额被 occupiedSharesByAccount 正确计入(不再 0/N)", () => {
    // 模拟一张「config 空、legacy 绑 anthropic 号 11、weight 2」的迁移卡订阅。
    const cardSub = { id: "card_x", ...rowToConfig({ config: null, ...legacyBound } as any) };
    const shares = occupiedSharesByAccount([cardSub], "anthropic");
    expect(shares.get(11)).toBe(2); // 此前读空 config → 0;修复后 = weight 2
  });

  it("config 损坏(非法 JSON)→ 也回退 legacy,不抛", () => {
    const out = rowToConfig({ config: "{not json", ...legacyBound } as any);
    expect(out.line).toBe("bind");
    expect((out.bindings as any).anthropic).toBe(11);
  });
});
