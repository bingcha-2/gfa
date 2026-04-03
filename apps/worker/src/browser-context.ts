/**
 * Playwright CDP browser context wrapper.
 *
 * Connects to an AdsPower-managed Chromium instance via its CDP debug URL
 * and provides page access, screenshot capture, and resource cleanup.
 */

import { chromium, Browser, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";

const SCREENSHOTS_DIR = path.resolve(process.cwd(), "screenshots");

export class WorkerBrowser {
  private browser: Browser | null = null;
  private page: Page | null = null;


  /**
   * Connect to a running Chrome instance via CDP websocket URL.
   *
   * @param cdpUrl  Chromium CDP debug websocket URL from AdsPower
   */
  async connect(cdpUrl: string): Promise<Page> {
    this.browser = await chromium.connectOverCDP(cdpUrl);

    // AdsPower always has at least one context with one page
    const contexts = this.browser.contexts();
    if (contexts.length === 0) {
      throw new Error("[browser] No browser contexts found after CDP connect");
    }

    const pages0 = contexts[0].pages();
    const existingPage = pages0.length > 0 ? pages0[0] : await contexts[0].newPage();

    // Clean-slate: clear everything for a fresh login.
    // AdsPower clears cache on restart, but this ensures a clean state
    // even if the profile was somehow left open.
    await contexts[0].clearCookies();

    // Clear localStorage / sessionStorage — navigate briefly then clear
    try {
      await existingPage.goto("https://accounts.google.com?hl=en", { waitUntil: "domcontentloaded", timeout: 8_000 });
      await existingPage.evaluate(() => {
        try { localStorage.clear(); } catch { /* cross-origin guard */ }
        try { sessionStorage.clear(); } catch { /* cross-origin guard */ }
      });
    } catch {
      // Non-fatal — if navigate fails, cookies are still cleared
    }

    // Reuse the same page that was used for cleanup / session check
    this.page = existingPage;

    return this.page;
  }

  /**
   * Get the current active page (throws if not connected).
   */
  getPage(): Page {
    if (!this.page) {
      throw new Error("[browser] Not connected — call connect() first");
    }
    return this.page;
  }

  /**
   * Take a screenshot and save to disk.
   * Returns the absolute file path of the saved screenshot.
   */
  async takeScreenshot(taskId: string, label: string): Promise<string | null> {
    const page = this.getPage();
    const dir = path.join(SCREENSHOTS_DIR, taskId);
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${label}-${Date.now()}.png`;
    const filepath = path.join(dir, filename);

    try {
      await page.screenshot({ path: filepath, fullPage: false, timeout: 10_000 });
      return filepath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[browser] screenshot failed for ${taskId} (${label}): ${msg}`);
      return null;
    }
  }

  /**
   * Navigate to a URL and wait for the page to be ready.
   */
  async navigateTo(
    url: string,
    options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number }
  ): Promise<void> {
    const page = this.getPage();
    await page.goto(url, {
      waitUntil: options?.waitUntil ?? "domcontentloaded",
      timeout: options?.timeout ?? 60_000,
    });
  }

  /**
   * Navigate with automatic retry on ERR_ABORTED.
   * Chrome may abort a navigation when: the profile is busy switching pages,
   * a JS redirect fires mid-navigation, or there's a brief network blip.
   * One retry after a short wait handles the vast majority of these cases.
   */
  async safeGoto(
    url: string,
    options?: { waitUntil?: "load" | "domcontentloaded"; timeout?: number }
  ): Promise<void> {
    const page = this.getPage();
    const waitUntil = options?.waitUntil ?? "domcontentloaded";
    const timeout = options?.timeout ?? 60_000;

    try {
      await page.goto(url, { waitUntil, timeout });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("ERR_ABORTED") ||
        msg.includes("net::ERR") ||
        msg.includes("interrupted by another navigation")
      ) {
        // Browser is mid-redirect (e.g. Google One intercept) — wait for it to settle,
        // then navigate to the intended destination again.
        await page.waitForTimeout(3_000);
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
        await page.goto(url, { waitUntil, timeout });
      } else {
        throw err;
      }
    }
  }

  /**
   * Close all extra tabs, keeping only one blank page.
   * Call before disconnect() to prevent tab accumulation across tasks.
   */
  async closeExtraPages(): Promise<void> {
    if (!this.browser) return;
    try {
      const contexts = this.browser.contexts();
      for (const ctx of contexts) {
        const pages = ctx.pages();
        // Navigate the first page to about:blank, close all others
        if (pages.length > 0) {
          await pages[0].goto("about:blank", { timeout: 5_000 }).catch(() => {});
          for (let i = 1; i < pages.length; i++) {
            await pages[i].close().catch(() => {});
          }
        }
      }
    } catch {
      // Non-fatal cleanup
    }
  }

  /**
   * Disconnect from the browser (does NOT close AdsPower profile).
   * Automatically closes extra tabs before disconnecting.
   */
  async disconnect(): Promise<void> {
    if (this.browser) {
      await this.closeExtraPages();
      await this.browser.close().catch(() => {
        // CDP disconnect errors are non-fatal
      });
      this.browser = null;
      this.page = null;
    }
  }
}
