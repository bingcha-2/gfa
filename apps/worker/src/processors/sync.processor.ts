/**
 * Sync family group processor.
 *
 * Reads the current member list from Google Family page and writes
 * the data back to FamilyMember / FamilyGroup tables.
 */

import { Job, UnrecoverableError } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { SyncFamilyGroupPayload } from "@gfa/shared";
import type { PostTaskSyncHints } from "../post-task-sync";

import { AdsPowerClient } from "../adspower-client";
import { BrowserPool } from "../browser-pool";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { gmailLogin } from "../gmail-login";
import { handleLoginResult } from "../handle-login-result";
import { ensureFamilyGroup } from "../ensure-family-group";
import { scrapeSubscriptionInfo } from "../scrape-subscription";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details?hl=en";

export interface SyncProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  pool: BrowserPool;
  workerId: string;
}

export interface ScrapedMember {
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
  let stopHeartbeat: (() => void) | null = null;

  try {
    // Cooldown guard: skip immediately if this account recently failed login
    if (!job.data.ignoreCooldown) {
      const cooldownSecs = await pool.isLoginCoolingDown(accountId);
      if (cooldownSecs > 0) {
        await logger.log("WARN", `[sync] Account ${accountId} in login cooldown (${cooldownSecs}s remaining), skipping`);
        await logger.updateStatus("FAILED_RETRYABLE", { code: "LOGIN_COOLDOWN", message: `Account in cooldown for ${cooldownSecs}s` });
        throw new Error(`LOGIN_COOLDOWN: ${cooldownSecs}s remaining`);
      }
    }

    // Acquire profile + open AdsPower browser (retries other profiles on failure)
    const acquired = await pool.acquireAndOpen(workerId, accountId, adspower);
    profileId = acquired.profileId;
    stopHeartbeat = pool.startHeartbeat(profileId, accountId, workerId);
    await logger.updateStatus("RUNNING");

    const page = await browser.connect(acquired.debugUrl);

    // Gmail auto-login
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      await handleLoginResult(loginResult, { job, pool, prisma, logger, accountId });
    }
    // Record which account is now logged into this profile
    await pool.setLastAccount(profileId!, accountId);

    // Ensure family group exists (also creates DB record if first run)
    const _syncT0 = Date.now();
    const _syncTs = () => `[${new Date().toISOString().slice(11, 23)}][+${Date.now() - _syncT0}ms]`;
    console.log(`${_syncTs()} [sync-flow] calling ensureFamilyGroup`);
    await ensureFamilyGroup(page, account, prisma, logger);
    console.log(`${_syncTs()} [sync-flow] ensureFamilyGroup done`);

    console.log(`${_syncTs()} [sync-flow] safeGoto family page`);
    await browser.safeGoto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`${_syncTs()} [sync-flow] safeGoto done`);
    await logger.log("INFO", "Navigated to Family page for sync");

    // Scrape current members from the page (visits each member detail page for real emails)
    const adminEmail = (account.loginEmail ?? "").trim().toLowerCase();
    const { members, availableSlots } = await scrapeMembersFromPage(page, adminEmail);
    await logger.log("INFO", `Found ${members.length} members on page`, { members });


    // Deduplicate, reconcile with DB, compute slots, and update FamilyGroup
    const { memberCount, availableSlots: finalSlots } =
      await dedupeAndUpdateGroupCounts(prisma, familyGroupId, members, availableSlots, logger);

    await logger.updateStatus("SUCCESS");
    await logger.log("INFO",
      `Sync complete: ${memberCount} non-admin members, ${finalSlots} slots available`);

    // If account was previously marked as unhealthy or risky, heal it since sync succeeded
    if (account.status !== "HEALTHY" || (account as any).syncError) {
      await prisma.account.update({
        where: { id: accountId },
        data: { status: "HEALTHY", syncError: null },
      });
      await logger.log("INFO", `Reset account status to HEALTHY and cleared syncError after successful sync`);
    }

    // Automatically restore any associated MANUAL_ONLY groups back to ACTIVE
    // since this successful sync proves the account is accessible again.
    const restoredGroups = await prisma.familyGroup.updateMany({
      where: { accountId, status: "MANUAL_ONLY" },
      data: { status: "ACTIVE" },
    });
    if (restoredGroups.count > 0) {
      await logger.log("INFO", `Auto-restored ${restoredGroups.count} family group(s) from MANUAL_ONLY to ACTIVE after successful sync`);
    }


    // Clear any accumulated failures or cooldowns
    await pool.clearAccountTaskFailures(accountId);
    await pool.clearLoginCooldown(accountId);

    // Non-fatal: update subscription info while we still have an active session
    try {
      const subInfo = await scrapeSubscriptionInfo(page);
      if (subInfo) {
        // Only update subscriptionStatusUpdatedAt when the status actually changes
        const currentAccount = await prisma.account.findUnique({
          where: { id: accountId },
          select: { subscriptionStatus: true },
        });
        const statusChanged = currentAccount?.subscriptionStatus !== subInfo.status;
        const isSuspended = subInfo.status === "SUSPENDED";

        await prisma.account.update({
          where: { id: accountId },
          data: {
            subscriptionExpiresAt: subInfo.expiresAt,
            subscriptionStatus: subInfo.status,
            subscriptionPlan: subInfo.planName,
            syncError: isSuspended ? "SUBSCRIPTION_SUSPENDED" : null,
            ...(statusChanged ? { subscriptionStatusUpdatedAt: new Date() } : {}),
          },
        });

        if (isSuspended) {
          await prisma.familyGroup.updateMany({
            where: { accountId },
            data: { status: "MANUAL_ONLY" }
          });
          await logger.log("WARN", `Subscription is SUSPENDED. Set account syncError and forced all family groups to MANUAL_ONLY`);
        }

        await logger.log("INFO", `Subscription refreshed: ${subInfo.status}${statusChanged ? " (status changed)" : ""}, plan: ${subInfo.planName ?? "unknown"}, expires: ${subInfo.expiresAt?.toISOString() ?? "unknown"}`);
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
    } catch {
      // noop
    }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "SYNC_ERROR" : "PROFILE_ACQUIRE_FAILED",
      message: errMsg,
    });

    throw error;
  } finally {
    stopHeartbeat?.();
    await browser.disconnect().catch(() => {});
    if (profileId) {
      await adspower.closeProfile(profileId).catch(() => {});
      await pool.release(profileId, workerId).catch(() => {});
    }
    await pool.releaseAccount(accountId, workerId).catch(() => {});
  }
}

/**
 * Scrape family member info from the Google Family page.
 * Visits each member's detail page to read the real email address,
 * since emails are not always shown on the list page.
 *
 * Returns { members, availableSlots }.
 */
export async function scrapeMembersFromPage(
  page: import("playwright").Page,
  adminEmail: string = ""
): Promise<{ members: ScrapedMember[]; availableSlots: number }> {
  const _t0 = Date.now();
  const _ts = () => `[${new Date().toISOString().slice(11, 23)}][+${Date.now() - _t0}ms]`;
  console.log(`${_ts()} [scrape] start: waitForLoadState(domcontentloaded)`);
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
  console.log(`${_ts()} [scrape] domcontentloaded done`);

  // Parse available slots from invite button text
  console.log(`${_ts()} [scrape] extracting invite link text`);
  const inviteLocator = page.locator('a[href*="invitemembers"]').first();
  const inviteLinkText = (await inviteLocator.count()) > 0
    ? await inviteLocator.textContent({ timeout: 3000 }).catch(() => "")
    : "";
  const slotMatch = inviteLinkText?.match(/(\d+)/);
  console.log(`${_ts()} [scrape] invite link text done: "${inviteLinkText?.slice(0, 40)}"`);

  // KEY INSIGHT: a[href*="family/member/"] IS the "Family member details" link.
  // The member's display name lives in SIBLING elements inside the parent card container,
  // NOT inside the <a> element itself.
  console.log(`${_ts()} [scrape] starting page.evaluate for card extraction`);
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

  console.log(`${_ts()} [scrape] page.evaluate done, card raw count: ${cardDebug.length}`);

  // Filter out Family Manager cards — detect by card text on list page
  const managerKw = ["family manager", "家庭群组管理员", "家庭群組管理員", "管理者"];
  const cardData = cardDebug.filter((c) => {
    const joined = c.leafTexts.join(" ").toLowerCase();
    return !managerKw.some((kw) => joined.includes(kw));
  }).map(({ href, displayName }) => ({ href, displayName }));

  const seenGaiaIds = new Set<string>();
  const uniqueCards: Array<{ href: string; displayName: string; gaiaId: string }> = [];
  for (const card of cardData) {
    if (!card.href) continue;

    // Extract gaiaId from href:
    //   /g/<id> = Google account (manager or accepted member)
    //   /member/i/<id> or /member/<id> = pending invite
    const gaiaId =
      card.href.match(/\/g\/([\d]+)/)?.[1] ??
      card.href.match(/\/member\/i\/([-\d]+)/)?.[1] ??
      card.href.match(/\/member\/([-\d]+)/)?.[1] ??
      card.href;
    if (!seenGaiaIds.has(gaiaId)) {
      seenGaiaIds.add(gaiaId);
      uniqueCards.push({ ...card, gaiaId });
    }
  }

  console.log(`${_ts()} [scrape] unique cards after dedup: ${uniqueCards.length}, starting detail page visits`);
  const members: ScrapedMember[] = [];
  const baseUrl = "https://myaccount.google.com/";

  for (const card of uniqueCards) {
    const detailUrl = card.href.startsWith("http")
      ? card.href
      : `${baseUrl}${card.href}`;

    try {
      console.log(`${_ts()} [scrape] visiting detail page ${uniqueCards.indexOf(card)+1}/${uniqueCards.length}: ${card.gaiaId}`);
      await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(200);

      // Read emails from leaf-node elements only to avoid concatenated parent text
      const rawEmails: string[] = await page.evaluate(() => {
        const leafEls = Array.from(document.querySelectorAll("*"))
          .filter((el) => el.children.length === 0); // leaf nodes only
        const texts = leafEls
          .map((el) => el.textContent?.trim() ?? "")
          .filter((t) => t.includes("@") && t.includes("."));
        // Strict ASCII-only email regex to reject concatenated name+email+role strings
        return texts.filter((t) => /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(t));
      });

      // If the ONLY email on the page is the admin's AND this is a /g/ card (Google account page),
      // this is the manager's own card → skip entirely.
      // For /member/i/ cards (pending invites) showing admin email, keep as gaiaOnly.
      const nonAdminEmails = rawEmails.filter((e) => e.toLowerCase() !== adminEmail);
      const isGoogleAccountCard = /\/g\/\d+/.test(card.href);
      if (rawEmails.length > 0 && nonAdminEmails.length === 0 && isGoogleAccountCard) {
        // Manager detail page — only admin email found on /g/ card, skip entirely
        continue;
      }

      // Use the first non-admin email as the member's email (empty → becomes gaiaOnly)
      const email = nonAdminEmails[0]?.trim().toLowerCase() ?? "";

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
          email,
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
    await page.goto("https://myaccount.google.com/family/details?hl=en", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }).catch(() => {});
    await page.waitForTimeout(200);
  }

  // members array already excludes the Family Manager, so capacity is 5 (not 6)
  const finalSlots = slotMatch ? parseInt(slotMatch[1], 10) : Math.max(0, 5 - members.length);
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
export async function reconcileMembers(
  prisma: PrismaClient,
  familyGroupId: string,
  scrapedMembers: ScrapedMember[],
  logger: TaskLogger,
  hints?: PostTaskSyncHints
): Promise<void> {
  const emailMembers = scrapedMembers.filter((m) => !!m.email);
  const gaiaOnlyMembers = scrapedMembers.filter((m) => !m.email && !!m.googleMemberId);

  if (emailMembers.length === 0 && gaiaOnlyMembers.length === 0) {
    // Zero members scraped — mark all existing ACTIVE/PENDING members as REMOVED
    // so DB stays consistent with the actual Google family group state.
    const staleMembers = await prisma.familyMember.findMany({
      where: { familyGroupId, status: { in: ["ACTIVE", "PENDING"] } },
      select: { id: true, email: true },
    });
    if (staleMembers.length > 0) {
      await prisma.familyMember.updateMany({
        where: { familyGroupId, status: { in: ["ACTIVE", "PENDING"] } },
        data: { status: "REMOVED", removedAt: new Date() },
      });
      const emails = staleMembers.map((m) => m.email).join(", ");
      await logger.log("INFO",
        `Marked ${staleMembers.length} member(s) as REMOVED (0 members on page): ${emails}`);
    } else {
      await logger.log("INFO", "No members scraped and no active members in DB — nothing to reconcile");
    }
    return;
  }

  const existing = await prisma.familyMember.findMany({ where: { familyGroupId } });
  const scrapedEmails = new Set(emailMembers.map((m) => m.email));

  // Track which DB member IDs were claimed by gaiaOnly linking (Step 2)
  const claimedIds = new Set<string>();

  // --- Step 1: Upsert email members ---
  for (const scraped of emailMembers) {
    const newStatus = scraped.isPending ? "PENDING" : "ACTIVE";

    // Check previous status BEFORE upsert to detect PENDING → ACTIVE transitions
    const previousRecord = await prisma.familyMember.findUnique({
      where: { familyGroupId_email: { familyGroupId, email: scraped.email } },
      select: { status: true },
    });

    await prisma.familyMember.upsert({
      where: { familyGroupId_email: { familyGroupId, email: scraped.email } },
      update: {
        displayName: scraped.displayName || undefined,
        role: scraped.role,
        status: newStatus,
        // Fix #2: Only overwrite googleMemberId if scraped value is valid.
        // Prevents a failed scrape from clearing a previously correct GAIA ID.
        ...(scraped.googleMemberId ? { googleMemberId: scraped.googleMemberId } : {}),
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

    // Sync Order status: when member transitions to ACTIVE (accepted invite),
    // update the corresponding Order from INVITE_SENT → COMPLETED.
    // Uses case-insensitive email match to handle legacy mixed-case records.
    if (newStatus === "ACTIVE" && (!previousRecord || previousRecord.status !== "ACTIVE")) {
      const updatedOrders = await prisma.order.updateMany({
        where: {
          familyGroupId,
          userEmail: scraped.email,
          status: { in: ["INVITE_SENT", "WAIT_USER_ACCEPT", "TASK_QUEUED"] },
        },
        data: {
          status: "COMPLETED",
          resultMessage: "Member accepted invite (detected by sync)",
        },
      });
      // Case-insensitive fallback
      if (updatedOrders.count === 0) {
        await prisma.$executeRawUnsafe(
          `UPDATE "Order" SET status = 'COMPLETED', resultMessage = 'Member accepted invite (detected by sync)', updatedAt = datetime('now')
           WHERE familyGroupId = ? AND LOWER(userEmail) = LOWER(?) AND status IN ('INVITE_SENT','WAIT_USER_ACCEPT','TASK_QUEUED')`,
          familyGroupId, scraped.email
        ).catch(() => {});
      }
      if (updatedOrders.count > 0) {
        await logger.log("INFO", `Order status synced to COMPLETED for ${scraped.email} (${updatedOrders.count} order(s))`);
      }
    }

    // Cleanup: if this member has a gaiaId, delete any OTHER records in the same group
    // with the same gaiaId but a DIFFERENT email (fixes previously scraped corrupted emails
    // like "송지연user@gmail.com구성원" that were stored due to textContent concatenation)
    if (scraped.googleMemberId) {
      const dupes = await prisma.familyMember.findMany({
        where: {
          familyGroupId,
          googleMemberId: scraped.googleMemberId,
          email: { not: scraped.email },
        },
        select: { id: true, email: true },
      });
      for (const dupe of dupes) {
        await prisma.familyMember.delete({ where: { id: dupe.id } });
        await logger.log("INFO", `Deleted duplicate member record: ${dupe.email} (same gaiaId=${scraped.googleMemberId})`);
      }
    }
  }

  // --- Step 2: Link gaiaOnly members to existing DB records ---
  // These are members whose email Google hides (e.g. accepted invite shows display name only).
  // Also match REMOVED records — they may have been re-invited.

  // --- Tier 0: Context-aware match (justInvitedEmail) ---
  // When a processor just invited someone and we know their email, but the page
  // shows them as gaiaOnly (pending invite, email hidden by Google), we can
  // directly link the gaiaOnly member to the known email record.
  if (hints?.justInvitedEmail && !scrapedEmails.has(hints.justInvitedEmail)) {
    const invitedRecord = await prisma.familyMember.findUnique({
      where: { familyGroupId_email: { familyGroupId, email: hints.justInvitedEmail } },
    });
    if (invitedRecord && !claimedIds.has(invitedRecord.id)) {
      // Find pending gaiaOnly members that aren't yet claimed
      const unclaimedPendingGaia = gaiaOnlyMembers.filter(
        (m) => m.isPending && !claimedIds.has(m.googleMemberId)
      );
      if (unclaimedPendingGaia.length === 1) {
        const scrape = unclaimedPendingGaia[0];
        await prisma.familyMember.update({
          where: { id: invitedRecord.id },
          data: {
            googleMemberId: scrape.googleMemberId,
            status: "PENDING",
            displayName: scrape.displayName || invitedRecord.displayName || undefined,
          },
        });
        claimedIds.add(invitedRecord.id);
        // Remove from gaiaOnlyMembers so T1-T4 don't process it again
        const idx = gaiaOnlyMembers.indexOf(scrape);
        if (idx >= 0) gaiaOnlyMembers.splice(idx, 1);
        await logger.log("INFO",
          `T0 context-match: gaia=${scrape.googleMemberId} → ${hints.justInvitedEmail} (just invited, pending)`);
      } else if (unclaimedPendingGaia.length > 1) {
        await logger.log("INFO",
          `T0: ${unclaimedPendingGaia.length} pending gaiaOnly members — cannot disambiguate, falling to T1+`);
      }
    }
  }

  for (const scrape of gaiaOnlyMembers) {
    const newStatus = scrape.isPending ? "PENDING" : "ACTIVE";
    await logger.log("INFO", `Linking gaiaOnly member: gaia=${scrape.googleMemberId}, name="${scrape.displayName}", pending=${scrape.isPending}`);

    // Tier 1: Already linked by gaiaId in a previous sync
    const byGaia = await prisma.familyMember.findFirst({
      where: { familyGroupId, googleMemberId: scrape.googleMemberId },
    });
    if (byGaia) {
      // T1-fix: If matched record is a placeholder (@gaia.unknown), try to find the
      // REAL member record that should own this GAIA ID and merge into it instead.
      // This resolves the "split identity" problem where a real email record and a
      // placeholder record point to the same person.
      const isPlaceholder = byGaia.email.endsWith("@gaia.unknown");
      if (isPlaceholder) {
        // Look for a single real-email member that has no gaiaId and wasn't matched by scraping
        const realCandidates = existing.filter(
          (m) =>
            !m.email.endsWith("@gaia.unknown") &&
            !m.googleMemberId &&
            !scrapedEmails.has(m.email) &&
            !claimedIds.has(m.id) &&
            m.status !== "REMOVED"
        );
        if (realCandidates.length === 1) {
          // Found exactly one real candidate — transfer GAIA ID from placeholder to real record
          const realMember = realCandidates[0];
          await prisma.familyMember.update({
            where: { id: realMember.id },
            data: {
              googleMemberId: scrape.googleMemberId,
              status: newStatus,
              displayName: scrape.displayName || realMember.displayName || undefined,
            },
          });
          // Delete the placeholder record — it's now merged
          await prisma.familyMember.delete({ where: { id: byGaia.id } }).catch(() => {});
          claimedIds.add(realMember.id);
          await logger.log("INFO",
            `T1-merge: gaia=${scrape.googleMemberId} transferred from placeholder ${byGaia.email} → real member ${realMember.email} (status=${newStatus})`);
          continue;
        }
        // Multiple or zero real candidates — keep updating the placeholder as before
        await logger.log("INFO",
          `T1: gaia=${scrape.googleMemberId} matched placeholder ${byGaia.email}, ${realCandidates.length} real candidate(s) — keeping placeholder`);
      }
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

    // Tier 3: Elimination — prioritize REAL email members over placeholders.
    // Split unlinked candidates into real-email vs placeholder pools.
    const allUnlinked = existing.filter(
      (m) =>
        !m.googleMemberId &&
        !scrapedEmails.has(m.email) &&
        !claimedIds.has(m.id)
    );
    // T3: Prefer real-email candidates (not @gaia.unknown)
    const realUnlinked = allUnlinked.filter((m) => !m.email.endsWith("@gaia.unknown"));

    if (realUnlinked.length === 1) {
      // Single real-email candidate — high confidence merge
      const candidate = realUnlinked[0];
      const nameMatches = !scrape.displayName || !candidate.displayName ||
        scrape.displayName === candidate.displayName;

      if (nameMatches) {
        await prisma.familyMember.update({
          where: { id: candidate.id },
          data: {
            googleMemberId: scrape.googleMemberId,
            status: newStatus,
            displayName: scrape.displayName || candidate.displayName || undefined,
          },
        });
        claimedIds.add(candidate.id);
        await logger.log("INFO", `T3 linked: gaia=${scrape.googleMemberId} → ${candidate.email} by elimination (${realUnlinked.length} real, ${allUnlinked.length} total unlinked, status=${newStatus})`);
        continue;
      } else {
        await logger.log("WARN",
          `T3 skipped: sole real candidate ${candidate.email} displayName="${candidate.displayName}" ` +
          `vs scraped="${scrape.displayName}" — mismatch`
        );
      }
    } else if (realUnlinked.length > 1) {
      await logger.log("INFO",
        `T3: ${realUnlinked.length} real unlinked candidates — cannot disambiguate, trying T3b`);
    }

    // T3b: Among multiple real candidates, try displayName match
    if (realUnlinked.length > 1 && scrape.displayName) {
      const byNameInUnlinked = realUnlinked.filter(
        (m) => m.displayName && m.displayName === scrape.displayName
      );
      if (byNameInUnlinked.length === 1) {
        const candidate = byNameInUnlinked[0];
        await prisma.familyMember.update({
          where: { id: candidate.id },
          data: {
            googleMemberId: scrape.googleMemberId,
            status: newStatus,
          },
        });
        claimedIds.add(candidate.id);
        await logger.log("INFO", `T3b linked: gaia=${scrape.googleMemberId} → ${candidate.email} via displayName among ${realUnlinked.length} candidates (status=${newStatus})`);
        continue;
      }
    }

    // Tier 4 (last resort): create placeholder — but only if no real candidate exists
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
      `real email unknown. ${realUnlinked.length} real / ${allUnlinked.length} total unmatched.`
    );
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

const NON_ADMIN_CAPACITY = 5;

/**
 * Shared helper: deduplicate scraped members, reconcile with DB,
 * compute slot counts, and update the FamilyGroup record.
 *
 * Used by: processSync, postTaskSync, and remove.processor inline sync.
 * Centralised here so slot-calculation logic stays in one place.
 */
export async function dedupeAndUpdateGroupCounts(
  prisma: PrismaClient,
  familyGroupId: string,
  members: ScrapedMember[],       // raw scraped (may contain duplicates)
  pageSlots: number,              // availableSlots from scrapeMembersFromPage
  logger: TaskLogger,
  opts?: { skipReconcile?: boolean; hints?: PostTaskSyncHints }
): Promise<{ memberCount: number; availableSlots: number }> {
  // --- Deduplicate by email ---
  const seenEmails = new Set<string>();
  const dedupedMembers = members.filter((m) => {
    const key = m.email?.toLowerCase();
    if (!key) return true; // gaiaOnly members always kept
    if (seenEmails.has(key)) return false;
    seenEmails.add(key);
    return true;
  });

  if (dedupedMembers.length < members.length) {
    await logger.log("WARN",
      `Deduped ${members.length - dedupedMembers.length} duplicate email(s) (${members.length} → ${dedupedMembers.length})`);
  }

  // --- Reconcile with DB ---
  if (!opts?.skipReconcile) {
    await reconcileMembers(prisma, familyGroupId, dedupedMembers, logger, opts?.hints);
  }

  // --- Compute slot counts ---
  // Use RAW (non-deduped) count for slots because Google counts duplicate
  // invitations as separate occupied slots.
  const rawNonAdmin = members.filter(
    (m) => !m.role.toLowerCase().includes("manager")
  );
  const dedupedNonAdmin = dedupedMembers.filter(
    (m) => !m.role.toLowerCase().includes("manager")
  );
  const computedSlots = Math.max(0, NON_ADMIN_CAPACITY - rawNonAdmin.length);

  // Diagnostic: log divergence between Google invite link and computed value.
  // We trust computedSlots (derived from actual member count) because
  // Google's invite link text can be stale/cached. Over-invite risk is
  // safely caught at execution time by invite processor's FAMILY_FULL detection.
  if (pageSlots !== computedSlots) {
    await logger.log("WARN",
      `Slot divergence: page says ${pageSlots}, computed=${computedSlots} (using computed)`);
  }

  // --- Update DB ---
  await prisma.familyGroup.update({
    where: { id: familyGroupId },
    data: {
      memberCount: dedupedNonAdmin.length,
      availableSlots: computedSlots,
      lastSyncedAt: new Date(),
    },
  });

  await logger.log("INFO",
    `Group counts updated: ${dedupedNonAdmin.length} members, ${computedSlots} slots available`);

  return { memberCount: dedupedNonAdmin.length, availableSlots: computedSlots };
}
