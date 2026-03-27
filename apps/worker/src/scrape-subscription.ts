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
 *   1. Find "Current plan" / "Your current plan" section.
 *   2. Extract plan name and storage from the NEARBY text only (not the
 *      entire page, which also lists other purchasable plans).
 *   3. If the current plan is the free 15 GB tier → SUSPENDED.
 *   4. If the current plan is a paid tier → ACTIVE.
 *   5. Try to parse expiry/renewal dates in multiple formats.
 */
export async function scrapeSubscriptionInfo(
  page: Page
): Promise<SubscriptionInfo | null> {
  try {
    await page.goto(GOOGLE_ONE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4000);

    const pageText = await page.evaluate(() => document.body.innerText);

    // Find the "Current plan" section and extract nearby text
    const currentPlanInfo = extractCurrentPlanSection(pageText);
    const expiresAt = parseExpiryDate(pageText);

    if (!currentPlanInfo) {
      // No "Current plan" found at all
      return { expiresAt: null, status: "SUSPENDED", planName: null };
    }

    // Free tier detection: "15 GB" with "$0" / "¥0" / "included with your Google Account"
    if (currentPlanInfo.isFreeTier) {
      return { expiresAt: null, status: "SUSPENDED", planName: null };
    }

    // Paid tier detected
    if (expiresAt) {
      const now = new Date();
      return {
        expiresAt,
        status: expiresAt > now ? "ACTIVE" : "EXPIRED",
        planName: currentPlanInfo.planName,
      };
    }

    // Paid tier but no expiry date (monthly subscriptions)
    return { expiresAt: null, status: "ACTIVE", planName: currentPlanInfo.planName };
  } catch {
    // Navigation failure, timeout, etc. — non-fatal
    return null;
  }
}

/**
 * Represents the parsed "Current plan" section from the page.
 */
interface CurrentPlanSection {
  /** Extracted plan name, e.g. "Google AI Ultra 30 TB" */
  planName: string | null;
  /** Whether this is the free 15 GB tier (no paid subscription) */
  isFreeTier: boolean;
}

/**
 * Find the "Current plan" section in the page text and extract
 * the plan name from ONLY the nearby text (next ~300 chars).
 *
 * This prevents matching plan names from other plan cards further
 * down the page (e.g. "Google AI Plus 200 GB" on a free-tier page).
 */
function extractCurrentPlanSection(text: string): CurrentPlanSection | null {
  // Find the first occurrence of "Current plan" / "Your current plan"
  const cpMatch = text.match(/(?:your\s+)?current\s*plan|当前方案|当前套餐|目前方案/i);
  if (!cpMatch || cpMatch.index === undefined) return null;

  // Extract the next 300 chars after the label
  const afterLabel = text.slice(cpMatch.index + cpMatch[0].length, cpMatch.index + cpMatch[0].length + 300);

  // Free tier detection: "15 GB" near "$0" / "¥0" / "included with your Google Account"
  const hasFreeTierIndicator =
    /(?:\$0|¥0|￥0|included\s+with\s+your\s+Google)/i.test(afterLabel) ||
    (/15\s*GB/i.test(afterLabel) && !/Google\s+(One|AI)/i.test(afterLabel));

  if (hasFreeTierIndicator) {
    return { planName: null, isFreeTier: true };
  }

  // Extract plan name from the nearby text only
  // Pattern 1: "Google AI Ultra\n30 TB" or "Google One AI Premium\n2 TB"
  const googlePlanMatch = afterLabel.match(
    /(?:Google\s+(?:One\s+)?(?:AI\s+)?(?:Premium|Ultra|Plus|Basic|Standard)[\s\S]{0,15}?\d+\s*(?:TB|GB))/i
  );
  if (googlePlanMatch) {
    return {
      planName: googlePlanMatch[0].replace(/\s+/g, " ").trim(),
      isFreeTier: false,
    };
  }

  // Pattern 2: Just a storage amount near "Current plan" (e.g. "2 TB", "100 GB")
  const storageMatch = afterLabel.match(/(\d+)\s*(TB|GB)/i);
  if (storageMatch) {
    const storageStr = `${storageMatch[1]} ${storageMatch[2].toUpperCase()}`;
    // Double-check it's not the free tier
    if (storageStr === "15 GB") {
      return { planName: null, isFreeTier: true };
    }
    return {
      planName: `Google One ${storageStr}`,
      isFreeTier: false,
    };
  }

  // "Current plan" found but no storage info — probably a paid plan
  return { planName: null, isFreeTier: false };
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
