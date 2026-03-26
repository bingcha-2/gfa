/**
 * Unit tests for ensureGoogleOneSharing().
 *
 * Mocks Playwright Page — no real browser required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureGoogleOneSharing } from "../ensure-google-one-sharing";

// ── Logger mock ─────────────────────────────────────────────────────────────

function buildMockLogger() {
  return { log: vi.fn().mockResolvedValue(undefined) } as any;
}

// ── Locator factory ──────────────────────────────────────────────────────────

function buildLocator(opts: { count?: number; ariaChecked?: string | null } = {}) {
  const loc: any = {
    count: vi.fn().mockResolvedValue(opts.count ?? 0),
    first: () => loc,
    click: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn().mockResolvedValue(opts.ariaChecked ?? null),
  };
  return loc;
}

// ── Page factory ─────────────────────────────────────────────────────────────

/**
 * Build a minimal Page mock.
 *
 * aboutTexts: array of body.innerText returned on successive calls to
 *             page.evaluate (first call = /about, last call = /about verify).
 * settingsToggleCount: how many toggles found on /settings page.
 * toggleAriaChecked:   value returned by getAttribute("aria-checked").
 * confirmBtnCount:     how many confirm buttons appear after toggle click.
 */
function buildMockPage(opts: {
  aboutTexts?: string[];          // sequential evaluate returns
  settingsToggleCount?: number;
  toggleAriaChecked?: string | null;
  confirmBtnCount?: number;
} = {}) {
  const texts = opts.aboutTexts ?? ["", ""];
  let evalIdx = 0;

  const page: any = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation(async () => texts[Math.min(evalIdx++, texts.length - 1)]),
    locator: vi.fn((selector: string) => {
      // Settings toggle selectors
      if (
        selector.includes("aria-label") ||
        selector.includes("switch") ||
        selector.includes("checkbox")
      ) {
        return buildLocator({
          count: opts.settingsToggleCount ?? 0,
          ariaChecked: opts.toggleAriaChecked ?? null,
        });
      }
      // Sharing label on /about
      if (selector.includes("text=") || selector.includes("label")) {
        return buildLocator({ count: 0 });
      }
      // Confirm buttons
      if (
        selector.includes("Turn on") ||
        selector.includes("开启") ||
        selector.includes("Confirm") ||
        selector.includes("OK")
      ) {
        return buildLocator({ count: opts.confirmBtnCount ?? 0 });
      }
      return buildLocator({ count: 0 });
    }),
  };
  return page;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ensureGoogleOneSharing — already active", () => {
  it("returns alreadyEnabled=true and skips settings navigation", async () => {
    const page   = buildMockPage({
      aboutTexts: ["Shared with your family"],
    });
    const logger = buildMockLogger();

    const result = await ensureGoogleOneSharing(page, logger);

    expect(result.alreadyEnabled).toBe(true);
    expect(result.activated).toBe(false);
    expect(result.noSubscription).toBe(false);
    // Should NOT navigate to /settings
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto.mock.calls[0][0]).toContain("one.google.com/about");
  });

  it("detects Chinese simplified sharing active text", async () => {
    const page   = buildMockPage({ aboutTexts: ["已与家庭共享 100 GB 存储空间"] });
    const logger = buildMockLogger();

    const result = await ensureGoogleOneSharing(page, logger);

    expect(result.alreadyEnabled).toBe(true);
  });
});

describe("ensureGoogleOneSharing — no subscription", () => {
  it("returns noSubscription=true when 'Get started' signal found without sharing text", async () => {
    const page   = buildMockPage({ aboutTexts: ["Get started with Google One"] });
    const logger = buildMockLogger();

    const result = await ensureGoogleOneSharing(page, logger);

    expect(result.noSubscription).toBe(true);
    expect(result.activated).toBe(false);
    expect(result.alreadyEnabled).toBe(false);
    // WARN log should be emitted
    const warnCalls = logger.log.mock.calls.filter((c: any[]) => c[0] === "WARN");
    expect(warnCalls.length).toBeGreaterThan(0);
  });
});

describe("ensureGoogleOneSharing — activates sharing", () => {
  it("clicks toggle then confirms modal and returns activated=true", async () => {
    const page = buildMockPage({
      // /about: sharing not yet active first call; active after activation
      aboutTexts: [
        "Google One 200 GB plan",           // call 0: not sharing
        "Shared with your family",          // call 1: after activation
      ],
      settingsToggleCount: 1,
      toggleAriaChecked: "false",
      confirmBtnCount: 1,
    });
    const logger = buildMockLogger();

    const result = await ensureGoogleOneSharing(page, logger);

    expect(result.activated).toBe(true);
    expect(result.alreadyEnabled).toBe(false);
    // Settings page navigated to
    const gotoUrls: string[] = page.goto.mock.calls.map((c: any[]) => c[0] as string);
    expect(gotoUrls.some((u) => u.includes("settings"))).toBe(true);
  });

  it("skips modal if no confirm button appears", async () => {
    const page = buildMockPage({
      aboutTexts: [
        "Google One 200 GB",
        "Shared with your family",
      ],
      settingsToggleCount: 1,
      toggleAriaChecked: "false",
      confirmBtnCount: 0,   // no confirmation modal
    });
    const logger = buildMockLogger();

    const result = await ensureGoogleOneSharing(page, logger);

    expect(result.activated).toBe(true);
  });

  it("returns activated=false with warning when toggle already checked (aria-checked=true)", async () => {
    const page = buildMockPage({
      aboutTexts: ["Google One 200 GB plan"],   // page doesn't say "Shared" yet
      settingsToggleCount: 1,
      toggleAriaChecked: "true",               // toggle already ON in settings
    });
    const logger = buildMockLogger();

    const result = await ensureGoogleOneSharing(page, logger);

    // Toggle is already checked → returns alreadyEnabled on settings page
    expect(result.alreadyEnabled).toBe(true);
  });
});

describe("ensureGoogleOneSharing — error handling", () => {
  it("returns all-false when page.goto throws (non-fatal)", async () => {
    const page: any = {
      goto: vi.fn().mockRejectedValue(new Error("Navigation timeout")),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn(),
      locator: vi.fn(),
    };
    const logger = buildMockLogger();

    const result = await ensureGoogleOneSharing(page, logger);

    expect(result.alreadyEnabled).toBe(false);
    expect(result.activated).toBe(false);
    expect(result.noSubscription).toBe(false);
    // WARN log emitted
    const warnCalls = logger.log.mock.calls.filter((c: any[]) => c[0] === "WARN");
    expect(warnCalls.length).toBeGreaterThan(0);
  });
});
