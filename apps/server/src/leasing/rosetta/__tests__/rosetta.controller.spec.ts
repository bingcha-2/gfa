import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { IS_PUBLIC_KEY } from "../../../shared/auth/public.decorator";
import { RosettaController } from "../rosetta.controller";

function makeController() {
  const rosetta = {
    createAccessKey: vi.fn(() => ({ ok: true })),
    updateAccessKey: vi.fn(() => ({ ok: true })),
    bindAccessKey: vi.fn(() => ({ ok: true, key: { id: "c1" } })),
    unbindAccessKey: vi.fn(() => ({ ok: true, key: { id: "c1" } })),
    setAccessKeyBindings: vi.fn(() => ({ ok: true })),
    deleteAccessKey: vi.fn(() => ({ ok: true })),
    cleanupExpiredKeys: vi.fn(async () => ({ ok: true })),
    cleanupUnboundKeys: vi.fn(async () => ({ ok: true })),
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

// 卡密弃用:后台「发卡/改卡/绑卡/解绑/设绑定/删卡/批量清理」一律停用(403 FEATURE_DISABLED),
// 不再委托给 service、不再 reload 任何池子。开通服务只剩账户下单订阅 / bind-card 转订阅两条路。
// 只读接口(GET access-keys 列表 / access-key-limits)不在此列,仍可用于后台查看。
describe("RosettaController — 卡密后台管理已停用", () => {
  const cases: Array<[string, (c: RosettaController) => unknown]> = [
    ["createAccessKey", (c) => c.createAccessKey()],
    ["updateAccessKey", (c) => c.updateAccessKey()],
    ["bindAccessKey", (c) => c.bindAccessKey()],
    ["unbindAccessKey", (c) => c.unbindAccessKey()],
    ["setAccessKeyBindings", (c) => c.setAccessKeyBindings()],
    ["deleteAccessKey", (c) => c.deleteAccessKey()],
    ["cleanupExpiredKeys", (c) => c.cleanupExpiredKeys()],
    ["cleanupUnboundKeys", (c) => c.cleanupUnboundKeys()],
  ];

  it.each(cases)("%s 抛 403 FEATURE_DISABLED,且不委托 service、不 reload 池子", (_name, call) => {
    const { controller, rosetta, tokenServer, remoteCodex, remoteAnthropic } = makeController();

    let thrown: any;
    try {
      call(controller);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(thrown.getResponse()).toMatchObject({ error: "FEATURE_DISABLED" });

    // 停用 = 彻底短路:不碰任何 service 方法,也不刷新任意池子。
    for (const fn of Object.values(rosetta)) expect(fn).not.toHaveBeenCalled();
    expect(tokenServer.reloadAccessKeys).not.toHaveBeenCalled();
    expect(remoteCodex.reloadAccessKeys).not.toHaveBeenCalled();
    expect(remoteAnthropic.reloadAccessKeys).not.toHaveBeenCalled();
  });
});

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
      };
      const controller = new RosettaController(rosetta, {} as any, {} as any, {} as any, {} as any);

      const res = await call(controller);

      expect(rosetta.occupiedSharesFromSubscriptions).toHaveBeenCalledWith(product);
      // 订阅占用口径覆盖文件值:号 1 → 5。
      expect(res.accounts.find((a: any) => a.id === 1).usedShares).toBe(5);
      // 无订阅占用的号归 0(覆盖掉残留的文件口径 99,而非保留)。
      expect(res.accounts.find((a: any) => a.id === 2).usedShares).toBe(0);
    },
  );
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

describe("RosettaController CLIProxy reconcile", () => {
  it("delegates reconcile requests to RosettaService", () => {
    const { controller, rosetta } = makeController();
    const body = { provider: "antigravity" };

    const result = controller.reconcileCliProxy(body);

    expect(rosetta.reconcileCliProxy).toHaveBeenCalledWith(body);
    expect(result).toEqual({ ok: true, uploaded: [1], unmanaged: [] });
  });
});
