import { describe, it, expect } from "vitest";

import {
  clampSeats,
  normalizeSubscription,
  recoverUsageTier,
} from "../../../../scripts/rebuild-subscriptions-and-orders";
import type { CatalogConfig } from "../../plan-catalog/pricing";

// 与 pricing.spec.ts 同款最小目录;无 supplyPolicies / shareCapacity → 走 defaultSupplyPolicies 与 8。
const CATALOG = {
  products: ["anthropic", "codex", "antigravity"],
  levels: {
    anthropic: ["pro", "max-5x", "max-20x"],
    codex: ["plus", "pro"],
    antigravity: ["pro", "ultra"],
  },
  usageTiers: {
    small: { bucketLimits: { "anthropic-claude": 50000 }, weeklyTokenLimit: 250000 },
    large: { bucketLimits: { "anthropic-claude": 150000 }, weeklyTokenLimit: 750000 },
  },
  pricing: {
    pool: { product: { anthropic: 6900, codex: 3900, antigravity: 3900 }, usage: { small: 0, large: 3000 }, devicePerExtra: 900 },
    bind: {
      levelPrice: {
        anthropic: { pro: 9900, "max-5x": 15900, "max-20x": 29900 },
        codex: { plus: 13900, pro: 19900 },
        antigravity: { pro: 11900, ultra: 19900 },
      },
      share: { "1": 0, "2": -2000, "4": -4000, "8": 0 },
      devicePerExtra: 900,
    },
  },
  durationDays: 30,
  windowMs: 18000000,
} as unknown as CatalogConfig;

describe("clampSeats", () => {
  it("passes through valid seat options", () => {
    expect(clampSeats(1, 8)).toBe(1);
    expect(clampSeats(2, 8)).toBe(2);
    expect(clampSeats(4, 8)).toBe(4);
    expect(clampSeats(8, 8)).toBe(8);
  });
  it("rounds non-options down to nearest legal seat", () => {
    expect(clampSeats(3, 8)).toBe(2);
    expect(clampSeats(7, 8)).toBe(4);
    expect(clampSeats(0, 8)).toBe(1);
  });
  it("never exceeds shareCapacity", () => {
    expect(clampSeats(8, 4)).toBe(4);
  });
});

describe("recoverUsageTier", () => {
  it("matches a tier by bucketLimits + weeklyTokenLimit", () => {
    expect(recoverUsageTier(CATALOG, { "anthropic-claude": 150000 }, 750000)).toBe("large");
  });
  it("returns empty string when no tier matches", () => {
    expect(recoverUsageTier(CATALOG, { "anthropic-claude": 8000000 }, 0)).toBe("");
  });
});

describe("normalizeSubscription — bind line (catalog card with redesign bugs)", () => {
  it("flips preferred-dynamic→pinned, strips stale static caps, fills salesSeatCapacity, keeps bindings", () => {
    // 复刻导出里的真实形态:max-20x、shareSeats=2、preferred-dynamic、带 bucketLimits/weeklyBucketLimits。
    const effective = {
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      shareSeats: 2,
      shareCapacity: 8,
      weight: 2,
      assignmentPolicy: "preferred-dynamic",
      deviceLimit: 1,
      windowMs: 18000000,
      salesSeatCapacity: { anthropic: 10 },
      bucketLimits: { "anthropic-claude": 32152975 },
      weeklyBucketLimits: { "anthropic-claude": 100192073 },
      bindings: { anthropic: 7 },
    };
    const { config, selection, bucketLimitsColumn, line } = normalizeSubscription(CATALOG, effective);

    expect(line).toBe("bind");
    expect(config.assignmentPolicy).toBe("pinned");
    expect(config.bucketLimits).toBeUndefined();
    expect(config.weeklyBucketLimits).toBeUndefined();
    expect(config.salesSeatCapacity).toEqual({ anthropic: 10 });
    expect(config.shareSeats).toBe(2);
    expect(config.weight).toBe(2);
    expect(config.shareCapacity).toBe(8);
    expect(config.bindings).toEqual({ anthropic: 7 });
    expect(config.levels).toEqual({ anthropic: "max-20x" });
    // 镜像列清空 → 完全交给 fair-share。
    expect(bucketLimitsColumn).toBeNull();
    // 反推 selection。
    expect(selection).toEqual({
      line: "bind",
      items: [{ product: "anthropic", level: "max-20x" }],
      shareSeats: 2,
      deviceLimit: 1,
    });
  });
});

describe("normalizeSubscription — legacy migrated card (empty config, no levels)", () => {
  it("treats a bound legacy card as pinned bind, fills default level per product", () => {
    // rowToConfig 对空 config 的回退结果:line=bind(因 bindings 有真实 accountId)、无 levels。
    const effective = {
      line: "bind",
      products: ["codex"],
      levels: {},
      bindings: { codex: 8 },
      weight: 1,
      deviceLimit: 1,
      windowMs: 18000000,
    };
    const { config, selection } = normalizeSubscription(CATALOG, effective);

    expect(config.line).toBe("bind");
    expect(config.assignmentPolicy).toBe("pinned");
    expect(config.levels).toEqual({ codex: "pro" }); // catalog 默认档位
    expect(config.bindings).toEqual({ codex: 8 });
    expect(config.salesSeatCapacity).toEqual({ codex: 10 });
    expect(selection).toEqual({
      line: "bind",
      items: [{ product: "codex", level: "pro" }],
      shareSeats: 1,
      deviceLimit: 1,
    });
  });

  it("derives the level from the bound account's planType when available (overrides default)", () => {
    // 老卡缺档位,但所绑账号真实 planType=max-5x → 用 planType,不再回退默认 max-20x。
    const effective = {
      line: "bind",
      products: ["anthropic"],
      levels: {},
      bindings: { anthropic: 16 },
      deviceLimit: 1,
    };
    const resolveLevel = (product: string, accountId?: number) =>
      product === "anthropic" && accountId === 16 ? "max-5x" : undefined;
    const { config, selection } = normalizeSubscription(CATALOG, effective, resolveLevel);
    expect(config.levels).toEqual({ anthropic: "max-5x" });
    expect((selection as any).items).toEqual([{ product: "anthropic", level: "max-5x" }]);
  });

  it("keeps an explicit level even if the bound account planType differs", () => {
    const effective = {
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      bindings: { anthropic: 16 },
      deviceLimit: 1,
    };
    const resolveLevel = () => "max-5x";
    const { config } = normalizeSubscription(CATALOG, effective, resolveLevel);
    expect(config.levels).toEqual({ anthropic: "max-20x" }); // 购买意图权威,不被 planType 覆盖
  });

  it("treats an unbound legacy card as pool", () => {
    const effective = { line: "pool", products: ["antigravity"], bucketLimits: {}, weeklyTokenLimit: 0, deviceLimit: 1, windowMs: 18000000 };
    const { config, line, bucketLimitsColumn } = normalizeSubscription(CATALOG, effective);
    expect(line).toBe("pool");
    expect(config).toEqual({ line: "pool", products: ["antigravity"], bucketLimits: {}, weeklyTokenLimit: 0, deviceLimit: 1, windowMs: 18000000 });
    expect(bucketLimitsColumn).toBe("{}");
  });
});

describe("normalizeSubscription — pool line", () => {
  it("keeps resolved bucketLimits as-is and recovers the tier for the selection", () => {
    const effective = {
      line: "pool",
      products: ["anthropic"],
      bucketLimits: { "anthropic-claude": 150000 },
      weeklyTokenLimit: 750000,
      deviceLimit: 2,
      windowMs: 18000000,
    };
    const { config, selection, bucketLimitsColumn } = normalizeSubscription(CATALOG, effective);
    expect(config.bucketLimits).toEqual({ "anthropic-claude": 150000 });
    expect(config.weeklyTokenLimit).toBe(750000);
    expect(bucketLimitsColumn).toBe(JSON.stringify({ "anthropic-claude": 150000 }));
    expect(selection).toEqual({ line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 2 });
  });
});

describe("normalizeSubscription — exclusive (独享)", () => {
  it("preserves exclusive:true through normalization", () => {
    const effective = {
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      shareSeats: 8,
      shareCapacity: 8,
      exclusive: true,
      bindings: { anthropic: 3 },
      deviceLimit: 1,
    };
    const { config } = normalizeSubscription(CATALOG, effective);
    expect(config.exclusive).toBe(true);
    expect(config.shareSeats).toBe(8);
  });
});
