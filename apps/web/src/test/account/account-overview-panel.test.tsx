/**
 * Tests for the account overview operating panel:
 *   src/components/account/account-overview-panel.tsx
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AccountOverviewPanel } from "@/components/account/account-overview-panel";
import type { AccountOverview } from "@/lib/account/user-types";

const overview: AccountOverview = {
  customer: {
    id: "cus_1",
    email: "member@example.com",
    displayName: "",
    emailVerified: true,
    referralCode: "BCAI2026",
    creditCents: 0,
    status: "ACTIVE",
    createdAt: "2026-06-01T00:00:00.000Z",
  },
  subscriptions: [
    {
      id: "sub_1",
      planName: "年度会员",
      status: "ACTIVE",
      products: ["Codex", "Claude Code"],
      // Far-future so the "active membership" intent stays stable regardless of
      // when the suite runs (the panel now honors real expiry).
      expiresAt: "2099-07-01T00:00:00.000Z",
      deviceLimit: 5,
      weight: 8,
      priority: 0,
      migratedFromCard: false,
      quota: {
        quotaMode: "static",
        buckets: [{ bucket: "Pro", used: 360_000, limit: 1_000_000 }],
        recentWindowTokens: 360_000,
        tokenWindowResetMs: 86_400_000,
        weeklyTokenLimit: 2_000_000,
        weeklyWindowResetMs: 604_800_000,
        weeklyWindowTokens: 460_000,
        totalTokensUsed: 900_000,
      },
    },
  ],
  devices: { count: 2, limit: 5 },
  unreadNotifications: 1,
};

describe("AccountOverviewPanel", () => {
  it("renders the membership pass overview instead of the old metric card wall", () => {
    render(
      <AccountOverviewPanel
        customerId="cus_1"
        overview={overview}
        loading={false}
        loadError={false}
      />
    );

    const panel = screen.getByTestId("account-overview-panel");
    expect(panel).toBeInTheDocument();
    // The cheap stat-card wall and conic usage ring are gone.
    expect(panel.querySelector(".account-stat-card")).not.toBeInTheDocument();
    expect(panel.querySelector(".account-usage-ring")).not.toBeInTheDocument();
    // The membership pass is the signature element, carrying the real plan name.
    expect(panel.querySelector(".account-pass")).toBeInTheDocument();
    expect(screen.getByText("年度会员")).toBeInTheDocument();
    // Active membership shows ACTIVE tier and renewal action.
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("额度余量")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /续费 \/ 购买套餐/ })).toHaveAttribute(
      "href",
      "/account/billing"
    );
    // Quick entry to billing replaces the old "查看订单与支付" footer link.
    expect(screen.getByText("订单与支付")).toBeInTheDocument();
  });

  it("groups operational status into the redesigned overview layout", () => {
    render(
      <AccountOverviewPanel
        customerId="cus_1"
        overview={overview}
        loading={false}
        loadError={false}
      />
    );

    const panel = screen.getByTestId("account-overview-panel");
    expect(panel.querySelector(".account-overview-status")).toBeInTheDocument();
    expect(panel.querySelector(".account-overview-actions")).toBeInTheDocument();
    expect(panel.querySelector(".account-overview-statstrip")).toBeInTheDocument();
    expect(panel.querySelector(".account-pass")).toBeInTheDocument();
  });

  it("keeps purchase and client setup actions visible when there is no plan", () => {
    render(
      <AccountOverviewPanel
        customerId="cus_1"
        overview={{ ...overview, subscriptions: [] }}
        loading={false}
        loadError={false}
      />
    );

    expect(screen.getByText("未开通套餐")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /购买套餐/ })).toHaveAttribute(
      "href",
      "/account/billing"
    );
    expect(screen.getByRole("link", { name: /安装客户端/ })).toHaveAttribute(
      "href",
      "/account/download"
    );
  });

  it("shows an EXPIRED state — not a false ACTIVE — for a lapsed subscription", () => {
    const lapsed: AccountOverview = {
      ...overview,
      subscriptions: [
        {
          ...overview.subscriptions[0],
          // status still reads ACTIVE from the backend, but the expiry has passed.
          status: "ACTIVE",
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    };

    render(
      <AccountOverviewPanel
        customerId="cus_1"
        overview={lapsed}
        loading={false}
        loadError={false}
      />
    );

    // The pass must not lie: no ACTIVE tier, no 运行中 / 正常.
    expect(screen.queryByText("ACTIVE")).not.toBeInTheDocument();
    expect(screen.queryByText("运行中")).not.toBeInTheDocument();
    expect(screen.queryByText("正常")).not.toBeInTheDocument();
    // It reports the lapsed state and surfaces a renew path.
    expect(screen.getByText("EXPIRED")).toBeInTheDocument();
    expect(screen.getAllByText(/已过期/).length).toBeGreaterThan(0);
    const renew = screen.getAllByRole("link", { name: /立即续费/ });
    expect(renew.length).toBeGreaterThan(0);
    renew.forEach((link) => expect(link).toHaveAttribute("href", "/account/billing"));
  });
});
