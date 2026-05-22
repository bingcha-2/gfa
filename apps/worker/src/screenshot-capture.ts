import type { Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import type { TaskLogger } from "./task-logger";

const SCREENSHOTS_DIR = path.resolve(process.cwd(), "screenshots");
const SCREENSHOT_MODE = (process.env.GFA_SCREENSHOT_MODE ?? process.env.SCREENSHOT_MODE ?? "errors").toLowerCase();
const SCREENSHOT_TIMEOUT_MS = Number(process.env.GFA_SCREENSHOT_TIMEOUT_MS ?? process.env.SCREENSHOT_TIMEOUT_MS ?? 2_000);

function sanitizeLabel(label: string): string {
  return label
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "step";
}

export async function captureStepScreenshot(
  page: Page,
  logger: TaskLogger,
  label: string,
  field?: "beforeScreenshotPath" | "afterScreenshotPath" | "errorScreenshotPath"
): Promise<string | null> {
  const isErrorScreenshot = field === "errorScreenshotPath";
  const shouldCapture =
    SCREENSHOT_MODE === "all" ||
    (SCREENSHOT_MODE === "errors" && isErrorScreenshot);

  if (!shouldCapture) {
    return null;
  }

  try {
    const taskId = logger.getTaskId();
    const dir = path.join(SCREENSHOTS_DIR, taskId);
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${Date.now()}-${sanitizeLabel(label)}.png`;
    const filepath = path.join(dir, filename);
    await page.screenshot({ path: filepath, fullPage: false, timeout: SCREENSHOT_TIMEOUT_MS });
    await logger.log("DEBUG", `[screenshot] ${label}: ${filepath}`);
    if (field) {
      await logger.recordScreenshot(field, filepath);
    }
    return filepath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.log("DEBUG", `[screenshot] ${label} failed: ${msg}`);
    return null;
  }
}
