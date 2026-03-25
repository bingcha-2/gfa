/**
 * Inspect the invite-members page DOM.
 */
import { config } from "dotenv";
import * as path from "path";
config({ path: path.resolve(__dirname, "../../.env") });
import { chromium } from "playwright";

async function main() {
  const host = process.env.ADSPOWER_HOST ?? "http://127.0.0.1:50354";
  const apiKey = process.env.ADSPOWER_API_KEY ?? "";

  const res = await fetch(
    `${host}/api/v1/browser/active?serial_number=38`,
    { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} }
  );
  const json = await (res.json() as Promise<any>);
  const wsUrl = json.data.ws.puppeteer;
  console.log("CDP:", wsUrl);

  const browser = await chromium.connectOverCDP(wsUrl);
  const page = browser.contexts()[0].pages()[0];

  // Navigate to invite page
  console.log("Navigating to invite page...");
  await page.goto("https://myaccount.google.com/family/invitemembers", {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  console.log("URL:", page.url());
  console.log("Title:", await page.title());

  // Screenshot
  await page.screenshot({
    path: "e:/work_space/googleAo/repos/google-family-automation/scripts/invite-page.png",
    fullPage: true,
  });

  // Dump all form elements, inputs, textareas
  const elements = await page.evaluate(() => {
    const results: string[] = [];

    // Inputs
    document.querySelectorAll("input, textarea").forEach((el, i) => {
      const inp = el as HTMLInputElement;
      results.push(
        `INPUT[${i}]: tag=${el.tagName} type="${inp.type}" name="${inp.name}" placeholder="${inp.placeholder}" id="${inp.id}" class="${el.className}" aria-label="${el.getAttribute("aria-label") ?? ""}"`
      );
    });

    // Buttons
    document.querySelectorAll("button, [role='button'], a[role='button']").forEach((el, i) => {
      results.push(
        `BTN[${i}]: tag=${el.tagName} text="${el.textContent?.trim().slice(0, 80)}" class="${el.className}" aria-label="${el.getAttribute("aria-label") ?? ""}" data-action="${el.getAttribute("data-action") ?? ""}"`
      );
    });

    // All clickable/interactive elements with meaningful text
    document.querySelectorAll("[jsaction], [data-rid]").forEach((el, i) => {
      if (i < 30) {
        results.push(
          `INTERACTIVE[${i}]: tag=${el.tagName} text="${el.textContent?.trim().slice(0, 60)}" class="${el.className.toString().slice(0, 60)}" jsaction="${el.getAttribute("jsaction")?.slice(0, 80) ?? ""}"`
        );
      }
    });

    return results.join("\n");
  });

  console.log("\n=== Invite Page Elements ===");
  console.log(elements);

  // Save main HTML
  const mainHTML = await page.evaluate(() => {
    return document.body.innerHTML.slice(0, 8000);
  });
  
  const fs = require("fs");
  fs.writeFileSync(
    "e:/work_space/googleAo/repos/google-family-automation/scripts/invite-dom.txt",
    `URL: ${page.url()}\n\n=== Elements ===\n${elements}\n\n=== HTML ===\n${mainHTML}`,
    "utf8"
  );

  console.log("\n✅ Saved invite-dom.txt");
  await browser.close();
}

main().catch(console.error);
