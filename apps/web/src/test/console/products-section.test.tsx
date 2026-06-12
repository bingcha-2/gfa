/**
 * Tests for the 套餐配置页「产品与等级」区块:
 *   src/app/(console)/console/(dashboard)/(product)/plan-catalog/products-section.tsx
 *
 * 绑定线等级改成「从账号池实际 planType 里选」(账号池里没有的等级选不了),不再手填。
 * 等级候选由 availableLevels[product] 提供(上层从 GET /api/console/account-levels 拉)。
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ProductsSection } from "@/app/(console)/console/(dashboard)/(product)/plan-catalog/products-section";
import type { ProductRow } from "@/lib/console/plan-catalog-form";

const rows: ProductRow[] = [
  { product: "anthropic", enabled: true, levels: ["max-20x"] },
];

const availableLevels = {
  anthropic: ["pro", "max-5x", "max-20x"],
};

describe("ProductsSection — 等级从账号池选", () => {
  it("把账号池里的等级渲染成可选项(含未选中的 pro / max-5x)", () => {
    render(
      <ProductsSection value={rows} onChange={() => {}} availableLevels={availableLevels} />,
    );
    expect(screen.getByRole("button", { name: /pro/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /max-5x/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /max-20x/ })).toBeInTheDocument();
  });

  it("点未选中的等级 → onChange 把它加进该产品 levels", () => {
    const onChange = vi.fn();
    render(
      <ProductsSection value={rows} onChange={onChange} availableLevels={availableLevels} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /max-5x/ }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as ProductRow[];
    expect(next[0].levels).toContain("max-5x");
    expect(next[0].levels).toContain("max-20x"); // 原有保留
  });

  it("点已选中的等级 → onChange 把它从 levels 去掉(toggle)", () => {
    const onChange = vi.fn();
    render(
      <ProductsSection value={rows} onChange={onChange} availableLevels={availableLevels} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /max-20x/ }));

    const next = onChange.mock.calls[0][0] as ProductRow[];
    expect(next[0].levels).not.toContain("max-20x");
  });

  it("不再渲染手填等级输入框", () => {
    render(
      <ProductsSection value={rows} onChange={() => {}} availableLevels={availableLevels} />,
    );
    expect(screen.queryByPlaceholderText(/新增等级/)).toBeNull();
  });

  it("账号池为空 → 提示该产品池里没有可选等级(先录号)", () => {
    render(
      <ProductsSection
        value={[{ product: "codex", enabled: true, levels: [] }]}
        onChange={() => {}}
        availableLevels={{ codex: [] }}
      />,
    );
    expect(screen.getByText(/账号池里没有可选等级/)).toBeInTheDocument();
  });

  it("已选等级在池里已不存在(孤儿)→ 仍可见并可移除,带提示", () => {
    const onChange = vi.fn();
    render(
      <ProductsSection
        value={[{ product: "anthropic", enabled: true, levels: ["legacy-tier"] }]}
        onChange={onChange}
        availableLevels={availableLevels}
      />,
    );
    // 孤儿档仍渲染(避免静默丢失老配置),点它可移除。
    const orphan = screen.getByRole("button", { name: /legacy-tier/ });
    expect(orphan).toBeInTheDocument();
    fireEvent.click(orphan);
    const next = onChange.mock.calls[0][0] as ProductRow[];
    expect(next[0].levels).not.toContain("legacy-tier");
  });
});
