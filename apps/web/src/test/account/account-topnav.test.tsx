/**
 * Tests for account top navigation:
 *   src/components/account/account-topnav.tsx
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { AccountTopNav } from "@/components/account/account-topnav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/account/billing",
  // AccountLocaleSwitcher reads useRouter() to refresh after a locale change.
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/account/account-provider", () => ({
  useAccount: () => ({
    customer: { email: "member@example.com", displayName: "" },
    handleLogout: vi.fn(),
    unread: 0,
  }),
}));

describe("AccountTopNav", () => {
  it("renders a desktop account rail and keeps billing active", () => {
    render(<AccountTopNav />);

    const billingLink = screen.getByRole("link", { name: /订阅|Billing/i });

    expect(billingLink).toHaveAttribute("data-active");
    expect(billingLink).toHaveClass("account-rail__link");
    expect(document.querySelector(".account-rail")).toBeInTheDocument();
    // The old sidebar shell is gone.
    expect(document.querySelector(".account-client-sidebar")).not.toBeInTheDocument();
  });

  it("keeps account actions in the top action bar", () => {
    render(<AccountTopNav />);

    expect(document.querySelector(".account-actionbar")).toBeInTheDocument();
    expect(screen.getByLabelText(/通知|Notifications/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /菜单|Menu/i })).toBeInTheDocument();
  });

  it("places 我的 (account hub) as the last primary rail item and drops the standalone 设备 link", () => {
    render(<AccountTopNav />);

    const linksRow = document.querySelector(".account-rail__nav");
    expect(linksRow).toBeTruthy();

    const links = within(linksRow as HTMLElement).getAllByRole("link");
    // Rightmost primary entry is the merged 我的 hub, pointing at /account/me.
    const last = links[links.length - 1];
    expect(last).toHaveTextContent("我的");
    expect(last).toHaveAttribute("href", "/account/me");

    // 设备 / 设置 are no longer standalone top-level links (merged into 我的).
    expect(screen.queryByRole("link", { name: "设备" })).toBeNull();
    expect(screen.queryByRole("link", { name: "设置" })).toBeNull();
  });
});
