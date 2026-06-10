import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeaseService } from "../lease-service";
import type { Provider } from "../provider";

// ════════════════════════════════════════════════════════════════════════════
// 绑定卡忽略冷却:绑定卡只有这一个号、无号可换,429/503 这类【可恢复冷却】对它
// 毫无意义 —— 预先拦只会让卡白白不可用。所以绑定卡一律无视冷却,直接去试真上游;
// 只有"号彻底死了(鉴权失效)"才拦。池子卡有备用号可轮换,冷却仍照常生效。
// ════════════════════════════════════════════════════════════════════════════

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeProvider(
  id: string,
  accountsFilePath: string,
  refreshToken: (account: any) => Promise<string> = async () => "access-token-ok",
): Provider<any> {
  return {
    id,
    accountsFilePath,
    refreshToken: vi.fn(refreshToken),
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

// 两张卡共用同一个号 acct 1:绑定卡(钉死 acct1) + 池子卡(动态池,池里也只有 acct1)。
const BOUND_REQ = { headers: { "x-token-server-secret": "bound-card" } };
const POOL_REQ = { headers: { "x-token-server-secret": "pool-card" } };
const OPUS = "claude-opus-4-6";
const HAIKU = "claude-haiku-4-5";

let tempDir: string;
let accountsFilePath: string;
let accessKeysFilePath: string;
let clock: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-bound-cooldown-"));
  accountsFilePath = path.join(tempDir, "accounts.json");
  accessKeysFilePath = path.join(tempDir, "access-keys.json");
  clock = 1_000_000;
  writeJson(accessKeysFilePath, {
    keys: [
      { id: "bound-1", key: "bound-card", status: "active", durationMs: 60 * 60 * 1000, windowLimit: 1e9, boundAccountId: 1 },
      { id: "pool-1", key: "pool-card", status: "active", durationMs: 60 * 60 * 1000, windowLimit: 1e9 },
    ],
  });
  writeJson(accountsFilePath, {
    accounts: [{ id: 1, email: "bound@x.com", refreshToken: "rt-1", enabled: true }],
  });
});
afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function makeService(id: string, refreshToken?: (account: any) => Promise<string>) {
  return new LeaseService(makeProvider(id, accountsFilePath, refreshToken), {
    accessKeysFilePath,
    minClientVersion: "",
    now: () => clock,
  });
}

// 把 acct1 对某 model 打成指定封禁(503=cooling / 429=exhausted)。
async function cool(svc: LeaseService<any>, req: any, model: string, status: number, reason: string) {
  const l: any = await svc.leaseToken(req, { clientId: "c1", modelKey: model });
  await svc.reportResult(req, { leaseId: l.leaseId, status, reason, modelKey: model });
}

describe("绑定卡忽略冷却", () => {
  it("opus 被官方 503 冷却后,绑定卡仍能租到(无视冷却)", async () => {
    const svc = makeService("anthropic");
    await cool(svc, BOUND_REQ, OPUS, 503, "http_503_service_unavailable");
    const r: any = await svc.leaseToken(BOUND_REQ, { clientId: "c1", modelKey: OPUS });
    expect(r.ok).toBe(true);
    expect(r.accountId).toBe(1);
    console.log(`[绑定] opus 503 冷却被无视,仍租到 acct=${r.accountId}`);
  });

  it("opus 被 429 冷却后,绑定卡仍能租到(无视冷却)", async () => {
    const svc = makeService("anthropic");
    await cool(svc, BOUND_REQ, OPUS, 429, "http_429_resource_exhausted");
    const r: any = await svc.leaseToken(BOUND_REQ, { clientId: "c1", modelKey: OPUS });
    expect(r.ok).toBe(true);
    expect(r.accountId).toBe(1);
    console.log(`[绑定] opus 429 冷却被无视,仍租到 acct=${r.accountId}`);
  });

  it("对照 —— 池子卡:opus 被 503 冷却后租不到(冷却仍生效,无备用号可换)", async () => {
    const svc = makeService("anthropic");
    await cool(svc, POOL_REQ, OPUS, 503, "http_503_service_unavailable");
    const msg = await svc
      .leaseToken(POOL_REQ, { clientId: "c1", modelKey: OPUS })
      .then(() => "")
      .catch((e: any) => String(e?.message || e));
    expect(msg).not.toBe("");
    expect(msg).toMatch(/官方上游|503/); // 池子卡 503 → poolUnavailableMessage 明说官方上游
    console.log(`[池子] opus 503 仍被冷却挡:${msg}`);
  });

  it("号彻底死了(invalid_grant)→ 绑定卡也救不了,仍拦并给'鉴权失效'", async () => {
    // refreshToken 抛 invalid_grant → markAccountTokenError 直接把号标 error。
    const svc = makeService("anthropic", async () => {
      throw new Error("invalid_grant");
    });
    const msg = await svc
      .leaseToken(BOUND_REQ, { clientId: "c1", modelKey: OPUS })
      .then(() => "")
      .catch((e: any) => String(e?.message || e));
    expect(msg).toContain("鉴权失效");
    console.log(`[绑定] 死号仍拦:${msg}`);
  });

  it("绑定卡:opus 冷却被无视、haiku 也照常(两 model 都能租)", async () => {
    const svc = makeService("anthropic");
    await cool(svc, BOUND_REQ, OPUS, 503, "http_503_service_unavailable");
    const rOpus: any = await svc.leaseToken(BOUND_REQ, { clientId: "c1", modelKey: OPUS });
    const rHaiku: any = await svc.leaseToken(BOUND_REQ, { clientId: "c1", modelKey: HAIKU });
    expect(rOpus.ok).toBe(true);
    expect(rHaiku.ok).toBe(true);
    console.log(`[绑定] opus & haiku 都租到 acct=${rOpus.accountId}/${rHaiku.accountId}`);
  });
});
