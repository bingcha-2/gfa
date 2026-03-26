import * as dotenv from "dotenv";
import { resolve } from "path";
import * as fs from "fs";

dotenv.config({ path: resolve(__dirname, "../../.env") });

import { chromium } from "playwright";
import { AdsPowerClient } from "./src/adspower-client";
import { gmailLogin } from "./src/gmail-login";
import { ensureFamilyGroup } from "./src/ensure-family-group";
import { PrismaClient } from "@prisma/client";

const ACCOUNT = {
  id:            "smoke-test-001",   // NOTE: not a real DB id — DB step will fail (expected in smoke mode)
  loginEmail:    "GellmanScuderi970@gmail.com",
  loginPassword: "merk0wfxuma",
  totpSecret:    "dvqrnkbowtqhgioleov6mdpgw5eqf2q7",
};

const PROFILE_ID     = process.env.ADSPOWER_POOL_IDS?.split(",")[0]?.trim() ?? "40";
const ADSPOWER_HOST  = process.env.ADSPOWER_HOST ?? "http://127.0.0.1:50354";
const ADSPOWER_KEY   = process.env.ADSPOWER_API_KEY;
const SCREENSHOT_DIR = "C:/tmp/smoke-screenshots";

const logger: any = {
  log: async (level: string, msg: string, extra?: any) => {
    const ts = new Date().toISOString().substring(11, 23);
    console.log(`[${ts}][${level}] ${msg}`, extra ? JSON.stringify(extra) : "");
  },
  updateStatus: async () => {},
  recordScreenshot: async () => {},
};

async function shot(page: import("playwright").Page, label: string) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const p = `${SCREENSHOT_DIR}/${label}-${Date.now()}.png`;
  await page.screenshot({ path: p, fullPage: true });
  console.log(`  📸 ${p}`);
}

async function main() {
  console.log(`\n🚀 Smoke Test — profile:${PROFILE_ID} account:${ACCOUNT.loginEmail}\n`);

  const adspower = new AdsPowerClient({ baseUrl: ADSPOWER_HOST, apiKey: ADSPOWER_KEY, maxRetries: 2, retryDelayMs: 2000 });
  const prisma   = new PrismaClient();

  console.log(`[1/5] Opening profile ${PROFILE_ID}...`);
  const { debugUrl } = await adspower.openProfile(PROFILE_ID);
  console.log(`      ${debugUrl}`);

  console.log(`[2/5] Playwright CDP connect...`);
  const browser  = await chromium.connectOverCDP(debugUrl);
  const contexts = browser.contexts();
  if (!contexts.length) throw new Error("No browser contexts");

  console.log(`[3/5] Clearing session (cookies + localStorage)...`);
  await contexts[0].clearCookies();
  const initPages = contexts[0].pages();
  const initPage  = initPages.length > 0 ? initPages[0] : await contexts[0].newPage();
  try {
    await initPage.goto("https://accounts.google.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await initPage.evaluate(() => { try { localStorage.clear(); } catch {} try { sessionStorage.clear(); } catch {} });
  } catch { console.log("      (localStorage clear timed out — cookies still cleared)"); }
  const allPages = contexts[0].pages();
  const page     = allPages.length > 0 ? allPages[0] : await contexts[0].newPage();
  console.log(`      ✅`);

  try {
    console.log(`\n[4/5] Gmail login...`);
    const loginResult = await gmailLogin(page, ACCOUNT, logger);
    if (!loginResult.success) {
      console.error(`❌ Login failed: ${loginResult.reason} — ${loginResult.detail}`);
      process.exit(1);
    }
    console.log(`      Login ✅\n`);

    // ── Pre-flight: screenshot of family/details state ──────────────────────
    await page.goto("https://myaccount.google.com/family/details", { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(1500);
    await shot(page, "before-ensure");
    const beforeText = await page.evaluate(() => document.body.innerText.slice(0, 400));
    console.log(`\n  📄 Before state:\n${beforeText}\n`);

    // ── Run ensureFamilyGroup (full chain including Google One sharing) ──────
    console.log(`[5/5] Running ensureFamilyGroup...`);
    const result = await ensureFamilyGroup(page, ACCOUNT, prisma, logger);
    console.log(`\n✅ DONE! familyGroupId = ${result.familyGroupId}`);

    // ── Post-flight screenshot ──────────────────────────────────────────────
    await page.goto("https://myaccount.google.com/family/details", { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(2000);
    await shot(page, "after-ensure");

    await page.goto("https://one.google.com/about", { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(2000);
    await shot(page, "google-one-status");
    const oneText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log(`\n  📄 Google One state:\n${oneText}`);

  } finally {
    await browser.close().catch(() => {});
    await adspower.closeProfile(PROFILE_ID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("\n❌ Script failed:", err.message ?? err);
  process.exit(1);
});
