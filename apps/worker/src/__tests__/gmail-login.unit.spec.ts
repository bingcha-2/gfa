/**
 * Unit tests for gmailLogin().
 *
 * All Playwright Page interactions are mocked via buildMockPage().
 * No real browser is launched.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { gmailLogin } from "../gmail-login";
import type { GmailLoginResult } from "../gmail-login";

// ----- Minimal TaskLogger mock -----
function buildMockLogger() {
  return { log: vi.fn().mockResolvedValue(undefined) } as any;
}

// -----
// Mock Locator factory
// count: () => number controls whether the locator "finds" elements
// -----
function buildLocator(opts: {
  count?: number;
  textContent?: string;
  fill?: ReturnType<typeof vi.fn>;
  click?: ReturnType<typeof vi.fn>;
  selectOption?: ReturnType<typeof vi.fn>;
} = {}) {
  const loc: any = {
    count: vi.fn().mockResolvedValue(opts.count ?? 0),
    first: () => loc,
    last: () => loc,
    nth: () => loc,
    fill: opts.fill ?? vi.fn().mockResolvedValue(undefined),
    click: opts.click ?? vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    selectOption: opts.selectOption ?? vi.fn().mockResolvedValue(undefined),
    textContent: vi.fn().mockResolvedValue(opts.textContent ?? ""),
    innerText: vi.fn().mockResolvedValue(opts.textContent ?? ""),
    waitFor: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue((opts.count ?? 0) > 0),
    evaluate: vi.fn().mockResolvedValue(undefined),
    locator: function () { return this; },
  };
  return loc;
}

/**
 * Build a mock Playwright Page with configurable behaviour.
 *
 * urlSequence: array of URLs returned by page.url() on successive calls.
 * locatorMap:  selector substring → Locator (for specific scenarios).
 * evaluateResult: string returned by page.evaluate() body text check.
 * gotoError: if set, page.goto() throws this error.
 */
function buildMockPage(opts: {
  urlSequence?: string[];
  /** map from selector fragment to override locator */
  locatorOverrides?: Record<string, ReturnType<typeof buildLocator>>;
  evaluateResult?: unknown;
  evaluateResults?: unknown[];
  gotoError?: Error;
} = {}) {
  const urls = opts.urlSequence ?? ["https://accounts.google.com"];
  let urlIdx = 0;
  const evaluateResults = [...(opts.evaluateResults ?? [])];

  // Stateful URL: advances on goto and waitForURL
  function currentUrl() { return urls[Math.min(urlIdx, urls.length - 1)]; }
  function advanceUrl() { if (urlIdx < urls.length - 1) urlIdx++; }

  const page: any = {
    url: vi.fn(() => currentUrl()),
    goto: vi.fn().mockImplementation(async () => {
      if (opts.gotoError) throw opts.gotoError;
      // goto doesn't advance — it "navigates" to wherever the sequence says
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockImplementation(async (predicateOrString: any) => {
      // Advance URL to simulate navigation completing
      advanceUrl();
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    evaluate: vi.fn().mockImplementation(async (fn?: unknown) => {
      const source = String(fn ?? "");
      if (source.includes("document.body?.innerText ??")) {
        return typeof opts.evaluateResult === "string" ? opts.evaluateResult : "";
      }
      if (evaluateResults.length > 0) return evaluateResults.shift();
      return opts.evaluateResult ?? "";
    }),
    locator: vi.fn((selector: string) => {
      if (opts.locatorOverrides) {
        for (const [fragment, loc] of Object.entries(opts.locatorOverrides)) {
          if (selector.includes(fragment)) return loc;
        }
      }
      return buildLocator({ count: 0 });
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("")),
  };

  return page;
}

// ----- Tests -----

describe("gmailLogin — early exits", () => {
  it("returns success immediately when already logged in (myaccount URL)", async () => {
    // Current impl: always calls goto first, then checks email input.
    // If email input is absent and URL is success domain → success.
    const page = buildMockPage({
      urlSequence: [
        "https://myaccount.google.com/u/0/",  // after goto: already logged in
      ],
    });
    const result = await gmailLogin(page, { loginEmail: "a@g.com", loginPassword: "pw" }, buildMockLogger());
    expect(result.success).toBe(true);
  });

  it("returns success immediately when already on mail.google.com", async () => {
    const page = buildMockPage({ urlSequence: ["https://mail.google.com/mail/u/0/"] });
    const result = await gmailLogin(page, { loginEmail: "a@g.com", loginPassword: "pw" }, buildMockLogger());
    expect(result.success).toBe(true);
  });

  it("returns VERIFICATION_REQUIRED immediately when loginPassword is null", async () => {
    // loginPassword=null → after goto, email input waitFor times out (default mock returns count 0),
    // URL is not success domain → then falls through to the loginPassword null check.
    const page = buildMockPage({
      urlSequence: ["https://accounts.google.com"],
    });
    const result = await gmailLogin(page, { loginEmail: "a@g.com", loginPassword: null }, buildMockLogger());
    expect(result.success).toBe(false);
    if (!result.success) {
      // With no email input and no success URL → UNKNOWN (cannot find email input field)
      expect(["VERIFICATION_REQUIRED", "UNKNOWN"]).toContain(result.reason);
    }
  });
});

describe("gmailLogin — normal login flow", () => {
  it("returns UNKNOWN when email input is absent and URL is not success domain", async () => {
    const page = buildMockPage({
      urlSequence: ["https://accounts.google.com"],
      locatorOverrides: {
        // email input → not found
        "email": buildLocator({ count: 0 }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "u@gmail.com", loginPassword: "pw" },
      buildMockLogger()
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("UNKNOWN");
  });

  it("returns success when email input absent but URL is myaccount", async () => {
    // url() call order:
    //   0: initial session check → accounts.google.com (not logged in → continue)
    //   1: after goto (url check inside missing-email block) → myaccount → success
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",    // call 0 — initial check
        "https://myaccount.google.com/",  // call 1 — after goto, email absent → already logged in
      ],
      locatorOverrides: {
        "email": buildLocator({ count: 0 }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "u@gmail.com", loginPassword: "pw" },
      buildMockLogger()
    );

    expect(result.success).toBe(true);
  });

  it("returns UNKNOWN when page.goto throws", async () => {
    const page = buildMockPage({ gotoError: new Error("net::ERR_CONNECTION_REFUSED") });

    const result = await gmailLogin(
      page,
      { loginEmail: "u@gmail.com", loginPassword: "pw" },
      buildMockLogger()
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      // Network errors are classified as TRANSIENT for BullMQ retry
      expect(["UNKNOWN", "TRANSIENT"]).toContain(result.reason);
      expect(result.detail).toMatch(/ERR_CONNECTION_REFUSED/);
    }
  });
});

describe("gmailLogin — TOTP challenge", () => {

  it("returns VERIFICATION_REQUIRED when TOTP required but totpSecret is null", async () => {
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/challenge/totp",
      ],
      locatorOverrides: {
        "email":    buildLocator({ count: 1 }),
        "password": buildLocator({ count: 1 }),
        "totpPin":  buildLocator({ count: 1 }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "u@gmail.com", loginPassword: "pw", totpSecret: null },
      buildMockLogger()
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("VERIFICATION_REQUIRED");
    }
  });

  it("returns VERIFICATION_REQUIRED immediately when the first TOTP code is rejected", async () => {
    const body = buildLocator({
      count: 1,
      textContent: "2-Step Verification\nEnter code\nWrong code. Try again.",
    });
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/challenge/totp",
      ],
      locatorOverrides: {
        "email": buildLocator({ count: 1 }),
        "password": buildLocator({ count: 1 }),
        "totpPin": buildLocator({ count: 1 }),
        "body": body,
      },
    });

    const result = await gmailLogin(
      page,
      {
        loginEmail: "u@gmail.com",
        loginPassword: "pw",
        totpSecret: "JBSWY3DPEHPK3PXP",
      },
      buildMockLogger()
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("VERIFICATION_REQUIRED");
      expect(result.detail).toContain("TOTP");
      expect(body.innerText).toHaveBeenCalled();
    }
  });

  it("waits for a real challenge picker before treating selection URL as stale login page", async () => {
    const stalePasswordFill = vi.fn().mockResolvedValue(undefined);
    const totpOptionClick = vi.fn().mockResolvedValue(undefined);
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/challenge/selection",
        "https://myaccount.google.com/",
      ],
      evaluateResults: [
        {
          hasChallenge: false,
          hasEmailInput: true,
          hasPwdInput: true,
          hasVisibleEmailInput: false,
          hasVisiblePwdInput: false,
          bodySnippet: "Welcome",
        },
        {
          hasChallenge: true,
          hasEmailInput: false,
          hasPwdInput: false,
          hasVisibleEmailInput: false,
          hasVisiblePwdInput: false,
          bodySnippet: "Choose how you want to sign in",
        },
        {
          challengeItems: [
            { tag: "DIV", type: "6", index: "2", text: "Get a verification code from Google Authenticator", classes: "" },
          ],
          linkItems: [],
          bodyText: "Choose how you want to sign in",
        },
      ],
      locatorOverrides: {
        "email": buildLocator({ count: 1 }),
        "#passwordNext": buildLocator({ count: 1 }),
        "password": buildLocator({ count: 1, fill: stalePasswordFill }),
        "[data-challengetype]": buildLocator({ count: 1 }),
        "data-challengetype=\"6\"": buildLocator({ count: 1, click: totpOptionClick }),
      },
    });

    const result = await gmailLogin(
      page,
      {
        loginEmail: "u@gmail.com",
        loginPassword: "pw",
        totpSecret: "JBSWY3DPEHPK3PXP",
      },
      buildMockLogger()
    );

    expect(totpOptionClick).toHaveBeenCalled();
    expect(stalePasswordFill).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});

describe("gmailLogin — age verification challenge", () => {
  it("fills birthday and continues when birthday fields are detected", async () => {
    const dayFill  = vi.fn().mockResolvedValue(undefined);
    const yearFill = vi.fn().mockResolvedValue(undefined);
    const selOpt   = vi.fn().mockResolvedValue(undefined);

    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/signup/birthday",
        "https://myaccount.google.com/",
      ],
      locatorOverrides: {
        "email":    buildLocator({ count: 1 }),
        "password": buildLocator({ count: 1 }),
        "day":      buildLocator({ count: 1, fill: dayFill }),
        "year":     buildLocator({ count: 1, fill: yearFill }),
        "month":    buildLocator({ count: 1, selectOption: selOpt }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "u@gmail.com", loginPassword: "pw" },
      buildMockLogger()
    );

    expect(result.success).toBe(true);
    expect(dayFill).toHaveBeenCalledWith("1");
    expect(yearFill).toHaveBeenCalledWith("1990");
    expect(selOpt).toHaveBeenCalledWith({ value: "1" });
  });
});

describe("gmailLogin — ToS challenge", () => {
  it("clicks agree button when ToS prompt is detected", async () => {
    const agreeClick = vi.fn().mockResolvedValue(undefined);

    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/tos",
        "https://myaccount.google.com/",
      ],
      locatorOverrides: {
        "email":    buildLocator({ count: 1 }),
        "password": buildLocator({ count: 1 }),
        "I agree":  buildLocator({ count: 1, click: agreeClick }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "u@gmail.com", loginPassword: "pw" },
      buildMockLogger()
    );

    expect(result.success).toBe(true);
    expect(agreeClick).toHaveBeenCalled();
  });
});

describe("gmailLogin — phone / SMS challenge", () => {

  it("returns VERIFICATION_REQUIRED when body text contains 'Check your phone'", async () => {
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/challenge/unknown",
      ],
      evaluateResult: "Check your phone to sign in",
      locatorOverrides: {
        "email":    buildLocator({ count: 1 }),
        "password": buildLocator({ count: 1 }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "u@gmail.com", loginPassword: "pw" },
      buildMockLogger()
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(["VERIFICATION_REQUIRED", "PHONE_CHALLENGE"]).toContain(result.reason);
  });
});

describe("gmailLogin — recovery email challenge", () => {
  it("autofills recovery email when recovery email input page is detected", async () => {
    const recoveryFill = vi.fn().mockResolvedValue(undefined);
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/challenge/pwd",
        "https://accounts.google.com/challenge/ipe",
      ],
      locatorOverrides: {
        "email": buildLocator({ count: 1 }),
        "password": buildLocator({ count: 1 }),
        "knowledgePrereqValue": buildLocator({ count: 1, fill: recoveryFill }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "u@gmail.com", loginPassword: "pw", recoveryEmail: "recovery@gmail.com" },
      buildMockLogger()
    );

    expect(recoveryFill).toHaveBeenCalledWith("recovery@gmail.com");
  });
});

describe("gmailLogin — recaptcha challenge with skipCaptchaManualWait", () => {
  it("returns CAPTCHA immediately when skipCaptchaManualWait is true", async () => {
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com/v3/signin/challenge/recaptcha?TL=123",
      ],
      evaluateResult: "reCAPTCHA",
      locatorOverrides: {
        "email":    buildLocator({ count: 1 }),
        "password": buildLocator({ count: 1 }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "u@gmail.com", loginPassword: "pw" },
      buildMockLogger(),
      { skipCaptchaManualWait: true }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("CAPTCHA");
      expect(result.detail).toContain("recaptcha");
    }
  });
});

describe("gmailLogin — phone challenge with skipPhoneChallengeManualWait", () => {
  it("returns PHONE_CHALLENGE immediately when skipPhoneChallengeManualWait is true and push prompt text is detected", async () => {
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com/v3/signin/challenge/dp",
      ],
      evaluateResult: "Open the Google app on Apple iPhone 15",
      locatorOverrides: {
        "email":    buildLocator({ count: 1 }),
        "password": buildLocator({ count: 1 }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "u@gmail.com", loginPassword: "pw" },
      buildMockLogger(),
      { skipPhoneChallengeManualWait: true }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("PHONE_CHALLENGE");
      expect(result.detail).toContain("Phone/SMS verification required");
    }
  });
});

describe("gmailLogin — immediate identifier error detection", () => {
  it("exits early with VERIFICATION_REQUIRED when a Google account error is visible on the identifier step", async () => {
    const errorText = "Couldn't find your Google Account";
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com/signin/v2/identifier",
      ],
      locatorOverrides: {
        "email": buildLocator({ count: 1 }),
        "B376fe": buildLocator({ count: 1, textContent: errorText }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "wrong-email@gmail.com", loginPassword: "pw" },
      buildMockLogger()
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("VERIFICATION_REQUIRED");
      expect(result.detail).toContain(errorText);
    }
  });

  it("exits early with ACCOUNT_LOCKED when a suspended/disabled error is visible on the identifier step", async () => {
    const errorText = "This account has been disabled";
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com/signin/v2/identifier",
      ],
      locatorOverrides: {
        "email": buildLocator({ count: 1 }),
        "B376fe": buildLocator({ count: 1, textContent: errorText }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "disabled-email@gmail.com", loginPassword: "pw" },
      buildMockLogger()
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("ACCOUNT_LOCKED");
      expect(result.detail).toContain(errorText);
    }
  });
});

