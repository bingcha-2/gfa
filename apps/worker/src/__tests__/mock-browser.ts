/**
 * Mock WorkerBrowser for integration tests.
 *
 * Provides a fake Playwright Page object that records method calls
 * without actually launching a browser.
 */

import { vi } from "vitest";

/**
 * Minimal mock Playwright Page that satisfies processor usage.
 * All navigation and interaction methods are no-ops.
 */
export function createMockPage() {
  const page: any = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue("https://myaccount.google.com/family/details"),
    locator: vi.fn().mockImplementation(() => createMockLocator()),
    evaluate: vi.fn().mockResolvedValue([]),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("")),
  };
  return page;
}

function createMockLocator() {
  const locator: any = {
    count: vi.fn().mockResolvedValue(1),
    first: vi.fn().mockImplementation(() => locator),
    last: vi.fn().mockImplementation(() => locator),
    nth: vi.fn().mockImplementation(() => locator),
    waitFor: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    textContent: vi.fn().mockResolvedValue(""),
    locator: vi.fn().mockImplementation(() => createMockLocator()),
  };
  return locator;
}

/**
 * Mock WorkerBrowser class matching the real WorkerBrowser interface.
 * Used via vi.mock('../browser-context') in test files.
 */
export class MockWorkerBrowser {
  private mockPage = createMockPage();

  async connect(_cdpUrl: string) {
    return this.mockPage;
  }

  getPage() {
    return this.mockPage;
  }

  async takeScreenshot(_taskId: string, _label: string): Promise<string> {
    return "/tmp/fake-screenshot.png";
  }

  async navigateTo(_url: string, _options?: any): Promise<void> {
    // no-op
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  /** Access the mock page for assertion */
  getMockPage() {
    return this.mockPage;
  }
}
