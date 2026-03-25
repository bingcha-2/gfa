/**
 * Connect to AdsPower browser via CDP, navigate to Google Family,
 * take screenshot and dump page DOM for selector calibration.
 */
import { config } from "dotenv";
import * as path from "path";
config({ path: path.resolve(__dirname, "../../.env") });
import { chromium } from "playwright";

async function main() {
  // Get CDP URL from AdsPower
  const host = process.env.ADSPOWER_HOST ?? "http://127.0.0.1:50354";
  const apiKey = process.env.ADSPOWER_API_KEY ?? "";

  const res = await fetch(
    `${host}/api/v1/browser/active?serial_number=38`,
    { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} }
  );
  const json = await (res.json() as Promise<any>);

  if (json.code !== 0 || json.data.status !== "Active") {
    console.error("Profile not active:", json);
    process.exit(1);
  }

  const wsUrl = json.data.ws.puppeteer;
  console.log("CDP URL:", wsUrl);

  // Connect via CDP
  const browser = await chromium.connectOverCDP(wsUrl);
  const contexts = browser.contexts();
  const context = contexts[0];
  const pages = context.pages();

  console.log(`\n=== ${pages.length} pages open ===`);
  for (const [i, p] of pages.entries()) {
    console.log(`  [${i}] ${p.url()} — ${await p.title()}`);
  }

  // Use first page or navigate
  let page = pages[0];

  // Navigate to family page
  console.log("\nNavigating to families.google.com/families ...");
  await page.goto("https://families.google.com/families", {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  console.log("Final URL:", page.url());
  console.log("Title:", await page.title());

  // Take screenshot
  const ssPath = "e:/work_space/googleAo/repos/google-family-automation/scripts/family-page.png";
  await page.screenshot({ path: ssPath, fullPage: true });
  console.log(`\n✅ Screenshot saved: ${ssPath}`);

  // Dump interesting DOM elements
  const bodyHTML = await page.evaluate(() => {
    // Get outer HTML but limit depth for readability
    const body = document.body;
    if (!body) return "NO BODY";

    // Find all buttons and links
    const elements: string[] = [];

    // All buttons
    const buttons = body.querySelectorAll("button, [role='button']");
    buttons.forEach((el, i) => {
      elements.push(
        `BUTTON[${i}]: tag=${el.tagName} text="${el.textContent?.trim().slice(0, 80)}" class="${el.className}" aria="${el.getAttribute("aria-label") ?? ""}" data="${Array.from(el.attributes).filter(a => a.name.startsWith("data-")).map(a => `${a.name}=${a.value}`).join(",")}"`
      );
    });

    // All links
    const links = body.querySelectorAll("a[href]");
    links.forEach((el, i) => {
      const a = el as HTMLAnchorElement;
      elements.push(
        `LINK[${i}]: href="${a.href}" text="${a.textContent?.trim().slice(0, 80)}" class="${a.className}"`
      );
    });

    // All elements with email-like content
    const allEls = body.querySelectorAll("*");
    allEls.forEach((el) => {
      const text = el.textContent?.trim() ?? "";
      if (text.includes("@") && text.length < 100 && el.children.length === 0) {
        elements.push(
          `EMAIL_EL: tag=${el.tagName} text="${text}" class="${el.className}" parent=${el.parentElement?.tagName}.${el.parentElement?.className.split(" ")[0]}`
        );
      }
    });

    // Member cards or list items
    const cards = body.querySelectorAll("[data-member], [data-email], [role='listitem'], .member, li");
    cards.forEach((el, i) => {
      if (i < 20) {
        elements.push(
          `CARD[${i}]: tag=${el.tagName} class="${el.className}" text="${el.textContent?.trim().slice(0, 120)}" attrs="${Array.from(el.attributes).map(a => `${a.name}=${a.value.slice(0,30)}`).join(",")}"`
        );
      }
    });

    return elements.join("\n");
  });

  console.log("\n=== DOM Elements ===");
  console.log(bodyHTML);

  // Also dump the main content area HTML structure
  const mainHTML = await page.evaluate(() => {
    const main = document.querySelector("main, [role='main'], #content, .content");
    if (main) return main.innerHTML.slice(0, 5000);
    return document.body.innerHTML.slice(0, 5000);
  });

  // Save to file for analysis
  const domPath = "e:/work_space/googleAo/repos/google-family-automation/scripts/family-dom.txt";
  require("fs").writeFileSync(domPath, `URL: ${page.url()}\nTitle: ${await page.title()}\n\n=== Elements ===\n${bodyHTML}\n\n=== Main HTML ===\n${mainHTML}`, "utf8");
  console.log(`\n✅ DOM dump saved: ${domPath}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
