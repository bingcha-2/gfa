/**
 * Debug script: Extract the exact secret from the "Can't scan it?" page.
 * Shows all regex matches and the full page text for analysis.
 */
import * as dotenv from "dotenv";
import { resolve } from "path";
dotenv.config({ path: resolve(__dirname, "../../.env") });

import { chromium } from "playwright";
import { AdsPowerClient } from "./src/adspower-client";
import { gmailLogin } from "./src/gmail-login";
import { generateTOTP, sanitiseBase32 } from "./src/totp";

const PROFILE_ID = process.env.ADSPOWER_POOL_IDS?.split(",")[0]?.trim() ?? "40";
const ADSPOWER_HOST = process.env.ADSPOWER_HOST ?? "http://127.0.0.1:50325";
const ADSPOWER_KEY = process.env.ADSPOWER_API_KEY;

import { PrismaClient } from "@prisma/client";

const logger: any = {
  log: async (level: string, msg: string) => console.log(`[${level}] ${msg}`),
  updateStatus: async () => {},
  recordScreenshot: async () => {},
};

async function main() {
  const prisma = new PrismaClient();
  const account = await prisma.account.findFirst({
    where: { status: "HEALTHY", totpSecret: { not: null }, loginPassword: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  if (!account) { console.error("No account"); process.exit(1); }

  const adspower = new AdsPowerClient({ baseUrl: ADSPOWER_HOST, apiKey: ADSPOWER_KEY });
  const { debugUrl } = await adspower.openProfile(PROFILE_ID);
  const browser = await chromium.connectOverCDP(debugUrl);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("No context");
  await ctx.clearCookies();
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    // Login
    await page.goto("https://accounts.google.com?hl=en", { waitUntil: "domcontentloaded", timeout: 60_000 });
    const lr = await gmailLogin(page, account, logger);
    if (!lr.success) { console.error("Login failed"); process.exit(1); }
    console.log("✅ Login OK\n");

    // Navigate to authenticator
    await page.goto("https://myaccount.google.com/two-step-verification/authenticator?hl=en", {
      waitUntil: "domcontentloaded", timeout: 60_000,
    });
    await page.waitForTimeout(3000);

    // Click Change
    await page.locator('button:has-text("Change authenticator app")').first().click();
    await page.waitForTimeout(4000);

    // Click Can't scan
    const cantScan = page.locator(`button:has-text("Can\u2019t scan it"), button:has-text("Can't scan it")`);
    await cantScan.first().click();
    await page.waitForTimeout(3000);

    // Now dump the EXACT page text
    const pageData = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";
      
      // Find ALL text nodes that might contain the secret
      const allTexts: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent?.trim();
        if (text && text.length > 10) {
          allTexts.push(text);
        }
      }

      // Also get all input/code/pre elements
      const specialEls = Array.from(document.querySelectorAll("input, code, pre, [data-text], span[class]"))
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          text: (el as HTMLElement).innerText?.trim()?.slice(0, 200),
          value: (el as HTMLInputElement).value?.slice(0, 200),
          className: el.className?.slice(0, 100),
        }))
        .filter(e => e.text || e.value);

      return { bodyText, allTexts, specialEls };
    });

    console.log("═══ FULL BODY TEXT ═══");
    console.log(pageData.bodyText);
    console.log("\n═══ TEXT NODES (>10 chars) ═══");
    for (const t of pageData.allTexts) {
      console.log(`  "${t}"`);
    }
    console.log("\n═══ SPECIAL ELEMENTS ═══");
    for (const el of pageData.specialEls) {
      console.log(`  [${el.tag}] class="${el.className}" text="${el.text}" value="${el.value}"`);
    }

    // Test regex matching
    const bodyText = pageData.bodyText;
    
    // Spaced regex (current)
    const spacedRegex = /([a-zA-Z2-7]{4}\s+){3,}[a-zA-Z2-7]{4}/g;
    let m;
    console.log("\n═══ SPACED REGEX MATCHES ═══");
    while ((m = spacedRegex.exec(bodyText)) !== null) {
      const raw = m[0].replace(/\s/g, "").toUpperCase();
      console.log(`  Match: "${m[0]}"`);
      console.log(`  → Cleaned: "${raw}" (len=${raw.length})`);
      try {
        const sanitized = sanitiseBase32(raw);
        console.log(`  → Sanitized: "${sanitized}"`);
        const totp = generateTOTP(sanitized);
        console.log(`  → TOTP: ${totp}`);
      } catch (e) {
        console.log(`  → sanitiseBase32 ERROR: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Click Cancel to not actually change anything
    await page.locator('button:has-text("Cancel")').first().click().catch(() => {});
    console.log("\n✅ Done (cancelled, no changes made)");

  } finally {
    await browser.close().catch(() => {});
    await adspower.closeProfile(PROFILE_ID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch(err => { console.error("❌ Failed:", err.message); process.exit(1); });
