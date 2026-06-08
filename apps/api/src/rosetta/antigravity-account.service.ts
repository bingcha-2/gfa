// Antigravity account-pool domain: CRUD + enable/pool toggles + token probe +
// single-account quota refresh against the antigravity (accounts.json) pool.
// Extracted from RosettaService — behavior-preserving (method bodies verbatim,
// this.dataDir/this.logger/this.tokenCache/this.accountsFile rebound to the
// shared RosettaContext; card-binding helpers delegated to AccessKeyService).

import * as path from "path";

import { AccessKeyService } from "./access-key.service";
import type { RosettaContext } from "./lib/context";
import { setAccountEnabled } from "./lib/pool";
import { tryDiscoverProject } from "./lib/project";
import { nowIso, readJson, writeJson } from "./lib/store";
import { ACCOUNT_SHARE_CAPACITY } from "../token-server/token-billing";
import {
  getAccessToken,
  refreshAccessToken,
  fetchAccountHealth,
  fetchAvailableModels,
  extractTierFromModelsJson,
} from "./google-api";

export class AntigravityAccountService {
  constructor(private readonly ctx: RosettaContext, private readonly accessKey: AccessKeyService) {}

  listAccounts() {
    const data = this.ctx.accountsFile.read();
    const boundCounts = this.accessKey.boundCardCounts("antigravity");
    const shares = this.accessKey.boundSharesByAccount("antigravity");
    const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map((account: any) => ({
      id: Number(account.id || 0),
      email: String(account.email || ""),
      enabled: account.enabled !== false,
      poolEnabled: account.poolEnabled !== false,
      alias: String(account.alias || ""),
      projectId: String(account.projectId || ""),
      planType: String(account.planType || ""),
      hasToken: Boolean(account.refreshToken),
      boundCardCount: boundCounts.get(Number(account.id || 0)) || 0,
      usedShares: shares.get(Number(account.id || 0)) || 0,
      shareCapacity: ACCOUNT_SHARE_CAPACITY,
      familyRole: String(account.familyRole || ""),
      familyStatus: String(account.familyStatus || ""),
      motherId: String(account.motherId || ""),
      seatId: String(account.seatId || ""),
    }));
    return { ok: true, accounts, dataDir: this.ctx.dataDir };
  }

  addAccount(payload: any) {
    const email = String(payload?.email || "").trim();
    const refreshToken = String(payload?.refreshToken || "").trim();
    if (!email) return { ok: false, error: "email 不能为空" };
    if (!refreshToken) return { ok: false, error: "refreshToken 不能为空" };

    const filePath = path.join(this.ctx.dataDir, "accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const existing = accounts.find((account: any) => String(account.email || "").toLowerCase() === email.toLowerCase());
    let accountId: number;
    if (existing) {
      existing.refreshToken = refreshToken;
      existing.enabled = payload.enabled !== undefined ? payload.enabled !== false : true;
      existing.alias = String(payload.alias ?? existing.alias ?? "");
      if (payload.projectId !== undefined) existing.projectId = String(payload.projectId || "");
      if (payload.planType !== undefined) existing.planType = String(payload.planType || "");
      accountId = Number(existing.id);
    } else {
      const maxId = accounts.reduce((max: number, account: any) => Math.max(max, Number(account.id || 0)), 0);
      accountId = maxId + 1;
      accounts.push({
        id: accountId,
        email,
        refreshToken,
        enabled: payload.enabled !== undefined ? payload.enabled !== false : true,
        alias: String(payload.alias || ""),
        projectId: String(payload.projectId || ""),
        planType: String(payload.planType || ""),
      });
    }
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, id: accountId, email, isUpdate: Boolean(existing), totalAccounts: accounts.length };
  }

  /** add-account + 入库探活(后台入口用):同步写入后刷一次 token,失败则置停用 + warning。 */
  async addAccountChecked(payload: any) {
    const r = this.addAccount(payload);
    if (!r.ok || !r.id) return r;
    const probe = await this.probeAntigravityToken(
      String(payload?.refreshToken || "").trim(),
    );
    if (!probe.valid) {
      setAccountEnabled(this.ctx.dataDir, "accounts.json", r.id, false);
      return { ...r, enabled: false, tokenValid: false, warning: `token 验证失败,已加入但置为停用: ${probe.error}` };
    }

    // Auto-discover projectId if not provided — without it the account is
    // invisible in the pool (isAccountEligible requires projectId).
    if (!String(payload?.projectId || "").trim()) {
      try {
        const filePath = path.join(this.ctx.dataDir, "accounts.json");
        const data = readJson(filePath, { accounts: [] });
        const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
        const acc = accounts.find((a: any) => Number(a.id) === r.id);
        if (acc && !acc.projectId) {
          await tryDiscoverProject(this.ctx, acc);
          if (acc.projectId) {
            writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
          }
        }
      } catch (err: any) {
        this.ctx.logger.warn(`Auto-discover projectId failed for account #${r.id}: ${err.message}`);
      }
    }

    return { ...r, tokenValid: true };
  }

  toggleAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.ctx.dataDir, "accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const account = accounts.find((item: any) => Number(item.id) === accountId);
    if (!account) return { ok: false, error: "账号不存在" };
    account.enabled = !account.enabled;
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: account.email, enabled: account.enabled };
  }

  toggleAccountPool(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.ctx.dataDir, "accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const account = accounts.find((item: any) => Number(item.id) === accountId);
    if (!account) return { ok: false, error: "账号不存在" };
    account.poolEnabled = account.poolEnabled === false ? true : false;
    writeJson(filePath, { ...data, accounts, updatedAt: nowIso() });
    return { ok: true, email: account.email, poolEnabled: account.poolEnabled };
  }

  deleteAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const filePath = path.join(this.ctx.dataDir, "accounts.json");
    const data = readJson(filePath, { accounts: [] });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const filtered = accounts.filter((account: any) => Number(account.id) !== accountId);
    if (filtered.length === accounts.length) return { ok: false, error: "账号不存在" };
    writeJson(filePath, { ...data, accounts: filtered, updatedAt: nowIso() });
    this.accessKey.clearBindingsForAccount("antigravity", accountId);
    return { ok: true, totalAccounts: filtered.length };
  }

  private async probeAntigravityToken(
    refreshToken: string,
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      await refreshAccessToken(refreshToken);
      return { valid: true };
    } catch (err: any) {
      return { valid: false, error: String(err?.message || err) };
    }
  }

  /**
   * 后台「刷新」(antigravity 单账号)= 强制刷新 token + 拉额度(二者本是一件事:
   * 拉额度必须先有有效 token)。发现 project → 刷 token → credits/planType + per-model 额度。
   */
  async refreshAccountQuota(payload: any) {
    const accountId = Number(payload?.accountId);
    const accountsFile = path.join(this.ctx.dataDir, "accounts.json");
    const data = readJson(accountsFile, { accounts: [] });
    const accounts: any[] = Array.isArray(data.accounts) ? data.accounts : [];
    const acc = accounts.find((a: any) => Number(a.id) === accountId);
    if (!acc) return { ok: false, error: "账号不存在" };
    if (!acc.refreshToken) return { ok: false, error: "该账号没有 refreshToken" };
    try {
      if (!acc.projectId) await tryDiscoverProject(this.ctx, acc);
      if (!acc.projectId) return { ok: false, email: acc.email, error: "无法发现 projectId" };
      this.ctx.tokenCache.delete(accountId); // 清缓存 → 强制真正刷一次 token
      const token = await getAccessToken(accountId, acc.refreshToken, this.ctx.tokenCache);
      const health = await fetchAccountHealth(token, acc.projectId, acc.email);
      if (health.planType && health.planType !== acc.planType) acc.planType = health.planType;

      const modelsResult = await fetchAvailableModels(token, acc.projectId);
      if (modelsResult) {
        const detectedTier = extractTierFromModelsJson(modelsResult.rawJson);
        if (detectedTier && detectedTier !== acc.planType) acc.planType = detectedTier;
        acc.modelQuotaFractions = {};
        acc.modelQuotaResetTimes = {};
        acc.modelQuotaRefreshedAt = Date.now();
        for (const [modelKey, info] of Object.entries(modelsResult.models)) {
          if (info.remainingFraction != null) acc.modelQuotaFractions[modelKey] = info.remainingFraction;
          if (info.resetTime) acc.modelQuotaResetTimes[modelKey] = info.resetTime;
        }
      }
      writeJson(accountsFile, { ...data, accounts, updatedAt: nowIso() });
      return {
        ok: true,
        email: acc.email,
        tokenValid: true,
        planType: acc.planType || "",
        modelQuotaFractions: acc.modelQuotaFractions || {},
      };
    } catch (err: any) {
      return { ok: false, email: acc.email, tokenValid: false, error: String(err?.message || err) };
    }
  }
}
