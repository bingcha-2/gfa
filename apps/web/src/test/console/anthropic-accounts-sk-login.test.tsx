import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ClaudeAccountsPage from "@/app/(console)/console/(dashboard)/(product)/anthropic-accounts/page";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("ClaudeAccountsPage SK onboarding", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, accounts: [] }),
      })),
    );
  });

  it("shows the SK one-click onboarding action for an email plus sessionKey line", async () => {
    render(<ClaudeAccountsPage />);

    fireEvent.change(await screen.findByPlaceholderText(/sessionKey/), {
      target: { value: "sk-user@example.com----sk-ant-sid02-AbCdEf1234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "解析" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /SK 一键上号/ })).toBeInTheDocument();
    });
  });
});
