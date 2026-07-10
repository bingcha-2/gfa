import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  launch: vi.fn(),
  openProfile: vi.fn(),
  closeProfile: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: mocks.connectOverCDP,
    launch: mocks.launch,
  },
}));

vi.mock("../adspower-profile-manager", () => ({
  makeDefaultAdsPowerClient: () => ({
    openProfile: mocks.openProfile,
    closeProfile: mocks.closeProfile,
  }),
  parseProxyToAdsPowerUserConfig: () => ({ proxy_type: "socks5" }),
}));

import { runCodexBrowserLogin } from "../codex-login-browser";

class FakeLocator {
  constructor(
    private readonly page: FakePage,
    private readonly selector: string,
  ) {}

  first() {
    return this;
  }

  nth() {
    return this;
  }

  async count() {
    return this.page.countFor(this.selector);
  }

  async isVisible() {
    return (await this.count()) > 0;
  }

  async click() {
    this.page.clickFor(this.selector);
  }

  async fill(value: string) {
    this.page.fillFor(this.selector, value);
  }

  async pressSequentially(value: string, options?: { delay?: number }) {
    this.page.pressSequentiallyFor(this.selector, value, options);
  }

  async evaluate(fn: (node: HTMLElement) => void) {
    fn({ click: () => this.page.clickFor(this.selector) } as any);
  }

  async innerText() {
    return this.page.bodyText();
  }
}

class FakePage {
  private stage = "blank";
  private codeFilled = false;
  private securityReleaseAt = 0;
  closed = false;
  loginSurfaceReadyAt = 0;
  events: Array<{
    type: "click" | "fill" | "press";
    selector: string;
    value?: string;
    delay?: number;
    at: number;
  }> = [];

  constructor(
    private readonly role: "auth" | "outlook",
    private readonly securityReleaseDelayMs = 20_000,
    private readonly initialUrl = "",
  ) {}

  private syncFromClock() {
    if (this.role === "auth" && this.stage === "security" && Date.now() >= this.securityReleaseAt) {
      this.stage = "auth-email";
      this.loginSurfaceReadyAt = Date.now();
    }
  }

  async goto(url: string) {
    if (this.role === "auth") {
      this.stage = "security";
      this.securityReleaseAt = Date.now() + this.securityReleaseDelayMs;
      return;
    }
    this.stage = url.includes("outlook.live.com/mail") ? "outlook-mail" : "outlook-mail";
  }

  async waitForLoadState() {}

  url() {
    this.syncFromClock();
    if (this.role === "auth") {
      if (this.stage === "blank" && this.initialUrl) return this.initialUrl;
      if (this.stage === "auth-code") return "https://auth.openai.com/email-verification";
      if (this.stage === "redirect") return "http://localhost:1455/auth/callback?code=oauth-code";
      return "https://auth.openai.com/log-in";
    }
    return "https://outlook.live.com/mail/0/inbox";
  }

  async title() {
    this.syncFromClock();
    if (this.role === "auth" && this.stage === "security") return "Just a moment...";
    if (this.role === "auth") return "Welcome back - OpenAI";
    return "Inbox - Outlook";
  }

  locator(selector: string) {
    return new FakeLocator(this, selector);
  }

  async evaluate() {
    this.syncFromClock();
    if (this.role !== "auth") return [];
    if (this.stage === "auth-email") {
      return [{ type: "email", name: "email", id: "email", autocomplete: "username" }];
    }
    if (this.stage === "auth-code") {
      return [{ type: "text", name: "code", id: "code", autocomplete: "one-time-code" }];
    }
    return [];
  }

  async close() {
    this.closed = true;
  }

  async reload() {}

  async bodyText() {
    this.syncFromClock();
    if (this.role === "auth") {
      if (this.stage === "security") {
        return "auth.openai.com Performing security verification This website uses a security service to protect against malicious bots.";
      }
      if (this.stage === "auth-code") return "Check your inbox Enter the verification code";
      return "Welcome back Email address Continue Continue with Google Continue with Microsoft";
    }
    return "Inbox Focused Other ChatGPT Your temporary ChatGPT login code Enter this temporary verification code to continue: 123456";
  }

  countFor(selector: string) {
    this.syncFromClock();
    if (selector === "body") return 1;
    if (this.role !== "auth") return 0;
    if (this.stage === "auth-email" && selector.includes("email")) return 1;
    if (this.stage === "auth-code" && selector.includes("code")) return 1;
    if ((this.stage === "auth-email" || this.stage === "auth-code") && (selector.includes("button") || selector.includes("submit"))) return 1;
    return 0;
  }

  clickFor(selector: string) {
    this.syncFromClock();
    this.events.push({ type: "click", selector, at: Date.now() });
    if (this.role !== "auth") return;
    if ((selector.includes("button") || selector.includes("submit")) && this.stage === "auth-email") {
      this.stage = "auth-code";
      return;
    }
    if ((selector.includes("button") || selector.includes("submit")) && this.stage === "auth-code" && this.codeFilled) {
      this.stage = "redirect";
    }
  }

  fillFor(selector: string, value: string) {
    this.syncFromClock();
    this.events.push({ type: "fill", selector, value, at: Date.now() });
    if (this.role === "auth" && this.stage === "auth-code" && selector.includes("code") && value) {
      this.codeFilled = true;
    }
  }

  pressSequentiallyFor(selector: string, value: string, options?: { delay?: number }) {
    this.syncFromClock();
    this.events.push({ type: "press", selector, value, delay: options?.delay, at: Date.now() });
    this.fillFor(selector, value);
  }
}

describe("runCodexBrowserLogin OpenAI security verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.openProfile.mockResolvedValue({ debugUrl: "ws://fake", webdriver: "" });
    mocks.closeProfile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the OpenAI security verification page to clear before consuming step budget", async () => {
    const authPage = new FakePage("auth");
    const outlookPage = new FakePage("outlook");
    const context = {
      pages: () => [authPage],
      newPage: vi.fn(async () => outlookPage),
      addInitScript: vi.fn(async () => {}),
      on: vi.fn(),
    };
    mocks.connectOverCDP.mockResolvedValue({
      contexts: () => [context],
      close: vi.fn(async () => {}),
    });

    const resultPromise = runCodexBrowserLogin({
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      redirectUri: "http://localhost:1455/auth/callback",
      email: "paintergilton06@hotmail.com",
      password: "mail-password",
      adspowerProfileId: "profile-1",
      proxyUrl: "socks5://user:pass@198.51.100.10:443",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toMatchObject({ ok: true, code: "oauth-code" });
  });

  it("keeps waiting when OpenAI security verification takes longer than 45 seconds", async () => {
    const authPage = new FakePage("auth", 60_000);
    const outlookPage = new FakePage("outlook");
    const context = {
      pages: () => [authPage],
      newPage: vi.fn(async () => outlookPage),
      addInitScript: vi.fn(async () => {}),
      on: vi.fn(),
    };
    mocks.connectOverCDP.mockResolvedValue({
      contexts: () => [context],
      close: vi.fn(async () => {}),
    });

    const resultPromise = runCodexBrowserLogin({
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      redirectUri: "http://localhost:1455/auth/callback",
      email: "paintergilton06@hotmail.com",
      password: "mail-password",
      adspowerProfileId: "profile-1",
      proxyUrl: "socks5://user:pass@198.51.100.10:443",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toMatchObject({ ok: true, code: "oauth-code" });
  });

  it("closes stale ChatGPT auth tabs before opening a fresh authorization page", async () => {
    const staleChatgptPage = new FakePage("auth", 20_000, "https://chatgpt.com/auth/login_with?callback_path=/");
    const authPage = new FakePage("auth");
    const outlookPage = new FakePage("outlook");
    const context = {
      pages: () => [staleChatgptPage],
      newPage: vi.fn().mockResolvedValueOnce(authPage).mockResolvedValueOnce(outlookPage),
      addInitScript: vi.fn(async () => {}),
      on: vi.fn(),
    };
    mocks.connectOverCDP.mockResolvedValue({
      contexts: () => [context],
      close: vi.fn(async () => {}),
    });

    const resultPromise = runCodexBrowserLogin({
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      redirectUri: "http://localhost:1455/auth/callback",
      email: "paintergilton06@hotmail.com",
      password: "mail-password",
      adspowerProfileId: "profile-1",
      proxyUrl: "socks5://user:pass@198.51.100.10:443",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(staleChatgptPage.closed).toBe(true);
    expect(context.newPage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, code: "oauth-code" });
  });

  it("waits for the OpenAI login surface to settle and types credentials gradually", async () => {
    const authPage = new FakePage("auth", 0);
    const outlookPage = new FakePage("outlook");
    const context = {
      pages: () => [authPage],
      newPage: vi.fn(async () => outlookPage),
      addInitScript: vi.fn(async () => {}),
      on: vi.fn(),
    };
    mocks.connectOverCDP.mockResolvedValue({
      contexts: () => [context],
      close: vi.fn(async () => {}),
    });

    const resultPromise = runCodexBrowserLogin({
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      redirectUri: "http://localhost:1455/auth/callback",
      email: "paintergilton06@hotmail.com",
      password: "mail-password",
      adspowerProfileId: "profile-1",
      proxyUrl: "socks5://user:pass@198.51.100.10:443",
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    const emailPress = authPage.events.find(
      (event) => event.type === "press" && event.value === "paintergilton06@hotmail.com",
    );
    expect(emailPress).toBeDefined();
    expect(emailPress?.delay).toBeGreaterThanOrEqual(50);
    expect((emailPress?.at || 0) - authPage.loginSurfaceReadyAt).toBeGreaterThanOrEqual(2_000);
    expect(result).toMatchObject({ ok: true, code: "oauth-code" });
  });
});
