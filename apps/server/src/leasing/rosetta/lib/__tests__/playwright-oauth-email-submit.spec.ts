import { describe, expect, it, vi } from "vitest";

import { EventEmitter } from "node:events";

import { PlaywrightOAuthSession, clickEmailSubmit } from "../playwright-oauth";

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
