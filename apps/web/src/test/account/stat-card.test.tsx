/**
 * Tests for account dashboard stat cards:
 *   src/components/account/stat-card.tsx
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CreditCardIcon } from "lucide-react";

import { StatCard } from "@/components/account/stat-card";

describe("StatCard", () => {
  it("renders account metric cards with a semantic tone and structured slots", () => {
    render(
      <StatCard
        label="当前套餐"
        value="Pro"
        sub="有效期至 2026-07-01"
        tone="success"
        icon={<CreditCardIcon />}
      />
    );

    const card = screen.getByText("当前套餐").closest("[data-slot='stat-card']");

    expect(card).toHaveAttribute("data-tone", "success");
    expect(card).toHaveClass("account-stat-card");
    expect(card?.querySelector("[data-slot='stat-icon']")).toBeInTheDocument();
    expect(screen.getByText("当前套餐")).toHaveAttribute("data-slot", "stat-label");
    expect(screen.getByText("Pro")).toHaveAttribute("data-slot", "stat-value");
  });

  it("keeps loading placeholders inside the same account card structure", () => {
    render(<StatCard label="近 30 天用量" loading tone="info" sub="placeholder" />);

    const card = screen.getByText("近 30 天用量").closest("[data-slot='stat-card']");

    expect(card).toHaveAttribute("data-tone", "info");
    expect(card?.querySelectorAll("[data-slot='skeleton']")).toHaveLength(2);
  });
});
