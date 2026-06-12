// ── Types for rosetta-load dashboard ──

export type BlockedModel = {
  modelKey: string;
  reason: string;
  blockedUntil: number;
  accountId?: number;
};

export type RequestStats = {
  total: number;
  successes: number;
  failures: number;
};

export type QuotaAccount = {
  id: number | string;
  email?: string;
  enabled?: boolean;
  planType?: string;
  projectId?: string;
  quotaStatus?: string;
  quotaStatusReason?: string;
  blockedUntil?: number;
  requestStats?: RequestStats;
  successRate?: number | null;
  lastConversationOkAt?: string;
  lastStatus?: string;
  activeLeases?: number;
  blockedModels?: BlockedModel[];
  modelQuotaFractions?: Record<string, number>;
  modelQuotaResetTimes?: Record<string, string>;
  modelQuotaRefreshedAt?: number;
};

export type DailyStats = {
  date?: string;
  leases?: number;
  successes?: number;
  errors?: number;
  tokensUsed?: number;
};

export type AccountStats = {
  totalLeases?: number;
  successCount?: number;
  errorCount?: number;
  totalTokensUsed?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  locationFailures?: number;
  lastStatus?: string;
  blockedUntil?: number;
  recentResults?: Array<{ ok?: boolean }>;
};

export type ModelGate = {
  modelKey: string;
  accountId: number;
  reason: string;
  blockedUntil: number;
};

export type EnterpriseProbeGroup = {
  weight: number;
  rate: number | null;
  emergency: boolean;
  successes: number;
  failures: number;
  cycleMinutesLeft: number;
};

export type Scheduler = {
  activeLeaseCounts?: Record<string, number>;
  accountStats?: Record<string, AccountStats>;
  modelGates?: ModelGate[];
  affinityClients?: number;
};

export type StatusData = {
  running?: boolean;
  port?: number;
  activeLeases?: number;
  totalLeases?: number;
  totalReports?: number;
  affinityClients?: number;
  daily?: DailyStats;
  quota?: { accounts?: QuotaAccount[] };
  scheduler?: Scheduler;
  enterpriseProbe?: Record<string, EnterpriseProbeGroup>;
};

export type ModelRow = {
  id: string;
  name: string;
  baseDelayMs: string;
  capacityWaitMs: string;
  maxAttempts: string;
  backoffMultiplier: string;
};

export type EscalationRow = {
  id: string;
  rate503: string;
  addDelayMs: string;
};

export interface CanonicalModel {
  id: string;
  displayName: string;
  aliases: string[];
}

export type QuotaDisplayItem = {
  key: string;
  label: string;
  percentage: number;
  resetTime: string;
};

/** Enriched account with computed fields (prefixed with _) */
export type EnrichedAccount = QuotaAccount & {
  _id: string;
  _activeLeases: number;
  _total: number;
  _successes: number;
  _failures: number;
  _successRate: number | null;
  _cooldownMs: number;
  _blockedModels: BlockedModel[];
  _locationFailures: number;
  _totalTokensUsed: number;
  _totalInputTokens: number;
  _totalOutputTokens: number;
  _lastStatus: string;
};
