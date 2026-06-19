import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 反重力【单账号】刷新额度(/api/rosetta/refresh-account-quota)。
// 旧 bug:只要 token 能刷出来,即使额度接口(fetchAvailableModels)失败返回 null,
// 也跳过更新却仍 return ok:true → 前端不管报不报错都弹"刷新成功"。
// 修复:额度接口拿不到数据时如实返回 ok:false(与批量刷新口径一致)。
vi.mock("../google-api", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  refreshAccessToken: vi.fn(),
  fetchAccountHealth: vi.fn(async () => ({
    planType: "pro",
    credits: { known: true, available: true, creditAmount: 1, minCreditAmount: 0, paidTierID: "" },
  })),
  fetchAvailableModels: vi.fn(),
  extractTierFromModelsJson: vi.fn(() => ""),
}));
vi.mock("../lib/project", () => ({ tryDiscoverProject: vi.fn() }));

import { AntigravityAccountService } from "../antigravity-account.service";
import { fetchAvailableModels } from "../google-api";
import { writeJson } from "../lib/store";

let dir: string;
let svc: AntigravityAccountService;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-refresh-"));
  const ctx: any = { dataDir: dir, tokenCache: new Map(), logger: { log: vi.fn(), warn: vi.fn() } };
  svc = new AntigravityAccountService(ctx, {} as any);
  // 账号已带 projectId(跳过 discovery),refreshToken 有效(getAccessToken mock 成功)。
  writeJson(path.join(dir, "accounts.json"), {
    accounts: [{ id: 1, email: "a@x.com", refreshToken: "rt", projectId: "p1", planType: "pro" }],
  });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("antigravity 单账号刷新额度对失败诚实上报", () => {
  it("额度接口失败(fetchAvailableModels=null)→ ok:false,不假报成功", async () => {
    vi.mocked(fetchAvailableModels).mockResolvedValue(null as any);
    const r: any = await svc.refreshAccountQuota({ accountId: 1 });
    expect(r.ok).toBe(false);
    expect(r.tokenValid).toBe(true); // token 有效,但额度没拉到
    expect(String(r.error)).toContain("额度接口");
  });

  it("额度接口成功 → ok:true,且写入 modelQuotaFractions", async () => {
    vi.mocked(fetchAvailableModels).mockResolvedValue({
      rawJson: "{}",
      models: { "gemini-2.5-pro": { remainingFraction: 0.7, resetTime: "" } },
    } as any);
    const r: any = await svc.refreshAccountQuota({ accountId: 1 });
    expect(r.ok).toBe(true);
    expect(r.modelQuotaFractions["gemini-2.5-pro"]).toBe(0.7);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "accounts.json"), "utf8"));
    expect(saved.accounts[0].modelQuotaFractions["gemini-2.5-pro"]).toBe(0.7);
  });

  it("无 refreshToken → ok:false", async () => {
    writeJson(path.join(dir, "accounts.json"), { accounts: [{ id: 2, email: "b@x.com" }] });
    const r: any = await svc.refreshAccountQuota({ accountId: 2 });
    expect(r.ok).toBe(false);
  });
});
