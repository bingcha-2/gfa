/**
 * Sync family group processor.
 *
 * Reads the current member list from Google Family page and writes
 * the data back to FamilyMember / FamilyGroup tables.
 */

import { Job, UnrecoverableError } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { SyncFamilyGroupPayload } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { BrowserPool } from "../browser-pool";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { gmailLogin } from "../gmail-login";
import { ensureFamilyGroup } from "../ensure-family-group";
import { scrapeSubscriptionInfo } from "../scrape-subscription";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details";

export interface SyncProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  pool: BrowserPool;
  workerId: string;
}

interface ScrapedMember {
  email: string;
  displayName: string;
  role: string;
  googleMemberId: string; // GAIA ID from href="/family/member/g/{id}"
  isPending: boolean;     // true = invite sent but not yet accepted
}

export async function processSync(
  job: Job<SyncFamilyGroupPayload>,
  deps: SyncProcessorDeps
): Promise<void> {
  const { prisma, adspower, pool, workerId } = deps;
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

  let profileId: string | null = null;

  try {
    profileId = await pool.acquire(workerId);
    await logger.updateStatus("RUNNING");

    const { debugUrl } = await adspower.openProfile(profileId);
    const page = await browser.connect(debugUrl);

    // Gmail auto-login (required every time — browser clears cache on start)
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      // TRANSIENT failures (e.g. password page didn't load) → let BullMQ retry
      if (loginResult.reason === "TRANSIENT") {
        throw new Error(`Login transient failure: ${loginResult.detail}`);
      }
      // VERIFICATION_REQUIRED or UNKNOWN → needs human intervention
      await prisma.account.update({ where: { id: accountId }, data: { status: "VERIFICATION_REQUIRED" } });
      await logger.updateStatus("MANUAL_REVIEW", { code: loginResult.reason, message: loginResult.detail });
      throw new UnrecoverableError("MANUAL_REVIEW");
    }

    // Ensure family group exists (also creates DB record if first run)
    await ensureFamilyGroup(page, account, prisma, logger);

    await browser.safeGoto(GOOGLE_FAMILY_URL, { waitUntil: "load", timeout: 60_000 });
    await logger.log("INFO", "Navigated to Family page for sync");

    // Scrape current members from the page (visits each member detail page for real emails)
    const { members, availableSlots } = await scrapeMembersFromPage(page);
    await logger.log("INFO", `Found ${members.length} members on page`, { members });

    const afterPath = await browser.takeScreenshot(taskId, "sync");
    await logger.recordScreenshot("afterScreenshotPath", afterPath);

    // Reconcile with database
    await reconcileMembers(prisma, familyGroupId, members, logger);

    // Update group counts.
    // Google family groups: 1 manager (admin) + up to 5 non-admin members = 6 total.
    // We only count non-admin members against the slot limit.
    const nonAdminMembers = members.filter(
      (m) => !m.role.toLowerCase().includes("manager")
    );
    const NON_ADMIN_CAPACITY = 5; // Google always allows 5 non-admin seats

    // Prefer the slot count scraped from Google's invite button (most accurate);
    // fall back to computing from non-admin member count.
    const computedSlots = Math.max(0, NON_ADMIN_CAPACITY - nonAdminMembers.length);
    const finalAvailableSlots = Math.min(availableSlots, computedSlots);

    await prisma.familyGroup.update({
      where: { id: familyGroupId },
      data: {
        memberCount: nonAdminMembers.length,
        availableSlots: finalAvailableSlots,
        lastSyncedAt: new Date(),
      },
    });

    await logger.updateStatus("SUCCESS");
    await logger.log(
      "INFO",
      `Sync complete: ${nonAdminMembers.length} non-admin members (${members.length} total incl. manager), ${finalAvailableSlots} slots available`
    );

    // Non-fatal: update subscription info while we still have an active session
    try {
      const subInfo = await scrapeSubscriptionInfo(page);
      if (subInfo) {
        await prisma.account.update({
          where: { id: accountId },
          data: {
            subscriptionExpiresAt: subInfo.expiresAt,
            subscriptionStatus: subInfo.status,
          },
        });
        await logger.log("INFO", `Subscription refreshed: ${subInfo.status}, expires: ${subInfo.expiresAt?.toISOString() ?? "unknown"}`);
      }
    } catch {
      // Fully silent: even the WARN log failing must not bubble to the outer catch
      await logger.log("WARN", "Subscription refresh failed during sync — skipping").catch(() => {});
    }
  } catch (error) {
    // Don't overwrite MANUAL_REVIEW status if login challenge was detected
    if (error instanceof UnrecoverableError) throw error;

    const errMsg = error instanceof Error ? error.message : String(error);

    try {
      const errPath = await browser.takeScreenshot(taskId, "error");
      await logger.recordScreenshot("errorScreenshotPath", errPath);
    } catch {
      // noop
    }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "SYNC_ERROR" : "PROFILE_ACQUIRE_FAILED",
      message: errMsg,
    });

    throw error;
  } finally {
    await browser.disconnect().catch(() => {});
    if (profileId) {
      await adspower.closeProfile(profileId).catch(() => {});
      await pool.release(profileId, workerId).catch(() => {});
    }
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
  await page.waitForLoadState("load", { timeout: 60000 });

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

  console.debug("[sync] card raw count:", cardDebug.length);
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
      await page.goto(detailUrl, { waitUntil: "load", timeout: 60000 });
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

      // Detect pending invite: Google shows cancel/revoke button instead of remove button.
      // Check all button texts on the page for cancel-invite indicators.
      const isPending = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a"))
          .map((el) => el.textContent?.trim() ?? "");
        const cancelKw = ["取消邀請", "取消邀请", "撤銷", "撤销", "Cancel invitation", "Revoke"];
        return btns.some((t) => cancelKw.some((kw) => t.includes(kw)));
      });

      if (email || card.gaiaId) {
        members.push({
          // Normalize to lowercase for consistent lookup (Google pages may show mixed case)
          email: email ? email.trim().toLowerCase() : "",
          displayName: card.displayName,
          role,
          googleMemberId: card.gaiaId,
          isPending,
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
          isPending: false,
        });
      }
    }

    // Navigate back to family list
    await page.goto("https://myaccount.google.com/family/details", {
      waitUntil: "load",
      timeout: 60000,
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

  // Track which DB member IDs were claimed by gaiaOnly linking (Step 2)
  const claimedIds = new Set<string>();

  // --- Step 1: Upsert email members ---
  for (const scraped of emailMembers) {
    const newStatus = scraped.isPending ? "PENDING" : "ACTIVE";
    await prisma.familyMember.upsert({
      where: { familyGroupId_email: { familyGroupId, email: scraped.email } },
      update: {
        displayName: scraped.displayName || undefined,
        role: scraped.role,
        status: newStatus,
        googleMemberId: scraped.googleMemberId || undefined,
        ...(newStatus === "ACTIVE" ? { joinedAt: new Date() } : {}),
      },
      create: {
        familyGroupId,
        email: scraped.email,
        displayName: scraped.displayName || undefined,
        role: scraped.role,
        status: newStatus,
        googleMemberId: scraped.googleMemberId || undefined,
        joinedAt: newStatus === "ACTIVE" ? new Date() : undefined,
      },
    });
    await logger.log("INFO",
      `Upserted member: ${scraped.email} status=${newStatus} (gaia=${scraped.googleMemberId || "unknown"})`);
  }

  // --- Step 2: Link gaiaOnly members to existing DB records ---
  // These are members whose email Google hides (e.g. accepted invite shows display name only).
  // Also match REMOVED records — they may have been re-invited.
  for (const scrape of gaiaOnlyMembers) {
    const newStatus = scrape.isPending ? "PENDING" : "ACTIVE";
    await logger.log("INFO", `Linking gaiaOnly member: gaia=${scrape.googleMemberId}, name="${scrape.displayName}", pending=${scrape.isPending}`);

    // Tier 1: Already linked by gaiaId in a previous sync
    const byGaia = await prisma.familyMember.findFirst({
      where: { familyGroupId, googleMemberId: scrape.googleMemberId },
    });
    if (byGaia) {
      await prisma.familyMember.update({
        where: { id: byGaia.id },
        data: {
          status: newStatus,
          displayName: scrape.displayName || byGaia.displayName || undefined,
        },
      });
      claimedIds.add(byGaia.id);
      await logger.log("INFO", `T1 linked: gaia=${scrape.googleMemberId} → ${byGaia.email} (status=${newStatus})`);
      continue;
    }

    // Tier 2: Match by displayName (include REMOVED records — may be re-invited)
    if (scrape.displayName) {
      const byName = await prisma.familyMember.findFirst({
        where: { familyGroupId, displayName: scrape.displayName },
      });
      if (byName) {
        await prisma.familyMember.update({
          where: { id: byName.id },
          data: {
            googleMemberId: scrape.googleMemberId,
            status: newStatus,
          },
        });
        claimedIds.add(byName.id);
        await logger.log("INFO", `T2 linked: gaia=${scrape.googleMemberId} → ${byName.email} via displayName (status=${newStatus})`);
        continue;
      }
    }

    // Tier 3: Elimination — single unlinked non-scraped member (any status except already-claimed)
    const unlinked = existing.filter(
      (m) =>
        !m.googleMemberId &&
        !scrapedEmails.has(m.email) &&
        !claimedIds.has(m.id)
    );
    if (unlinked.length === 1) {
      await prisma.familyMember.update({
        where: { id: unlinked[0].id },
        data: {
          googleMemberId: scrape.googleMemberId,
          status: newStatus,
          displayName: scrape.displayName || unlinked[0].displayName || undefined,
        },
      });
      claimedIds.add(unlinked[0].id);
      await logger.log("INFO", `T3 linked: gaia=${scrape.googleMemberId} → ${unlinked[0].email} by elimination (status=${newStatus})`);
    } else {
      // Tier 4: No match found — create placeholder
      const placeholder = `pending-${scrape.googleMemberId}@gaia.unknown`;
      await prisma.familyMember.upsert({
        where: { familyGroupId_email: { familyGroupId, email: placeholder } },
        update: {
          displayName: scrape.displayName || undefined,
          googleMemberId: scrape.googleMemberId,
          status: newStatus,
        },
        create: {
          familyGroupId,
          email: placeholder,
          displayName: scrape.displayName || undefined,
          googleMemberId: scrape.googleMemberId,
          role: scrape.role ?? "member",
          status: newStatus,
          joinedAt: new Date(),
        },
      });
      await logger.log("WARN",
        `T4 created placeholder for gaia=${scrape.googleMemberId} ("${scrape.displayName}") — ` +
        `real email unknown. ${unlinked.length} unmatched candidates.`
      );
    }
  }

  // --- Step 3: Mark stale members as REMOVED ---
  // After gaiaOnly linking is complete, check which DB members are NOT represented
  // on the scraped page. A member is stale if:
  //   (a) its email is NOT in scrapedEmails (not an email-visible member)
  //   (b) it was NOT claimed by gaiaOnly linking (not a gaia-linked member)
  //   (c) its gaiaId is NOT in the scraped gaiaOnly set (not already matched by gaia)
  //   (d) its status is ACTIVE or PENDING (not already REMOVED)
  const scrapedGaiaIds = new Set(scrapedMembers.filter((m) => m.googleMemberId).map((m) => m.googleMemberId));

  for (const member of existing) {
    if (member.status === "REMOVED") continue;
    if (scrapedEmails.has(member.email)) continue;
    if (claimedIds.has(member.id)) continue;
    if (member.googleMemberId && scrapedGaiaIds.has(member.googleMemberId)) continue;

    await prisma.familyMember.update({
      where: { id: member.id },
      data: { status: "REMOVED", removedAt: new Date() },
    });
    await logger.log("INFO", `Marked ${member.email} as REMOVED (not on page, not linked by gaia)`);
  }
}
