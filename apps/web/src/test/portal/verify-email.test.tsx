/**
 * Tests for the email verification flow:
 *   src/components/portal/verify-email-flow.tsx
 *
 * The POST must fire exactly once even under StrictMode double-effects.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";

import { VerifyEmailFlow } from "@/components/portal/verify-email-flow";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("VerifyEmailFlow", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the token once and shows success", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", mockFetch);

    render(<VerifyEmailFlow token="tok-123" />);

    await waitFor(() => {
      expect(screen.getByText("邮箱验证成功")).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/web-session/verify-email");
    expect(JSON.parse(init.body as string)).toEqual({ token: "tok-123" });

    // Link back into the portal
    expect(screen.getByRole("link", { name: "进入用户中心 →" })).toHaveAttribute(
      "href",
      "/account"
    );
  });

  it("fires exactly one POST under StrictMode double-effects", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", mockFetch);

    render(
      <StrictMode>
        <VerifyEmailFlow token="tok-strict" />
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByText("邮箱验证成功")).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("shows the invalid-token state on 400 INVALID_TOKEN", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "INVALID_TOKEN" }, 400));
    vi.stubGlobal("fetch", mockFetch);

    render(<VerifyEmailFlow token="tok-bad" />);

    await waitFor(() => {
      expect(screen.getByText("链接无效或已过期")).toBeInTheDocument();
    });
  });

  it("shows missing-token state without calling the API", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    render(<VerifyEmailFlow token={null} />);

    expect(
      screen.getByText("缺少验证令牌,请检查邮件中的链接是否完整。")
    ).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
