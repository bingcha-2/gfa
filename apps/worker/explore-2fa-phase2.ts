/**
 * 2FA 修改流程探索 Phase 2
 * 
 * 接入已打开的 AdsPower 浏览器（不关闭不重新登录），
 * 直接点击 "Change authenticator app" 并探索后续流程。
 * 
 * Usage: npx tsx apps/worker/explore-2fa-phase2.ts
 */

import * as dotenv from "dotenv";
import { resolve } from "path";
import * as fs from "fs";
import * as readline from "readline";

dotenv.config({ path: resolve(__dirname, "../../.env") });

import { chromium, Page } from "playwright";
import { AdsPowerClient } from "./src/adspower-client";

const PROFILE_ID    = process.env.ADSPOWER_POOL_IDS?.split(",")[0]?.trim() ?? "40";
const ADSPOWER_HOST = process.env.ADSPOWER_HOST ?? "http://127.0.0.1:50325";
const ADSPOWER_KEY  = process.env.ADSPOWER_API_KEY;
const SCREENSHOT_DIR = "C:/tmp/2fa-explore-p2";

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

async function dumpPage(page: Page, label: string) {
  const info = await page.evaluate(() => {
    const url = location.href;
    const title = document.title;
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4")).map(el => ({
      tag: el.tagName, text: (el as HTMLElement).innerText?.trim().slice(0, 120),
    }));

    const interactive = Array.from(document.querySelectorAll(
      'a, button, input, select, textarea, [role="button"], [role="link"]'
    )).filter(el => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).slice(0, 40).map(el => {
      const htmlEl = el as HTMLElement;
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        type: el.getAttribute("type"),
        id: el.id?.slice(0, 40),
        text: htmlEl.innerText?.trim().slice(0, 120),
        ariaLabel: el.getAttribute("aria-label")?.slice(0, 80),
        href: el.getAttribute("href")?.slice(0, 120),
        classes: el.className?.toString().slice(0, 60),
        name: el.getAttribute("name"),
        placeholder: el.getAttribute("placeholder"),
      };
    });

    // Look for QR code or secret key
    const images = Array.from(document.querySelectorAll("img, canvas, svg")).map(el => ({
      tag: el.tagName.toLowerCase(),
      src: (el as HTMLImageElement).src?.slice(0, 200),
      alt: el.getAttribute("alt"),
      width: (el as HTMLElement).offsetWidth,
      height: (el as HTMLElement).offsetHeight,
      dataUrl: el.tagName === "IMG" && (el as HTMLImageElement).src?.startsWith("data:") ? "yes" : "no",
    })).filter(img => img.width > 30 && img.height > 30);

    // Look for text that might contain the secret key
    const allText = document.body?.innerText || "";
    const secretKeyPatterns: string[] = [];
    // Look for base32-like strings (uppercase letters + digits 2-7, 16+ chars)
    const base32Regex = /[A-Z2-7]{16,}/g;
    let match;
    while ((match = base32Regex.exec(allText)) !== null) {
      secretKeyPatterns.push(match[0]);
    }

    const bodyText = allText.slice(0, 1500);

    return { url, title, headings, interactive, images, secretKeyPatterns, bodyText };
  });

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const dumpPath = `${SCREENSHOT_DIR}/${String(shotCounter).padStart(2, "0")}-${label}-dump.json`;
  fs.writeFileSync(dumpPath, JSON.stringify(info, null, 2));

  console.log(`\n  ═══ ${label} ═══`);
  console.log(`  URL: ${info.url}`);
  console.log(`  Title: ${info.title}`);
  console.log(`  Headings: ${info.headings.map(h => `${h.tag}:"${h.text}"`).join(" | ")}`);
  console.log(`  Interactive (visible):`);
  for (const el of info.interactive) {
    const desc = el.text || el.ariaLabel || el.placeholder || el.href || el.id || "(no label)";
    console.log(`    [${el.tag}${el.type ? `[type=${el.type}]` : ""}${el.role ? `[role=${el.role}]` : ""}] ${desc.slice(0, 90)}`);
  }
  console.log(`  Images (QR?): ${info.images.length}`);
  for (const img of info.images) {
    console.log(`    [${img.tag}] ${img.width}x${img.height} alt="${img.alt}" dataUrl=${img.dataUrl} src="${img.src?.slice(0, 80)}"`);
  }
  if (info.secretKeyPatterns.length > 0) {
    console.log(`  🔑 Possible secret keys found: ${info.secretKeyPatterns.join(", ")}`);
  }
  console.log(`  Body text:\n    ${info.bodyText.slice(0, 600).replace(/\n/g, "\n    ")}`);
  console.log(`  📄 ${dumpPath}`);
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n  ⏸️  ${prompt} [Enter=继续, q=退出] `, (answer) => {
      rl.close();
      if (answer.trim().toLowerCase() === "q") process.exit(0);
      resolve();
    });
  });
}

async function main() {
  const adspower = new AdsPowerClient({
    baseUrl: ADSPOWER_HOST,
    apiKey: ADSPOWER_KEY,
    maxRetries: 2,
    retryDelayMs: 2000,
  });

  // Check if profile is already active (from phase 1)
  const { active, debugUrl: existingUrl } = await adspower.checkProfile(PROFILE_ID);
  let debugUrl: string;
  
  if (active && existingUrl) {
    console.log(`\n✅ Profile ${PROFILE_ID} is already active, reconnecting...`);
    debugUrl = existingUrl;
  } else {
    console.log(`\n⚠️  Profile ${PROFILE_ID} not active. Need to start fresh.`);
    console.log(`   Please run explore-2fa.ts first and keep it at the final pause.`);
    console.log(`   Or press Enter to open profile and manually navigate.`);
    await waitForEnter("Press Enter to open profile");
    const opened = await adspower.openProfile(PROFILE_ID);
    debugUrl = opened.debugUrl;
  }

  const browser = await chromium.connectOverCDP(debugUrl);
  const contexts = browser.contexts();
  if (!contexts.length) throw new Error("No browser contexts");
  
  const pages = contexts[0].pages();
  const page = pages.length > 0 ? pages[0] : await contexts[0].newPage();
  console.log(`  Current URL: ${page.url()}\n`);

  try {
    // Navigate to authenticator page if not already there
    if (!page.url().includes("authenticator")) {
      console.log("  Navigating to authenticator page...");
      await page.goto("https://myaccount.google.com/two-step-verification/authenticator?hl=en", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(3000);
    }

    await shot(page, "authenticator-before-change");
    await dumpPage(page, "Authenticator page (before change)");
    await waitForEnter("准备点击 'Change authenticator app'");

    // ═══ Click "Change authenticator app" ═══
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("[Phase 2] Clicking 'Change authenticator app'...");
    
    const changeBtn = page.locator([
      'button:has-text("Change authenticator app")',
      'button:has-text("更改身份验证器")',
      'button:has-text("更改验证器")',
      'button:has-text("變更驗證器")',
      'a:has-text("Change authenticator app")',
    ].join(", "));

    if ((await changeBtn.count()) === 0) {
      console.error("  ❌ 'Change authenticator app' button not found!");
      await shot(page, "change-btn-not-found");
      process.exit(1);
    }

    await changeBtn.first().click();
    console.log("  ✅ Clicked 'Change authenticator app'");
    await page.waitForTimeout(5000);
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    await shot(page, "after-change-click");
    await dumpPage(page, "After clicking Change (QR code page?)");
    await waitForEnter("查看 Change 后的页面（可能是 QR 码页面）");

    // ═══ Look for "Can't scan it?" or manual secret key ═══
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("[Phase 2] Looking for secret key / 'Can't scan it?' link...");

    const cantScanLink = page.locator([
      'a:has-text("Can\'t scan")',
      'button:has-text("Can\'t scan")',
      'a:has-text("无法扫描")',
      'a:has-text("無法掃描")',
      'button:has-text("无法扫描")',
      'button:has-text("無法掃描")',
      // Google sometimes uses text like "Enter a setup key" or "Manual entry"
      'a:has-text("setup key")',
      'a:has-text("manual")',
      'button:has-text("setup key")',
      'a:has-text("手动输入")',
      'a:has-text("手動輸入")',
    ].join(", "));

    const cantScanCount = await cantScanLink.count();
    console.log(`  "Can't scan" links found: ${cantScanCount}`);

    if (cantScanCount > 0) {
      for (let i = 0; i < cantScanCount; i++) {
        const text = await cantScanLink.nth(i).innerText().catch(() => "?");
        console.log(`    [${i}] "${text.trim()}"`);
      }

      console.log("  Clicking 'Can't scan' to reveal secret key...");
      await cantScanLink.first().click();
      await page.waitForTimeout(3000);

      await shot(page, "secret-key-revealed");
      await dumpPage(page, "Secret key revealed");
      await waitForEnter("查看 secret key 页面");
    }

    // ═══ Look for the setup key / code input ═══
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("[Phase 2] Looking for setup key text and verification input...");

    const pageContent = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";
      
      // Find base32-like secret keys
      const base32Regex = /[A-Z2-7 ]{16,}/g;
      const secrets: string[] = [];
      let m;
      while ((m = base32Regex.exec(bodyText)) !== null) {
        const clean = m[0].replace(/\s/g, "");
        if (clean.length >= 16 && /^[A-Z2-7]+$/.test(clean)) {
          secrets.push(clean);
        }
      }

      // Find all inputs (for verification code)
      const inputs = Array.from(document.querySelectorAll("input")).map(el => ({
        type: el.type,
        name: el.name,
        id: el.id,
        placeholder: el.placeholder,
        ariaLabel: el.getAttribute("aria-label"),
        visible: el.offsetWidth > 0 && el.offsetHeight > 0,
        autocomplete: el.autocomplete,
      }));

      // Find buttons (for verify/next/confirm)
      const buttons = Array.from(document.querySelectorAll("button")).filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }).map(el => ({
        text: el.innerText?.trim().slice(0, 80),
        ariaLabel: el.getAttribute("aria-label"),
        type: el.type,
      }));

      return { secrets, inputs, buttons, bodyText: bodyText.slice(0, 2000) };
    });

    console.log(`\n  🔑 Secret keys found: ${pageContent.secrets.length}`);
    for (const s of pageContent.secrets) {
      console.log(`    ${s}`);
    }

    console.log(`\n  📝 Input fields: ${pageContent.inputs.length}`);
    for (const inp of pageContent.inputs.filter(i => i.visible)) {
      console.log(`    [input type=${inp.type}] name="${inp.name}" id="${inp.id}" placeholder="${inp.placeholder}" aria="${inp.ariaLabel}"`);
    }

    console.log(`\n  🔘 Buttons: ${pageContent.buttons.length}`);
    for (const btn of pageContent.buttons) {
      console.log(`    [button] "${btn.text}"`);
    }

    console.log(`\n  Body text:\n    ${pageContent.bodyText.slice(0, 800).replace(/\n/g, "\n    ")}`);

    await shot(page, "final-exploration");
    await dumpPage(page, "Final exploration state");

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("🔍 Phase 2 探索完成！");
    console.log(`📁 截图和 dump 保存在: ${SCREENSHOT_DIR}`);
    console.log("═══════════════════════════════════════════════════════════");

    await waitForEnter("Phase 2 完成。按 Enter 关闭浏览器");

  } finally {
    await browser.close().catch(() => {});
    await adspower.closeProfile(PROFILE_ID).catch(() => {});
  }
}

main().catch((err) => {
  console.error("\n❌ Script failed:", err.message ?? err);
  process.exit(1);
});
