import { describe, expect, it, vi } from "vitest";

import { TokenUsageStatsService, deriveAccountHealth, summarizeSubStatus } from "../token-usage-stats.service";

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
    expect(a.customers[0].customerId).toBe("c1"); // 反代来自 c1(无 customerId → custKey 回退 accessKeyId)
    const b = res.accounts.find((x) => x.accountEmail === "b@x.com")!;
    expect(b.product).toBe("codex");
  });
});

describe("getAccountBanAnalysis — 扇出客户 + 剔除空母号", () => {
  it("distinctCustomers 按 customerId 去重,文件卡(无 customerId)回退 accessKeyId", async () => {
    const rows = [
      // 同一买家 cust1 持 2 张卡 → 扇出卡 2、扇出客户 1
      { accountEmail: "a@x.com", accessKeyId: "k1", customerId: "cust1", bucket: "anthropic-claude", requests: 5, failedRequests: 0, reverseProxyHits: 0, totalTokens: 10 },
      { accountEmail: "a@x.com", accessKeyId: "k2", customerId: "cust1", bucket: "anthropic-claude", requests: 5, failedRequests: 0, reverseProxyHits: 0, totalTokens: 10 },
      // 另一买家 cust2 + 一张无 customerId 的文件卡(回退 accessKeyId 各算一份)
      { accountEmail: "a@x.com", accessKeyId: "k3", customerId: "cust2", bucket: "anthropic-claude", requests: 5, failedRequests: 0, reverseProxyHits: 0, totalTokens: 10 },
      { accountEmail: "a@x.com", accessKeyId: "k4", customerId: "", bucket: "anthropic-claude", requests: 5, failedRequests: 0, reverseProxyHits: 0, totalTokens: 10 },
    ];
    const prisma = {
      cardUsageHourly: { findMany: vi.fn().mockResolvedValue(rows) },
      requestLog: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const res = await makeService(prisma).getAccountBanAnalysis({ days: 7 });
    const a = res.accounts.find((x) => x.accountEmail === "a@x.com")!;
    expect(a.distinctCards).toBe(4);       // k1..k4
    expect(a.distinctCustomers).toBe(3);   // cust1、cust2、文件卡 k4
  });

  it("accountEmail 为空的 legacy 行不进风险榜(不再出现 (unknown))", async () => {
    const rows = [
      { accountEmail: "", accessKeyId: "k1", customerId: "c", bucket: "anthropic-claude", requests: 9, failedRequests: 0, reverseProxyHits: 0, totalTokens: 0 },
      { accountEmail: "real@x.com", accessKeyId: "k2", customerId: "c", bucket: "anthropic-claude", requests: 3, failedRequests: 0, reverseProxyHits: 0, totalTokens: 0 },
    ];
    const prisma = {
      cardUsageHourly: { findMany: vi.fn().mockResolvedValue(rows) },
      requestLog: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const res = await makeService(prisma).getAccountBanAnalysis({ days: 7 });
    expect(res.accounts).toHaveLength(1);
    expect(res.accounts[0].accountEmail).toBe("real@x.com");
    expect(res.accounts.some((a) => a.accountEmail === "(unknown)" || a.accountEmail === "")).toBe(false);
  });
});

describe("getAccountBanAnalysis — 每客户峰值/分 + 来源IP + 持卡数(点开母号看哪个买家)", () => {
  it("按客户从同一次 RequestLog 扫描聚合峰值 req/min、不同来源 IP、持卡数", async () => {
    // 买家 cust1 持 2 张卡(k1/k2)→ 持卡数 2
    const rows = [
      { accountEmail: "a@x.com", accessKeyId: "k1", customerId: "cust1", bucket: "anthropic-claude", requests: 3, failedRequests: 0, reverseProxyHits: 0, totalTokens: 10 },
      { accountEmail: "a@x.com", accessKeyId: "k2", customerId: "cust1", bucket: "anthropic-claude", requests: 1, failedRequests: 0, reverseProxyHits: 0, totalTokens: 5 },
    ];
    // cust1 同一分钟 2 条(峰值=2)、2 个来源 IP;同分钟还有 1 条在下一分钟
    const t = "2026-06-23T00:00:";
    const logRows = [
      { provider: "anthropic", accountEmail: "a@x.com", accessKeyId: "k1", customerId: "cust1", surface: "cli", sourceIp: "1.1.1.1", exitIp: "9.9.9.9", userId: "u1", at: new Date(`${t}05Z`) },
      { provider: "anthropic", accountEmail: "a@x.com", accessKeyId: "k2", customerId: "cust1", surface: "cli", sourceIp: "2.2.2.2", exitIp: "9.9.9.9", userId: "u1", at: new Date(`${t}40Z`) },
      { provider: "anthropic", accountEmail: "a@x.com", accessKeyId: "k1", customerId: "cust1", surface: "cli", sourceIp: "1.1.1.1", exitIp: "9.9.9.9", userId: "u1", at: new Date("2026-06-23T00:01:10Z") },
    ];
    const prisma = {
      cardUsageHourly: { findMany: vi.fn().mockResolvedValue(rows) },
      requestLog: { findMany: vi.fn().mockResolvedValue(logRows) },
    };
    const res = await makeService(prisma).getAccountBanAnalysis({ days: 7 });
    const cu = res.accounts[0].customers[0];
    expect(cu.customerId).toBe("cust1");
    expect(cu.distinctCards).toBe(2);        // k1 + k2
    expect(cu.peakReqPerMin).toBe(2);        // 同分钟 2 条
    expect(cu.distinctSourceIps).toBe(2);    // 1.1.1.1 / 2.2.2.2
  });
});

describe("summarizeSubStatus — 客户订阅状态汇总", () => {
  it("优先级 CANCELLED > EXPIRED > ACTIVE > 空", () => {
    expect(summarizeSubStatus(["ACTIVE", "CANCELLED"])).toBe("CANCELLED"); // 任一取消 → 告警
    expect(summarizeSubStatus(["EXPIRED", "EXPIRED"])).toBe("EXPIRED");
    expect(summarizeSubStatus(["EXPIRED", "ACTIVE"])).toBe("ACTIVE");      // 还有在用的不算过期
    expect(summarizeSubStatus(["ACTIVE"])).toBe("ACTIVE");
    expect(summarizeSubStatus([undefined, undefined])).toBe("");          // 文件卡无订阅
  });
});

describe("getAccountBanAnalysis — 客户标记订阅已取消", () => {
  it("订阅卡 accessKeyId=Subscription.id,CANCELLED 的客户被标出", async () => {
    const rows = [
      { accountEmail: "a@x.com", accessKeyId: "sub_cancelled", customerId: "buyerCancel", bucket: "anthropic-claude", requests: 7, failedRequests: 0, reverseProxyHits: 0, totalTokens: 10 },
      { accountEmail: "a@x.com", accessKeyId: "sub_active", customerId: "buyerOk", bucket: "anthropic-claude", requests: 3, failedRequests: 0, reverseProxyHits: 0, totalTokens: 10 },
    ];
    const subFind = vi.fn().mockResolvedValue([
      { id: "sub_cancelled", status: "CANCELLED" },
      { id: "sub_active", status: "ACTIVE" },
    ]);
    const prisma = {
      cardUsageHourly: { findMany: vi.fn().mockResolvedValue(rows) },
      requestLog: { findMany: vi.fn().mockResolvedValue([]) },
      subscription: { findMany: subFind },
    };
    const res = await makeService(prisma).getAccountBanAnalysis({ days: 7 });
    const acct = res.accounts.find((x) => x.accountEmail === "a@x.com")!;
    const cancel = acct.customers.find((c) => c.customerId === "buyerCancel")!;
    const ok = acct.customers.find((c) => c.customerId === "buyerOk")!;
    expect(cancel.subStatus).toBe("CANCELLED");
    expect(ok.subStatus).toBe("ACTIVE");
    // 只查一次,带上两张卡 id
    expect(subFind).toHaveBeenCalledTimes(1);
    expect(subFind.mock.calls[0][0].where.id.in.sort()).toEqual(["sub_active", "sub_cancelled"]);
  });

  it("subscription 表缺失/抛错时降级为空状态,不影响风险榜", async () => {
    const rows = [
      { accountEmail: "a@x.com", accessKeyId: "k1", customerId: "c1", bucket: "anthropic-claude", requests: 1, failedRequests: 0, reverseProxyHits: 0, totalTokens: 0 },
    ];
    const prisma = {
      cardUsageHourly: { findMany: vi.fn().mockResolvedValue(rows) },
      requestLog: { findMany: vi.fn().mockResolvedValue([]) },
      subscription: { findMany: vi.fn().mockRejectedValue(new Error("no table")) },
    };
    const res = await makeService(prisma).getAccountBanAnalysis({ days: 7 });
    expect(res.accounts[0].customers[0].subStatus).toBe("");
  });
});

describe("getBanAnalysis — TTL 缓存(避免每次全量扫 RequestLog)", () => {
  it("TTL 内只扫一次 RequestLog,过期后重扫", async () => {
    let clock = 1_000_000;
    const requestLogFind = vi.fn().mockResolvedValue([]);
    const prisma = {
      cardUsageHourly: { findMany: vi.fn().mockResolvedValue([]) },
      requestLog: { findMany: requestLogFind },
      accountBanEvent: { findMany: vi.fn().mockResolvedValue([]) },
    };
    class Clocked extends TokenUsageStatsService { protected nowMs() { return clock; } }
    const svc = new Clocked(prisma as any);

    await svc.getBanAnalysis({ days: 3 });
    await svc.getBanAnalysis({ days: 3 });
    expect(requestLogFind).toHaveBeenCalledTimes(1); // 第二次命中缓存

    clock += TokenUsageStatsService.BAN_ANALYSIS_TTL_MS + 1;
    await svc.getBanAnalysis({ days: 3 });
    expect(requestLogFind).toHaveBeenCalledTimes(2); // 过期重算

    await svc.getBanAnalysis({ days: 7 }); // 不同 days 独立缓存
    expect(requestLogFind).toHaveBeenCalledTimes(3);
  });
});

describe("deriveAccountHealth — 母号状态压成标签", () => {
  it("不在池 / 禁用 / Token失效 / 永久死亡 / 配额 / 正常", () => {
    expect(deriveAccountHealth({ found: false }).label).toBe("不在池");
    expect(deriveAccountHealth({ found: true, enabled: false }).label).toBe("已禁用");
    expect(deriveAccountHealth({ found: true, quotaStatus: "exhausted", quotaStatusReason: "invalid_grant" }))
      .toMatchObject({ label: "Token失效", tone: "destructive" });
    expect(deriveAccountHealth({ found: true, quotaStatusReason: "service_disabled" }).label).toBe("已死");
    expect(deriveAccountHealth({ found: true, quotaStatus: "exhausted" }).label).toBe("已用尽");
    expect(deriveAccountHealth({ found: true, quotaStatus: "cooling" }).label).toBe("冷却中");
    expect(deriveAccountHealth({ found: true, quotaStatus: "error" }).label).toBe("异常");
    expect(deriveAccountHealth({ found: true, quotaStatus: "ok" })).toMatchObject({ label: "正常", tone: "ok" });
  });

  it("verification_required 不算永久死亡(可恢复)", () => {
    // isPermanentDeathReason 对 verification/validation 返回 false → 落到配额分支
    expect(deriveAccountHealth({ found: true, quotaStatus: "ok", quotaStatusReason: "verification_required" }).label).toBe("正常");
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
