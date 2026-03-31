/**
 * Automation processor — handles OAuth and accept-invite tasks.
 *
 * Credentials come from the BullMQ job payload (passed from client).
 * Uses the existing BrowserPool + AdsPower infrastructure.
 *
 * Flow:
 *   1. Acquire AdsPower profile from pool
 *   2. Connect via CDP
 *   3. Gmail login
 *   4. Execute action-specific logic
 *   5. Write result to Task payload (client polls to get it)
 *   6. Release profile
 */

import { Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import type { AutomationPayload } from "@gfa/shared";

import { AdsPowerClient } from "../adspower-client";
import { BrowserPool } from "../browser-pool";
import { WorkerBrowser } from "../browser-context";
import { TaskLogger } from "../task-logger";
import { gmailLogin, type LoginCredentials } from "../gmail-login";
import { handleLoginResult } from "../handle-login-result";

// ---- OAuth constants ----
const OAUTH_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");

const FAMILY_URL = "https://families.google.com/families?hl=en";
const FAMILY_DETAILS_URL = "https://myaccount.google.com/family/details?hl=en";

export interface AutomationProcessorDeps {
  prisma: PrismaClient;
  adspower: AdsPowerClient;
  pool: BrowserPool;
  workerId: string;
}

export async function processAutomation(
  job: Job<AutomationPayload>,
  deps: AutomationProcessorDeps
): Promise<void> {
  const { prisma, adspower, pool, workerId } = deps;
  const { action, credentials } = job.data;
  const taskId = job.data.taskId ?? job.id ?? job.name;

  if (!taskId) {
    console.error(`[worker:${workerId}] automation job has no id, skipping`);
    return;
  }

  const logger = new TaskLogger(prisma, taskId, workerId);

  // Guard: skip if this task already reached a terminal state.
  // This prevents stalled-job retries from re-running a completed OAuth flow.
  const existing = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true },
  });
  if (
    existing &&
    (existing.status === "SUCCESS" || existing.status === "FAILED_FINAL")
  ) {
    console.log(
      `[worker:${workerId}][task:${taskId}] Skipping — already ${existing.status}`
    );
    return;
  }

  const browser = new WorkerBrowser();
  let profileId: string | null = null;

  try {
    // Acquire AdsPower profile (with retry across pool)
    let debugUrl: string | undefined;
    const maxProfileAttempts = pool.poolSize;
    const failedProfiles = new Set<string>();

    for (
      let profileAttempt = 1;
      profileAttempt <= maxProfileAttempts;
      profileAttempt++
    ) {
      profileId = await pool.acquireExcluding(workerId, failedProfiles);
      await logger.log(
        "INFO",
        `[automation:${action}] Acquired profile ${profileId} (attempt ${profileAttempt}/${maxProfileAttempts})`
      );
      try {
        debugUrl = (await adspower.openProfile(profileId)).debugUrl;
        break;
      } catch (profileErr) {
        const msg =
          profileErr instanceof Error
            ? profileErr.message
            : String(profileErr);
        await logger.log(
          "WARN",
          `Profile ${profileId} unavailable: ${msg}`
        );
        failedProfiles.add(profileId!);
        await adspower.closeProfile(profileId!).catch(() => {});
        await pool.release(profileId!, workerId).catch(() => {});
        profileId = null;
        if (profileAttempt === maxProfileAttempts) {
          throw new Error(
            `All ${maxProfileAttempts} profiles unavailable: ${msg}`
          );
        }
      }
    }

    await logger.updateStatus("RUNNING");
    const page = await browser.connect(debugUrl!);

    // Build LoginCredentials from payload
    const loginCreds: LoginCredentials = {
      loginEmail: credentials.email,
      loginPassword: credentials.password,
      totpSecret: credentials.totpSecret,
    };

    // Step 1: Gmail login
    await logger.log("INFO", `Logging in as ${credentials.email}`);
    const loginResult = await gmailLogin(page, loginCreds, logger);

    if (!loginResult.success) {
      await logger.log(
        "WARN",
        `Login failed: ${loginResult.reason} — ${loginResult.detail}`
      );
      await logger.updateStatus("FAILED_FINAL", {
        code: loginResult.reason,
        message: loginResult.detail,
      });
      return;
    }
    await logger.log("INFO", "Google login successful");

    // Step 2: Dispatch to action handler
    switch (action) {
      case "oauth":
        await handleOAuth(page, loginCreds, logger, prisma, taskId);
        break;
      case "accept-invite":
        await handleAcceptInvite(page, loginCreds, logger);
        // After accept-invite succeeds, sync Order + FamilyMember status
        await syncOrderAfterAccept(prisma, credentials.email, logger);
        break;
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    try {
      await browser.takeScreenshot(taskId, "error");
    } catch {
      // noop
    }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "AUTOMATION_ERROR" : "PROFILE_ACQUIRE_FAILED",
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

// ============================================================
// OAuth handler
// ============================================================

async function handleOAuth(
  page: import("playwright").Page,
  credentials: LoginCredentials,
  logger: TaskLogger,
  prisma: PrismaClient,
  taskId: string
): Promise<void> {
  await logger.log("INFO", "Starting Antigravity OAuth flow");

  const REDIRECT_URI = "http://127.0.0.1:19876/oauth-callback";

  // Build OAuth URL
  const oauthParams = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: `automation-${taskId}`,
    hl: "en",
  });
  const oauthUrl = `${AUTH_URL}?${oauthParams.toString()}`;

  // ── Route interception ──────────────────────────────────────────
  // Google will redirect the browser to our redirect_uri after consent.
  // No local server is listening on 127.0.0.1:19876, so the browser would
  // show ERR_CONNECTION_REFUSED and page.url() may NOT contain the code.
  //
  // Fix: intercept the request via Playwright's page.route() BEFORE it
  // hits the network, extract the auth code from the URL, and fulfill
  // the request with a simple HTML page so the browser doesn't error out.
  let authCode: string | null = null;

  await page.route("**/oauth-callback**", async (route) => {
    const reqUrl = route.request().url();
    await logger.log("DEBUG", `[oauth] Intercepted redirect: ${reqUrl}`);
    try {
      const url = new URL(reqUrl);
      const code = url.searchParams.get("code");
      if (code) {
        authCode = code;
        await logger.log("INFO", "Authorization code captured via route interception");
      }
    } catch {
      // URL parse error — ignore
    }
    // Fulfill with a simple page so the browser doesn't show an error
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body><h3>OAuth complete — you can close this tab.</h3></body></html>",
    });
  });

  await page.goto(oauthUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  // Handle OAuth consent flow (up to 15 attempts)
  for (let attempt = 0; attempt < 15; attempt++) {
    // If the route handler already captured the code, we're done
    if (authCode) {
      await logger.log("INFO", "Auth code already captured, breaking out of consent loop");
      break;
    }

    const nowUrl = page.url();

    // Fallback: check page.url() in case route interception didn't fire
    if (
      nowUrl.startsWith("http://127.0.0.1:19876") ||
      nowUrl.startsWith("http://localhost")
    ) {
      try {
        const url = new URL(nowUrl);
        const code = url.searchParams.get("code");
        if (code) {
          authCode = code;
          await logger.log("INFO", "Authorization code received from page URL");
          break;
        }
      } catch {
        // URL parse error — continue
      }
    }

    // TOTP re-auth during OAuth
    if (nowUrl.includes("challenge/totp") && credentials.totpSecret) {
      const { generateTOTP, totpSecondsRemaining } = await import("../totp");
      const remaining = totpSecondsRemaining();
      if (remaining < 5) {
        await page.waitForTimeout((remaining + 1) * 1000);
      }
      const totpInput = page.locator(
        'input[type="tel"], input[type="text"][name="totpPin"], input[name="Pin"]'
      );
      if ((await totpInput.count()) > 0) {
        const code = generateTOTP(credentials.totpSecret!);
        await totpInput.first().fill(code);
        await logger.log("INFO", `TOTP re-auth submitted: ${code.substring(0, 2)}****`);
        const nextBtn = page.locator(
          'button[type="submit"], #totpNext, div[id="totpNext"] button, ' +
          'button[jsname="LgbsSe"], div[role="button"][jsname="LgbsSe"]'
        );
        if ((await nextBtn.count()) > 0) {
          await nextBtn.first().evaluate((el: HTMLElement) => el.click());
        } else {
          await page.keyboard.press("Enter");
        }
        await page.waitForTimeout(5000);
        continue;
      }
    }

    // Password re-auth
    if (nowUrl.includes("challenge/pwd") && credentials.loginPassword) {
      const pwdInput = page.locator(
        'input[type="password"]:not([aria-hidden="true"])'
      );
      if ((await pwdInput.count()) > 0) {
        await pwdInput.first().fill(credentials.loginPassword);
        await logger.log("INFO", "Password re-auth submitted");
        const nextBtn = page.locator(
          'button[type="submit"], button[jsname="LgbsSe"], #passwordNext button'
        );
        if ((await nextBtn.count()) > 0) {
          await nextBtn.first().evaluate((el: HTMLElement) => el.click());
        } else {
          await page.keyboard.press("Enter");
        }
        await page.waitForTimeout(5000);
        continue;
      }
    }

    // Skip / Not now
    const skipBtn = page.locator(
      [
        'button[jsname="LkDMRd"]',
        'button:has-text("Not now")',
        'a:has-text("Not now")',
        'button:has-text("Skip")',
        'a:has-text("Skip")',
      ].join(", ")
    );
    if ((await skipBtn.count()) > 0) {
      await skipBtn.first().evaluate((el: HTMLElement) => el.click());
      await logger.log("INFO", "Clicked skip/not-now");
      await page.waitForTimeout(3000);
      continue;
    }

    // Account chooser
    if (
      nowUrl.includes("accountchooser") ||
      nowUrl.includes("selectaccount") ||
      nowUrl.includes("/o/oauth2/")
    ) {
      const accountOption = page.locator(
        `[data-email="${credentials.loginEmail}"]`
      );
      if ((await accountOption.count()) > 0) {
        await accountOption.first().click();
        await logger.log("INFO", "Selected account by data-email");
        await page.waitForTimeout(3000);
        continue;
      }
      // Fallback: click first account
      const firstAccount = page.locator(
        'ul li[role="presentation"], div[data-authuser], div.JDAKTe'
      );
      if ((await firstAccount.count()) > 0) {
        await firstAccount.first().click();
        await logger.log("INFO", "Selected first account from chooser");
        await page.waitForTimeout(3000);
        continue;
      }
    }

    // First-party native app consent: "Sign in" on native app page
    if (
      nowUrl.includes("firstparty/nativeapp") ||
      nowUrl.includes("signin/oauth")
    ) {
      const signInBtn = page.locator(
        'button:has-text("Sign in"), button:has-text("Continue")'
      );
      if ((await signInBtn.count()) > 0) {
        await signInBtn.last().evaluate((el: HTMLElement) => el.click());
        await logger.log("INFO", "Clicked 'Sign in' on consent page");
        await page.waitForTimeout(5000);
        continue;
      }
    }

    // Consent buttons
    const consentBtn = page.locator(
      [
        '#submit_approve_access',
        'input[id="submit_approve_access"]',
        'button[type="submit"]',
        'button:has-text("Allow")',
        'button:has-text("Continue")',
      ].join(", ")
    );
    if ((await consentBtn.count()) > 0) {
      await consentBtn.first().evaluate((el: HTMLElement) => el.click());
      await logger.log("INFO", "Clicked consent/allow button");
      await page.waitForTimeout(3000);
      continue;
    }

    // Checkboxes
    const checkboxes = page.locator('input[type="checkbox"]:not(:checked)');
    if ((await checkboxes.count()) > 0) {
      for (let i = 0; i < (await checkboxes.count()); i++) {
        await checkboxes.nth(i).check().catch(() => {});
      }
      await logger.log("INFO", "Checked scope checkboxes");
      await page.waitForTimeout(1000);
      continue;
    }

    await page.waitForTimeout(2000);
  }

  // Clean up route handler
  await page.unroute("**/oauth-callback**").catch(() => {});

  // Final URL check (fallback)
  if (!authCode) {
    const finalUrl = page.url();
    await logger.log("WARN", `No auth code from interception. Final URL: ${finalUrl}`);
    if (
      finalUrl.startsWith("http://127.0.0.1:19876") ||
      finalUrl.startsWith("http://localhost")
    ) {
      try {
        authCode = new URL(finalUrl).searchParams.get("code");
      } catch {}
    }
  }

  if (!authCode) {
    await logger.updateStatus("FAILED_FINAL", {
      code: "OAUTH_INCOMPLETE",
      message: `OAuth did not complete. Final URL: ${page.url()}`,
    });
    return;
  }

  // Exchange code for tokens
  await logger.log("INFO", "Exchanging auth code for tokens");
  const tokenParams = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    code: authCode,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const tokenResp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    await logger.updateStatus("FAILED_FINAL", {
      code: "TOKEN_EXCHANGE_FAILED",
      message: `Token exchange failed: ${errText}`,
    });
    return;
  }

  const tokenData = await tokenResp.json();
  const token = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token ?? "",
    expires_in: tokenData.expires_in ?? 3600,
    email: credentials.loginEmail,
  };

  // Store result in task payload so client can retrieve it
  await prisma.task.update({
    where: { id: taskId },
    data: {
      payload: JSON.stringify({
        action: "oauth",
        email: credentials.loginEmail,
        result: token,
      }),
    },
  });

  await logger.updateStatus("SUCCESS");
  await logger.log("INFO", `OAuth completed for ${credentials.loginEmail}`);
}

// ============================================================
// Accept invite handler
// ============================================================

async function handleAcceptInvite(
  page: import("playwright").Page,
  credentials: LoginCredentials,
  logger: TaskLogger
): Promise<void> {
  await logger.log("INFO", "Starting accept-invite flow");

  /** Force English on any Google page */
  async function ensureEnglish() {
    try {
      const url = new URL(page.url());
      if (
        url.hostname.includes("google") &&
        url.searchParams.get("hl") !== "en"
      ) {
        url.searchParams.set("hl", "en");
        await page.goto(url.toString(), {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForTimeout(2000);
      }
    } catch {}
  }

  // Navigate to family page
  await logger.log("INFO", "Navigating to Google Family");
  await page.goto(FAMILY_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(3000);
  await page
    .waitForLoadState("networkidle", { timeout: 15000 })
    .catch(() => {});
  await ensureEnglish();

  // Check if already in a family — leave first
  const pageText = (await page.textContent("body").catch(() => "")) ?? "";
  const IN_FAMILY = [
    "Family member",
    "Leave family group",
    "Family group",
    "家庭成员",
    "退出家庭群组",
  ];
  const NOT_IN_FAMILY = [
    "Join a family",
    "Create a family",
    "Get started",
    "加入",
    "创建",
  ];
  const alreadyInFamily =
    IN_FAMILY.some((m) => pageText.includes(m)) &&
    !NOT_IN_FAMILY.some((m) => pageText.includes(m));

  if (alreadyInFamily) {
    await logger.log("INFO", "Already in a family group, leaving first...");
    await page.goto(FAMILY_DETAILS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const leaveBtn = page.locator(
      [
        'button:has-text("Leave family group")',
        'button:has-text("Leave")',
        'a:has-text("Leave")',
        'div[role="button"]:has-text("Leave")',
      ].join(", ")
    );
    if ((await leaveBtn.count()) > 0) {
      await leaveBtn.first().evaluate((el: HTMLElement) => el.click());
      await logger.log("INFO", "Clicked Leave family group");
      await page.waitForTimeout(3000);

      // Confirm leave dialog
      const confirmLeave = page.locator(
        'button:has-text("Leave"), button:has-text("Confirm"), button:has-text("Yes")'
      );
      for (let i = 0; i < 3; i++) {
        if ((await confirmLeave.count()) > 0) {
          await confirmLeave
            .last()
            .evaluate((el: HTMLElement) => el.click());
          await logger.log("INFO", `Confirmed leave (round ${i + 1})`);
          await page.waitForTimeout(3000);
        } else break;
      }

      await page.waitForTimeout(2000);
      await page.goto(FAMILY_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForTimeout(3000);
    }
  }

  // Look for pending invitation
  await logger.log("INFO", "Looking for pending invitation");

  const INVITE_KEYWORDS = [
    "View invitation",
    "Join",
    "Accept",
    "Accept invitation",
    "查看邀请",
    "加入",
    "接受",
  ];
  const inviteSelectors = INVITE_KEYWORDS.flatMap((kw) => [
    `button:has-text("${kw}")`,
    `a:has-text("${kw}")`,
    `div[role="button"]:has-text("${kw}")`,
    `div[role="link"]:has-text("${kw}")`,
  ]);

  let inviteFound = false;

  // Approach 1: families page
  const joinBtn = page.locator(inviteSelectors.join(", "));
  if ((await joinBtn.count()) > 0) {
    await joinBtn.first().click();
    inviteFound = true;
    await logger.log("INFO", "Clicked invite button on families page");
    await page.waitForTimeout(3000);
    await ensureEnglish();
  }

  // Approach 2: family details page
  if (!inviteFound) {
    await page.goto(FAMILY_DETAILS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(3000);

    const joinBtn2 = page.locator(inviteSelectors.join(", "));
    if ((await joinBtn2.count()) > 0) {
      await joinBtn2.first().click();
      inviteFound = true;
      await logger.log("INFO", "Clicked invite button on details page");
      await page.waitForTimeout(3000);
    }
  }

  // Approach 3: Gmail
  if (!inviteFound) {
    await logger.log("INFO", "No invite button found, checking Gmail");
    await page.goto("https://mail.google.com/mail/u/0/#inbox", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(5000);

    const familyEmail = page.locator(
      [
        'tr:has-text("family group")',
        'tr:has-text("family")',
        'div[role="row"]:has-text("family")',
      ].join(", ")
    );
    if ((await familyEmail.count()) > 0) {
      await familyEmail.first().click();
      await page.waitForTimeout(4000);

      const acceptLink = page.locator(
        [
          'a:has-text("Accept")',
          'a:has-text("Join")',
          'a[href*="families.google.com"]',
        ].join(", ")
      );
      if ((await acceptLink.count()) > 0) {
        const href = await acceptLink.first().getAttribute("href");
        if (href) {
          await page.goto(href, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
          await page.waitForTimeout(3000);
          inviteFound = true;
          await logger.log("INFO", "Opened invitation link from email");
        }
      }
    }
  }

  if (!inviteFound) {
    await logger.updateStatus("FAILED_FINAL", {
      code: "NO_INVITATION",
      message: "No pending family invitation found",
    });
    return;
  }

  // Handle confirmation dialogs
  await logger.log("INFO", "Confirming invitation");
  for (let confirmRound = 0; confirmRound < 5; confirmRound++) {
    await page.waitForTimeout(3000);
    await ensureEnglish();

    const bodyText = (await page.textContent("body").catch(() => "")) ?? "";

    // Success check
    const SUCCESS_MARKERS = [
      "Welcome to the family",
      "You joined",
      "You're now part of",
      "Family member",
      "Leave family group",
      "已加入",
      "家庭成员",
    ];
    if (SUCCESS_MARKERS.some((m) => bodyText.includes(m))) {
      await logger.log("INFO", "Success — invitation accepted!");
      break;
    }

    const CONFIRM_KEYWORDS = [
      "Confirm",
      "Join family group",
      "Join family",
      "Join",
      "Accept invitation",
      "Accept",
      "Yes",
      "Continue",
      "确认",
      "加入",
      "接受",
      "继续",
    ];
    const confirmSelectors = CONFIRM_KEYWORDS.flatMap((kw) => [
      `button:has-text("${kw}")`,
      `a:has-text("${kw}")`,
      `div[role="button"]:has-text("${kw}")`,
    ]);
    const confirmBtn = page.locator(confirmSelectors.join(", "));

    if ((await confirmBtn.count()) > 0) {
      await confirmBtn.first().evaluate((el: HTMLElement) => el.click());
      await logger.log(
        "INFO",
        `Clicked confirm button (round ${confirmRound + 1})`
      );
      await page.waitForTimeout(3000);
    } else if (confirmRound >= 2) {
      break;
    }
  }

  // Verify success
  await page.goto(FAMILY_DETAILS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(3000);

  const verifyText = (await page.textContent("body").catch(() => "")) ?? "";
  const isMember =
    verifyText.includes(credentials.loginEmail) ||
    verifyText.includes("Family member") ||
    verifyText.includes("Leave family group");

  if (isMember) {
    await logger.updateStatus("SUCCESS");
    await logger.log("INFO", "Successfully joined family group!");
  } else {
    await logger.updateStatus("SUCCESS");
    await logger.log(
      "INFO",
      "Invite flow completed — verify membership manually"
    );
  }
}



// ============================================================
// Post-accept sync: update Order + FamilyMember status
// ============================================================

/**
 * After accept-invite succeeds, find the Order and FamilyMember records
 * for the accepted email and update them to COMPLETED / ACTIVE.
 *
 * Uses case-insensitive email matching for robustness.
 */
async function syncOrderAfterAccept(
  prisma: PrismaClient,
  email: string,
  logger: TaskLogger
): Promise<void> {
  const normalized = email.trim().toLowerCase();

  try {
    // Update Order: INVITE_SENT / WAIT_USER_ACCEPT / TASK_QUEUED → COMPLETED
    const updated = await prisma.order.updateMany({
      where: {
        userEmail: normalized,
        status: { in: ["INVITE_SENT", "WAIT_USER_ACCEPT", "TASK_QUEUED"] },
      },
      data: {
        status: "COMPLETED",
        resultMessage: "Member accepted invite (auto-detected by accept-invite automation)",
      },
    });

    // Case-insensitive fallback
    if (updated.count === 0) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Order" SET status = 'COMPLETED',
           resultMessage = 'Member accepted invite (auto-detected by accept-invite automation)',
           updatedAt = datetime('now')
         WHERE LOWER(userEmail) = ?
           AND status IN ('INVITE_SENT','WAIT_USER_ACCEPT','TASK_QUEUED')`,
        normalized
      ).catch(() => {});
    }

    if (updated.count > 0) {
      await logger.log("INFO", `Order status synced to COMPLETED for ${email} (${updated.count} order(s))`);
    }

    // Update FamilyMember: PENDING → ACTIVE
    const memberUpdate = await prisma.familyMember.updateMany({
      where: {
        email: normalized,
        status: "PENDING",
      },
      data: {
        status: "ACTIVE",
        joinedAt: new Date(),
      },
    });

    // Case-insensitive fallback for FamilyMember
    if (memberUpdate.count === 0) {
      await prisma.$executeRawUnsafe(
        `UPDATE FamilyMember SET status = 'ACTIVE', joinedAt = datetime('now'), updatedAt = datetime('now')
         WHERE LOWER(email) = ? AND status = 'PENDING'`,
        normalized
      ).catch(() => {});
    }

    if (memberUpdate.count > 0) {
      await logger.log("INFO", `FamilyMember status synced to ACTIVE for ${email}`);
    }
  } catch (err) {
    // Non-fatal: accept-invite itself succeeded, DB sync is best-effort
    await logger.log("WARN",
      `Post-accept DB sync failed for ${email}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
