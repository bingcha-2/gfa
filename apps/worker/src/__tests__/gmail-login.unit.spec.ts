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
    waitFor: vi.fn().mockResolvedValue(undefined),
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
  evaluateResult?: string;
  gotoError?: Error;
} = {}) {
  const urls = opts.urlSequence ?? ["https://accounts.google.com"];
  let urlCallIdx = 0;

  const page: any = {
    url: vi.fn(() => urls[Math.min(urlCallIdx++, urls.length - 1)]),
    goto: vi.fn().mockImplementation(async () => {
      if (opts.gotoError) throw opts.gotoError;
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    evaluate: vi.fn().mockResolvedValue(opts.evaluateResult ?? ""),
    locator: vi.fn((selector: string) => {
      // Check overrides
      if (opts.locatorOverrides) {
        for (const [fragment, loc] of Object.entries(opts.locatorOverrides)) {
          if (selector.includes(fragment)) return loc;
        }
      }
      // Default: nothing found
      return buildLocator({ count: 0 });
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("")),
  };

  return page;
}

// ----- Tests -----

describe("gmailLogin — early exits", () => {
  it("returns success immediately when already logged in (myaccount URL)", async () => {
    const page = buildMockPage({ urlSequence: ["https://myaccount.google.com/u/0/"] });
    const result = await gmailLogin(page, { loginEmail: "a@g.com", loginPassword: "pw" }, buildMockLogger());
    expect(result.success).toBe(true);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("returns success immediately when already on mail.google.com", async () => {
    const page = buildMockPage({ urlSequence: ["https://mail.google.com/mail/u/0/"] });
    const result = await gmailLogin(page, { loginEmail: "a@g.com", loginPassword: "pw" }, buildMockLogger());
    expect(result.success).toBe(true);
  });

  it("returns VERIFICATION_REQUIRED immediately when loginPassword is null", async () => {
    const page = buildMockPage();
    const result = await gmailLogin(page, { loginEmail: "a@g.com", loginPassword: null }, buildMockLogger());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("VERIFICATION_REQUIRED");
      expect(result.detail).toMatch(/loginPassword/);
    }
  });
});

describe("gmailLogin — normal login flow", () => {
  it("fills email + password and returns success when final URL is myaccount", async () => {
    const emailFill = vi.fn().mockResolvedValue(undefined);
    const pwFill    = vi.fn().mockResolvedValue(undefined);
    const nextClick = vi.fn().mockResolvedValue(undefined);

    // url() sequence: initial → after goto → challenge round 1 = success
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",          // initial url() — not logged in
        "https://accounts.google.com",          // after goto
        "https://myaccount.google.com/",        // round 0 → success
      ],
      locatorOverrides: {
        "email":    buildLocator({ count: 1, fill: emailFill }),
        "password": buildLocator({ count: 1, fill: pwFill }),
        // Next button
        "#identifierNext": buildLocator({ count: 1, click: nextClick }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "user@gmail.com", loginPassword: "secret123" },
      buildMockLogger()
    );

    expect(result.success).toBe(true);
    expect(emailFill).toHaveBeenCalledWith("user@gmail.com");
    expect(pwFill).toHaveBeenCalledWith("secret123");
  });

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
      expect(result.reason).toBe("UNKNOWN");
      expect(result.detail).toMatch(/ERR_CONNECTION_REFUSED/);
    }
  });
});

describe("gmailLogin — TOTP challenge", () => {
  it("submits TOTP code when totpSecret is configured", async () => {
    const totpFill = vi.fn().mockResolvedValue(undefined);
    // Valid base32 TOTP secret
    const totpSecret = "JBSWY3DPEHPK3PXP";

    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",    // initial
        "https://accounts.google.com",    // after goto
        "https://accounts.google.com/challenge/totp", // round 0 — TOTP needed
        "https://myaccount.google.com/",  // round 1 — success
      ],
      locatorOverrides: {
        // email + password present
        "email":    buildLocator({ count: 1 }),
        "password": buildLocator({ count: 1 }),
        // TOTP input present in round 0
        "totpPin":  buildLocator({ count: 1, fill: totpFill }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "u@gmail.com", loginPassword: "pw", totpSecret },
      buildMockLogger()
    );

    expect(result.success).toBe(true);
    // The fill may be called once per loop round — verify it was called at least once
    expect(totpFill).toHaveBeenCalled();
    // Code should be a 6-digit string (check first call)
    const code: string = totpFill.mock.calls[0][0];
    expect(code).toMatch(/^\d{6}$/);
  });

  it("returns VERIFICATION_REQUIRED when TOTP required but totpSecret is null", async () => {
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",
        "https://accounts.google.com",
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
      expect(result.detail).toMatch(/totpSecret/);
    }
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
        "https://accounts.google.com/tos",
        "https://myaccount.google.com/",
      ],
      locatorOverrides: {
        "email":    buildLocator({ count: 1 }),
        "password": buildLocator({ count: 1 }),
        // Agree button — matched by "I agree" text fragment
        "I agree":  buildLocator({ count: 1, click: agreeClick }),
      },
    });

    const result = await gmailLogin(
      page,
      { loginEmail: "u@gmail.com", loginPassword: "pw" },
      buildMockLogger()
    );

    expect(result.success).toBe(true);
    // Agree button may be clicked once per loop round — verify at least once
    expect(agreeClick).toHaveBeenCalled();
  });
});

describe("gmailLogin — phone / SMS challenge", () => {
  it("returns VERIFICATION_REQUIRED when phone challenge URL is detected", async () => {
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",
        "https://accounts.google.com",
        "https://accounts.google.com/challenge/dp",  // phone challenge URL
      ],
      evaluateResult: "",
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
    if (!result.success) expect(result.reason).toBe("VERIFICATION_REQUIRED");
  });

  it("returns VERIFICATION_REQUIRED when body text contains 'Check your phone'", async () => {
    const page = buildMockPage({
      urlSequence: [
        "https://accounts.google.com",
        "https://accounts.google.com",
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
    if (!result.success) expect(result.reason).toBe("VERIFICATION_REQUIRED");
  });
});
