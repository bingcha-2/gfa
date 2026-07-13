import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RosettaService } from "../rosetta.service";
import { refreshAccessToken } from "../google-api";
import { refreshCodexAccessToken } from "../../remote-codex/auth/codex-token-provider";
import { fetchCodexQuotaUpstream } from "../../remote-codex/auth/codex-usage";

// Probe / per-account refresh hit the network — mock the underlying token + quota
// fetchers so these tests stay offline and deterministic.
vi.mock("../google-api", async (orig) => ({
  ...(await (orig as any)()),
  refreshAccessToken: vi.fn(),
}));
vi.mock("../../remote-codex/auth/codex-token-provider", () => ({
  refreshCodexAccessToken: vi.fn(),
}));
vi.mock("../../remote-codex/auth/codex-usage", async (orig) => ({
  ...(await (orig as any)()),
  fetchCodexQuotaUpstream: vi.fn(),
}));

const readAccounts = (dir: string, file: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).accounts;

describe("RosettaService — 入库探活 + 单账号刷新", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfa-probe-"));
    vi.clearAllMocks();
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("codex 加号:token 有效 → enabled 保持 true, tokenValid:true", async () => {
    vi.mocked(refreshCodexAccessToken).mockResolvedValue("access-tok");
    const svc = new RosettaService({ dataDir: tempDir });

    const r: any = await svc.addCodexAccountChecked({ email: "ok@x.com", refreshToken: "rt" });

    expect(r).toMatchObject({ ok: true, tokenValid: true });
    expect(readAccounts(tempDir, "codex-accounts.json")[0]).toMatchObject({ email: "ok@x.com", enabled: true });
  });

  it("codex 加号:token 无效 → 仍入池但 enabled=false + warning", async () => {
    vi.mocked(refreshCodexAccessToken).mockRejectedValue(new Error("401 invalid_grant"));
    const svc = new RosettaService({ dataDir: tempDir });

    const r: any = await svc.addCodexAccountChecked({ email: "dead@x.com", refreshToken: "bad" });

    expect(r).toMatchObject({ ok: true, tokenValid: false });
    expect(r.warning).toContain("token 验证失败");
    const acc = readAccounts(tempDir, "codex-accounts.json")[0];
    expect(acc).toMatchObject({ email: "dead@x.com", enabled: false }); // 死号不以启用态进池
  });

  it("antigravity 加号:token 无效 → enabled=false", async () => {
    vi.mocked(refreshAccessToken).mockRejectedValue(new Error("invalid_grant"));
    const svc = new RosettaService({ dataDir: tempDir });

    const r: any = await svc.addAccountChecked({ email: "dead@g.com", refreshToken: "bad" });

    expect(r).toMatchObject({ ok: true, tokenValid: false });
    expect(readAccounts(tempDir, "accounts.json")[0]).toMatchObject({ enabled: false });
  });

  it("codex 刷新(token + 额度合一):刷 token 回写 + 落盘 5h/周余量 + binding fraction", async () => {
    vi.mocked(refreshCodexAccessToken).mockImplementation(async (acc: any) => {
      acc.accessTokenExpiresAt = 1_900_000_000_000;
      acc.refreshToken = "rotated-rt";
      return "new-access";
    });
    vi.mocked(fetchCodexQuotaUpstream).mockResolvedValue({
      planType: "plus",
      codexQuota: { hourlyPercent: 80, weeklyPercent: 30, hourlyResetTime: "", weeklyResetTime: "2026-01-01T00:00:00Z" },
    });
    const svc = new RosettaService({ dataDir: tempDir });
    svc.addCodexAccount({ email: "q@x.com", refreshToken: "old-rt" });
    const id = readAccounts(tempDir, "codex-accounts.json")[0].id;

    const r: any = await svc.refreshCodexAccountQuota({ accountId: id });

    expect(r).toMatchObject({ ok: true, tokenValid: true, hourlyPercent: 80, weeklyPercent: 30, planType: "plus" });
    const acc = readAccounts(tempDir, "codex-accounts.json")[0];
    expect(acc.accessToken).toBe("new-access"); // token 同时被刷新回写
    expect(acc.refreshToken).toBe("rotated-rt");
    expect(acc.codexHourlyPercent).toBe(80);
    expect(acc.codexWeeklyPercent).toBe(30);
    // weekly(30) < hourly(80) → binding fraction = 0.30
    expect(acc.modelQuotaFractions.codex).toBeCloseTo(0.3);
  });

  it("codex 刷新:token 刷成功但额度接口失败 → 仍 ok(tokenValid) + quotaError", async () => {
    vi.mocked(refreshCodexAccessToken).mockResolvedValue("access-tok");
    vi.mocked(fetchCodexQuotaUpstream).mockResolvedValue(null);
    const svc = new RosettaService({ dataDir: tempDir });
    svc.addCodexAccount({ email: "q2@x.com", refreshToken: "rt" });
    const id = readAccounts(tempDir, "codex-accounts.json")[0].id;

    const r: any = await svc.refreshCodexAccountQuota({ accountId: id });

    expect(r).toMatchObject({ ok: true, tokenValid: true });
    expect(r.quotaError).toContain("上游额度获取失败");
  });

  it("codex 刷新:上游缺 weekly 窗口(报 -1)→ 不覆盖已存真实 weekly,保留旧值", async () => {
    vi.mocked(refreshCodexAccessToken).mockResolvedValue("access-tok");
    const svc = new RosettaService({ dataDir: tempDir });
    svc.addCodexAccount({ email: "q3@x.com", refreshToken: "rt" });
    const id = readAccounts(tempDir, "codex-accounts.json")[0].id;

    // 1) 先一次完整真实值,落盘 weekly=67。
    vi.mocked(fetchCodexQuotaUpstream).mockResolvedValueOnce({
      planType: "plus",
      codexQuota: { hourlyPercent: 96, weeklyPercent: 67, hourlyResetTime: "", weeklyResetTime: "2099-01-01T00:00:00Z" },
    });
    await svc.refreshCodexAccountQuota({ accountId: id });
    expect(readAccounts(tempDir, "codex-accounts.json")[0].codexWeeklyPercent).toBe(67);

    // 2) 再一次:上游缺 weekly(报 -1),5h 更新到 90 —— weekly 必须保留 67,不被 -1/伪造100 覆盖。
    vi.mocked(fetchCodexQuotaUpstream).mockResolvedValueOnce({
      planType: "plus",
      codexQuota: { hourlyPercent: 90, weeklyPercent: -1, hourlyResetTime: "", weeklyResetTime: "" },
    });
    const r: any = await svc.refreshCodexAccountQuota({ accountId: id });
    const acc = readAccounts(tempDir, "codex-accounts.json")[0];
    expect(acc.codexHourlyPercent).toBe(90); // 5h 更新
    expect(acc.codexWeeklyPercent).toBe(67); // weekly 保留真实值,未被 -1 覆盖
    expect(r.weeklyPercent).toBe(67); // 回带的也是保留值
  });

  it("codex 刷新:旧绑定窗口已 absent 且当前窗口未知时清除陈旧 binding", async () => {
    vi.mocked(refreshCodexAccessToken).mockResolvedValue("access-tok");
    const svc = new RosettaService({ dataDir: tempDir });
    svc.addCodexAccount({ email: "weekly-only@x.com", refreshToken: "rt" });
    const seeded = readAccounts(tempDir, "codex-accounts.json")[0];
    const file = path.join(tempDir, "codex-accounts.json");
    fs.writeFileSync(file, JSON.stringify({ accounts: [{
      ...seeded,
      codexHourlyPercent: 10,
      codexHourlyResetTime: "2099-01-01T00:00:00Z",
      modelQuotaFractions: { codex: 0.1 },
      modelQuotaResetTimes: { codex: "2099-01-01T00:00:00Z" },
    }] }));
    vi.mocked(fetchCodexQuotaUpstream).mockResolvedValue({
      planType: "plus",
      codexQuota: {
        hourlyPercent: -1,
        weeklyPercent: -1,
        hourlyPresent: false,
        weeklyPresent: true,
      },
    });

    await svc.refreshCodexAccountQuota({ accountId: seeded.id });

    const acc = readAccounts(tempDir, "codex-accounts.json")[0];
    expect(acc).not.toHaveProperty("codexHourlyPercent");
    expect(acc.modelQuotaFractions).not.toHaveProperty("codex");
    expect(acc.modelQuotaResetTimes).not.toHaveProperty("codex");
  });

  it("codex 刷新:同一耗尽 binding 临时缺 reset 时保留真实恢复时间", async () => {
    vi.mocked(refreshCodexAccessToken).mockResolvedValue("access-tok");
    const svc = new RosettaService({ dataDir: tempDir });
    svc.addCodexAccount({ email: "exhausted@x.com", refreshToken: "rt" });
    const id = readAccounts(tempDir, "codex-accounts.json")[0].id;

    vi.mocked(fetchCodexQuotaUpstream).mockResolvedValueOnce({
      planType: "plus",
      codexQuota: {
        hourlyPercent: 0, weeklyPercent: 80,
        hourlyPresent: true, weeklyPresent: true,
        hourlyResetTime: "2099-06-10T05:00:00Z",
      },
    });
    await svc.refreshCodexAccountQuota({ accountId: id });
    expect(readAccounts(tempDir, "codex-accounts.json")[0].modelQuotaResetTimes.codex).toBe("2099-06-10T05:00:00Z");

    vi.mocked(fetchCodexQuotaUpstream).mockResolvedValueOnce({
      planType: "plus",
      codexQuota: {
        hourlyPercent: 0, weeklyPercent: 80,
        hourlyPresent: true, weeklyPresent: true,
      },
    });
    await svc.refreshCodexAccountQuota({ accountId: id });

    const acc = readAccounts(tempDir, "codex-accounts.json")[0];
    expect(acc.modelQuotaFractions.codex).toBe(0);
    expect(acc.modelQuotaResetTimes.codex).toBe("2099-06-10T05:00:00Z");
  });
});
