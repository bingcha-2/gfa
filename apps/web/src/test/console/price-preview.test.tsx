/**
 * Tests for the 套餐配置页「实时算价预览」(交互式):
 *   src/app/(console)/console/(dashboard)/(product)/plan-catalog/price-preview.tsx
 *
 * 改成和客户端购买页同款交互:运营点选号池线 / 绑定线的产品、用量档、等级、共享、设备,
 * 实时看任意组合的价格。计价复用 computePurchase(与后端同口径)。这里验证:
 *   ① 进页面默认预选首产品 + 首档,即有非空价;② 各旋钮点击即时叠加;
 *   ③ 切到绑定线选产品默认首档 + 改等级 / 共享即时改价;④ 失效兜底不崩。
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { PricePreview } from "@/app/(console)/console/(dashboard)/(product)/plan-catalog/price-preview";
import { configToForm, type PlanCatalogForm } from "@/lib/console/plan-catalog-form";
import type { CatalogConfig } from "@/lib/account/catalog-pricing";

// 与 buy-page 测试同一份 fixture(分),经 configToForm 转成表单喂给预览。
const CONFIG: CatalogConfig = {
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

const FORM: PlanCatalogForm = configToForm(CONFIG);

function total() {
  return screen.getByTestId("preview-total").textContent;
}

describe("PricePreview — 号池线交互试算", () => {
  it("默认预选首产品(Anthropic)+ 小用量 → ¥69", () => {
    render(<PricePreview form={FORM} />);
    expect(total()).toBe("¥69");
  });

  it("加选 / 切档 / 加设备逐项即时叠加,取消产品回退", () => {
    render(<PricePreview form={FORM} />);

    // 加选 Codex → ¥69 + ¥39 = ¥108
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(total()).toBe("¥108");

    // 切大用量 → +¥30 = ¥138
    fireEvent.click(screen.getByRole("radio", { name: "大用量" }));
    expect(total()).toBe("¥138");

    // 设备 +1 → +¥9 = ¥147
    fireEvent.click(screen.getByRole("button", { name: "增加" }));
    expect(total()).toBe("¥147");

    // 取消 Codex → ¥69 + ¥30 + ¥9 = ¥108
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(total()).toBe("¥108");
  });
});

describe("PricePreview — 绑定线交互试算", () => {
  it("切到绑定线默认空,选产品默认首档,改等级 / 共享即时改价", () => {
    render(<PricePreview form={FORM} />);

    fireEvent.click(screen.getByRole("tab", { name: "绑定线" }));
    expect(total()).toBe("—");
    expect(screen.getByText("请为选中的产品各选一个等级")).toBeInTheDocument();

    // 选 Anthropic → 默认 pro ¥99
    fireEvent.click(screen.getByRole("button", { name: "Anthropic (Claude)" }));
    expect(total()).toBe("¥99");

    // 升 max-20x → ¥299
    const group = screen.getByRole("radiogroup", { name: /Anthropic/ });
    fireEvent.click(within(group).getByRole("radio", { name: "max-20x" }));
    expect(total()).toBe("¥299");

    // 共享 4 人 → 折扣 -¥70 → ¥229
    fireEvent.click(screen.getByRole("radio", { name: "4 人共享" }));
    expect(total()).toBe("¥229");
  });
});

describe("PricePreview — 线切换保留各自选配", () => {
  it("号池线选配切到绑定线再切回不丢", () => {
    render(<PricePreview form={FORM} />);
    expect(total()).toBe("¥69"); // 默认 Anthropic 小用量

    fireEvent.click(screen.getByRole("tab", { name: "绑定线" }));
    expect(total()).toBe("—");

    fireEvent.click(screen.getByRole("tab", { name: "号池线" }));
    expect(total()).toBe("¥69");
  });
});

describe("PricePreview — 边界", () => {
  it("无启用产品 → 给出提示,不崩", () => {
    const empty = configToForm({ ...CONFIG, products: [] });
    render(<PricePreview form={empty} />);
    expect(screen.getByText(/启用并配置产品后/)).toBeInTheDocument();
  });
});
