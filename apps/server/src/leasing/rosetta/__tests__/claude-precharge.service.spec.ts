import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ClaudePrechargeService,
  type ClaudePrechargeOrgProbeResult,
} from "../claude-precharge.service";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const SESSION_KEY_OLD = ["sk", "ant-sid02-old"].join("-");
const SESSION_KEY_LIVE = ["sk", "ant-sid02-live"].join("-");
const TEST_TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const TEST_TOTP_URL = `https://2fa.show/2fa/${TEST_TOTP_SECRET}`;

class TestPrechargeService extends ClaudePrechargeService {
  loginResult: ClaudePrechargeOrgProbeResult = {
    orgId: "org-1",
    orgName: "Org One",
    capabilities: ["chat"],
    rateLimitTier: "default_claude_ai",
    billingType: "",
    sessionKey: SESSION_KEY_LIVE,
  };

  quickResult: ClaudePrechargeOrgProbeResult = this.loginResult;
  loginOptions: any[] = [];

  protected override async loginAndReadOrganization(_account?: any, options?: any): Promise<ClaudePrechargeOrgProbeResult> {
    this.loginOptions.push(options || {});
    return this.loginResult;
  }

  protected override async readOrganizationWithSessionKey(): Promise<ClaudePrechargeOrgProbeResult> {
    return this.quickResult;
  }
}

describe("ClaudePrechargeService", () => {
  let dataDir: string;
  let claudeSvc: {
    startAutoClaudeOAuth: ReturnType<typeof vi.fn>;
    startManualClaudeLoginWithCredentials: ReturnType<typeof vi.fn>;
  };
  let svc: TestPrechargeService;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-claude-precharge-"));
    claudeSvc = {
      startAutoClaudeOAuth: vi.fn(() => ({ ok: true, taskId: "task-1" })),
      startManualClaudeLoginWithCredentials: vi.fn(() => ({ ok: true, taskId: "manual-1" })),
    };
    svc = new TestPrechargeService({ dataDir } as any, claudeSvc as any);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("imports precharge accounts and redacts secrets in list output", () => {
    const result = svc.importAccounts({
      lines: `user@example.com----pw123----${SESSION_KEY_OLD}`,
      proxyUrl: "167.148.11.252:443:user:pass",
      adspowerProfileId: "k1bvbavq",
    });

    expect(result).toMatchObject({ ok: true, total: 1, success: 1 });

    const list = svc.listAccounts();
    expect(list.accounts).toHaveLength(1);
    expect(list.accounts[0]).toMatchObject({
      email: "user@example.com",
      proxyUrl: "socks5://user:pass@167.148.11.252:443",
      adspowerProfileId: "k1bvbavq",
      status: "NEW",
      hasMailPassword: true,
      hasSessionKey: true,
    });
    expect((list.accounts[0] as any).mailPassword).toBeUndefined();
    expect((list.accounts[0] as any).sessionKey).toBeUndefined();
  });

  it("imports gmail precharge credentials with recovery email, TOTP URL, and session key", () => {
    const result = svc.importAccounts({
      lines: `gmail-user@gmail.com----pw123----recover@nmailbox.org----${TEST_TOTP_URL}----${SESSION_KEY_OLD}`,
      proxyUrl: "socks5://user:pass@127.0.0.1:1080",
      adspowerProfileId: "profile-1",
    });

    expect(result).toMatchObject({ ok: true, total: 1, success: 1 });

    const stored = JSON.parse(
      fs.readFileSync(path.join(dataDir, "anthropic-precharge-accounts.json"), "utf8"),
    ).accounts[0];
    expect(stored).toMatchObject({
      email: "gmail-user@gmail.com",
      mailPassword: "pw123",
      recoveryEmail: "recover@nmailbox.org",
      totpSecret: TEST_TOTP_SECRET,
      sessionKey: SESSION_KEY_OLD,
    });

    const listed = svc.listAccounts().accounts[0] as any;
    expect(listed).toMatchObject({
      hasMailPassword: true,
      hasRecoveryEmail: true,
      hasTotpSecret: true,
      hasSessionKey: true,
    });
    expect(listed.recoveryEmail).toBeUndefined();
    expect(listed.totpSecret).toBeUndefined();
  });

  it("login probe stores organization metadata and a fresh sessionKey", async () => {
    const imported = svc.importAccounts({
      lines: "user@example.com----pw123",
      proxyUrl: "socks5://user:pass@127.0.0.1:1080",
      adspowerProfileId: "k1bvbavq",
    });

    const probed = await svc.loginProbe({ accountId: imported.results[0].id });

    expect(probed).toMatchObject({
      ok: true,
      orgId: "org-1",
      status: "ORG_READY",
    });

    const stored = JSON.parse(
      fs.readFileSync(path.join(dataDir, "anthropic-precharge-accounts.json"), "utf8"),
    ).accounts[0];
    expect(stored).toMatchObject({
      orgId: "org-1",
      orgName: "Org One",
      sessionKey: SESSION_KEY_LIVE,
      status: "ORG_READY",
      lastError: "",
    });
    expect(svc.loginOptions[0]?.keepBrowserOpen).toBeFalsy();
  });

  it("passes saved gmail recovery email and TOTP secret to precharge login probe", async () => {
    const imported = svc.importAccounts({
      lines: `gmail-user@gmail.com----pw123----recover@nmailbox.org----${TEST_TOTP_URL}`,
      proxyUrl: "socks5://user:pass@127.0.0.1:1080",
      adspowerProfileId: "profile-1",
    });

    await expect(svc.loginProbe({ accountId: imported.results[0].id })).resolves.toMatchObject({
      ok: true,
      status: "ORG_READY",
    });

    expect(svc.loginOptions[0]).toMatchObject({
      recoveryEmail: "recover@nmailbox.org",
      totpSecret: TEST_TOTP_SECRET,
    });
  });

  it("quick probe uses the saved sessionKey and marks failed sessions for relogin", async () => {
    writeJson(path.join(dataDir, "anthropic-precharge-accounts.json"), {
      accounts: [
        {
          id: 1,
          email: "user@example.com",
          mailPassword: "pw123",
          sessionKey: SESSION_KEY_OLD,
          proxyUrl: "socks5://user:pass@127.0.0.1:1080",
          adspowerProfileId: "k1bvbavq",
          status: "ORG_READY",
        },
      ],
    });
    svc.quickResult = { orgId: "", error: "not logged in" };

    const result = await svc.quickProbe({ accountId: 1 });

    expect(result).toMatchObject({
      ok: false,
      status: "NEEDS_RELOGIN",
      error: "not logged in",
    });
    expect(svc.listAccounts().accounts[0]).toMatchObject({
      status: "NEEDS_RELOGIN",
      lastError: "not logged in",
    });
  });

  it("marks top-up and starts activation with password first or SK fallback", () => {
    writeJson(path.join(dataDir, "anthropic-precharge-accounts.json"), {
      accounts: [
        {
          id: 1,
          email: "user@example.com",
          mailPassword: "pw123",
          sessionKey: SESSION_KEY_OLD,
          proxyUrl: "socks5://user:pass@127.0.0.1:1080",
          adspowerProfileId: "k1bvbavq",
          status: "AWAITING_TOPUP",
        },
      ],
    });

    expect(svc.markTopup({ accountId: 1 })).toMatchObject({ ok: true, status: "TOPUP_DONE" });
    expect(svc.activate({ accountId: 1 })).toMatchObject({ ok: true, taskId: "task-1" });
    expect(claudeSvc.startAutoClaudeOAuth).toHaveBeenLastCalledWith({
      email: "user@example.com",
      password: "pw123",
      proxyUrl: "socks5://user:pass@127.0.0.1:1080",
      adspowerProfileId: "k1bvbavq",
      recoveryEmail: "",
      totpSecret: "",
      sessionKey: "",
    });

    expect(svc.activateWithSessionKey({ accountId: 1 })).toMatchObject({ ok: true, taskId: "task-1" });
    expect(claudeSvc.startAutoClaudeOAuth).toHaveBeenLastCalledWith({
      email: "user@example.com",
      password: "",
      proxyUrl: "socks5://user:pass@127.0.0.1:1080",
      adspowerProfileId: "k1bvbavq",
      recoveryEmail: "",
      totpSecret: "",
      sessionKey: SESSION_KEY_OLD,
    });
  });

  it("passes saved gmail recovery email and TOTP secret to precharge activation", () => {
    writeJson(path.join(dataDir, "anthropic-precharge-accounts.json"), {
      accounts: [
        {
          id: 1,
          email: "gmail-user@gmail.com",
          mailPassword: "pw123",
          recoveryEmail: "recover@nmailbox.org",
          totpSecret: TEST_TOTP_SECRET,
          proxyUrl: "socks5://user:pass@127.0.0.1:1080",
          adspowerProfileId: "profile-1",
          status: "TOPUP_DONE",
        },
      ],
    });

    expect(svc.activate({ accountId: 1 })).toMatchObject({ ok: true, taskId: "task-1" });
    expect(claudeSvc.startAutoClaudeOAuth).toHaveBeenLastCalledWith({
      email: "gmail-user@gmail.com",
      password: "pw123",
      proxyUrl: "socks5://user:pass@127.0.0.1:1080",
      adspowerProfileId: "profile-1",
      recoveryEmail: "recover@nmailbox.org",
      totpSecret: TEST_TOTP_SECRET,
      sessionKey: "",
    });
  });

  it("runs precharge manual login as login probe and leaves the browser open", async () => {
    writeJson(path.join(dataDir, "anthropic-precharge-accounts.json"), {
      accounts: [
        {
          id: 1,
          email: "user@example.com",
          mailPassword: "pw123",
          proxyUrl: "socks5://user:pass@127.0.0.1:1080",
          adspowerProfileId: "profile-1",
          status: "AWAITING_TOPUP",
        },
      ],
    });

    const result = await svc.manualLogin({ accountId: 1 });

    expect(result).toMatchObject({
      ok: true,
      accountId: 1,
      email: "user@example.com",
      orgId: "org-1",
      status: "ORG_READY",
    });
    expect(svc.loginOptions[0]).toMatchObject({ keepBrowserOpen: true });
    expect(claudeSvc.startManualClaudeLoginWithCredentials).not.toHaveBeenCalled();
    expect(svc.listAccounts().accounts[0]).toMatchObject({
      status: "ORG_READY",
      orgId: "org-1",
      lastError: "",
    });
  });

  it("rejects precharge manual login when the strict AdsPower environment is incomplete", async () => {
    writeJson(path.join(dataDir, "anthropic-precharge-accounts.json"), {
      accounts: [
        { id: 1, email: "no-proxy@example.com", mailPassword: "pw123", adspowerProfileId: "profile-1" },
        { id: 2, email: "no-profile@example.com", mailPassword: "pw123", proxyUrl: "socks5://127.0.0.1:1080" },
        { id: 3, email: "no-password@example.com", proxyUrl: "socks5://127.0.0.1:1080", adspowerProfileId: "profile-3" },
      ],
    });

    await expect(svc.manualLogin({ accountId: 1 })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("代理") });
    await expect(svc.manualLogin({ accountId: 2 })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("AdsPower") });
    await expect(svc.manualLogin({ accountId: 3 })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("密码") });
    expect(claudeSvc.startManualClaudeLoginWithCredentials).not.toHaveBeenCalled();
  });
});
