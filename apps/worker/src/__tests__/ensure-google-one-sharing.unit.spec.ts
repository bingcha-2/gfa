/**
 * Unit tests for ensureGoogleOneSharing().
 *
 * The implementation navigates directly to one.google.com/u/0/settings and
 * reads the aria-checked state of the "Share Google One with family" toggle.
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
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    textContent: vi.fn().mockResolvedValue("OK"),
    locator: vi.fn().mockImplementation(() => buildLocator({ count: 0 })),
  };
  return loc;
}

// ── Page factory ─────────────────────────────────────────────────────────────
/**
 * The implementation navigates to one.google.com/u/0/settings and reads
 * the toggle's aria-checked attribute. Key opts:
 *   settingsUrl:        URL returned by page.url() after goto (controls URL check)
 *   settingsToggleCount: number of toggles found on settings page
 *   toggleAriaChecked:  aria-checked value of the toggle
 *   confirmBtnCount:    number of confirm buttons inside [role="dialog"]
 *   gotoThrows:         if true, page.goto rejects (non-fatal path)
 */
function buildMockPage(opts: {
  settingsUrl?: string;
  settingsToggleCount?: number;
  toggleAriaChecked?: string | null;
  confirmBtnCount?: number;
  gotoThrows?: boolean;
} = {}) {
  const toggleAriaChecked = opts.toggleAriaChecked ?? null;

  // After the toggle is clicked, simulate aria-checked changing to "true"
  // by tracking the click call count
  let toggleClickCount = 0;
  const toggleLoc: any = {
    count: vi.fn().mockResolvedValue(opts.settingsToggleCount ?? 0),
    first: () => toggleLoc,
    getAttribute: vi.fn().mockImplementation(async () => {
      // Return the overridden value after click (simulate state change)
      return opts.toggleAriaChecked ?? null;
    }),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockImplementation(async () => {
      toggleClickCount++;
    }),
    textContent: vi.fn().mockResolvedValue("Turn on"),
    locator: vi.fn().mockImplementation(() => buildLocator({ count: 0 })),
  };

  const dialogLoc: any = {
    count: vi.fn().mockResolvedValue(opts.confirmBtnCount && opts.confirmBtnCount > 0 ? 1 : 0),
    first: () => dialogLoc,
    locator: vi.fn().mockImplementation(() => buildLocator({ count: opts.confirmBtnCount ?? 0 })),
  };

  const page: any = {
    goto: opts.gotoThrows
      ? vi.fn().mockRejectedValue(new Error("Navigation timeout"))
      : vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(opts.settingsUrl ?? "https://one.google.com/u/0/settings"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(""),
    locator: vi.fn((selector: string) => {
      // Toggle selector (contains aria-label or role=switch)
      if (selector.includes("aria-label") || selector.includes("switch")) {
        return toggleLoc;
      }
      // Dialog selector
      if (selector.includes("dialog")) {
        return dialogLoc;
      }
      return buildLocator({ count: 0 });
    }),
  };
  return { page, toggleLoc };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ensureGoogleOneSharing — already active (toggle aria-checked=true)", () => {
  it("returns alreadyEnabled=true when toggle is already ON", async () => {
    const { page } = buildMockPage({
      settingsToggleCount: 1,
      toggleAriaChecked: "true",
    });
    const logger = buildMockLogger();

    const result = await ensureGoogleOneSharing(page, logger);

    expect(result.alreadyEnabled).toBe(true);
    expect(result.activated).toBe(false);
    expect(result.noSubscription).toBe(false);
    // Should navigate to settings
    expect(page.goto).toHaveBeenCalled();
    expect(page.goto.mock.calls[0][0]).toContain("one.google.com");
  });
});

describe("ensureGoogleOneSharing — no subscription", () => {
  it("returns noSubscription=true when redirected away from one.google.com", async () => {
    const { page } = buildMockPage({
      settingsUrl: "https://accounts.google.com/signin",   // redirected
    });
    const logger = buildMockLogger();

    const result = await ensureGoogleOneSharing(page, logger);

    expect(result.noSubscription).toBe(true);
    expect(result.activated).toBe(false);
    expect(result.alreadyEnabled).toBe(false);
    const warnCalls = logger.log.mock.calls.filter((c: any[]) => c[0] === "WARN");
    expect(warnCalls.length).toBeGreaterThan(0);
  });

  it("returns noSubscription=true when toggle not found on settings page", async () => {
    const { page } = buildMockPage({
      settingsToggleCount: 0,  // no toggle present
    });
    const logger = buildMockLogger();

    const result = await ensureGoogleOneSharing(page, logger);

    expect(result.noSubscription).toBe(true);
    expect(result.activated).toBe(false);
    expect(result.alreadyEnabled).toBe(false);
    const warnCalls = logger.log.mock.calls.filter((c: any[]) => c[0] === "WARN");
    expect(warnCalls.length).toBeGreaterThan(0);
  });
});

describe("ensureGoogleOneSharing — activates sharing", () => {
  it("clicks toggle and returns activated=true when aria-checked changes to true", async () => {
    // Simulate: toggle starts OFF, clicking it immediately changes to "true"
    let clickCount = 0;
    const { page, toggleLoc } = buildMockPage({
      settingsToggleCount: 1,
      toggleAriaChecked: "false",
    });
    // Override getAttribute to return "true" after click (simulate immediate state change)
    toggleLoc.getAttribute.mockImplementation(async () => {
      return clickCount > 0 ? "true" : "false";
    });
    toggleLoc.click.mockImplementation(async () => { clickCount++; });

    const logger = buildMockLogger();
    const result = await ensureGoogleOneSharing(page, logger);

    expect(result.activated).toBe(true);
    expect(result.alreadyEnabled).toBe(false);
  });

  it("confirms modal and returns activated=true when confirm button present", async () => {
    let clickCount = 0;
    const { page, toggleLoc } = buildMockPage({
      settingsToggleCount: 1,
      toggleAriaChecked: "false",
      confirmBtnCount: 1,
    });
    // Toggle stays OFF until after modal confirm (simulate by 3rd getAttribute call = true)
    let attrCallCount = 0;
    toggleLoc.getAttribute.mockImplementation(async () => {
      attrCallCount++;
      return attrCallCount >= 3 ? "true" : "false";
    });
    toggleLoc.click.mockImplementation(async () => { clickCount++; });

    const logger = buildMockLogger();
    const result = await ensureGoogleOneSharing(page, logger);

    expect(result.activated).toBe(true);
  });
});

describe("ensureGoogleOneSharing — error handling", () => {
  it("returns all-false (non-fatal) when page.goto throws", async () => {
    const { page } = buildMockPage({ gotoThrows: true });
    const logger = buildMockLogger();

    const result = await ensureGoogleOneSharing(page, logger);

    expect(result.alreadyEnabled).toBe(false);
    expect(result.activated).toBe(false);
    expect(result.noSubscription).toBe(false);
    const warnCalls = logger.log.mock.calls.filter((c: any[]) => c[0] === "WARN");
    expect(warnCalls.length).toBeGreaterThan(0);
  });
});
