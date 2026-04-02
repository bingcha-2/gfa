/**
 * EnsureFamilyGroup — after Gmail login, verify the account has an active
 * Google Family Group. If not, automatically create one via the UI.
 *
 * Wizard flow (3 steps, no iframes):
 *   family/details              → click "Get started"       → a.umngff
 *   family/create               → click "Create a Family Group" → a.UywwFc-mRLv6
 *   family/createconfirmation   → click "Confirm"           → button.UywwFc-LgbsSe
 */

import type { Page } from "playwright";
import { PrismaClient } from "@prisma/client";
import type { TaskLogger } from "./task-logger";
import { ensureGoogleOneSharing } from "./ensure-google-one-sharing";

const FAMILY_URL = "https://myaccount.google.com/family/details?hl=en";

export async function ensureFamilyGroup(
  page: Page,
  account: { id: string; loginEmail: string },
  prisma: PrismaClient,
  logger: TaskLogger
): Promise<{ familyGroupId: string }> {
  await logger.log("INFO", "[ensure-family-group] Checking family group status");

  await page.goto(FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Wait for key elements to render (invite link or member cards), fallback 3s
  await Promise.race([
    page.locator('a[href*="invitemembers"], a[href*="family/member"], a[href*="family/create"]').first()
      .waitFor({ state: "visible", timeout: 3000 }).catch(() => {}),
    page.waitForTimeout(3000),
  ]);

  const landedUrl = page.url();

  // Detect login redirect: Google sent us back to accounts.google.com
  // This means gmailLogin() succeeded superficially but the session wasn't established
  if (landedUrl.includes("accounts.google.com")) {
    throw new Error(
      `[ensure-family-group] Session not established — redirected to Google login page ` +
      `(URL: ${landedUrl}). The previous gmailLogin may need re-verification.`
    );
  }

  // Case 1: Family group already exists (invite link or member cards present)
  const hasInviteLink = (await page.locator('a[href*="invitemembers"]').count()) > 0;
  const hasMemberCards = (await page.locator('a[href*="family/member"]').count()) > 0;
  if (hasInviteLink || hasMemberCards) {
    await logger.log("INFO", "[ensure-family-group] Family group already exists");
    await ensureGoogleOneSharing(page, logger);
    return findOrCreateDbRecord(prisma, account, logger);
  }

  // Case 2: "Get started" link present → start creation wizard
  // NOTE: do NOT use generic class selectors like `a.umngff` — they match member cards too
  const getStartedBtn = page.locator('a[href*="family/create"]').first();
  if ((await getStartedBtn.count()) > 0) {
    await logger.log("INFO", "[ensure-family-group] No family group found — starting creation wizard");
    await getStartedBtn.click();
    await page.waitForTimeout(4000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await walkCreationWizard(page, logger);

    // Verify creation succeeded
    await page.goto(FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4000);

    const inviteLinkAfter = page.locator('a[href*="invitemembers"]');
    if ((await inviteLinkAfter.count()) === 0) {
      throw new Error(
        "[ensure-family-group] Family group creation may have failed — invite link not found after creation"
      );
    }

    await logger.log("INFO", "[ensure-family-group] Family group created successfully");
    await ensureGoogleOneSharing(page, logger);
    return findOrCreateDbRecord(prisma, account, logger);
  }

  // Case 3: Unknown state
  const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? "");
  throw new Error(
    `[ensure-family-group] Cannot determine family group state. URL: ${page.url()}, snippet: ${pageText}`
  );
}

/**
 * Walk through the 2-step creation wizard:
 *   Step A (family/create):              click "Create a Family Group" → a.UywwFc-mRLv6
 *   Step B (family/createconfirmation):  click "Confirm"               → button.UywwFc-LgbsSe
 */
async function walkCreationWizard(page: Page, logger: TaskLogger): Promise<void> {
  for (let step = 0; step < 8; step++) {
    const url = page.url();
    await logger.log("INFO", `[ensure-family-group] Wizard step ${step + 1}: URL = ${url}`);

    // Done when redirected back to family page (invitemembers = creation success)
    if (
      url.includes("family/details") ||
      url.includes("family/manage") ||
      url.includes("family/members") ||
      url.includes("family/invitemembers")
    ) {
      await logger.log("INFO", "[ensure-family-group] Wizard complete");
      return;
    }

    // Wait for page to render
    await page.waitForTimeout(2000);

    // ── Step A: family/create ────────────────────────────────────────────────
    if (url.includes("family/create") && !url.includes("createconfirmation")) {
      // Primary selector: UywwFc-mRLv6 is the "Create a Family Group" card/button
      // Secondary selectors as fallback
      const btn = page.locator([
        "a.UywwFc-mRLv6",
        "a[aria-label='Create a Family Group']",
        "a[href*='createconfirmation']",
        "a[href*='family/createconfirmation']",
        // Fallback: any prominent link to confirmation
        "a[href*='createconfirm']",
      ].join(", ")).first();

      if ((await btn.count()) > 0) {
        const href = await btn.getAttribute("href").catch(() => "");
        await logger.log("INFO", `[ensure-family-group] Clicking "Create a Family Group" (href: ${href})`);
        await btn.click();
        await page.waitForTimeout(3000);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        continue;
      }

      await logger.log("WARN", "[ensure-family-group] Could not find 'Create a Family Group' button on family/create");
      break;
    }

    // ── Step B: family/createconfirmation ────────────────────────────────────
    if (url.includes("createconfirmation")) {
      const confirmBtn = page.locator([
        "button.UywwFc-LgbsSe",
        "button:has-text('Confirm')",
        "button:has-text('確認')",
        "button:has-text('확인')",
        "button:has-text('確定')",
        "button:has-text('同意')",
        "button[type='submit']",
      ].join(", ")).first();

      if ((await confirmBtn.count()) > 0) {
        const txt = await confirmBtn.textContent().catch(() => "?");
        await logger.log("INFO", `[ensure-family-group] Clicking Confirm button: "${txt?.trim()}"`);
        await confirmBtn.click();
        await page.waitForTimeout(4000);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        continue;
      }

      await logger.log("WARN", "[ensure-family-group] Could not find Confirm button on createconfirmation page");
      break;
    }

    // Unknown page — log and exit
    await logger.log("WARN", `[ensure-family-group] Unknown wizard URL: ${url} — stopping`);
    break;
  }
}

/**
 * Look up or create the FamilyGroup DB record for this account.
 */
async function findOrCreateDbRecord(
  prisma: PrismaClient,
  account: { id: string; loginEmail: string },
  logger: TaskLogger
): Promise<{ familyGroupId: string }> {
  const existing = await prisma.familyGroup.findFirst({
    where: { accountId: account.id },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  if (existing) {
    await logger.log("INFO", `[ensure-family-group] Using existing DB record: ${existing.id}`);
    return { familyGroupId: existing.id };
  }

  try {
    const groupName = account.loginEmail.split("@")[0];
    const newGroup = await prisma.familyGroup.create({
      data: {
        accountId: account.id,
        groupName,
        maxMembers: 5,
        memberCount: 0,
        availableSlots: 5,
      },
    });
    await logger.log("INFO", `[ensure-family-group] Created new DB record: ${newGroup.id}`);
    return { familyGroupId: newGroup.id };
  } catch (err: any) {
    // FK error (P2003): accountId doesn't exist in DB (e.g. smoke test with fake id)
    if (err?.code === "P2003" || err?.message?.includes("Foreign key")) {
      await logger.log("WARN", `[ensure-family-group] DB FK error (account not in DB) — returning placeholder. ${err.message}`);
      return { familyGroupId: `no-db-${account.id}` };
    }
    throw err;
  }
}
