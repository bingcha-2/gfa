/**
 * Agent Pool Processor — handles agent-replace and agent-migrate compound tasks.
 *
 * agent-replace flow:
 *   1. Login as mother → remove old child from family group
 *   2. Mother invites new child
 *   3. Login as new child → accept invite
 *   4. DB: old child → banned, new child → uploaded to same pool
 *
 * agent-migrate flow:
 *   1. Login as old mother → remove child from family group
 *   2. Login as new mother → invite child
 *   3. Login as child → accept invite
 *   4. DB: update child's motherAccountId/motherGroupId
 */

import { Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { QUEUE_NAMES, JOB_DEFAULTS } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { BrowserPool } from "../browser-pool";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { gmailLogin, type LoginCredentials } from "../gmail-login";
import { handleAcceptInvite } from "./automation.processor";
import { executeInviteOnPage } from "./invite.processor";

const GOOGLE_FAMILY_URL = "https://myaccount.google.com/family/details?hl=en";
const FAMILY_INVITE_URL = "https://myaccount.google.com/family/addmember?hl=en";

export interface AgentPoolProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  pool: BrowserPool;
  workerId: string;
}

// ============================================================
// Shared helpers
// ============================================================

/**
 * Login to a Google account, navigate to family page, and return the page.
 * Handles full profile lifecycle (acquire, connect, login).
 */
async function loginAndGetPage(
  credentials: { email: string; password: string; totpSecret?: string },
  deps: AgentPoolProcessorDeps,
  logger: TaskLogger,
  label: string
): Promise<{
  page: import("playwright").Page;
  browser: WorkerBrowser;
  profileId: string;
  stopHeartbeat: () => void;
}> {
  const { adspower, pool, workerId } = deps;
  const browser = new WorkerBrowser();

  const accountLockKey = `email:${credentials.email.toLowerCase()}`;
  const acquired = await pool.acquireAndOpen(workerId, accountLockKey, adspower);
  const stopHeartbeat = pool.startHeartbeat(acquired.profileId, accountLockKey, workerId);

  await logger.log("INFO", `[${label}] Acquired profile ${acquired.profileId} for ${credentials.email}`);
  const page = await browser.connect(acquired.debugUrl);

  const loginCreds: LoginCredentials = {
    loginEmail: credentials.email,
    loginPassword: credentials.password,
    totpSecret: credentials.totpSecret,
  };

  await logger.log("INFO", `[${label}] Logging in as ${credentials.email}...`);
  const loginResult = await gmailLogin(page, loginCreds, logger);
  if (!loginResult.success) {
    throw new Error(`[${label}] Login failed for ${credentials.email}: ${loginResult.reason} — ${loginResult.detail}`);
  }
  await logger.log("INFO", `[${label}] Login successful for ${credentials.email}`);

  return { page, browser, profileId: acquired.profileId, stopHeartbeat };
}

type RosettaFamilyJoinPayload = {
  taskId?: string;
  action: "family-join";
  credentials: { email: string; password: string; recoveryEmail?: string; totpSecret?: string };
  childCredentials?: { email: string; password: string; recoveryEmail?: string; totpSecret?: string };
};

export async function processRosettaFamilyJoin(
  job: Job<RosettaFamilyJoinPayload>,
  deps: AgentPoolProcessorDeps
): Promise<void> {
  const { prisma, workerId } = deps;
  const taskId = job.data.taskId ?? job.id ?? job.name;
  if (!taskId) return;

  const logger = new TaskLogger(prisma, taskId, workerId);
  const motherCredentials = job.data.credentials;
  const childCredentials = job.data.childCredentials;

  if (!motherCredentials?.email || !motherCredentials.password) {
    await logger.updateStatus("FAILED_FINAL", {
      code: "MISSING_MOTHER_CREDENTIALS",
      message: "Mother account credentials are required for family join",
    });
    return;
  }
  if (!childCredentials?.email || !childCredentials.password) {
    await logger.updateStatus("FAILED_FINAL", {
      code: "MISSING_CHILD_CREDENTIALS",
      message: "Child account credentials are required for family join",
    });
    return;
  }

  let motherSession: Awaited<ReturnType<typeof loginAndGetPage>> | null = null;
  let childSession: Awaited<ReturnType<typeof loginAndGetPage>> | null = null;

  try {
    await logger.updateStatus("RUNNING");
    await logger.log("INFO", `[family-join] Mother ${motherCredentials.email} will invite ${childCredentials.email}`);

    motherSession = await loginAndGetPage(motherCredentials, deps, logger, "family-join-mother");
    await executeInviteOnPage(motherSession.page, childCredentials.email, logger);
    await releaseSession(deps, motherSession.browser, motherSession.profileId, motherSession.stopHeartbeat, motherCredentials.email);
    motherSession = null;

    await logger.log("INFO", `[family-join] Invite sent, logging in child ${childCredentials.email} to accept`);
    childSession = await loginAndGetPage(childCredentials, deps, logger, "family-join-child");
    const accepted = await handleAcceptInvite(childSession.page, {
      loginEmail: childCredentials.email,
      loginPassword: childCredentials.password,
      totpSecret: childCredentials.totpSecret,
    }, logger);

    if (!accepted) {
      await logger.updateStatus("FAILED_RETRYABLE", {
        code: "ACCEPT_INVITE_FAILED",
        message: `Child ${childCredentials.email} did not accept the family invitation`,
      });
      throw new Error(`Child ${childCredentials.email} did not accept the family invitation`);
    }

    await prisma.task.update({
      where: { id: taskId },
      data: {
        payload: JSON.stringify({
          action: "family-join",
          email: motherCredentials.email,
          childEmail: childCredentials.email,
          result: { accepted: true, motherEmail: motherCredentials.email, childEmail: childCredentials.email },
        }),
      },
    });
    await logger.updateStatus("SUCCESS");
    await logger.log("INFO", `[family-join] ${childCredentials.email} joined ${motherCredentials.email}'s family`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.updateStatus("FAILED_RETRYABLE", {
      code: "FAMILY_JOIN_FAILED",
      message,
    });
    throw error;
  } finally {
    if (motherSession) {
      await releaseSession(deps, motherSession.browser, motherSession.profileId, motherSession.stopHeartbeat, motherCredentials.email);
    }
    if (childSession) {
      await releaseSession(deps, childSession.browser, childSession.profileId, childSession.stopHeartbeat, childCredentials.email);
    }
  }
}

/**
 * Release a browser session (profile + heartbeat + disconnect).
 */
async function releaseSession(
  deps: AgentPoolProcessorDeps,
  browser: WorkerBrowser,
  profileId: string,
  stopHeartbeat: (() => void) | null,
  accountEmail: string
) {
  const { adspower, pool, workerId } = deps;
  stopHeartbeat?.();
  await browser.disconnect().catch(() => { });
  await adspower.closeProfile(profileId).catch(() => { });
  await pool.release(profileId, workerId).catch(() => { });
  await pool.releaseAccount(`email:${accountEmail.toLowerCase()}`, workerId).catch(() => { });
}

/**
 * Navigate to Google Family page and remove a member by email.
 */
async function removeMemberFromFamily(
  page: import("playwright").Page,
  memberEmail: string,
  logger: TaskLogger,
  label: string
): Promise<void> {
  await logger.log("INFO", `[${label}] Navigating to family page...`);
  await page.goto(GOOGLE_FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // Find and click the member card
  const memberCards = await page.$$("[data-member-email], [data-email]");
  let found = false;

  // Try to find by email in data attributes or text content
  for (const card of memberCards) {
    const text = await card.textContent().catch(() => "");
    const email = await card.getAttribute("data-member-email") ?? await card.getAttribute("data-email") ?? "";
    if (email.toLowerCase() === memberEmail.toLowerCase() || text?.toLowerCase().includes(memberEmail.toLowerCase())) {
      await card.click();
      found = true;
      break;
    }
  }

  // Fallback: try finding by searching all visible text
  if (!found) {
    const allLinks = await page.$$("a, [role='link'], [role='listitem']");
    for (const link of allLinks) {
      const text = await link.textContent().catch(() => "");
      if (text?.toLowerCase().includes(memberEmail.toLowerCase())) {
        await link.click();
        found = true;
        break;
      }
    }
  }

  if (!found) {
    // Try direct navigation to member removal
    await logger.log("WARN", `[${label}] Could not find member card for ${memberEmail}, trying direct remove flow...`);
    // Navigate to family details which may show members differently
    await page.goto(`https://myaccount.google.com/family/details?hl=en`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
  }

  // Wait for member detail page / remove button
  await page.waitForTimeout(2000);

  // Look for remove button
  const removeSelector = [
    "button:has-text('Remove member')",
    "button:has-text('Remove')",
    "[aria-label*='Remove']",
    "[aria-label*='remove']",
  ];

  let clicked = false;
  for (const sel of removeSelector) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click();
      clicked = true;
      await logger.log("INFO", `[${label}] Clicked remove button for ${memberEmail}`);
      break;
    }
  }

  if (!clicked) {
    throw new Error(`[${label}] Could not find remove button for ${memberEmail}`);
  }

  // Confirm removal dialog
  await page.waitForTimeout(2000);
  const confirmSelectors = [
    "button:has-text('Remove')",
    "button:has-text('Confirm')",
    "button:has-text('Yes')",
    "[data-mdc-dialog-action='ok']",
    "[data-mdc-dialog-action='accept']",
  ];

  for (const sel of confirmSelectors) {
    const btn = await page.$(sel);
    if (btn && await btn.isVisible()) {
      await btn.click();
      await logger.log("INFO", `[${label}] Confirmed removal of ${memberEmail}`);
      break;
    }
  }

  await page.waitForTimeout(3000);
  await logger.log("INFO", `[${label}] Member ${memberEmail} removal completed`);
}

/**
 * Navigate to Google Family invite page and invite a new member.几个号池列表也要支持分页，不能一次性加载，另外我让你删除号码池模块，不是手机号池模块，就是包含批量上号、已上号账号的号码池
 */
async function inviteMemberToFamily(
  page: import("playwright").Page,
  newEmail: string,
  logger: TaskLogger,
  label: string
): Promise<void> {
  await logger.log("INFO", `[${label}] Navigating to invite page...`);
  await page.goto(FAMILY_INVITE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // Find email input
  const emailInput = await page.$("input[type='email'], input[aria-label*='email'], input[aria-label*='Email']")
    ?? await page.$("input[type='text']");

  if (!emailInput) {
    throw new Error(`[${label}] Could not find email input on invite page`);
  }

  await emailInput.fill(newEmail);
  await page.waitForTimeout(1000);

  // Click send/invite button
  const sendSelectors = [
    "button:has-text('Send')",
    "button:has-text('Invite')",
    "button:has-text('Add')",
    "[aria-label*='Send']",
    "[aria-label*='send']",
  ];

  let sent = false;
  for (const sel of sendSelectors) {
    const btn = await page.$(sel);
    if (btn && await btn.isVisible()) {
      await btn.click();
      sent = true;
      await logger.log("INFO", `[${label}] Sent invite to ${newEmail}`);
      break;
    }
  }

  if (!sent) {
    throw new Error(`[${label}] Could not find send/invite button`);
  }

  await page.waitForTimeout(3000);
  await logger.log("INFO", `[${label}] Invite sent to ${newEmail}`);
}

/**
 * Accept a pending family group invitation.
 */
async function acceptFamilyInvite(
  page: import("playwright").Page,
  logger: TaskLogger,
  label: string
): Promise<void> {
  // Navigate to family page — pending invites should appear
  await logger.log("INFO", `[${label}] Navigating to family page to accept invite...`);
  await page.goto("https://myaccount.google.com/family?hl=en", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);

  // Detect invitation link in Gmail or directly on family page
  const acceptSelectors = [
    "button:has-text('Join')",
    "button:has-text('Accept')",
    "a:has-text('Join')",
    "a:has-text('Accept')",
    "[aria-label*='Join']",
    "[aria-label*='Accept']",
  ];

  let accepted = false;
  for (const sel of acceptSelectors) {
    const btn = await page.$(sel);
    if (btn && await btn.isVisible()) {
      await btn.click();
      accepted = true;
      await logger.log("INFO", `[${label}] Clicked accept/join button`);
      break;
    }
  }

  if (!accepted) {
    // Try clicking any prominent button on the page
    await logger.log("WARN", `[${label}] No explicit accept button found, looking for family invite flow...`);
    // Check for invitation text
    const bodyText = await page.textContent("body") ?? "";
    if (bodyText.includes("invit") || bodyText.includes("join")) {
      await logger.log("INFO", `[${label}] Invitation text detected, attempting to join...`);
    }
  }

  // Wait for confirmation
  await page.waitForTimeout(5000);

  // Check if we're now a family member
  const currentUrl = page.url();
  const bodyText = await page.textContent("body") ?? "";
  if (bodyText.includes("family group") || bodyText.includes("Family") || currentUrl.includes("/family/details")) {
    await logger.log("INFO", `[${label}] Successfully joined family group`);
  } else {
    await logger.log("WARN", `[${label}] Join status uncertain — current URL: ${currentUrl}`);
  }
}


// ============================================================
// agent-replace processor
// ============================================================

export async function processAgentReplace(
  job: Job,
  deps: AgentPoolProcessorDeps
): Promise<void> {
  const { prisma, workerId } = deps;
  const data = job.data;
  const taskId = data.taskId ?? job.id ?? job.name;

  if (!taskId) return;
  const logger = new TaskLogger(prisma, taskId, workerId);

  const { oldEmail, newEmail, oldAccountId, newAccountId, groupId, targetPool,
    motherCredentials, newCredentials } = data;

  await logger.updateStatus("RUNNING");
  await logger.log("INFO", `[agent-replace] Starting: ${oldEmail} → ${newEmail}`);

  let motherSession: Awaited<ReturnType<typeof loginAndGetPage>> | null = null;
  let childSession: Awaited<ReturnType<typeof loginAndGetPage>> | null = null;

  try {
    // ── Step 1: Login as mother, remove old member ──
    await logger.log("INFO", "[agent-replace] Step 1/3: Login as mother to remove old member");
    motherSession = await loginAndGetPage(motherCredentials, deps, logger, "mother");

    await removeMemberFromFamily(motherSession.page, oldEmail, logger, "remove-old");

    // Sync DB: mark FamilyMember as REMOVED + update group slots
    await prisma.familyMember.updateMany({
      where: { familyGroupId: groupId, email: oldEmail.toLowerCase(), status: { in: ["ACTIVE", "PENDING"] } },
      data: { status: "REMOVED", removedAt: new Date() },
    }).catch(() => { });
    await prisma.familyGroup.update({
      where: { id: groupId },
      data: { availableSlots: { increment: 1 }, memberCount: { decrement: 1 } },
    }).catch(() => { });
    await logger.log("INFO", `[agent-replace] FamilyMember ${oldEmail} marked REMOVED`);

    await logger.log("INFO", "[agent-replace] Old member removed, releasing mother session");
    await releaseSession(deps, motherSession.browser, motherSession.profileId, motherSession.stopHeartbeat, motherCredentials.email);
    motherSession = null;

    // ── Step 2: Login as mother again, invite new member ──
    await logger.log("INFO", "[agent-replace] Step 2/3: Login as mother to invite new member");
    motherSession = await loginAndGetPage(motherCredentials, deps, logger, "mother-invite");

    await inviteMemberToFamily(motherSession.page, newEmail, logger, "invite-new");

    await logger.log("INFO", "[agent-replace] Invite sent, releasing mother session");
    await releaseSession(deps, motherSession.browser, motherSession.profileId, motherSession.stopHeartbeat, motherCredentials.email);
    motherSession = null;

    // Brief pause to let invite propagate
    await new Promise(r => setTimeout(r, 5000));

    // ── Step 3: Login as new child, accept invite ──
    await logger.log("INFO", "[agent-replace] Step 3/3: Login as new child to accept invite");
    childSession = await loginAndGetPage(newCredentials, deps, logger, "child-accept");

    await acceptFamilyInvite(childSession.page, logger, "accept-invite");

    // Sync DB: upsert new FamilyMember as ACTIVE + update group slots
    await prisma.familyMember.upsert({
      where: { familyGroupId_email: { familyGroupId: groupId, email: newEmail.toLowerCase() } },
      update: { status: "ACTIVE", joinedAt: new Date(), removedAt: null },
      create: {
        familyGroupId: groupId,
        email: newEmail.toLowerCase(),
        role: "member",
        status: "ACTIVE",
        joinedAt: new Date(),
      },
    }).catch(() => { });
    await prisma.familyGroup.update({
      where: { id: groupId },
      data: { availableSlots: { decrement: 1 }, memberCount: { increment: 1 } },
    }).catch(() => { });
    await logger.log("INFO", `[agent-replace] FamilyMember ${newEmail} upserted as ACTIVE`);

    await releaseSession(deps, childSession.browser, childSession.profileId, childSession.stopHeartbeat, newCredentials.email);
    childSession = null;

    // ── Step 4: Update database records ──
    await logger.log("INFO", "[agent-replace] Updating database records...");

    // Old account → banned
    await prisma.agentAccount.update({
      where: { id: oldAccountId },
      data: { banned: true },
    }).catch(e => logger.log("WARN", `Failed to mark old account banned: ${e}`));

    // New account → same pool as old, with mother info
    const oldAcc = await prisma.agentAccount.findUnique({ where: { id: oldAccountId } });
    await prisma.agentAccount.update({
      where: { id: newAccountId },
      data: {
        pool: targetPool ?? oldAcc?.pool ?? "no_ban",
        banned: false,
        uploadedToPool: new Date(),
        motherAccountId: oldAcc?.motherAccountId ?? null,
        motherGroupId: groupId,
        familyGroupId: groupId,
        status: "UPLOADED",
        uploadedAt: new Date(),
      },
    }).catch(e => logger.log("WARN", `Failed to update new account: ${e}`));

    await logger.updateStatus("SUCCESS");
    await logger.log("INFO", `[agent-replace] Completed: ${oldEmail} → ${newEmail}`);

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await logger.log("ERROR", `[agent-replace] Failed: ${msg}`);
    await logger.updateStatus("FAILED_FINAL", {
      code: "AGENT_REPLACE_ERROR",
      message: msg,
    });
  } finally {
    if (motherSession) {
      await releaseSession(deps, motherSession.browser, motherSession.profileId, motherSession.stopHeartbeat, motherCredentials.email).catch(() => { });
    }
    if (childSession) {
      await releaseSession(deps, childSession.browser, childSession.profileId, childSession.stopHeartbeat, newCredentials.email).catch(() => { });
    }
  }
}


// ============================================================
// agent-migrate processor
// ============================================================

export async function processAgentMigrate(
  job: Job,
  deps: AgentPoolProcessorDeps
): Promise<void> {
  const { prisma, workerId } = deps;
  const data = job.data;
  const taskId = data.taskId ?? job.id ?? job.name;

  if (!taskId) return;
  const logger = new TaskLogger(prisma, taskId, workerId);

  const { childEmail, childAccountId, oldGroupId, newGroupId,
    childCredentials, oldMotherCredentials, newMotherCredentials } = data;

  await logger.updateStatus("RUNNING");
  await logger.log("INFO", `[agent-migrate] Starting: ${childEmail} from old group → new group`);

  let session: Awaited<ReturnType<typeof loginAndGetPage>> | null = null;
  let currentSessionEmail = "";

  try {
    // ── Step 1: Login as old mother, remove child ──
    await logger.log("INFO", "[agent-migrate] Step 1/3: Login as old mother to remove child");
    currentSessionEmail = oldMotherCredentials.email;
    session = await loginAndGetPage(oldMotherCredentials, deps, logger, "old-mother");

    await removeMemberFromFamily(session.page, childEmail, logger, "remove-child");

    // Sync DB: mark old FamilyMember as REMOVED + update old group slots
    await prisma.familyMember.updateMany({
      where: { familyGroupId: oldGroupId, email: childEmail.toLowerCase(), status: { in: ["ACTIVE", "PENDING"] } },
      data: { status: "REMOVED", removedAt: new Date() },
    }).catch(() => { });
    await prisma.familyGroup.update({
      where: { id: oldGroupId },
      data: { availableSlots: { increment: 1 }, memberCount: { decrement: 1 } },
    }).catch(() => { });
    await logger.log("INFO", `[agent-migrate] FamilyMember ${childEmail} marked REMOVED in old group`);

    await releaseSession(deps, session.browser, session.profileId, session.stopHeartbeat, currentSessionEmail);
    session = null;

    // ── Step 2: Login as new mother, invite child ──
    await logger.log("INFO", "[agent-migrate] Step 2/3: Login as new mother to invite child");
    currentSessionEmail = newMotherCredentials.email;
    session = await loginAndGetPage(newMotherCredentials, deps, logger, "new-mother");

    await inviteMemberToFamily(session.page, childEmail, logger, "invite-child");

    await releaseSession(deps, session.browser, session.profileId, session.stopHeartbeat, currentSessionEmail);
    session = null;

    // Brief pause
    await new Promise(r => setTimeout(r, 5000));

    // ── Step 3: Login as child, accept invite ──
    await logger.log("INFO", "[agent-migrate] Step 3/3: Login as child to accept invite");
    currentSessionEmail = childCredentials.email;
    session = await loginAndGetPage(childCredentials, deps, logger, "child-accept");

    await acceptFamilyInvite(session.page, logger, "child-accept");

    // Sync DB: upsert new FamilyMember as ACTIVE + update new group slots
    await prisma.familyMember.upsert({
      where: { familyGroupId_email: { familyGroupId: newGroupId, email: childEmail.toLowerCase() } },
      update: { status: "ACTIVE", joinedAt: new Date(), removedAt: null },
      create: {
        familyGroupId: newGroupId,
        email: childEmail.toLowerCase(),
        role: "member",
        status: "ACTIVE",
        joinedAt: new Date(),
      },
    }).catch(() => { });
    await prisma.familyGroup.update({
      where: { id: newGroupId },
      data: { availableSlots: { decrement: 1 }, memberCount: { increment: 1 } },
    }).catch(() => { });
    await logger.log("INFO", `[agent-migrate] FamilyMember ${childEmail} upserted as ACTIVE in new group`);

    await releaseSession(deps, session.browser, session.profileId, session.stopHeartbeat, currentSessionEmail);
    session = null;

    // ── Step 4: Update database ──
    await logger.log("INFO", "[agent-migrate] Updating database records...");

    // Get new group's mother account
    const newGroup = await prisma.familyGroup.findUnique({
      where: { id: newGroupId },
      select: { id: true, accountId: true },
    });

    await prisma.agentAccount.update({
      where: { id: childAccountId },
      data: {
        motherAccountId: newGroup?.accountId ?? null,
        motherGroupId: newGroupId,
        familyGroupId: newGroupId,
      },
    }).catch(e => logger.log("WARN", `Failed to update child account: ${e}`));

    await logger.updateStatus("SUCCESS");
    await logger.log("INFO", `[agent-migrate] Completed: ${childEmail} migrated to new group`);

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await logger.log("ERROR", `[agent-migrate] Failed: ${msg}`);
    await logger.updateStatus("FAILED_FINAL", {
      code: "AGENT_MIGRATE_ERROR",
      message: msg,
    });
  } finally {
    if (session) {
      await releaseSession(deps, session.browser, session.profileId, session.stopHeartbeat, currentSessionEmail).catch(() => { });
    }
  }
}
