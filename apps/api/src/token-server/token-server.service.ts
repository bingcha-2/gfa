import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { Injectable } from "@nestjs/common";

import { AccessKeyStore } from "./access-key-store";
import { maskEmail, readJsonFile, writeJsonFile } from "./data-store";
import { accountWeight, EnterpriseProbeManager, scoreAccount } from "./lease-scheduler";
import {
  DEFAULT_AFFINITY_TTL_MS,
  DEFAULT_LEASE_TTL_MS,
  MAX_REMOTE_LEASE_TTL_MS,
  accessKeySessionTtlMs,
  affinityKey,
  normalizeModelKey,
  validateClientVersion,
} from "./token-billing";
import { refreshGoogleAccessToken, TokenAccount } from "./account-token-provider";

type ServiceOptions = {
  accountsFilePath?: string;
  accessKeysFilePath?: string;
  tokenProvider?: (account: TokenAccount) => Promise<string>;
  now?: () => number;
  randomId?: () => string;
  minClientVersion?: string;
  leaseTtlMs?: number;
  affinityTtlMs?: number;
};

type LeaseRecord = {
  leaseId: string;
  accountId: number;
  email: string;
  projectId: string;
  clientId: string;
  modelKey: string;
  accessKeyId: string;
  accessKeySessionId: string;
  createdAt: number;
  expiresAt: string;
  released: boolean;
  isGeneration: boolean;
  requestBodyBytes: number;
};

type HttpErrorBody = {
  statusCode: number;
  message: string;
};

function defaultDataDir() {
  if (process.env.ROSETTA_DATA_DIR) return process.env.ROSETTA_DATA_DIR;
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "Antigravity", "rosetta");
}

export class TokenServerHttpError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly body?: unknown) {
    super(message);
  }

  toBody(): HttpErrorBody | unknown {
    return this.body || { ok: false, error: this.message };
  }
}

@Injectable()
export class TokenServerService {
  private readonly accountsFilePath: string;
  private readonly accessKeyStore: AccessKeyStore;
  private readonly tokenProvider: (account: TokenAccount) => Promise<string>;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly minClientVersion: string;
  private readonly leaseTtlMs: number;
  private readonly affinityTtlMs: number;
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly clientAffinity = new Map<string, { accountId: number; expiresAt: number }>();
  private readonly enterpriseProbe = new EnterpriseProbeManager({ log: () => undefined });
  private totalLeases = 0;
  private totalReports = 0;
  private totalErrors = 0;
  private lastError = "";

  constructor(options: ServiceOptions = {}) {
    const dataDir = defaultDataDir();
    this.accountsFilePath = options.accountsFilePath || path.join(dataDir, "accounts.json");
    this.accessKeyStore = new AccessKeyStore(options.accessKeysFilePath || path.join(dataDir, "access-keys.json"));
    this.tokenProvider = options.tokenProvider || refreshGoogleAccessToken;
    this.now = options.now || Date.now;
    this.randomId = options.randomId || (() => crypto.randomUUID());
    this.minClientVersion = options.minClientVersion || process.env.BCAI_MIN_CLIENT_VERSION || "";
    this.leaseTtlMs = Number(options.leaseTtlMs || DEFAULT_LEASE_TTL_MS);
    this.affinityTtlMs = Number(options.affinityTtlMs || DEFAULT_AFFINITY_TTL_MS);
  }

  getStatus() {
    this.cleanupExpiredLeases();
    const accounts = this.readAccounts();
    return {
      running: true,
      mode: "remote-token-server",
      authMode: "access-key",
      totalLeases: this.totalLeases,
      totalReports: this.totalReports,
      totalErrors: this.totalErrors,
      lastError: this.lastError,
      activeLeases: Array.from(this.leases.values()).filter((lease) => !lease.released).length,
      affinityClients: this.clientAffinity.size,
      accessKeys: this.accessKeyStore.readAll().keys.map((key) => this.accessKeyStore.publicStatus(key)),
      accounts: {
        total: accounts.length,
        enabled: accounts.filter((account) => account.enabled !== false).length,
        withProject: accounts.filter((account) => account.projectId).length,
      },
    };
  }

  async leaseToken(req: any, payload: any) {
    const modelKey = String(payload?.modelKey || payload?.model || "").trim();
    const auth = this.accessKeyStore.resolveFromRequest(req, payload, {
      activate: true,
      enforceLimit: true,
      modelKey,
    });
    if (!auth.record) throw this.fail(401, auth.error || "Unauthorized");

    const versionCheck = validateClientVersion(payload, this.minClientVersion);
    if (!versionCheck.ok) {
      throw this.fail(versionCheck.statusCode || 426, "当前插件版本过低", {
        code: "CLIENT_UPGRADE_REQUIRED",
        error: "当前插件版本过低",
        ...versionCheck,
        ok: false,
      });
    }

    const sessionCheck = this.accessKeyStore.validateSession(auth.record, payload, this.now());
    if (!sessionCheck.ok) {
      throw this.fail(sessionCheck.statusCode || 409, sessionCheck.error || "Access key session conflict", {
        ok: false,
        error: sessionCheck.error,
        sessionClientId: sessionCheck.sessionClientId,
        sessionExpiresAt: sessionCheck.sessionExpiresAt,
        accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
      });
    }

    const clientId = String(payload?.clientId || payload?.client || "").trim();
    const accessKeySessionId = this.accessKeyStore.refreshSession(auth.record, { clientId }, this.now(), {
      create: sessionCheck.action === "create",
      rotate: sessionCheck.action === "refresh",
    });
    const account = this.selectAccount(modelKey, clientId, payload);
    if (!account) throw this.fail(503, "No account with projectId is available.");

    try {
      const accessToken = await this.tokenProvider(account);
      this.writeAccounts(this.readAccounts().map((item) => item.id === account.id ? { ...item, ...account } : item));
      const lease = this.createLease(account, accessKeySessionId, auth.record.id, clientId, modelKey, payload);
      this.leases.set(lease.leaseId, lease);
      this.rememberAffinity(clientId, modelKey, account.id);
      this.totalLeases++;
      this.accessKeyStore.flush();
      return {
        ok: true,
        leaseId: lease.leaseId,
        accessKeySessionId,
        sessionId: accessKeySessionId,
        sessionExpiresAt: auth.record.sessionExpiresAt || "",
        accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
        accountId: account.id,
        emailHint: maskEmail(account.email),
        accessToken,
        projectId: account.projectId,
        expiresAt: lease.expiresAt,
        probation: false,
        candidateStats: { healthyForModel: this.availableAccounts(payload).length },
        retryPolicy: null,
      };
    } catch (error) {
      throw this.fail(503, error instanceof Error ? error.message : "Token lease failed");
    }
  }

  async reportResult(req: any, payload: any) {
    const auth = this.accessKeyStore.resolveFromRequest(req, payload);
    if (!auth.record) throw this.fail(401, auth.error || "Unauthorized");

    const leaseId = String(payload?.leaseId || "").trim();
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return { ok: true, ignored: true, reason: "lease_not_found", status: this.getStatus() };
    }
    if (auth.record.id !== lease.accessKeyId) {
      throw this.fail(403, "Lease/access key mismatch");
    }

    const status = Number(payload?.status || 0);
    const modelKey = String(payload?.modelKey || lease.modelKey || "").trim();
    const usage = this.usageForBilling(lease, status, payload);
    this.accessKeyStore.recordUsage(lease.accessKeyId, status, usage, modelKey);
    this.accessKeyStore.refreshSession(auth.record, { clientId: lease.clientId }, this.now());
    this.accessKeyStore.flush();

    this.totalReports++;
    if (status >= 200 && status < 400) {
      this.enterpriseProbe.reportResult(lease.email, true);
    } else if (status >= 400) {
      lease.released = true;
      this.enterpriseProbe.reportResult(lease.email, false);
      this.clearAffinity(lease.accountId, lease.clientId, modelKey);
    }
    lease.released = true;

    return {
      ok: true,
      accessKeyStatus: this.accessKeyStore.publicStatus(auth.record),
      status: this.getStatus(),
    };
  }

  activateAccessKey(req: any, payload: any) {
    const accountCard = AccessKeyStore.extractKeyFromRequest(req, payload);
    const clientId = String(payload?.deviceId || payload?.clientId || payload?.client || "").trim();

    if (!accountCard) {
      return {
        success: false,
        code: "ACCOUNT_CARD_REQUIRED",
        message: "Account card is required",
      };
    }
    if (!clientId) {
      return {
        success: false,
        code: "ACCOUNT_CARD_AND_DEVICE_REQUIRED",
        message: "Account card and device id are required",
      };
    }

    const auth = this.accessKeyStore.resolveFromRequest(req, { ...payload, accessKey: accountCard }, { activate: true });
    if (!auth.record) {
      return {
        success: false,
        code: this.activationErrorCode(auth.error),
        message: auth.error || "Account card activation failed",
      };
    }

    const sessionPayload = { ...payload, clientId };
    const sessionCheck = this.accessKeyStore.validateSession(auth.record, sessionPayload, this.now());
    if (!sessionCheck.ok) {
      return {
        success: false,
        code: "DEVICE_BOUND_TO_ANOTHER_CLIENT",
        message: sessionCheck.error || "Account card is already active on another device",
        data: {
          sessionClientId: sessionCheck.sessionClientId,
          sessionExpiresAt: sessionCheck.sessionExpiresAt,
        },
      };
    }

    this.accessKeyStore.refreshSession(auth.record, sessionPayload, this.now(), {
      create: sessionCheck.action === "create",
      rotate: sessionCheck.action === "refresh",
    });
    this.accessKeyStore.flush();

    const accessKeyStatus = this.accessKeyStore.publicStatus(auth.record);
    return {
      success: true,
      code: "OK",
      message: "Activated",
      data: {
        accountCard: {
          id: auth.record.id,
          expiresAt: accessKeyStatus.expiresAt || "",
        },
        accessKeyStatus,
      },
    };
  }

  async shadowReport(req: any, payload: any) {
    this.accessKeyStore.resolveFromRequest(req, payload);
    return { ok: true };
  }

  reloadAccessKeys() {
    this.accessKeyStore.reload();
    return { ok: true, reloaded: true };
  }

  private readAccounts(): TokenAccount[] {
    const data = readJsonFile(this.accountsFilePath);
    const accounts = Array.isArray(data) ? data : Array.isArray(data.accounts) ? data.accounts : [];
    return accounts.map((account: any) => ({
      ...account,
      id: Number(account.id),
      email: String(account.email || ""),
      refreshToken: String(account.refreshToken || ""),
      projectId: String(account.projectId || "").trim(),
      enabled: account.enabled !== false,
    }));
  }

  private writeAccounts(accounts: TokenAccount[]) {
    const previous = readJsonFile(this.accountsFilePath);
    const value = Array.isArray(previous) ? accounts : { ...previous, accounts };
    writeJsonFile(this.accountsFilePath, value);
  }

  private availableAccounts(payload: any) {
    const excluded = new Set(
      (Array.isArray(payload?.excludeAccountIds) ? payload.excludeAccountIds : [])
        .map((value: unknown) => Number(value))
        .filter((value: number) => Number.isFinite(value) && value > 0),
    );
    return this.readAccounts().filter((account) =>
      account.enabled !== false &&
      Boolean(account.projectId) &&
      Boolean(account.refreshToken) &&
      !excluded.has(account.id),
    );
  }

  private selectAccount(modelKey: string, clientId: string, payload: any): TokenAccount | null {
    const candidates = this.availableAccounts(payload);
    if (!candidates.length) return null;
    const preferredAccountId = this.preferredAccountId(clientId, modelKey);
    const now = this.now();
    return candidates
      .map((account) => ({
        account,
        score: scoreAccount(account, {
          now,
          preferredAccountId,
          modelKey,
          activeLeaseCount: (accountId, targetModel) => this.activeLeaseCount(accountId, targetModel),
          accountStats: { lastUsedAt: 0 },
          accountWeight: accountWeight(account, this.enterpriseProbe),
        }),
      }))
      .sort((a, b) => a.score - b.score || a.account.id - b.account.id)[0].account;
  }

  private createLease(
    account: TokenAccount,
    accessKeySessionId: string,
    accessKeyId: string,
    clientId: string,
    modelKey: string,
    payload: any,
  ): LeaseRecord {
    const ttlMs = Math.max(60_000, Math.min(this.leaseTtlMs, MAX_REMOTE_LEASE_TTL_MS));
    return {
      leaseId: this.randomId(),
      accountId: account.id,
      email: account.email,
      projectId: String(account.projectId || ""),
      clientId,
      modelKey,
      accessKeyId,
      accessKeySessionId,
      createdAt: this.now(),
      expiresAt: new Date(this.now() + Math.min(ttlMs, accessKeySessionTtlMs({ sessionTtlMs: ttlMs }))).toISOString(),
      released: false,
      isGeneration: payload?.isGeneration !== false,
      requestBodyBytes: Math.max(0, Number(payload?.bodyBytes || payload?.requestBodyBytes || 0)),
    };
  }

  private usageForBilling(lease: LeaseRecord, status: number, payload: any) {
    const reported = Number(payload?.totalTokens || payload?.rawTotalTokens || 0);
    if (status >= 200 && status < 400 && lease.isGeneration && reported <= 0) {
      const inputTokens = Math.max(100, Math.ceil(lease.requestBodyBytes / 4));
      const outputTokens = Math.max(50, Math.ceil(inputTokens * 0.1));
      return { inputTokens, outputTokens, rawTotalTokens: inputTokens + outputTokens, totalTokens: inputTokens + outputTokens };
    }
    return {
      inputTokens: payload?.inputTokens,
      outputTokens: payload?.outputTokens,
      cachedInputTokens: payload?.cachedInputTokens,
      rawTotalTokens: payload?.rawTotalTokens,
      totalTokens: payload?.totalTokens,
    };
  }

  private activeLeaseCount(accountId: number, modelKey: string) {
    const targetModel = normalizeModelKey(modelKey);
    return Array.from(this.leases.values()).filter((lease) =>
      !lease.released &&
      lease.accountId === accountId &&
      (!targetModel || normalizeModelKey(lease.modelKey) === targetModel),
    ).length;
  }

  private preferredAccountId(clientId: string, modelKey: string) {
    if (!clientId) return 0;
    const affinity = this.clientAffinity.get(affinityKey(clientId, modelKey));
    if (!affinity || affinity.expiresAt <= this.now()) return 0;
    return affinity.accountId;
  }

  private rememberAffinity(clientId: string, modelKey: string, accountId: number) {
    if (!clientId) return;
    this.clientAffinity.set(affinityKey(clientId, modelKey), {
      accountId,
      expiresAt: this.now() + Math.max(60_000, this.affinityTtlMs),
    });
  }

  private clearAffinity(accountId: number, clientId: string, modelKey: string) {
    if (!clientId) return;
    const key = affinityKey(clientId, modelKey);
    if (this.clientAffinity.get(key)?.accountId === accountId) this.clientAffinity.delete(key);
  }

  private cleanupExpiredLeases() {
    const now = this.now();
    for (const lease of this.leases.values()) {
      if (Date.parse(lease.expiresAt) <= now) lease.released = true;
    }
    for (const [key, affinity] of this.clientAffinity.entries()) {
      if (affinity.expiresAt <= now) this.clientAffinity.delete(key);
    }
  }

  private fail(statusCode: number, message: string, body?: unknown) {
    this.totalErrors++;
    this.lastError = message;
    return new TokenServerHttpError(statusCode, message, body);
  }

  private activationErrorCode(error?: string) {
    if (!error) return "ACCOUNT_CARD_NOT_FOUND";
    if (error.includes("Missing")) return "ACCOUNT_CARD_REQUIRED";
    if (error.includes("Invalid")) return "ACCOUNT_CARD_NOT_FOUND";
    if (error.includes("disabled")) return "ACCOUNT_CARD_INACTIVE";
    if (error.includes("expired")) return "ACCOUNT_CARD_EXPIRED";
    return "ACCOUNT_CARD_NOT_FOUND";
  }
}
