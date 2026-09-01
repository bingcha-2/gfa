import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { TicketContact } from "@/components/account/ticket-contact";

describe("TicketContact (工单页·售后客服联系卡)", () => {
  it("renders the WeChat id (with copy) and QR when configured", () => {
    const { container } = render(
      <TicketContact wechat="bcai-kefu" qrcodeUrl="https://cdn.example/qr.png" />,
    );

    // 微信号原样展示 + 可复制
    expect(screen.getByText("bcai-kefu")).toBeInTheDocument();
    expect(container.querySelector(".account-support__copy")).toBeInTheDocument();

    // 二维码沿用官网 FAQ 的外链 img
    const qr = container.querySelector(".account-support__qr img") as HTMLImageElement | null;
    expect(qr).not.toBeNull();
    expect(qr?.getAttribute("src")).toBe("https://cdn.example/qr.png");
  });

  it("renders nothing when neither WeChat nor QR is configured", () => {
    const { container } = render(<TicketContact />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the WeChat block without a QR when only WeChat is set", () => {
    const { container } = render(<TicketContact wechat="bcai-kefu" />);
    expect(screen.getByText("bcai-kefu")).toBeInTheDocument();
    expect(container.querySelector(".account-support__qr")).toBeNull();
  });
});
