import { describe, expect, it, vi } from "vitest";

import { IS_PUBLIC_KEY } from "../../../shared/auth/public.decorator";
import { RosettaController } from "../rosetta.controller";

function makeController() {
  const rosetta = {
    handleCliProxyReport: vi.fn(() => ({ ok: true, action: "auth_dead" })),
    reconcileCliProxy: vi.fn(() => ({ ok: true, uploaded: [1], unmanaged: [] })),
  };
  const tokenServer = { reloadAccessKeys: vi.fn() };
  const remoteCodex = { reloadAccessKeys: vi.fn() };
  const remoteAnthropic = { reloadAccessKeys: vi.fn() };
  const controller = new RosettaController(
    rosetta as any,
    {} as any, // tokenUsageStats
    tokenServer as any,
    remoteCodex as any,
    remoteAnthropic as any,
  );
  return { controller, rosetta, tokenServer, remoteCodex, remoteAnthropic };
}

// 卡密后台管理(发卡/改卡/绑卡/删卡/批量清理 + access-keys 列表 / 限额查询)已随激活码改造
// 整体删除:开通服务只剩账户下单订阅 / 激活码兑换两条路,控制器不再暴露任何卡密端点。

// 后台账号列表的「份额用量」(usedShares)必须按 DB 订阅占用(座位真相源)显示,
// 而非底层 list 算出的文件卡口径(access-keys.json 已退役)。否则:订阅绑定到某号、
// 占了座位后,后台仍显示 0/N。三个 provider 的列表都经 overlaySubscriptionShares 覆盖。
describe("RosettaController — 账号列表 usedShares 改用 DB 订阅口径", () => {
  const handlers: Array<[string, (c: RosettaController) => Promise<any>, string, string]> = [
    ["accounts", (c) => c.listAccounts(), "antigravity", "listAccounts"],
    ["codex-accounts", (c) => c.listCodexAccounts(), "codex", "listCodexAccounts"],
    ["anthropic-accounts", (c) => c.listClaudeAccounts(), "anthropic", "listClaudeAccounts"],
  ];

  it.each(handlers)(
    "GET %s:用订阅占用覆盖文件口径 usedShares,并按 product 查询份额",
    async (_route, call, product, listFn) => {
      const rosetta: any = {
        // 底层 list 仍返回文件口径:号 1 = 0(订阅不写文件)、号 2 = 99(残留卡数)。
        [listFn]: vi.fn(() => ({
          ok: true,
          accounts: [
            { id: 1, usedShares: 0 },
            { id: 2, usedShares: 99 },
          ],
          dataDir: "/tmp",
        })),
        // DB 座位真相源:号 1 被订阅占了 5 份,号 2 无订阅占用。
        occupiedSharesFromSubscriptions: vi.fn(async () => new Map<number, number>([[1, 5]])),
        quotaPoolSummaries: vi.fn(async () => new Map<number, any>(product === "antigravity" ? [] : [[1, { accountId: 1, provider: product }]])),
      };
      const controller = new RosettaController(rosetta, {} as any, {} as any, {} as any, {} as any);

      const res = await call(controller);

      expect(rosetta.occupiedSharesFromSubscriptions).toHaveBeenCalledWith(product);
      if (product !== "antigravity") expect(rosetta.quotaPoolSummaries).toHaveBeenCalledWith(product);
      // 订阅占用口径覆盖文件值:号 1 → 5。
      expect(res.accounts.find((a: any) => a.id === 1).usedShares).toBe(5);
      // 无订阅占用的号归 0(覆盖掉残留的文件口径 99,而非保留)。
      expect(res.accounts.find((a: any) => a.id === 2).usedShares).toBe(0);
      if (product !== "antigravity") expect(res.accounts.find((a: any) => a.id === 1).quotaPool).toEqual({ accountId: 1, provider: product });
    },
  );
});

describe("RosettaController — 母号关联订阅(点 email)", () => {
  it("按 accountId 转数字后委托给 RosettaService", async () => {
    const rosetta: any = {
      listClaudeAccountSubscriptions: vi.fn(async () => ({ ok: true, accountId: 7, subscriptions: [] })),
    };
    const controller = new RosettaController(rosetta, {} as any, {} as any, {} as any, {} as any);

    const res = await controller.listClaudeAccountSubscriptions("7");

    expect(rosetta.listClaudeAccountSubscriptions).toHaveBeenCalledWith(7);
    expect(res).toEqual({ ok: true, accountId: 7, subscriptions: [] });
  });
});

describe("RosettaController — 母号额度池", () => {
  it("支持全局列表和单母号明细查询", async () => {
    const rosetta: any = {
      listQuotaPools: vi.fn(async () => ({ ok: true, pools: [] })),
      getQuotaPool: vi.fn(async () => ({ ok: true, pool: { accountId: 7 } })),
    };
    const controller = new RosettaController(rosetta, {} as any, {} as any, {} as any, {} as any);

    await expect(controller.listQuotaPools("anthropic")).resolves.toEqual({ ok: true, pools: [] });
    await expect(controller.getQuotaPool("anthropic", "7")).resolves.toEqual({ ok: true, pool: { accountId: 7 } });
    expect(rosetta.listQuotaPools).toHaveBeenCalledWith("anthropic");
    expect(rosetta.getQuotaPool).toHaveBeenCalledWith("anthropic", 7);
  });
});

describe("RosettaController CLIProxy report", () => {
  it("is public so the shared-secret check runs before admin JWT auth", () => {
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, RosettaController.prototype.reportCliProxyFailure);

    expect(isPublic).toBe(true);
  });

  it("rejects reports with an invalid shared secret", () => {
    process.env.CLIPROXY_REPORT_SECRET = "report-secret";
    const { controller } = makeController();

    expect(() => controller.reportCliProxyFailure("bad-secret", { accountId: 1 })).toThrow("Invalid CLIProxy report secret");

    delete process.env.CLIPROXY_REPORT_SECRET;
  });

  it("passes valid reports to RosettaService with the token server", () => {
    process.env.CLIPROXY_REPORT_SECRET = "report-secret";
    const { controller, rosetta, tokenServer } = makeController();
    const body = { gfaAccountId: 1, status: 400, reason: "invalid_grant" };

    const result = controller.reportCliProxyFailure("report-secret", body);

    expect(rosetta.handleCliProxyReport).toHaveBeenCalledWith(body, tokenServer);
    expect(result).toEqual({ ok: true, action: "auth_dead" });
    delete process.env.CLIPROXY_REPORT_SECRET;
  });
});

describe("RosettaController Codex quota refresh", () => {
  it("reactivates an auth-dead Codex account after a successful token refresh", async () => {
    const rosetta: any = {
      refreshCodexAccountQuota: vi.fn(async () => ({ ok: true, accountId: 8, tokenValid: true })),
    };
    const remoteCodex: any = {
      reactivateIfAuthDead: vi.fn(() => ({ ok: true, reactivated: true })),
    };
    const controller = new RosettaController(rosetta, {} as any, {} as any, remoteCodex, {} as any);

    const result = await controller.refreshCodexAccountQuota({ accountId: 8 });

    expect(remoteCodex.reactivateIfAuthDead).toHaveBeenCalledWith(8);
    expect(result).toEqual({ ok: true, accountId: 8, tokenValid: true, reactivated: true });
  });
});

describe("RosettaController Anthropic quota refresh", () => {
  it("propagates trusted rollover evidence to bound subscriptions and persists the new windows", async () => {
    const rosetta: any = {
      refreshClaudeAccountQuota: vi.fn(async () => ({
        ok: true,
        hourlyPercent: 90,
        weeklyPercent: 98,
        previousHourlyResetTime: "2026-07-16T07:00:00.000Z",
        previousWeeklyResetTime: "2026-07-16T07:00:00.000Z",
        quotaObservedAt: 1_784_185_983_688,
      })),
    };
    const tokenServer: any = { persistSubscriptionWindowsFor: vi.fn(async () => undefined) };
    const rollback = vi.fn();
    const remoteAnthropic: any = {
      syncPersistedAccountQuotaSnapshot: vi.fn(() => ({
        subscriptionsTouched: 1,
        subscriptionIds: ['sub-1'],
        rollback,
      })),
      reactivateIfAuthDead: vi.fn(() => ({ ok: true, reactivated: false })),
    };
    const controller = new RosettaController(
      rosetta,
      {} as any,
      tokenServer,
      {} as any,
      remoteAnthropic,
    );

    const result = await controller.refreshClaudeAccountQuota({ accountId: 21 });

    expect(remoteAnthropic.syncPersistedAccountQuotaSnapshot).toHaveBeenCalledWith(21, {
      previousHourlyResetAt: "2026-07-16T07:00:00.000Z",
      previousWeeklyResetAt: "2026-07-16T07:00:00.000Z",
      observedAt: 1_784_185_983_688,
      snapshotId: "console-refresh:anthropic:21:1784185983688",
    });
    expect(tokenServer.persistSubscriptionWindowsFor).toHaveBeenCalledWith(['sub-1']);
    expect(rollback).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, quotaSyncedSubscriptions: 1, reactivated: false });
  });

  it("rolls back live subscription windows when targeted persistence fails", async () => {
    const rosetta: any = {
      refreshClaudeAccountQuota: vi.fn(async () => ({ ok: true, weeklyPercent: 98 })),
    };
    const persistError = new Error("db unavailable");
    const tokenServer: any = {
      persistSubscriptionWindowsFor: vi.fn(async () => { throw persistError; }),
    };
    const rollback = vi.fn();
    const remoteAnthropic: any = {
      syncPersistedAccountQuotaSnapshot: vi.fn(() => ({
        subscriptionsTouched: 1,
        subscriptionIds: ['sub-1'],
        rollback,
      })),
      reactivateIfAuthDead: vi.fn(),
    };
    const controller = new RosettaController(
      rosetta,
      {} as any,
      tokenServer,
      {} as any,
      remoteAnthropic,
    );

    await expect(controller.refreshClaudeAccountQuota({ accountId: 21 })).rejects.toBe(persistError);
    expect(rollback).toHaveBeenCalledOnce();
    expect(remoteAnthropic.reactivateIfAuthDead).not.toHaveBeenCalled();
  });
});

describe("RosettaController Claude verification code", () => {
  it("delegates verification-code requests to RosettaService", async () => {
    const rosetta: any = {
      fetchClaudeVerificationCode: vi.fn(async () => ({ ok: true, code: "123456" })),
    };
    const controller = new RosettaController(rosetta, {} as any, {} as any, {} as any, {} as any);
    const body = {
      email: "mail-user@example.com",
      password: "pw",
      adspowerProfileId: "k1e8c364",
    };

    await expect(controller.fetchClaudeVerificationCode(body)).resolves.toEqual({ ok: true, code: "123456" });
    expect(rosetta.fetchClaudeVerificationCode).toHaveBeenCalledWith(body);
  });
});

describe("RosettaController CLIProxy reconcile", () => {
  it("delegates reconcile requests to RosettaService", () => {
    const { controller, rosetta } = makeController();
    const body = { provider: "antigravity" };

    const result = controller.reconcileCliProxy(body);

    expect(rosetta.reconcileCliProxy).toHaveBeenCalledWith(body);
    expect(result).toEqual({ ok: true, uploaded: [1], unmanaged: [] });
  });
});
