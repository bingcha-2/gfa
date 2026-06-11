import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ════════════════════════════════════════════════════════════════════════════
// 复现问题 1：后台刷新额度 —— 死号(拿不到 projectId / 额度接口失败)仍提示"刷新成功"
//
// refreshQuota 是后台"全量刷新额度"。它的返回里 ok 永远是 true，且把
// "拿不到 projectId 的死号"在 ready 过滤时直接剔除(credits-quota.service.ts:109)，
// 既不计入 refreshed 也不计入 errors，total 也用剔除后的数 —— 死号彻底隐形。
// 前端/运维看到的是 ok:true，根本不知道有号死了。
// ════════════════════════════════════════════════════════════════════════════

vi.mock("../google-api", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  fetchAccountHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  extractTierFromModelsJson: vi.fn(() => ""),
  discoverProject: vi.fn(),
}));

import { CreditsQuotaService } from "../credits-quota.service";
import { discoverProject, fetchAccountHealth, fetchAvailableModels } from "../google-api";
import { writeJson } from "../lib/store";

let dir: string;
let ctx: any;
let svc: CreditsQuotaService;

const health = (planType = "pro") => ({
  credits: { known: true, available: true, creditAmount: 100, minCreditAmount: 0, paidTierID: "tier-x" },
  planType,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-refresh-"));
  ctx = { dataDir: dir, logger: { log: vi.fn(), warn: vi.fn() }, tokenCache: new Map() };
  svc = new CreditsQuotaService(ctx);
  vi.clearAllMocks();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const writeAccounts = (accounts: any[]) => writeJson(path.join(dir, "accounts.json"), { accounts });

describe("问题#1 后台刷新额度对死号诚实上报(修复后)", () => {
  it("死号(拿不到 projectId)被计入失败并列出,不再隐形", async () => {
    // 一个健康号 + 一个死号(没有 projectId，discovery 也发现不出来)
    writeAccounts([
      { id: 1, email: "alive@x.com", refreshToken: "rt", projectId: "p1", planType: "pro" },
      { id: 2, email: "dead@x.com", refreshToken: "rt" }, // 没有 projectId —— 这就是"已死的号"
    ]);
    vi.mocked(fetchAccountHealth).mockResolvedValue(health("pro") as any);
    vi.mocked(fetchAvailableModels).mockResolvedValue({
      rawJson: {},
      models: { "gemini-2.5-pro": { remainingFraction: 0.5, resetTime: "" } },
    } as any);
    // 死号的 projectId 发现失败(返回空)
    vi.mocked(discoverProject).mockResolvedValue({} as any);

    const r: any = await svc.refreshQuota();

    // 修复后:有死号 → ok:false;总数含死号;死号计入 errors 并出现在清单里
    expect(r.ok).toBe(false);
    expect(r.total).toBe(2); // 两个号都被统计(之前是 1)
    expect(r.refreshed).toBe(1);
    expect(r.errors).toBe(1); // 死号计入失败(之前是 0)
    const deadResult = r.accounts.find((x: any) => x.id === 2);
    expect(deadResult).toMatchObject({ id: 2, error: "no projectId" });

    console.log(`[修复#1] 2 个号(1 死 1 活)→ ${JSON.stringify(r)}：死号 #2 现身于 errors + 清单`);
  });

  it("有 projectId 但额度接口失败的号 → 计入失败、ok:false", async () => {
    writeAccounts([{ id: 1, email: "a@x.com", refreshToken: "rt", projectId: "p1" }]);
    vi.mocked(fetchAccountHealth).mockResolvedValue(health("pro") as any);
    vi.mocked(fetchAvailableModels).mockResolvedValue(null as any); // 额度接口拿不到数据

    const r: any = await svc.refreshQuota();

    expect(r).toMatchObject({ ok: false, refreshed: 0, errors: 1, total: 1 });
    expect(r.accounts[0]).toMatchObject({ id: 1, error: "quota fetch failed" });
    console.log(`[修复#1] 额度接口失败 → ${JSON.stringify(r)}：ok:false + 列出原因`);
  });

  it("全部号都死 → ok:false", async () => {
    writeAccounts([
      { id: 1, email: "a@x.com", refreshToken: "rt", projectId: "p1" },
      { id: 2, email: "b@x.com", refreshToken: "rt", projectId: "p2" },
    ]);
    vi.mocked(fetchAccountHealth).mockResolvedValue(health("pro") as any);
    vi.mocked(fetchAvailableModels).mockResolvedValue(null as any); // 两个号额度都失败

    const r: any = await svc.refreshQuota();

    expect(r.ok).toBe(false);
    expect(r.errors).toBe(2);
    expect(r.total).toBe(2);
    console.log(`[修复#1] 全部号失败 → ${JSON.stringify(r)}：ok:false`);
  });

  it("全部健康 → ok:true(不误报失败)", async () => {
    writeAccounts([{ id: 1, email: "a@x.com", refreshToken: "rt", projectId: "p1", planType: "pro" }]);
    vi.mocked(fetchAccountHealth).mockResolvedValue(health("pro") as any);
    vi.mocked(fetchAvailableModels).mockResolvedValue({
      rawJson: {}, models: { "gemini-2.5-pro": { remainingFraction: 0.9, resetTime: "" } },
    } as any);

    const r: any = await svc.refreshQuota();
    expect(r).toMatchObject({ ok: true, refreshed: 1, errors: 0, total: 1 });
  });
});
