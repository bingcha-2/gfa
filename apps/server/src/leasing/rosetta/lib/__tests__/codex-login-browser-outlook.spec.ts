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

  async pressSequentially(value: string) {
    this.page.fillFor(this.selector, value);
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
  private mailboxSnapshotAvailable = false;

  constructor(private readonly role: "auth" | "outlook") {}

  async goto(url: string) {
    if (this.role === "auth") {
      this.stage = "auth-email";
      return;
    }
    this.stage = url.includes("outlook.live.com/mail") ? "outlook-mail" : "microsoft-account";
    this.mailboxSnapshotAvailable = this.stage === "outlook-mail";
  }

  async waitForLoadState() {}

  url() {
    if (this.role === "auth") {
      if (this.stage === "auth-code") return "https://auth.openai.com/email-verification";
      if (this.stage === "redirect") return "http://localhost:1455/auth/callback?code=oauth-code";
      return "https://auth.openai.com/log-in";
    }
    if (this.stage === "outlook-mail") return "https://outlook.live.com/mail/0/inbox";
    return "https://account.microsoft.com/?refd=account.live.com";
  }

  locator(selector: string) {
    return new FakeLocator(this, selector);
  }

  async evaluate() {
    if (this.role !== "auth") return [];
    if (this.stage === "auth-email") {
      return [{ type: "email", name: "email", id: "email", autocomplete: "username" }];
    }
    if (this.stage === "auth-code") {
      return [{ type: "text", name: "code", id: "code", autocomplete: "one-time-code" }];
    }
    return [];
  }

  async close() {}

  async reload() {}

  async bodyText() {
    if (this.role === "auth") {
      if (this.stage === "auth-code") return "Check your inbox Enter the verification code";
      return "Welcome back Email address Continue";
    }
    if (this.stage === "outlook-mail" && this.mailboxSnapshotAvailable) {
      this.mailboxSnapshotAvailable = false;
      return "Inbox Focused Other ChatGPT Your temporary ChatGPT login code Enter this temporary verification code to continue: 123456";
    }
    if (this.stage === "microsoft-account") return "Account Never lose access to your Microsoft account Add a recovery email";
    return "";
  }

  countFor(selector: string) {
    if (selector === "body") return 1;
    if (this.role !== "auth") return 0;
    if (this.stage === "auth-email" && selector.includes("email")) return 1;
    if (this.stage === "auth-code" && selector.includes("code")) return 1;
    if (selector.includes("button") || selector.includes("submit")) return 1;
    return 0;
  }

  clickFor(selector: string) {
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
    if (this.role === "auth" && this.stage === "auth-code" && selector.includes("code") && value) {
      this.codeFilled = true;
    }
  }
}

describe("runCodexBrowserLogin Outlook email code handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.openProfile.mockResolvedValue({ debugUrl: "ws://fake", webdriver: "" });
    mocks.closeProfile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the Outlook mailbox text observed during login before the page text disappears", async () => {
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
      email: "outlook-user@example.test",
      password: "mail-password",
      adspowerProfileId: "profile-1",
      proxyUrl: "socks5://user:pass@198.51.100.10:443",
      maxSteps: 8,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toMatchObject({ ok: true, code: "oauth-code" });
  });
});
