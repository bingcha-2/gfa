/**
 * Smoke test — Google One family sharing toggle
 * Account: GrobyGilchrest@gmail.com (has Google One subscription)
 */
import * as dotenv from "dotenv";
import { resolve } from "path";
import * as fs from "fs";

dotenv.config({ path: resolve(__dirname, "../../.env") });

import { chromium } from "playwright";
import { AdsPowerClient } from "./src/adspower-client";
import { gmailLogin } from "./src/gmail-login";
import { ensureGoogleOneSharing } from "./src/ensure-google-one-sharing";

const ACCOUNT = {
  id:            "smoke-google-one",
  loginEmail:    "GrobyGilchrest@gmail.com",
  loginPassword: "7pgkuspyhj",
  totpSecret:    "aep4 yien tngz limc 4zut qj6u vigg yjt6",
};

const PROFILE_ID     = process.env.ADSPOWER_POOL_IDS?.split(",")[0]?.trim() ?? "40";
const ADSPOWER_HOST  = process.env.ADSPOWER_HOST ?? "http://127.0.0.1:50354";
const ADSPOWER_KEY   = process.env.ADSPOWER_API_KEY;
const SCREENSHOT_DIR = "C:/tmp/smoke-screenshots";

const logger: any = {
  log: async (level: string, msg: string) => {
    const ts = new Date().toISOString().substring(11, 23);
    console.log(`[${ts}][${level}] ${msg}`);
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
  console.log(`\n🚀 Google One Toggle Smoke Test — ${ACCOUNT.loginEmail}\n`);

  const adspower = new AdsPowerClient({
    baseUrl: ADSPOWER_HOST,
    apiKey: ADSPOWER_KEY,
    maxRetries: 2,
    retryDelayMs: 2000,
  });

  console.log(`[1/4] Opening AdsPower profile ${PROFILE_ID}...`);
  const { debugUrl } = await adspower.openProfile(PROFILE_ID);
  console.log(`      ${debugUrl}`);

  const browser  = await chromium.connectOverCDP(debugUrl);
  const contexts = browser.contexts();
  if (!contexts.length) throw new Error("No browser contexts");

  // Clear session
  console.log(`[2/4] Clearing session...`);
  await contexts[0].clearCookies();
  const initPage = contexts[0].pages()[0] ?? await contexts[0].newPage();
  await initPage.goto("https://accounts.google.com", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await initPage.evaluate(() => { try { localStorage.clear(); } catch {} try { sessionStorage.clear(); } catch {} });
  const page = contexts[0].pages()[0] ?? await contexts[0].newPage();
  console.log(`      ✅`);

  try {
    // ── Login ──────────────────────────────────────────────────────────────────
    console.log(`[3/4] Gmail login...`);
    const loginResult = await gmailLogin(page, ACCOUNT, logger);
    if (!loginResult.success) {
      console.error(`❌ Login failed: ${loginResult.reason} — ${loginResult.detail}`);
      process.exit(1);
    }
    console.log(`      Login ✅\n`);
    await shot(page, "after-login");

    // ── Test ensureGoogleOneSharing ────────────────────────────────────────────
    console.log(`[4/4] Testing ensureGoogleOneSharing...`);
    const result = await ensureGoogleOneSharing(page, logger);
    console.log(`\n✅ Result:`, JSON.stringify(result, null, 2));
    await shot(page, "after-sharing");

    // ── Dump settings page toggles ─────────────────────────────────────────────
    await page.goto("https://one.google.com/u/0/settings", { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(4000);
    await shot(page, "google-one-settings-final");

    const toggles = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role=switch], [aria-checked], button, [role=button]'))
        .map(el => ({
          tag: el.tagName,
          role: el.getAttribute("role"),
          cls: (el.className ?? "").substring(0, 80),
          ariaLabel: el.getAttribute("aria-label"),
          ariaChecked: el.getAttribute("aria-checked"),
          text: ((el as HTMLElement).innerText || el.textContent || "").trim().slice(0, 60),
          visible: !!((el as HTMLElement).offsetWidth || (el as HTMLElement).offsetHeight),
        }))
        .filter(x => x.visible)
    );

    fs.writeFileSync(`${SCREENSHOT_DIR}/google-one-toggles.json`, JSON.stringify(toggles, null, 2), "utf8");
    console.log(`\n  📦 Visible toggles (${toggles.length}):\n${JSON.stringify(toggles, null, 2)}`);
    console.log(`  📄 Saved to: ${SCREENSHOT_DIR}/google-one-toggles.json`);

  } finally {
    // Close extra tabs before disconnecting
    try {
      for (const ctx of browser.contexts()) {
        const pages = ctx.pages();
        if (pages.length > 0) {
          await pages[0].goto("about:blank", { timeout: 5_000 }).catch(() => {});
          for (let i = 1; i < pages.length; i++) await pages[i].close().catch(() => {});
        }
      }
    } catch {}
    await browser.close().catch(() => {});
    await adspower.closeProfile(PROFILE_ID).catch(() => {});
  }
}

main().catch(err => {
  console.error("\n❌ Failed:", err.message ?? err);
  process.exit(1);
});
