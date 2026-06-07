import * as path from "path";

import { Injectable, Logger, Optional } from "@nestjs/common";

import { AgentAccountService } from "../automation/agent-account.service";
import { AutomationService } from "../automation/automation.service";
import type { CachedToken } from "./google-api";

import { AccessKeyService } from "./access-key.service";
import { AdspowerService } from "./adspower.service";
import { AntigravityAccountService } from "./antigravity-account.service";
import { CaptchaService } from "./captcha.service";
import { ClaudeAccountService } from "./claude-account.service";
import { CodexService } from "./codex.service";
import { CreditsQuotaService } from "./credits-quota.service";
import { GoogleOAuthService } from "./google-oauth.service";
import type { RosettaContext } from "./lib/context";
import { migrateClaudeProductToAnthropic } from "./lib/migrate";
import { CachedJsonFile, defaultDataDir, readJson } from "./lib/store";

// migrate re-exported so existing importers (tests, bootstrap) keep importing it
// from this module unchanged.
export { migrateClaudeProductToAnthropic } from "./lib/migrate";

type RosettaServiceOptions = {
  dataDir?: string;
  codexOAuthPort?: number;
  codexOAuthFetch?: typeof fetch;
  claudeOAuthFetch?: typeof fetch;
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
  private readonly claudeOAuthFetch: typeof fetch;
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
  private readonly adspowerSvc: AdspowerService;

  constructor(
    @Optional() options: RosettaServiceOptions = {},
    @Optional() private readonly automation?: AutomationService,
    @Optional() private readonly agentAccounts?: AgentAccountService,
  ) {
    this.dataDir = options.dataDir || defaultDataDir();
    // 启动时一次性把产品 claude→anthropic 迁移到位(改文件名 + 卡绑定 key),必须在任何
    // 账号池/卡密读取之前;幂等,无旧数据时为 no-op。
    migrateClaudeProductToAnthropic(this.dataDir);
    this.codexOAuthPort = Number(options.codexOAuthPort ?? CODEX_OAUTH_DEFAULT_CALLBACK_PORT);
    this.codexOAuthFetch = options.codexOAuthFetch || fetch;
    this.claudeOAuthFetch = options.claudeOAuthFetch || fetch;
    this.accessKeysFile = new CachedJsonFile(path.join(this.dataDir, "access-keys.json"), { keys: [] });
    this.accountsFile = new CachedJsonFile(path.join(this.dataDir, "accounts.json"), { accounts: [] });

    this.ctx = {
      dataDir: this.dataDir,
      logger: this.logger,
      tokenCache: this.tokenCache,
      accessKeysFile: this.accessKeysFile,
      accountsFile: this.accountsFile,
      codexOAuthFetch: this.codexOAuthFetch,
      claudeOAuthFetch: this.claudeOAuthFetch,
      codexOAuthPort: this.codexOAuthPort,
      automation: this.automation,
      agentAccounts: this.agentAccounts,
    };
    this.accessKeySvc = new AccessKeyService(this.ctx);
    this.captchaSvc = new CaptchaService({ dataDir: this.dataDir, automation: this.automation, logger: this.logger });
    this.antigravitySvc = new AntigravityAccountService(this.ctx, this.accessKeySvc);
    this.codexSvc = new CodexService(this.ctx, this.accessKeySvc);
    this.claudeSvc = new ClaudeAccountService(this.ctx, this.accessKeySvc);
    this.googleSvc = new GoogleOAuthService(this.ctx, (p: any) => this.antigravitySvc.addAccountChecked(p));
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
  startClaudeOAuthLogin() { return this.claudeSvc.startClaudeOAuthLogin(); }
  getClaudeOAuthLoginStatus(loginId: string) { return this.claudeSvc.getClaudeOAuthLoginStatus(loginId); }
  cancelClaudeOAuthLogin(loginId: string) { return this.claudeSvc.cancelClaudeOAuthLogin(loginId); }
  submitClaudeOAuthCallback(loginId: string, rawInput: string) { return this.claudeSvc.submitClaudeOAuthCallback(loginId, rawInput); }
  toggleClaudeAccount(payload: any) { return this.claudeSvc.toggleClaudeAccount(payload); }
  setClaudeAccountProxy(payload: any) { return this.claudeSvc.setClaudeAccountProxy(payload); }
  deleteClaudeAccount(payload: any) { return this.claudeSvc.deleteClaudeAccount(payload); }
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
  cleanupExpiredKeys() { return this.accessKeySvc.cleanupExpiredKeys(); }
  cleanupUnboundKeys() { return this.accessKeySvc.cleanupUnboundKeys(); }
  getThrottleConfig() { return this.accessKeySvc.getThrottleConfig(); }
  saveThrottleConfig(payload: any) { return this.accessKeySvc.saveThrottleConfig(payload); }

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
}
