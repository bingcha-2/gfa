import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ClaudeAccountsPage from "@/app/(console)/console/(dashboard)/(product)/anthropic-accounts/page";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
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

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it("starts manual Claude login from both account pools without refreshing token flows", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("anthropic-manual-login-status")) {
        return jsonResponse({ ok: true, status: "ready_for_manual", phase: "ready_for_manual", currentUrl: "https://claude.ai/" });
      }
      if (url.includes("anthropic-precharge-manual-login")) {
        return jsonResponse({ ok: true, taskId: "precharge-task", status: "running", phase: "starting", email: "precharge@example.com" });
      }
      if (url.includes("anthropic-manual-login")) {
        return jsonResponse({ ok: true, taskId: "account-task", status: "running", phase: "starting", email: "pool@example.com" });
      }
      if (url.includes("anthropic-precharge-accounts")) {
        return jsonResponse({ ok: true, accounts: [prechargeAccountFixture()] });
      }
      if (url.includes("anthropic-accounts")) {
        return jsonResponse({ ok: true, accounts: [accountFixture()] });
      }
      return jsonResponse({ ok: true, accounts: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ClaudeAccountsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "人工登录 pool@example.com" }));
    await waitFor(() => {
      expect(findPost(fetchMock, "anthropic-manual-login")).toBeTruthy();
    });
    expect(postBody(findPost(fetchMock, "anthropic-manual-login"))).toEqual({ accountId: 101 });

    fireEvent.click(await screen.findByRole("button", { name: "人工登录 precharge@example.com" }));
    await waitFor(() => {
      expect(findPost(fetchMock, "anthropic-precharge-manual-login")).toBeTruthy();
    });
    expect(postBody(findPost(fetchMock, "anthropic-precharge-manual-login"))).toEqual({ accountId: 202 });
  });
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

function findPost(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.find(([input, init]) => String(input).includes(path) && init?.method === "POST");
}

function postBody(call: unknown[] | undefined) {
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body || "{}"));
}

function accountFixture() {
  return {
    id: 101,
    email: "pool@example.com",
    enabled: true,
    poolEnabled: true,
    alias: "",
    planType: "max",
    hasToken: true,
    boundCardCount: 0,
    usedShares: 0,
    shareCapacity: 4,
    claudeHourlyPercent: 0,
    claudeWeeklyPercent: 0,
    claudeHourlyResetTime: "",
    claudeWeeklyResetTime: "",
    modelQuotaRefreshedAt: 0,
    proxyUrl: "http://proxy.example:8080",
    adspowerProfileId: "profile-101",
    hasMailPassword: true,
    quotaStatus: "",
    quotaStatusReason: "",
  };
}

function prechargeAccountFixture() {
  return {
    id: 202,
    email: "precharge@example.com",
    proxyUrl: "http://proxy.example:8080",
    adspowerProfileId: "profile-202",
    orgId: "",
    orgName: "",
    capabilities: [],
    rateLimitTier: "",
    billingType: "",
    status: "NEW",
    hasMailPassword: true,
    hasSessionKey: false,
    lastProbeAt: "",
    lastError: "",
    activateTaskId: "",
    createdAt: "",
    updatedAt: "",
  };
}
