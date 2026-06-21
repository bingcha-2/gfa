import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CatalogPurchase } from "@/components/account/catalog-purchase";
import type { CatalogConfig } from "@/lib/account/catalog-pricing";

const CATALOG: CatalogConfig = {
  products: ["anthropic", "codex", "antigravity"],
  levels: {
    anthropic: ["pro", "max-5x", "max-20x"],
    codex: ["plus", "pro"],
    antigravity: ["pro", "ultra"],
  },
  usageTiers: {
    small: { bucketLimits: { "anthropic-claude": 50000 }, weeklyTokenLimit: 250000 },
    large: { bucketLimits: { "anthropic-claude": 150000 }, weeklyTokenLimit: 750000 },
  },
  pricing: {
    pool: {
      product: { anthropic: 6900, codex: 3900, antigravity: 3900 },
      usage: { small: 0, large: 3000 },
      devicePerExtra: 900,
    },
    bind: {
      levelPrice: {
        anthropic: { pro: 9900, "max-5x": 15900, "max-20x": 29900 },
        codex: { plus: 13900, pro: 19900 },
        antigravity: { pro: 11900, ultra: 19900 },
      },
      share: { "1": 0, "2": -4000, "4": -7000, "8": -9000 },
      devicePerExtra: 900,
    },
  },
  durationDays: 30,
  windowMs: 18000000,
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

function postCalls(mockFetch: ReturnType<typeof vi.fn>) {
  return mockFetch.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );
}

function checkoutBtn() {
  return screen.getByRole("button", { name: "去支付" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CatalogPurchase unified bind line", () => {
  it("shows the bind purchase controls without customer-visible line tabs or pool controls", () => {
    render(<CatalogPurchase catalog={CATALOG} />);

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByText("号池线")).not.toBeInTheDocument();
    expect(screen.queryByText("绑定线")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "小用量" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "大用量" })).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Claude" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Antigravity" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "1/8 席" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "2/8 席" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "4/8 席" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "8/8 席" })).toBeInTheDocument();
  });

  it("prices product, level, seat, and device changes through the bind selection", () => {
    render(<CatalogPurchase catalog={CATALOG} />);

    expect(screen.getByTestId("catalog-total")).toHaveTextContent("—");
    expect(checkoutBtn()).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(screen.getByTestId("catalog-total")).toHaveTextContent("¥12.37");

    fireEvent.click(screen.getByRole("radio", { name: "Max 20x" }));
    expect(screen.getByTestId("catalog-total")).toHaveTextContent("¥37.37");

    fireEvent.click(screen.getByRole("radio", { name: "2/8 席" }));
    expect(screen.getByTestId("catalog-total")).toHaveTextContent("¥34.75");

    fireEvent.click(screen.getByRole("button", { name: "增加" }));
    expect(screen.getByTestId("catalog-total")).toHaveTextContent("¥43.75");
    expect(checkoutBtn()).toBeEnabled();
  });

  it("posts only the unified bind selection when checking out", async () => {
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse(createdOrder()));
      }
      return Promise.resolve(jsonResponse({ outTradeNo: "C1", status: "PENDING" }));
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<CatalogPurchase catalog={CATALOG} />);
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    fireEvent.click(screen.getByRole("radio", { name: "2/8 席" }));
    fireEvent.click(checkoutBtn());

    await waitFor(() => expect(postCalls(mockFetch)).toHaveLength(1));
    const body = JSON.parse((postCalls(mockFetch)[0][1] as RequestInit).body as string);

    expect(body.selection).toEqual({
      line: "bind",
      items: [{ product: "anthropic", level: "pro" }],
      shareSeats: 2,
      deviceLimit: 1,
    });
    expect(body.selection).not.toHaveProperty("shareUsers");
    expect(body.selection).not.toHaveProperty("usageTier");
    expect(body.selection).not.toHaveProperty("products");
  });

  it("caps seat choices by catalog shareCapacity but still submits shareSeats", async () => {
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse(createdOrder()));
      }
      return Promise.resolve(jsonResponse({ outTradeNo: "C1", status: "PENDING" }));
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<CatalogPurchase catalog={{ ...CATALOG, shareCapacity: 4 }} />);

    expect(screen.getByRole("radio", { name: "1/4 席" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "4/4 席" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "8/4 席" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    fireEvent.click(screen.getByRole("radio", { name: "4/4 席" }));
    fireEvent.click(checkoutBtn());

    await waitFor(() => expect(postCalls(mockFetch)).toHaveLength(1));
    const body = JSON.parse((postCalls(mockFetch)[0][1] as RequestInit).body as string);
    expect(body.selection).toMatchObject({
      line: "bind",
      shareSeats: 4,
      deviceLimit: 1,
    });
    expect(body.selection).not.toHaveProperty("shareUsers");
  });
});
