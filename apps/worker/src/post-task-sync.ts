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
 */

import type { Page } from "playwright";
import { PrismaClient } from "@prisma/client";
import { TaskLogger } from "./task-logger";
import { scrapeMembersFromPage, reconcileMembers } from "./processors/sync.processor";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details?hl=en";

export async function postTaskSync(
  page: Page,
  prisma: PrismaClient,
  familyGroupId: string,
  adminEmail: string,
  logger: TaskLogger
): Promise<void> {
  try {
    await logger.log("INFO", "[post-task-sync] Starting post-task family sync...");

    // Navigate to family details (may already be there)
    if (!page.url().includes("family/details")) {
      await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    await page.waitForTimeout(2000);

    // Scrape current state
    const { members, availableSlots } = await scrapeMembersFromPage(page, adminEmail.trim().toLowerCase());
    await logger.log("INFO", `[post-task-sync] Scraped ${members.length} members, ${availableSlots} available slots`);

    // Deduplicate
    const seenEmails = new Set<string>();
    const dedupedMembers = members.filter((m) => {
      const key = m.email?.toLowerCase();
      if (!key) return true;
      if (seenEmails.has(key)) return false;
      seenEmails.add(key);
      return true;
    });

    // Reconcile with DB
    await reconcileMembers(prisma, familyGroupId, dedupedMembers, logger);

    // Update group counts
    const dedupedNonAdmin = dedupedMembers.filter(
      (m) => !m.role.toLowerCase().includes("manager")
    );
    const rawNonAdmin = members.filter(
      (m) => !m.role.toLowerCase().includes("manager")
    );
    const NON_ADMIN_CAPACITY = 5;
    const computedSlots = Math.max(0, NON_ADMIN_CAPACITY - rawNonAdmin.length);
    const finalAvailableSlots = Math.min(availableSlots, computedSlots);

    await prisma.familyGroup.update({
      where: { id: familyGroupId },
      data: {
        memberCount: dedupedNonAdmin.length,
        availableSlots: finalAvailableSlots,
        lastSyncedAt: new Date(),
      },
    });

    await logger.log("INFO",
      `[post-task-sync] Complete: ${dedupedNonAdmin.length} members, ${finalAvailableSlots} slots available`
    );
  } catch (err) {
    // Non-fatal: log and swallow
    const msg = err instanceof Error ? err.message : String(err);
    await logger.log("WARN", `[post-task-sync] Failed (non-fatal): ${msg}`).catch(() => {});
  }
}
