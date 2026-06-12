import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { LeaseService } from "../lease-service";
import type { Provider } from "../provider";
import { sessionReqFor, withSessionResolver } from "../../token-server/__tests__/session-test-util";
import {
  TOKEN_DEATH_STRIKE_THRESHOLD,
  TOKEN_DEATH_FIRST_COOLDOWN_MS,
} from "../../token-server/token-billing";

// ════════════════════════════════════════════════════════════════════════════
// invalid_grant「N 击确认」:单次 invalid_grant 不再一击判死,而是先软冷却(不落盘、
// 可自动复检),攒满第 N 次(默认 5)才升级为持久化「已失效·鉴权失效」。两击之间任一
// 次刷 token 成功即清零。瞬时误判在重试里自愈,真死号在 N×软冷却 内复发确认。
// ════════════════════════════════════════════════════════════════════════════

const STRIKES = TOKEN_DEATH_STRIKE_THRESHOLD; // 默认 5
const COOL = TOKEN_DEATH_FIRST_COOLDOWN_MS;   // 默认 30s

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeProvider(
  accountsFilePath: string,
  refresh: (a: any) => Promise<string>,
): Provider<any> {
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

const REQ = sessionReqFor("card-1");
const PAYLOAD = { clientId: "c1", modelKey: "gpt-5-codex" };
const INVALID_GRANT = '400 {"error":"invalid_grant","error_description":"refresh token revoked"}';

let tempDir: string;
let accountsFilePath: string;
let accessKeysFilePath: string;
let clock: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-invgrant-strikes-"));
  accountsFilePath = path.join(tempDir, "anthropic-accounts.json");
  accessKeysFilePath = path.join(tempDir, "access-keys.json");
  clock = 1_000_000;
  writeJson(accessKeysFilePath, {
    keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, windowLimit: 1e9 }],
  });
  writeJson(accountsFilePath, {
    accounts: [{ id: 1, email: "a@example.com", refreshToken: "rt-1", enabled: true }],
  });
});
afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function makeService(refresh: (a: any) => Promise<string>) {
  const provider = makeProvider(accountsFilePath, refresh);
  const svc = withSessionResolver(new LeaseService(provider, { accessKeysFilePath, minClientVersion: "", now: () => clock }));
  return { svc, refresh: provider.refreshToken as unknown as Mock };
}

const lease = (svc: LeaseService<any>) => svc.leaseToken(REQ, PAYLOAD).then(() => true).catch(() => false);
const onDiskAcct = () => {
  const data = JSON.parse(fs.readFileSync(accountsFilePath, "utf8"));
  return data.accounts.find((a: any) => a.id === 1);
};

describe("invalid_grant N 击确认", () => {
  it("首次 invalid_grant → 软冷却:不落盘死号、出池约 30s、过后自动复检", async () => {
    const { svc, refresh } = makeService(async () => { throw new Error(INVALID_GRANT); });

    expect(await lease(svc)).toBe(false);     // attempt #1 → strike 1(软)
    expect(refresh).toHaveBeenCalledTimes(1);

    // 同 clock 再租:被软冷却挡住,根本不再尝试刷 token(出池)
    expect(await lease(svc)).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);

    // 不持久化:磁盘上没有 quotaStatus=error(瞬时态不跨重启)
    svc.flushAccounts();
    expect(onDiskAcct().quotaStatus).not.toBe("error");

    // 软冷却到期 → 自动复检,重新尝试刷 token
    clock += COOL + 1;
    expect(await lease(svc)).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it(`第 ${STRIKES} 次 invalid_grant → 升级为持久化「已失效·鉴权失效」(24h、跨重启)`, async () => {
    const { svc, refresh } = makeService(async () => { throw new Error(INVALID_GRANT); });

    for (let i = 0; i < STRIKES; i++) {
      await lease(svc);
      clock += COOL + 1; // 越过软冷却,下一次才会重新被选中尝试
    }

    expect(refresh).toHaveBeenCalledTimes(STRIKES);
    svc.flushAccounts();
    const a1 = onDiskAcct();
    expect(a1.quotaStatus).toBe("error");
    expect(a1.quotaStatusReason).toBe("invalid_grant");

    // 已死:1h 后仍封(24h 档),且 error 直接拦在选号前,不再尝试刷 token
    clock += 60 * 60 * 1000;
    expect(await lease(svc)).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(STRIKES);
  });

  it("两击之间刷 token 成功 → 计数清零,后续再撞也不会提前判死", async () => {
    let mode: "fail" | "ok" = "fail";
    const { svc } = makeService(async () => {
      if (mode === "ok") return "access-token-ok";
      throw new Error(INVALID_GRANT);
    });

    // 先撞 N-1 次(差一击就死)
    for (let i = 0; i < STRIKES - 1; i++) { await lease(svc); clock += COOL + 1; }
    svc.flushAccounts();
    expect(onDiskAcct().quotaStatus).not.toBe("error");

    // 一次成功 → tokenDeathStrikes 清零
    mode = "ok";
    expect(await lease(svc)).toBe(true);
    clock += COOL + 1;

    // 再撞 N-1 次:因为已清零,仍未攒满 → 不死
    mode = "fail";
    for (let i = 0; i < STRIKES - 1; i++) { await lease(svc); clock += COOL + 1; }
    svc.flushAccounts();
    expect(onDiskAcct().quotaStatus).not.toBe("error");
  });

  it("软冷却态不跨重启:重启后视为健康,可正常租到(对照持久化死号)", async () => {
    const { svc } = makeService(async () => { throw new Error(INVALID_GRANT); });
    await lease(svc); // strike 1(软,未落盘)
    svc.flushAccounts();
    expect(onDiskAcct().quotaStatus).not.toBe("error");

    // 重启:换一个 refresh 能成功的服务,从同一份文件 rehydrate
    const { svc: svc2 } = makeService(async () => "access-token-ok");
    await svc2.onModuleInit();
    expect(await lease(svc2)).toBe(true); // 软态没留痕 → 健康可租
  });
});
