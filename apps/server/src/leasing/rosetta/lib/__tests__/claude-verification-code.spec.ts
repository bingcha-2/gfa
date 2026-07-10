import { describe, expect, it, vi } from "vitest";

const browserMocks = vi.hoisted(() => ({
  closeProfile: vi.fn(async () => {}),
  checkProfile: vi.fn(async () => ({ active: true, debugUrl: "ws://adspower/debug" })),
  openProfile: vi.fn(async () => ({ debugUrl: "ws://adspower/reopened", webdriver: "" })),
  connectOverCDP: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: browserMocks.connectOverCDP,
  },
}));

vi.mock("../adspower-profile-manager", () => ({
  makeDefaultAdsPowerClient: () => ({
    checkProfile: browserMocks.checkProfile,
    openProfile: browserMocks.openProfile,
    closeProfile: browserMocks.closeProfile,
  }),
}));

import {
  extractClaudeVerificationCode,
  fetchClaudeVerificationCode,
  openClaudeMagicLinkForVerificationCode,
} from "../claude-verification-code";

describe("extractClaudeVerificationCode", () => {
  it("extracts the six digit code from a Claude magic-link code page", () => {
    const text = "Use verification code to continue Enter this verification code where you first tried to sign in 654321 Copy Code";

    expect(extractClaudeVerificationCode(text)).toBe("654321");
  });
});

describe("fetchClaudeVerificationCode", () => {
  it("fetches the latest mail link and opens it in the requested AdsPower profile", async () => {
    const fetchMagicLink = vi.fn(async () => ({
      ok: true,
      url: "https://claude.ai/magic-link#token:email",
      subject: "Secure link to log in to Claude.ai",
      date: "2026-07-05T05:00:12.766Z",
    }));
    const openMagicLinkInBrowser = vi.fn(async () => ({
      ok: true,
      code: "123456",
      startedProfile: false,
    }));

    await expect(fetchClaudeVerificationCode({
      email: "mail-user@example.com",
      password: "mail-password",
      adspowerProfileId: "k1e8c364",
      sinceMs: 123,
      waitMs: 1_200,
    }, {
      fetchMagicLink,
      openMagicLinkInBrowser,
      })).resolves.toMatchObject({
      ok: true,
      code: "123456",
      source: "mail-password",
      subject: "Secure link to log in to Claude.ai",
      date: "2026-07-05T05:00:12.766Z",
      adspowerProfileId: "k1e8c364",
      startedProfile: false,
    });

    expect(fetchMagicLink).toHaveBeenCalledWith({
      email: "mail-user@example.com",
      password: "mail-password",
      sinceMs: 123,
      waitMs: 1_200,
      proxyUrl: undefined,
    });
    expect(openMagicLinkInBrowser).toHaveBeenCalledWith({
      adspowerProfileId: "k1e8c364",
      email: "mail-user@example.com",
      magicLinkUrl: "https://claude.ai/magic-link#token:email",
      timeoutMs: expect.any(Number),
      closeCodeTab: true,
      closeBrowser: true,
      clearBrowserData: true,
    });
  });
});

describe("openClaudeMagicLinkForVerificationCode", () => {
  it("lets the Claude code page settle before reading the verification code", async () => {
    const calls: string[] = [];
    const cdp = { send: vi.fn(async () => {}) };
    const page = {
      goto: vi.fn(async () => { calls.push("goto"); }),
      waitForLoadState: vi.fn(async () => { calls.push("load"); }),
      waitForTimeout: vi.fn(async (ms: number) => { calls.push(`wait:${ms}`); }),
      textContent: vi.fn(async () => {
        calls.push("text");
        return "Enter this verification code where you first tried to sign in 123456 Copy Code";
      }),
      evaluate: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const context = {
      newPage: vi.fn(async () => page),
      clearCookies: vi.fn(async () => {}),
      newCDPSession: vi.fn(async () => cdp),
    };
    const browser = {
      contexts: vi.fn(() => [context]),
      close: vi.fn(async () => {}),
    };
    browserMocks.connectOverCDP.mockResolvedValueOnce(browser);

    await expect(openClaudeMagicLinkForVerificationCode({
      adspowerProfileId: "k1e8c364",
      email: "mail-user@example.com",
      magicLinkUrl: "https://claude.ai/magic-link#token",
      timeoutMs: 5_000,
      closeCodeTab: true,
    })).resolves.toMatchObject({ ok: true, code: "123456" });

    const firstSettleWait = calls.findIndex((call) => call.startsWith("wait:"));
    expect(firstSettleWait).toBeGreaterThan(calls.indexOf("goto"));
    expect(calls.indexOf("text")).toBeGreaterThan(firstSettleWait);
  });

  it("clears Claude browser data and closes the AdsPower profile after reading a code", async () => {
    const cdp = { send: vi.fn(async () => {}) };
    const page = {
      goto: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      textContent: vi.fn(async () => "Enter this verification code where you first tried to sign in 123456 Copy Code"),
      waitForTimeout: vi.fn(async () => {}),
      evaluate: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const context = {
      newPage: vi.fn(async () => page),
      clearCookies: vi.fn(async () => {}),
      newCDPSession: vi.fn(async () => cdp),
    };
    const browser = {
      contexts: vi.fn(() => [context]),
      close: vi.fn(async () => {}),
    };
    browserMocks.connectOverCDP.mockResolvedValueOnce(browser);
    browserMocks.openProfile.mockClear();

    await expect(openClaudeMagicLinkForVerificationCode({
      adspowerProfileId: "k1e8c364",
      email: "mail-user@example.com",
      magicLinkUrl: "https://claude.ai/magic-link#token",
      timeoutMs: 5_000,
      closeCodeTab: true,
    })).resolves.toMatchObject({ ok: true, code: "123456" });

    expect(browserMocks.openProfile).toHaveBeenCalledWith("k1e8c364");
    expect(browserMocks.connectOverCDP).toHaveBeenCalledWith("ws://adspower/reopened");
    expect(context.clearCookies).toHaveBeenCalled();
    expect(page.evaluate).toHaveBeenCalled();
    expect(cdp.send).toHaveBeenCalledWith("Network.clearBrowserCookies");
    expect(cdp.send).toHaveBeenCalledWith("Network.clearBrowserCache");
    expect(cdp.send).toHaveBeenCalledWith("Storage.clearDataForOrigin", {
      origin: "https://claude.ai",
      storageTypes: "all",
    });
    expect(cdp.send).toHaveBeenCalledWith("Page.resetNavigationHistory");
    expect(page.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
    expect(browserMocks.closeProfile).toHaveBeenCalledWith("k1e8c364");
  });
});
