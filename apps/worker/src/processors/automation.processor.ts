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
import { handlePhoneVerification, isVerificationPage } from "../phone-verification";
import { generateTOTP, totpSecondsRemaining, currentTotpWindow, lastUsedTotpWindow, markTotpUsed } from "../totp";

/** Max time for the entire accept-invite flow (5 min), well under BullMQ lockDuration (10 min). */
const ACCEPT_INVITE_TIMEOUT_MS = 5 * 60 * 1000;

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
  const { action, credentials, phones } = job.data;
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
  let stopHeartbeat: (() => void) | null = null;

  // Look up the Account record by email so we use the same lock key
  // (account.id) as invite/sync/remove/replace processors.
  // Without this, Redis would have two different lock names for the
  // same Google account, defeating account-level serialisation.
  //
  // If no Account row exists yet (onboarding: oauth / accept-invite for
  // a brand-new account), fall back to an email-derived key so the task
  // can still proceed while maintaining per-email serialisation.
  const dbAccount = await prisma.account.findFirst({
    where: { loginEmail: credentials.email },
    select: { id: true },
  });
  const accountLockKey = dbAccount?.id ?? `email:${credentials.email.toLowerCase()}`;

  try {

    // Acquire profile + open AdsPower browser (retries other profiles on failure)
    const acquired = await pool.acquireAndOpen(workerId, accountLockKey, adspower);
    profileId = acquired.profileId;
    stopHeartbeat = pool.startHeartbeat(profileId, accountLockKey, workerId);
    await logger.log(
      "INFO",
      `[automation:${action}] Acquired profile ${profileId}`
    );

    await logger.updateStatus("RUNNING");
    const page = await browser.connect(acquired.debugUrl);

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
      case "accept-invite": {
        // Wrap with overall timeout to prevent the task from running forever
        // and exceeding BullMQ lockDuration (10 min).
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("ACCEPT_INVITE_TIMEOUT: exceeded 5 min")), ACCEPT_INVITE_TIMEOUT_MS)
        );
        const acceptResult = await Promise.race([
          handleAcceptInvite(page, loginCreds, logger),
          timeoutPromise,
        ]);
        // Only sync Order + FamilyMember status when accept-invite actually succeeded
        if (acceptResult === true) {
          await syncOrderAfterAccept(prisma, credentials.email, logger);
        } else {
          await logger.log("WARN", "accept-invite did not succeed — skipping Order/FamilyMember sync");
        }

        // ── Post-accept: proactive phone verification (if phones available) ──
        // setTaskStatus=false: this is a bonus step, must NOT overwrite the accept-invite result
        if (phones && phones.length > 0) {
          await logger.log("INFO", "[accept-invite] Starting proactive phone verification...");
          await doProactivePhoneVerification(page, loginCreds, logger, prisma, taskId, phones, false);
        }
        break;
      }
      case "phone-verify": {
        // Dedicated phone verification flow
        await handlePhoneVerifyAction(page, loginCreds, logger, prisma, taskId, phones);
        break;
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    try {
    } catch {
      // noop
    }

    await logger.updateStatus("FAILED_RETRYABLE", {
      code: profileId ? "AUTOMATION_ERROR" : "PROFILE_ACQUIRE_FAILED",
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
    await pool.releaseAccount(accountLockKey, workerId).catch(() => {});
  }
}

// ============================================================
// OAuth handler
// ============================================================

/**
 * Run the OAuth consent flow and exchange the code for tokens.
 * Returns { access_token, refresh_token, ... } or null on failure.
 * Separated from handleOAuth so phone-verify can also obtain a token.
 */
async function doOAuthForToken(
  page: import("playwright").Page,
  credentials: LoginCredentials,
  logger: TaskLogger
): Promise<{ access_token: string; refresh_token: string; expires_in: number; email: string } | null> {
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
    state: `automation-${Date.now()}`,
    hl: "en",
  });
  const oauthUrl = `${AUTH_URL}?${oauthParams.toString()}`;

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
      const { generateTOTP: genTOTP, totpSecondsRemaining: totpRemaining, currentTotpWindow: curWin, lastUsedTotpWindow: lastWin, markTotpUsed: markUsed } = await import("../totp");
      const cw = curWin();
      if (cw <= lastWin()) {
        const remaining = totpRemaining();
        await page.waitForTimeout((remaining + 1) * 1000);
      } else {
        const remaining = totpRemaining();
        if (remaining < 5) {
          await page.waitForTimeout((remaining + 1) * 1000);
        }
      }
      const totpInput = page.locator(
        'input[type="tel"], input[type="text"][name="totpPin"], input[name="Pin"]'
      );
      if ((await totpInput.count()) > 0) {
        const code = genTOTP(credentials.totpSecret!);
        await totpInput.first().fill(code);
        await logger.log("INFO", `TOTP re-auth submitted: ${code.substring(0, 2)}****`);
        markUsed();
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

    // First-party native app consent
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
    await logger.log("WARN", "OAuth consent flow did not produce an auth code");
    return null;
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
    await logger.log("WARN", `Token exchange failed: ${errText}`);
    return null;
  }

  const tokenData = await tokenResp.json();
  return {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token ?? "",
    expires_in: tokenData.expires_in ?? 3600,
    email: credentials.loginEmail,
  };
}

/**
 * Full OAuth task handler — gets token and stores in task payload.
 */
async function handleOAuth(
  page: import("playwright").Page,
  credentials: LoginCredentials,
  logger: TaskLogger,
  prisma: PrismaClient,
  taskId: string
): Promise<void> {
  await logger.log("INFO", "Starting Antigravity OAuth flow");

  const token = await doOAuthForToken(page, credentials, logger);

  if (!token) {
    await logger.updateStatus("FAILED_FINAL", {
      code: "OAUTH_INCOMPLETE",
      message: `OAuth did not complete. Final URL: ${page.url()}`,
    });
    return;
  }

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
// Re-auth helper — handles password & TOTP re-authentication
// during the accept-invite flow (Google may require it after
// navigating to family pages or clicking Join/Leave).
// ============================================================

async function handleReAuth(
  page: import("playwright").Page,
  credentials: LoginCredentials,
  logger: TaskLogger
): Promise<boolean> {
  const url = page.url();

  // Password re-auth
  if (url.includes("challenge/pwd") || url.includes("signin/challenge")) {
    const pwdInput = page.locator(
      'input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])'
    );
    if (credentials.loginPassword && (await pwdInput.count()) > 0) {
      await pwdInput.first().fill(credentials.loginPassword);
      await logger.log("INFO", "[accept-invite] Re-auth: password submitted");
      const nextBtn = page.locator(
        'button[type="submit"], button[jsname="LgbsSe"], #passwordNext button'
      );
      if ((await nextBtn.count()) > 0) {
        await nextBtn.first().evaluate((el: HTMLElement) => el.click());
      } else {
        await page.keyboard.press("Enter");
      }
      await page.waitForTimeout(4000);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      return true;
    }
  }

  // TOTP re-auth
  if (url.includes("challenge/totp")) {
    if (!credentials.totpSecret) {
      await logger.log("WARN", "[accept-invite] TOTP challenge but no totpSecret configured");
      return false;
    }
    const curWin = currentTotpWindow();
    if (curWin <= lastUsedTotpWindow()) {
      const remaining = totpSecondsRemaining();
      await page.waitForTimeout((remaining + 1) * 1000);
    } else {
      const remaining = totpSecondsRemaining();
      if (remaining < 5) {
        await page.waitForTimeout((remaining + 1) * 1000);
      }
    }
    const totpInput = page.locator(
      'input[type="tel"], input[type="text"][name="totpPin"], input[name="Pin"]'
    );
    if ((await totpInput.count()) > 0) {
      const code = generateTOTP(credentials.totpSecret!);
      await totpInput.first().fill(code);
      await logger.log("INFO", `[accept-invite] Re-auth: TOTP submitted (${code.substring(0, 2)}****)`);
      markTotpUsed();
      const nextBtn = page.locator(
        'button[type="submit"], #totpNext, div[id="totpNext"] button, ' +
        'button[jsname="LgbsSe"], div[role="button"][jsname="LgbsSe"]'
      );
      if ((await nextBtn.count()) > 0) {
        await nextBtn.first().evaluate((el: HTMLElement) => el.click());
      } else {
        await page.keyboard.press("Enter");
      }
      await page.waitForTimeout(4000);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      return true;
    }
  }

  // Challenge selection page — try to pick TOTP
  if (url.includes("challenge/selection") && credentials.totpSecret) {
    const totpOption = page.locator(
      'div[data-challengetype="6"], li[data-challengetype="6"], ' +
      'button[data-challengetype="6"]'
    );
    if ((await totpOption.count()) > 0) {
      await totpOption.first().click();
      await logger.log("INFO", "[accept-invite] Re-auth: selected TOTP from challenge selection");
      await page.waitForTimeout(3000);
      return true;
    }
  }

  return false;
}

// ============================================================
// Accept invite handler
// ============================================================

async function handleAcceptInvite(
  page: import("playwright").Page,
  credentials: LoginCredentials,
  logger: TaskLogger
): Promise<boolean> {
  await logger.log("INFO", "Starting accept-invite flow");

  /** Force English on any Google page — only call at major navigation points */
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
          timeout: 15000,
        });
        await page.waitForTimeout(1500);
      }
    } catch {}
  }

  /**
   * Check URL for re-auth challenges and handle them.
   * Returns true if a re-auth was performed (caller should re-check page state).
   */
  async function checkAndHandleReAuth(): Promise<boolean> {
    const url = page.url();
    if (
      url.includes("challenge/pwd") ||
      url.includes("challenge/totp") ||
      url.includes("challenge/selection") ||
      url.includes("signin/challenge")
    ) {
      return handleReAuth(page, credentials, logger);
    }
    return false;
  }

  // ── Navigate to family page ──
  await logger.log("INFO", "Navigating to Google Family");
  await page.goto(FAMILY_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(2000);
  await page
    .waitForLoadState("networkidle", { timeout: 10000 })
    .catch(() => {});
  await ensureEnglish();

  // Handle re-auth if Google redirected to a challenge page
  for (let ra = 0; ra < 3; ra++) {
    if (!(await checkAndHandleReAuth())) break;
    await ensureEnglish();
  }

  // ── Check if already in a family — leave first ──
  const rawPageText = (await page.textContent("body").catch(() => "")) ?? "";
  const lowerText = rawPageText.toLowerCase();
  await logger.log("INFO", `Family page text (first 300 chars): ${lowerText.slice(0, 300)}`);

  const IN_FAMILY_KEYWORDS = [
    "family member", "leave family", "your family", "you're a member",
    "you are a member", "family group members",
    "家庭成员", "家庭群组", "退出家庭", "家庭组成员", "离开家庭",
    "家庭成員", "退出家庭群組", "離開家庭",
    "ファミリーメンバー", "ファミリーグループ",
    "가족 그룹", "가족 구성원",
    "thành viên gia đình", "nhóm gia đình",
  ];

  const NOT_IN_FAMILY_KEYWORDS = [
    "join a family", "create a family", "get started", "no family group",
    "加入家庭", "创建家庭", "创建一个家庭群组",
    "加入", "建立家庭",
    "ファミリーグループに参加", "ファミリーを作成",
    "가족 그룹에 참여", "가족 그룹 만들기",
    "tham gia nhóm gia đình", "tạo nhóm gia đình",
  ];

  const matchesInFamily = IN_FAMILY_KEYWORDS.some((kw) => lowerText.includes(kw.toLowerCase()));
  const matchesNotInFamily = NOT_IN_FAMILY_KEYWORDS.some((kw) => lowerText.includes(kw.toLowerCase()));
  const alreadyInFamily = matchesInFamily && !matchesNotInFamily;

  await logger.log("INFO",
    `Family detection: inFamily=${matchesInFamily}, notInFamily=${matchesNotInFamily}, verdict=${alreadyInFamily ? "IN_FAMILY" : "NOT_IN_FAMILY"}`
  );

  if (alreadyInFamily) {
    await logger.log("INFO", "Already in a family group — attempting to leave...");

    await page.goto(FAMILY_DETAILS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    await ensureEnglish();

    // Handle re-auth when navigating to family details
    for (let ra = 0; ra < 3; ra++) {
      if (!(await checkAndHandleReAuth())) break;
      await ensureEnglish();
    }

    const LEAVE_KEYWORDS = [
      "Leave family group", "Leave", "leave family",
      "退出家庭群組", "退出家庭群组", "退出", "離開家庭群組", "离开家庭",
      "Leave group", "脱退",
      "ファミリーグループから脱退", "脱退する",
      "가족 그룹 나가기", "나가기",
      "Rời nhóm gia đình", "Rời khỏi",
    ];
    const leaveBtnSelectors = LEAVE_KEYWORDS.flatMap((kw) => [
      `button:has-text("${kw}")`,
      `a:has-text("${kw}")`,
      `div[role="button"]:has-text("${kw}")`,
      `span:has-text("${kw}")`,
    ]);

    const leaveBtn = page.locator(leaveBtnSelectors.join(", "));
    const leaveCount = await leaveBtn.count();
    await logger.log("INFO", `Found ${leaveCount} leave button(s)`);

    if (leaveCount > 0) {
      for (let i = 0; i < Math.min(leaveCount, 3); i++) {
        const btnText = await leaveBtn.nth(i).textContent().catch(() => "?");
        await logger.log("INFO", `Leave button ${i}: "${btnText?.trim()}"`);
      }

      await leaveBtn.first().evaluate((el: HTMLElement) => el.click());
      await logger.log("INFO", "Clicked Leave button");
      await page.waitForTimeout(3000);

      // Handle re-auth that may appear after clicking Leave
      // Google often redirects to a challenge page or shows a password/TOTP overlay
      for (let ra = 0; ra < 5; ra++) {
        const currentUrl = page.url();
        await logger.log("DEBUG", `[leave-family] Re-auth check ${ra + 1}, URL: ${currentUrl}`);

        // Check URL-based re-auth (redirect to challenge page)
        if (await checkAndHandleReAuth()) {
          await logger.log("INFO", `[leave-family] Re-auth handled (round ${ra + 1})`);
          await page.waitForTimeout(3000);
          continue;
        }

        // Also check for inline password field that Google sometimes shows as an overlay
        const inlinePwd = page.locator(
          'input[type="password"]:visible'
        );
        if (credentials.loginPassword && (await inlinePwd.count()) > 0) {
          await inlinePwd.first().fill(credentials.loginPassword);
          await logger.log("INFO", "[leave-family] Filled inline password field");
          // Try to click a submit/next button near it
          const inlineSubmit = page.locator(
            'button[type="submit"], button[jsname="LgbsSe"], ' +
            'div[role="button"][jsname="LgbsSe"], #passwordNext button'
          );
          if ((await inlineSubmit.count()) > 0) {
            await inlineSubmit.first().evaluate((el: HTMLElement) => el.click());
          } else {
            await page.keyboard.press("Enter");
          }
          await logger.log("INFO", "[leave-family] Inline password submitted");
          await page.waitForTimeout(4000);
          continue;
        }

        // Check for inline TOTP field
        if (credentials.totpSecret) {
          const inlineTotp = page.locator(
            'input[type="tel"]:visible, input[name="totpPin"]:visible, input[name="Pin"]:visible'
          );
           if ((await inlineTotp.count()) > 0) {
            const curWin2 = currentTotpWindow();
            if (curWin2 <= lastUsedTotpWindow()) {
              const remaining = totpSecondsRemaining();
              await page.waitForTimeout((remaining + 1) * 1000);
            } else {
              const remaining = totpSecondsRemaining();
              if (remaining < 5) {
                await page.waitForTimeout((remaining + 1) * 1000);
              }
            }
            const code = generateTOTP(credentials.totpSecret!);
            await inlineTotp.first().fill(code);
            await logger.log("INFO", `[leave-family] Inline TOTP submitted (${code.substring(0, 2)}****)`);
            markTotpUsed();
            const inlineSubmit = page.locator(
              'button[type="submit"], #totpNext, div[id="totpNext"] button, ' +
              'button[jsname="LgbsSe"], div[role="button"][jsname="LgbsSe"]'
            );
            if ((await inlineSubmit.count()) > 0) {
              await inlineSubmit.first().evaluate((el: HTMLElement) => el.click());
            } else {
              await page.keyboard.press("Enter");
            }
            await page.waitForTimeout(4000);
            continue;
          }
        }

        break; // No re-auth detected
      }

      // Confirm leave dialog — Google shows a confirmation popup
      await page.waitForTimeout(2000);
      const CONFIRM_LEAVE_KEYWORDS = [
        "Leave", "Confirm", "Yes", "OK", "Continue",
        "退出", "確認", "确认", "是", "好",
        "確定", "続ける", "はい",
        "나가기", "확인", "예",
        "Rời khỏi", "Xác nhận", "Có",
      ];
      const confirmSelectors = CONFIRM_LEAVE_KEYWORDS.flatMap((kw) => [
        `button:has-text("${kw}")`,
        `div[role="button"]:has-text("${kw}")`,
      ]);

      const confirmBtn = page.locator(confirmSelectors.join(", "));
      for (let i = 0; i < 5; i++) {
        // Also check for re-auth between confirm attempts
        if (await checkAndHandleReAuth()) {
          await logger.log("INFO", `[leave-family] Re-auth during confirm (attempt ${i + 1})`);
          await page.waitForTimeout(3000);
          continue;
        }

        // If URL no longer contains "family/leave", the leave was processed
        const currentUrl = page.url();
        if (!currentUrl.includes("family/leave") && !currentUrl.includes("challenge")) {
          await logger.log("INFO", `[leave-family] URL changed away from leave page: ${currentUrl} — leave likely succeeded`);
          break;
        }

        const confirmCount = await confirmBtn.count();
        if (confirmCount > 0) {
          const btnText = await confirmBtn.last().textContent().catch(() => "?");
          await confirmBtn.last().evaluate((el: HTMLElement) => el.click());
          await logger.log("INFO", `Confirmed leave (attempt ${i + 1}), clicked: "${btnText?.trim()}"`);
          await page.waitForTimeout(3000);
        } else {
          await logger.log("DEBUG", `[leave-family] No confirm button found (attempt ${i + 1})`);
          break;
        }
      }

      // Verify: reload family page and check
      await page.waitForTimeout(3000);
      await page.goto(FAMILY_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(3000);
      await ensureEnglish();

      const verifyText = ((await page.textContent("body").catch(() => "")) ?? "").toLowerCase();
      const stillInFamily = IN_FAMILY_KEYWORDS.some((kw) => verifyText.includes(kw.toLowerCase()));
      const nowNotInFamily = NOT_IN_FAMILY_KEYWORDS.some((kw) => verifyText.includes(kw.toLowerCase()));

      // Also check for pending invitation on the page — if an invitation is visible,
      // the leave was successful (we left the old group and can see the new invite).
      const INVITATION_KEYWORDS = [
        "view invitation", "invitation", "you've been invited",
        "join", "accept invitation", "accept",
        "查看邀请", "邀请", "已邀请你",
        "招待", "招待状を表示",
        "초대", "초대장 보기",
        "lời mời", "xem lời mời",
      ];
      const hasInvitation = INVITATION_KEYWORDS.some((kw) => verifyText.includes(kw.toLowerCase()));

      if (stillInFamily && !nowNotInFamily && !hasInvitation) {
        await logger.log("ERROR", "Leave family FAILED — still in family group after all attempts");
        await logger.updateStatus("FAILED_RETRYABLE", {
          code: "LEAVE_FAMILY_FAILED",
          message: "Could not leave existing family group — Google may require manual password/2FA confirmation",
        });
        return false;
      } else if (hasInvitation) {
        await logger.log("INFO", "Successfully left family group ✓ (pending invitation detected on page)");
      } else {
        await logger.log("INFO", "Successfully left family group ✓");
      }
    } else {
      await logger.log("WARN", "Could not find Leave button. Continuing with accept flow...");
      await page.goto(FAMILY_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(2000);
      await ensureEnglish();
    }
  }

  // ── Ensure English before looking for invitation ──
  await ensureEnglish();

  // ── Look for pending invitation ──
  await logger.log("INFO", "Looking for pending invitation");

  const INVITE_KEYWORDS = [
    "View invitation",
    "Join",
    "Accept",
    "Accept invitation",
    "查看邀请",
    "加入",
    "接受",
    // Japanese
    "招待状を表示", "参加", "承諾",
    // Korean
    "초대장 보기", "가입", "수락",
    // Vietnamese
    "Xem lời mời", "Tham gia", "Chấp nhận",
  ];
  const inviteSelectors = INVITE_KEYWORDS.flatMap((kw) => [
    `button:has-text("${kw}")`,
    // Filter out member cards which are <a> tags to specific member IDs
    `a:not([href*="member/g"]):has-text("${kw}")`,
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
    await page.waitForTimeout(2000);
    await ensureEnglish();
  }

  // Approach 2: family details page
  if (!inviteFound) {
    await page.goto(FAMILY_DETAILS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    await ensureEnglish();

    const joinBtn2 = page.locator(inviteSelectors.join(", "));
    if ((await joinBtn2.count()) > 0) {
      await joinBtn2.first().click();
      inviteFound = true;
      await logger.log("INFO", "Clicked invite button on details page");
      await page.waitForTimeout(2000);
      await ensureEnglish();
    }
  }

  // Approach 3: Gmail
  if (!inviteFound) {
    await logger.log("INFO", "No invite button found, checking Gmail");
    await page.goto("https://mail.google.com/mail/u/0/#inbox", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const familyEmail = page.locator(
      [
        'tr:has-text("family group")',
        'tr:has-text("family")',
        'div[role="row"]:has-text("family")',
      ].join(", ")
    );
    if ((await familyEmail.count()) > 0) {
      await familyEmail.first().click();
      await page.waitForTimeout(3000);

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
            timeout: 30000,
          });
          await page.waitForTimeout(2000);
          await ensureEnglish();
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
    return false;
  }

  // ── Handle confirmation dialogs (with re-auth awareness) ──
  await logger.log("INFO", "Confirming invitation");

  const SUCCESS_MARKERS = [
    "Welcome to the family",
    "You joined",
    "You're now part of",
    "Leave family group",
    "已加入",
    "家庭成员",
    "家庭成員",
    // Japanese
    "ファミリーグループから脱退",
    // Korean
    "가족 그룹 나가기",
    // Vietnamese
    "Rời nhóm gia đình",
  ];

  for (let confirmRound = 0; confirmRound < 5; confirmRound++) {
    await page.waitForTimeout(2000);

    // Check for re-auth challenges FIRST
    const reAuthed = await checkAndHandleReAuth();
    if (reAuthed) {
      await logger.log("INFO", `[accept-invite] Re-auth handled in confirm round ${confirmRound + 1}`);
      await ensureEnglish();
      continue; // Retry this round after re-auth
    }

    const bodyText = (await page.textContent("body").catch(() => "")) ?? "";

    // Success check
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
      // Japanese
      "参加する", "参加", "承諾", "確認", "はい",
      // Korean
      "가족 그룹 가입하기", "가입", "수락", "확인", "예",
      // Vietnamese
      "Tham gia nhóm gia đình", "Tham gia", "Chấp nhận", "Xác nhận", "Có",
    ];
    const confirmSelectors = CONFIRM_KEYWORDS.flatMap((kw) => [
      // Priority 1: Real buttons
      `button:has-text("${kw}")`,
      // Priority 2: Links that are NOT member detail cards
      `a:not([href*="member/g"]):has-text("${kw}")`,
      `div[role="button"]:has-text("${kw}")`,
    ]);
    const confirmBtn = page.locator(confirmSelectors.join(", "));

    if ((await confirmBtn.count()) > 0) {
      await confirmBtn.first().evaluate((el: HTMLElement) => el.click());
      await logger.log(
        "INFO",
        `Clicked confirm button (round ${confirmRound + 1})`
      );
      await page.waitForTimeout(2000);
      await ensureEnglish();
    } else if (confirmRound >= 2) {
      await logger.log("WARN", `No confirm button found after ${confirmRound + 1} rounds — stopping`);
      break;
    }
  }

  // ── Verify success ──
  await page.goto(FAMILY_DETAILS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(2000);
  await ensureEnglish();

  // Handle re-auth on verification page
  for (let ra = 0; ra < 3; ra++) {
    if (!(await checkAndHandleReAuth())) break;
    await ensureEnglish();
  }

  const verifyText = (await page.textContent("body").catch(() => "")) ?? "";
  const isMember =
    verifyText.includes(credentials.loginEmail) ||
    verifyText.includes("Family member") ||
    verifyText.includes("Leave family group") ||
    SUCCESS_MARKERS.some((m) => verifyText.includes(m));

  if (isMember) {
    await logger.updateStatus("SUCCESS");
    await logger.log("INFO", "Successfully joined family group!");
    return true;
  } else {
    // Don't mark as SUCCESS when we can't verify membership
    await logger.updateStatus("FAILED_RETRYABLE", {
      code: "MEMBERSHIP_UNVERIFIED",
      message: "Invite flow completed but could not verify family membership",
    });
    await logger.log(
      "WARN",
      "Invite flow completed but membership could not be verified — marked as FAILED_RETRYABLE"
    );
    return false;
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
    // Update Order: only JOIN type, INVITE_SENT / WAIT_USER_ACCEPT / TASK_QUEUED → COMPLETED
    // Use findFirst + update to avoid accidentally marking multiple orders
    const latestOrder = await prisma.order.findFirst({
      where: {
        userEmail: normalized,
        orderType: "JOIN",
        status: { in: ["INVITE_SENT", "WAIT_USER_ACCEPT", "TASK_QUEUED"] },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });

    let updatedCount = 0;
    if (latestOrder) {
      await prisma.order.update({
        where: { id: latestOrder.id },
        data: {
          status: "COMPLETED",
          resultMessage: "Member accepted invite (auto-detected by accept-invite automation)",
        },
      });
      updatedCount = 1;
    }

    // Case-insensitive fallback
    if (updatedCount === 0) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Order" SET status = 'COMPLETED',
           resultMessage = 'Member accepted invite (auto-detected by accept-invite automation)',
           updatedAt = datetime('now')
         WHERE LOWER(userEmail) = ?
           AND orderType = 'JOIN'
           AND status IN ('INVITE_SENT','WAIT_USER_ACCEPT','TASK_QUEUED')
         LIMIT 1`,
        normalized
      ).catch(() => {});
    }

    if (updatedCount > 0) {
      await logger.log("INFO", `Order status synced to COMPLETED for ${email}`);
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

// ============================================================
// Shared proactive phone verification logic
// Used by both accept-invite (post-accept) and phone-verify
// ============================================================

/**
 * Proactively check if a Google account requires phone verification by
 * probing the cloudcode API with an OAuth token. If VALIDATION_REQUIRED
 * is returned, extract the validation_url and complete verification in Playwright.
 *
 * Flow:
 *   1. OAuth consent → get access_token (browser is already logged in, fast)
 *   2. Call cloudcode-pa.googleapis.com/v1internal:generateContent with token
 *   3. If 403 + VALIDATION_REQUIRED → extract validation_url from error body
 *   4. Open validation_url in Playwright → phone verification
 *   5. If 200 or non-validation 403 → account doesn't need verification
 *
 * @param setTaskStatus  If true, set the task to SUCCESS/FAILED_FINAL.
 *                       Pass false when called as a sub-step (e.g. accept-invite).
 */
async function doProactivePhoneVerification(
  page: import("playwright").Page,
  credentials: LoginCredentials,
  logger: TaskLogger,
  prisma: PrismaClient,
  taskId: string,
  phones: import("@gfa/shared").PhoneInfo[],
  setTaskStatus: boolean
): Promise<void> {
  // ── Step 1: OAuth to get access_token ──
  await logger.log("INFO", "[phone-verify] Running OAuth to get access token for API probe...");
  const token = await doOAuthForToken(page, credentials, logger);

  if (!token) {
    await logger.log("WARN", "[phone-verify] OAuth failed — cannot probe API for verification status");
    if (setTaskStatus) {
      await logger.updateStatus("FAILED_FINAL", {
        code: "OAUTH_FAILED",
        message: "Could not obtain OAuth token for verification probe",
      });
    }
    return;
  }

  await logger.log("INFO", "[phone-verify] Got access token, probing cloudcode API...");

  // ── Step 2: Probe cloudcode API ──
  const probeResult = await probeCloudCodeAPI(token.access_token, logger);

  if (!probeResult.needsVerification) {
    // Account is fine — no verification needed
    if (setTaskStatus) {
      const existingPayload = await prisma.task.findUnique({ where: { id: taskId }, select: { payload: true } });
      let payloadObj: Record<string, unknown> = {};
      try { payloadObj = JSON.parse(existingPayload?.payload ?? "{}"); } catch {}
      payloadObj.result = {
        needed: false,
        resolved: true,
        message: "Account does not require phone verification",
      };
      // Return token info so the client can use it
      payloadObj.token = {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        project_id: probeResult.projectId ?? null,
      };
      await prisma.task.update({
        where: { id: taskId },
        data: { payload: JSON.stringify(payloadObj) },
      });
      await logger.updateStatus("SUCCESS");
    }
    await logger.log("INFO", `[phone-verify] Account ${credentials.loginEmail} does not require verification`);
    return;
  }

  // ── Step 3: Need verification — open validation_url ──
  if (!probeResult.validationUrl) {
    await logger.log("WARN", "[phone-verify] VALIDATION_REQUIRED but no validation_url found in error response");
    if (setTaskStatus) {
      await logger.updateStatus("FAILED_FINAL", {
        code: "NO_VALIDATION_URL",
        message: "VALIDATION_REQUIRED detected but could not extract validation_url",
      });
    }
    return;
  }

  // Fix incomplete validationUrl — API sometimes returns &authuser without =0
  let validationUrl = probeResult.validationUrl;
  if (validationUrl.endsWith("&authuser")) {
    validationUrl += "=0";
  }

  await logger.log("INFO", `[phone-verify] Opening validation URL: ${validationUrl.substring(0, 100)}...`);
  await page.goto(validationUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // Wait for redirect — validation URL goes through signin/continue → actual verification page
  const gotoUrl = page.url();
  await Promise.race([
    page.waitForURL((url) => url.toString() !== gotoUrl, { timeout: 15000 }).catch(() => {}),
    page.locator('text=/verify|phone|number|验证/i').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {}),
    page.locator('input[type="tel"]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {}),
  ]);

  // Check where we landed
  const currentUrl = page.url();
  await logger.log("INFO", `[phone-verify] Landed on: ${currentUrl}`);

  // Check if we're on a verification page FIRST (before success check)
  if (isVerificationPage(currentUrl)) {
    await logger.log("INFO", "[phone-verify] Reached verification page — proceeding with phone verification");
  } else {
    // Check if we ended up on a success page (check pathname, not query params to avoid false positive from continue= param)
    try {
      const urlObj = new URL(currentUrl);
      if (urlObj.pathname.includes("auth_success") || urlObj.hostname.includes("myaccount.google.com")) {
        await logger.log("INFO", "[phone-verify] Landed on success page — verification may have auto-completed");
        if (setTaskStatus) {
          await logger.updateStatus("SUCCESS");
        }
        return;
      }
    } catch {}

    // Unknown page — log details but still try to proceed
    await logger.log("WARN", `[phone-verify] URL doesn't match known verification patterns, will try anyway: ${currentUrl}`);
    const pageTitle = await page.title();
    const pageText = await page.textContent("body").catch(() => "");
    await logger.log("DEBUG", `[phone-verify] Page title: ${pageTitle}, body preview: ${(pageText ?? "").substring(0, 300)}`);
  }

  // ── Step 4: Do phone verification ──
  const result = await handlePhoneVerification(page, phones, logger);

  // Store result — merge into existing payload
  const existingPayload = await prisma.task.findUnique({ where: { id: taskId }, select: { payload: true } });
  let payloadObj: Record<string, unknown> = {};
  try { payloadObj = JSON.parse(existingPayload?.payload ?? "{}"); } catch {}
  payloadObj.phoneVerifyResult = {
    needed: result.needed,
    resolved: result.resolved,
    usedPhone: result.usedPhone,
    disabledPhones: result.disabledPhones,
  };
  // Return token info so the client can use it
  payloadObj.token = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    project_id: probeResult.projectId ?? null,
  };
  if (setTaskStatus) {
    payloadObj.result = payloadObj.phoneVerifyResult;
  }

  await prisma.task.update({
    where: { id: taskId },
    data: { payload: JSON.stringify(payloadObj) },
  });

  if (result.resolved) {
    if (setTaskStatus) await logger.updateStatus("SUCCESS");
    await logger.log("INFO", `[phone-verify] ✅ Verification completed for ${credentials.loginEmail}`);
  } else {
    if (setTaskStatus) {
      await logger.updateStatus("FAILED_FINAL", {
        code: "PHONE_VERIFY_FAILED",
        message: result.error ?? "Phone verification failed",
      });
    }
    await logger.log("WARN", `[phone-verify] Verification failed: ${result.error}`);
  }
}

// ============================================================
// Cloudcode API probe — detect VALIDATION_REQUIRED
// ============================================================

/**
 * Call cloudcode-pa.googleapis.com to check if the account needs validation.
 * Returns { needsVerification, validationUrl, projectId } based on the API response.
 *
 * Two-step flow (matches Cockpit's wakeup_verification):
 *   1. loadCodeAssist → get project_id (+ auto-onboard if needed)
 *   2. streamGenerateContent → real generation probe to trigger VALIDATION_REQUIRED
 */
async function probeCloudCodeAPI(
  accessToken: string,
  logger: TaskLogger
): Promise<{ needsVerification: boolean; validationUrl?: string; projectId?: string }> {
  // ── Constants matching Cockpit ──
  const LOAD_UA = "antigravity/1.21.6 windows/amd64 google-api-nodejs-client/10.3.0";
  const STREAM_UA = "antigravity";
  const CLOUD_CODE_UA = "antigravity/1.21.6 windows/amd64";
  const METADATA = {
    ideName: "antigravity",
    ideType: "ANTIGRAVITY",
    ideVersion: "1.21.6",
    pluginVersion: "1.21.6",
    platform: "WINDOWS_AMD64",
    updateChannel: "stable",
    pluginType: "GEMINI",
  };

  // Endpoint ordering: GCP TOS accounts use prod, others use daily (matches resolve_cloud_code_base_url)
  const DAILY = "https://daily-cloudcode-pa.googleapis.com";
  const PROD = "https://cloudcode-pa.googleapis.com";
  const SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";

  // ── Step 1: loadCodeAssist → get project_id + detect GcpTos ──
  let projectId: string | undefined;
  let isGcpTos = false;

  // Try daily first for initial probe (Cockpit default)
  const loadCodeAssistBases = [DAILY, PROD, SANDBOX];
  for (const base of loadCodeAssistBases) {
    try {
      const loadResp = await fetch(`${base}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": LOAD_UA,
          "x-goog-api-client": "gl-node/22.21.1",
          "Accept": "*/*",
          "Accept-Encoding": "gzip, deflate, br",
        },
        body: JSON.stringify({ metadata: METADATA, mode: "FULL_ELIGIBILITY_CHECK" }),
        signal: AbortSignal.timeout(15000),
      });

      const loadText = await loadResp.text();
      await logger.log("DEBUG", `[phone-verify] loadCodeAssist ${loadResp.status} at ${base}: ${loadText.substring(0, 2000)}`);

      if (loadResp.ok) {
        try {
          const loadData = JSON.parse(loadText);

          // Detect GcpTos from currentTier or allowedTiers
          const currentTier = loadData?.currentTier;
          if (currentTier?.usesGcpTos) isGcpTos = true;
          const allowedTiers = loadData?.allowedTiers ?? [];
          if (!isGcpTos && allowedTiers.some((t: any) => t.usesGcpTos)) isGcpTos = true;

          // ★ Check ineligibleTiers for VALIDATION_REQUIRED — this is the definitive check!
          const ineligibleTiers = loadData?.ineligibleTiers ?? [];
          const validationEntry = ineligibleTiers.find(
            (t: any) => t.reasonCode === "VALIDATION_REQUIRED"
          );
          if (validationEntry) {
            const vUrl = validationEntry.validationUrl ?? null;
            await logger.log("INFO", `[phone-verify] loadCodeAssist → VALIDATION_REQUIRED detected! validationUrl=${vUrl ? vUrl.substring(0, 80) + "..." : "none"}`);
            // Extract project_id even if validation is required (for later use)
            const project = loadData?.cloudaicompanionProject;
            const pid = typeof project === "string" ? project : project?.id;
            return { needsVerification: true, validationUrl: vUrl ?? undefined, projectId: pid };
          }

          // Extract project_id
          const project = loadData?.cloudaicompanionProject;
          if (typeof project === "string" && project) {
            projectId = project;
          } else if (project?.id) {
            projectId = project.id;
          }

          // If no project, try onboardUser
          if (!projectId) {
            const tierId =
              allowedTiers.find((t: any) => t.isDefault)?.id ||
              allowedTiers.find((t: any) => t.id)?.id ||
              loadData?.paidTier?.id || currentTier?.id;

            if (tierId) {
              await logger.log("INFO", `[phone-verify] No project_id, onboarding with tier=${tierId} (gcpTos=${isGcpTos})`);
              const onboardHeaders = {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${accessToken}`,
                "User-Agent": LOAD_UA,
                "Accept-Encoding": "gzip",
              };
              // For GcpTos accounts, onboard on prod endpoint
              const onboardBase = isGcpTos ? PROD : base;
              const onboardResp = await fetch(`${onboardBase}/v1internal:onboardUser`, {
                method: "POST",
                headers: onboardHeaders,
                body: JSON.stringify({ tierId, metadata: METADATA }),
                signal: AbortSignal.timeout(30000),
              });
              const onboardText = await onboardResp.text();
              await logger.log("DEBUG", `[phone-verify] onboardUser ${onboardResp.status}: ${onboardText.substring(0, 300)}`);
              if (onboardResp.ok) {
                let onboardData = JSON.parse(onboardText);
                // Poll until done
                while (!onboardData?.done) {
                  const opName = onboardData?.name?.trim();
                  if (!opName) break;
                  await logger.log("DEBUG", `[phone-verify] onboardUser polling: ${opName}`);
                  await new Promise(r => setTimeout(r, 500));
                  const pollResp = await fetch(`${onboardBase}/v1internal/${opName}`, {
                    method: "GET",
                    headers: onboardHeaders,
                    signal: AbortSignal.timeout(15000),
                  });
                  if (!pollResp.ok) break;
                  onboardData = await pollResp.json();
                }
                const onboardProject = onboardData?.response?.cloudaicompanionProject;
                if (typeof onboardProject === "string" && onboardProject) projectId = onboardProject;
                else if (onboardProject?.id) projectId = onboardProject.id;
              }
            }
          }

          if (projectId) {
            await logger.log("INFO", `[phone-verify] Got project_id: ${projectId}, gcpTos=${isGcpTos}`);
            break;
          }
        } catch (parseErr) {
          await logger.log("WARN", `[phone-verify] loadCodeAssist parse error: ${parseErr}`);
        }
      }
      if (loadResp.status === 401 || loadResp.status === 403) {
        await logger.log("WARN", `[phone-verify] loadCodeAssist ${loadResp.status}`);
        break;
      }
    } catch (err) {
      await logger.log("DEBUG", `[phone-verify] loadCodeAssist error at ${base}: ${err}`);
      continue;
    }
  }

  if (!projectId) {
    await logger.log("WARN", "[phone-verify] Could not get project_id — cannot probe");
    return { needsVerification: false };
  }

  // ── Step 1.5: fetchUserInfo → the LS calls this on startup to check verification status ──
  // API: cloudcode-pa.googleapis.com/v1internal:fetchUserInfo
  // This is the API the Antigravity LS calls first — it returns user verification state
  const userInfoBases = isGcpTos ? [PROD, DAILY] : [DAILY, PROD];
  for (const base of userInfoBases) {
    try {
      const uiResp = await fetch(`${base}/v1internal:fetchUserInfo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": CLOUD_CODE_UA,
          "Accept-Encoding": "gzip",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15000),
      });
      const uiText = await uiResp.text();
      await logger.log("DEBUG", `[phone-verify] fetchUserInfo ${uiResp.status} at ${base}: ${uiText.substring(0, 2000)}`);

      if (uiResp.status === 403) {
        // Check for VALIDATION_REQUIRED in the 403 response
        if (uiText.includes("VALIDATION_REQUIRED") || uiText.includes("validation_url")) {
          await logger.log("INFO", "[phone-verify] fetchUserInfo 403 → VALIDATION_REQUIRED!");
          const validationUrl = extractValidationUrl(uiText);
          return { needsVerification: true, validationUrl: validationUrl ?? undefined, projectId };
        }
        await logger.log("INFO", `[phone-verify] fetchUserInfo 403 (possibly verification required)`);
        // Even without explicit VALIDATION_REQUIRED, a 403 on fetchUserInfo is suspicious
        const validationUrl = extractValidationUrl(uiText);
        return { needsVerification: true, validationUrl: validationUrl ?? undefined, projectId };
      }

      if (uiResp.ok) {
        // Check response body for verification-related fields
        try {
          const uiData = JSON.parse(uiText);
          // Look for any verification/validation flags in the response
          const hasValidation = uiText.includes("validation") || uiText.includes("verification") || uiText.includes("VALIDATION");
          if (hasValidation) {
            await logger.log("INFO", `[phone-verify] fetchUserInfo contains validation-related data`);
          }
        } catch {}
        await logger.log("INFO", "[phone-verify] fetchUserInfo 200 — proceeding to model check");
        break;
      }
    } catch (err) {
      await logger.log("DEBUG", `[phone-verify] fetchUserInfo error at ${base}: ${err}`);
      continue;
    }
  }

  // ── Step 2: fetchAvailableModels → check 403 ──
  // GcpTos → prod first; else → daily first (matches resolve_cloud_code_base_url)
  const probeBases = isGcpTos ? [PROD, DAILY, SANDBOX] : [DAILY, PROD, SANDBOX];

  for (const base of probeBases) {
    try {
      const resp = await fetch(`${base}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": CLOUD_CODE_UA,
          "Accept-Encoding": "gzip",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15000),
      });

      const respText = await resp.text();
      await logger.log("DEBUG", `[phone-verify] fetchModels ${resp.status} at ${base}: ${respText.substring(0, 500)}`);

      if (resp.status === 403) {
        if (respText.includes("VALIDATION_REQUIRED") || respText.includes("validation_url")) {
          await logger.log("INFO", "[phone-verify] fetchModels 403 VALIDATION_REQUIRED!");
          const validationUrl = extractValidationUrl(respText);
          return { needsVerification: true, validationUrl: validationUrl ?? undefined, projectId };
        }
        await logger.log("WARN", `[phone-verify] fetchModels 403 (not VALIDATION_REQUIRED)`);
        return { needsVerification: false, projectId };
      }

      if (resp.ok) {
        // fetchAvailableModels returned 200 — account not blocked at model listing level.
        // Proceed to streamGenerateContent for definitive check.
        await logger.log("INFO", "[phone-verify] fetchModels 200 — proceeding to generation probe");
        break;
      }

      if (resp.status === 429 || resp.status >= 500) continue;
      // 401, 404, etc. — break
      break;
    } catch (err) {
      await logger.log("DEBUG", `[phone-verify] fetchModels error at ${base}: ${err}`);
      continue;
    }
  }

  // ── Step 3: streamGenerateContent → definitive VALIDATION_REQUIRED check ──
  // Model name: "gemini-3-flash" confirmed from Cockpit's modelNames.ts / antigravityModels.ts
  const sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  const probeBody = {
    project: projectId,
    requestId: `agent/antigravity/probe/${Date.now()}`,
    model: "gemini-3-flash",
    userAgent: "antigravity",
    requestType: "agent",
    request: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      session_id: sessionId,
      systemInstruction: {
        parts: [{ text: "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding." }],
      },
      generationConfig: { temperature: 0, maxOutputTokens: 1 },
    },
  };

  for (const base of probeBases) {
    try {
      const resp = await fetch(`${base}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": STREAM_UA,
          "Accept-Encoding": "gzip",
        },
        body: JSON.stringify(probeBody),
        signal: AbortSignal.timeout(30000),
      });

      const respText = await resp.text();
      await logger.log("DEBUG", `[phone-verify] generateContent ${resp.status} at ${base}: ${respText.substring(0, 500)}`);

      if (resp.ok) {
        await logger.log("INFO", "[phone-verify] generateContent 200 — account verified OK");
        return { needsVerification: false, projectId };
      }

      if (resp.status === 403) {
        if (respText.includes("VALIDATION_REQUIRED") || respText.includes("validation_url")) {
          await logger.log("INFO", "[phone-verify] generateContent 403 VALIDATION_REQUIRED!");
          const validationUrl = extractValidationUrl(respText);
          return { needsVerification: true, validationUrl: validationUrl ?? undefined, projectId };
        }
        await logger.log("WARN", `[phone-verify] generateContent 403 (not VALIDATION_REQUIRED): ${respText.substring(0, 200)}`);
        return { needsVerification: false, projectId };
      }

      if (resp.status === 401) {
        await logger.log("WARN", "[phone-verify] generateContent 401 — token expired");
        return { needsVerification: false, projectId };
      }

      // 404/429/500 → try next endpoint
      if (resp.status === 404 || resp.status === 429 || resp.status >= 500) {
        await logger.log("DEBUG", `[phone-verify] generateContent ${resp.status}, trying next endpoint`);
        continue;
      }

      await logger.log("INFO", `[phone-verify] generateContent ${resp.status} — not blocked`);
      return { needsVerification: false, projectId };
    } catch (err) {
      await logger.log("DEBUG", `[phone-verify] generateContent error at ${base}: ${err}`);
      continue;
    }
  }

  await logger.log("WARN", "[phone-verify] All generateContent endpoints failed");
  return { needsVerification: false, projectId };
}

/**
 * Extract validation_url from a Google API error response body.
 * Matches the extraction logic in Antigravity-Manager's token_manager.rs.
 */
function extractValidationUrl(errorText: string): string | null {
  try {
    const parsed = JSON.parse(errorText);

    // Structured path: error.details[].metadata.validation_url
    const details = parsed?.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        const url = detail?.metadata?.validation_url;
        if (url && typeof url === "string") {
          return url.replace(/\\u0026/g, "&");
        }
      }
    }

    // Top-level fallback
    if (parsed?.validation_url) {
      return String(parsed.validation_url).replace(/\\u0026/g, "&");
    }
  } catch {
    // Not JSON — try regex
  }

  // Regex fallback: any Google accounts URL
  const urlMatch = errorText.match(/https:\/\/accounts\.google\.com\/[^\s"'\\]+/);
  if (urlMatch) {
    return urlMatch[0].replace(/\\u0026/g, "&");
  }

  return null;
}

// ============================================================
// Dedicated phone verification handler
// ============================================================

/**
 * Handle the dedicated phone-verify action.
 */
async function handlePhoneVerifyAction(
  page: import("playwright").Page,
  credentials: LoginCredentials,
  logger: TaskLogger,
  prisma: PrismaClient,
  taskId: string,
  phones?: import("@gfa/shared").PhoneInfo[]
): Promise<void> {
  await logger.log("INFO", "Starting dedicated phone verification flow");

  if (!phones || phones.length === 0) {
    await logger.updateStatus("FAILED_FINAL", {
      code: "NO_PHONES",
      message: "No phone numbers provided for verification",
    });
    return;
  }

  await doProactivePhoneVerification(page, credentials, logger, prisma, taskId, phones, true);
}

