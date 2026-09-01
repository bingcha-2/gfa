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
  private microsoftSetupDone = false;
  readonly gotoUrls: string[] = [];
  clickedOpenOutlook = false;
  clickedRecoverySkip = false;
  clickedPasskeyCancel = false;
  clickedStaySignedInYes = false;
  clickedChineseNext = false;
  readonly inboxNavigationOrigins: string[] = [];

  constructor(
    private readonly role: "auth" | "outlook",
    private readonly recoveryPromptHasSkip = true,
    private readonly language: "en" | "zh" = "en",
    private readonly mandatoryIdentityPrompt = false,
    private readonly inboxRedirectsToRecovery = false,
    private readonly rejectCodeSubmission = false,
    private readonly startsAtMicrosoftCredentialPage = false,
  ) {}

  async goto(url: string) {
    this.gotoUrls.push(url);
    if (this.role === "auth") {
      this.stage = "auth-email";
      return;
    }
    if (this.startsAtMicrosoftCredentialPage && !this.microsoftSetupDone && !url.includes("outlook.live.com/mail")) {
      this.stage = "microsoft-email";
      return;
    }
    if (url.includes("outlook.live.com/mail")) {
      this.inboxNavigationOrigins.push(this.stage);
      if (this.inboxRedirectsToRecovery && this.stage === "microsoft-recovery-prompt") return;
    }
    if (!this.microsoftSetupDone && !url.includes("outlook.live.com/mail")) {
      this.stage = "microsoft-privacy-notice";
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
    if (this.stage === "microsoft-account") return "https://account.microsoft.com/?lang=en-US&refd=account.live.com";
    if (this.stage === "microsoft-email" || this.stage === "microsoft-password") return "https://login.live.com/login.srf";
    if (this.stage === "microsoft-recovery-prompt") return "https://account.live.com/proofs/Add";
    if (this.stage === "microsoft-passkey") return "https://account.live.com/proofs/passkey";
    if (this.stage === "microsoft-stay-signed-in") return "https://login.live.com/ppsecure/post.srf";
    if (this.stage === "microsoft-identity-verification") return "https://account.live.com/identity/confirm";
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
    if (this.stage === "microsoft-privacy-notice") {
      return this.language === "zh"
        ? "关于你的 Microsoft 帐户的简短说明 你的隐私是我们的首要任务 确定"
        : "A quick note about your Microsoft account Your privacy is our priority OK";
    }
    if (this.stage === "microsoft-email") return "登录 使用你的 Microsoft 帐户。电子邮件地址或电话号码 下一步";
    if (this.stage === "microsoft-password") return "输入密码 登录";
    if (this.stage === "microsoft-recovery-prompt") {
      return this.language === "zh"
        ? "让我们来保护你的账户 添加备用邮箱 暂时跳过"
        : "Help us protect your account Add a recovery email address Skip for now";
    }
    if (this.stage === "microsoft-passkey") {
      return this.language === "zh" ? "正在设置密钥 取消 下一步" : "Setting up a passkey Cancel Next";
    }
    if (this.stage === "microsoft-stay-signed-in") {
      return this.language === "zh" ? "保持登录状态？ 是 否" : "Stay signed in? Yes No";
    }
    if (this.stage === "microsoft-identity-verification") {
      return "Help us protect your account Add a recovery email address A security code is required";
    }
    if (this.stage === "microsoft-account") {
      return "Account Never lose access to your Microsoft account Add a recovery email Outlook Open Outlook.com";
    }
    return "";
  }

  countFor(selector: string) {
    if (selector === "body") return 1;
    if (this.role === "outlook") {
      if (this.stage === "microsoft-email" && (selector.includes("email") || selector.includes("loginfmt") || selector.includes("username") || selector.includes("下一步"))) return 1;
      if (this.stage === "microsoft-password" && (selector.includes("password") || selector.includes("passwd") || selector.includes("Sign in"))) return 1;
      if (this.stage === "microsoft-privacy-notice" && selector.includes(this.language === "zh" ? "确定" : "OK")) return 1;
      if (this.stage === "microsoft-recovery-prompt" && this.recoveryPromptHasSkip && selector.includes(this.language === "zh" ? "暂时跳过" : "Skip for now")) return 1;
      if (this.stage === "microsoft-passkey" && selector.includes(this.language === "zh" ? "取消" : "Cancel")) return 1;
      if (this.stage === "microsoft-stay-signed-in" && selector.includes(this.language === "zh" ? "是" : "Yes")) return 1;
      if (this.stage === "microsoft-account" && selector.includes("Open Outlook.com")) return 1;
      return 0;
    }
    if (this.stage === "auth-email" && selector.includes("email")) return 1;
    if (this.stage === "auth-code" && selector.includes("code")) return 1;
    if (selector.includes("button") || selector.includes("submit")) return 1;
    return 0;
  }

  clickFor(selector: string) {
    if (this.role === "outlook") {
      if (this.stage === "microsoft-email" && selector.includes("下一步")) {
        this.clickedChineseNext = true;
        this.stage = "microsoft-password";
        return;
      }
      if (this.stage === "microsoft-password" && selector.includes("Sign in")) {
        this.stage = "microsoft-privacy-notice";
        return;
      }
      if (this.stage === "microsoft-privacy-notice" && selector.includes(this.language === "zh" ? "确定" : "OK")) {
        this.stage = this.mandatoryIdentityPrompt ? "microsoft-identity-verification" : "microsoft-recovery-prompt";
        return;
      }
      if (this.stage === "microsoft-recovery-prompt" && selector.includes(this.language === "zh" ? "暂时跳过" : "Skip for now")) {
        this.clickedRecoverySkip = true;
        this.stage = "microsoft-passkey";
        return;
      }
      if (this.stage === "microsoft-passkey" && selector.includes(this.language === "zh" ? "取消" : "Cancel")) {
        this.clickedPasskeyCancel = true;
        this.stage = "microsoft-stay-signed-in";
        return;
      }
      if (this.stage === "microsoft-stay-signed-in" && selector.includes(this.language === "zh" ? "是" : "Yes")) {
        this.clickedStaySignedInYes = true;
        this.stage = "microsoft-account";
        this.microsoftSetupDone = true;
        return;
      }
      if (this.stage === "microsoft-account" && selector.includes("Open Outlook.com")) {
        this.clickedOpenOutlook = true;
        return;
      }
      return;
    }
    if ((selector.includes("button") || selector.includes("submit")) && this.stage === "auth-email") {
      this.stage = "auth-code";
      return;
    }
    if ((selector.includes("button") || selector.includes("submit")) && this.stage === "auth-code" && this.codeFilled && !this.rejectCodeSubmission) {
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
  async function runOutlookLogin(outlookPage: FakePage) {
    const authPage = new FakePage("auth");
    const context = {
      pages: () => [authPage],
      newPage: vi.fn(async () => outlookPage),
      addInitScript: vi.fn(async () => {}),
      on: vi.fn(),
    };
    mocks.launch.mockResolvedValue({
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    });

    const resultPromise = runCodexBrowserLogin({
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      redirectUri: "http://localhost:1455/auth/callback",
      email: "outlook-user@outlook.com",
      password: "mail-password",
      proxyUrl: "socks5://user:pass@198.51.100.10:443",
      maxSteps: 8,
    });
    await vi.runAllTimersAsync();
    return resultPromise;
  }

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
    const outlookPage = new FakePage("outlook", true, "zh");
    const result = await runOutlookLogin(outlookPage);

    expect(result).toMatchObject({ ok: true, code: "oauth-code" });
    expect(outlookPage.clickedOpenOutlook).toBe(false);
    expect(outlookPage.clickedRecoverySkip).toBe(true);
    expect(outlookPage.clickedPasskeyCancel).toBe(true);
    expect(outlookPage.clickedStaySignedInYes).toBe(true);
    expect(outlookPage.gotoUrls).toContain("https://outlook.live.com/mail/0/inbox");
  });

  it("does not pretend login completed when the verification page never accepts the code", async () => {
    const authPage = new FakePage("auth", true, "en", false, false, true);
    const outlookPage = new FakePage("outlook");
    const context = {
      pages: () => [authPage],
      newPage: vi.fn(async () => outlookPage),
      addInitScript: vi.fn(async () => {}),
      on: vi.fn(),
    };
    mocks.launch.mockResolvedValue({
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    });

    const resultPromise = runCodexBrowserLogin({
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      redirectUri: "http://localhost:1455/auth/callback",
      email: "outlook-user@outlook.com",
      password: "mail-password",
      proxyUrl: "socks5://user:pass@198.51.100.10:443",
      maxSteps: 8,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toMatchObject({
      ok: false,
      step: "email_code_submit",
      lastUrl: "https://auth.openai.com/email-verification",
    });
    expect(result.error).toContain("20 秒内没有完成提交");
  });

  it("submits the Chinese Microsoft email page instead of repeatedly retyping the address", async () => {
    const outlookPage = new FakePage("outlook", true, "zh", false, false, false, true);
    const result = await runOutlookLogin(outlookPage);

    expect(result).toMatchObject({ ok: true, code: "oauth-code" });
    expect(outlookPage.clickedChineseNext).toBe(true);
  });

  it("opens the inbox directly when the recovery-email prompt has no skip action", async () => {
    const outlookPage = new FakePage("outlook", false);
    const result = await runOutlookLogin(outlookPage);

    expect(result).toMatchObject({ ok: true, code: "oauth-code" });
    expect(outlookPage.clickedRecoverySkip).toBe(false);
    expect(outlookPage.inboxNavigationOrigins).toContain("microsoft-recovery-prompt");
  });

  it("does not bypass mandatory identity verification even when recovery wording is present", async () => {
    const outlookPage = new FakePage("outlook", false, "en", true);
    const result = await runOutlookLogin(outlookPage);

    expect(result).toMatchObject({ ok: false, step: "email_code_polling" });
    expect(outlookPage.inboxNavigationOrigins).toEqual([]);
  });

  it("attempts the direct-inbox recovery only once when Microsoft redirects back to the prompt", async () => {
    const outlookPage = new FakePage("outlook", false, "en", false, true);
    const result = await runOutlookLogin(outlookPage);

    expect(result).toMatchObject({ ok: false, step: "email_code_polling" });
    expect(outlookPage.inboxNavigationOrigins).toEqual(["microsoft-recovery-prompt"]);
  });
});
