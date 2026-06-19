/**
 * PlanCatalog 表单 ↔ config 纯转换层测试(lib/console/plan-catalog-form.ts)。
 *
 * 重点:元↔分换算、嵌套结构(products/levels/usageTiers/pricing)拆解与组装、
 * round-trip 稳定性,以及组装产物能直接喂 catalog-pricing 的 computePurchase
 * (与后端计价同口径)。CATALOG fixture 与 catalog-pricing.test.ts / 服务端
 * pricing.spec.ts 同源。
 */

import { describe, it, expect } from "vitest";

import {
  configToForm,
  formToConfig,
  validateForm,
  yuanToCents,
  centsToYuan,
  type PlanCatalogForm,
} from "@/lib/console/plan-catalog-form";
import { computePurchase, type CatalogConfig } from "@/lib/account/catalog-pricing";

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
      share: { "1": 0, "2": -2000, "4": -4000, "8": 0 },
      devicePerExtra: 900,
    },
  },
  durationDays: 30,
  windowMs: 18000000,
};

describe("yuanToCents / centsToYuan — 元↔分", () => {
  it("元 → 分:整数与两位小数都四舍五入到整分", () => {
    expect(yuanToCents("69")).toBe(6900);
    expect(yuanToCents("99.90")).toBe(9990);
    expect(yuanToCents("19.99")).toBe(1999); // 防 19.99*100=1998.999… 浮点
    expect(yuanToCents("0")).toBe(0);
  });

  it("元 → 分:空串 / 非法 → 0", () => {
    expect(yuanToCents("")).toBe(0);
    expect(yuanToCents("abc")).toBe(0);
  });

  it("分 → 元:去掉末尾零与浮点误差", () => {
    expect(centsToYuan(6900)).toBe("69");
    expect(centsToYuan(9990)).toBe("99.9");
    expect(centsToYuan(0)).toBe("0");
    expect(centsToYuan(-4000)).toBe("-40"); // 折扣为负
  });
});

describe("configToForm — 拆解 + ÷100", () => {
  const form = configToForm(CATALOG);

  it("产品行:保序、enabled、等级", () => {
    expect(form.products.map((p) => p.product)).toEqual([
      "anthropic",
      "codex",
      "antigravity",
    ]);
    expect(form.products.every((p) => p.enabled)).toBe(true);
    expect(form.products[0].levels).toEqual(["pro", "max-5x", "max-20x"]);
  });

  it("号池产品价:分 → 元", () => {
    expect(form.pricing.pool.product.anthropic).toBe("69");
    expect(form.pricing.pool.devicePerExtra).toBe("9");
    expect(form.pricing.pool.usage.large).toBe("30");
  });

  it("绑定等级价矩阵 + 共享折扣:分 → 元", () => {
    expect(form.pricing.bind.levelPrice.anthropic["max-20x"]).toBe("299");
    expect(form.pricing.bind.share["2"]).toBe("-20");
  });

  it("用量档:token 数原样为字符串,周限额拆出", () => {
    const small = form.usageTiers.find((t) => t.key === "small")!;
    expect(small.bucketLimits["anthropic-claude"]).toBe("50000");
    expect(small.weeklyTokenLimit).toBe("250000");
  });

  it("有效期 / 窗口", () => {
    expect(form.durationDays).toBe("30");
    expect(form.windowMs).toBe("18000000");
  });
});

describe("formToConfig — 组装 + ×100", () => {
  it("round-trip:config → form → config 字节等价", () => {
    const back = formToConfig(configToForm(CATALOG));
    expect(back).toEqual(CATALOG);
  });

  it("round-trip preserves supplyPolicies without interpreting nested policy JSON", () => {
    const supplyPolicies = {
      anthropic: {
        defaultLevel: "max-20x",
        salesSeatsPerAccount: { "max-20x": 10 },
        buckets: {
          "anthropic-claude": {
            source: "learned",
            provider: "anthropic",
            planType: "max-20x",
            family: "claude",
            samplePolicy: { trust: "operator" },
          },
        },
      },
    };
    const form = configToForm({
      ...CATALOG,
      supplyPolicies,
    } as any);
    const back = formToConfig(form as any);

    expect(form.supplyPolicies).toEqual({
      anthropic: {
        ...supplyPolicies.anthropic,
        salesSeatsPerAccount: { "max-20x": "10" },
      },
    });
    expect(back.supplyPolicies).toEqual(supplyPolicies);
  });

  it("round-trip preserves oversellFactor as an editable top-level catalog field", () => {
    const form = configToForm({
      ...CATALOG,
      oversellFactor: 1.25,
    } as any);
    const back = formToConfig(form as any) as any;

    expect((form as any).oversellFactor).toBe("1.25");
    expect(back.oversellFactor).toBe(1.25);
  });

  it("clamps oversellFactor below 1 to the server minimum", () => {
    const form = configToForm(CATALOG) as any;
    form.oversellFactor = "0.5";

    expect((formToConfig(form) as any).oversellFactor).toBe(1);
  });

  it("converts editable supply policy sales seat strings back to config numbers", () => {
    const form = configToForm({
      ...CATALOG,
      supplyPolicies: {
        anthropic: {
          defaultLevel: "max-20x",
          salesSeatsPerAccount: { "max-20x": 10 },
          buckets: {
            "anthropic-claude": {
              source: "learned",
              provider: "anthropic",
              planType: "max-20x",
              family: "claude",
            },
          },
        },
      },
    } as any);

    form.supplyPolicies!.anthropic.salesSeatsPerAccount["max-20x"] = "12" as any;

    expect(
      formToConfig(form as any).supplyPolicies!.anthropic.salesSeatsPerAccount["max-20x"],
    ).toBe(12);
  });

  it("组装产物可直接喂 computePurchase,价格与原 catalog 一致", () => {
    const back = formToConfig(configToForm(CATALOG));

    const pool = computePurchase(back, {
      line: "pool",
      products: ["anthropic", "codex"],
      usageTier: "large",
      deviceLimit: 3,
    });
    expect(pool.priceCents).toBe(6900 + 3900 + 3000 + 900 * 2);

    const bind = computePurchase(back, {
      line: "bind",
      items: [{ product: "anthropic", level: "max-20x" }],
      shareUsers: 2,
      deviceLimit: 1,
    });
    // 29900 + (-4000 share) = 25900
    expect(bind.priceCents).toBe(Math.floor((29900 * 4) / 8) - 4000);
    expect(bind.config.weight).toBe(4); // capacity 8 / 2 人
  });

  it("停用产品:不进 config.products,但其 levels / 价仍保留", () => {
    const form = configToForm(CATALOG);
    form.products[1].enabled = false; // 停用 codex
    const config = formToConfig(form);

    expect(config.products).toEqual(["anthropic", "antigravity"]);
    // levels / 等级价矩阵对所有出现过的产品仍写(便于重新启用)。
    expect(config.levels.codex).toEqual(["plus", "pro"]);
    expect(config.pricing.bind.levelPrice.codex.plus).toBe(13900);
  });

  it("删等级:等级价矩阵随之丢弃该等级", () => {
    const form = configToForm(CATALOG);
    const anthropic = form.products.find((p) => p.product === "anthropic")!;
    anthropic.levels = ["pro"]; // 删掉 max-5x / max-20x
    const config = formToConfig(form);

    expect(config.levels.anthropic).toEqual(["pro"]);
    expect(Object.keys(config.pricing.bind.levelPrice.anthropic)).toEqual(["pro"]);
  });

  it("用量桶留空(0)不写进 bucketLimits", () => {
    const form = configToForm(CATALOG);
    const small = form.usageTiers.find((t) => t.key === "small")!;
    small.bucketLimits["anthropic-claude"] = ""; // 清空
    const config = formToConfig(form);
    expect(config.usageTiers.small.bucketLimits).toEqual({});
  });

  it("新增产品 + 等级 + 价:从空 config 长出来", () => {
    const empty: CatalogConfig = {
      products: [],
      levels: {},
      usageTiers: {},
      pricing: {
        pool: { product: {}, usage: {}, devicePerExtra: 0 },
        bind: { levelPrice: {}, share: {}, devicePerExtra: 0 },
      },
      durationDays: 30,
      windowMs: 18000000,
    };
    const form = configToForm(empty);
    const next: PlanCatalogForm = {
      ...form,
      products: [{ product: "anthropic", enabled: true, levels: ["pro"] }],
      usageTiers: [
        { key: "small", bucketLimits: { "anthropic-claude": "50000" }, weeklyTokenLimit: "250000" },
      ],
      pricing: {
        pool: { product: { anthropic: "69" }, usage: { small: "0" }, devicePerExtra: "9" },
        bind: {
          levelPrice: { anthropic: { pro: "99" } },
          share: { "1": "0", "2": "-20", "4": "-40", "8": "0" },
          devicePerExtra: "9",
        },
      },
    };
    const config = formToConfig(next);
    expect(config.products).toEqual(["anthropic"]);
    expect(config.pricing.pool.product.anthropic).toBe(6900);
    expect(config.pricing.bind.levelPrice.anthropic.pro).toBe(9900);
    expect(config.usageTiers.small.weeklyTokenLimit).toBe(250000);
  });
});

describe("configToForm — 容错(半成品 config 不崩)", () => {
  it("缺失字段补空安全默认", () => {
    // 故意残缺:只有 products,其余全缺。
    const partial = { products: ["anthropic"] } as unknown as CatalogConfig;
    const form = configToForm(partial);
    expect(form.products[0].product).toBe("anthropic");
    expect(form.products[0].enabled).toBe(true);
    expect(form.usageTiers).toEqual([]);
    expect(form.pricing.pool.devicePerExtra).toBe("0");
    // 不抛即通过。
  });
});

describe("validateForm — 发布前轻校验", () => {
  it("完整 config 通过", () => {
    expect(validateForm(configToForm(CATALOG))).toEqual([]);
  });

  it("无启用产品 → 报错", () => {
    const form = configToForm(CATALOG);
    form.products.forEach((p) => (p.enabled = false));
    expect(validateForm(form)).toContain("至少启用一个产品。");
  });

  it("启用产品但无等级 → 报错", () => {
    const form = configToForm(CATALOG);
    const anthropic = form.products.find((p) => p.product === "anthropic")!;
    anthropic.levels = [];
    expect(validateForm(form).some((e) => e.includes("anthropic"))).toBe(true);
  });

  it("有效期 < 1 / 窗口过小 → 报错", () => {
    const form = configToForm(CATALOG);
    form.durationDays = "0";
    form.windowMs = "1000";
    const errors = validateForm(form);
    expect(errors.some((e) => e.includes("有效期"))).toBe(true);
    expect(errors.some((e) => e.includes("窗口"))).toBe(true);
  });

  it("旧版用量档为空不阻塞统一绑定线发布", () => {
    const form = configToForm(CATALOG);
    form.usageTiers = [];
    expect(validateForm(form)).toEqual([]);
  });
});
