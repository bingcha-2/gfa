import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeaseService } from "../lease-service";
import type { Provider } from "../provider";
import { sessionReqFor, withSessionResolver } from "../../token-server/__tests__/session-test-util";

// ════════════════════════════════════════════════════════════════════════════
// 瞬时限速 429 ≠ 额度耗尽 429。
//
// 上游(如 Anthropic rate_limit_error / "would exceed your account's rate limit")
// 的限速 429 账号额度并未用尽、是健康的。若按额度耗尽冷却到配额窗口 reset(可达数小时),
// 绑定卡(无备号)会因一次瞬时限速被打死数小时,而用户额度其实还满着。
// 期望:限速 429 → 【一点不冷却、不踢出轮换,下个请求立刻还能用它】;
//       额度耗尽 429 → 长冷却 + exhausted。
// ════════════════════════════════════════════════════════════════════════════

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeProvider(id: string, accountsFilePath: string, rateLimitZeroCooldown = true): Provider<any> {
  return {
    id,
    accountsFilePath,
    rateLimitZeroCooldown,
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
const MODEL = "gemini-2.5-pro";
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

let tempDir: string;
let accountsFilePath: string;
let accessKeysFilePath: string;
let clock: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-limit-429-"));
  accountsFilePath = path.join(tempDir, "accounts.json");
  accessKeysFilePath = path.join(tempDir, "access-keys.json");
  clock = 1_000_000;
  writeJson(accessKeysFilePath, {
    keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, windowLimit: 1e9 }],
  });
});
afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function makeService(accounts: any[], rateLimitZeroCooldown = true) {
  writeJson(accountsFilePath, { accounts });
  return withSessionResolver(new LeaseService(makeProvider("codex", accountsFilePath, rateLimitZeroCooldown), {
    accessKeysFilePath,
    minClientVersion: "",
    now: () => clock,
  }));
}

function acctStatus(svc: LeaseService<any>, id: number) {
  return (svc as any).getStatus().quota.accounts.find((a: any) => a.id === id);
}

async function leaseThenReport(svc: LeaseService<any>, report: Record<string, unknown>) {
  const l: any = await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL });
  await svc.reportResult(REQ, { leaseId: l.leaseId, modelKey: MODEL, ...report });
}

describe("瞬时限速 429 ≠ 额度耗尽 429 的冷却分流", () => {
  it("rate_limit 429(too_many_requests)→ 一点不冷却、不踢出轮换", async () => {
    const svc = makeService([{ id: 1, email: "a@x.com", refreshToken: "rt-1", enabled: true }]);
    await leaseThenReport(svc, { status: 429, reason: "http_429_too_many_requests" });

    const a = acctStatus(svc, 1);
    expect(a.quotaStatus).toBe("ok"); // 健康号,没被标 cooling/exhausted
    // 零冷却:时钟没动也能立刻把同一个号再租出去。
    const r: any = await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL });
    expect(r.accountId).toBe(1);
  });

  it("额度耗尽 429(resource_exhausted)→ 长冷却 + exhausted(行为不变)", async () => {
    const svc = makeService([{ id: 1, email: "a@x.com", refreshToken: "rt-1", enabled: true }]);
    await leaseThenReport(svc, { status: 429, reason: "http_429_resource_exhausted" });

    const a = acctStatus(svc, 1);
    expect(a.quotaStatus).toBe("exhausted");
    // reset 时间未知 → 回落 5h 默认。
    expect(a.blockedUntil - clock).toBe(FIVE_HOURS_MS);
  });

  it("rate_limit 429 带上游短 retry-after → 仍一点不冷却(限速不 sideline 健康号)", async () => {
    const svc = makeService([{ id: 1, email: "a@x.com", refreshToken: "rt-1", enabled: true }]);
    await leaseThenReport(svc, { status: 429, reason: "http_429_too_many_requests", retryAfterMs: 30_000 });

    const a = acctStatus(svc, 1);
    expect(a.quotaStatus).toBe("ok");
    const r: any = await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL });
    expect(r.accountId).toBe(1); // 限速不冷却,立刻可再租
  });

  it("reason 含糊(默认 quota)但账号 5h 额度仍有余 → 判为瞬时限速(零冷却)", async () => {
    const svc = makeService([{
      id: 1, email: "a@x.com", refreshToken: "rt-1", enabled: true,
      // 账号该模型仍有 50% 额度 → 有额度还 429,必是瞬时限速。
      modelQuotaFractions: { [MODEL]: 0.5 },
    }]);
    await leaseThenReport(svc, { status: 429, reason: "quota" });

    const a = acctStatus(svc, 1);
    expect(a.quotaStatus).toBe("ok");
    const r: any = await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL });
    expect(r.accountId).toBe(1);
  });

  it("reason 含糊且账号额度已用尽(fraction=0)→ 仍判为额度耗尽(长冷却)", async () => {
    const svc = makeService([{
      id: 1, email: "a@x.com", refreshToken: "rt-1", enabled: true,
      modelQuotaFractions: { [MODEL]: 0 },
    }]);
    await leaseThenReport(svc, { status: 429, reason: "quota" });

    const a = acctStatus(svc, 1);
    expect(a.quotaStatus).toBe("exhausted");
    expect(a.blockedUntil - clock).toBe(FIVE_HOURS_MS);
  });

  it("额度耗尽的号 5h 内被冷却、到点后恢复(对比限速的零冷却)", async () => {
    const svc = makeService([{ id: 1, email: "a@x.com", refreshToken: "rt-1", enabled: true }]);
    await leaseThenReport(svc, { status: 429, reason: "http_429_resource_exhausted" });

    // 耗尽:5h 内被冷却,池子空 → leaseToken 抛错(无可用号)。
    await expect(svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL })).rejects.toThrow();

    // 5h+1s 后冷却已过 → 同一个号重新可租到。
    clock += FIVE_HOURS_MS + 1000;
    const r: any = await svc.leaseToken(REQ, { clientId: "c1", modelKey: MODEL });
    expect(r.accountId).toBe(1);
  });

  it("不 opt-in 零冷却的 provider(如 antigravity):限速类 429 仍照常冷却", async () => {
    // rateLimitZeroCooldown=false → 即便 reason 含糊 + 账号有余量(本会判限速),
    // 也不走零冷却,而是进冷却路径(antigravity 的 429 需要冷却)。
    const svc = makeService([{
      id: 1, email: "a@x.com", refreshToken: "rt-1", enabled: true,
      modelQuotaFractions: { [MODEL]: 0.5 }, // 有余量:opt-in 的 provider 会判限速→零冷却
    }], /* rateLimitZeroCooldown */ false);
    await leaseThenReport(svc, { status: 429, reason: "quota" });

    const a = acctStatus(svc, 1);
    expect(a.quotaStatus).not.toBe("ok"); // 被冷却,不是健康号
    expect(a.blockedUntil - clock).toBeGreaterThan(0); // 确实设了冷却
  });
});
