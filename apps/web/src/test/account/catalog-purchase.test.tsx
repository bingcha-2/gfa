/**
 * Component tests for the two-line catalog purchase UI:
 *   src/components/account/catalog-purchase.tsx
 *
 * Focus: the live price recomputes on every knob change and matches the same
 * pure function the server charges with; checkout is gated until a valid
 * selection exists; switching lines swaps the panel.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { CatalogPurchase } from "@/components/account/catalog-purchase";
import type { CatalogConfig } from "@/lib/account/catalog-pricing";

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

function total() {
  return screen.getByTestId("catalog-total").textContent;
}

function checkoutBtn() {
  return screen.getByRole("button", { name: "去支付" });
}

describe("CatalogPurchase — 默认绑定线", () => {
  it("首屏默认选中绑定线,且绑定线排在号池线之前", () => {
    render(<CatalogPurchase catalog={CATALOG} />);

    // 绑定模式置前:第一个 tab 是绑定线
    expect(screen.getAllByRole("tab")[0]).toHaveTextContent("绑定线");

    // 默认选中绑定线、号池线未选中
    expect(screen.getByRole("tab", { name: /绑定线/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /号池线/ })).toHaveAttribute("aria-selected", "false");

    // 绑定线初始空 → 价格占位 + 等级提示
    expect(total()).toBe("—");
    expect(screen.getByText("请为选中的产品各选一个等级")).toBeInTheDocument();
  });
});

describe("CatalogPurchase — 号池线实时算价", () => {
  it("切到号池线后无产品 → 价格占位、去支付禁用、给出提示", () => {
    render(<CatalogPurchase catalog={CATALOG} />);
    fireEvent.click(screen.getByRole("tab", { name: /号池线/ }));
    expect(total()).toBe("—");
    expect(checkoutBtn()).toBeDisabled();
    expect(screen.getByText("请至少选择一个产品")).toBeInTheDocument();
  });

  it("选产品 + 切大用量 + 加设备 → 价格逐项即时叠加(与 computePurchase 一致)", () => {
    render(<CatalogPurchase catalog={CATALOG} />);
    fireEvent.click(screen.getByRole("tab", { name: /号池线/ }));

    // 选 Claude → ¥69
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(total()).toBe("¥69");
    expect(checkoutBtn()).toBeEnabled();

    // 加选 Codex → ¥69 + ¥39 = ¥108
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(total()).toBe("¥108");

    // 切大用量 → +¥30 = ¥138(用量是单选 radio)
    fireEvent.click(screen.getByRole("radio", { name: "大用量" }));
    expect(total()).toBe("¥138");

    // 设备 +1 → +¥9 = ¥147
    fireEvent.click(screen.getByRole("button", { name: "增加" }));
    expect(total()).toBe("¥147");

    // 取消 Codex → 回到 ¥69 + ¥30 + ¥9 = ¥108
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(total()).toBe("¥108");
  });
});

describe("CatalogPurchase — 绑定线实时算价", () => {
  it("切到绑定线后选产品默认首档,改等级 / 共享人数即时改价", () => {
    render(<CatalogPurchase catalog={CATALOG} />);

    // 切到绑定线
    fireEvent.click(screen.getByRole("tab", { name: /绑定线/ }));
    expect(total()).toBe("—");
    expect(screen.getByText("请为选中的产品各选一个等级")).toBeInTheDocument();

    // 选 Claude → 默认 pro ¥99
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(total()).toBe("¥99");

    // 升到 max-20x → ¥299
    fireEvent.click(screen.getByRole("radio", { name: "Max 20x" }));
    expect(total()).toBe("¥299");

    // 共享 4 人 → 折扣 -¥70 → ¥229
    fireEvent.click(screen.getByRole("radio", { name: "4 人拼车" }));
    expect(total()).toBe("¥229");
  });
});

describe("CatalogPurchase — 线切换", () => {
  it("两条线各自保留选配,切回不丢状态", () => {
    render(<CatalogPurchase catalog={CATALOG} />);

    // 号池线选 Claude(默认在绑定线,先切到号池线)
    fireEvent.click(screen.getByRole("tab", { name: /号池线/ }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(total()).toBe("¥69");

    // 切到绑定线 → 独立空状态
    fireEvent.click(screen.getByRole("tab", { name: /绑定线/ }));
    expect(total()).toBe("—");

    // 切回号池线 → Claude 仍在
    fireEvent.click(screen.getByRole("tab", { name: /号池线/ }));
    expect(total()).toBe("¥69");
  });

  it("绑定线产品块在选中后才显示等级单选", () => {
    render(<CatalogPurchase catalog={CATALOG} />);
    fireEvent.click(screen.getByRole("tab", { name: /绑定线/ }));

    // 未选中时没有等级 radio
    expect(screen.queryByRole("radio", { name: "Pro" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    const group = screen.getByRole("radiogroup", { name: /Codex/ });
    expect(within(group).getByRole("radio", { name: "Plus" })).toBeInTheDocument();
    expect(within(group).getByRole("radio", { name: "Pro" })).toBeInTheDocument();
  });
});
