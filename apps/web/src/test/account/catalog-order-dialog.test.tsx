/**
 * State-machine tests for the catalog-order QR flow:
 *   src/components/account/catalog-order-dialog.tsx (CatalogOrderFlow)
 *
 * Mirrors order-qr-dialog.test.tsx but asserts the selection (not a planId)
 * is POSTed to /billing/catalog-orders.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

import { CatalogOrderFlow } from "@/components/account/catalog-order-dialog";
import type { Selection } from "@/lib/account/catalog-pricing";

const SELECTION: Selection = {
  line: "bind",
  items: [{ product: "anthropic", level: "max-20x" }],
  shareUsers: 1,
  deviceLimit: 1,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createdOrder() {
  return {
    outTradeNo: "C1",
    amountCents: 29900,
    baseCents: 29900,
    feeCents: 0,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    payUrl: "https://pay.example/catalog",
    qrDataUri: "data:image/png;base64,CATALOGQR",
  };
}

function mockBillingFetch(status: string) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(jsonResponse(createdOrder()));
    }
    return Promise.resolve(jsonResponse({ outTradeNo: "C1", status }));
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

describe("CatalogOrderFlow", () => {
  it("POSTs the selection to catalog-orders and renders the QR", async () => {
    const mockFetch = mockBillingFetch("PENDING");
    vi.stubGlobal("fetch", mockFetch);

    render(<CatalogOrderFlow selection={SELECTION} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const img = screen.getByAltText("支付二维码");
    expect(img).toHaveAttribute("src", "data:image/png;base64,CATALOGQR");
    expect(screen.getByText("¥299")).toBeInTheDocument();

    // Exactly one order created, hitting the catalog-orders endpoint with the selection
    const posts = postCalls(mockFetch);
    expect(posts).toHaveLength(1);
    const [url, init] = posts[0] as [string, RequestInit];
    expect(url).toContain("/api/account/billing/catalog-orders");
    expect(JSON.parse(init.body as string)).toEqual({
      selection: SELECTION,
      channel: "ALIPAY",
    });
  });

  it("renders the paid success state on PAID", async () => {
    const mockFetch = mockBillingFetch("PAID");
    vi.stubGlobal("fetch", mockFetch);

    render(<CatalogOrderFlow selection={SELECTION} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("套餐已开通")).toBeInTheDocument();
  });
});
