/**
 * Quick kick script: remove nettruths@gmail.com from family group.
 * Directly uses Playwright + AdsPower CDP (no BullMQ).
 */
import { config } from "dotenv";
import * as path from "path";
config({ path: path.resolve(__dirname, "../../.env") });
import { chromium } from "playwright";

const FAMILY_URL = "https://myaccount.google.com/family/details";

async function main() {
  const host = process.env.ADSPOWER_HOST ?? "http://127.0.0.1:50354";
  const apiKey = process.env.ADSPOWER_API_KEY ?? "";
  const targetEmail = process.argv[2] || "nettruths@gmail.com";

  // Get CDP URL
  const res = await fetch(
    `${host}/api/v1/browser/active?serial_number=38`,
    { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} }
  );
  const json = await (res.json() as Promise<any>);

  if (json.code !== 0 || json.data.status !== "Active") {
    console.error("Profile not active. Starting...");
    await fetch(`${host}/api/v1/browser/start?serial_number=38`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    await new Promise(r => setTimeout(r, 3000));
    return main(); // retry
  }

  const wsUrl = json.data.ws.puppeteer;
  console.log("CDP:", wsUrl);

  const browser = await chromium.connectOverCDP(wsUrl);
  const page = browser.contexts()[0].pages()[0];

  // Go to family details
  console.log("Navigating to family details...");
  await page.goto(FAMILY_URL, { waitUntil: "networkidle", timeout: 30000 });
  console.log("URL:", page.url());

  // Find member by navigating to each member's detail page
  const memberLinks = page.locator('a.umngff[href*="family/member/"]');
  const count = await memberLinks.count();
  console.log(`Found ${count} member(s) on page`);

  let found = false;
  for (let i = 0; i < count; i++) {
    const name = await memberLinks.nth(i).locator('.IlKlLe').textContent().catch(() => '');
    const role = await memberLinks.nth(i).locator('.ImPZoc').textContent().catch(() => '');
    console.log(`  [${i}] ${name} (${role})`);

    // Click into member detail
    await memberLinks.nth(i).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    // Check if page contains target email or if this is not the admin
    const bodyText = await page.textContent("body") ?? "";
    console.log(`  Detail URL: ${page.url()}`);

    if (bodyText.includes(targetEmail) || (name && !role?.includes("管理員"))) {
      console.log(`  ✓ Found target member: ${name}`);
      found = true;
      break;
    }

    // Go back
    await page.goto(FAMILY_URL, { waitUntil: "networkidle" });
  }

  if (!found) {
    console.error(`❌ Member ${targetEmail} not found`);
    await browser.close();
    process.exit(1);
  }

  // Click remove/cancel button
  const removeButton = page.locator(
    'button:has-text("移除"), button:has-text("取消邀請"), button:has-text("Remove"), button:has-text("Cancel invite")'
  );

  const removeCount = await removeButton.count();
  console.log(`Found ${removeCount} remove/cancel button(s)`);

  if (removeCount === 0) {
    console.error("❌ No remove/cancel button found");
    await page.screenshot({ path: "scripts/kick-error.png", fullPage: true });
    await browser.close();
    process.exit(1);
  }

  console.log(`Clicking: "${await removeButton.first().textContent()}"`);
  await removeButton.first().click();
  await page.waitForTimeout(2000);

  // Confirm if dialog appears
  const confirmButton = page.locator(
    'button:has-text("確認"), button:has-text("確定"), button:has-text("取消邀請"), button:has-text("Confirm"), button:has-text("Yes")'
  );

  if ((await confirmButton.count()) > 0) {
    console.log(`Confirming: "${await confirmButton.first().textContent()}"`);
    await confirmButton.first().click();
    await page.waitForTimeout(3000);
  }

  await page.waitForLoadState("networkidle");
  console.log("\n✅ Member removed/invite cancelled!");
  console.log("Final URL:", page.url());

  await page.screenshot({ path: "scripts/kick-result.png", fullPage: true });
  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
