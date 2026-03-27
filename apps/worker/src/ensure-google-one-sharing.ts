/**
 * EnsureGoogleOneSharing — after a family group is confirmed, navigate to
 * one.google.com/settings and activate "Share Google One with family" toggle.
 *
 * How Google One settings work (verified from real DOM analysis):
 *  - URL: https://one.google.com/u/0/settings
 *  - Toggle element: BUTTON[role="switch"][aria-label="Share Google One with family"]
 *  - aria-checked="true"  → sharing is ON
 *  - aria-checked="false" → sharing is OFF
 *
 * This step is NON-FATAL: if the account has no Google One subscription,
 * or the UI changes, the function logs a warning and returns without throwing.
 */

import type { Page } from "playwright";
import type { TaskLogger } from "./task-logger";

const GOOGLE_ONE_SETTINGS_URL = "https://one.google.com/u/0/settings?hl=en";

// Multi-locale aria-label values for the sharing toggle
const SHARING_TOGGLE_LABELS = [
  "Share Google One with family",   // EN
  "与家人共享 Google One",           // Simplified Chinese
  "與家人共用 Google One",           // Traditional Chinese
  "가족과 Google One 공유",          // Korean
  "家族と Google One を共有",         // Japanese
  "Compartir Google One con familia", // Spanish
];

export interface GoogleOneSharingResult {
  /** true if sharing was already enabled before this call */
  alreadyEnabled: boolean;
  /** true if sharing was successfully activated by this call */
  activated: boolean;
  /** true if Google One is not available on this account */
  noSubscription: boolean;
}

export async function ensureGoogleOneSharing(
  page: Page,
  logger: TaskLogger
): Promise<GoogleOneSharingResult> {
  try {
    return await _ensureGoogleOneSharing(page, logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.log("WARN", `[google-one-sharing] Non-fatal error: ${msg}`);
    return { alreadyEnabled: false, activated: false, noSubscription: false };
  }
}

async function _ensureGoogleOneSharing(
  page: Page,
  logger: TaskLogger
): Promise<GoogleOneSharingResult> {
  await logger.log("INFO", "[google-one-sharing] Checking Google One family sharing status");

  // Navigate to settings page
  await page.goto(GOOGLE_ONE_SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);

  const currentUrl = page.url();

  // Detect no-subscription: if redirected away from settings (e.g. to /about or /u/0/)
  // or the settings page has no subscription section
  if (!currentUrl.includes("one.google.com")) {
    await logger.log("WARN", "[google-one-sharing] Redirected away from Google One — no subscription?");
    return { alreadyEnabled: false, activated: false, noSubscription: true };
  }

  // Find the "Share Google One with family" toggle by aria-label
  const toggleSel = SHARING_TOGGLE_LABELS
    .map(label => `button[role="switch"][aria-label="${label}"]`)
    .join(", ");

  const toggle = page.locator(toggleSel).first();

  // Check if the page loaded but has no toggle (no subscription)
  if ((await toggle.count()) === 0) {
    await logger.log("WARN", "[google-one-sharing] Sharing toggle not found — account may not have Google One subscription");
    return { alreadyEnabled: false, activated: false, noSubscription: true };
  }

  // Check current state via aria-checked
  const ariaChecked = await toggle.getAttribute("aria-checked");
  await logger.log("INFO", `[google-one-sharing] Toggle found, aria-checked="${ariaChecked}"`);

  if (ariaChecked === "true") {
    await logger.log("INFO", "[google-one-sharing] Toggle is already ON — nothing to do");
    return { alreadyEnabled: true, activated: false, noSubscription: false };
  }

  // Click the toggle to enable sharing
  await logger.log("INFO", "[google-one-sharing] Enabling family sharing toggle...");
  // Scroll toggle into visible viewport first
  await toggle.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  // Use normal click (not force) so Angular events fire properly
  try {
    await toggle.click({ timeout: 5_000 });
  } catch {
    // Fallback: JS click via evaluate
    await toggle.evaluate((el) => (el as HTMLElement).click());
  }
  await page.waitForTimeout(3000);
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  // Check if toggle changed to ON immediately (no modal needed)
  await page.waitForTimeout(1500);
  const ariaCheckedImmediate = await toggle.getAttribute("aria-checked").catch(() => null);
  await logger.log("INFO", `[google-one-sharing] After click: aria-checked="${ariaCheckedImmediate}"`);

  if (ariaCheckedImmediate === "true") {
    await logger.log("INFO", "[google-one-sharing] ✅ Google One family sharing successfully activated");
    return { alreadyEnabled: false, activated: true, noSubscription: false };
  }

  // If still OFF: look for a confirmation modal/dialog (restrict to dialog scope!)
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').first();
  if ((await dialog.count()) > 0) {
    const confirmBtn = dialog.locator([
      'button:has-text("Turn on")',
      'button:has-text("Enable")',
      'button:has-text("Confirm")',
      'button:has-text("OK")',
      'button:has-text("开启")',
      'button:has-text("确认")',
    ].join(", ")).first();

    if ((await confirmBtn.count()) > 0) {
      const btnText = await confirmBtn.textContent().catch(() => "?");
      await logger.log("INFO", `[google-one-sharing] Confirming modal: "${btnText?.trim()}"`);
      await confirmBtn.click();
      await page.waitForTimeout(2000);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
  }

  // Final verify — re-query the toggle to avoid stale element reference after modal
  const toggleAfter = page.locator(toggleSel).first();
  const ariaCheckedAfter = await toggleAfter.getAttribute("aria-checked").catch(() => null);
  await logger.log("INFO", `[google-one-sharing] Final aria-checked="${ariaCheckedAfter}"`);

  if (ariaCheckedAfter === "true") {
    await logger.log("INFO", "[google-one-sharing] ✅ Google One family sharing successfully activated");
    return { alreadyEnabled: false, activated: true, noSubscription: false };
  }

  // Could not verify — log but don't fail
  await logger.log("WARN", "[google-one-sharing] Could not verify toggle activation — may have partially succeeded");
  return { alreadyEnabled: false, activated: false, noSubscription: false };
}
