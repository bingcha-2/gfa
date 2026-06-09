import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeaseService } from "../lease-service";
import type { Provider } from "../provider";

// ════════════════════════════════════════════════════════════════════════════
// 回归:把"永久死亡"错误按 reason 细分 + 计数升级(不再当短瞬时冷却)。
//
// 根因:冷却档位原本只按 HTTP 状态码分,而同一状态码混装了不同寿命的错误:
//   403 = service_disabled(项目删/禁,永久) / verification(用户可恢复) / 瞬时反滥用
//   400 = location_unsupported(地区永久不支持)
// 修复(markAccountPermanentDeath):
//   首次命中 → 中档账号级冷却(5min,容忍偶发误判/瞬时挑战);
//   同号同类再次命中 → 升级为持久化死号(quotaStatus=error,跨重启、不被 success 复活)。
//   verification 不算永久死亡(仍走原 60s 短冷却,用户可自行恢复)。
// ════════════════════════════════════════════════════════════════════════════

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeProvider(accountsFilePath: string, refresh: (a: any) => Promise<string>): Provider<any> {
  return {
    id: "fake",
    accountsFilePath,
    refreshToken: vi.fn(refresh),
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

const REQ = { headers: { "x-token-server-secret": "secret-card" } };
const MODEL = "gpt-5-codex";
const MIN = 60 * 1000;

let tempDir: string;
let accountsFilePath: string;
let accessKeysFilePath: string;
let clock: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-permdeath-"));
  accountsFilePath = path.join(tempDir, "codex-accounts.json");
  accessKeysFilePath = path.join(tempDir, "access-keys.json");
  clock = 1_000_000;
  writeJson(accessKeysFilePath, {
    keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, windowLimit: 1e9 }],
  });
  writeJson(accountsFilePath, {
    accounts: [{ id: 1, email: "a@x.com", refreshToken: "rt-1", enabled: true }],
  });
});
afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function makeService(refresh: (a: any) => Promise<string> = async () => "access-token-ok") {
  const svc = new LeaseService(makeProvider(accountsFilePath, refresh), {
    accessKeysFilePath,
    minClientVersion: "",
    now: () => clock,
  });
  (svc as any).provider.refreshToken = vi.fn(refresh);
  return svc;
}

async function leaseAndReport(svc: LeaseService<any>, status: number, reason: string) {
  const l: any = await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL });
  await svc.reportResult(REQ, { leaseId: l.leaseId, status, reason, modelKey: MODEL });
  return l.accountId as number;
}
const canLease = async (svc: LeaseService<any>) =>
  svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL }).then(() => true).catch(() => false);

describe("永久死亡分档 + 计数升级", () => {
  it("403 service_disabled:首次 5min 档(不再 60s 复活);再次命中 → 持久化死号", async () => {
    const svc = makeService();

    // —— 第一次命中:中档冷却(5min),不再 60s 复活 ——
    await leaseAndReport(svc, 403, "http_403_service_disabled");
    clock += 61 * 1000;
    expect(await canLease(svc)).toBe(false); // 61s 仍冷却(旧实现此刻会复活)
    clock += 5 * MIN; // 越过首档 5min
    expect(await canLease(svc)).toBe(true); // 容忍误判:首档过后给一次复探

    // —— 第二次命中:升级为持久化死号 ——
    await leaseAndReport(svc, 403, "http_403_service_disabled");
    clock += 10 * MIN; // 远超 5min 首档
    expect(await canLease(svc)).toBe(false); // 已升级,不再复活

    // 持久化到磁盘(跨重启仍死)
    svc.flushAccounts();
    const onDisk = JSON.parse(fs.readFileSync(accountsFilePath, "utf8"));
    expect(onDisk.accounts.find((a: any) => a.id === 1).quotaStatus).toBe("error");
    console.log("[修复] service_disabled:5min 首档容错 → 再次命中升级为持久化死号");
  });

  it("400 location_unsupported:不再走 3-strike 瞬时,直接进永久死亡分档", async () => {
    const svc = makeService();
    await leaseAndReport(svc, 400, "http_400_location_unsupported"); // 第一次即进首档,不用攒 3 次
    clock += 61 * 1000;
    expect(await canLease(svc)).toBe(false);
    console.log("[修复] location_unsupported:首次即冷却,不再前 3 次白烧");
  });

  it("升级后的死号不会被一次 success 误报复活", async () => {
    const svc = makeService();
    await leaseAndReport(svc, 403, "http_403_service_disabled"); // strike1
    clock += 5 * MIN;
    await leaseAndReport(svc, 403, "http_403_service_disabled"); // strike2 → 持久化 error
    // 伪造一条 success 上报(stale/重复/伪造)不应复活它
    const l: any = await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL }).catch(() => null);
    expect(l).toBeNull(); // 已死,租不到 → 没机会上报 success;直接验证仍死
    clock += 10 * MIN;
    expect(await canLease(svc)).toBe(false);
    console.log("[修复] 升级后的永久死号不被 success 复活(等同 invalid_grant 待遇)");
  });

  it("对照:403 verification → 需验证/不可用(error+verification_required+30min),非永久、可复活", async () => {
    const svc = makeService();
    await leaseAndReport(svc, 403, "http_403_account_verification_required");

    // 标成"需验证/不可用":出池、显示 verification_required
    svc.flushAccounts();
    const onDisk = JSON.parse(fs.readFileSync(accountsFilePath, "utf8"));
    expect(onDisk.accounts.find((a: any) => a.id === 1)).toMatchObject({
      quotaStatus: "error",
      quotaStatusReason: "verification_required",
    });

    clock += 61 * 1000;
    expect(await canLease(svc)).toBe(false); // 不是 60s 自愈,300min 内仍不可用
    clock += 300 * MIN; // 越过 300min → 自动复检
    expect(await canLease(svc)).toBe(true); // 非永久:复检后回到候选(验证好了即可用)
    console.log("[对照] verification:需验证/不可用,300min 自动复检,非永久死亡");
  });

  it("对照:invalid_grant 仍是 24h 持久化(分类对了本就能做对)", async () => {
    const svc = makeService(async () => {
      throw new Error('400 {"error":"invalid_grant","error_description":"token revoked"}');
    });
    await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL }).catch(() => {});
    clock += 60 * MIN;
    expect(await canLease(svc)).toBe(false); // 1h 后仍封(24h 档)
    console.log("[对照] invalid_grant:24h 永久封不变");
  });
});
