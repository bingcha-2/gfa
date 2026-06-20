import { config } from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";

import { AdsPowerClient } from "../src/adspower-client";
import { BrowserPool } from "../src/browser-pool";
import { WorkerBrowser } from "../src/browser-context";
import { gmailLogin } from "../src/gmail-login";
import { TaskLogger } from "../src/task-logger";

type CliOptions = {
  email?: string;
  profileId: string;
  holdMs: number;
  closeOnSuccess: boolean;
};

const repoRoot = path.resolve(__dirname, "../../..");
config({ path: path.join(repoRoot, ".env") });

process.env.DATABASE_URL = process.env.DATABASE_URL?.startsWith("file:")
  ? process.env.DATABASE_URL
  : "file:D:/GFA-per/prisma/dev.db";
process.env.ROSETTA_DATA_DIR = "D:/GFA-data/rosetta";

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    profileId: "k1cde219",
    holdMs: 30 * 60 * 1000,
    closeOnSuccess: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--email") {
      opts.email = requireValue(arg, next).toLowerCase();
      i++;
    } else if (arg === "--profile") {
      opts.profileId = requireValue(arg, next);
      i++;
    } else if (arg === "--hold-ms") {
      opts.holdMs = Number(requireValue(arg, next));
      i++;
    } else if (arg === "--close-on-success") {
      opts.closeOnSuccess = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.holdMs) || opts.holdMs < 30_000) {
    throw new Error("--hold-ms must be at least 30000");
  }

  return opts;
}

function requireValue(flag: string, value?: string): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!domain) return "(bad-email)";
  return `${name.slice(0, 2)}***${name.slice(-2)}@${domain}`;
}

function sanitize(value: unknown): string {
  return String(value ?? "")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (email) => maskEmail(email))
    .replace(/https:\/\/accounts\.google\.com[^\s"']+/g, "<google-accounts-url>")
    .slice(0, 800);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function selectCandidate(prisma: PrismaClient, requestedEmail?: string) {
  const dataFile = process.env.ROSETTA_DATA_DIR
    ? path.join(process.env.ROSETTA_DATA_DIR, "adspower-import.json")
    : "D:/GFA-data/rosetta/adspower-import.json";
  const batch = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const items: any[] = Array.isArray(batch.items) ? batch.items : [];

  const failedEmails = [...new Set(items
    .filter((item) =>
      item.status === "failed" &&
      /hiddenPassword|Password input never became visible|transient/i.test(String(item.error || ""))
    )
    .map((item) => String(item.email || "").toLowerCase())
    .filter(Boolean))];

  const emails = requestedEmail ? [requestedEmail] : failedEmails;
  const accounts = await prisma.agentAccount.findMany({
    where: { loginEmail: { in: emails } },
    select: {
      id: true,
      loginEmail: true,
      loginPassword: true,
      recoveryEmail: true,
      totpSecret: true,
      refreshToken: true,
      status: true,
    },
  });
  const byEmail = new Map(accounts.map((account) => [account.loginEmail.toLowerCase(), account]));
  const selected = emails.map((email) => byEmail.get(email)).find((account) => account && !account.refreshToken);
  if (!selected) {
    throw new Error(requestedEmail
      ? `No failed/no-token AgentAccount found for ${maskEmail(requestedEmail)}`
      : "No failed/no-token AgentAccount candidate found");
  }
  return selected;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const workerId = `diag-stop-${Date.now().toString(36)}`;
  const stopFile = path.join(repoRoot, ".tmp", `${workerId}.stop`);
  const prisma = new PrismaClient();
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const adspower = new AdsPowerClient({
    baseUrl: process.env.ADSPOWER_HOST || "http://127.0.0.1:50325",
    apiKey: process.env.ADSPOWER_API_KEY || "",
    maxRetries: 3,
    retryDelayMs: 3000,
  });
  const pool = new BrowserPool(redis);
  const browser = new WorkerBrowser();

  let stopHeartbeat: (() => void) | undefined;
  let taskId = "";
  let accountLockKey = "";
  let acquiredProfile = "";
  let closeProfileOnExit = false;

  try {
    const account = await selectCandidate(prisma, opts.email);
    accountLockKey = `email:${account.loginEmail.toLowerCase()}`;

    const task = await prisma.task.create({
      data: {
        type: "OAUTH_AUTHORIZE" as any,
        status: "PENDING" as any,
        source: "rosetta-account-auto-import-stop-diagnostic",
        payload: JSON.stringify({
          action: "oauth",
          email: account.loginEmail,
          profileId: opts.profileId,
          diagnostic: "stop-on-login-failure",
        }),
      },
    });
    taskId = task.id;
    const logger = new TaskLogger(prisma, task.id, workerId);

    console.log(`[diag] selected ${maskEmail(account.loginEmail)} task=${task.id} profile=${opts.profileId}`);
    const acquired = await pool.acquireSpecificAndOpen(workerId, accountLockKey, opts.profileId, adspower);
    acquiredProfile = acquired.profileId;
    stopHeartbeat = pool.startHeartbeat(acquired.profileId, accountLockKey, workerId);
    await logger.log("INFO", `[diagnostic] Acquired profile ${acquired.profileId}; browser will stay open at failure.`);
    await logger.updateStatus("RUNNING");

    const page = await browser.connect(acquired.debugUrl);
    const result = await gmailLogin(
      page,
      {
        loginEmail: account.loginEmail,
        loginPassword: account.loginPassword,
        recoveryEmail: account.recoveryEmail,
        totpSecret: account.totpSecret,
      },
      logger,
      {
        manualChallengeWaitMs: 0,
        skipPhoneChallengeManualWait: true,
        skipCaptchaManualWait: true,
      },
    );

    const currentUrl = page.url();
    const pwdFields = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="password"]')).map((element) => ({
        name: element.getAttribute("name"),
        ariaHidden: element.getAttribute("aria-hidden"),
        visible: (element as HTMLElement).offsetParent !== null,
      })),
    ).catch((err) => [{ error: err instanceof Error ? err.message : String(err) }]);
    const title = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    const screenshotDir = path.join(repoRoot, ".tmp", "adspower-stop-diagnostic");
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `${task.id}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 5000 }).catch(() => undefined);

    await logger.log("WARN", `[diagnostic] stopped with result=${JSON.stringify(result)}`);
    await logger.log("INFO", `[diagnostic] currentUrl=${currentUrl}`);
    await logger.updateStatus(result.success ? "SUCCESS" : "MANUAL_REVIEW", result.success
      ? undefined
      : { code: result.reason, message: result.detail });
    closeProfileOnExit = (result.success && opts.closeOnSuccess) ||
      (!result.success && /TOTP secret appears invalid/i.test(result.detail));

    console.log(JSON.stringify({
      phase: "stopped",
      email: maskEmail(account.loginEmail),
      taskId: task.id,
      profileId: acquired.profileId,
      result: result.success ? { success: true } : { success: false, reason: result.reason, detail: sanitize(result.detail) },
      currentUrl: sanitize(currentUrl),
      title: sanitize(title),
      pwdFields,
      bodySnippet: sanitize(bodyText).slice(0, 1000),
      screenshotPath,
      stopFile,
      holdMs: opts.holdMs,
      closeProfileOnExit,
    }, null, 2));

    if (closeProfileOnExit) {
      console.log(result.success
        ? "[diag] Login succeeded; closing browser because --close-on-success is set."
        : "[diag] TOTP rejected on first attempt; closing browser immediately.");
    } else {
      const deadline = Date.now() + opts.holdMs;
      console.log(`[diag] browser is open. Create stop file to release locks: ${stopFile}`);
      while (Date.now() < deadline && !fs.existsSync(stopFile)) {
        await sleep(5000);
      }
      console.log("[diag] hold finished; leaving AdsPower browser open and releasing Redis locks.");
    }
  } finally {
    stopHeartbeat?.();
    if (closeProfileOnExit && acquiredProfile) {
      await browser.disconnect().catch(() => undefined);
      await adspower.closeProfile(acquiredProfile).catch(() => undefined);
    }
    if (acquiredProfile) {
      await pool.release(acquiredProfile, workerId).catch(() => undefined);
    }
    if (accountLockKey) {
      await pool.releaseAccount(accountLockKey, workerId).catch(() => undefined);
    }
    await prisma.$disconnect().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    if (taskId) {
      console.log(`[diag] task=${taskId}`);
    }
  }
}

main().catch((err) => {
  console.error(`[diag] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
