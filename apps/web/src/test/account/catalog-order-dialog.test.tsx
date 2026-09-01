import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogOrderFlow } from "@/components/account/catalog-order-dialog";
import type { Selection } from "@/lib/account/catalog-pricing";

const SELECTION: Selection = {
  line: "bind",
  items: [{ product: "anthropic", level: "max-20x" }],
  shareSeats: 8,
  deviceLimit: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CatalogOrderFlow", () => {
  it("shows payment failure and the support WeChat contact without creating an order", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          contact_name: "客服",
          contact_wechat: "18339526286",
          contact_qrcode_url: "/api/faq-images/support.jpg",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", mockFetch);

    render(<CatalogOrderFlow selection={SELECTION} />);

    expect(screen.getByRole("alert")).toHaveTextContent("支付暂时故障");
    await act(async () => {});

    expect(screen.getByAltText("售后微信二维码")).toHaveAttribute(
      "src",
      "/api/faq-images/support.jpg",
    );
    expect(screen.getByText("18339526286")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/contact-settings",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(
      mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
    ).toBe(false);
  });

  it("copies the support WeChat ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ contact_qrcode_url: "/api/faq-images/support.jpg" })),
      ),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CatalogOrderFlow selection={SELECTION} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "复制" }));

    expect(writeText).toHaveBeenCalledWith("18339526286");
  });

  it("falls back to the default WeChat contact when settings fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(<CatalogOrderFlow selection={SELECTION} />);
    await act(async () => {});

    expect(screen.getByAltText("售后微信二维码")).toHaveAttribute(
      "src",
      "/api/faq-images/mr-gan-wechat-qr.jpg",
    );
    expect(screen.getByText("18339526286")).toBeInTheDocument();
  });
});
