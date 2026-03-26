/**
 * Scrapes Google One subscription info from the account's subscription page.
 *
 * Returns null on any failure — caller must treat this as non-fatal.
 */

import type { Page } from "playwright";

export interface SubscriptionInfo {
  /** Parsed expiry date, or null if not found */
  expiresAt: Date | null;
  /** Derived status based on whether expiresAt is in the future */
  status: "ACTIVE" | "EXPIRED" | "SUSPENDED";
}

// Use /about without /u/0/ to avoid user-index dependency in AdsPower profiles
const GOOGLE_ONE_URL = "https://one.google.com/about";

/**
 * Navigate to the Google One page and attempt to parse the subscription
 * renewal / expiry date from the page text.
 *
 * Supports both Chinese and English date formats:
 *   - "下次续订：2025年3月15日"
 *   - "Next renewal: March 15, 2025"
 *   - "到期时间：2025-03-15"
 */
export async function scrapeSubscriptionInfo(
  page: Page
): Promise<SubscriptionInfo | null> {
  try {
    await page.goto(GOOGLE_ONE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    await page.waitForTimeout(1500);

    const pageText = await page.evaluate(() => document.body.innerText);

    const expiresAt = parseExpiryDate(pageText);

    if (!expiresAt) {
      // Page loaded but no date found — could mean no active subscription
      return { expiresAt: null, status: "SUSPENDED" };
    }

    const now = new Date();
    const status: SubscriptionInfo["status"] =
      expiresAt > now ? "ACTIVE" : "EXPIRED";

    return { expiresAt, status };
  } catch {
    // Navigation failure, timeout, etc. — non-fatal
    return null;
  }
}

/**
 * Parse the expiry/renewal date from raw page text.
 * Tries multiple patterns to handle locale variations.
 */
function parseExpiryDate(text: string): Date | null {
  // Pattern 1: Chinese "2025年3月15日" or "2025 年 3 月 15 日"
  const chineseMatch = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (chineseMatch) {
    const d = new Date(
      parseInt(chineseMatch[1], 10),
      parseInt(chineseMatch[2], 10) - 1,
      parseInt(chineseMatch[3], 10)
    );
    if (!isNaN(d.getTime())) return d;
  }

  // Pattern 2: English "March 15, 2025" / "Mar 15, 2025"
  const englishMatch = text.match(
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i
  );
  if (englishMatch) {
    const d = new Date(englishMatch[0]);
    if (!isNaN(d.getTime())) return d;
  }

  // Pattern 3: ISO-like near renewal/expiry keywords: "到期：2025-03-15" or "expires 2025-03-15"
  const isoMatch = text.match(/(?:续订|到期|到期时间|Renewal|Expir).*?(\d{4})-(\d{2})-(\d{2})/i);
  if (isoMatch) {
    const d = new Date(
      parseInt(isoMatch[1], 10),
      parseInt(isoMatch[2], 10) - 1,
      parseInt(isoMatch[3], 10)
    );
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}
