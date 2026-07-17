export type QuotaPoolConfidence = "unavailable" | "insufficient" | "low" | "medium" | "high";
export type QuotaPoolAlert = "ok" | "warning" | "danger" | "insufficient";

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
  provider: "codex" | "anthropic";
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

export type QuotaPoolSubscription = {
  id: string;
  customerId: string;
  customerEmail: string;
  customerName: string;
  status: string;
  exclusive: boolean;
  weight: number;
  startsAt: string | null;
  expiresAt: string | null;
  fiveHour: { used: number; limit: number; remaining: number };
  weekly: { used: number; limit: number; remaining: number };
  usdQuotaPerSeatByProduct: Record<string, { fiveHour: number; weekly: number }>;
  includedInEstimate: boolean;
  order: {
    id: string;
    outTradeNo: string;
    amountCents: number;
    payChannel: string;
    status: string;
    paidAt: string | null;
  } | null;
};

export type QuotaPoolDetail = QuotaPoolSummary & {
  subscriptions: QuotaPoolSubscription[];
};

export type QuotaPoolTarget = {
  provider: "codex" | "anthropic";
  id: number;
  email: string;
};

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatQuotaUsd(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : USD_FORMATTER.format(value);
}

export function formatQuotaPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${Math.round(value)}%`;
}

export function formatCoverage(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${Math.round(value * 100)}%`;
}

export function confidenceLabel(value: QuotaPoolConfidence): string {
  return {
    unavailable: "不可用",
    insufficient: "采样不足",
    low: "低可信",
    medium: "中可信",
    high: "高可信",
  }[value];
}
