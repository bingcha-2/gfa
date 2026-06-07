/**
 * Smoke test for the change2FA flow.
 *
 * Usage:
 *   npx tsx apps/worker/smoke-change-2fa.ts [email] [--dry-run]
 *
 * If no email is given, the first HEALTHY account with a totpSecret is used.
 * --dry-run  shows the flow without actually completing verification (stops after secret extraction).
 */

import * as dotenv from "dotenv";
import { resolve } from "path";
import * as fs from "fs";
import * as readline from "readline";

dotenv.config({ path: resolve(__dirname, "../../.env") });

import { chromium } from "playwright";
import { AdsPowerClient } from "./src/adspower-client";
import { gmailLogin } from "./src/gmail-login";
import { change2FA } from "./src/change-2fa";
import { PrismaClient } from "@prisma/client";

// ── CLI args ──
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const emailArg = args.find((a) => !a.startsWith("--"));

// ── Config ──
const PROFILE_ID = process.env.ADSPOWER_POOL_IDS?.split(",")[0]?.trim() ?? "40";
const ADSPOWER_HOST = process.env.ADSPOWER_HOST ?? "http://127.0.0.1:50325";
const ADSPOWER_KEY = process.env.ADSPOWER_API_KEY;
const SCREENSHOT_DIR = "C:/tmp/smoke-change-2fa";

// ── Minimal logger ──
const logger: any = {
  log: async (level: string, msg: string, extra?: any) => {
    const ts = new Date().toISOString().substring(11, 23);
    console.log(`[${ts}][${level}] ${msg}`, extra ? JSON.stringify(extra) : "");
  },
  updateStatus: async () => {},
  recordScreenshot: async () => {},
};

// ── Screenshot helper ──
async function shot(page: import("playwright").Page, label: string) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const p = `${SCREENSHOT_DIR}/${label}-${Date.now()}.png`;
  await page.screenshot({ path: p, fullPage: true });
  console.log(`  📸 ${p}`);
}

// ── Readline helper ──
function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Main ──
async function main() {
  const prisma = new PrismaClient();

  // ── Resolve account ──
  let account: {
    id: string;
    loginEmail: string;
    loginPassword: string;
    totpSecret: string;
  };

  if (emailArg) {
    const row = await prisma.account.findFirst({
      where: { loginEmail: emailArg },
    });
    if (!row) {
      console.error(`❌ Account not found in DB: ${emailArg}`);
      process.exit(1);
    }
    if (!row.loginPassword) {
      console.error(`❌ Account ${emailArg} has no loginPassword`);
      process.exit(1);
    }
    if (!row.totpSecret) {
      console.error(`❌ Account ${emailArg} has no totpSecret`);
      process.exit(1);
    }
    account = {
      id: row.id,
      loginEmail: row.loginEmail,
      loginPassword: row.loginPassword,
      totpSecret: row.totpSecret,
    };
  } else {
    const row = await prisma.account.findFirst({
      where: {
        status: "HEALTHY",
        totpSecret: { not: null },
        loginPassword: { not: null },
      },
      orderBy: { createdAt: "asc" },
    });
    if (!row || !row.loginPassword || !row.totpSecret) {
      console.error("❌ No HEALTHY account with totpSecret found in DB");
      process.exit(1);
    }
    account = {
      id: row.id,
      loginEmail: row.loginEmail,
      loginPassword: row.loginPassword,
      totpSecret: row.totpSecret,
    };
  }

  console.log(`\n🚀 Smoke Test — change2FA${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log(`   profile: ${PROFILE_ID}`);
  console.log(`   account: ${account.loginEmail}`);
  console.log(`   old totp: ${account.totpSecret.slice(0, 4)}****\n`);

  const adspower = new AdsPowerClient({ baseUrl: ADSPOWER_HOST, apiKey: ADSPOWER_KEY, maxRetries: 2, retryDelayMs: 2000 });
  let browser: import("playwright").Browser | null = null;

  try {
    // ── Step 1: Open AdsPower profile ──
    console.log(`[1/5] Opening profile ${PROFILE_ID}...`);
    const { debugUrl } = await adspower.openProfile(PROFILE_ID);
    console.log(`      ${debugUrl}`);

    // ── Step 2: Connect Playwright ──
    console.log(`[2/5] Playwright CDP connect...`);
    browser = await chromium.connectOverCDP(debugUrl);
    const contexts = browser.contexts();
    if (!contexts.length) throw new Error("No browser contexts");

    // ── Step 3: Clear session ──
    console.log(`[3/5] Clearing session (cookies + localStorage)...`);
    await contexts[0].clearCookies();
    const initPages = contexts[0].pages();
    const initPage = initPages.length > 0 ? initPages[0] : await contexts[0].newPage();
    try {
      await initPage.goto("https://accounts.google.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
      await initPage.evaluate(() => { try { localStorage.clear(); } catch {} try { sessionStorage.clear(); } catch {} });
    } catch { console.log("      (localStorage clear timed out — cookies still cleared)"); }
    const allPages = contexts[0].pages();
    const page = allPages.length > 0 ? allPages[0] : await contexts[0].newPage();
    console.log(`      ✅`);

    // ── Step 4: Gmail login ──
    console.log(`\n[4/5] Gmail login...`);
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      console.error(`❌ Login failed: ${loginResult.reason} — ${loginResult.detail}`);
      await shot(page, "login-failed");
      process.exit(1);
    }
    console.log(`      Login ✅`);
    await shot(page, "after-login");

    // ── Step 5: Change 2FA ──
    if (DRY_RUN) {
      console.log(`\n[5/5] DRY RUN — navigating to Authenticator page but NOT completing verification...`);
      await page.goto("https://myaccount.google.com/two-step-verification/authenticator?hl=en", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(3000);
      await shot(page, "dry-run-authenticator-page");
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || "");
      console.log(`\n  📄 Authenticator page state:\n${bodyText}\n`);
      console.log(`\n✅ DRY RUN complete — no changes made.`);
    } else {
      console.log(`\n[5/5] Running change2FA...`);
      const result = await change2FA(page, account, logger);
      await shot(page, "after-change-2fa");

      if (result.success) {
        console.log(`\n✅ 2FA changed successfully!`);
        console.log(`   New TOTP secret: ${result.newTotpSecret}`);
        console.log(`   Old TOTP secret: ${account.totpSecret}`);

        // ── Ask to update DB ──
        const answer = await ask(`\n🔄 Update DB with new secret? (y/N): `);
        if (answer.toLowerCase() === "y") {
          await prisma.account.update({
            where: { id: account.id },
            data: { totpSecret: result.newTotpSecret },
          });
          console.log(`   ✅ DB updated for ${account.loginEmail}`);
        } else {
          console.log(`   ⏭️  DB not updated. New secret: ${result.newTotpSecret}`);
        }
      } else {
        console.error(`\n❌ change2FA failed!`);
        console.error(`   reason: ${result.reason}`);
        console.error(`   detail: ${result.detail}`);
        await shot(page, "change-2fa-failed");
        process.exit(1);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await adspower.closeProfile(PROFILE_ID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("\n❌ Script failed:", err.message ?? err);
  process.exit(1);
});
