import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RosettaService } from "../rosetta.service";

// 母号 → 绑定订阅(点 email 看关联订单/账户)。口径:只数 config.line=bind 且
// bindings.anthropic 命中的 ACTIVE 订阅,带出客户 email + 下单 PlanOrder。

function makeService(prisma: any) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-subs-"));
  // ctor: (options, automation?, agentAccounts?, injectedAccessKeyStore?, prisma?)
  const svc = new RosettaService({ dataDir }, undefined, undefined, undefined, prisma);
  return { svc, dataDir };
}

describe("RosettaService.listClaudeAccountSubscriptions", () => {
  let cleanup: string[] = [];
  beforeEach(() => { cleanup = []; });
  afterEach(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("无 prisma 时返回空列表(不抛)", async () => {
    const { svc, dataDir } = makeService(undefined);
    cleanup.push(dataDir);
    const res = await svc.listClaudeAccountSubscriptions(7);
    expect(res).toEqual({ ok: true, accountId: 7, subscriptions: [] });
  });

  it("非法 accountId 返回空列表", async () => {
    const findMany = vi.fn();
    const { svc, dataDir } = makeService({ subscription: { findMany }, planOrder: { findMany: vi.fn() } });
    cleanup.push(dataDir);
    const res = await svc.listClaudeAccountSubscriptions(0);
    expect(res.subscriptions).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("只返回绑到该母号的 bind 订阅,带出客户 + 订单,过滤别的号/号池", async () => {
    const rows = [
      {
        id: "sub-hit",
        status: "ACTIVE",
        startsAt: new Date("2026-06-01T00:00:00.000Z"),
        expiresAt: new Date("2026-07-01T00:00:00.000Z"),
        activatedFromOrderId: "order-1",
        config: JSON.stringify({ line: "bind", bindings: { anthropic: 7 }, weight: 2, exclusive: true }),
        customer: { id: "cus-1", email: "buyer@example.com", displayName: "Buyer" },
      },
      {
        // 绑到别的号 → 过滤
        id: "sub-other-account",
        status: "ACTIVE",
        startsAt: null,
        expiresAt: null,
        activatedFromOrderId: null,
        config: JSON.stringify({ line: "bind", bindings: { anthropic: 5 } }),
        customer: { id: "cus-2", email: "other@example.com", displayName: null },
      },
      {
        // 号池(即便误带 bindings)→ 过滤
        id: "sub-pool",
        status: "ACTIVE",
        startsAt: null,
        expiresAt: null,
        activatedFromOrderId: null,
        config: JSON.stringify({ line: "pool", bindings: { anthropic: 7 } }),
        customer: { id: "cus-3", email: "pool@example.com", displayName: null },
      },
    ];
    const subFindMany = vi.fn(async () => rows);
    const orderFindMany = vi.fn(async () => [
      { id: "order-1", outTradeNo: "OT-1", amountCents: 9900, payChannel: "ALIPAY", status: "PAID", paidAt: new Date("2026-06-01T00:00:00.000Z") },
    ]);
    const { svc, dataDir } = makeService({
      subscription: { findMany: subFindMany },
      planOrder: { findMany: orderFindMany },
    });
    cleanup.push(dataDir);

    const res = await svc.listClaudeAccountSubscriptions(7);

    expect(subFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "ACTIVE" } }));
    expect(res.subscriptions).toHaveLength(1);
    const s = res.subscriptions[0];
    expect(s.id).toBe("sub-hit");
    expect(s.customerEmail).toBe("buyer@example.com");
    expect(s.customerName).toBe("Buyer");
    expect(s.exclusive).toBe(true);
    expect(s.weight).toBe(2);
    expect(s.expiresAt).toBe("2026-07-01T00:00:00.000Z");
    expect(s.order).toEqual({
      id: "order-1",
      outTradeNo: "OT-1",
      amountCents: 9900,
      payChannel: "ALIPAY",
      status: "PAID",
      paidAt: "2026-06-01T00:00:00.000Z",
    });
    // 只为命中的订阅查了一次订单
    expect(orderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["order-1"] } } }),
    );
  });

  it("无绑定命中时不查 PlanOrder", async () => {
    const subFindMany = vi.fn(async () => []);
    const orderFindMany = vi.fn(async () => []);
    const { svc, dataDir } = makeService({
      subscription: { findMany: subFindMany },
      planOrder: { findMany: orderFindMany },
    });
    cleanup.push(dataDir);
    const res = await svc.listClaudeAccountSubscriptions(7);
    expect(res.subscriptions).toEqual([]);
    expect(orderFindMany).not.toHaveBeenCalled();
  });
});

describe("RosettaService.getQuotaPool", () => {
  let cleanup: string[] = [];
  beforeEach(() => { cleanup = []; });
  afterEach(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("汇总母号窗口与绑定订阅，返回整池推算、剩余额度和订单明细", async () => {
    const row = {
      id: "sub-1",
      status: "ACTIVE",
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      activatedFromOrderId: "order-1",
      config: JSON.stringify({
        line: "bind",
        bindings: { anthropic: 7 },
        weight: 2,
        usdQuotaByProduct: { anthropic: { fiveHour: 20, weekly: 100 } },
      }),
      windowState: {
        usdUsageByProduct: {
          anthropic: { used5h: 8, usedWeekly: 30, upstreamAccountId: 7 },
        },
      },
      customer: { id: "cus-1", email: "buyer@example.com", displayName: "Buyer" },
    };
    const prisma = {
      subscription: { findMany: vi.fn(async () => [row]) },
      planOrder: { findMany: vi.fn(async () => [{
        id: "order-1",
        outTradeNo: "OT-1",
        amountCents: 9900,
        payChannel: "ALIPAY",
        status: "PAID",
        paidAt: new Date("2026-07-01T00:00:00.000Z"),
      }]) },
    };
    const { svc, dataDir } = makeService(prisma);
    cleanup.push(dataDir);
    fs.writeFileSync(path.join(dataDir, "anthropic-accounts.json"), JSON.stringify({ accounts: [{
      id: 7,
      email: "mother@example.com",
      planType: "max",
      claudeHourlyPercent: 60,
      claudeWeeklyPercent: 70,
      modelQuotaRefreshedAt: Date.now(),
    }] }));

    const result = await svc.getQuotaPool("anthropic", 7);

    expect(result.pool).toMatchObject({
      accountId: 7,
      email: "mother@example.com",
      activeSubscriptionCount: 1,
      totalSeats: 2,
      fiveHour: {
        trackedUsedUsd: 8,
        inferredTotalUsd: 20,
        inferredRemainingUsd: 12,
        customerRemainingUsd: 12,
        coverageRatio: 1,
      },
      weekly: {
        trackedUsedUsd: 30,
        inferredTotalUsd: 100,
        inferredRemainingUsd: 70,
        customerRemainingUsd: 70,
        coverageRatio: 1,
      },
      subscriptions: [{
        id: "sub-1",
        customerEmail: "buyer@example.com",
        fiveHour: { used: 8, limit: 20, remaining: 12 },
        weekly: { used: 30, limit: 100, remaining: 70 },
        usdQuotaPerSeatByProduct: { anthropic: { fiveHour: 10, weekly: 50 } },
        includedInEstimate: true,
        order: { id: "order-1", outTradeNo: "OT-1" },
      }],
    });
  });
});
