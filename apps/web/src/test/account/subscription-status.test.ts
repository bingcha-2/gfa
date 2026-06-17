/**
 * Tests for membership-status derivation:
 *   src/lib/account/subscription-status.ts
 *
 * Regression guard for the overview bug where an EXPIRED subscription rendered
 * as "ACTIVE / 运行中 / 正常" because the panel only checked existence, not status
 * or expiry.
 */

import { describe, expect, it } from "vitest";

import {
  deriveMembershipStatus,
  isSubscriptionActive,
  pickRepresentativeSubscription,
  productEntitlementBadge,
  quotaMeterPercent,
  quotaMeterValueLabel,
  subscriptionPlanLabel,
} from "@/lib/account/subscription-status";

const NOW = Date.parse("2026-06-13T00:00:00.000Z");
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString();

type SubLike = { id?: string; status: string; expiresAt: string | null };
const sub = (over: Partial<SubLike>): SubLike => ({
  status: "ACTIVE",
  expiresAt: null,
  ...over,
});

describe("isSubscriptionActive", () => {
  it("is true for ACTIVE with a future expiry", () => {
    expect(isSubscriptionActive(sub({ expiresAt: iso(10) }), NOW)).toBe(true);
  });
  it("is true for ACTIVE that never expires", () => {
    expect(isSubscriptionActive(sub({ expiresAt: null }), NOW)).toBe(true);
  });
  it("is FALSE for ACTIVE status whose expiry is in the past (the bug)", () => {
    expect(isSubscriptionActive(sub({ status: "ACTIVE", expiresAt: iso(-1) }), NOW)).toBe(false);
  });
  it("is false for a non-active status even with a future expiry", () => {
    expect(isSubscriptionActive(sub({ status: "EXPIRED", expiresAt: iso(10) }), NOW)).toBe(false);
  });
  it("treats status case-insensitively", () => {
    expect(isSubscriptionActive(sub({ status: "active", expiresAt: iso(5) }), NOW)).toBe(true);
  });
});

describe("pickRepresentativeSubscription", () => {
  it("returns null for an empty list", () => {
    expect(pickRepresentativeSubscription([], NOW)).toBeNull();
  });
  it("prefers an active subscription over an inactive one that expires later", () => {
    const expiredLater = sub({ id: "a", status: "EXPIRED", expiresAt: iso(100) });
    const activeNow = sub({ id: "b", status: "ACTIVE", expiresAt: iso(5) });
    expect(pickRepresentativeSubscription([expiredLater, activeNow], NOW)?.id).toBe("b");
  });
  it("when none are active, returns the one that expired most recently", () => {
    const old = sub({ id: "old", status: "EXPIRED", expiresAt: iso(-30) });
    const recent = sub({ id: "recent", status: "EXPIRED", expiresAt: iso(-2) });
    expect(pickRepresentativeSubscription([old, recent], NOW)?.id).toBe("recent");
  });
});

describe("deriveMembershipStatus", () => {
  it("returns 'none' when there are no subscriptions", () => {
    expect(deriveMembershipStatus([], NOW)).toEqual({ state: "none", best: null, daysLeft: null });
  });
  it("returns 'active' for an ACTIVE sub comfortably in the future", () => {
    const r = deriveMembershipStatus([sub({ expiresAt: iso(30) })], NOW);
    expect(r.state).toBe("active");
    expect(r.daysLeft).toBe(30);
  });
  it("returns 'active' with null daysLeft for a never-expiring sub", () => {
    const r = deriveMembershipStatus([sub({ expiresAt: null })], NOW);
    expect(r.state).toBe("active");
    expect(r.daysLeft).toBeNull();
  });
  it("returns 'expiring_soon' within the 7-day window", () => {
    expect(deriveMembershipStatus([sub({ expiresAt: iso(3) })], NOW).state).toBe("expiring_soon");
    expect(deriveMembershipStatus([sub({ expiresAt: iso(7) })], NOW).state).toBe("expiring_soon");
  });
  it("returns 'expired' for an ACTIVE-status sub whose expiry has passed (the bug)", () => {
    const r = deriveMembershipStatus([sub({ status: "ACTIVE", expiresAt: iso(-1) })], NOW);
    expect(r.state).toBe("expired");
    expect(r.daysLeft).toBe(-1);
  });
  it("returns 'expired' for an EXPIRED-status sub", () => {
    expect(deriveMembershipStatus([sub({ status: "EXPIRED", expiresAt: iso(-10) })], NOW).state).toBe("expired");
  });
});

describe("subscriptionPlanLabel", () => {
  // The overview endpoint sends planName=null for every sub, so the discriminator
  // for "迁移卡密订阅" must be the explicit migratedFromCard flag — NOT planName==null.
  type SubLike = { planName: string | null; migratedFromCard: boolean; products: string[]; seatsLabel?: string };
  const label = (over: Partial<SubLike>): string =>
    subscriptionPlanLabel({ planName: null, migratedFromCard: false, products: [], ...over });

  it("uses the backend plan name verbatim when present", () => {
    expect(label({ planName: "Pro 年付" })).toBe("Pro 年付");
  });

  it("labels a card-migrated subscription 迁移卡密订阅", () => {
    expect(label({ migratedFromCard: true })).toBe("迁移卡密订阅");
  });

  it("keeps 迁移卡密订阅 for a migrated sub even when it carries products", () => {
    expect(label({ migratedFromCard: true, products: ["codex"] })).toBe("迁移卡密订阅");
  });

  it("does NOT call a normal purchased sub 迁移卡密订阅 — shows its products (the bug)", () => {
    expect(label({ migratedFromCard: false, products: ["codex"] })).toBe("codex");
  });

  it("joins multiple products for a configurator subscription", () => {
    expect(label({ products: ["codex", "claude"] })).toBe("codex+claude");
  });

  it("appends the backend seats label for a unified bind subscription", () => {
    expect(label({ products: ["codex", "claude"], seatsLabel: "2/8 席" })).toBe("codex+claude · 2/8 席");
  });

  it("falls back to a generic name for a nameless, non-migrated, product-less sub", () => {
    expect(label({})).toBe("会员订阅");
  });
});

describe("quota meter display", () => {
  it("uses remaining percent for the quota bar", () => {
    expect(quotaMeterPercent({ bucket: "anthropic-claude", used: 4_000_000, limit: 20_000_000 })).toBe(80);
  });

  it("exposes a percent label, not raw token counts", () => {
    const label = quotaMeterValueLabel({ bucket: "anthropic-claude", used: 4_000_000, limit: 20_000_000 });

    expect(label).toBe("80%");
    expect(label).not.toContain("4000000");
    expect(label).not.toContain("20,000,000");
  });
});

describe("productEntitlementBadge", () => {
  // "授权产品" claims the grant is live, so it must only appear while the
  // membership is actually active. A lapsed plan shows 套餐产品 (muted) — what
  // renewing would restore, not a current authorization.
  it("reads 授权产品 / active while the membership is live", () => {
    expect(productEntitlementBadge("active")).toEqual({ label: "授权产品", active: true });
  });

  it("stays 授权产品 / active during the expiring-soon grace window", () => {
    expect(productEntitlementBadge("expiring_soon")).toEqual({ label: "授权产品", active: true });
  });

  it("relabels to 套餐产品 / inactive once expired — no false 授权 claim (the bug)", () => {
    expect(productEntitlementBadge("expired")).toEqual({ label: "套餐产品", active: false });
  });

  it("treats a no-plan account as inactive 套餐产品", () => {
    expect(productEntitlementBadge("none")).toEqual({ label: "套餐产品", active: false });
  });
});

describe("deriveMembershipStatus — cancellation", () => {
  it("folds a cancelled representative (no active sub) into 'none' — the pass reads 未开通, not 已过期", () => {
    expect(deriveMembershipStatus([sub({ status: "CANCELLED", expiresAt: iso(-2) })], NOW)).toEqual({
      state: "none",
      best: null,
      daysLeft: null,
    });
  });

  it("still reports 'active' when an active sub coexists with a cancelled one", () => {
    const r = deriveMembershipStatus(
      [
        sub({ id: "x", status: "CANCELLED", expiresAt: iso(100) }),
        sub({ id: "y", status: "ACTIVE", expiresAt: iso(20) }),
      ],
      NOW
    );
    expect(r.state).toBe("active");
    expect(r.best?.id).toBe("y");
  });
});
