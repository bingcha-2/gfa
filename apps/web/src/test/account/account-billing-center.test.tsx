/**
 * Tests for the account billing center:
 *   src/components/account/account-billing-center.tsx
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { AccountBillingCenter } from "@/components/account/account-billing-center";
import type {
  BillingOrderRecord,
  Plan,
  Subscription,
} from "@/lib/account/user-types";

const subscriptions: Subscription[] = [
  {
    id: "sub_1",
    planName: "年度会员",
    status: "ACTIVE",
    products: ["Codex", "Claude Code"],
    expiresAt: "2026-07-01T00:00:00.000Z",
    deviceLimit: 5,
    weight: 8,
    priority: 0,
    migratedFromCard: false,
  },
];

const plans: Plan[] = [
  {
    id: "plan_1",
    name: "月度套餐",
    description: "适合短期使用",
    priceCents: 9900,
    durationDays: 30,
    products: ["Codex", "Claude Code"],
    deviceLimit: 2,
    weight: 5,
    sortOrder: 1,
  },
];

const orders: BillingOrderRecord[] = [
  {
    outTradeNo: "BCAI-20260612-001",
    planName: "月度套餐",
    amountCents: 9900,
    payChannel: "ALIPAY",
    status: "PENDING",
    createdAt: "2026-06-12T00:00:00.000Z",
    paidAt: null,
  },
];

describe("AccountBillingCenter", () => {
  it("renders billing as an account payment center instead of a table-first admin page", () => {
    render(
      <AccountBillingCenter
        subscriptions={subscriptions}
        plans={plans}
        orders={{ orders, total: 1 }}
        page={1}
        totalPages={1}
        loadError={false}
        onBound={vi.fn()}
        onPage={vi.fn()}
        onPurchase={vi.fn()}
      />
    );

    const center = screen.getByTestId("account-billing-center");
    expect(center).toBeInTheDocument();
    expect(center.querySelector(".account-billing-hero")).toBeInTheDocument();
    expect(center.querySelector(".account-plan-card")).toBeInTheDocument();
    expect(center.querySelector("table")).not.toBeInTheDocument();
    expect(screen.getByText("支付中心")).toBeInTheDocument();
    expect(screen.getAllByText("年度会员").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "立即购买" })).toBeInTheDocument();
    expect(screen.getByText("BCAI-20260612-001")).toBeInTheDocument();
  });

  it("keeps purchase and card binding visible while data is still loading", () => {
    render(
      <AccountBillingCenter
        subscriptions={null}
        plans={null}
        orders={null}
        page={1}
        totalPages={1}
        loadError={false}
        onBound={vi.fn()}
        onPage={vi.fn()}
        onPurchase={vi.fn()}
      />
    );

    expect(screen.getByText("正在同步订阅与订单")).toBeInTheDocument();
    expect(screen.getAllByText("绑定卡密").length).toBeGreaterThan(0);
    expect(screen.getByText("套餐目录")).toBeInTheDocument();
  });
});
