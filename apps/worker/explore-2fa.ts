/**
 * 2FA 修改流程探索脚本
 * 
 * 目的：登录 Google 账号后，导航到 2FA 设置页面，
 * 逐步记录页面结构和截图，为实现"修改 2FA"功能收集信息。
 * 
 * 每一步都会暂停，等待你按 Enter 继续。
 * 
 * Usage: npx tsx apps/worker/explore-2fa.ts [accountEmail]
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
import { handleReAuth, isReAuthPage, handleReAuthLoop } from "./src/handle-reauth";

// ── Config ──
const PROFILE_ID    = process.env.ADSPOWER_POOL_IDS?.split(",")[0]?.trim() ?? "40";
const ADSPOWER_HOST = process.env.ADSPOWER_HOST ?? "http://127.0.0.1:50325";
const ADSPOWER_KEY  = process.env.ADSPOWER_API_KEY;
const SCREENSHOT_DIR = "C:/tmp/2fa-explore";

// Google 2FA 相关 URL
const TWO_STEP_URL = "https://myaccount.google.com/signinoptions/two-step-verification?hl=en";
const SECURITY_URL = "https://myaccount.google.com/security?hl=en";

// ── Logger (minimal) ──
const logger: any = {
  log: async (level: string, msg: string, extra?: any) => {
    const ts = new Date().toISOString().substring(11, 23);
    console.log(`  [${ts}][${level}] ${msg}`, extra ? JSON.stringify(extra) : "");
  },
  updateStatus: async () => {},
  recordScreenshot: async () => {},
};

// ── Helpers ──
let shotCounter = 0;

async function shot(page: Page, label: string): Promise<string> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  shotCounter++;
  const filename = `${String(shotCounter).padStart(2, "0")}-${label}-${Date.now()}.png`;
  const filepath = `${SCREENSHOT_DIR}/${filename}`;
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`  📸 ${filepath}`);
  return filepath;
}

async function dumpPageStructure(page: Page, label: string): Promise<void> {
  const info = await page.evaluate(() => {
    const url = location.href;
    const title = document.title;

    // Collect all interactive elements
    const interactiveEls = document.querySelectorAll(
      'a, button, input, select, [role="button"], [role="link"], [data-action], [jsaction]'
    );
    const interactive = Array.from(interactiveEls).slice(0, 60).map((el, i) => {
      const htmlEl = el as HTMLElement;
      const rect = htmlEl.getBoundingClientRect();
      return {
        idx: i,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        type: el.getAttribute("type"),
        href: el.getAttribute("href")?.slice(0, 120),
        text: htmlEl.innerText?.trim().slice(0, 100),
        ariaLabel: el.getAttribute("aria-label")?.slice(0, 80),
        dataAction: el.getAttribute("data-action"),
        id: el.id?.slice(0, 40),
        classes: el.className?.toString().slice(0, 60),
        visible: rect.width > 0 && rect.height > 0,
      };
    });

    // Collect all text content sections
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4")).map(el => ({
      tag: el.tagName,
      text: (el as HTMLElement).innerText?.trim().slice(0, 100),
    }));

    // Check for iframes (Google often uses iframes for settings)
    const iframes = Array.from(document.querySelectorAll("iframe")).map(el => ({
      src: el.src?.slice(0, 150),
      title: el.title,
      id: el.id,
    }));

    const bodyText = document.body?.innerText?.slice(0, 800) || "";

    return { url, title, headings, interactive, iframes, bodyText };
  });

  // Write to file
  const dumpPath = `${SCREENSHOT_DIR}/${String(shotCounter).padStart(2, "0")}-${label}-dump.json`;
  fs.writeFileSync(dumpPath, JSON.stringify(info, null, 2));
  
  console.log(`\n  ═══ Page Structure: ${label} ═══`);
  console.log(`  URL: ${info.url}`);
  console.log(`  Title: ${info.title}`);
  console.log(`  Headings: ${info.headings.map(h => `${h.tag}:"${h.text}"`).join(" | ")}`);
  console.log(`  iFrames: ${info.iframes.length > 0 ? JSON.stringify(info.iframes) : "none"}`);
  console.log(`  Interactive elements (visible):`);
  
  const visibleEls = info.interactive.filter(e => e.visible);
  for (const el of visibleEls.slice(0, 30)) {
    const label = el.text || el.ariaLabel || el.href || el.id || "(no label)";
    console.log(`    [${el.tag}${el.role ? `[role=${el.role}]` : ""}] ${label.slice(0, 80)}`);
  }
  
  console.log(`  📄 Full dump: ${dumpPath}`);
  console.log(`  Body text (first 400):\n    ${info.bodyText.slice(0, 400).replace(/\n/g, "\n    ")}`);
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n  ⏸️  ${prompt} [按 Enter 继续, 输入 q 退出] `, (answer) => {
      rl.close();
      if (answer.trim().toLowerCase() === "q") {
        console.log("  用户退出");
        process.exit(0);
      }
      resolve();
    });
  });
}

// ── Main ──
async function main() {
  const prisma = new PrismaClient();

  // Find test account
  const targetEmail = process.argv[2];
  let account: any;

  if (targetEmail) {
    account = await prisma.account.findFirst({
      where: { loginEmail: targetEmail },
    });
  } else {
    // Pick first healthy account with TOTP
    account = await prisma.account.findFirst({
      where: {
        status: "HEALTHY",
        totpSecret: { not: null },
        loginPassword: { not: null },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  if (!account) {
    console.error("❌ No suitable account found");
    process.exit(1);
  }

  console.log(`\n🔑 Test Account: ${account.loginEmail}`);
  console.log(`   ID: ${account.id}`);
  console.log(`   Status: ${account.status}`);
  console.log(`   Has TOTP: ${!!account.totpSecret}`);
  console.log(`   Profile: ${PROFILE_ID}\n`);

  const adspower = new AdsPowerClient({
    baseUrl: ADSPOWER_HOST,
    apiKey: ADSPOWER_KEY,
    maxRetries: 2,
    retryDelayMs: 2000,
  });

  // Step 1: Open AdsPower profile
  console.log("═══════════════════════════════════════════════════════════");
  console.log("[Step 1/7] Opening AdsPower profile...");
  const { debugUrl } = await adspower.openProfile(PROFILE_ID);
  console.log(`  Debug URL: ${debugUrl}`);

  // Step 2: Connect via CDP
  console.log("\n[Step 2/7] Connecting via CDP...");
  const browser = await chromium.connectOverCDP(debugUrl);
  const contexts = browser.contexts();
  if (!contexts.length) throw new Error("No browser contexts");

  // Clear session
  await contexts[0].clearCookies();
  const pages = contexts[0].pages();
  const page = pages.length > 0 ? pages[0] : await contexts[0].newPage();
  
  try {
    await page.goto("https://accounts.google.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.evaluate(() => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    });
  } catch {
    console.log("  (localStorage clear skipped)");
  }
  console.log("  ✅ Connected and session cleared");

  try {
    // Step 3: Gmail login
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("[Step 3/7] Logging into Gmail...");
    const loginResult = await gmailLogin(page, account, logger);
    if (!loginResult.success) {
      console.error(`  ❌ Login failed: ${loginResult.reason} — ${loginResult.detail}`);
      await shot(page, "login-failed");
      process.exit(1);
    }
    console.log("  ✅ Login successful");
    await shot(page, "login-success");

    // Step 4: Navigate to Security page first
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("[Step 4/7] Navigating to Security settings...");
    await page.goto(SECURITY_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    
    // Check if re-auth is required
    if (isReAuthPage(page.url())) {
      console.log("  ⚠️  Re-authentication required!");
      await shot(page, "security-reauth");
      await handleReAuthLoop(page, {
        loginEmail: account.loginEmail,
        password: account.loginPassword,
        totpSecret: account.totpSecret,
      }, logger, { logPrefix: "[explore-2fa]" });
      console.log("  ✅ Re-auth completed");
    }
    
    await shot(page, "security-page");
    await dumpPageStructure(page, "security-page");
    await waitForEnter("查看 Security 页面结构，准备进入 2FA 设置");

    // Step 5: Navigate to 2-Step Verification page
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("[Step 5/7] Navigating to 2-Step Verification...");
    await page.goto(TWO_STEP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    
    // Check if re-auth is required (Google usually requires re-auth for 2FA settings)
    if (isReAuthPage(page.url())) {
      console.log("  ⚠️  Re-authentication required for 2FA page!");
      await shot(page, "2fa-reauth-before");
      await dumpPageStructure(page, "2fa-reauth");
      await waitForEnter("查看重认证页面");

      await handleReAuthLoop(page, {
        loginEmail: account.loginEmail,
        password: account.loginPassword,
        totpSecret: account.totpSecret,
      }, logger, { logPrefix: "[explore-2fa]" });
      console.log("  ✅ Re-auth completed");
      await page.waitForTimeout(3000);
    }

    await shot(page, "2fa-main-page");
    await dumpPageStructure(page, "2fa-main-page");
    await waitForEnter("查看 2FA 主页面，准备寻找 Authenticator 设置入口");

    // Step 6: Find and click Authenticator app option
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("[Step 6/7] Looking for Authenticator app setting...");
    
    // Search for authenticator-related elements
    const authElements = await page.evaluate(() => {
      const allEls = document.querySelectorAll("*");
      const matches: any[] = [];
      const keywords = [
        "authenticator", "身份验证器", "驗證器", "认证器",
        "totp", "google authenticator", "2fa",
        "verification app", "验证应用", "authenticator app",
        "change", "修改", "更改", "edit", "编辑",
        "set up", "设置", "設定", "add", "添加",
      ];
      
      Array.from(allEls).forEach((el, idx) => {
        const text = (el as HTMLElement).innerText?.toLowerCase() || "";
        const ariaLabel = el.getAttribute("aria-label")?.toLowerCase() || "";
        const href = el.getAttribute("href")?.toLowerCase() || "";
        
        for (const kw of keywords) {
          if (text.includes(kw) || ariaLabel.includes(kw) || href.includes(kw)) {
            const htmlEl = el as HTMLElement;
            const rect = htmlEl.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              matches.push({
                idx,
                tag: el.tagName.toLowerCase(),
                text: htmlEl.innerText?.trim().slice(0, 120),
                ariaLabel: el.getAttribute("aria-label")?.slice(0, 80),
                href: (el as HTMLAnchorElement).href?.slice(0, 120),
                role: el.getAttribute("role"),
                classes: el.className?.toString().slice(0, 60),
                keyword: kw,
                clickable: el.tagName === "A" || el.tagName === "BUTTON" || el.getAttribute("role") === "button" || el.getAttribute("role") === "link",
              });
            }
            break; // only match first keyword
          }
        }
      });
      
      // Deduplicate by text
      const seen = new Set<string>();
      return matches.filter(m => {
        const key = m.text?.slice(0, 50);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 30);
    });

    console.log(`\n  Found ${authElements.length} authenticator-related elements:`);
    for (const el of authElements) {
      const clickIndicator = el.clickable ? "🔗" : "  ";
      console.log(`  ${clickIndicator} [${el.tag}] "${el.text?.slice(0, 80)}" (keyword: ${el.keyword})`);
      if (el.href) console.log(`       href: ${el.href}`);
    }

    // Try to find the "Authenticator" clickable element
    const authLink = page.locator([
      // Look for Authenticator section links/buttons
      'a:has-text("Authenticator")',
      'button:has-text("Authenticator")',
      'div[role="link"]:has-text("Authenticator")',
      'a:has-text("身份验证器")',
      'a:has-text("驗證器")',
      // Google uses right-arrow / pencil icons as edit buttons
      'a[href*="authenticator"]',
      'a[href*="totp"]',
    ].join(", "));

    const authCount = await authLink.count();
    console.log(`\n  Authenticator clickable links found: ${authCount}`);

    if (authCount > 0) {
      for (let i = 0; i < authCount; i++) {
        const text = await authLink.nth(i).innerText().catch(() => "(no text)");
        const href = await authLink.nth(i).getAttribute("href").catch(() => "(no href)");
        console.log(`    [${i}] text="${text?.trim().slice(0, 80)}" href="${href}"`);
      }
    }

    await waitForEnter("查看 Authenticator 相关元素，准备点击进入修改页面");

    // Try clicking the authenticator option
    if (authCount > 0) {
      console.log("  Clicking authenticator option...");
      await authLink.first().click();
      await page.waitForTimeout(3000);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      
      // Re-auth might be triggered
      if (isReAuthPage(page.url())) {
        console.log("  ⚠️  Re-auth triggered after clicking authenticator!");
        await shot(page, "auth-reauth");
        await handleReAuthLoop(page, {
          loginEmail: account.loginEmail,
          password: account.loginPassword,
          totpSecret: account.totpSecret,
        }, logger, { logPrefix: "[explore-2fa]" });
        await page.waitForTimeout(3000);
      }

      await shot(page, "authenticator-page");
      await dumpPageStructure(page, "authenticator-page");
    }

    // Step 7: Explore the authenticator setup/change page
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("[Step 7/7] Exploring authenticator setup/change UI...");
    
    // Look for "Set up" / "Change" / QR code / secret key elements
    const setupElements = await page.evaluate(() => {
      const keywords = [
        "set up", "change", "add", "remove", "delete",
        "设置", "修改", "更改", "添加", "删除", "移除",
        "qr code", "二维码", "secret", "密钥",
        "can't scan", "无法扫描", "manually", "手动",
        "enter this", "输入此",
        "get started", "开始",
      ];
      
      const matches: any[] = [];
      const allEls = document.querySelectorAll("a, button, [role='button'], [role='link'], span, div");
      
      Array.from(allEls).forEach(el => {
        const htmlEl = el as HTMLElement;
        const text = htmlEl.innerText?.toLowerCase() || "";
        const ariaLabel = el.getAttribute("aria-label")?.toLowerCase() || "";
        
        for (const kw of keywords) {
          if (text.includes(kw) || ariaLabel.includes(kw)) {
            const rect = htmlEl.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && text.length < 200) {
              matches.push({
                tag: el.tagName.toLowerCase(),
                text: htmlEl.innerText?.trim().slice(0, 120),
                ariaLabel: el.getAttribute("aria-label")?.slice(0, 80),
                role: el.getAttribute("role"),
                keyword: kw,
              });
              break;
            }
          }
        }
      });

      // Also look for images (QR codes)
      const images = Array.from(document.querySelectorAll("img, canvas, svg")).map(el => ({
        tag: el.tagName.toLowerCase(),
        src: (el as HTMLImageElement).src?.slice(0, 100),
        alt: el.getAttribute("alt"),
        width: (el as HTMLElement).offsetWidth,
        height: (el as HTMLElement).offsetHeight,
      })).filter(img => img.width > 50 && img.height > 50);

      const bodyText = document.body?.innerText?.slice(0, 1200) || "";

      return { matches, images, bodyText };
    });

    console.log(`\n  Setup/Change related elements: ${setupElements.matches.length}`);
    const seen = new Set<string>();
    for (const el of setupElements.matches) {
      const key = el.text?.slice(0, 50);
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`    [${el.tag}] "${el.text?.slice(0, 100)}" (keyword: ${el.keyword})`);
    }

    console.log(`\n  Images/Canvas (possible QR): ${setupElements.images.length}`);
    for (const img of setupElements.images) {
      console.log(`    [${img.tag}] ${img.width}x${img.height} alt="${img.alt}" src="${img.src?.slice(0, 80)}"`);
    }

    console.log(`\n  Body text:\n    ${setupElements.bodyText.slice(0, 600).replace(/\n/g, "\n    ")}`);

    await shot(page, "final-state");
    await dumpPageStructure(page, "final-state");

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("🔍 探索完成！");
    console.log(`📁 所有截图和 dump 保存在: ${SCREENSHOT_DIR}`);
    console.log("═══════════════════════════════════════════════════════════");

    await waitForEnter("探索完成，你可以在浏览器中手动操作。按 Enter 关闭浏览器");

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
