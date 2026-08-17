import type { QuotaEstimatorAccountState, QuotaEstimatorScopeState } from "../token-server/account-quota-estimator";

export type QuotaPoolProvider = "codex" | "anthropic";
export type QuotaPoolConfidence = "unavailable" | "insufficient" | "low" | "medium" | "high";
export type QuotaPoolAlert = "ok" | "warning" | "danger" | "insufficient";

export type QuotaPoolAccountInput = {
  id: number;
  accountKey: string;
  email: string;
  planType: string;
  hourlyPercent: number | null;
  weeklyPercent: number | null;
  hourlyResetAt: string | null;
  weeklyResetAt: string | null;
  refreshedAt: number;
};

export type QuotaPoolSubscriptionInput = {
  id: string;
  customerEmail: string;
  status: string;
  bindingAccountId: number;
  weight: number;
  exclusive: boolean;
  fiveHourLimit: number;
  weeklyLimit: number;
  usedFiveHour: number;
  usedWeekly: number;
  upstreamAccountId: number;
};

export type QuotaPoolScope = {
  remainingPercent: number | null;
  resetAt: string | null;
  trackedUsedUsd: number;
  soldLimitUsd: number;
  customerRemainingUsd: number;
  inferredTotalUsd: number | null;
  inferredRemainingUsd: number | null;
  shortfallUsd: number;
  coverageRatio: number | null;
  confidence: QuotaPoolConfidence;
  reasons: string[];
};

export type QuotaPoolSummary = {
  provider: QuotaPoolProvider;
  accountId: number;
  email: string;
  planType: string;
  refreshedAt: number;
  activeSubscriptionCount: number;
  accountingSubscriptionCount: number;
  boundCustomerEmails: string[];
  totalSeats: number;
  fiveHour: QuotaPoolScope;
  weekly: QuotaPoolScope;
  minCoverageRatio: number | null;
  alert: QuotaPoolAlert;
};

const STALE_AFTER_MS = 15 * 60 * 1000;
const EPSILON = 1e-9;

function finiteNonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizedPercent(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

function normalizeTimestamp(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 10_000_000_000 ? n * 1000 : n;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function downgradeConfidence(confidence: QuotaPoolConfidence): QuotaPoolConfidence {
  if (confidence === "high") return "medium";
  if (confidence === "medium") return "low";
  return confidence;
}

function buildScope(
  scope: "fiveHour" | "weekly",
  account: QuotaPoolAccountInput,
  subscriptions: QuotaPoolSubscriptionInput[],
  now: number,
  estimator?: QuotaEstimatorScopeState,
): QuotaPoolScope {
  const accountRemaining = normalizedPercent(
    scope === "fiveHour" ? account.hourlyPercent : account.weeklyPercent,
  );
  // Never combine a newly refreshed account-file percentage with an older
  // Redis estimate. If estimator state exists, all displayed window values
  // come from that same atomic hash/epoch; the account file is display-only
  // fallback while Redis is cold.
  const remainingPercent = estimator
    ? normalizedPercent(estimator.remainingPercent)
    : accountRemaining;
  const accountResetAt = scope === "fiveHour" ? account.hourlyResetAt : account.weeklyResetAt;
  const resetAt = estimator
    ? (estimator.resetAt ? new Date(estimator.resetAt).toISOString() : null)
    : accountResetAt;
  const limitKey = scope === "fiveHour" ? "fiveHourLimit" : "weeklyLimit";
  const usedKey = scope === "fiveHour" ? "usedFiveHour" : "usedWeekly";

  const activeBound = subscriptions.filter(
    (subscription) => subscription.status === "ACTIVE" && subscription.bindingAccountId === account.id,
  );
  const trackedUsedUsd = estimator
    ? roundUsd(finiteNonNegative(estimator.trackedUsedUsd))
    : 0;
  const soldLimitUsd = roundUsd(
    activeBound.reduce((sum, subscription) => sum + finiteNonNegative(subscription[limitKey]), 0),
  );
  const customerRemainingUsd = roundUsd(
    activeBound.reduce(
      (sum, subscription) => sum + Math.max(
        0,
        finiteNonNegative(subscription[limitKey]) - finiteNonNegative(subscription[usedKey]),
      ),
      0,
    ),
  );

  const result: QuotaPoolScope = {
    remainingPercent,
    resetAt,
    trackedUsedUsd,
    soldLimitUsd,
    customerRemainingUsd,
    inferredTotalUsd: null,
    inferredRemainingUsd: null,
    shortfallUsd: 0,
    coverageRatio: null,
    confidence: "unavailable",
    reasons: [],
  };

  if (remainingPercent === null) {
    result.reasons.push("母号尚未报告该额度窗口");
    return result;
  }
  if (!estimator) {
    result.confidence = "insufficient";
    result.reasons.push("母号用量正在按实际服务账号采样");
    return result;
  }
  if (estimator.inferredTotalUsd === null || estimator.inferredTotalUsd <= EPSILON) {
    result.confidence = "insufficient";
    result.reasons.push(`同一额度周期内的有效样本不足（${estimator.sampleCount} 段）`);
    return result;
  }

  result.inferredTotalUsd = roundUsd(estimator.inferredTotalUsd);
  result.inferredRemainingUsd = roundUsd(result.inferredTotalUsd * (remainingPercent / 100));
  result.shortfallUsd = roundUsd(Math.max(0, customerRemainingUsd - result.inferredRemainingUsd));
  result.coverageRatio = customerRemainingUsd > EPSILON
    ? Math.round((result.inferredRemainingUsd / customerRemainingUsd) * 10_000) / 10_000
    : null;
  result.confidence = estimator.confidence;

  const refreshedAt = normalizeTimestamp(estimator.lastSnapshotAt);
  if (!refreshedAt || now - refreshedAt > STALE_AFTER_MS) {
    result.confidence = downgradeConfidence(result.confidence);
    result.reasons.push("母号额度快照超过 15 分钟未刷新");
  }
  result.reasons.push("用量按 lease 发放时的实际母号归因，仅统计本系统 API 原价等价用量");
  return result;
}

export function estimateQuotaPool(
  provider: QuotaPoolProvider,
  account: QuotaPoolAccountInput,
  subscriptions: QuotaPoolSubscriptionInput[],
  now = Date.now(),
  estimator?: QuotaEstimatorAccountState,
): QuotaPoolSummary {
  const activeBound = subscriptions.filter(
    (subscription) => subscription.status === "ACTIVE" && subscription.bindingAccountId === account.id,
  );
  const accounting = subscriptions.filter((subscription) => {
    const used = finiteNonNegative(subscription.usedFiveHour) + finiteNonNegative(subscription.usedWeekly);
    if (used <= EPSILON) return false;
    if (subscription.upstreamAccountId > 0) return subscription.upstreamAccountId === account.id;
    return subscription.status === "ACTIVE" && subscription.bindingAccountId === account.id;
  });
  const fiveHour = buildScope("fiveHour", account, subscriptions, now, estimator?.fiveHour);
  const weekly = buildScope("weekly", account, subscriptions, now, estimator?.weekly);
  const coverages = [fiveHour.coverageRatio, weekly.coverageRatio]
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const minCoverageRatio = coverages.length ? Math.min(...coverages) : null;
  const alert: QuotaPoolAlert = minCoverageRatio === null
    ? "insufficient"
    : minCoverageRatio < 0.9
      ? "danger"
      : minCoverageRatio < 1.1
        ? "warning"
        : "ok";

  return {
    provider,
    accountId: account.id,
    email: account.email,
    planType: account.planType,
    refreshedAt: normalizeTimestamp(account.refreshedAt),
    activeSubscriptionCount: activeBound.length,
    accountingSubscriptionCount: accounting.length,
    boundCustomerEmails: [...new Set(
      activeBound.map((subscription) => subscription.customerEmail.trim().toLowerCase()).filter(Boolean),
    )],
    totalSeats: activeBound.reduce((sum, subscription) => sum + subscription.weight, 0),
    fiveHour,
    weekly,
    minCoverageRatio,
    alert,
  };
}
