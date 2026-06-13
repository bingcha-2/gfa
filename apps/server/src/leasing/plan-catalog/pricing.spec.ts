import { describe, it, expect } from "vitest";

import { computePurchase } from "./pricing";

// 一份代表性的 PlanCatalog.config(对齐 spec §4.1)
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

describe("computePurchase — 号池线", () => {
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
});

describe("computePurchase — 绑定线", () => {
  it("单产品 Claude max-20x + 独号(1人) + 1 设备 → ¥299,config 带等级与 weight、无用量上限", () => {
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
});

describe("computePurchase — 校验", () => {
  it("绑定线选了 catalog 里不存在的等级 → 抛错(不能默默算 0 价)", () => {
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

describe("computePurchase — 绑定线 weight 跟随注入的 shareCapacity(去容量双源)", () => {
  // 服务端读目录时把运行时 ACCOUNT_SHARE_CAPACITY 注入 config.shareCapacity;绑定线
  // weight = shareCapacity / 共享人数,与运行时座位口径同源(不再硬编码 8)。
  const withCap = (shareCapacity: number) => ({ ...CATALOG, shareCapacity });
  const sel = (shareUsers: number) => ({
    line: "bind" as const,
    items: [{ product: "anthropic", level: "max-20x" }],
    shareUsers,
    deviceLimit: 1,
  });

  it("shareCapacity=4(test 运行时):独号→4(占满)、2 人→2、4 人→1", () => {
    expect(computePurchase(withCap(4), sel(1)).config.weight).toBe(4);
    expect(computePurchase(withCap(4), sel(2)).config.weight).toBe(2);
    expect(computePurchase(withCap(4), sel(4)).config.weight).toBe(1);
  });

  it("shareCapacity=8(prod 默认):独号→8、2 人→4、8 人→1", () => {
    expect(computePurchase(withCap(8), sel(1)).config.weight).toBe(8);
    expect(computePurchase(withCap(8), sel(2)).config.weight).toBe(4);
    expect(computePurchase(withCap(8), sel(8)).config.weight).toBe(1);
  });

  it("config 未注入 shareCapacity → 回退 prod 默认 8(非权威路径如 console 预览)", () => {
    expect(computePurchase(CATALOG, sel(2)).config.weight).toBe(4); // 8 / 2
  });
});
