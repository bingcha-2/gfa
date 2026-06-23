import { describe, expect, it, vi } from "vitest";

import { TokenUsageStatsService } from "../token-usage-stats.service";

function makeService(prisma: any) {
  return new TokenUsageStatsService(prisma as any);
}

describe("getAccountBanAnalysis — 母号风险聚合(codex+anthropic)", () => {
  it("按 product+email 分组,算反代率/失败率/扇出,排除 antigravity,反代降序", async () => {
    const rows = [
      { accountEmail: "a@x.com", accessKeyId: "c1", bucket: "anthropic-claude", requests: 10, failedRequests: 2, reverseProxyHits: 5, totalTokens: 100 },
      { accountEmail: "a@x.com", accessKeyId: "c2", bucket: "anthropic-claude", requests: 10, failedRequests: 0, reverseProxyHits: 0, totalTokens: 50 },
      { accountEmail: "b@x.com", accessKeyId: "c3", bucket: "codex-gpt", requests: 4, failedRequests: 4, reverseProxyHits: 4, totalTokens: 20 },
      { accountEmail: "z@x.com", accessKeyId: "c9", bucket: "gemini", requests: 99, failedRequests: 0, reverseProxyHits: 0, totalTokens: 0 },
    ];
    // a@x: 同一分钟 2 条(峰值 req/min=2)、2 个来源 IP
    const logRows = [
      { provider: "anthropic", accountEmail: "a@x.com", surface: "cli", sourceIp: "1.1.1.1", exitIp: "9.9.9.9", userId: "u1", at: new Date("2026-06-23T00:00:05Z") },
      { provider: "anthropic", accountEmail: "a@x.com", surface: "desktop", sourceIp: "2.2.2.2", exitIp: "9.9.9.9", userId: "u2", at: new Date("2026-06-23T00:00:40Z") },
    ];
    const prisma = {
      cardUsageHourly: { findMany: vi.fn().mockResolvedValue(rows) },
      requestLog: { findMany: vi.fn().mockResolvedValue(logRows) },
    };
    const res = await makeService(prisma).getAccountBanAnalysis({ days: 7 });

    expect(res.accounts).toHaveLength(2); // gemini(antigravity) 被排除
    const a = res.accounts.find((x) => x.accountEmail === "a@x.com")!;
    expect(a.product).toBe("anthropic");
    expect(a.requests).toBe(20);
    expect(a.reverseProxyHits).toBe(5);
    expect(a.reverseProxyRate).toBeCloseTo(0.25);
    expect(a.failRate).toBeCloseTo(0.1);
    expect(a.distinctCards).toBe(2);
    expect(a.peakReqPerMin).toBe(2); // 同分钟 2 条
    expect(a.distinctSourceIps).toBe(2);
    expect(a.distinctUsers).toBe(2); // 两个 metadata.user_id
    expect(res.accounts[0].accountEmail).toBe("a@x.com"); // 反代数 5 > 4 → 排第一
    expect(a.cards[0].accessKeyId).toBe("c1"); // 反代来自 c1
    const b = res.accounts.find((x) => x.accountEmail === "b@x.com")!;
    expect(b.product).toBe("codex");
  });
});

describe("getBanComparison — 已封 vs 健康 定因对比", () => {
  it("两组均值 + 差异倍数,按差异降序,峰值 req/min 从 RequestLog 时间戳算", async () => {
    // 两个母号:a@x(已封,反代高、来源 IP 多)、b@x(健康)
    const cardRows = [
      { accountEmail: "a@x.com", accessKeyId: "c1", bucket: "anthropic-claude", requests: 20, failedRequests: 4, reverseProxyHits: 10, totalTokens: 200 },
      { accountEmail: "a@x.com", accessKeyId: "c2", bucket: "anthropic-claude", requests: 20, failedRequests: 0, reverseProxyHits: 0, totalTokens: 100 },
      { accountEmail: "b@x.com", accessKeyId: "c3", bucket: "anthropic-claude", requests: 20, failedRequests: 0, reverseProxyHits: 0, totalTokens: 100 },
    ];
    const banRows = [{ provider: "anthropic", accountEmail: "a@x.com" }];
    // a@x: 同一分钟 3 条(峰值 req/min=3)、3 个来源 IP;b@x: 1 条、1 个 IP
    const t0 = new Date("2026-06-23T00:00:10Z");
    const logRows = [
      { provider: "anthropic", accountEmail: "a@x.com", surface: "desktop", sourceIp: "1.1.1.1", exitIp: "9.9.9.9", userId: "u1", at: t0 },
      { provider: "anthropic", accountEmail: "a@x.com", surface: "cli", sourceIp: "2.2.2.2", exitIp: "9.9.9.9", userId: "u2", at: t0 },
      { provider: "anthropic", accountEmail: "a@x.com", surface: "cli", sourceIp: "3.3.3.3", exitIp: "9.9.9.9", userId: "u3", at: t0 },
      { provider: "anthropic", accountEmail: "b@x.com", surface: "cli", sourceIp: "8.8.8.8", exitIp: "7.7.7.7", userId: "u9", at: t0 },
    ];
    const prisma = {
      cardUsageHourly: { findMany: vi.fn().mockResolvedValue(cardRows) },
      accountBanEvent: { findMany: vi.fn().mockResolvedValue(banRows) },
      requestLog: { findMany: vi.fn().mockResolvedValue(logRows) },
    };
    const res = await makeService(prisma).getBanComparison({ days: 7 });

    expect(res.bannedCount).toBe(1);
    expect(res.healthyCount).toBe(1);
    const rp = res.metrics.find((m) => m.key === "reverseProxyRate")!;
    expect(rp.bannedAvg).toBeCloseTo(0.25); // a@x: 10/40
    expect(rp.healthyAvg).toBeCloseTo(0);
    const ips = res.metrics.find((m) => m.key === "distinctSourceIps")!;
    expect(ips.bannedAvg).toBe(3);
    expect(ips.healthyAvg).toBe(1);
    const users = res.metrics.find((m) => m.key === "distinctUsers")!;
    expect(users.bannedAvg).toBe(3); // a@x 有 u1/u2/u3
    expect(users.healthyAvg).toBe(1); // b@x 有 u9
    const peak = res.metrics.find((m) => m.key === "peakReqPerMin")!;
    expect(peak.bannedAvg).toBe(3); // 同分钟 3 条
    // 降序:差异最大的排前面
    expect(res.metrics[0].ratio).toBeGreaterThanOrEqual(res.metrics[1].ratio);
  });
});

describe("getBanEvents — 封号事件流", () => {
  it("倒序 + requestCount + 封号前峰值 req/min,只取 codex/anthropic", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "e1", createdAt: new Date(), provider: "anthropic", accountId: 1, accountEmail: "a@x.com",
        reason: "banned", upstreamStatus: 403, upstreamBody: "disabled", modelKey: "claude", deathStrikes: 2,
        // 两条在同一分钟、一条在下一分钟 → 峰值 req/min = 2,requestCount = 3
        requests: [
          { at: new Date("2026-06-23T00:00:05Z") },
          { at: new Date("2026-06-23T00:00:20Z") },
          { at: new Date("2026-06-23T00:01:30Z") },
        ],
      },
    ]);
    const res = await makeService({ accountBanEvent: { findMany } }).getBanEvents({ days: 7 });

    expect(res.events[0]).toMatchObject({ id: "e1", provider: "anthropic", upstreamStatus: 403, requestCount: 3, peakReqPerMin: 2 });
    expect(findMany.mock.calls[0][0].where.provider).toEqual({ in: ["codex", "anthropic"] });
    expect(findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
  });
});

describe("getRequestLogs — per-request 热表浏览", () => {
  it("应用 母号/卡/surface/反代 过滤 + 倒序 + provider 限定", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "r1", surface: "desktop", reverseProxy: true }]);
    const res = await makeService({ requestLog: { findMany } }).getRequestLogs({
      accountEmail: "a@x.com", surface: "desktop", reverseProxyOnly: true, hours: 24, limit: 50,
    });
    expect(res.logs).toHaveLength(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ accountEmail: "a@x.com", surface: "desktop", reverseProxy: true });
    expect(arg.where.provider).toEqual({ in: ["codex", "anthropic"] });
    expect(arg.where.at.gte).toBeInstanceOf(Date);
    expect(arg.orderBy).toEqual({ at: "desc" });
    expect(arg.take).toBe(50);
  });

  it("无过滤时不带 reverseProxy/accountEmail 条件", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await makeService({ requestLog: { findMany } }).getRequestLogs({});
    const where = findMany.mock.calls[0][0].where;
    expect(where.reverseProxy).toBeUndefined();
    expect(where.accountEmail).toBeUndefined();
  });
});

describe("getBanEventRequests — 时间线 + 封号前 3 天聚合", () => {
  it("时间线按 seq 升序 + window3d 从 RequestLog([封号-72h,封号]) 聚合", async () => {
    const banAt = new Date("2026-06-23T12:00:00Z");
    const event = { provider: "anthropic", accountEmail: "a@x.com", createdAt: banAt };
    const reqRows = [{ seq: 0 }, { seq: 1 }];
    const logRows = [
      { reverseProxy: true, sourceIp: "1.1.1.1", deviceId: "dev1", userId: "u1", totalTokens: 10, at: new Date("2026-06-23T11:00:05Z") },
      { reverseProxy: true, sourceIp: "2.2.2.2", deviceId: "dev2", userId: "u2", totalTokens: 20, at: new Date("2026-06-23T11:00:20Z") },
      { reverseProxy: false, sourceIp: "1.1.1.1", deviceId: "dev1", userId: "u1", totalTokens: 5, at: new Date("2026-06-22T10:00:00Z") },
    ];
    const prisma = {
      accountBanEvent: { findUnique: vi.fn().mockResolvedValue(event) },
      banEventRequest: { findMany: vi.fn().mockResolvedValue(reqRows) },
      requestLog: { findMany: vi.fn().mockResolvedValue(logRows) },
    };
    const res = await makeService(prisma).getBanEventRequests("e1");

    expect(res.requests).toHaveLength(2);
    expect(prisma.banEventRequest.findMany.mock.calls[0][0]).toMatchObject({ where: { banEventId: "e1" }, orderBy: { seq: "asc" } });
    expect(res.window3d).toMatchObject({
      requests: 3, reverseProxyHits: 2, distinctSourceIps: 2, distinctDevices: 2, distinctUsers: 2, totalTokens: 35, peakReqPerMin: 2,
    });
    expect(res.window3d!.reverseProxyRate).toBeCloseTo(2 / 3);
    const w = prisma.requestLog.findMany.mock.calls[0][0].where;
    expect(w.accountEmail).toBe("a@x.com");
    expect(w.at.lte).toEqual(banAt);
    expect(w.at.gte.getTime()).toBe(banAt.getTime() - 72 * 3600 * 1000);
  });

  it("空 id 直接返回空,不查库", async () => {
    const findMany = vi.fn();
    const res = await makeService({ banEventRequest: { findMany } }).getBanEventRequests("");
    expect(res.requests).toEqual([]);
    expect(res.window3d).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });
});
