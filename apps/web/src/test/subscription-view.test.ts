import { describe, expect, it } from "vitest";
import { buildSubscriptionView } from "@/lib/console/subscription-view";

describe("buildSubscriptionView", () => {
  it("bind line: 逐产品行带等级+绑定号,未绑标记 unbound", () => {
    const v = buildSubscriptionView({
      config: JSON.stringify({
        line: "bind",
        products: ["anthropic", "codex"],
        levels: { anthropic: "max-20x", codex: "plus" },
        bindings: { anthropic: 15, codex: 0 },
        weight: 4,
        deviceLimit: 3,
      }),
    });
    expect(v.line).toBe("bind");
    expect(v.weight).toBe(4);
    expect(v.rows).toEqual([
      { product: "anthropic", level: "max-20x", accountId: 15, bound: true, accountEmail: null },
      { product: "codex", level: "plus", accountId: null, bound: false, accountEmail: null },
    ]);
  });

  it("pool line: 无绑定行,带用量档", () => {
    const v = buildSubscriptionView({
      config: JSON.stringify({ line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 1, weight: 1 }),
    });
    expect(v.line).toBe("pool");
    expect(v.usageTier).toBe("large");
    expect(v.rows).toEqual([{ product: "anthropic", level: null, accountId: null, bound: false, accountEmail: null }]);
  });

  it("config 为 null/损坏 + 无 legacy 列 → 安全降级为 pool 空行", () => {
    expect(buildSubscriptionView({ config: null }).line).toBe("pool");
    expect(buildSubscriptionView({ config: "{bad json" }).rows).toEqual([]);
  });

  it("config 空 → 回退 legacy bindings 列推断绑定线(对齐后端 rowToConfig)", () => {
    const v = buildSubscriptionView({
      config: null,
      productEntitlements: JSON.stringify(["anthropic", "codex"]),
      bindings: JSON.stringify({ anthropic: 15, codex: 0 }),
      levels: JSON.stringify({ anthropic: "max-20x", codex: "plus" }),
      weight: 4,
      deviceLimit: 3,
    });
    expect(v.line).toBe("bind");
    expect(v.weight).toBe(4);
    expect(v.deviceLimit).toBe(3);
    expect(v.rows).toEqual([
      { product: "anthropic", level: "max-20x", accountId: 15, bound: true, accountEmail: null },
      { product: "codex", level: "plus", accountId: null, bound: false, accountEmail: null },
    ]);
  });

  it("config 空 + 仅占位绑定(0)→ 回退仍是号池线", () => {
    const v = buildSubscriptionView({
      config: null,
      productEntitlements: JSON.stringify(["anthropic"]),
      bindings: JSON.stringify({ anthropic: 0 }),
    });
    expect(v.line).toBe("pool");
    expect(v.rows).toEqual([{ product: "anthropic", level: null, accountId: null, bound: false, accountEmail: null }]);
  });

  it("boundAccounts 提供时,绑定行带上账号邮箱", () => {
    const v = buildSubscriptionView({
      config: JSON.stringify({
        line: "bind",
        products: ["anthropic", "codex"],
        bindings: { anthropic: 2, codex: 0 },
      }),
      boundAccounts: { anthropic: { id: 2, email: "seat@team.com" } },
    });
    expect(v.rows[0]).toEqual({ product: "anthropic", level: null, accountId: 2, bound: true, accountEmail: "seat@team.com" });
    // 未绑定行 / 无邮箱映射 → accountEmail 为 null
    expect(v.rows[1].accountEmail).toBeNull();
  });

  it("无 boundAccounts → accountEmail 为 null(不报错)", () => {
    const v = buildSubscriptionView({
      config: JSON.stringify({ line: "bind", products: ["anthropic"], bindings: { anthropic: 2 } }),
    });
    expect(v.rows[0].accountEmail).toBeNull();
  });

  it("显式 config 优先于 legacy 列", () => {
    const v = buildSubscriptionView({
      config: JSON.stringify({ line: "pool", products: ["anthropic"], usageTier: "large" }),
      bindings: JSON.stringify({ anthropic: 15 }),
    });
    expect(v.line).toBe("pool");
    expect(v.usageTier).toBe("large");
  });
});
