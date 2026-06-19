import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSupportConversationMock } = vi.hoisted(() => ({
  getSupportConversationMock: vi.fn(),
}));

vi.mock("@/lib/account/user-api", () => ({
  getSupportConversation: getSupportConversationMock,
}));

import { SupportChatPage } from "@/components/account/support-chat-page";

describe("SupportChatPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a standalone chat surface when the support agent is enabled", async () => {
    getSupportConversationMock.mockResolvedValue({
      enabled: true,
      conversation: null,
    });

    const { container } = render(<SupportChatPage />);

    expect(screen.getByRole("heading", { name: /在线客服|Support/i })).toBeInTheDocument();
    await screen.findByRole("textbox");
    expect(container.querySelector(".support-page")).toBeInTheDocument();
    expect(container.querySelector(".sc-panel--page")).toBeInTheDocument();
  });

  it("shows a useful unavailable state instead of blanking the page", async () => {
    getSupportConversationMock.mockResolvedValue({
      enabled: false,
      conversation: null,
    });

    const { container } = render(<SupportChatPage />);

    await waitFor(() => {
      expect(container.querySelector(".sc-unavailable")).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: /工单|ticket/i })).toHaveAttribute(
      "href",
      "/account/tickets",
    );
    expect(screen.getByRole("link", { name: /FAQ/i })).toHaveAttribute("href", "/faq");
  });
});
