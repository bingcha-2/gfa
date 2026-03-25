import { chromium } from "playwright";

async function main() {
  const host = "http://127.0.0.1:50354";
  const apiKey = "d1f286bfc5ae11374faf1083c9d28480008379d6ce494bed";

  const checkRes = await fetch(`${host}/api/v1/browser/active?serial_number=39`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const checkJson = (await checkRes.json()) as any;
  const wsUrl = checkJson.data.ws.puppeteer;

  const browser = await chromium.connectOverCDP(wsUrl);
  const page = browser.contexts()[0].pages()[0];

  // We're on the /family/remove/ page already — just click Remove
  const removeUrl = "https://myaccount.google.com/family/remove/g/104673262100937405714";
  console.log("Navigating to remove confirmation page...");
  await page.goto(removeUrl, { waitUntil: "networkidle", timeout: 30000 });
  console.log("URL:", page.url());

  // Look for the "Remove" button (blue primary button)
  const removeBtn = page.locator(
    'button:has-text("Remove"), button:has-text("移除")'
  );
  console.log(`Remove buttons: ${await removeBtn.count()}`);

  if ((await removeBtn.count()) > 0) {
    // Click the last one (the actual Remove button, not nav elements)
    await removeBtn.last().click();
    console.log("Clicked Remove!");

    await page.waitForTimeout(5000);
    await page.waitForLoadState("networkidle");
    console.log("After remove URL:", page.url());
  }

  // Verify
  await page.goto("https://myaccount.google.com/family/details", {
    waitUntil: "networkidle", timeout: 30000,
  });

  const remaining = await page.evaluate(() => {
    const links = document.querySelectorAll('a.umngff[href*="family/member/"]');
    return Array.from(links).map(l => ({
      name: l.querySelector(".IlKlLe")?.textContent?.trim() ?? "",
      role: l.querySelector(".ImPZoc")?.textContent?.trim() ?? "",
    }));
  });
  console.log("\nRemaining members:");
  remaining.forEach((m: any, i: number) => console.log(`  [${i}] ${m.name} | ${m.role}`));

  const hasLaura = remaining.some((m: any) =>
    m.name.toLowerCase().includes("laura") || m.name.toLowerCase().includes("rommens")
  );
  console.log(hasLaura
    ? "\n❌ Laura Rommens still present"
    : "\n✅ Laura Rommens REMOVED!"
  );

  await browser.close();
}

main().catch(console.error);
