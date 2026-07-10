import { beforeEach, describe, expect, it, vi } from "vitest";

import { EventEmitter } from "node:events";

const oauthMocks = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  openProfile: vi.fn(async () => ({ debugUrl: "ws://adspower/debug" })),
  closeProfile: vi.fn(async () => {}),
}));

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: oauthMocks.connectOverCDP,
  },
}));

vi.mock("../adspower-client", () => ({
  AdsPowerClient: vi.fn(function () {
    return {
      openProfile: oauthMocks.openProfile,
      closeProfile: oauthMocks.closeProfile,
    };
  }),
  parseProxyToAdsPowerUserConfig: vi.fn(() => ({ proxy_type: "socks5" })),
}));

import { PlaywrightOAuthSession, clickEmailSubmit, triggerMagicLinkViaBrowser } from "../playwright-oauth";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("clickEmailSubmit", () => {
  it("falls back to DOM click when Playwright native click times out on the email button", async () => {
    const nativeButton = {
      isVisible: vi.fn(async () => true),
      click: vi.fn(async () => {
        throw new Error("locator.click: Timeout 30000ms exceeded\n  - performing click action");
      }),
    };
    const page = {
      getByRole: vi.fn(() => nativeButton),
      evaluate: vi.fn(async () => true),
      locator: vi.fn(),
      keyboard: { press: vi.fn() },
    } as any;

    await expect(clickEmailSubmit(page)).resolves.toBe(true);

    expect(nativeButton.click).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it("uses the native click when it succeeds", async () => {
    const nativeButton = {
      isVisible: vi.fn(async () => true),
      click: vi.fn(async () => {}),
    };
    const page = {
      getByRole: vi.fn(() => nativeButton),
      evaluate: vi.fn(),
      locator: vi.fn(),
      keyboard: { press: vi.fn() },
    } as any;

    await expect(clickEmailSubmit(page)).resolves.toBe(true);

    expect(nativeButton.click).toHaveBeenCalledTimes(1);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe("PlaywrightOAuthSession.consumeMagicLink", () => {
  it("reopens the authorize URL when the magic link does not directly return to the OAuth callback", async () => {
    const callbackUrl = "https://platform.claude.com/oauth/code/callback?code=abc123&state=state123";
    const authorizeUrl = "https://claude.ai/cai/oauth/authorize?client_id=client";
    const magicLinkUrl = "https://claude.ai/login/magic-link";
    const page = new EventEmitter() as any;
    let currentUrl = "https://claude.ai/login";
    const mainFrame = { url: () => currentUrl };

    page.mainFrame = vi.fn(() => mainFrame);
    page.url = vi.fn(() => currentUrl);
    page.textContent = vi.fn(async () => "Claude home");
    page.getByRole = vi.fn(() => ({
      waitFor: vi.fn(async () => {
        throw new Error("no consent button");
      }),
      click: vi.fn(),
    }));
    page.goto = vi.fn(async (url: string) => {
      currentUrl = url;
      if (url === authorizeUrl) {
        currentUrl = callbackUrl;
        queueMicrotask(() => page.emit("framenavigated", mainFrame));
      }
    });

    const session = new PlaywrightOAuthSession({} as any, {} as any, page);

    await expect(session.consumeMagicLink(magicLinkUrl, 250, authorizeUrl)).resolves.toMatchObject({
      ok: true,
      code: "abc123",
      state: "state123",
      callbackUrl,
    });
    expect(page.goto).toHaveBeenNthCalledWith(1, magicLinkUrl, expect.any(Object));
    expect(page.goto).toHaveBeenNthCalledWith(2, authorizeUrl, expect.any(Object));
  });
});

describe("triggerMagicLinkViaBrowser", () => {
  it("lets the Claude email page settle and types the email gradually before submitting", async () => {
    const events: string[] = [];
    const emailInput = {
      first: () => emailInput,
      isVisible: vi.fn(async () => true),
      click: vi.fn(async () => { events.push("click-email"); }),
      fill: vi.fn(async (value: string) => { events.push(`fill:${value}`); }),
      pressSequentially: vi.fn(async (value: string, options?: { delay?: number }) => {
        events.push(`press:${value}:${options?.delay ?? 0}`);
      }),
    };
    const submitButton = {
      isVisible: vi.fn(async () => true),
      click: vi.fn(async () => { events.push("click-submit"); }),
    };
    const page = {
      goto: vi.fn(async () => { events.push("goto"); }),
      waitForLoadState: vi.fn(async () => { events.push("load"); }),
      waitForTimeout: vi.fn(async (ms: number) => { events.push(`wait:${ms}`); }),
      locator: vi.fn(() => emailInput),
      getByRole: vi.fn(() => submitButton),
      evaluate: vi.fn(async () => true),
      textContent: vi.fn(async () => "Check your email"),
      url: vi.fn(() => "https://claude.ai/login"),
      keyboard: { press: vi.fn(async () => {}) },
      isClosed: vi.fn(() => false),
    };
    const context = {
      clearCookies: vi.fn(async () => {}),
      pages: vi.fn(() => [page]),
      newPage: vi.fn(async () => page),
    };
    const browser = {
      contexts: vi.fn(() => [context]),
      close: vi.fn(async () => {}),
    };
    oauthMocks.connectOverCDP.mockResolvedValueOnce(browser);

    const result = await triggerMagicLinkViaBrowser({
      authorizeUrl: "https://claude.ai/cai/oauth/authorize",
      email: "mail-user@example.com",
      adspowerProfileId: "profile-1",
    });

    expect(result.ok).toBe(true);
    const settleIndex = events.findIndex((event) => event.startsWith("wait:"));
    const pressIndex = events.findIndex((event) => event.startsWith("press:mail-user@example.com"));
    expect(settleIndex).toBeGreaterThan(events.indexOf("goto"));
    expect(pressIndex).toBeGreaterThan(settleIndex);
    expect(emailInput.fill).not.toHaveBeenCalledWith("mail-user@example.com");

    await result.session?.close();
  });
});
