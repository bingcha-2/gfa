/**
 * Parity tests for the client catalog pricing mirror:
 *   src/lib/account/catalog-pricing.ts
 *
 * The CATALOG fixture is copied verbatim from the server spec
 * (apps/server/src/leasing/plan-catalog/pricing.spec.ts) so a divergence
 * between client display price and server charge fails here.
 */

import { describe, it, expect } from "vitest";

import { computePurchase, type CatalogConfig } from "@/lib/account/catalog-pricing";

// 一份代表性的 PlanCatalog.config(对齐 spec §4.1 + 服务端 pricing.spec.ts)
const CATALOG: CatalogConfig = {
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
    pool: {
      product: { anthropic: 6900, codex: 3900, antigravity: 3900 },
      usage: { small: 0, large: 3000 },
      devicePerExtra: 900,
    },
    bind: {
      levelPrice: {
        anthropic: { pro: 9900, "max-5x": 15900, "max-20x": 29900 },
        codex: { plus: 13900, pro: 19900 },
        antigravity: { pro: 11900, ultra: 19900 },
      },
      share: { "1": 0, "2": -4000, "4": -7000, "8": -9000 },
      devicePerExtra: 900,
    },
  },
  durationDays: 30,
  windowMs: 18000000,
};

describe("computePurchase — 号池线(与服务端口径一致)", () => {
  it("单产品 Claude + 小用量 + 1 设备 → ¥69,config 快照用量档", () => {
    const result = computePurchase(CATALOG, {
      line: "pool",
      products: ["anthropic"],
      usageTier: "small",
      deviceLimit: 1,
    });

    expect(result.priceCents).toBe(6900);
    expect(result.config).toEqual({
      line: "pool",
      products: ["anthropic"],
      bucketLimits: { "anthropic-claude": 50000 },
      weeklyTokenLimit: 250000,
      deviceLimit: 1,
      windowMs: 18000000,
    });
  });

  it("多产品 + 大用量 + 3 设备 → Σ产品 + 用量加价 + 额外设备×2", () => {
    const result = computePurchase(CATALOG, {
      line: "pool",
      products: ["anthropic", "codex"],
      usageTier: "large",
      deviceLimit: 3,
    });

    // 6900 + 3900 + 3000(large) + 900×2(extra devices) = 15600
    expect(result.priceCents).toBe(6900 + 3900 + 3000 + 900 * 2);
    expect(result.config.weeklyTokenLimit).toBe(750000);
  });

  it("零产品 + 小用量 + 1 设备 → ¥0(纯加法,无基础底价)", () => {
    const result = computePurchase(CATALOG, {
      line: "pool",
      products: [],
      usageTier: "small",
      deviceLimit: 1,
    });
    expect(result.priceCents).toBe(0);
  });
});

describe("computePurchase — 绑定线(与服务端口径一致)", () => {
  it("单产品 Claude max-20x + 独号(1人) + 1 设备 → ¥299,config 带等级与 weight 8", () => {
    const result = computePurchase(CATALOG, {
      line: "bind",
      items: [{ product: "anthropic", level: "max-20x" }],
      shareSeats: 8,
      deviceLimit: 1,
    });

    expect(result.priceCents).toBe(29900);
    expect(result.config).toEqual({
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      shareSeats: 8,
      shareCapacity: 8,
      weight: 8,
      assignmentPolicy: "preferred-dynamic",
      deviceLimit: 1,
      windowMs: 18000000,
    });
  });

  it("shareSeats=2 生成 bind config: shareSeats=2, capacity=8, weight=2, preferred-dynamic", () => {
    const result = computePurchase(CATALOG, {
      line: "bind",
      items: [{ product: "anthropic", level: "pro" }],
      shareSeats: 2,
      deviceLimit: 1,
    });

    // 9900 + (-7000) = 2900
    expect(result.priceCents).toBe(9900 - 7000);
    expect(result.config).toEqual({
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "pro" },
      shareSeats: 2,
      shareCapacity: 8,
      weight: 2,
      assignmentPolicy: "preferred-dynamic",
      deviceLimit: 1,
      windowMs: 18000000,
    });
  });

  it("legacy shareUsers=4 转换为 shareSeats=2, weight=2", () => {
    const result = computePurchase(CATALOG, {
      line: "bind",
      items: [{ product: "anthropic", level: "pro" }],
      shareUsers: 4,
      deviceLimit: 1,
    });

    expect(result.priceCents).toBe(9900 - 7000);
    expect(result.config.shareSeats).toBe(2);
    expect(result.config.weight).toBe(2);
  });

  it("legacy shareUsers=8 鍦?shareCapacity=4 涓嬩粛杞垚鏈€灏?1 席", () => {
    const result = computePurchase({ ...CATALOG, shareCapacity: 4 }, {
      line: "bind",
      items: [{ product: "anthropic", level: "max-20x" }],
      shareUsers: 8,
      deviceLimit: 1,
    });

    expect(result.priceCents).toBe(29900 - 9000);
    expect(result.config.shareSeats).toBe(1);
    expect(result.config.shareCapacity).toBe(4);
    expect(result.config.weight).toBe(1);
  });

  it("多产品各挑等级 + 8 人 + 2 设备 → Σ等级价 + share 折扣 + 额外设备,weight=1", () => {
    const result = computePurchase(CATALOG, {
      line: "bind",
      items: [
        { product: "anthropic", level: "max-5x" },
        { product: "codex", level: "pro" },
      ],
      shareSeats: 1,
      deviceLimit: 2,
    });

    // 15900 + 19900 + (-9000) + 900 = 27700
    expect(result.priceCents).toBe(15900 + 19900 - 9000 + 900);
    expect(result.config.products).toEqual(["anthropic", "codex"]);
    expect(result.config.levels).toEqual({ anthropic: "max-5x", codex: "pro" });
    expect(result.config.weight).toBe(1);
  });
});

describe("computePurchase — 校验(非法选择抛错,绝不默默算 0)", () => {
  it("绑定线选了 catalog 里不存在的等级 → 抛错", () => {
    expect(() =>
      computePurchase(CATALOG, {
        line: "bind",
        items: [{ product: "anthropic", level: "nonexistent" }],
        shareSeats: 8,
        deviceLimit: 1,
      }),
    ).toThrow(/level|等级|nonexistent/i);
  });

  it("非法 shareSeats=3 → 抛错", () => {
    expect(() =>
      computePurchase(CATALOG, {
        line: "bind",
        items: [{ product: "anthropic", level: "pro" }],
        shareSeats: 3,
        deviceLimit: 1,
      }),
    ).toThrow(/shareSeats|seat/i);
  });

  it("小数 shareSeats=2.9 → 抛错", () => {
    expect(() =>
      computePurchase(CATALOG, {
        line: "bind",
        items: [{ product: "anthropic", level: "pro" }],
        shareSeats: 2.9,
        deviceLimit: 1,
      }),
    ).toThrow(/shareSeats|seat/i);
  });

  it("显式非法 shareSeats 不被 legacy shareUsers 掩盖", () => {
    expect(() =>
      computePurchase(CATALOG, {
        line: "bind",
        items: [{ product: "anthropic", level: "pro" }],
        shareSeats: 3,
        shareUsers: 4,
        deviceLimit: 1,
      }),
    ).toThrow(/shareSeats|seat/i);
  });

  it("显式 shareSeats 超过 shareCapacity → 抛错", () => {
    expect(() =>
      computePurchase({ ...CATALOG, shareCapacity: 4 }, {
        line: "bind",
        items: [{ product: "anthropic", level: "pro" }],
        shareSeats: 8,
        deviceLimit: 1,
      }),
    ).toThrow(/shareSeats|seat/i);
  });

  it("号池线选了不存在的用量档 → 抛错", () => {
    expect(() =>
      computePurchase(CATALOG, {
        line: "pool",
        products: ["anthropic"],
        usageTier: "huge",
        deviceLimit: 1,
      }),
    ).toThrow(/usage|用量|huge/i);
  });
});
