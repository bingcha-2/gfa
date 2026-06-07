/**
 * 2FA 修改完整流程探索 (Phase 3 - 最终版)
 * 
 * 完整走完: Login → 2FA page → Authenticator → Change → Can't scan → 提取密钥 → 验证码 → 完成
 * 
 * Usage: npx tsx apps/worker/explore-2fa-phase3.ts
 */

import * as dotenv from "dotenv";
import { resolve } from "path";
import * as fs from "fs";
import * as readline from "readline";

dotenv.config({ path: resolve(__dirname, "../../.env") });

import { chromium, Page } from "playwright";
import { PrismaClient } from "@prisma/client";
import { AdsPowerClient } from "./src/adspower-client";
import { gmailLogin } from "./src/gmail-login";
import { handleReAuthLoop, isReAuthPage } from "./src/handle-reauth";
import { generateTOTP } from "./src/totp";

const PROFILE_ID    = process.env.ADSPOWER_POOL_IDS?.split(",")[0]?.trim() ?? "40";
const ADSPOWER_HOST = process.env.ADSPOWER_HOST ?? "http://127.0.0.1:50325";
const ADSPOWER_KEY  = process.env.ADSPOWER_API_KEY;
const SCREENSHOT_DIR = "C:/tmp/2fa-explore-p3";

const logger: any = {
  log: async (level: string, msg: string, extra?: any) => {
    const ts = new Date().toISOString().substring(11, 23);
    console.log(`  [${ts}][${level}] ${msg}`, extra ? JSON.stringify(extra) : "");
  },
  updateStatus: async () => {},
  recordScreenshot: async () => {},
};

let shotCounter = 0;

async function shot(page: Page, label: string): Promise<string> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  shotCounter++;
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${String(shotCounter).padStart(2, "0")}-${safeLabel}-${Date.now()}.png`;
  const filepath = `${SCREENSHOT_DIR}/${filename}`;
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`  📸 ${filepath}`);
  return filepath;
}

async function dumpPage(page: Page, label: string) {
  const info = await page.evaluate(() => {
    const interactive = Array.from(document.querySelectorAll(
      'a, button, input, select, textarea, [role="button"], [role="link"]'
    )).filter(el => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).slice(0, 40).map(el => {
      const h = el as HTMLElement;
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        type: el.getAttribute("type"),
        id: el.id?.slice(0, 40),
        text: h.innerText?.trim().slice(0, 120),
        ariaLabel: el.getAttribute("aria-label")?.slice(0, 80),
        href: el.getAttribute("href")?.slice(0, 120),
        name: el.getAttribute("name"),
        placeholder: el.getAttribute("placeholder"),
      };
    });

    const images = Array.from(document.querySelectorAll("img, canvas, svg")).map(el => ({
      tag: el.tagName.toLowerCase(),
      src: (el as HTMLImageElement).src?.slice(0, 200),
      alt: el.getAttribute("alt"),
      width: (el as HTMLElement).offsetWidth,
      height: (el as HTMLElement).offsetHeight,
    })).filter(img => img.width > 30 && img.height > 30);

    // Look for secret keys (base32 strings)
    const bodyText = document.body?.innerText || "";
    const secrets: string[] = [];
    const base32Regex = /[A-Z2-7 ]{16,}/g;
    let m;
    while ((m = base32Regex.exec(bodyText)) !== null) {
      const clean = m[0].replace(/\s/g, "");
      if (clean.length >= 16 && /^[A-Z2-7]+$/.test(clean)) secrets.push(clean);
    }

    // Also check for otpauth:// URIs in img src attributes (QR code data)
    const qrImgs = Array.from(document.querySelectorAll("img")).filter(
      img => img.src?.includes("otpauth") || img.src?.includes("chart.googleapis.com")
    ).map(img => img.src);

    return { interactive, images, secrets, qrImgs, bodyText: bodyText.slice(0, 2000) };
  });

  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dumpPath = `${SCREENSHOT_DIR}/${String(shotCounter).padStart(2, "0")}-${safeLabel}-dump.json`;
  fs.writeFileSync(dumpPath, JSON.stringify(info, null, 2));

  console.log(`\n  ═══ ${label} ═══`);
  console.log(`  URL: ${page.url()}`);
  console.log(`  Interactive:`);
  for (const el of info.interactive) {
    const desc = el.text || el.ariaLabel || el.placeholder || el.href || el.id || "(empty)";
    console.log(`    [${el.tag}${el.type ? `[${el.type}]` : ""}] ${desc.slice(0, 90)}`);
  }
  if (info.secrets.length > 0) console.log(`  🔑 Secret keys: ${info.secrets.join(", ")}`);
  if (info.qrImgs.length > 0) console.log(`  🔲 QR img src: ${info.qrImgs.join(", ")}`);
  console.log(`  Images: ${info.images.length}`);
  for (const img of info.images) {
    console.log(`    [${img.tag}] ${img.width}x${img.height} src="${img.src?.slice(0, 80)}"`);
  }
  console.log(`  Body (500chars):\n    ${info.bodyText.slice(0, 500).replace(/\n/g, "\n    ")}`);
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n  ⏸️  ${prompt} [Enter/q] `, (answer) => {
      rl.close();
      if (answer.trim().toLowerCase() === "q") process.exit(0);
      resolve();
    });
  });
}

async function main() {
  const prisma = new PrismaClient();
  const account = await prisma.account.findFirst({
    where: { status: "HEALTHY", totpSecret: { not: null }, loginPassword: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  if (!account) { console.error("No account"); process.exit(1); }

  console.log(`\n🔑 Account: ${account.loginEmail} (has TOTP: ${!!account.totpSecret})\n`);

  const adspower = new AdsPowerClient({ baseUrl: ADSPOWER_HOST, apiKey: ADSPOWER_KEY, maxRetries: 2, retryDelayMs: 2000 });
  const { debugUrl } = await adspower.openProfile(PROFILE_ID);
  const browser = await chromium.connectOverCDP(debugUrl);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("No context");
  await ctx.clearCookies();
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    // Login
    console.log("══ [1] Gmail Login ══");
    await page.goto("https://accounts.google.com?hl=en", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
    const lr = await gmailLogin(page, account, logger);
    if (!lr.success) { console.error(`Login failed: ${lr.reason}`); process.exit(1); }
    console.log("  ✅ Login OK\n");

    // Navigate to 2FA authenticator page
    console.log("══ [2] Navigate to Authenticator page ══");
    await page.goto("https://myaccount.google.com/two-step-verification/authenticator?hl=en", {
      waitUntil: "domcontentloaded", timeout: 60_000,
    });
    await page.waitForTimeout(3000);
    
    // Handle re-auth if triggered
    if (isReAuthPage(page.url())) {
      console.log("  Re-auth needed...");
      await handleReAuthLoop(page, {
        loginEmail: account.loginEmail,
        password: account.loginPassword,
        totpSecret: account.totpSecret,
      }, logger);
      await page.waitForTimeout(3000);
    }

    await shot(page, "authenticator-page");
    await dumpPage(page, "Authenticator page");
    await waitForEnter("准备点击 Change authenticator app");

    // Click Change
    console.log("\n══ [3] Click 'Change authenticator app' ══");
    const changeBtn = page.locator('button:has-text("Change authenticator app")');
    if ((await changeBtn.count()) === 0) {
      // Maybe it says "Set up authenticator" for accounts without one
      const setupBtn = page.locator('button:has-text("Set up"), button:has-text("Add authenticator")');
      if ((await setupBtn.count()) > 0) {
        await setupBtn.first().click();
      } else {
        console.error("  ❌ No Change/Setup button found");
        process.exit(1);
      }
    } else {
      await changeBtn.first().click();
    }
    console.log("  ✅ Clicked");
    await page.waitForTimeout(4000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    await shot(page, "qr-code-dialog");
    await dumpPage(page, "QR code dialog");
    await waitForEnter("查看 QR 码对话框，准备点击 Can't scan it?");

    // Click "Can't scan it?" to reveal the text secret
    console.log("\n══ [4] Click 'Can't scan it?' ══");
    const cantScan = page.locator([
      'a:has-text("Can\'t scan it")',
      'button:has-text("Can\'t scan it")',
      'a:has-text("Can\'t scan")',
      'button:has-text("Can\'t scan")',
      'a:has-text("无法扫描")',
      'a:has-text("無法掃描")',
      'a:has-text("Enter a setup key")',
    ].join(", "));

    if ((await cantScan.count()) > 0) {
      await cantScan.first().click();
      console.log("  ✅ Clicked Can't scan");
      await page.waitForTimeout(3000);
    } else {
      console.log("  ⚠️  'Can't scan' not found — maybe secret is already visible");
    }

    await shot(page, "secret-key-page");
    await dumpPage(page, "Secret key revealed");

    // Extract the secret key
    const secretData = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";
      
      // Method 1: Look for base32 strings in page text
      const base32Regex = /[A-Z2-7]{4}(\s+[A-Z2-7]{4}){3,}/g;
      const spacedSecrets: string[] = [];
      let m;
      while ((m = base32Regex.exec(bodyText)) !== null) {
        spacedSecrets.push(m[0]);
      }

      // Method 2: Look for continuous base32 strings
      const contRegex = /[A-Z2-7]{16,}/g;
      const contSecrets: string[] = [];
      while ((m = contRegex.exec(bodyText)) !== null) {
        contSecrets.push(m[0]);
      }

      // Method 3: Look for elements that might contain the key
      const codeEls = document.querySelectorAll('[data-text], code, pre, .secret-key, [class*="secret"], [class*="key"]');
      const codeTexts = Array.from(codeEls).map(el => (el as HTMLElement).innerText?.trim()).filter(Boolean);

      // Method 4: Check QR code img src for otpauth URI
      const qrImgs = Array.from(document.querySelectorAll("img")).filter(
        img => img.src?.includes("otpauth") || img.src?.includes("chart")
      ).map(img => img.src);

      return { spacedSecrets, contSecrets, codeTexts, qrImgs, bodyText: bodyText.slice(0, 2000) };
    });

    console.log("\n  ═══ Secret Key Extraction ═══");
    console.log(`  Spaced secrets: ${secretData.spacedSecrets.length > 0 ? secretData.spacedSecrets.join(" | ") : "none"}`);
    console.log(`  Continuous secrets: ${secretData.contSecrets.length > 0 ? secretData.contSecrets.join(" | ") : "none"}`);
    console.log(`  Code elements: ${secretData.codeTexts.length > 0 ? secretData.codeTexts.join(" | ") : "none"}`);
    console.log(`  QR img src: ${secretData.qrImgs.length > 0 ? secretData.qrImgs.join(" | ") : "none"}`);
    console.log(`  Body text:\n    ${secretData.bodyText.slice(0, 800).replace(/\n/g, "\n    ")}`);

    await waitForEnter("查看提取的 secret key，准备输入验证码并点 Next");

    // Now we need to: use the NEW secret to generate a TOTP code, fill it in, and click Next/Verify
    console.log("\n══ [5] Generate TOTP and verify ══");
    
    // First check if there's a "Next" button to click (from QR code page to verification page)
    const nextBtn = page.locator('button:has-text("Next"), button:has-text("下一步")');
    if ((await nextBtn.count()) > 0) {
      await nextBtn.first().click();
      console.log("  Clicked Next");
      await page.waitForTimeout(3000);
    }

    await shot(page, "verification-page");
    await dumpPage(page, "Verification code input page");

    // Look for the verification code input
    const codeInput = page.locator([
      'input[type="tel"]',
      'input[type="text"]',
      'input[name="totpPin"]',
      'input[id="totpPin"]',
      'input[autocomplete="one-time-code"]',
    ].join(", "));

    const inputCount = await codeInput.count();
    console.log(`\n  Verification code inputs found: ${inputCount}`);
    for (let i = 0; i < inputCount; i++) {
      const inp = codeInput.nth(i);
      const visible = await inp.isVisible().catch(() => false);
      const type = await inp.getAttribute("type");
      const name = await inp.getAttribute("name");
      const placeholder = await inp.getAttribute("placeholder");
      console.log(`    [${i}] visible=${visible} type=${type} name=${name} placeholder=${placeholder}`);
    }

    // Look for verify/confirm button
    const verifyBtn = page.locator([
      'button:has-text("Verify")',
      'button:has-text("验证")',
      'button:has-text("驗證")',
      'button:has-text("Next")',
      'button:has-text("下一步")',
      'button:has-text("Confirm")',
      'button:has-text("确认")',
    ].join(", "));
    const verifyCount = await verifyBtn.count();
    console.log(`  Verify/Confirm buttons found: ${verifyCount}`);

    console.log("\n  ⚠️  不实际提交验证码（避免修改账号2FA）");
    console.log("  如需实际测试，可以手动在浏览器中操作。\n");

    await shot(page, "final-state");

    console.log("═══════════════════════════════════════════════════════════");
    console.log("🔍 Phase 3 完整探索完成！");
    console.log(`📁 截图保存在: ${SCREENSHOT_DIR}`);
    console.log("═══════════════════════════════════════════════════════════");

    // Click Cancel to avoid actually changing 2FA
    const cancelBtn = page.locator('button:has-text("Cancel"), button:has-text("取消")');
    if ((await cancelBtn.count()) > 0) {
      await cancelBtn.first().click();
      console.log("  ✅ Clicked Cancel to abort 2FA change");
    }

    await waitForEnter("完成！按 Enter 关闭浏览器");

  } finally {
    await browser.close().catch(() => {});
    await adspower.closeProfile(PROFILE_ID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("\n❌ Failed:", err.message ?? err);
  process.exit(1);
});
