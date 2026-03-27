import { chromium } from "playwright";

const ADSPOWER_BASE = "http://localhost:50354";
const PROFILE_ID = "39";
const API_KEY = "d1f286bfc5ae11374faf1083c9d28480008379d6ce494bed";
const AUTH_HEADERS = { "Authorization": `Bearer ${API_KEY}` };

async function main() {
  // Open profile (assume already logged in from last test)
  console.log("Opening AdsPower profile...");
  const r = await fetch(`${ADSPOWER_BASE}/api/v1/browser/start?serial_number=${PROFILE_ID}`, { headers: AUTH_HEADERS });
  const j = await r.json();
  if (j.code !== 0 || !j.data?.ws?.puppeteer) throw new Error("AdsPower: " + j.msg);

  const browser = await chromium.connectOverCDP(j.data.ws.puppeteer);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    // Page 1: Plans page (currently open or navigate)
    console.log("\n=== Page 1: Plans page ===");
    await page.goto("https://one.google.com/about/plans?hl=en", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    const plansText = await page.evaluate(() => document.body.innerText);
    console.log("Full text length: " + plansText.length);

    // Search for ANY date-like patterns
    const datePatterns = [
      { name: "Month DD, YYYY", regex: /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}/gi },
      { name: "YYYY-MM-DD", regex: /\d{4}-\d{2}-\d{2}/g },
      { name: "MM/DD/YYYY", regex: /\d{1,2}\/\d{1,2}\/\d{4}/g },
      { name: "DD/MM/YYYY", regex: /\d{1,2}\.\d{1,2}\.\d{4}/g },
      { name: "Chinese date", regex: /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g },
      { name: "renewal/expir keyword", regex: /(?:renew|expir|billing|next\s*(?:payment|charge)|until|valid|trial)/gi },
    ];

    for (const { name, regex } of datePatterns) {
      const matches = plansText.match(regex);
      console.log(`  ${name}: ${matches ? JSON.stringify(matches) : "none"}`);
    }

    // Page 2: Settings / subscription management page
    console.log("\n=== Page 2: Settings page ===");
    await page.goto("https://one.google.com/settings?hl=en", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    const settingsText = await page.evaluate(() => document.body.innerText);
    console.log("Full text length: " + settingsText.length);
    console.log("--- FULL TEXT ---");
    console.log(settingsText.slice(0, 2000));
    console.log("--- END ---");

    for (const { name, regex } of datePatterns) {
      regex.lastIndex = 0; // reset regex state
      const matches = settingsText.match(regex);
      console.log(`  ${name}: ${matches ? JSON.stringify(matches) : "none"}`);
    }

    // Page 3: Google Play subscriptions page (often has renewal date)
    console.log("\n=== Page 3: Google Play subscriptions ===");
    await page.goto("https://play.google.com/store/account/subscriptions?hl=en", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    const playText = await page.evaluate(() => document.body.innerText);
    console.log("Full text length: " + playText.length);
    console.log("--- FULL TEXT ---");
    console.log(playText.slice(0, 2000));
    console.log("--- END ---");

    for (const { name, regex } of datePatterns) {
      regex.lastIndex = 0;
      const matches = playText.match(regex);
      console.log(`  ${name}: ${matches ? JSON.stringify(matches) : "none"}`);
    }

    // Page 4: Google Pay subscriptions page
    console.log("\n=== Page 4: Google Pay subscriptions ===");
    await page.goto("https://pay.google.com/gp/w/home/activity?hl=en", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    const payText = await page.evaluate(() => document.body.innerText);
    console.log("Full text length: " + payText.length);
    console.log("--- FULL TEXT (first 2000) ---");
    console.log(payText.slice(0, 2000));
    console.log("--- END ---");

    for (const { name, regex } of datePatterns) {
      regex.lastIndex = 0;
      const matches = payText.match(regex);
      console.log(`  ${name}: ${matches ? JSON.stringify(matches) : "none"}`);
    }

  } finally {
    await browser.close().catch(() => {});
    await fetch(`${ADSPOWER_BASE}/api/v1/browser/stop?serial_number=${PROFILE_ID}`, { headers: AUTH_HEADERS }).catch(() => {});
    console.log("\nDone.");
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
