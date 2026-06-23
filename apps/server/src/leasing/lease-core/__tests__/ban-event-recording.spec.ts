import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeaseService } from "../lease-service";
import type { Provider } from "../provider";
import { sessionReqFor, withSessionResolver } from "../../token-server/__tests__/session-test-util";

// 封号事件记录器接入 LeaseService:
//   - 每次上报喂 observeRequest(内存环);reverseProxy 来自客户端 clientFlag。
//   - 母号 403 永久封禁 → recordBan(带 status/reason/body/strikes)。
//   - 未注入 recorder(antigravity)→ no-op,不影响主流程。

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeProvider(accountsFilePath: string): Provider<any> {
  return {
    id: "anthropic",
    accountsFilePath,
    refreshToken: vi.fn(async () => "access-token-ok"),
    normalizeAccount: (raw: any) => ({
      ...raw,
      id: Number(raw.id),
      email: String(raw.email || ""),
      refreshToken: String(raw.refreshToken || ""),
      enabled: raw.enabled !== false,
    }),
    isAccountEligible: () => true,
    applyQuotaSnapshot: (account: any) => ({ account, creditDelta: null }),
    egressPolicy: "optional" as const,
    leaseResponseExtras: () => ({}),
  } as unknown as Provider<any>;
}

const REQ = sessionReqFor("card-1");
const MODEL = "claude";

let tempDir: string;
let accountsFilePath: string;
let accessKeysFilePath: string;
let clock: number;
let recorder: { observeRequest: ReturnType<typeof vi.fn>; recordBan: ReturnType<typeof vi.fn> };
let logRecorder: { record: ReturnType<typeof vi.fn> };

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ban-event-rec-"));
  accountsFilePath = path.join(tempDir, "anthropic-accounts.json");
  accessKeysFilePath = path.join(tempDir, "access-keys.json");
  clock = 1_000_000;
  recorder = { observeRequest: vi.fn(), recordBan: vi.fn() };
  logRecorder = { record: vi.fn() };
  writeJson(accessKeysFilePath, {
    keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, windowLimit: 1e9 }],
  });
  writeJson(accountsFilePath, {
    accounts: [{ id: 1, email: "a@x.com", refreshToken: "rt-1", enabled: true, proxyUrl: "socks5://u:p@1.2.3.4:1080" }],
  });
});
afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function makeService(opts: { noRecorder?: boolean } = {}) {
  const svc = withSessionResolver(new LeaseService(makeProvider(accountsFilePath), {
    accessKeysFilePath,
    minClientVersion: "",
    now: () => clock,
    banEventRecorder: opts.noRecorder ? undefined : (recorder as any),
    requestLogRecorder: opts.noRecorder ? undefined : (logRecorder as any),
  }));
  (svc as any).provider.refreshToken = vi.fn(async () => "access-token-ok");
  return svc;
}

async function leaseAndReport(
  svc: LeaseService<any>,
  status: number,
  reason: string,
  extra: Record<string, unknown> = {},
) {
  const l: any = await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL });
  await svc.reportResult(REQ, { leaseId: l.leaseId, status, reason, modelKey: MODEL, totalTokens: 100, ...extra });
  return l.accountId as number;
}

describe("封号事件记录接入 LeaseService", () => {
  it("每次上报都喂 observeRequest(reverseProxy 取自 clientFlag)", async () => {
    const svc = makeService();
    await leaseAndReport(svc, 200, "", { clientFlag: "no_cc_system_prompt" });
    expect(recorder.observeRequest).toHaveBeenCalledTimes(1);
    expect(recorder.observeRequest.mock.calls[0][0]).toMatchObject({
      provider: "anthropic", accountId: 1, accessKeyId: "card-1", modelKey: MODEL, status: 200,
      totalTokens: 100, reverseProxy: true,
    });
  });

  it("403 service_disabled 封号 → recordBan(status/reason/body/strikes)", async () => {
    const svc = makeService();
    await leaseAndReport(svc, 403, "http_403_service_disabled", { errorText: "account disabled by anthropic" });
    expect(recorder.recordBan).toHaveBeenCalledTimes(1);
    const arg = recorder.recordBan.mock.calls[0][0];
    expect(arg).toMatchObject({
      provider: "anthropic", accountId: 1, accountEmail: "a@x.com",
      reason: "http_403_service_disabled", upstreamStatus: 403, upstreamBody: "account disabled by anthropic",
      modelKey: MODEL,
    });
    expect(arg.deathStrikes).toBeGreaterThanOrEqual(1);
  });

  it("每次上报喂 requestLogRecorder.record(server 富集 exitIp/sourceIp + 客户端 surface/headers/deviceId)", async () => {
    const svc = makeService();
    await leaseAndReport(svc, 200, "", {
      clientFlag: "no_cc_system_prompt", surface: "cli", headers: '{"user-agent":"claude-cli/2"}',
    });
    expect(logRecorder.record).toHaveBeenCalledTimes(1);
    expect(logRecorder.record.mock.calls[0][0]).toMatchObject({
      provider: "anthropic", accountId: 1, accountEmail: "a@x.com", accessKeyId: "card-1",
      deviceId: "c1", modelKey: MODEL, status: 200, reverseProxy: true,
      surface: "cli", exitIp: "1.2.3.4", headers: '{"user-agent":"claude-cli/2"}',
    });
    // 环也带上了 surface/exitIp
    expect(recorder.observeRequest.mock.calls[0][0]).toMatchObject({ surface: "cli", exitIp: "1.2.3.4" });
  });

  it("普通成功上报不触发 recordBan", async () => {
    const svc = makeService();
    await leaseAndReport(svc, 200, "");
    expect(recorder.recordBan).not.toHaveBeenCalled();
  });

  it("未注入 recorder 时主流程不报错(antigravity 路径)", async () => {
    const svc = makeService({ noRecorder: true });
    await expect(leaseAndReport(svc, 403, "http_403_service_disabled")).resolves.toBe(1);
  });
});
