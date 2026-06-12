import { describe, expect, it } from "vitest";

import { legacyColumnsToConfig } from "./subscription-config";

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
