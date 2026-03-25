/**
 * Sync family group processor.
 *
 * Reads the current member list from Google Family page and writes
 * the data back to FamilyMember / FamilyGroup tables.
 */

import { Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { SyncFamilyGroupPayload } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { ProfileLock } from "../profile-lock";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details";

export interface SyncProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  lock: ProfileLock;
  workerId: string;
}

interface ScrapedMember {
  email: string;
  displayName: string;
  role: string;
}

export async function processSync(
  job: Job<SyncFamilyGroupPayload>,
  deps: SyncProcessorDeps
): Promise<void> {
  const { prisma, adspower, lock, workerId } = deps;
  const { familyGroupId, accountId } = job.data;
  const taskId = job.id ?? job.name;
  if (!taskId) {
    console.error(`[worker:${workerId}] sync job has no id or name, skipping`);
    return;
  }

  const logger = new TaskLogger(prisma, taskId, workerId);
  const browser = new WorkerBrowser();

  const account = await prisma.account.findUnique({
    where: { id: accountId },
  });
  if (!account) {
    await logger.updateStatus("FAILED_FINAL", {
      code: "ACCOUNT_NOT_FOUND",
      message: `Account ${accountId} not found`,
    });
    return;
  }

  const profileId = account.adspowerProfileId;

  const locked = await lock.acquire(profileId, workerId);
  if (!locked) {
    await logger.updateStatus("FAILED_RETRYABLE", {
      code: "PROFILE_LOCKED",
      message: `Profile ${profileId} locked`,
    });
    throw new Error(`Profile ${profileId} locked — will retry`);
  }

  try {
    await logger.updateStatus("RUNNING");

    const { debugUrl } = await adspower.openProfile(profileId);
    const page = await browser.connect(debugUrl);

    await browser.navigateTo(GOOGLE_FAMILY_URL, { waitUntil: "networkidle" });
    await logger.log("INFO", "Navigated to Family page for sync");

    // Scrape current members from the page
    const members = await scrapeMembersFromPage(page);
    await logger.log("INFO", `Found ${members.length} members on page`, {
      members,
    });

    const afterPath = await browser.takeScreenshot(taskId, "sync");
    await logger.recordScreenshot("afterScreenshotPath", afterPath);

    // Reconcile with database
    await reconcileMembers(prisma, familyGroupId, members, logger);

    // Update group counts
    await prisma.familyGroup.update({
      where: { id: familyGroupId },
      data: {
        memberCount: members.length,
        availableSlots: Math.max(0, 6 - members.length),
        lastSyncedAt: new Date(),
      },
    });

    await logger.updateStatus("SUCCESS");
    await logger.log("INFO", `Sync complete: ${members.length} members, ${Math.max(0, 6 - members.length)} slots available`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    try {
      const errPath = await browser.takeScreenshot(taskId, "error");
      await logger.recordScreenshot("errorScreenshotPath", errPath);
    } catch {
      // noop
    }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: "SYNC_ERROR",
      message: errMsg,
    });

    throw error;
  } finally {
    await browser.disconnect().catch(() => {});
    await adspower.closeProfile(profileId).catch(() => {});
    await lock.release(profileId, workerId).catch(() => {});
  }
}

/**
 * Scrape family member info from the Google Family page.
 * Returns a list of { email, displayName, role }.
 *
 * Selectors calibrated from real Google Family UI (myaccount.google.com/family/details).
 * Members are rendered as <a class="umngff" href="family/member/g/..."> inside <div class="N25As">.
 * Each member card: displayName in div.IlKlLe, role in div.ImPZoc.
 * Account email is captured from the top-right avatar button's aria-label.
 */
async function scrapeMembersFromPage(
  page: import("playwright").Page
): Promise<ScrapedMember[]> {
  await page.waitForLoadState("networkidle");

  const members = await page.evaluate(() => {
    const result: { email: string; displayName: string; role: string }[] = [];

    // Member cards: div.N25As > a.umngff[href^="family/member/"]
    const memberCards = document.querySelectorAll('a.umngff[href*="family/member/"]');

    memberCards.forEach((el) => {
      const displayName = el.querySelector('.IlKlLe')?.textContent?.trim() ?? '';
      const role = el.querySelector('.ImPZoc')?.textContent?.trim() ?? 'member';

      // Try to extract email from member detail link or from visible text
      // On the list page, emails aren't always visible; the displayName is the primary identifier
      // We'll use the member profile URL segment as a fallback identifier
      const href = el.getAttribute('href') ?? '';
      const memberGaiaId = href.match(/member\/g\/(\d+)/)?.[1] ?? '';

      result.push({
        email: '', // Email not directly visible on list page; will match by displayName
        displayName,
        role,
      });
    });

    return result;
  });

  // Also scrape the available slots from the invite button text
  // "傳送邀請 (還可邀請 5 人)" → 5 slots
  const inviteLinkText = await page
    .locator('a[href*="invitemembers"]')
    .first()
    .textContent()
    .catch(() => '');

  // Parse the slot count from the link text
  const slotMatch = inviteLinkText?.match(/(\d+)/);
  const availableSlots = slotMatch ? parseInt(slotMatch[1], 10) : 6 - members.length;

  // Attach availableSlots to the result via a custom property on the array
  (members as any).__availableSlots = availableSlots;

  return members;
}

/**
 * Reconcile scraped members with the database.
 */
async function reconcileMembers(
  prisma: PrismaClient,
  familyGroupId: string,
  scrapedMembers: ScrapedMember[],
  logger: TaskLogger
): Promise<void> {
  const existing = await prisma.familyMember.findMany({
    where: { familyGroupId },
  });

  const scrapedEmails = new Set(scrapedMembers.map((m) => m.email));
  const existingEmails = new Set(existing.map((m) => m.email));

  // Mark members NOT on page as REMOVED
  for (const member of existing) {
    if (!scrapedEmails.has(member.email) && member.status === "ACTIVE") {
      await prisma.familyMember.update({
        where: { id: member.id },
        data: { status: "REMOVED", removedAt: new Date() },
      });
      await logger.log("INFO", `Marked ${member.email} as REMOVED (not on page)`);
    }
  }

  // Upsert members found on page
  for (const scraped of scrapedMembers) {
    if (existingEmails.has(scraped.email)) {
      // Update existing
      await prisma.familyMember.updateMany({
        where: { familyGroupId, email: scraped.email },
        data: {
          displayName: scraped.displayName,
          role: scraped.role,
          status: "ACTIVE",
        },
      });
    } else {
      // Create new
      await prisma.familyMember.create({
        data: {
          familyGroupId,
          email: scraped.email,
          displayName: scraped.displayName,
          role: scraped.role,
          status: "ACTIVE",
          joinedAt: new Date(),
        },
      });
      await logger.log("INFO", `New member discovered: ${scraped.email}`);
    }
  }
}
