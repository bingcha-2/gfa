/**
 * Tests for account top navigation:
 *   src/components/account/account-topnav.tsx
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { AccountTopNav } from "@/components/account/account-topnav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/account/billing",
}));

vi.mock("@/components/account/account-provider", () => ({
  useAccount: () => ({
    customer: { email: "member@example.com", displayName: "" },
    handleLogout: vi.fn(),
  }),
}));

vi.mock("@/lib/account/user-api", () => ({
  getNotifications: () => Promise.resolve({ notifications: [], total: 0, unread: 0 }),
}));

describe("AccountTopNav", () => {
  it("marks the current account section inside the account-owned top nav", () => {
    render(<AccountTopNav />);

    const billingLink = screen.getByRole("link", { name: /订阅|Billing/i });

    expect(billingLink).toHaveAttribute("data-active");
    expect(billingLink).toHaveClass("account-topnav__link");
    expect(document.querySelector(".account-topnav")).toBeInTheDocument();
    // The old sidebar shell is gone.
    expect(document.querySelector(".account-client-sidebar")).not.toBeInTheDocument();
  });
});
