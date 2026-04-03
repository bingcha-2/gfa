/**
 * Shared family member scraper.
 *
 * Extracted from sync.processor.ts so that replace, invite, and remove
 * processors can reuse the same proven scraping logic for retry pre-checks.
 */

import type { Page } from "playwright";

export interface ScrapedMember {
  email: string;
  displayName: string;
  role: string;
  googleMemberId: string; // GAIA ID from href="/family/member/g/{id}"
  isPending: boolean;     // true = invite sent but not yet accepted
}

/**
 * Scrape family member info from the Google Family page.
 * Visits each member's detail page to read the real email address,
 * since emails are not always shown on the list page.
 *
 * Returns { members, availableSlots }.
 */
export async function scrapeMembersFromPage(
  page: Page,
  adminEmail: string = ""
): Promise<{ members: ScrapedMember[]; availableSlots: number }> {
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  // Parse available slots from invite button text
  const inviteLinkText = await page
    .locator('a[href*="invitemembers"]')
    .first()
    .textContent()
    .catch(() => "");
  const slotMatch = inviteLinkText?.match(/(\d+)/);

  // KEY INSIGHT: a[href*="family/member/"] IS the "Family member details" link.
  // The member's display name lives in SIBLING elements inside the parent card container,
  // NOT inside the <a> element itself.
  const cardDebug = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="family/member/"]');
    return Array.from(links).map((link) => {
      const href = link.getAttribute("href") ?? "";

      // Walk up to find the card container (li, or a div that wraps both name + link)
      const card = link.closest("li, [data-member], .member-card") ?? link.parentElement;

      // Collect leaf-node texts from the CARD, excluding any text from inside the <a>
      const cardDescendants = card ? Array.from(card.querySelectorAll("*")) : [];
      const leafTexts = cardDescendants
        .filter((c) => c.children.length === 0 && !link.contains(c))
        .map((c) => c.textContent?.trim() ?? "")
        .filter((t) => t.length > 0)
        .slice(0, 10);

      // Best name: not an email, not purely numeric, not too short (avatar letter)
      const nameEl = cardDescendants.find((child) => {
        if (link.contains(child)) return false; // skip anything inside the <a>
        if (child.children.length > 0) return false; // leaf nodes only
        const text = child.textContent?.trim() ?? "";
        return (
          text.length > 1 && // exclude single avatar letters
          text.length < 80 &&
          !text.includes("@") &&
          !text.toLowerCase().includes("family member") &&
          !/^\d+$/.test(text) // exclude pure numbers
        );
      });

      const displayName = nameEl?.textContent?.trim() ?? "";
      return { href, displayName, leafTexts };
    });
  });

  console.debug("[scrape] card raw count:", cardDebug.length);

  // Filter out Family Manager cards — detect by card text on list page
  const managerKw = ["family manager", "家庭群组管理员", "家庭群組管理員", "管理者"];
  const cardData = cardDebug.filter((c) => {
    const joined = c.leafTexts.join(" ").toLowerCase();
    return !managerKw.some((kw) => joined.includes(kw));
  }).map(({ href, displayName }) => ({ href, displayName }));

  const seenGaiaIds = new Set<string>();
  const uniqueCards: Array<{ href: string; displayName: string; gaiaId: string }> = [];
  for (const card of cardData) {
    if (!card.href) continue;

    // Extract gaiaId from href:
    //   /g/<id> = Google account (manager or accepted member)
    //   /member/i/<id> or /member/<id> = pending invite
    const gaiaId =
      card.href.match(/\/g\/([\d]+)/)?.[1] ??
      card.href.match(/\/member\/i\/([-\d]+)/)?.[1] ??
      card.href.match(/\/member\/([-\d]+)/)?.[1] ??
      card.href;
    if (!seenGaiaIds.has(gaiaId)) {
      seenGaiaIds.add(gaiaId);
      uniqueCards.push({ ...card, gaiaId });
    }
  }

  const members: ScrapedMember[] = [];
  const baseUrl = "https://myaccount.google.com/";

  for (const card of uniqueCards) {
    const detailUrl = card.href.startsWith("http")
      ? card.href
      : `${baseUrl}${card.href}`;

    try {
      await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(500);

      // Read emails from leaf-node elements only to avoid concatenated parent text
      const rawEmails: string[] = await page.evaluate(() => {
        const leafEls = Array.from(document.querySelectorAll("*"))
          .filter((el) => el.children.length === 0); // leaf nodes only
        const texts = leafEls
          .map((el) => el.textContent?.trim() ?? "")
          .filter((t) => t.includes("@") && t.includes("."));
        // Strict ASCII-only email regex to reject concatenated name+email+role strings
        return texts.filter((t) => /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(t));
      });

      // If the ONLY email on the page is the admin's AND this is a /g/ card (Google account page),
      // this is the manager's own card → skip entirely.
      // For /member/i/ cards (pending invites) showing admin email, keep as gaiaOnly.
      const nonAdminEmails = rawEmails.filter((e) => e.toLowerCase() !== adminEmail);
      const isGoogleAccountCard = /\/g\/\d+/.test(card.href);
      if (rawEmails.length > 0 && nonAdminEmails.length === 0 && isGoogleAccountCard) {
        // Manager detail page — only admin email found on /g/ card, skip entirely
        continue;
      }

      // Use the first non-admin email as the member's email (empty → becomes gaiaOnly)
      const email = nonAdminEmails[0]?.trim().toLowerCase() ?? "";

      // Role
      const role = await page.evaluate(() =>
        document.querySelector(".ImPZoc, [data-member-role]")?.textContent?.trim() ?? "member"
      );

      // Detect pending invite: Google shows cancel/revoke button instead of remove button.
      // Check all button texts on the page for cancel-invite indicators.
      const isPending = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a"))
          .map((el) => el.textContent?.trim() ?? "");
        const cancelKw = ["取消邀請", "取消邀请", "撤銷", "撤销", "Cancel invitation", "Revoke"];
        return btns.some((t) => cancelKw.some((kw) => t.includes(kw)));
      });

      if (email || card.gaiaId) {
        members.push({
          email,
          displayName: card.displayName,
          role,
          googleMemberId: card.gaiaId,
          isPending,
        });
      }
    } catch {
      // Skip unreadable member detail — still record with list-page data
      if (card.gaiaId) {
        members.push({
          email: "",
          displayName: card.displayName,
          role: "member",
          googleMemberId: card.gaiaId,
          isPending: false,
        });
      }
    }

    // Navigate back to family list
    await page.goto("https://myaccount.google.com/family/details?hl=en", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }).catch(() => {});
    await page.waitForTimeout(500);
  }

  // members array already excludes the Family Manager, so capacity is 5 (not 6)
  const finalSlots = slotMatch ? parseInt(slotMatch[1], 10) : Math.max(0, 5 - members.length);
  return { members, availableSlots: finalSlots };
}
