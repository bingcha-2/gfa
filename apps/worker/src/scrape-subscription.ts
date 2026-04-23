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

// Primary: Google Account Wallet & subscriptions page — directly shows
// plan name + "Renews on <date>" for each subscription.
const GOOGLE_SUBSCRIPTIONS_URL = "https://myaccount.google.com/payments-and-subscriptions?hl=en";
// Fallback: Google One plans page for plan info when subscriptions page fails
const GOOGLE_ONE_URL = "https://one.google.com/about/plans?hl=en";

/**
 * Scrape subscription info during sync.
 *
 * Primary strategy — Wallet & subscriptions page
 * (`myaccount.google.com/payments-and-subscriptions`):
 *   The page lists active subscriptions like:
 *     "Google One · Google AI Ultra (30 TB) · Renews on Apr 28, 2026"
 *   We extract both the plan name and renewal date from this single page.
 *
 * Fallback — Google One plans page (`one.google.com/about/plans`):
 *   Used only when the subscriptions page navigation fails entirely.
 */
export async function scrapeSubscriptionInfo(
  page: Page
): Promise<SubscriptionInfo | null> {
  // --- Primary: Wallet & subscriptions page ---
  const fromSubs = await scrapeFromSubscriptionsPage(page);
  if (fromSubs) return fromSubs;

  // --- Fallback: Google One plans page ---
  return scrapeFromGoogleOnePage(page);
}

/**
 * PRIMARY: scrape from Google Account Wallet & subscriptions page.
 * This page shows "Google One\nGoogle AI Ultra (30 TB)\nRenews on Apr 28, 2026".
 */
async function scrapeFromSubscriptionsPage(page: Page): Promise<SubscriptionInfo | null> {
  try {
    await page.goto(GOOGLE_SUBSCRIPTIONS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1000);

    const pageText = await page.evaluate(() => document.body.innerText);

    // Check if "Google One" subscription exists on the page
    const googleOneIdx = pageText.search(/Google\s+One/i);
    if (googleOneIdx === -1) {
      // No Google One subscription found → SUSPENDED (free tier)
      return { expiresAt: null, status: "SUSPENDED", planName: null };
    }

    // Extract nearby text (500 chars after "Google One") for plan name + date
    const nearby = pageText.slice(googleOneIdx, googleOneIdx + 500);

    // Extract plan name: "Google AI Ultra (30 TB)" or "Google AI Premium (2 TB)"
    const planMatch = nearby.match(
      /Google\s+(?:One\s+)?(?:AI\s+)?(?:Premium|Ultra|Plus|Basic|Standard)[\s\S]{0,30}?\(?\d+\s*(?:TB|GB)\)?/i
    );
    const planName = planMatch
      ? planMatch[0].replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").trim()
      : null;

    // Detect payment failure / billing issues → treat as SUSPENDED
    // Google shows messages like:
    //   "Your payment was declined"
    //   "Payment failed"
    //   "Fix payment method"
    //   "Action needed" (with billing context)
    //   "付款被拒" / "付款失败" / "결제가 거부" etc.
    const paymentFailurePatterns = [
      /payment\s+(?:was\s+)?declined/i,
      /payment\s+failed/i,
      /payment\s+method\s+(?:expired|invalid|failed)/i,
      /fix\s+(?:your\s+)?payment/i,
      /billing\s+(?:issue|problem|error)/i,
      /update\s+(?:your\s+)?payment\s+method/i,
      /try\s+again\s+or\s+use\s+a\s+different\s+payment/i,
      /subscription\s+(?:was\s+)?(?:suspended|cancelled|canceled|paused)/i,
      /account\s+(?:is\s+)?on\s+hold/i,
      /付款被拒/,
      /付款失败/,
      /支付失败/,
      /账单问题/,
      /更新.*付款方式/,
      /订阅.*暂停/,
      /결제.*거부/,
      /결제.*실패/,
    ];

    const textToCheck = nearby + " " + pageText.slice(0, 2000);
    const isPaymentFailed = paymentFailurePatterns.some((p) => p.test(textToCheck));

    // Even with a payment warning, try to extract the renewal date first.
    // If a valid future date exists, the subscription is still active — the warning
    // is just about an upcoming card expiry, not an actual subscription stop.
    // Example: "Service ending - card expiring soon" + "Renews on May 19, 2026"
    //          → subscription is still ACTIVE, card just needs updating.
    if (isPaymentFailed) {
      let warnExpiresAt = parseRenewalDate(nearby) ?? parseRenewalDate(pageText) ?? parseExpiryDate(pageText);
      if (warnExpiresAt && warnExpiresAt > new Date()) {
        console.log(`[scrape-subscription] Payment warning detected but subscription still active (renews ${warnExpiresAt.toISOString()}). Plan: ${planName}`);
        return { expiresAt: warnExpiresAt, status: "ACTIVE", planName };
      }
      console.log(`[scrape-subscription] Payment failure detected, no valid future renewal date. Plan: ${planName}. Marking as SUSPENDED.`);
      return { expiresAt: warnExpiresAt, status: "SUSPENDED", planName };
    }

    // Extract renewal date: "Renews on Apr 28, 2026" etc.
    let expiresAt = parseRenewalDate(nearby);

    // If not found nearby, try the whole page
    if (!expiresAt) {
      expiresAt = parseRenewalDate(pageText);
    }

    // Still nothing? Try generic date patterns on whole page
    if (!expiresAt) {
      expiresAt = parseExpiryDate(pageText);
    }

    // Debug: log a snippet so we can diagnose parsing failures
    if (!expiresAt) {
      console.log(`[scrape-subscription] No date found. Nearby text (first 300 chars): ${nearby.slice(0, 300)}`);
    }

    if (expiresAt) {
      const now = new Date();
      return {
        expiresAt,
        status: expiresAt > now ? "ACTIVE" : "EXPIRED",
        planName,
      };
    }

    // Google One found but no renewal date — likely billing issue (payment declined, etc.)
    // A healthy active subscription always shows a renewal date.
    console.log(`[scrape-subscription] Google One found but no renewal date. Plan: ${planName}. Marking as SUSPENDED.`);
    return { expiresAt: null, status: "SUSPENDED", planName };
  } catch {
    // Navigation failed — return null so fallback is tried
    return null;
  }
}

/**
 * FALLBACK: scrape from Google One plans page when subscriptions page fails.
 */
async function scrapeFromGoogleOnePage(page: Page): Promise<SubscriptionInfo | null> {
  try {
    await page.goto(GOOGLE_ONE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2000);

    const pageText = await page.evaluate(() => document.body.innerText);

    const currentPlanInfo = extractCurrentPlanSection(pageText);
    const expiresAt = parseExpiryDate(pageText);

    if (!currentPlanInfo) {
      return { expiresAt: null, status: "SUSPENDED", planName: null };
    }

    if (currentPlanInfo.isFreeTier) {
      return { expiresAt: null, status: "SUSPENDED", planName: null };
    }

    if (expiresAt) {
      const now = new Date();
      return {
        expiresAt,
        status: expiresAt > now ? "ACTIVE" : "EXPIRED",
        planName: currentPlanInfo.planName,
      };
    }

    // Paid plan found but no renewal date — treat as SUSPENDED (billing issue likely)
    return { expiresAt: null, status: "SUSPENDED", planName: currentPlanInfo.planName };
  } catch {
    return null;
  }
}

/**
 * Parse "Renews on <date>" or "Renewed on <date>" patterns.
 * Handles English date formats like "Apr 28, 2026", "April 28, 2026".
 * Also handles CJK patterns: "续订日期：2026年4月28日", "갱신일: 2026년 4월 28일".
 */
function parseRenewalDate(text: string): Date | null {
  // English month-day-year pattern used by multiple regexes below
  const EN_DATE = `((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?\\s+\\d{1,2},?\\s+\\d{4})`;

  // 1. "Renews on ..." / "Renew on ..."
  const renewsOn = text.match(new RegExp(`Renews?\\s+on\\s+${EN_DATE}`, 'i'));
  if (renewsOn) { const d = new Date(renewsOn[1]); if (!isNaN(d.getTime())) return d; }

  // 2. "Renews Apr 28, 2026" (without "on")
  const renewsNoOn = text.match(new RegExp(`Renews?\\s+${EN_DATE}`, 'i'));
  if (renewsNoOn) { const d = new Date(renewsNoOn[1]); if (!isNaN(d.getTime())) return d; }

  // 3. "Next payment on ..."
  const nextPayment = text.match(new RegExp(`Next\\s+(?:payment|billing|charge)\\s+(?:on\\s+)?${EN_DATE}`, 'i'));
  if (nextPayment) { const d = new Date(nextPayment[1]); if (!isNaN(d.getTime())) return d; }

  // 4. "Expires on ..." / "Expiring on ..." / "Expires ..."
  const expiresOn = text.match(new RegExp(`Expir(?:es?|ing)\\s+(?:on\\s+)?${EN_DATE}`, 'i'));
  if (expiresOn) { const d = new Date(expiresOn[1]); if (!isNaN(d.getTime())) return d; }

  // 5. "Paid through ..." / "Valid through ..." / "Valid until ..."
  const through = text.match(new RegExp(`(?:Paid|Valid)\\s+(?:through|until|till)\\s+${EN_DATE}`, 'i'));
  if (through) { const d = new Date(through[1]); if (!isNaN(d.getTime())) return d; }

  // 6. "until Apr 28, 2026"
  const until = text.match(new RegExp(`until\\s+${EN_DATE}`, 'i'));
  if (until) { const d = new Date(until[1]); if (!isNaN(d.getTime())) return d; }

  // 7. Numeric date near keywords: "04/28/2026" or "2026/04/28" or "2026-04-28"
  const numericNear = text.match(
    /(?:renew|expir|payment|billing|through|until|valid|到期|续订|续费)[\s\S]{0,40}?(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/i
  );
  if (numericNear) {
    const d = new Date(parseInt(numericNear[1], 10), parseInt(numericNear[2], 10) - 1, parseInt(numericNear[3], 10));
    if (!isNaN(d.getTime())) return d;
  }
  const numericNearMDY = text.match(
    /(?:renew|expir|payment|billing|through|until|valid|到期|续订|续费)[\s\S]{0,40}?(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/i
  );
  if (numericNearMDY) {
    const d = new Date(parseInt(numericNearMDY[3], 10), parseInt(numericNearMDY[1], 10) - 1, parseInt(numericNearMDY[2], 10));
    if (!isNaN(d.getTime())) return d;
  }

  // Chinese: "续订日期...2026年4月28日" or just "2026年4月28日" near renewal keywords
  const cnMatch = text.match(/(?:续订|续费|到期|renew)[\s\S]{0,30}?(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/i);
  if (cnMatch) {
    const d = new Date(parseInt(cnMatch[1], 10), parseInt(cnMatch[2], 10) - 1, parseInt(cnMatch[3], 10));
    if (!isNaN(d.getTime())) return d;
  }

  // Korean: "갱신일: 2026년 4월 28일"
  const krMatch = text.match(/(?:갱신|만료)[\s\S]{0,30}?(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/i);
  if (krMatch) {
    const d = new Date(parseInt(krMatch[1], 10), parseInt(krMatch[2], 10) - 1, parseInt(krMatch[3], 10));
    if (!isNaN(d.getTime())) return d;
  }

  return null;
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
  const cpMatch = text.match(/(?:your\s+)?current\s*plan|当前方案|当前套餐|目前方案|현재\s*요금제|현재\s*구독/i);
  if (!cpMatch || cpMatch.index === undefined) return null;

  // Extract the next 300 chars after the label
  const afterLabel = text.slice(cpMatch.index + cpMatch[0].length, cpMatch.index + cpMatch[0].length + 300);

  // Free tier detection: "15 GB" near "$0" / "¥0" / "included with your Google Account"
  const hasFreeTierIndicator =
    /(?:\$0|¥0|￥0|₩0|0원|included\s+with\s+your\s+Google|Google\s*계정에\s*포함됨)/i.test(afterLabel) ||
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
  // Pattern 1: Chinese/Korean "2025年3月15日" or "2025년 3월 15일"
  const chineseMatch = text.match(/(\d{4})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일]/);
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
  const isoMatch = text.match(/(?:续订|到期|到期时间|Renewal|Expir|갱신|만료).*?(\d{4})-(\d{2})-(\d{2})/i);
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
