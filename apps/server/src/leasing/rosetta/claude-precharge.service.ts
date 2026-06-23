import * as crypto from "crypto";
import * as path from "path";

import type { RosettaContext } from "./lib/context";
import {
  readClaudeOrganizationsViaSessionKey,
  triggerMagicLinkViaBrowser,
  waitForClaudeOrganizationsFromPage,
  type ClaudeWebOrganization,
  type PlaywrightOAuthSession,
} from "./lib/playwright-oauth";
import { fetchAnthropicMagicLinkViaWeb } from "./lib/mailcom-web-magic-link";
import { nowIso, readJson, toSocks5ProxyUrl, writeJson } from "./lib/store";

export type ClaudePrechargeStatus =
  | "NEW"
  | "ORG_READY"
  | "AWAITING_TOPUP"
  | "TOPUP_DONE"
  | "OAUTH_STARTED"
  | "MOVED_TO_POOL"
  | "NEEDS_RELOGIN"
  | "PROBE_FAILED";

export type ClaudePrechargeOrgProbeResult = {
  orgId?: string;
  orgName?: string;
  capabilities?: string[];
  rateLimitTier?: string;
  billingType?: string;
  sessionKey?: string;
  currentUrl?: string;
  session?: PlaywrightOAuthSession;
  error?: string;
};

type ProbeOptions = {
  keepBrowserOpen?: boolean;
};

type StoredPrechargeAccount = {
  id: number;
  email: string;
  mailPassword?: string;
  sessionKey?: string;
  proxyUrl?: string;
  adspowerProfileId?: string;
  orgId?: string;
  orgName?: string;
  capabilities?: string[];
  rateLimitTier?: string;
  billingType?: string;
  status?: ClaudePrechargeStatus;
  lastProbeAt?: string;
  lastError?: string;
  activateTaskId?: string;
  createdAt?: string;
  updatedAt?: string;
};

type PrechargeStore = {
  accounts: StoredPrechargeAccount[];
  updatedAt?: string;
};

type ClaudeOAuthStarter = {
  startAutoClaudeOAuth(payload: any): any;
  startManualClaudeLoginWithCredentials(payload: any): any;
};

export class ClaudePrechargeService {
  private readonly manualProbeSessions = new Map<number, PlaywrightOAuthSession>();

  constructor(
    private readonly ctx: RosettaContext,
    private readonly claudeSvc: ClaudeOAuthStarter,
  ) {}

  private filePath() {
    return path.join(this.ctx.dataDir, "anthropic-precharge-accounts.json");
  }

  private load(): PrechargeStore {
    const data = readJson(this.filePath(), { accounts: [] });
    return {
      ...data,
      accounts: Array.isArray(data.accounts) ? data.accounts as StoredPrechargeAccount[] : [],
    };
  }

  private save(data: PrechargeStore) {
    writeJson(this.filePath(), { ...data, updatedAt: nowIso() });
  }

  listAccounts() {
    const data = this.load();
    return {
      ok: true,
      accounts: data.accounts.map((account) => ({
        id: Number(account.id || 0),
        email: String(account.email || ""),
        proxyUrl: String(account.proxyUrl || ""),
        adspowerProfileId: String(account.adspowerProfileId || ""),
        orgId: String(account.orgId || ""),
        orgName: String(account.orgName || ""),
        capabilities: Array.isArray(account.capabilities) ? account.capabilities : [],
        rateLimitTier: String(account.rateLimitTier || ""),
        billingType: String(account.billingType || ""),
        status: normalizeStatus(account.status),
        hasMailPassword: Boolean(account.mailPassword),
        hasSessionKey: Boolean(account.sessionKey),
        lastProbeAt: String(account.lastProbeAt || ""),
        lastError: String(account.lastError || ""),
        activateTaskId: String(account.activateTaskId || ""),
        createdAt: String(account.createdAt || ""),
        updatedAt: String(account.updatedAt || ""),
      })),
    };
  }

  importAccounts(payload: any) {
    const lines = String(payload?.lines || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const proxyUrl = payload?.proxyUrl ? toSocks5ProxyUrl(payload.proxyUrl) : "";
    const adspowerProfileId = String(payload?.adspowerProfileId || "").trim();
    const data = this.load();
    const accounts = data.accounts;
    const results: Array<{ id: number; email: string; ok: boolean; error?: string; isUpdate?: boolean }> = [];

    for (const line of lines) {
      const parsed = parsePrechargeLine(line);
      if (!parsed.email || !parsed.mailPassword) {
        results.push({ id: 0, email: parsed.email || line.slice(0, 30), ok: false, error: "格式不对，需要: email----password----可选sessionKey" });
        continue;
      }
      const existing = accounts.find((account) => account.email.toLowerCase() === parsed.email.toLowerCase());
      let id: number;
      if (existing) {
        id = Number(existing.id);
        existing.mailPassword = parsed.mailPassword;
        if (parsed.sessionKey) existing.sessionKey = parsed.sessionKey;
        if (proxyUrl) existing.proxyUrl = proxyUrl;
        if (adspowerProfileId) existing.adspowerProfileId = adspowerProfileId;
        existing.status = normalizeStatus(existing.status);
        existing.lastError = "";
        existing.updatedAt = nowIso();
      } else {
        id = accounts.reduce((max, account) => Math.max(max, Number(account.id || 0)), 0) + 1;
        accounts.push({
          id,
          email: parsed.email,
          mailPassword: parsed.mailPassword,
          sessionKey: parsed.sessionKey,
          proxyUrl,
          adspowerProfileId,
          status: "NEW",
          lastError: "",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
      }
      results.push({ id, email: parsed.email, ok: true, isUpdate: Boolean(existing) });
    }

    this.save({ ...data, accounts });
    return { ok: true, total: lines.length, success: results.filter((result) => result.ok).length, results };
  }

  async loginProbe(payload: any) {
    return this.probe(payload, "login");
  }

  async quickProbe(payload: any) {
    return this.probe(payload, "quick");
  }

  markTopup(payload: any) {
    const found = this.findAccount(Number(payload?.accountId));
    if (!found.account) return { ok: false, error: "账号不存在" };
    found.account.status = "TOPUP_DONE";
    found.account.updatedAt = nowIso();
    this.save(found.data);
    return { ok: true, id: found.account.id, email: found.account.email, status: "TOPUP_DONE" };
  }

  async manualLogin(payload: any) {
    return this.probe(payload, "login", { keepBrowserOpen: true });
  }

  activate(payload: any) {
    const found = this.findAccount(Number(payload?.accountId));
    const account = found.account;
    if (!account) return { ok: false, error: "账号不存在" };
    if (!account.mailPassword) return { ok: false, error: "邮箱密码为空，无法优先邮箱登录" };
    const result = this.claudeSvc.startAutoClaudeOAuth({
      email: account.email,
      password: account.mailPassword,
      proxyUrl: account.proxyUrl || "",
      adspowerProfileId: account.adspowerProfileId || "",
      sessionKey: "",
    });
    return this.afterActivationStart(found, result);
  }

  activateWithSessionKey(payload: any) {
    const found = this.findAccount(Number(payload?.accountId));
    const account = found.account;
    if (!account) return { ok: false, error: "账号不存在" };
    if (!account.sessionKey) return { ok: false, error: "sessionKey 为空，无法兜底上号" };
    const result = this.claudeSvc.startAutoClaudeOAuth({
      email: account.email,
      password: "",
      proxyUrl: account.proxyUrl || "",
      adspowerProfileId: account.adspowerProfileId || "",
      sessionKey: account.sessionKey,
    });
    return this.afterActivationStart(found, result);
  }

  deleteAccount(payload: any) {
    const accountId = Number(payload?.accountId);
    const data = this.load();
    const accounts = data.accounts.filter((account) => Number(account.id) !== accountId);
    if (accounts.length === data.accounts.length) return { ok: false, error: "账号不存在" };
    this.save({ ...data, accounts });
    return { ok: true };
  }

  private afterActivationStart(found: { data: any; account?: StoredPrechargeAccount }, result: any) {
    if (!result?.ok) return result;
    const account = found.account!;
    account.status = "OAUTH_STARTED";
    account.activateTaskId = String(result.taskId || "");
    account.lastError = "";
    account.updatedAt = nowIso();
    this.save(found.data);
    return { ...result, accountId: account.id, email: account.email, status: "OAUTH_STARTED" };
  }

  private async probe(payload: any, mode: "login" | "quick", options: ProbeOptions = {}) {
    const found = this.findAccount(Number(payload?.accountId));
    const account = found.account;
    if (!account) return { ok: false, error: "账号不存在" };
    if (!account.proxyUrl) return this.markProbeError(found, "PROBE_FAILED", "出口代理为空");
    if (!account.adspowerProfileId) return this.markProbeError(found, "PROBE_FAILED", "AdsPower profile 为空");
    if (mode === "login" && !account.mailPassword) return this.markProbeError(found, "NEEDS_RELOGIN", "邮箱密码为空");
    if (mode === "quick" && !account.sessionKey) return this.markProbeError(found, "NEEDS_RELOGIN", "sessionKey 为空");

    const result = mode === "login"
      ? await this.loginAndReadOrganization(account, { keepBrowserOpen: options.keepBrowserOpen })
      : await this.readOrganizationWithSessionKey(account);
    if (options.keepBrowserOpen && result.session) {
      this.holdManualProbeSession(account.id, result.session);
    }
    if (!result.orgId) {
      return this.markProbeError(found, mode === "quick" ? "NEEDS_RELOGIN" : "PROBE_FAILED", result.error || "未获取到组织 ID");
    }

    account.orgId = result.orgId;
    account.orgName = result.orgName || account.orgName || "";
    account.capabilities = result.capabilities || [];
    account.rateLimitTier = result.rateLimitTier || "";
    account.billingType = result.billingType || "";
    if (result.sessionKey) account.sessionKey = result.sessionKey;
    account.status = "ORG_READY";
    account.lastError = "";
    account.lastProbeAt = nowIso();
    account.updatedAt = nowIso();
    this.save(found.data);
    return {
      ok: true,
      id: account.id,
      accountId: account.id,
      email: account.email,
      orgId: account.orgId,
      orgName: account.orgName,
      status: account.status,
      currentUrl: result.currentUrl,
    };
  }

  private holdManualProbeSession(accountId: number, session: PlaywrightOAuthSession) {
    const existing = this.manualProbeSessions.get(accountId);
    if (existing && existing !== session) {
      void existing.close().catch(() => {});
    }
    this.manualProbeSessions.set(accountId, session);
  }

  private markProbeError(
    found: { data: any; account?: StoredPrechargeAccount },
    status: ClaudePrechargeStatus,
    error: string,
  ) {
    const account = found.account!;
    account.status = status;
    account.lastError = error;
    account.lastProbeAt = nowIso();
    account.updatedAt = nowIso();
    this.save(found.data);
    return { ok: false, id: account.id, email: account.email, status, error };
  }

  private findAccount(accountId: number): { data: any; account?: StoredPrechargeAccount } {
    const data = this.load();
    return {
      data,
      account: data.accounts.find((account) => Number(account.id) === accountId),
    };
  }

  protected async loginAndReadOrganization(
    account: StoredPrechargeAccount,
    options: ProbeOptions = {},
  ): Promise<ClaudePrechargeOrgProbeResult> {
    const authorizeUrl = buildClaudeAuthorizeUrl();
    const triggerStart = Date.now();
    const trigger = await triggerMagicLinkViaBrowser({
      authorizeUrl,
      email: account.email,
      password: account.mailPassword || "",
      proxyUrl: account.proxyUrl,
      adspowerProfileId: account.adspowerProfileId,
    });
    if (!trigger.ok || !trigger.session) return { error: trigger.error || "浏览器触发失败" };

    try {
      const mail = await fetchAnthropicMagicLinkViaWeb({
        email: account.email,
        password: account.mailPassword || "",
        sinceMs: triggerStart - 30_000,
        waitMs: 90_000,
        proxyUrl: account.proxyUrl,
      });
      if (!mail.ok || !mail.url) {
        return {
          error: mail.error || "未获取到 magic link",
          currentUrl: trigger.session.page.url(),
          session: options.keepBrowserOpen ? trigger.session : undefined,
        };
      }
      await trigger.session.page.goto(mail.url, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
      const orgs = await waitForClaudeOrganizationsFromPage(trigger.session.page, {
        previousSessionKey: account.sessionKey || "",
        settleMs: 10_000,
        retryDelayMs: 10_000,
        maxAttempts: 3,
      });
      if (!orgs.ok || !orgs.organizations.length) {
        return {
          error: orgs.error || `organizations HTTP ${orgs.status}: ${orgs.bodySnippet}`,
          currentUrl: trigger.session.page.url(),
          session: options.keepBrowserOpen ? trigger.session : undefined,
        };
      }
      return {
        ...orgProbeFromOrganization(orgs.organizations[0], orgs.sessionKey),
        currentUrl: trigger.session.page.url(),
        session: options.keepBrowserOpen ? trigger.session : undefined,
      };
    } finally {
      if (!options.keepBrowserOpen) await trigger.session.close().catch(() => {});
    }
  }

  protected async readOrganizationWithSessionKey(account: StoredPrechargeAccount): Promise<ClaudePrechargeOrgProbeResult> {
    const result = await readClaudeOrganizationsViaSessionKey({
      sessionKey: account.sessionKey || "",
      proxyUrl: account.proxyUrl,
      adspowerProfileId: account.adspowerProfileId,
    });
    if (!result.ok || !result.organizations?.length) {
      return { error: result.error || `organizations HTTP ${result.status || 0}: ${result.bodySnippet || ""}` };
    }
    return orgProbeFromOrganization(result.organizations[0], account.sessionKey || "");
  }
}

function parsePrechargeLine(line: string) {
  const parts = line.split(/----+/).map((part) => part.trim());
  const email = parts[0] || "";
  const mailPassword = parts[1] || "";
  const sessionKey = (parts.find((part, index) => index >= 2 && part.startsWith("sk-ant-")) || "").trim();
  return { email, mailPassword, sessionKey };
}

function normalizeStatus(raw: unknown): ClaudePrechargeStatus {
  const value = String(raw || "").toUpperCase();
  const allowed: ClaudePrechargeStatus[] = [
    "NEW",
    "ORG_READY",
    "AWAITING_TOPUP",
    "TOPUP_DONE",
    "OAUTH_STARTED",
    "MOVED_TO_POOL",
    "NEEDS_RELOGIN",
    "PROBE_FAILED",
  ];
  return allowed.includes(value as ClaudePrechargeStatus) ? value as ClaudePrechargeStatus : "NEW";
}

function orgProbeFromOrganization(org: ClaudeWebOrganization, sessionKey: string): ClaudePrechargeOrgProbeResult {
  return {
    orgId: String(org.uuid || org.id || ""),
    orgName: String(org.name || ""),
    capabilities: Array.isArray(org.capabilities) ? org.capabilities.map(String) : [],
    rateLimitTier: String(org.rate_limit_tier || ""),
    billingType: String(org.billing_type || ""),
    sessionKey,
  };
}

function buildClaudeAuthorizeUrl(): string {
  const clientId = process.env.BCAI_CLAUDE_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
  const authEndpoint = process.env.BCAI_CLAUDE_AUTHORIZE_URL || "https://claude.com/cai/oauth/authorize";
  const redirectUri = process.env.BCAI_CLAUDE_REDIRECT_URI || "https://platform.claude.com/oauth/code/callback";
  const scopes = "org:create_api_key user:profile user:inference";
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest().toString("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${authEndpoint}?${params.toString()}`;
}
