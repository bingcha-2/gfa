/**
 * Tests for the bind-card flow:
 *   src/components/account/bind-card-form.tsx
 *
 * Renders with the default zh-CN dictionary (LocaleContext default value).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { BindCardForm } from "@/components/account/bind-card-form";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function submitCard(key: string) {
  fireEvent.change(screen.getByPlaceholderText("输入卡密,例如 AI…"), {
    target: { value: key },
  });
  fireEvent.click(screen.getByRole("button", { name: "绑定卡密" }));
}

describe("BindCardForm", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the card key and shows the success state", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        subscription: {
          id: "sub-1",
          expiresAt: "2026-12-31T00:00:00.000Z",
          products: ["claude", "codex"],
          deviceLimit: 3,
          planName: null,
        },
      })
    );
    vi.stubGlobal("fetch", mockFetch);
    const onBound = vi.fn();

    render(<BindCardForm onBound={onBound} />);
    await submitCard("AI-TEST-123");

    await waitFor(() => {
      expect(screen.getByText("绑定成功")).toBeInTheDocument();
    });

    // Correct endpoint + body
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/web/bind-card");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ cardKey: "AI-TEST-123" });

    expect(onBound).toHaveBeenCalledOnce();
  });

  it("shows the already-bound info state when alreadyBound is true", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        alreadyBound: true,
        subscription: {
          id: "sub-1",
          expiresAt: "2026-12-31T00:00:00.000Z",
          products: ["claude"],
          deviceLimit: 3,
          planName: null,
        },
      })
    );
    vi.stubGlobal("fetch", mockFetch);

    render(<BindCardForm />);
    await submitCard("AI-DUP-1");

    await waitFor(() => {
      expect(
        screen.getByText("该卡密已绑定到当前账号,订阅信息如下。")
      ).toBeInTheDocument();
    });
  });

  it("shows the CARD_NOT_FOUND message on 404", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: "CARD_NOT_FOUND", message: "card not found" }, 404)
    );
    vi.stubGlobal("fetch", mockFetch);

    render(<BindCardForm />);
    await submitCard("AI-NOPE");

    await waitFor(() => {
      expect(
        screen.getByText("卡密不存在,请检查输入是否正确。")
      ).toBeInTheDocument();
    });
  });

  it("shows the CARD_ALREADY_BOUND message on 409", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: "CARD_ALREADY_BOUND", message: "already bound" },
        409
      )
    );
    vi.stubGlobal("fetch", mockFetch);

    render(<BindCardForm />);
    await submitCard("AI-TAKEN");

    await waitFor(() => {
      expect(screen.getByText("该卡密已绑定到其他账号。")).toBeInTheDocument();
    });
  });

  it("falls back to the generic message for unknown error codes", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: "SOMETHING_ELSE", message: "boom" }, 500)
    );
    vi.stubGlobal("fetch", mockFetch);

    render(<BindCardForm />);
    await submitCard("AI-ERR");

    await waitFor(() => {
      expect(screen.getByText("绑定失败,请稍后重试。")).toBeInTheDocument();
    });
  });

  it("disables the submit button while pending", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const mockFetch = vi.fn().mockImplementation(
      () => new Promise<Response>((res) => (resolveFetch = res))
    );
    vi.stubGlobal("fetch", mockFetch);

    render(<BindCardForm />);
    await submitCard("AI-SLOW");

    expect(screen.getByRole("button", { name: "绑定中…" })).toBeDisabled();

    resolveFetch(
      jsonResponse({
        ok: true,
        subscription: {
          id: "s",
          expiresAt: null,
          products: [],
          deviceLimit: 1,
          planName: null,
        },
      })
    );
    await waitFor(() => {
      expect(screen.getByText("绑定成功")).toBeInTheDocument();
    });
  });
});
