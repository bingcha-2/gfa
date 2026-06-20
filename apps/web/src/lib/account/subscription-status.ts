/**
 * Membership-status derivation for the account overview.
 *
 * The membership pass must report the user's REAL state. A subscription row can
 * carry `status: "ACTIVE"` while its `expiresAt` has already passed; treating
 * mere existence as "active" makes the pass claim 运行中 / 正常 over a lapsed
 * plan — the single worst failure for a portal whose job is "3 秒看清状态".
 */

import type { QuotaBucket, Subscription } from "./user-types";

export type MembershipState = "active" | "expiring_soon" | "expired" | "none";

const DAY_MS = 86_400_000;

/** An active membership entering this window (in days) flips to "expiring_soon". */
export const EXPIRING_SOON_DAYS = 7;

type SubLike = Pick<Subscription, "status" | "expiresAt">;

/** ACTIVE status AND not past its expiry. A null expiry never lapses. */
export function isSubscriptionActive<T extends SubLike>(sub: T, now: number): boolean {
  if (sub.status.toUpperCase() !== "ACTIVE") return false;
  if (sub.expiresAt == null) return true;
  return new Date(sub.expiresAt).getTime() > now;
}

/**
 * Pick the subscription that represents the account on the membership pass:
 * a currently-active one if any exists, otherwise the most recently expired
 * (latest expiry). Mirrors the billing center's selection so the two never
 * disagree about which plan is "current".
 */
export function pickRepresentativeSubscription<T extends SubLike>(
  subscriptions: T[],
  now: number
): T | null {
  if (subscriptions.length === 0) return null;
  return [...subscriptions].sort((a, b) => {
    const aActive = isSubscriptionActive(a, now) ? 1 : 0;
    const bActive = isSubscriptionActive(b, now) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aExp = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bExp = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
    return bExp - aExp;
  })[0];
}

/**
 * Display name for a subscription on the membership pass / subscriptions list.
 *
 * "迁移卡密订阅" is the label for subs migrated from an old 卡密, and ONLY those —
 * the discriminator is the explicit `migratedFromCard` flag. The overview endpoint
 * sends `planName: null` for every sub (the configurator has no single plan name),
 * so guessing "null ⇒ migrated" mislabels normal purchases. Falls back to the
 * authorized products (matching the billing center's `products.join("+")`).
 */
export function subscriptionPlanLabel(
  sub: Pick<Subscription, "planName" | "migratedFromCard" | "products"> & { seatsLabel?: string | null }
): string {
  const seatsLabel = sub.seatsLabel?.trim();
  if (seatsLabel && sub.products.length > 0) return `${sub.products.join("+")} · ${seatsLabel}`;
  if (sub.planName && sub.planName.trim()) return sub.planName;
  if (sub.migratedFromCard) return "迁移卡密订阅";
  if (sub.products.length > 0) return sub.products.join("+");
  return "会员订阅";
}

export function quotaMeterPercent(
  bucket: Pick<QuotaBucket, "bucket" | "used" | "limit"> | null | undefined
): number | null {
  if (!bucket || Number(bucket.limit) <= 0) return null;
  const used = Number(bucket.used ?? 0);
  return Math.max(0, Math.min(100, Math.round(((bucket.limit - used) / bucket.limit) * 100)));
}

export function quotaMeterValueLabel(
  bucket: Pick<QuotaBucket, "bucket" | "used" | "limit"> | null | undefined
): string | null {
  const pct = quotaMeterPercent(bucket);
  return pct == null ? null : `${pct}%`;
}

/**
 * Heading + live-grant flag for the membership pass's products area.
 *
 * "授权产品" asserts the products are authorized right now, so it must only show
 * while the membership is active (active / expiring_soon). A lapsed plan renders
 * its 套餐产品 muted — what renewing would restore, not a current authorization.
 */
export function productEntitlementBadge(state: MembershipState): {
  label: string;
  active: boolean;
} {
  const active = state === "active" || state === "expiring_soon";
  return { label: active ? "授权产品" : "套餐产品", active };
}

export type MembershipStatus<T> = {
  state: MembershipState;
  best: T | null;
  /** Whole days until expiry; negative once lapsed; null when it never expires. */
  daysLeft: number | null;
};

export function deriveMembershipStatus<T extends SubLike>(
  subscriptions: T[],
  now: number
): MembershipStatus<T> {
  const best = pickRepresentativeSubscription(subscriptions, now);
  if (!best) return { state: "none", best: null, daysLeft: null };
  // A cancelled subscription grants nothing — present the pass as 未开通 (none),
  // not 已过期. (Product decision: cancellation has no dedicated card state.)
  if (best.status.toUpperCase() === "CANCELLED") {
    return { state: "none", best: null, daysLeft: null };
  }

  const daysLeft =
    best.expiresAt == null
      ? null
      : Math.ceil((new Date(best.expiresAt).getTime() - now) / DAY_MS);

  if (!isSubscriptionActive(best, now)) return { state: "expired", best, daysLeft };
  if (daysLeft != null && daysLeft <= EXPIRING_SOON_DAYS) {
    return { state: "expiring_soon", best, daysLeft };
  }
  return { state: "active", best, daysLeft };
}
