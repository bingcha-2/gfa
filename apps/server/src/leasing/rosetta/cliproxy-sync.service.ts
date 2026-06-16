import * as crypto from "crypto";
import * as path from "path";

import { BadRequestException, Logger } from "@nestjs/common";

import { readJson, writeJson } from "./lib/store";

export type CliProxyProvider = "gemini" | "antigravity";
export type CliProxySyncDesired = "enabled" | "disabled" | "deleted";

export type CliProxySyncState = {
  desired: CliProxySyncDesired;
  remoteProvider: CliProxyProvider;
  remoteName: string;
  revision: number;
  tokenHash: string;
  lastSyncedAt: number;
  lastSeenAt: number;
  lastError: string;
};

type SyncContext = {
  dataDir: string;
  logger: Logger | Console;
};

type ExternalAccountFailureSink = {
  applyExternalAccountFailure: (payload: {
    accountId: number;
    modelKey?: string;
    status: number;
    reason?: string;
    retryAfterMs?: number;
  }) => { ok?: boolean; action?: string; error?: string };
};

export class CliProxySyncService {
  constructor(private readonly ctx: SyncContext) {}

  async getStatus() {
    const { baseUrl, managementKey } = this.requireConfig();
    try {
      const resp = await fetch(`${baseUrl}/v0/management/auth-files`, {
        headers: {
          Authorization: `Bearer ${managementKey}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data = await resp.json();
      return {
        connected: true,
        baseUrl,
        files: Array.isArray(data) ? data : data?.files || [],
      };
    } catch (err: any) {
      return {
        connected: false,
        baseUrl,
        error: err.message,
        files: [],
      };
    }
  }

  async handleReport(payload: any, leaseService: ExternalAccountFailureSink) {
    const accountId = Number(payload?.gfaAccountId || payload?.accountId || 0);
    const filePath = path.join(this.ctx.dataDir, "accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const account = accounts.find((item: any) => Number(item.id) === accountId);
    if (!account) return { ok: false, error: "账号不存在" };

    const sync = account.cliproxySync || {};
    const remoteName = String(payload?.remoteName || "");
    const provider = String(payload?.provider || "");
    const currentRevision = Number(sync.revision || 0);
    const reportRevision = Number(payload?.revision || 0);

    if (remoteName && sync.remoteName && remoteName !== sync.remoteName) {
      return { ok: true, ignored: true, reason: "remote_name_mismatch" };
    }
    if (provider && sync.remoteProvider && provider !== sync.remoteProvider) {
      return { ok: true, ignored: true, reason: "provider_mismatch" };
    }
    if (currentRevision > 0 && reportRevision > 0 && reportRevision < currentRevision) {
      return { ok: true, ignored: true, reason: "stale_revision" };
    }

    const result = leaseService.applyExternalAccountFailure({
      accountId,
      modelKey: String(payload?.modelKey || payload?.model || ""),
      status: Number(payload?.status || 0),
      reason: String(payload?.reason || ""),
      retryAfterMs: Number(payload?.retryAfterMs || 0),
    });

    account.cliproxySync = {
      ...sync,
      desired: result.action === "auth_dead" ? "disabled" : sync.desired || "enabled",
      lastSeenAt: Date.now(),
      lastError: result.ok ? String(payload?.reason || "") : String(result.error || "report failed"),
    };
    writeJson(filePath, { ...data, accounts, updatedAt: new Date().toISOString() });

    return result;
  }

  async reconcile(provider: CliProxyProvider = "antigravity") {
    const { baseUrl, managementKey } = this.requireConfig();
    const remote = await this.listRemoteFiles(baseUrl, managementKey);
    const data = readJson(path.join(this.ctx.dataDir, "accounts.json"), { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const expected = new Set(accounts.map((account: any) => this.remoteName(account, provider)));
    const uploaded: number[] = [];

    for (const account of accounts) {
      const accountId = Number(account.id);
      const name = this.remoteName(account, provider);
      if (
        account.enabled !== false &&
        account.poolEnabled !== false &&
        account.quotaStatus !== "error" &&
        account.refreshToken &&
        !remote.has(name)
      ) {
        const result = await this.syncAccount(accountId, provider);
        if (result.ok) uploaded.push(accountId);
      }
    }

    const unmanaged = Array.from(remote).filter((name) => !expected.has(name));
    return { ok: true, uploaded, unmanaged };
  }

  async syncMany(ids: number[], provider: CliProxyProvider = "antigravity") {
    if (!ids.length) throw new BadRequestException("ids is required");
    const addedAccounts: Array<{ id: number; email: string; projectId: string }> = [];
    const errors: Array<{ id: number; email: string; error: string }> = [];

    for (const rawId of ids) {
      const accountId = Number(rawId);
      const result = await this.syncAccount(accountId, provider);
      if (result.ok) {
        addedAccounts.push({
          id: accountId,
          email: String(result.email || ""),
          projectId: String(result.projectId || ""),
        });
      } else {
        errors.push({
          id: accountId,
          email: String(result.email || ""),
          error: String(result.error || "同步失败"),
        });
      }
    }

    return {
      total: ids.length,
      added: addedAccounts.length,
      updated: 0,
      failed: errors.length,
      addedAccounts,
      updatedAccounts: [],
      errors,
    };
  }

  async syncAccount(accountId: number, provider: CliProxyProvider = "antigravity") {
    const { baseUrl, managementKey } = this.requireConfig();
    const filePath = path.join(this.ctx.dataDir, "accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const account = accounts.find((item: any) => Number(item.id) === Number(accountId));
    if (!account) return { ok: false, accountId, error: "账号不存在" };
    if (!account.refreshToken) {
      return {
        ok: false,
        accountId,
        email: String(account.email || ""),
        error: "账号没有 refreshToken",
      };
    }

    const remoteName = this.remoteName(account, provider);
    const revision = Number(account.cliproxySync?.revision || 0) + 1;
    const credential = this.credentialFor(account, provider, revision);
    const resp = await fetch(`${baseUrl}/v0/management/auth-files?name=${encodeURIComponent(remoteName)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${managementKey}`,
      },
      body: JSON.stringify(credential),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const lastError = `HTTP ${resp.status}: ${text.slice(0, 120)}`;
      account.cliproxySync = this.nextState(account, provider, remoteName, revision, "enabled", lastError);
      writeJson(filePath, { ...data, accounts, updatedAt: new Date().toISOString() });
      return {
        ok: false,
        accountId: Number(account.id),
        email: String(account.email || ""),
        projectId: String(account.projectId || ""),
        error: lastError,
        remoteName,
        revision,
      };
    }

    account.cliproxySync = this.nextState(account, provider, remoteName, revision, "enabled", "");
    writeJson(filePath, { ...data, accounts, updatedAt: new Date().toISOString() });
    return {
      ok: true,
      accountId: Number(account.id),
      email: String(account.email || ""),
      projectId: String(account.projectId || ""),
      remoteName,
      revision,
    };
  }

  private requireConfig() {
    const baseUrl = process.env.CLIPROXY_BASE_URL;
    const managementKey = process.env.CLIPROXY_MANAGEMENT_KEY;
    if (!baseUrl || !managementKey) {
      throw new BadRequestException("CLIProxyAPI 未配置");
    }
    return { baseUrl, managementKey };
  }

  private async listRemoteFiles(baseUrl: string, managementKey: string) {
    const resp = await fetch(`${baseUrl}/v0/management/auth-files`, {
      headers: { Authorization: `Bearer ${managementKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    const files = Array.isArray(data) ? data : data?.files || [];
    return new Set(
      files
        .map((file: any) => String(typeof file === "string" ? file : file?.name || file?.fileName || ""))
        .filter(Boolean),
    );
  }

  private remoteName(account: any, provider: CliProxyProvider) {
    return `${provider}-gfa-${Number(account.id)}-${String(account.email || "unknown")}.json`;
  }

  private tokenHash(account: any) {
    return crypto.createHash("sha256").update(String(account.refreshToken || "")).digest("hex").slice(0, 16);
  }

  private credentialFor(account: any, provider: CliProxyProvider, revision: number) {
    const syncIdentity = {
      gfa_account_id: Number(account.id),
      gfa_revision: revision,
    };
    if (provider === "antigravity") {
      return {
        type: "antigravity",
        email: account.email,
        project_id: account.projectId || "",
        ...syncIdentity,
        refresh_token: account.refreshToken,
        access_token: account.accessToken || "",
      };
    }
    return {
      type: "gemini",
      email: account.email,
      project_id: account.projectId || "",
      ...syncIdentity,
      token: {
        refresh_token: account.refreshToken,
      },
    };
  }

  private nextState(
    account: any,
    provider: CliProxyProvider,
    remoteName: string,
    revision: number,
    desired: CliProxySyncDesired,
    lastError: string,
  ): CliProxySyncState {
    const now = Date.now();
    return {
      desired,
      remoteProvider: provider,
      remoteName,
      revision,
      tokenHash: this.tokenHash(account),
      lastSyncedAt: lastError ? 0 : now,
      lastSeenAt: now,
      lastError,
    };
  }
}
