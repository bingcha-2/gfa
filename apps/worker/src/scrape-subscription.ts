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
  /** Plan name extracted from the page, e.g. "Google AI Ultra 30 TB" */
  planName: string | null;
}

// Navigate to the plans page with English locale for consistent scraping
const GOOGLE_ONE_URL = "https://one.google.com/about/plans?hl=en";

/**
 * Navigate to the Google One page and attempt to parse the subscription
 * renewal / expiry date and plan name from the page text.
 *
 * Detection strategy:
 *   1. If we see "Current plan" text → subscription is ACTIVE,
 *      even if no expiry date is found (monthly plans don't show one).
 *   2. Try to parse expiry/renewal dates in multiple formats.
 *   3. Extract plan name from the card that has "Current plan" label.
 */
export async function scrapeSubscriptionInfo(
  page: Page
): Promise<SubscriptionInfo | null> {
  try {
    await page.goto(GOOGLE_ONE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4000);

    const pageText = await page.evaluate(() => document.body.innerText);

    // Detect active subscription by "Current plan" label
    const hasCurrentPlan =
      /current\s*plan/i.test(pageText) ||
      /当前方案|当前套餐|目前方案/i.test(pageText);

    const expiresAt = parseExpiryDate(pageText);
    const planName = parsePlanName(pageText);

    if (expiresAt) {
      const now = new Date();
      return {
        expiresAt,
        status: expiresAt > now ? "ACTIVE" : "EXPIRED",
        planName,
      };
    }

    if (hasCurrentPlan) {
      // Page shows "Current plan" but no date — e.g. monthly subscriptions
      return { expiresAt: null, status: "ACTIVE", planName };
    }

    // No date and no "Current plan" → likely no active subscription
    return { expiresAt: null, status: "SUSPENDED", planName: null };
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

  // Pattern 3: ISO-like near renewal/expiry keywords
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

/**
 * Extract the plan name from the page text around "Current plan" label.
 * Looks for common Google One plan names:
 *   - "Google One AI Premium 2 TB"
 *   - "Google AI Ultra 30 TB"
 *   - "Google One 100 GB" / "2 TB"
 */
function parsePlanName(text: string): string | null {
  // Look for "Google ..." plan name patterns
  const planMatch = text.match(
    /(?:Google\s+(?:One\s+)?(?:AI\s+)?(?:Premium|Ultra|Basic|Standard)?[\s\S]{0,10}?\d+\s*(?:TB|GB))/i
  );
  if (planMatch) {
    // Clean up whitespace
    return planMatch[0].replace(/\s+/g, " ").trim();
  }

  // Fallback: look for standalone storage amounts near "Current plan"
  const currentPlanIdx = text.search(/current\s*plan|当前方案|当前套餐/i);
  if (currentPlanIdx >= 0) {
    // Check the 200 chars after "Current plan" for a storage amount
    const nearby = text.slice(currentPlanIdx, currentPlanIdx + 200);
    const storageMatch = nearby.match(/(\d+)\s*(TB|GB)/i);
    if (storageMatch) {
      return `Google One ${storageMatch[1]} ${storageMatch[2].toUpperCase()}`;
    }
  }

  return null;
}
