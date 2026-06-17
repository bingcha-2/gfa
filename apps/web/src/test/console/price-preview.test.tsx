import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { PricePreview } from "@/app/(console)/console/(dashboard)/(product)/plan-catalog/price-preview";
import { configToForm, type PlanCatalogForm } from "@/lib/console/plan-catalog-form";
import type { CatalogConfig } from "@/lib/account/catalog-pricing";

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

describe("PricePreview unified bind line", () => {
  it("starts empty and exposes only bind-line controls", () => {
    render(<PricePreview form={FORM} />);

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "号池线" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "大用量" })).not.toBeInTheDocument();
    expect(total()).toBe("—");
    expect(screen.getByText("请为选中的产品各选一个等级")).toBeInTheDocument();
  });

  it("prices product, level, seat, and device changes through shareSeats", () => {
    render(<PricePreview form={FORM} />);

    fireEvent.click(screen.getByRole("button", { name: "Anthropic (Claude)" }));
    expect(total()).toBe("¥9");

    const group = screen.getByRole("radiogroup", { name: /Anthropic/ });
    fireEvent.click(within(group).getByRole("radio", { name: "max-20x" }));
    expect(total()).toBe("¥209");

    fireEvent.click(screen.getByRole("radio", { name: "2/8 席" }));
    expect(total()).toBe("¥229");

    fireEvent.click(screen.getByRole("button", { name: "增加" }));
    expect(total()).toBe("¥238");
  });

});

describe("PricePreview edge cases", () => {
  it("shows an empty hint when no product is enabled", () => {
    const empty = configToForm({ ...CONFIG, products: [] });
    render(<PricePreview form={empty} />);

    expect(screen.getByText(/启用并配置产品后/)).toBeInTheDocument();
  });
});
