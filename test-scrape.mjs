import { chromium } from "playwright";

const ADSPOWER_BASE = "http://localhost:50354";
const PROFILE_ID = "39";
const API_KEY = "d1f286bfc5ae11374faf1083c9d28480008379d6ce494bed";
const AUTH_HEADERS = { "Authorization": `Bearer ${API_KEY}` };
const EMAIL = "s01030876996@gmail.com";
const PASSWORD = "01030876996";
const TOTP_SECRET = "2SYTGLTV4KXHL37FYLV5PESNQLGWLHVR";

function base32Decode(encoded) {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of encoded) { const v = CHARS.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, "0"); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(bytes);
}

async function generateTOTP(secret) {
  const key = base32Decode(secret);
  const time = Math.floor(Date.now() / 30000);
  const tb = new ArrayBuffer(8);
  new DataView(tb).setBigUint64(0, BigInt(time));
  const ck = await globalThis.crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", ck, tb));
  const o = sig[sig.length - 1] & 0x0f;
  const code = (((sig[o] & 0x7f) << 24) | ((sig[o + 1] & 0xff) << 16) | ((sig[o + 2] & 0xff) << 8) | (sig[o + 3] & 0xff)) % 1000000;
  return code.toString().padStart(6, "0");
}

async function main() {
  console.log("Opening AdsPower profile...");
  const r = await fetch(`${ADSPOWER_BASE}/api/v1/browser/start?serial_number=${PROFILE_ID}`, { headers: AUTH_HEADERS });
  const j = await r.json();
  if (j.code !== 0 || !j.data?.ws?.puppeteer) throw new Error("AdsPower: " + j.msg);
  console.log("Connected to CDP.");

  const browser = await chromium.connectOverCDP(j.data.ws.puppeteer);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    // Login
    await page.goto("https://accounts.google.com?hl=en", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    if (!page.url().includes("myaccount")) {
      console.log("Not logged in, entering credentials...");
      const ei = page.locator('input[type="email"]');
      if (await ei.count() > 0) {
        await ei.fill(EMAIL);
        await page.locator("#identifierNext button").first().click();
        await page.waitForTimeout(3000);
      }

      const pi = page.locator('input[type="password"]:visible');
      if (await pi.count() > 0) {
        await pi.fill(PASSWORD);
        await page.locator("#passwordNext button").first().click();
        await page.waitForTimeout(3000);
      }

      const ti = page.locator('input[name="totpPin"], input[id="totpPin"]');
      if (await ti.count() > 0) {
        const code = await generateTOTP(TOTP_SECRET);
        console.log("TOTP code: " + code);
        await ti.fill(code);
        await page.locator("#totpNext button").first().click();
        await page.waitForTimeout(3000);
      }
    }
    console.log("Login URL: " + page.url());

    // Navigate to Google One
    console.log("\nNavigating to Google One plans page...");
    await page.goto("https://one.google.com/about/plans?hl=en", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);

    const pageText = await page.evaluate(() => document.body.innerText);
    console.log("\n--- PAGE TEXT (first 1000 chars) ---");
    console.log(pageText.slice(0, 1000));
    console.log("--- END ---\n");

    // Run scraper logic
    const hasCurrent = /current\s*plan/i.test(pageText);
    const planMatch = pageText.match(/(?:Google\s+(?:One\s+)?(?:AI\s+)?(?:Premium|Ultra|Basic|Standard)?[\s\S]{0,10}?\d+\s*(?:TB|GB))/i);
    const planName = planMatch ? planMatch[0].replace(/\s+/g, " ").trim() : null;
    const dateMatch = pageText.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i);
    const cnDateMatch = pageText.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);

    console.log("hasCurrent:  " + hasCurrent);
    console.log("planName:    " + planName);
    console.log("dateMatch:   " + (dateMatch?.[0] ?? "null"));
    console.log("cnDateMatch: " + (cnDateMatch?.[0] ?? "null"));

    let status = hasCurrent ? "ACTIVE" : "SUSPENDED";
    let expiresAt = null;
    if (dateMatch) {
      expiresAt = new Date(dateMatch[0]);
      status = expiresAt > new Date() ? "ACTIVE" : "EXPIRED";
      console.log("expiresAt:   " + expiresAt.toISOString());
    }

    console.log("\n=== RESULT ===");
    console.log("status:    " + status);
    console.log("planName:  " + planName);
    console.log("expiresAt: " + (expiresAt?.toISOString() ?? "null"));

    await page.screenshot({ path: "C:/tmp/google-one-page.png" });
    console.log("\nScreenshot saved to C:/tmp/google-one-page.png");
  } finally {
    await browser.close().catch(() => {});
    await fetch(`${ADSPOWER_BASE}/api/v1/browser/stop?serial_number=${PROFILE_ID}`, { headers: AUTH_HEADERS }).catch(() => {});
    console.log("Done.");
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
