import * as path from "path";

import { BadRequestException, Inject, Injectable, Logger, Optional } from "@nestjs/common";

import { AgentAccountService } from "../../google-family/automation/agent-account.service";
import { AutomationService } from "../../google-family/automation/automation.service";
import { proxyAwareFetch } from "../lease-core/egress";
import type { CachedToken } from "./google-api";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { occupiedSharesByAccount } from "../subscription/seat";

import { AccessKeyService } from "./access-key.service";
import { AdspowerService } from "./adspower.service";
import { AntigravityAccountService } from "./antigravity-account.service";
import { CaptchaService } from "./captcha.service";
import { ClaudeAccountService } from "./claude-account.service";
import { ClaudeSessionPoolService } from "./claude-session-pool.service";
import { CodexService } from "./codex.service";
import { CreditsQuotaService } from "./credits-quota.service";
import { GoogleOAuthService } from "./google-oauth.service";
import type { RosettaContext } from "./lib/context";
import type { AccessKeyStore } from "../token-server/access-key-store";
import { migrateClaudeProductToAnthropic } from "./lib/migrate";
import { CachedJsonFile, defaultDataDir, readJson, setAccountProxyInPool, writeJson } from "./lib/store";

// migrate re-exported so existing importers (tests, bootstrap) keep importing it
// from this module unchanged.
export { migrateClaudeProductToAnthropic } from "./lib/migrate";

type RosettaServiceOptions = {
  dataDir?: string;
  codexOAuthPort?: number;
  codexOAuthFetch?: typeof fetch;
  /** Shared AccessKeyStore — the authoritative in-memory source of per-card
   *  window usage. When set, the admin list reads usage from it instead of the
   *  (event-free) JSON file. */
  accessKeyStore?: AccessKeyStore;
};

const CODEX_OAUTH_DEFAULT_CALLBACK_PORT = 1455;

/**
 * RosettaService is a thin FACADE. The actual logic lives in per-domain services
 * (access-key, antigravity/codex/claude accounts, google-oauth, captcha,
 * credits-quota, adspower) under ./*.service.ts, sharing a RosettaContext. The
 * facade owns the shared state (dataDir, file caches, token cache, OAuth fetch
 * impls), wires the services, and delegates every public method. Controller and
 * tests call the facade exactly as before — behavior is unchanged.
 */
@Injectable()
export class RosettaService {
  private readonly dataDir: string;
  private readonly codexOAuthPort: number;
  private readonly codexOAuthFetch: typeof fetch;
  private readonly logger = new Logger(RosettaService.name);
  /** In-memory access_token cache: accountId → { accessToken, expiresAt }. */
  private readonly tokenCache = new Map<number, CachedToken>();
  /** mtime-cached file readers for hot-path list queries. */
  private readonly accessKeysFile: CachedJsonFile;
  private readonly accountsFile: CachedJsonFile;

  private readonly ctx: RosettaContext;
  private readonly accessKeySvc: AccessKeyService;
  private readonly captchaSvc: CaptchaService;
  private readonly antigravitySvc: AntigravityAccountService;
  private readonly codexSvc: CodexService;
  private readonly claudeSvc: ClaudeAccountService;
  private readonly googleSvc: GoogleOAuthService;
  private readonly creditsSvc: CreditsQuotaService;
  private readonly sessionPoolSvc: ClaudeSessionPoolService;
  private readonly adspowerSvc: AdspowerService;

  constructor(
    @Optional() options: RosettaServiceOptions = {},
    @Optional() private readonly automation?: AutomationService,
    @Optional() private readonly agentAccounts?: AgentAccountService,
    @Optional() @Inject("SHARED_ACCESS_KEY_STORE") injectedAccessKeyStore?: AccessKeyStore,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    // Prefer an explicitly-passed store (tests); else the DI-shared one (prod).
    options = { ...options, accessKeyStore: options.accessKeyStore || injectedAccessKeyStore };
    this.dataDir = options.dataDir || defaultDataDir();
    // 启动时一次性把产品 claude→anthropic 迁移到位(改文件名 + 卡绑定 key),必须在任何
    // 账号池/卡密读取之前;幂等,无旧数据时为 no-op。
    migrateClaudeProductToAnthropic(this.dataDir);
    this.codexOAuthPort = Number(options.codexOAuthPort ?? CODEX_OAUTH_DEFAULT_CALLBACK_PORT);
    this.codexOAuthFetch = options.codexOAuthFetch || fetch;
    this.accessKeysFile = new CachedJsonFile(path.join(this.dataDir, "access-keys.json"), { keys: [] });
    this.accountsFile = new CachedJsonFile(path.join(this.dataDir, "accounts.json"), { accounts: [] });

    this.ctx = {
      dataDir: this.dataDir,
      logger: this.logger,
      tokenCache: this.tokenCache,
      accessKeysFile: this.accessKeysFile,
      accountsFile: this.accountsFile,
      codexOAuthFetch: this.codexOAuthFetch,
      codexOAuthPort: this.codexOAuthPort,
      automation: this.automation,
      agentAccounts: this.agentAccounts,
      accessKeyStore: options.accessKeyStore,
    };
    this.accessKeySvc = new AccessKeyService(this.ctx);
    this.captchaSvc = new CaptchaService({ dataDir: this.dataDir, automation: this.automation, logger: this.logger });
    this.antigravitySvc = new AntigravityAccountService(this.ctx, this.accessKeySvc);
    this.codexSvc = new CodexService(this.ctx, this.accessKeySvc);
    this.claudeSvc = new ClaudeAccountService(this.ctx, this.accessKeySvc);
    this.googleSvc = new GoogleOAuthService(this.ctx, (p: any) => this.antigravitySvc.addAccountChecked(p));
    this.sessionPoolSvc = new ClaudeSessionPoolService(this.ctx);
    this.creditsSvc = new CreditsQuotaService(this.ctx);
    this.adspowerSvc = new AdspowerService(this.ctx);
  }

  // ── Employees (not a separate domain; small, stays here) ────────────────
  listEmployees() {
    const data = readJson(path.join(this.dataDir, "employees.json"), {
      employees: [],
      accounts: [],
      sessions: [],
    });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const employees = (Array.isArray(data.employees) ? data.employees : []).map((employee: any) => {
      const mine = accounts.filter((account: any) => account.employeeId === employee.id);
      return {
        id: String(employee.id || ""),
        email: String(employee.email || ""),
        status: String(employee.status || "active"),
        createdAt: String(employee.createdAt || ""),
        lastActiveAt: String(employee.lastActiveAt || ""),
        stats: {
          total: mine.length,
          accepted: mine.filter((account: any) => account.status === "accepted").length,
          failed: mine.filter((account: any) => account.status === "failed").length,
          disabled: mine.filter((account: any) => account.status === "disabled").length,
          deleted: mine.filter((account: any) => account.status === "deleted").length,
        },
      };
    });

    return { ok: true, employees, accounts };
  }

  // ── 订阅座位口径(控制台账号列表用)──────────────────────────────────────
  /**
   * 某 product 下每个上游号(accountId)被 ACTIVE 订阅占用的份额(Σweight)。
   * 座位真相源 = DB 订阅 config.bindings(access-keys.json 文件口径已退役),与
   * 下单选号(entitlement-sync.seatOccupancyFromDb)同口径。控制台账号列表用它
   * 覆盖 usedShares —— 否则订阅占了座位、后台仍按文件卡数显示 0/N。无 prisma
   * (单元测试 new RosettaService 未注入)时返回空 Map。
   */
  async occupiedSharesFromSubscriptions(product: string): Promise<Map<number, number>> {
    if (!this.prisma) return new Map<number, number>();
    const parse = (json: string | null): Record<string, any> => {
      try {
        const p = JSON.parse(String(json || "{}"));
        return p && typeof p === "object" && !Array.isArray(p) ? p : {};
      } catch {
        return {};
      }
    };
    const rows = await this.prisma.subscription.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, config: true },
    });
    const configs = rows.map((r: { id: string; config: string | null }) => ({ id: r.id, ...parse(r.config) }));
    return occupiedSharesByAccount(configs, product);
  }

  // ── Antigravity accounts (→ AntigravityAccountService) ──────────────────
  listAccounts() { return this.antigravitySvc.listAccounts(); }
  addAccount(payload: any) { return this.antigravitySvc.addAccount(payload); }
  addAccountChecked(payload: any) { return this.antigravitySvc.addAccountChecked(payload); }
  toggleAccount(payload: any) { return this.antigravitySvc.toggleAccount(payload); }
  toggleAccountPool(payload: any) { return this.antigravitySvc.toggleAccountPool(payload); }
  deleteAccount(payload: any) { return this.antigravitySvc.deleteAccount(payload); }
  refreshAccountQuota(payload: any) { return this.antigravitySvc.refreshAccountQuota(payload); }

  // ── Codex accounts + OAuth (→ CodexService) ─────────────────────────────
  listCodexAccounts() { return this.codexSvc.listCodexAccounts(); }
  addCodexAccount(payload: any) { return this.codexSvc.addCodexAccount(payload); }
  addCodexAccountChecked(payload: any) { return this.codexSvc.addCodexAccountChecked(payload); }
  importCodexAccountFromText(payload: any) { return this.codexSvc.importCodexAccountFromText(payload); }
  exportCodexAccounts() { return this.codexSvc.exportCodexAccounts(); }
  importCodexAccountsFromText(payload: any) { return this.codexSvc.importCodexAccountsFromText(payload); }
  importCodexAccountCheckedFromText(payload: any) { return this.codexSvc.importCodexAccountCheckedFromText(payload); }
  importCodexAccountsCheckedFromText(payload: any) { return this.codexSvc.importCodexAccountsCheckedFromText(payload); }
  refreshCodexAccountQuota(payload: any) { return this.codexSvc.refreshCodexAccountQuota(payload); }
  startCodexOAuthLogin() { return this.codexSvc.startCodexOAuthLogin(); }
  getCodexOAuthLoginStatus(loginId: string) { return this.codexSvc.getCodexOAuthLoginStatus(loginId); }
  cancelCodexOAuthLogin(loginId: string) { return this.codexSvc.cancelCodexOAuthLogin(loginId); }
  submitCodexOAuthCallback(loginId: string, rawInput: string) { return this.codexSvc.submitCodexOAuthCallback(loginId, rawInput); }
  startAutomatedCodexLogin(payload: any) { return this.codexSvc.startAutomatedCodexLogin(payload); }
  getAutomatedCodexLoginStatus(jobId: string) { return this.codexSvc.getAutomatedCodexLoginStatus(jobId); }
  toggleCodexAccount(payload: any) { return this.codexSvc.toggleCodexAccount(payload); }
  toggleCodexAccountPool(payload: any) { return this.codexSvc.toggleCodexAccountPool(payload); }
  deleteCodexAccount(payload: any) { return this.codexSvc.deleteCodexAccount(payload); }

  // ── Google OAuth (→ GoogleOAuthService) ─────────────────────────────────
  startGoogleOAuthLogin() { return this.googleSvc.startGoogleOAuthLogin(); }
  getGoogleOAuthLoginStatus(loginId: string) { return this.googleSvc.getGoogleOAuthLoginStatus(loginId); }
  cancelGoogleOAuthLogin(loginId: string) { return this.googleSvc.cancelGoogleOAuthLogin(loginId); }
  submitGoogleOAuthCallback(loginId: string, rawInput: string) { return this.googleSvc.submitGoogleOAuthCallback(loginId, rawInput); }

  // ── Claude/Anthropic accounts + OAuth (→ ClaudeAccountService) ──────────
  listClaudeAccounts() { return this.claudeSvc.listClaudeAccounts(); }
  addClaudeAccount(payload: any) { return this.claudeSvc.addClaudeAccount(payload); }
  startClaudeOAuthLogin(proxyUrl?: string) { return this.claudeSvc.startClaudeOAuthLogin(proxyUrl); }
  getClaudeOAuthLoginStatus(loginId: string) { return this.claudeSvc.getClaudeOAuthLoginStatus(loginId); }
  cancelClaudeOAuthLogin(loginId: string) { return this.claudeSvc.cancelClaudeOAuthLogin(loginId); }
  submitClaudeOAuthCallback(loginId: string, rawInput: string) { return this.claudeSvc.submitClaudeOAuthCallback(loginId, rawInput); }
  fetchClaudeMagicLink(payload: any) { return this.claudeSvc.fetchClaudeMagicLink(payload); }
  followClaudeMagicLink(loginId: string, url: string) { return this.claudeSvc.followMagicLink(loginId, url); }
  startAutoClaudeOAuth(payload: any) { return this.claudeSvc.startAutoClaudeOAuth(payload); }
  getAutoClaudeOAuthStatus(taskId: string) { return this.claudeSvc.getAutoOAuthStatus(taskId); }
  toggleClaudeAccount(payload: any) { return this.claudeSvc.toggleClaudeAccount(payload); }
  toggleClaudeAccountPool(payload: any) { return this.claudeSvc.toggleClaudeAccountPool(payload); }
  setClaudeAccountProxy(payload: any) { return this.claudeSvc.setClaudeAccountProxy(payload); }
  setClaudeAccountMailPassword(payload: any) { return this.claudeSvc.setClaudeAccountMailPassword(payload); }
  setClaudeAccountAdspowerProfile(payload: any) { return this.claudeSvc.setClaudeAccountAdspowerProfile(payload); }
  deleteClaudeAccount(payload: any) { return this.claudeSvc.deleteClaudeAccount(payload); }

  // ── Claude Session Pool / 白号登录号池 (→ ClaudeSessionPoolService) ────
  listClaudeSessionAccounts() { return this.sessionPoolSvc.listAccounts(); }
  addClaudeSessionAccount(payload: any) { return this.sessionPoolSvc.addAccount(payload); }
  batchImportClaudeSessionAccounts(payload: any) { return this.sessionPoolSvc.batchImport(payload); }
  deleteClaudeSessionAccount(payload: any) { return this.sessionPoolSvc.deleteAccount(payload); }
  toggleClaudeSessionAccount(payload: any) { return this.sessionPoolSvc.toggleAccount(payload); }
  setClaudeSessionProxy(payload: any) { return this.sessionPoolSvc.setProxy(payload); }
  updateClaudeSessionKey(payload: any) { return this.sessionPoolSvc.updateSessionKey(payload); }
  // 客户端接管时租白号 / 注入后回报能用与否(状态由回报驱动,服务端不验证)。
  leaseClaudeSession(payload: any) { return this.sessionPoolSvc.leaseSession(payload); }
  reportClaudeSession(payload: any) { return this.sessionPoolSvc.reportSession(payload); }

  // ── 通用出口代理(御三家共用) ───────────────────────────────────────────
  // 给任意 provider 的某个号设/清粘性出口代理。客户端租到该号时随 lease 下发
  // accountProxyUrl + egressRequired,据此固定出口 IP(anthropic 强制、codex/antigravity 可选)。
  setAccountProxy(payload: any) {
    const provider = String(payload?.provider || "").trim().toLowerCase();
    const poolFile: Record<string, string> = {
      anthropic: "anthropic-accounts.json",
      codex: "codex-accounts.json",
      antigravity: "accounts.json",
    };
    const fileName = poolFile[provider];
    if (!fileName) return { ok: false, error: `未知 provider:${provider || "(空)"}(支持 anthropic/codex/antigravity)` };
    return setAccountProxyInPool(path.join(this.dataDir, fileName), Number(payload?.accountId), payload?.proxyUrl);
  }
  refreshClaudeAccountQuota(payload: any) { return this.claudeSvc.refreshClaudeAccountQuota(payload); }

  // ── Access keys / 卡密 (→ AccessKeyService) ──────────────────────────────
  listAccessKeys(query: { search?: string }) { return this.accessKeySvc.listAccessKeys(query); }
  createAccessKey(payload: any) { return this.accessKeySvc.createAccessKey(payload); }
  updateAccessKey(payload: any) { return this.accessKeySvc.updateAccessKey(payload); }
  getAccessKeyLimits(cardId: string) { return this.accessKeySvc.getAccessKeyLimits(cardId); }
  deleteAccessKey(payload: any) { return this.accessKeySvc.deleteAccessKey(payload); }
  bindAccessKey(payload: any) { return this.accessKeySvc.bindAccessKey(payload); }
  unbindAccessKey(payload: any) { return this.accessKeySvc.unbindAccessKey(payload); }
  setAccessKeyBindings(payload: any) { return this.accessKeySvc.setAccessKeyBindings(payload); }
  async cleanupExpiredKeys() {
    const subscriptionIds = await this.loadSubscriptionIds();
    return this.accessKeySvc.cleanupExpiredKeys(subscriptionIds);
  }
  async cleanupUnboundKeys() {
    const subscriptionIds = await this.loadSubscriptionIds();
    return this.accessKeySvc.cleanupUnboundKeys(subscriptionIds);
  }
  /** Load the set of active Subscription ids from Prisma (if available).
   *  Used by cleanup methods to guard subscription shadow records. */
  private async loadSubscriptionIds(): Promise<ReadonlySet<string>> {
    if (!this.prisma) return new Set();
    try {
      const rows = await this.prisma.subscription.findMany({ select: { id: true } });
      return new Set(rows.map((r) => r.id));
    } catch {
      // If the DB is unavailable (e.g. test environment without Prisma), be
      // conservative and return an empty set — cleanup still runs but the
      // migratedToCustomerId guard remains active.
      return new Set();
    }
  }
  // Account-system writers (subscription shadow records / bind-card migration).
  // Delegate to the SAME AccessKeyService so access-keys.json keeps one writer.
  upsertKeyRecord(fields: { id: string } & Record<string, unknown>, options?: { createIfMissing?: boolean }) {
    return this.accessKeySvc.upsertKeyRecord(fields, options);
  }
  assignSeatForProduct(product: string, weight: number, level: string) {
    return this.accessKeySvc.assignSeatForProduct(product, weight, level);
  }
  /** 去影子座位分配:占用份额/人数按 DB ACTIVE 订阅 config 算好传入,不读文件(见 access-key.service)。 */
  assignSeatForProductFromShares(
    product: string,
    weight: number,
    level: string,
    occupiedShares: Map<number, number>,
    boundCounts?: Map<number, number>,
  ) {
    return this.accessKeySvc.assignSeatForProductFromShares(product, weight, level, occupiedShares, boundCounts);
  }
  /** 下单前座位预检:该 product+level 有无剩 ≥ weight 份的号(占用份额按 DB 订阅 config 传入)。 */
  hasAvailableSeatFromShares(product: string, weight: number, level: string, occupiedShares: Map<number, number>) {
    return this.accessKeySvc.hasAvailableSeatFromShares(product, weight, level, occupiedShares);
  }

  // ── Captcha / location unblock (→ CaptchaService) ───────────────────────
  createCaptchaUnblock(payload: any) { return this.captchaSvc.createCaptchaUnblock(payload); }
  getCaptchaUnblockStatus() { return this.captchaSvc.getCaptchaUnblockStatus(); }
  retryCaptchaUnblock(payload: any) { return this.captchaSvc.retryCaptchaUnblock(payload); }
  unblockLocation() { return this.captchaSvc.unblockLocation(); }

  // ── Credits / quota refresh (→ CreditsQuotaService) ─────────────────────
  refreshCredits() { return this.creditsSvc.refreshCredits(); }
  refreshQuota() { return this.creditsSvc.refreshQuota(); }

  // ── AdsPower import (→ AdspowerService) ─────────────────────────────────
  adspowerImport(payload: any) { return this.adspowerSvc.adspowerImport(payload); }
  adspowerImportStatus(batchId: string) { return this.adspowerSvc.adspowerImportStatus(batchId); }
  adspowerImportHistory() { return this.adspowerSvc.adspowerImportHistory(); }

  // ── CLIProxy management ──

  async getCliProxyStatus() {
    const baseUrl = process.env.CLIPROXY_BASE_URL;
    const managementKey = process.env.CLIPROXY_MANAGEMENT_KEY;
    if (!baseUrl || !managementKey) {
      throw new BadRequestException(
        "CLIProxyAPI 未配置。请在 .env 中设置 CLIPROXY_BASE_URL 和 CLIPROXY_MANAGEMENT_KEY",
      );
    }

    try {
      const resp = await fetch(`${baseUrl}/v0/management/auth-files`, {
        headers: {
          "Authorization": `Bearer ${managementKey}`,
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${errorText.substring(0, 200)}`);
      }

      const data = await resp.json();
      return {
        connected: true,
        baseUrl,
        files: Array.isArray(data) ? data : (data?.files || []),
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

  async uploadToCliProxy(
    ids: number[],
    customClientId?: string,
    customClientSecret?: string,
    provider: "gemini" | "antigravity" = "gemini",
  ) {
    if (!ids.length) throw new BadRequestException("ids is required");

    const baseUrl = process.env.CLIPROXY_BASE_URL;
    const managementKey = process.env.CLIPROXY_MANAGEMENT_KEY;
    if (!baseUrl || !managementKey) {
      throw new BadRequestException(
        "CLIProxyAPI 未配置。请在 .env 中设置 CLIPROXY_BASE_URL 和 CLIPROXY_MANAGEMENT_KEY",
      );
    }

    const numericIds = ids.map(id => Number(id));
    const data = this.accountsFile.read();
    const allAccounts = Array.isArray(data.accounts) ? data.accounts : [];
    const accounts = allAccounts.filter((acc: any) => numericIds.includes(Number(acc.id)));

    const OAUTH_CLIENT_ID =
      customClientId || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
    const OAUTH_CLIENT_SECRET = customClientSecret || "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";

    const added: Array<{ id: number; email: string; projectId: string }> = [];
    const updated: Array<{ id: number; email: string; projectId: string }> = [];
    const errors: Array<{ id: number; email: string; error: string }> = [];

    let hasUpdates = false;

    for (const acc of accounts) {
      if (!acc.refreshToken) {
        errors.push({ id: Number(acc.id), email: acc.email, error: "没有 Token" });
        continue;
      }

      // 1. Discover projectId
      let projectId = "";
      let accessToken = "";
      try {
        const discovery = await this.discoverProjectId(acc.refreshToken, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, acc.proxyUrl);
        projectId = discovery.projectId;
        accessToken = discovery.accessToken;

        if (projectId) {
          this.logger.log(`[uploadToCliProxy] ${acc.email} projectId=${projectId}`);
          if (acc.projectId !== projectId) {
            acc.projectId = projectId;
            hasUpdates = true;
          }
        } else {
          this.logger.warn(`[uploadToCliProxy] ${acc.email} 未拿到 projectId`);
          errors.push({ id: Number(acc.id), email: acc.email, error: "无法获取 projectId" });
          continue;
        }
      } catch (err: any) {
        this.logger.warn(
          `[uploadToCliProxy] ${acc.email} projectId discovery failed: ${err.message}`,
        );
        errors.push({ id: Number(acc.id), email: acc.email, error: `projectId 获取失败: ${err.message}` });
        continue;
      }

      // 2. Build CLIProxyAPI credential JSON (matching existing format on server)
      let credentialJson: any;
      let fileName = "";

      if (provider === "antigravity") {
        credentialJson = {
          type: "antigravity",
          email: acc.email,
          project_id: projectId,
          access_token: accessToken,
          refresh_token: acc.refreshToken,
        };
        fileName = `antigravity-${acc.email}.json`;
      } else {
        credentialJson = {
          auto: false,
          checked: true,
          disabled: false,
          email: acc.email,
          project_id: projectId,
          token: {
            client_id: OAUTH_CLIENT_ID,
            client_secret: OAUTH_CLIENT_SECRET,
            refresh_token: acc.refreshToken,
            token_uri: "https://oauth2.googleapis.com/token",
            token_type: "Bearer",
            scopes: [
              "https://www.googleapis.com/auth/cloud-platform",
              "https://www.googleapis.com/auth/userinfo.email",
              "https://www.googleapis.com/auth/userinfo.profile",
            ],
            universe_domain: "googleapis.com",
          },
          type: "gemini",
        };
        fileName = `gemini-${acc.email}-${projectId}.json`;
      }

      // 3. Upload via management API
      try {
        const resp = await fetch(
          `${baseUrl}/v0/management/auth-files?name=${encodeURIComponent(fileName)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${managementKey}`,
            },
            body: JSON.stringify(credentialJson),
            signal: AbortSignal.timeout(15000),
          },
        );

        if (resp.ok) {
          this.logger.log(`[uploadToCliProxy] ${acc.email} uploaded as ${fileName}`);
          added.push({ id: Number(acc.id), email: acc.email, projectId });
        } else {
          const errorText = await resp.text().catch(() => "");
          this.logger.warn(
            `[uploadToCliProxy] ${acc.email} upload failed: ${resp.status} ${errorText}`,
          );
          // If 409 or similar, treat as update
          if (resp.status === 409) {
            updated.push({ id: Number(acc.id), email: acc.email, projectId });
          } else {
            errors.push({
              id: Number(acc.id),
              email: acc.email,
              error: `上传失败 (HTTP ${resp.status}): ${errorText.substring(0, 100)}`,
            });
          }
        }
      } catch (err: any) {
        this.logger.error(`[uploadToCliProxy] ${acc.email} upload error: ${err.message}`);
        errors.push({ id: Number(acc.id), email: acc.email, error: `网络错误: ${err.message}` });
      }
    }

    if (hasUpdates) {
      writeJson(path.join(this.dataDir, "accounts.json"), data);
      this.accountsFile.invalidate();
    }

    // Check for IDs not found in DB/JSON
    const foundIds = new Set(accounts.map((a: any) => Number(a.id)));
    for (const id of ids) {
      if (!foundIds.has(Number(id))) {
        errors.push({ id: Number(id), email: "", error: "未找到该账号" });
      }
    }

    this.logger.log(
      `uploadToCliProxy: added=${added.length}, updated=${updated.length}, errors=${errors.length}`,
    );

    return {
      total: ids.length,
      added: added.length,
      updated: updated.length,
      failed: errors.length,
      addedAccounts: added,
      updatedAccounts: updated,
      errors,
    };
  }

  private async discoverProjectId(
    refreshToken: string,
    clientId = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret = "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",
    proxyUrl?: string,
  ): Promise<{ projectId: string; accessToken: string }> {
    // 1. Exchange refreshToken for access_token (through the account's exit proxy
    // when set — these carry the account token and must not leak the datacenter IP).
    const tokenResp = await proxyAwareFetch(proxyUrl, "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const tokenData = await tokenResp.json() as Record<string, unknown>;
    const accessToken = String(tokenData.access_token || "");
    if (!accessToken) {
      throw new Error(String(tokenData.error_description || tokenData.error || "No access_token"));
    }

    // 2. Call loadCodeAssist to discover projectId
    const METADATA = {
      ideName: "antigravity",
      ideType: "ANTIGRAVITY",
      ideVersion: "1.21.6",
      pluginVersion: "1.21.6",
      platform: "WINDOWS_AMD64",
      updateChannel: "stable",
      pluginType: "GEMINI",
    };
    const hosts = [
      "daily-cloudcode-pa.sandbox.googleapis.com",
      "daily-cloudcode-pa.googleapis.com",
      "cloudcode-pa.googleapis.com",
    ];
    for (const host of hosts) {
      try {
        const r = await proxyAwareFetch(proxyUrl, `https://${host}/v1internal:loadCodeAssist`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ metadata: METADATA }),
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) {
          const d = await r.json() as Record<string, unknown>;
          const p = d.cloudaicompanionProject as any;
          if (typeof p === "string" && p) return { projectId: p, accessToken };
          if (p?.id) return { projectId: String(p.id), accessToken };

          // No project yet — try onboardUser to provision
          const allowedTiers = (d.allowedTiers as any[]) ?? [];
          const currentTier = d.currentTier as any;
          const tierId =
            allowedTiers.find((t: any) => t.isDefault)?.id ||
            allowedTiers.find((t: any) => t.id)?.id ||
            (d.paidTier as any)?.id || currentTier?.id;

          if (tierId) {
            try {
              let onboardResult = await proxyAwareFetch(proxyUrl, `https://${host}/v1internal:onboardUser`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ tierId, metadata: METADATA }),
                signal: AbortSignal.timeout(15000),
              }).then(res => res.json() as Promise<Record<string, any>>);

              // Poll until done
              let polls = 0;
              while (!onboardResult?.done && polls < 10) {
                const opName = String(onboardResult?.name || "").trim();
                if (!opName) break;
                await new Promise(resolve => setTimeout(resolve, 500));
                onboardResult = await proxyAwareFetch(proxyUrl, `https://${host}/v1internal/${opName}`, {
                  headers: { Authorization: `Bearer ${accessToken}` },
                  signal: AbortSignal.timeout(10000),
                }).then(res => res.json() as Promise<Record<string, any>>);
                polls++;
              }

              const onboardProject = onboardResult?.response?.cloudaicompanionProject;
              if (typeof onboardProject === "string" && onboardProject) return { projectId: onboardProject, accessToken };
              if (onboardProject?.id) return { projectId: String(onboardProject.id), accessToken };
            } catch { /* try next host */ }
          }
        }
      } catch { /* try next host */ }
    }
    return { projectId: "", accessToken };
  }

  async syncFromPayload(payload: { accounts?: any[]; codex?: any[]; keys?: any[] }) {
    this.logger.log(`[syncFromPayload] Started Rosetta sync request.`);

    const mergeStats = {
      antigravity: { added: 0, updated: 0, collisions: 0 },
      codex: { added: 0, updated: 0, collisions: 0 },
      keys: { added: 0, updated: 0 },
    };

    // ID mapping maps for card binding updates
    // provider -> localId -> email
    const localIdToEmail = {
      antigravity: new Map<number, string>(),
      codex: new Map<number, string>(),
    };
    // provider -> email -> remoteId
    const remoteEmailToId = {
      antigravity: new Map<string, number>(),
      codex: new Map<string, number>(),
    };

    // 1. Map local IDs to emails (received in payload)
    if (Array.isArray(payload.accounts)) {
      for (const acc of payload.accounts) {
        if (acc.id && acc.email) {
          localIdToEmail.antigravity.set(Number(acc.id), String(acc.email).toLowerCase());
        }
      }
    }
    if (Array.isArray(payload.codex)) {
      for (const acc of payload.codex) {
        if (acc.id && acc.email) {
          localIdToEmail.codex.set(Number(acc.id), String(acc.email).toLowerCase());
        }
      }
    }

    // Helper to merge a pool file
    const mergePool = (
      fileName: string,
      localList: any[],
      provider: "antigravity" | "codex"
    ) => {
      const filePath = path.join(this.dataDir, fileName);
      const data = readJson(filePath, { accounts: [] });
      const rAccounts = Array.isArray(data.accounts) ? data.accounts : [];

      const rEmailMap = new Map<string, any>();
      const rIdSet = new Set<number>();
      for (const acc of rAccounts) {
        rEmailMap.set(String(acc.email).toLowerCase(), acc);
        rIdSet.add(Number(acc.id));
      }

      for (const lAcc of localList) {
        const emailLower = String(lAcc.email).toLowerCase();
        const existingRemoteAcc = rEmailMap.get(emailLower);

        if (existingRemoteAcc) {
          // Merge credentials
          Object.assign(existingRemoteAcc, {
            ...lAcc,
            id: existingRemoteAcc.id, // Keep remote ID
            updatedAt: new Date().toISOString(),
          });
          mergeStats[provider].updated++;
        } else {
          let targetId = Number(lAcc.id);
          if (rIdSet.has(targetId)) {
            // Collision! Allocate new ID
            mergeStats[provider].collisions++;
            targetId = rAccounts.length > 0 ? Math.max(...rIdSet) + 1 : 1;
          }
          const newAcc = {
            ...lAcc,
            id: targetId,
            updatedAt: new Date().toISOString(),
          };
          rAccounts.push(newAcc);
          rIdSet.add(targetId);
          rEmailMap.set(emailLower, newAcc);
          mergeStats[provider].added++;
        }
      }

      // Populate remote maps for card bindings
      for (const acc of rAccounts) {
        if (acc.id && acc.email) {
          remoteEmailToId[provider].set(String(acc.email).toLowerCase(), Number(acc.id));
        }
      }

      writeJson(filePath, { ...data, accounts: rAccounts, updatedAt: new Date().toISOString() });
    };

    // 2. Perform Account Merges
    mergePool("accounts.json", payload.accounts || [], "antigravity");
    this.accountsFile.invalidate(); // Clear NestJS cache

    mergePool("codex-accounts.json", payload.codex || [], "codex");

    // 3. Merge Card Keys
    const keysFilePath = path.join(this.dataDir, "access-keys.json");
    const keysData = readJson(keysFilePath, { keys: [] });
    const rKeys = Array.isArray(keysData.keys) ? keysData.keys : [];

    const rKeyMap = new Map<string, any>();
    for (const key of rKeys) {
      rKeyMap.set(String(key.id), key);
      rKeyMap.set(String(key.key), key);
    }

    const localKeys = payload.keys || [];
    for (const lKey of localKeys) {
      const existingKey = rKeyMap.get(String(lKey.id)) || rKeyMap.get(String(lKey.key));
      if (existingKey) {
        // Card already exists, skip
        continue;
      }

      const newKey = JSON.parse(JSON.stringify(lKey));

      // Translate bindings if present
      if (newKey.bindings && typeof newKey.bindings === "object") {
        for (const provider of Object.keys(newKey.bindings)) {
          if (provider === "antigravity" || provider === "codex") {
            const localId = Number(newKey.bindings[provider]);
            if (localId > 0) {
              const email = localIdToEmail[provider].get(localId);
              if (email) {
                const remoteId = remoteEmailToId[provider].get(email);
                if (remoteId && remoteId > 0) {
                  newKey.bindings[provider] = remoteId;
                } else {
                  newKey.bindings[provider] = 0;
                }
              } else {
                newKey.bindings[provider] = 0;
              }
            }
          }
        }
      }

      rKeys.push(newKey);
      rKeyMap.set(String(newKey.id), newKey);
      rKeyMap.set(String(newKey.key), newKey);
      mergeStats.keys.added++;
    }

    writeJson(keysFilePath, { ...keysData, keys: rKeys, updatedAt: new Date().toISOString() });
    this.accessKeysFile.invalidate(); // Clear NestJS cache

    this.logger.log(
      `[syncFromPayload] Complete. Antigravity: +${mergeStats.antigravity.added}/~${mergeStats.antigravity.updated} (c:${mergeStats.antigravity.collisions}). Codex: +${mergeStats.codex.added}/~${mergeStats.codex.updated} (c:${mergeStats.codex.collisions}). Keys: +${mergeStats.keys.added}`
    );

    return {
      success: true,
      stats: mergeStats,
    };
  }
}
