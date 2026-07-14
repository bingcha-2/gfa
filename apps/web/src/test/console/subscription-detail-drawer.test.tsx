import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SubscriptionDetailDrawer } from "@/app/(console)/console/(dashboard)/(customer)/subscriptions/subscription-detail-drawer";
import type { ConsoleSubscription } from "@/lib/console/types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const subscription: ConsoleSubscription = {
  id: "sub-1",
  customerId: "cust-1",
  planId: null,
  status: "ACTIVE",
  startsAt: "2026-07-01T00:00:00.000Z",
  expiresAt: "2026-08-01T00:00:00.000Z",
  productEntitlements: JSON.stringify(["codex"]),
  weight: 4,
  shareSeats: 4,
  deviceLimit: 1,
  createdAt: "2026-07-01T00:00:00.000Z",
  line: "bind",
  config: JSON.stringify({
    line: "bind",
    products: ["codex"],
    levels: { codex: "pro" },
    bindings: { codex: 3 },
    shareSeats: 4,
    deviceLimit: 1,
  }),
  bindings: JSON.stringify({ codex: 3 }),
  levels: JSON.stringify({ codex: "pro" }),
  usdQuotaByProduct: { codex: { fiveHour: 0, weekly: 1166.666668 } },
  usdQuotaUsageByProduct: {
    codex: {
      fiveHour: null,
      weekly: {
        used: 25,
        limit: 1166.666668,
        resetAt: "2026-07-20T00:00:00.000Z",
      },
    },
  },
  boundAccounts: { codex: { id: 3, email: "seat@example.com" } },
  plan: null,
  customer: { email: "customer@example.com" },
};

describe("SubscriptionDetailDrawer USD usage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows live total usage and hides the disabled Codex 5h runtime row", () => {
    render(
      <SubscriptionDetailDrawer
        sub={subscription}
        open
        onOpenChange={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    const weekly = screen.getByTestId("quota-usage-每周");
    expect(within(weekly).getByText(/已用 \$25\.00 \/ \$1,166\.67/)).toBeInTheDocument();
    expect(within(weekly).getByText("2.1%")).toBeInTheDocument();
    expect(screen.queryByTestId("quota-usage-5 小时")).not.toBeInTheDocument();
  });

  it("confirms and resets only the weekly window", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      usageByProduct: {
        codex: {
          fiveHour: null,
          weekly: { used: 0, limit: 1166.666668, resetAt: "2026-07-20T00:00:00.000Z" },
        },
      },
    }), { status: 200 }));
    const onChanged = vi.fn();
    render(
      <SubscriptionDetailDrawer
        sub={subscription}
        open
        onOpenChange={vi.fn()}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(within(screen.getByTestId("quota-usage-每周")).getByRole("button", { name: "清零已用" }));
    expect(await screen.findByRole("heading", { name: "清零每周已用额度？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认清零" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/console/subscriptions/sub-1/usd-quota/reset");
    expect(JSON.parse(String(options?.body))).toEqual({ product: "codex", scope: "weekly" });
    await waitFor(() => expect(within(screen.getByTestId("quota-usage-每周")).getByText("0.0%")).toBeInTheDocument());
    expect(onChanged).toHaveBeenCalled();
  });
});
