import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

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
