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
   */
  async connect(cdpUrl: string): Promise<Page> {
    this.browser = await chromium.connectOverCDP(cdpUrl);

    // AdsPower always has at least one context with one page
    const contexts = this.browser.contexts();
    if (contexts.length === 0) {
      throw new Error("[browser] No browser contexts found after CDP connect");
    }

    const pages = contexts[0].pages();
    this.page = pages.length > 0 ? pages[0] : await contexts[0].newPage();

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
  async takeScreenshot(taskId: string, label: string): Promise<string> {
    const page = this.getPage();
    const dir = path.join(SCREENSHOTS_DIR, taskId);
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${label}-${Date.now()}.png`;
    const filepath = path.join(dir, filename);

    await page.screenshot({ path: filepath, fullPage: true });
    return filepath;
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
   * Disconnect from the browser (does NOT close AdsPower profile).
   */
  async disconnect(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {
        // CDP disconnect errors are non-fatal
      });
      this.browser = null;
      this.page = null;
    }
  }
}
