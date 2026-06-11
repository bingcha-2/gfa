/**
 * State-machine tests for the purchase QR flow:
 *   src/components/portal/order-qr-dialog.tsx (OrderQrFlow)
 *
 * created → QR shown · EXPIRED → regenerate · PAID → success + callbacks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { OrderQrFlow } from "@/components/portal/order-qr-dialog";
import type { Plan } from "@/lib/user-types";

const PLAN: Plan = {
  id: "plan-1",
  name: "标准版",
  description: "",
  priceCents: 9900,
  durationDays: 30,
  products: ["claude"],
  deviceLimit: 3,
  weight: 1,
  sortOrder: 1,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createdOrder(outTradeNo = "T1") {
  return {
    outTradeNo,
    amountCents: 9900,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    payUrl: "https://pay.example/x",
    qrDataUri: "data:image/png;base64,FAKEQR",
  };
}

/** fetch mock that answers POST with a created order and GET with a status. */
function mockBillingFetch(opts: {
  status: string;
  orderFactory?: () => unknown;
}) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(
        jsonResponse(opts.orderFactory ? opts.orderFactory() : createdOrder())
      );
    }
    return Promise.resolve(
      jsonResponse({ outTradeNo: "T1", status: opts.status })
    );
  });
}

function postCalls(mockFetch: ReturnType<typeof vi.fn>) {
  return mockFetch.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST"
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("OrderQrFlow", () => {
  it("creates an order on mount and shows the QR code with amount and pay link", async () => {
    const mockFetch = mockBillingFetch({ status: "PENDING" });
    vi.stubGlobal("fetch", mockFetch);

    render(<OrderQrFlow plan={PLAN} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // QR rendered straight from the data URI
    const img = screen.getByAltText("支付二维码");
    expect(img).toHaveAttribute("src", "data:image/png;base64,FAKEQR");

    // Amount + mobile pay link
    expect(screen.getByText("¥99")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "打开支付" });
    expect(link).toHaveAttribute("href", "https://pay.example/x");

    // Exactly one order created
    expect(postCalls(mockFetch)).toHaveLength(1);
    const [, init] = postCalls(mockFetch)[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      planId: "plan-1",
      channel: "ALIPAY",
    });
  });

  it("shows the expired state and regenerates a new order on click", async () => {
    const mockFetch = mockBillingFetch({ status: "EXPIRED" });
    vi.stubGlobal("fetch", mockFetch);

    render(<OrderQrFlow plan={PLAN} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // First poll returned EXPIRED → expired state
    expect(screen.getByText("二维码已过期")).toBeInTheDocument();
    const regenButton = screen.getByRole("button", { name: "重新生成" });

    fireEvent.click(regenButton);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // A second order POST went out
    expect(postCalls(mockFetch)).toHaveLength(2);
  });

  it("shows the paid success state and fires onPaid + auto-close", async () => {
    const mockFetch = mockBillingFetch({ status: "PAID" });
    vi.stubGlobal("fetch", mockFetch);
    const onPaid = vi.fn();
    const onRequestClose = vi.fn();

    render(
      <OrderQrFlow
        plan={PLAN}
        onPaid={onPaid}
        onRequestClose={onRequestClose}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("套餐已开通")).toBeInTheDocument();
    expect(onPaid).toHaveBeenCalledOnce();
    expect(onRequestClose).not.toHaveBeenCalled();

    // Auto-close after ~2s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(onRequestClose).toHaveBeenCalledOnce();
  });
});
