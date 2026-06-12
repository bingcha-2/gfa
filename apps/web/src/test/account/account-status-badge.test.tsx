/**
 * Tests for semantic account status badges:
 *   src/components/account/account-status-badge.tsx
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AccountStatusBadge } from "@/components/account/account-status-badge";

describe("AccountStatusBadge", () => {
  it("renders a semantic tone and visible dot", () => {
    render(<AccountStatusBadge tone="success">可用</AccountStatusBadge>);

    const badge = screen.getByText("可用");
    expect(badge).toHaveAttribute("data-tone", "success");
    expect(badge.querySelector("[data-slot='status-dot']")).toBeInTheDocument();
  });

  it("defaults unknown status presentation to muted", () => {
    render(<AccountStatusBadge tone="muted">未知</AccountStatusBadge>);

    expect(screen.getByText("未知")).toHaveAttribute("data-tone", "muted");
  });
});
