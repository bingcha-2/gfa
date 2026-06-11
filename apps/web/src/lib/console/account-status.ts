// Shared, presentation-free helpers for an upstream account's runtime health,
// derived from the persisted quotaStatus the API now exposes on every account.

export type AccountStatusInput = {
  quotaStatus?: string;
  quotaStatusReason?: string;
};

export type AccountStatusBadge = {
  tone: "green" | "yellow" | "red";
  label: string;
};

/**
 * Bucket accounts into healthy vs not-ok, grouping the not-ok ones by reason.
 * Any non-"ok" status (error / exhausted / cooling) counts as not-ok — the old
 * summary only counted "exhausted", so dead (error) accounts were silently
 * tallied as healthy.
 */
export function accountHealthSummary(
  accounts: AccountStatusInput[],
): { okCount: number; reasons: Record<string, number> } {
  const reasons: Record<string, number> = {};
  let okCount = 0;
  for (const a of accounts) {
    const status = a.quotaStatus || "ok";
    if (status === "ok") {
      okCount++;
      continue;
    }
    const reason = a.quotaStatusReason || status || "unknown";
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return { okCount, reasons };
}

/** Map a persisted quotaStatus to a colored badge for the account tables. */
export function accountStatusLabel(
  quotaStatus?: string,
  quotaStatusReason?: string,
): AccountStatusBadge {
  const status = quotaStatus || "ok";
  if (status === "error") {
    const reason = quotaStatusReason === "invalid_grant" ? "鉴权失效" : "连续报错";
    return { tone: "red", label: `已失效·${reason}` };
  }
  if (status === "exhausted" || status === "cooling") {
    return { tone: "yellow", label: "额度恢复中" };
  }
  return { tone: "green", label: "正常" };
}
