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
  googleMemberId: string; // GAIA ID from href="/family/member/g/{id}"
}

export async function processSync(
  job: Job<SyncFamilyGroupPayload>,
  deps: SyncProcessorDeps
): Promise<void> {
  const { prisma, adspower, lock, workerId } = deps;
  const { familyGroupId, accountId } = job.data;
  const taskId = job.data.taskId ?? job.id ?? job.name;
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

    // Scrape current members from the page (visits each member detail page for real emails)
    const { members, availableSlots } = await scrapeMembersFromPage(page);
    await logger.log("INFO", `Found ${members.length} members on page`, { members });

    const afterPath = await browser.takeScreenshot(taskId, "sync");
    await logger.recordScreenshot("afterScreenshotPath", afterPath);

    // Reconcile with database
    await reconcileMembers(prisma, familyGroupId, members, logger);

    // Update group counts — use scraped availableSlots (from Google's invite button text)
    // and DB maxMembers (not hardcoded to 6)
    const group = await prisma.familyGroup.findUnique({
      where: { id: familyGroupId },
      select: { maxMembers: true },
    });
    const maxMembers = group?.maxMembers ?? 5;

    await prisma.familyGroup.update({
      where: { id: familyGroupId },
      data: {
        memberCount: members.length,
        availableSlots: Math.min(availableSlots, Math.max(0, maxMembers - members.length)),
        lastSyncedAt: new Date(),
      },
    });

    await logger.updateStatus("SUCCESS");
    await logger.log("INFO", `Sync complete: ${members.length} members, ${availableSlots} slots available`);
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
 * Visits each member's detail page to read the real email address,
 * since emails are not always shown on the list page.
 *
 * Returns { members, availableSlots }.
 */
async function scrapeMembersFromPage(
  page: import("playwright").Page
): Promise<{ members: ScrapedMember[]; availableSlots: number }> {
  await page.waitForLoadState("networkidle");

  // Parse available slots from invite button text
  const inviteLinkText = await page
    .locator('a[href*="invitemembers"]')
    .first()
    .textContent()
    .catch(() => "");
  const slotMatch = inviteLinkText?.match(/(\d+)/);

  // KEY INSIGHT: a[href*="family/member/"] IS the "Family member details" link.
  // The member's display name lives in SIBLING elements inside the parent card container,
  // NOT inside the <a> element itself.
  const cardDebug = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="family/member/"]');
    return Array.from(links).map((link) => {
      const href = link.getAttribute("href") ?? "";

      // Walk up to find the card container (li, or a div that wraps both name + link)
      const card = link.closest("li, [data-member], .member-card") ?? link.parentElement;

      // Collect leaf-node texts from the CARD, excluding any text from inside the <a>
      const cardDescendants = card ? Array.from(card.querySelectorAll("*")) : [];
      const leafTexts = cardDescendants
        .filter((c) => c.children.length === 0 && !link.contains(c))
        .map((c) => c.textContent?.trim() ?? "")
        .filter((t) => t.length > 0)
        .slice(0, 10);

      // Best name: not an email, not purely numeric, not too short (avatar letter)
      const nameEl = cardDescendants.find((child) => {
        if (link.contains(child)) return false; // skip anything inside the <a>
        if (child.children.length > 0) return false; // leaf nodes only
        const text = child.textContent?.trim() ?? "";
        return (
          text.length > 1 && // exclude single avatar letters
          text.length < 80 &&
          !text.includes("@") &&
          !text.toLowerCase().includes("family member") &&
          !/^\d+$/.test(text) // exclude pure numbers
        );
      });

      const displayName = nameEl?.textContent?.trim() ?? "";
      return { href, displayName, leafTexts };
    });
  });

  console.log("[sync] card debug:", JSON.stringify(cardDebug, null, 2));
  const cardData = cardDebug.map(({ href, displayName }) => ({ href, displayName }));
  const seenGaiaIds = new Set<string>();
  const uniqueCards: Array<{ href: string; displayName: string; gaiaId: string }> = [];
  for (const card of cardData) {
    if (!card.href) continue;
    // Try /g/12345 first, then bare /member/12345
    const gaiaId =
      card.href.match(/\/g\/(\d+)/)?.[1] ??
      card.href.match(/\/member\/(\d+)/)?.[1] ??
      card.href; // last resort: use full href as key
    if (!seenGaiaIds.has(gaiaId)) {
      seenGaiaIds.add(gaiaId);
      uniqueCards.push({ ...card, gaiaId });
    }
  }

  const members: ScrapedMember[] = [];
  const baseUrl = "https://myaccount.google.com/";

  for (const card of uniqueCards) {
    const detailUrl = card.href.startsWith("http")
      ? card.href
      : `${baseUrl}${card.href}`;

    try {
      await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 20000 });
      await page.waitForTimeout(500);

      // Read email from detail page only — NOT displayName (page title would give 'Family member details')
      const email = await page.evaluate(() => {
        const allText = Array.from(document.querySelectorAll("div, span, p"))
          .map((el) => el.textContent?.trim() ?? "")
          .filter((t) => t.includes("@") && t.includes("."));
        return allText.find((t) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) ?? "";
      });

      // Role
      const role = await page.evaluate(() =>
        document.querySelector(".ImPZoc, [data-member-role]")?.textContent?.trim() ?? "member"
      );

      if (email || card.gaiaId) {
        members.push({
          email,
          displayName: card.displayName,
          role,
          googleMemberId: card.gaiaId,
        });
      }
    } catch {
      // Skip unreadable member detail — still record with list-page data
      if (card.gaiaId) {
        members.push({
          email: "",
          displayName: card.displayName,
          role: "member",
          googleMemberId: card.gaiaId,
        });
      }
    }

    // Navigate back to family list
    await page.goto("https://myaccount.google.com/family/details", {
      waitUntil: "networkidle",
      timeout: 20000,
    }).catch(() => {});
    await page.waitForTimeout(500);
  }

  const finalSlots = slotMatch ? parseInt(slotMatch[1], 10) : Math.max(0, 6 - members.length);
  return { members, availableSlots: finalSlots };
}

/**
 * Reconcile scraped members with the database.
 *
 * Two categories of scraped members:
 *   A) emailMembers   — have email (pending invites, or detail page showed email)
 *   B) gaiaOnlyMembers — no email but have GAIA ID (accepted invite, Google hides email)
 *
 * Strategy:
 *   1. Upsert email members normally.
 *   2. For REMOVED marking: skip if gaiaOnly members exist (they may correspond to DB records).
 *   3. For gaiaOnly members: link to existing DB records via gaiaId → displayName → elimination.
 */
async function reconcileMembers(
  prisma: PrismaClient,
  familyGroupId: string,
  scrapedMembers: ScrapedMember[],
  logger: TaskLogger
): Promise<void> {
  const emailMembers = scrapedMembers.filter((m) => !!m.email);
  const gaiaOnlyMembers = scrapedMembers.filter((m) => !m.email && !!m.googleMemberId);

  if (emailMembers.length === 0 && gaiaOnlyMembers.length === 0) {
    await logger.log("WARN", "No members scraped — skipping reconciliation");
    return;
  }

  const existing = await prisma.familyMember.findMany({ where: { familyGroupId } });
  const scrapedEmails = new Set(emailMembers.map((m) => m.email));

  // --- Step 1: Mark members as REMOVED only when we can be sure they left ---
  // If there are gaiaOnly scraped members, they may correspond to DB records
  // not in scrapedEmails — be conservative and skip REMOVED marking for those.
  for (const member of existing) {
    if (!member.email || !scrapedEmails.has(member.email) && member.status === "ACTIVE") {
      if (gaiaOnlyMembers.length > 0) {
        // Could correspond to a gaiaOnly scraped member — skip
        await logger.log("DEBUG", `Skipping REMOVED for ${member.email} — ${gaiaOnlyMembers.length} unidentified scrape member(s) present`);
      } else if (member.email && !scrapedEmails.has(member.email) && member.status === "ACTIVE") {
        await prisma.familyMember.update({
          where: { id: member.id },
          data: { status: "REMOVED", removedAt: new Date() },
        });
        await logger.log("INFO", `Marked ${member.email} as REMOVED (not on page)`);
      }
    }
  }

  // --- Step 2: Upsert email members ---
  for (const scraped of emailMembers) {
    await prisma.familyMember.upsert({
      where: { familyGroupId_email: { familyGroupId, email: scraped.email } },
      update: {
        displayName: scraped.displayName || undefined,
        role: scraped.role,
        status: "ACTIVE",
        googleMemberId: scraped.googleMemberId || undefined,
      },
      create: {
        familyGroupId,
        email: scraped.email,
        displayName: scraped.displayName || undefined,
        role: scraped.role,
        status: "ACTIVE",
        googleMemberId: scraped.googleMemberId || undefined,
        joinedAt: new Date(),
      },
    });
    await logger.log("INFO", `Upserted member: ${scraped.email} (gaia=${scraped.googleMemberId || "unknown"})`);
  }

  // --- Step 3: Link gaiaOnly members to existing DB records ---
  // Members with no email on page: try gaiaId → displayName → single-candidate elimination
  for (const scrape of gaiaOnlyMembers) {
    await logger.log("INFO", `Linking gaiaOnly member: gaia=${scrape.googleMemberId}, name="${scrape.displayName}"`);

    // Tier 1: Already linked by gaiaId in a previous sync
    const byGaia = await prisma.familyMember.findFirst({
      where: { familyGroupId, googleMemberId: scrape.googleMemberId },
    });
    if (byGaia) {
      await prisma.familyMember.update({
        where: { id: byGaia.id },
        data: { status: "ACTIVE", displayName: scrape.displayName || byGaia.displayName || undefined },
      });
      await logger.log("INFO", `T1 linked: gaia=${scrape.googleMemberId} → ${byGaia.email}`);
      continue;
    }

    // Tier 2: Match by displayName
    if (scrape.displayName) {
      const byName = await prisma.familyMember.findFirst({
        where: { familyGroupId, displayName: scrape.displayName },
      });
      if (byName) {
        await prisma.familyMember.update({
          where: { id: byName.id },
          data: { googleMemberId: scrape.googleMemberId, status: "ACTIVE" },
        });
        await logger.log("INFO", `T2 linked: gaia=${scrape.googleMemberId} → ${byName.email} via displayName`);
        continue;
      }
    }

    // Tier 3: Elimination — single unlinked active/pending member not in scrapedEmails
    const unlinked = existing.filter(
      (m) => !m.googleMemberId && !scrapedEmails.has(m.email) && m.status !== "REMOVED"
    );
    if (unlinked.length === 1) {
      await prisma.familyMember.update({
        where: { id: unlinked[0].id },
        data: {
          googleMemberId: scrape.googleMemberId,
          status: "ACTIVE",
          displayName: scrape.displayName || unlinked[0].displayName || undefined,
        },
      });
      await logger.log("INFO", `T3 linked: gaia=${scrape.googleMemberId} → ${unlinked[0].email} by elimination`);
    } else {
      // Tier 4: No match found — create as INVITED so the member is not silently dropped
      // This covers pending invites that are visible on page but have no email in our DB yet
      const placeholder = `pending-${scrape.googleMemberId}@gaia.unknown`;
      await prisma.familyMember.upsert({
        where: { familyGroupId_email: { familyGroupId, email: placeholder } },
        update: {
          displayName: scrape.displayName || undefined,
          googleMemberId: scrape.googleMemberId,
          status: "PENDING",
        },
        create: {
          familyGroupId,
          email: placeholder,
          displayName: scrape.displayName || undefined,
          googleMemberId: scrape.googleMemberId,
          role: scrape.role ?? "member",
          status: "PENDING",
          joinedAt: new Date(),
        },
      });
      await logger.log("WARN",
        `T4 created INVITED placeholder for gaia=${scrape.googleMemberId} ("${scrape.displayName}") — ` +
        `real email unknown. ${unlinked.length} unmatched candidates.`
      );
    }
  }
}
