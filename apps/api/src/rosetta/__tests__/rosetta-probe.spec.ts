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
vi.mock("../../remote-codex/auth/codex-usage", () => ({
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
});
