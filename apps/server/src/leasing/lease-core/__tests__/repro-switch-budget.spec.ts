import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeaseService } from "../lease-service";
import type { Provider } from "../provider";

// ════════════════════════════════════════════════════════════════════════════
// 复现问题 2：换号逻辑 —— 死号没被及时排除，把换号预算快速耗尽
//
// 换号预算是【每请求】的：maxAttempts = min(30, max(5, 候选池大小))
// (lease-service.ts:464)。每个死号失败一次就吃掉一个 attempt。
//
// 关键缺口：
//  - 非永久错误(网络/5xx 等)要连续失败 REMOTE_ACCOUNT_ERROR_THRESHOLD(=3) 次
//    才标死(lease-service.ts:1284)。判死前每个请求都会重新选中它、再吃一次预算。
//  - "假活"死号:token 刷新成功、但真实生成时已死 → 服务端按 token 刷新判健康，
//    永远标不了死，每个请求都把它当好号选中。(这正是问题 1 让它隐形的后果)
// ════════════════════════════════════════════════════════════════════════════

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeProvider(
  accountsFilePath: string,
  refreshTokenImpl: (account: any) => Promise<string>,
): Provider<any> {
  return {
    id: "fake",
    accountsFilePath,
    refreshToken: vi.fn(refreshTokenImpl),
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

let tempDir: string;
let accountsFilePath: string;
let accessKeysFilePath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-switch-"));
  accountsFilePath = path.join(tempDir, "codex-accounts.json");
  accessKeysFilePath = path.join(tempDir, "access-keys.json");
  writeJson(accessKeysFilePath, {
    keys: [{ id: "card-1", key: "secret-card", status: "active", durationMs: 60 * 60 * 1000, windowLimit: 100000 }],
  });
});
afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe("复现#2 换号预算被死号耗尽", () => {
  it("一个请求里,5 个死号各吃一次换号预算 → 整次请求失败", async () => {
    // 5 个死号:token 刷新都失败(非永久错误,不会被立即标死)
    writeJson(accountsFilePath, {
      accounts: Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        email: `dead${i + 1}@x.com`,
        refreshToken: `rt-${i + 1}`,
        enabled: true,
      })),
    });
    const refresh = vi.fn(async () => {
      throw new Error("503 upstream temporarily unavailable"); // 瞬时错误,非 invalid_grant
    });
    const service = new LeaseService(makeProvider(accountsFilePath, refresh), {
      accessKeysFilePath,
      minClientVersion: "",
    });
    // 把 provider 上被 vi.fn 包裹的 refreshToken 也指过来统计调用次数
    (service as any).provider.refreshToken = refresh;

    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toBeTruthy();

    // maxAttempts = min(30, max(5, 5)) = 5 → 5 个死号每个被试一次,预算一次性烧光
    expect(refresh).toHaveBeenCalledTimes(5);
    console.log(`[复现#2] 单请求换号 ${refresh.mock.calls.length} 次(5 个死号各 1 次)→ 预算耗尽、请求失败`);
  });

  it("非永久错误的死号要 3 个请求才标死 → 期间每个请求都重新烧预算", async () => {
    writeJson(accountsFilePath, {
      accounts: [{ id: 1, email: "dead@x.com", refreshToken: "rt-1", enabled: true }],
    });
    const refresh = vi.fn(async () => {
      throw new Error("500 internal error"); // 非永久错误
    });
    const service = new LeaseService(makeProvider(accountsFilePath, refresh), {
      accessKeysFilePath,
      minClientVersion: "",
    });
    (service as any).provider.refreshToken = refresh;

    // 连发 4 个请求
    for (let i = 0; i < 4; i++) {
      await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }).catch(() => {});
    }

    // 前 3 个请求各试 1 次(strike 1→2→3,第 3 次后才标死);第 4 个请求才因已标死而不再试。
    // 即:死号在被判死前白白烧掉了 3 个请求的换号机会。
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(3);
    console.log(`[复现#2] 非永久错误死号:4 个请求共试 ${refresh.mock.calls.length} 次后才停(判死滞后 3 拍)`);
  });

  // —— 修复后:永久死亡(403 service_disabled)不再每 60s 复活。——
  // 详细的分档/升级回归在 repro-permanent-death-misclass.spec.ts;这里只锁住
  // "不再 60s 复活"这一条,防止 FORBIDDEN_COOLDOWN_MS 短冷却又把它放回轮换。
  it("生成 403 service_disabled 的死号:冷却 >60s(不再每 60s 烧换号位)", async () => {
    writeJson(accountsFilePath, {
      accounts: [{ id: 1, email: "dead-project@x.com", refreshToken: "rt-1", enabled: true }],
    });
    const refresh = vi.fn(async () => "access-token-ok"); // token 刷新成功(死在生成阶段)
    let clock = 1_000_000;
    const service = new LeaseService(makeProvider(accountsFilePath, refresh), {
      accessKeysFilePath,
      minClientVersion: "",
      now: () => clock,
    });
    (service as any).provider.refreshToken = refresh;

    const l1: any = await service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" });
    expect(l1.accountId).toBe(1);
    await service.reportResult(REQ, {
      leaseId: l1.leaseId, status: 403, reason: "http_403_service_disabled", modelKey: "gpt-5-codex",
    });

    // 立刻再租 → 被冷却
    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toBeTruthy();

    // 推进 61s(旧实现此刻会复活)→ 修复后仍在冷却(首档 5min)。
    clock += 61 * 1000;
    await expect(
      service.leaseToken(REQ, { clientId: "c1", modelKey: "gpt-5-codex" }),
    ).rejects.toBeTruthy();
    console.log("[修复] 403 service_disabled:61s 后仍被冷却,不再每 60s 回到轮换");
  });
});
