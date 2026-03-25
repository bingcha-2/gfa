/**
 * Inspect the member detail page for remove-member selectors.
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

  // First go to family details to find member links
  console.log("Going to family details...");
  await page.goto("https://myaccount.google.com/family/details", {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  // Find all member links
  const memberLinks = await page.evaluate(() => {
    const links = document.querySelectorAll('a.umngff[href*="family/member/"]');
    return Array.from(links).map(l => ({
      href: (l as HTMLAnchorElement).href,
      name: l.querySelector('.IlKlLe')?.textContent?.trim() ?? '',
      role: l.querySelector('.ImPZoc')?.textContent?.trim() ?? '',
    }));
  });

  console.log("\n=== Members ===");
  memberLinks.forEach((m, i) => console.log(`  [${i}] ${m.name} (${m.role}) → ${m.href}`));

  // Navigate to first NON-admin member's detail page
  const nonAdmin = memberLinks.find(m => !m.role.includes("管理員") && !m.role.includes("manager"));
  const targetLink = nonAdmin ? nonAdmin.href : memberLinks[memberLinks.length - 1]?.href;

  if (!targetLink) {
    console.log("No member detail links found");
    await browser.close();
    return;
  }

  console.log(`\nNavigating to member detail: ${targetLink}`);
  await page.goto(targetLink, { waitUntil: "networkidle", timeout: 30000 });

  console.log("URL:", page.url());
  console.log("Title:", await page.title());

  // Screenshot
  await page.screenshot({
    path: "e:/work_space/googleAo/repos/google-family-automation/scripts/member-detail.png",
    fullPage: true,
  });

  // Dump all buttons, links, and interactive elements
  const elements = await page.evaluate(() => {
    const results: string[] = [];

    document.querySelectorAll("button, [role='button']").forEach((el, i) => {
      results.push(
        `BTN[${i}]: tag=${el.tagName} text="${el.textContent?.trim().slice(0, 80)}" class="${el.className.toString().slice(0, 60)}" aria="${el.getAttribute("aria-label") ?? ""}"`
      );
    });

    document.querySelectorAll("a[href]").forEach((el, i) => {
      const a = el as HTMLAnchorElement;
      results.push(
        `LINK[${i}]: href="${a.href}" text="${a.textContent?.trim().slice(0, 80)}" class="${a.className.slice(0, 60)}"`
      );
    });

    // Look for any "remove" or "delete" text
    document.querySelectorAll("*").forEach(el => {
      const text = el.textContent?.trim() ?? "";
      if ((text.includes("移除") || text.includes("刪除") || text.includes("Remove") || text.includes("remove") || text.includes("Delete")) && el.children.length < 3 && text.length < 100) {
        results.push(
          `REMOVE_EL: tag=${el.tagName} text="${text}" class="${el.className.toString().slice(0, 60)}" parent=${el.parentElement?.tagName}`
        );
      }
    });

    return results.join("\n");
  });

  console.log("\n=== Member Detail Elements ===");
  console.log(elements);

  const fs = require("fs");
  fs.writeFileSync(
    "e:/work_space/googleAo/repos/google-family-automation/scripts/member-detail-dom.txt",
    `URL: ${page.url()}\n\n${elements}`,
    "utf8"
  );

  console.log("\n✅ Saved member-detail-dom.txt");
  await browser.close();
}

main().catch(console.error);
