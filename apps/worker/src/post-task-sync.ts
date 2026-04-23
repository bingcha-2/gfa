/**
 * Post-task sync: lightweight family state reconciliation after any browser task.
 *
 * After any processor (replace, invite, remove, health) finishes its primary
 * operation on a Google Family group, this function re-scrapes the family page
 * and reconciles member data with the database.
 *
 * Benefits:
 *   - Catches PENDING → ACTIVE transitions (user manually accepted invite)
 *   - Detects externally removed members
 *   - Updates slot counts accurately after mutations
 *   - Keeps DB in sync without requiring a separate SYNC task
 *
 * This is non-fatal: errors are logged but never propagate to the caller.
 *
 * NOTE: This function does NOT scrape subscription info because it would
 * navigate away from the family page. Callers that need subscription data
 * (sync.processor, health.processor) handle it themselves after the family
 * sync is fully done.
 */

import type { Page } from "playwright";
import { PrismaClient } from "@prisma/client";
import { TaskLogger } from "./task-logger";
import { scrapeMembersFromPage, dedupeAndUpdateGroupCounts } from "./processors/sync.processor";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details?hl=en";

/**
 * Context hints from the calling processor.
 * Helps reconciliation correctly link gaiaOnly members that were just invited.
 */
export interface PostTaskSyncHints {
  /** Email of the member that was just invited — gaiaOnly members should prefer this. */
  justInvitedEmail?: string;
  /** If true, reconcileMembers will NOT create @gaia.unknown placeholder records (Tier 4). */
  skipPlaceholders?: boolean;
}

/**
 * @returns true if sync succeeded, false if it failed (non-fatal).
 */
export async function postTaskSync(
  page: Page,
  prisma: PrismaClient,
  familyGroupId: string,
  adminEmail: string,
  logger: TaskLogger,
  hints?: PostTaskSyncHints
): Promise<boolean> {
  try {
    await logger.log("INFO", "[post-task-sync] Starting post-task family sync...");

    // Navigate to family details (may already be there)
    if (!page.url().includes("family/details")) {
      await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    await page.waitForTimeout(500);

    // Scrape current state
    const { members, availableSlots } = await scrapeMembersFromPage(page, adminEmail.trim().toLowerCase());
    await logger.log("INFO", `[post-task-sync] Scraped ${members.length} members, ${availableSlots} available slots`);

    // Deduplicate, reconcile, compute slots, and update FamilyGroup — all in one shared call
    await dedupeAndUpdateGroupCounts(prisma, familyGroupId, members, availableSlots, logger, { hints });

    await logger.log("INFO", "[post-task-sync] Complete");
    return true;
  } catch (err) {
    // Non-fatal: log and swallow
    const msg = err instanceof Error ? err.message : String(err);
    await logger.log("WARN", `[post-task-sync] Failed (non-fatal): ${msg}`).catch(() => {});
    return false;
  }
}
