/**
 * State-machine tests for the catalog-order QR flow:
 *   src/components/account/catalog-order-dialog.tsx (CatalogOrderFlow)
 *
 * Mirrors order-qr-dialog.test.tsx but asserts the selection (not a planId)
 * is POSTed to /billing/catalog-orders.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { useState } from "react";

import { CatalogOrderFlow } from "@/components/account/catalog-order-dialog";
import type { Selection } from "@/lib/account/catalog-pricing";

const SELECTION: Selection = {
  line: "bind",
  items: [{ product: "anthropic", level: "max-20x" }],
  shareSeats: 8,
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
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
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
    // 统一收银台:不再预选渠道,下单 body 只带 selection(无 channel)。
    expect(JSON.parse(init.body as string)).toEqual({
      selection: SELECTION,
    });
    expect(JSON.parse(init.body as string).selection).not.toHaveProperty("shareUsers");
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

  // 用户报「反复创建订单」:countdown ticker 每秒重渲染 + selection 引用抖动会让旧代码
  // 不断重发下单。防重:selection 内容签名 + requestedRef 去重 + creatingRef 并发闸。
  it("selection 引用抖动 + countdown 每秒重渲染 → 仍只下一单(防重)", async () => {
    const mockFetch = mockBillingFetch("PENDING");
    vi.stubGlobal("fetch", mockFetch);

    // 父每次渲染都传「新 selection 对象」(内容相同),模拟真实里引用每次都变。
    function Harness() {
      const [, setTick] = useState(0);
      const selection: Selection = {
        line: "pool",
        products: ["anthropic"],
        usageTier: "small",
        deviceLimit: 1,
      };
      return (
        <div>
          <button onClick={() => setTick((t) => t + 1)}>rerender</button>
          <CatalogOrderFlow selection={selection} />
        </div>
      );
    }

    render(<Harness />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(postCalls(mockFetch)).toHaveLength(1);

    // 强制父重渲染 3 次(每次新 selection 对象)+ 推进 countdown ticker 5 秒。
    await act(async () => {
      fireEvent.click(screen.getByText("rerender"));
      fireEvent.click(screen.getByText("rerender"));
      fireEvent.click(screen.getByText("rerender"));
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(postCalls(mockFetch)).toHaveLength(1); // 仍只 1 个下单 POST
  });

  // 统一收银台:前端不再预选 alipay/wxpay —— 一个二维码,渠道由用户在网关侧自选。
  it("统一收银台:无支付方式切换分组,只下一单且不带 channel", async () => {
    const mockFetch = mockBillingFetch("PENDING");
    vi.stubGlobal("fetch", mockFetch);

    render(<CatalogOrderFlow selection={SELECTION} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // 渠道切换分组已移除。
    expect(screen.queryByRole("group", { name: "支付方式" })).toBeNull();

    const posts = postCalls(mockFetch);
    expect(posts).toHaveLength(1);
    expect(JSON.parse((posts[0][1] as RequestInit).body as string)).toEqual({
      selection: SELECTION,
    });
    expect(JSON.parse((posts[0][1] as RequestInit).body as string).selection).not.toHaveProperty(
      "shareUsers",
    );
  });
});
