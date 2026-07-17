export type QuotaPoolProvider = "codex" | "anthropic";
export type QuotaPoolConfidence = "unavailable" | "insufficient" | "low" | "medium" | "high";
export type QuotaPoolAlert = "ok" | "warning" | "danger" | "insufficient";

export type QuotaPoolAccountInput = {
  id: number;
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

const MIN_SAMPLE_BURN = 0.03;
const LOW_SAMPLE_BURN = 0.1;
const MEDIUM_SAMPLE_BURN = 0.3;
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
): QuotaPoolScope {
  const remainingPercent = normalizedPercent(
    scope === "fiveHour" ? account.hourlyPercent : account.weeklyPercent,
  );
  const resetAt = scope === "fiveHour" ? account.hourlyResetAt : account.weeklyResetAt;
  const limitKey = scope === "fiveHour" ? "fiveHourLimit" : "weeklyLimit";
  const usedKey = scope === "fiveHour" ? "usedFiveHour" : "usedWeekly";

  const activeBound = subscriptions.filter(
    (subscription) => subscription.status === "ACTIVE" && subscription.bindingAccountId === account.id,
  );
  const accounted = subscriptions.filter((subscription) => {
    if (subscription.upstreamAccountId > 0) return subscription.upstreamAccountId === account.id;
    return subscription.status === "ACTIVE" && subscription.bindingAccountId === account.id;
  });

  const trackedUsedUsd = roundUsd(
    accounted.reduce((sum, subscription) => sum + finiteNonNegative(subscription[usedKey]), 0),
  );
  const soldLimitUsd = roundUsd(
    activeBound.reduce((sum, subscription) => sum + finiteNonNegative(subscription[limitKey]), 0),
  );
  const customerRemainingUsd = roundUsd(
    activeBound.reduce(
      (sum, subscription) => sum + Math.max(0,
        finiteNonNegative(subscription[limitKey]) - finiteNonNegative(subscription[usedKey])),
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
    result.reasons.push("母号未报告该窗口");
    return result;
  }

  const burnFraction = 1 - remainingPercent / 100;
  if (burnFraction <= EPSILON) {
    result.confidence = "insufficient";
    result.reasons.push("母号尚未产生可测量消耗");
    return result;
  }
  if (trackedUsedUsd <= EPSILON) {
    result.confidence = "insufficient";
    result.reasons.push("母号已下降，但没有可归因的订阅美元用量");
    return result;
  }
  if (burnFraction < MIN_SAMPLE_BURN) {
    result.confidence = "insufficient";
    result.reasons.push("母号消耗不足 3%，样本波动过大");
    return result;
  }

  result.inferredTotalUsd = roundUsd(trackedUsedUsd / burnFraction);
  result.inferredRemainingUsd = roundUsd(result.inferredTotalUsd * (remainingPercent / 100));
  result.shortfallUsd = roundUsd(Math.max(0, customerRemainingUsd - result.inferredRemainingUsd));
  result.coverageRatio = customerRemainingUsd > EPSILON
    ? Math.round((result.inferredRemainingUsd / customerRemainingUsd) * 10_000) / 10_000
    : null;
  result.confidence = burnFraction < LOW_SAMPLE_BURN
    ? "low"
    : burnFraction < MEDIUM_SAMPLE_BURN
      ? "medium"
      : "high";

  const refreshedAt = normalizeTimestamp(account.refreshedAt);
  if (!refreshedAt || now - refreshedAt > STALE_AFTER_MS) {
    result.confidence = downgradeConfidence(result.confidence);
    result.reasons.push("母号额度快照超过 15 分钟未刷新");
  }
  result.reasons.push("估算仅覆盖本系统已记录的 API 等价美元用量");
  return result;
}

export function estimateQuotaPool(
  provider: QuotaPoolProvider,
  account: QuotaPoolAccountInput,
  subscriptions: QuotaPoolSubscriptionInput[],
  now = Date.now(),
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
  const fiveHour = buildScope("fiveHour", account, subscriptions, now);
  const weekly = buildScope("weekly", account, subscriptions, now);
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
