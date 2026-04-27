/**
 * Rosetta state types for the Webview UI.
 * Mirrors the shape pushed by rosettaHandler via postMessage.
 */

export interface RosettaQuotaEntry {
  key: string;
  label: string;
  percent: number;
  hasSnapshotPercent: boolean;
  resetTime: string;
  provider: string;
  isBlocked: boolean;
  displayPercent: number;
}

export interface RosettaQuotaGroup {
  key: string;
  title: string;
  percent: number;
  hasSnapshotPercent: boolean;
  resetTime: string;
  modelCount: number;
  blockedCount: number;
  entries: RosettaQuotaEntry[];
}

export interface RosettaAccount {
  id: number;
  email: string;
  enabled: boolean;
  alias: string;
  planType: string;
  projectId: string;
  isActive: boolean;
  quotaStatus: string;
  canRotate: boolean;
  quotaLiveBlockedCount: number;
  quotaRefreshedAt: string;
  accountResetTime: string;
  quotaGroups: RosettaQuotaGroup[];
  accountStatusLabel: string;
  accountStatusTone: string;
  hasCredentials: boolean;
  successRate: number | null;
  qualityTier: string;
  requestStats: { total: number; successes: number; failures: number };
}

export interface RosettaReverseProxy {
  running: boolean;
  url: string;
  port: number;
  apiKey: string;
  defaultModel: string;
  totalRequests: number;
  totalErrors: number;
  models: Array<{ id: string }>;
  endpoints: Array<{ path: string; format: string }>;
  routeHits: Record<string, number>;
  toolBridge: boolean;
}

export interface RosettaRelay {
  running: boolean;
  url: string;
  statusUrl: string;
  upstream: string;
  hasApiKey: boolean;
  totalRequests: number;
  totalErrors: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastError: string | null;
  accessKeyStatus?: {
    id: string;
    name: string;
    status: string;
    firstUsedAt: string;
    expiresAt: string;
    remainingMs: number;
    totalRequests: number;
    recentWindowRequests: number;
    windowLimit: number;
    windowMs: number;
    lastUsedAt: string;
  } | null;
}

export interface RosettaState {
  ready: boolean;
  problem: string;
  proxy: {
    running: boolean;
    activeEmail: string;
    totalAccounts: number;
    rotatableAccounts: number;
    totalRequests: number;
    totalRotations: number;
    url: string;
  };
  reverseProxy: RosettaReverseProxy;
  relay: RosettaRelay;
  ide: {
    configuredUrl: string;
    expectedUrl: string;
    isConfigured: boolean;
    isLiveAttached: boolean;
  };
  logs: {
    path: string;
    exists: boolean;
    updatedAt: number;
    lines: string[];
  };
  accounts: RosettaAccount[];
}
