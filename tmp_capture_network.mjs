/**
 * Network capture script — observe Google Family page's batchexecute requests.
 * 
 * This script does NOT send any invite. It only:
 * 1. Opens an AdsPower profile from the pool
 * 2. Navigates to Google Family page (assumes already logged in)
 * 3. Monitors all batchexecute network requests/responses
 * 4. Navigates to the invite page (but does NOT fill or submit)
 * 5. Saves captured data to tmp_network_capture.json
 *
 * Usage: node tmp_capture_network.mjs
 */

import { chromium } from "playwright";
import fs from "fs";

const ADSPOWER_BASE = "http://local.adspower.net:50325";
const API_KEY = "72b3bff4dfd7dafca46046dd4c5c1992008379d6ce494bed";
// Use first pool profile
const PROFILE_ID = "k1aryykr";
const FAMILY_URL = "https://myaccount.google.com/family/details?hl=en";

const captures = [];

async function main() {
  console.log("Opening AdsPower profile...");
  const r = await fetch(
    `${ADSPOWER_BASE}/api/v1/browser/start?user_id=${PROFILE_ID}&api_key=${API_KEY}`
  );
  const j = await r.json();
  if (j.code !== 0 || !j.data?.ws?.puppeteer) {
    throw new Error("AdsPower open failed: " + j.msg);
  }
  console.log("CDP URL:", j.data.ws.puppeteer);

  const browser = await chromium.connectOverCDP(j.data.ws.puppeteer);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || (await ctx.newPage());

  // Set up comprehensive network listener
  page.on("response", async (response) => {
    const url = response.url();
    
    // Capture ALL requests to Google domains that look like API calls
    const isInteresting =
      url.includes("batchexecute") ||
      url.includes("family") ||
      url.includes("FamilyMembersUi") ||
      url.includes("invitemembers") ||
      (url.includes("google.com") && url.includes("data"));

    if (!isInteresting) return;

    try {
      const status = response.status();
      const headers = response.headers();
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "[could not read body]";
      }

      const entry = {
        timestamp: new Date().toISOString(),
        url: url.substring(0, 500),
        status,
        contentType: headers["content-type"] || "",
        bodyLength: body.length,
        bodyPreview: body.substring(0, 2000),
        bodyTail: body.length > 2000 ? body.substring(body.length - 500) : "",
      };

      captures.push(entry);
      console.log(
        `[${captures.length}] ${status} ${url.substring(0, 100)}... (${body.length} bytes)`
      );
    } catch (err) {
      console.log(`[capture error] ${err.message}`);
    }
  });

  // Also capture requests (not just responses)
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("batchexecute")) {
      const postData = request.postData();
      captures.push({
        timestamp: new Date().toISOString(),
        type: "REQUEST",
        method: request.method(),
        url: url.substring(0, 500),
        postDataPreview: postData ? postData.substring(0, 2000) : null,
      });
      console.log(
        `[REQ] ${request.method()} ${url.substring(0, 100)}... ` +
        `(postData: ${postData ? postData.length + " bytes" : "none"})`
      );
    }
  });

  try {
    // Step 1: Navigate to family details page
    console.log("\n=== Step 1: Loading Family Details Page ===");
    await page.goto(FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);

    // Check if logged in
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "");
    console.log("Page text preview:", bodyText.slice(0, 200));

    // Check for invite link
    const inviteLink = page.locator('a[href*="invitemembers"]');
    const inviteCount = await inviteLink.count();
    console.log(`\nInvite link found: ${inviteCount > 0 ? "YES" : "NO"}`);

    if (inviteCount > 0) {
      // Step 2: Click invite link to load invite page (captures batchexecute calls)
      console.log("\n=== Step 2: Loading Invite Page (NOT sending) ===");
      await inviteLink.first().click();
      await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
      await page.waitForTimeout(5000);

      const invitePageUrl = page.url();
      console.log("Invite page URL:", invitePageUrl);

      // Check what inputs/buttons are available
      const emailInput = page.locator([
        "input.I4p4db",
        'input[placeholder*="email" i]',
        'input[type="email"]',
      ].join(", "));
      const inputCount = await emailInput.count();
      console.log(`Email input found: ${inputCount > 0 ? "YES" : "NO"}`);

      const sendButton = page.locator(
        'button:has-text("Send"), button:has-text("傳送"), button:has-text("发送")'
      );
      const btnCount = await sendButton.count();
      console.log(`Send button found: ${btnCount > 0 ? "YES" : "NO"}`);
    } else {
      console.log("No invite slots available — checking page state...");
      const memberLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="family/member/"]'))
          .map(a => a.href);
      });
      console.log(`Member links on page: ${memberLinks.length}`);
    }

    // Step 3: Go back to family details to capture any additional network calls
    console.log("\n=== Step 3: Returning to Family Details ===");
    await page.goto(FAMILY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);

    // Step 4: Extract WIZ_global_data structure
    console.log("\n=== Step 4: Extracting WIZ_global_data ===");
    const wizData = await page.evaluate(() => {
      const scripts = document.querySelectorAll("script");
      const wizScripts = [];
      for (const s of scripts) {
        const text = s.textContent || "";
        if (text.includes("WIZ_global_data") || text.includes("AF_initDataCallback")) {
          wizScripts.push(text.substring(0, 1500));
        }
      }
      return wizScripts;
    });
    console.log(`Found ${wizData.length} WIZ/AF scripts`);
    if (wizData.length > 0) {
      captures.push({
        timestamp: new Date().toISOString(),
        type: "WIZ_DATA",
        scriptCount: wizData.length,
        scripts: wizData.map((s, i) => ({ index: i, preview: s.substring(0, 1000) })),
      });
    }

  } finally {
    // Save all captures
    const outputPath = "tmp_network_capture.json";
    fs.writeFileSync(outputPath, JSON.stringify(captures, null, 2));
    console.log(`\n=== Saved ${captures.length} captures to ${outputPath} ===`);

    await browser.close().catch(() => {});
    await fetch(
      `${ADSPOWER_BASE}/api/v1/browser/stop?user_id=${PROFILE_ID}&api_key=${API_KEY}`
    ).catch(() => {});
    console.log("Done.");
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message || e);
  process.exit(1);
});
