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
      shareUsers: 1,
      deviceLimit: 1,
    });

    expect(result.priceCents).toBe(29900);
    expect(result.config).toEqual({
      line: "bind",
      products: ["anthropic"],
      levels: { anthropic: "max-20x" },
      weight: 8,
      deviceLimit: 1,
      windowMs: 18000000,
    });
  });

  it("共享人数折扣:Claude pro + 4 人 → 价格含负向 share 加价,weight=2", () => {
    const result = computePurchase(CATALOG, {
      line: "bind",
      items: [{ product: "anthropic", level: "pro" }],
      shareUsers: 4,
      deviceLimit: 1,
    });

    // 9900 + (-7000) = 2900
    expect(result.priceCents).toBe(9900 - 7000);
    expect(result.config.weight).toBe(2); // capacity 8 / 4 人
  });

  it("多产品各挑等级 + 8 人 + 2 设备 → Σ等级价 + share 折扣 + 额外设备,weight=1", () => {
    const result = computePurchase(CATALOG, {
      line: "bind",
      items: [
        { product: "anthropic", level: "max-5x" },
        { product: "codex", level: "pro" },
      ],
      shareUsers: 8,
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
        shareUsers: 1,
        deviceLimit: 1,
      }),
    ).toThrow(/level|等级|nonexistent/i);
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
