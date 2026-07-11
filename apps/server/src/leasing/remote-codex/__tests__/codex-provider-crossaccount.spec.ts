// 跨账号污染防护(系统性根因):客户端只有一份全局额度缓存,不认账号(codex_leaser.go:79
// globalCodexLeaser 单例)。服务端换号接力/改绑(lease-service.ts:534「账户级接力」)把一张卡从
// 母号 X 换到母号 10 时,客户端缓存里可能还是 X 探来的额度,却随本次上报带 accountId=10 发来。
// 客户端已把「额度探自哪个号」记在 accountQuota.accountId(codex_quota_sync.go:194)—— 服务端据此
// 拒掉:accountQuota.accountId ≠ 本号 id → 丢弃,绝不让别号额度污染本号。纯服务端,不用发客户端。
import { describe, expect, it } from "vitest";
import { CodexProvider } from "../codex.provider";

describe("CodexProvider.applyQuotaSnapshot 跨账号污染防护", () => {
  const p = new CodexProvider();
  const acc = (): any => ({
    id: 10, email: "a@b.c", refreshToken: "r", enabled: true,
    codexHourlyPercent: 50, codexWeeklyPercent: 80,
    codexHourlyResetTime: "2036-01-01T00:00:00Z", codexWeeklyResetTime: "2036-01-02T00:00:00Z",
    modelQuotaFractions: { codex: 0.5 },
  });

  it("额度探自另一个号(accountQuota.accountId≠本号)→ 拒绝,不覆盖真实值", () => {
    const account = acc();
    p.applyQuotaSnapshot(account, {
      accountId: 7, // 探自账号 7 的陈旧缓存(换号接力后)
      codexQuota: { hourlyPercent: 98, weeklyPercent: 100, hourlyResetTime: "2099-01-01T00:00:00Z", weeklyResetTime: "2099-01-02T00:00:00Z" },
    });
    // 账号 10 保持真实 50/80,不被账号 7 的 98/100 污染;reset 时间也不被换。
    expect(account.codexHourlyPercent).toBe(50);
    expect(account.codexWeeklyPercent).toBe(80);
    expect(account.codexHourlyResetTime).toBe("2036-01-01T00:00:00Z");
  });

  it("额度探自本号(accountId 一致)→ 正常应用", () => {
    const account = acc();
    p.applyQuotaSnapshot(account, {
      accountId: 10,
      codexQuota: { hourlyPercent: 30, weeklyPercent: 70 },
    });
    expect(account.codexHourlyPercent).toBe(30);
    expect(account.codexWeeklyPercent).toBe(70);
  });

  it("accountQuota 无 accountId(老格式/缺字段)→ 不拦,正常应用(向后兼容)", () => {
    const account = acc();
    p.applyQuotaSnapshot(account, { codexQuota: { hourlyPercent: 40, weeklyPercent: 60 } });
    expect(account.codexHourlyPercent).toBe(40);
    expect(account.codexWeeklyPercent).toBe(60);
  });
});
