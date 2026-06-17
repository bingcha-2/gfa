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
      { product: "anthropic", level: "max-20x", accountId: 15, bound: true },
      { product: "codex", level: "plus", accountId: null, bound: false },
    ]);
  });

  it("pool line: 无绑定行,带用量档", () => {
    const v = buildSubscriptionView({
      config: JSON.stringify({ line: "pool", products: ["anthropic"], usageTier: "large", deviceLimit: 1, weight: 1 }),
    });
    expect(v.line).toBe("pool");
    expect(v.usageTier).toBe("large");
    expect(v.rows).toEqual([{ product: "anthropic", level: null, accountId: null, bound: false }]);
  });

  it("config 为 null/损坏 → 安全降级为 pool 空行", () => {
    expect(buildSubscriptionView({ config: null }).line).toBe("pool");
    expect(buildSubscriptionView({ config: "{bad json" }).rows).toEqual([]);
  });
});
