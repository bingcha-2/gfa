import { describe, expect, it, vi } from "vitest";

import { RequestLogTracker, REQUEST_LOG_RETENTION_MS, REQUEST_LOG_MAX_ROWS } from "../request-log-tracker";

function makePrisma() {
  return {
    requestLog: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

describe("RequestLogTracker", () => {
  it("只安排下一次北京时间 04:00 的每日清理", () => {
    vi.useFakeTimers();
    // 17:00 UTC = 01:00 the next day in Beijing, regardless of host timezone.
    vi.setSystemTime(new Date("2026-07-14T17:00:00.000Z"));
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const t = new RequestLogTracker(makePrisma());

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3 * 60 * 60 * 1000);
    t.destroy();
    vi.useRealTimers();
  });

  it("record 缓冲,flush 批量 createMany 后清空队列", async () => {
    const prisma = makePrisma();
    const t = new RequestLogTracker(prisma, { autoStart: false, now: () => 1000 });
    t.record({
      provider: "anthropic", accountId: 1, accountEmail: "a@x.com", accessKeyId: "c1",
      status: 200, totalTokens: 50, reverseProxy: true, surface: "cli", sourceIp: "1.2.3.4",
      exitIp: "9.9.9.9", headers: '{"user-agent":"claude-cli/2"}', reportId: "r1", traceId: "t1",
      leaseId: "l1", quotaSubjectId: "c1", requestStartedAt: 100, upstreamCompletedAt: 200,
      snapshotObservedAt: 250, primaryReason: "LATE_USAGE_RECONCILED",
    });
    expect(t.getQueueForTesting()).toHaveLength(1);

    await t.flush();
    expect(prisma.requestLog.createMany).toHaveBeenCalledTimes(1);
    const data = (prisma.requestLog.createMany as any).mock.calls[0][0].data;
    expect(data[0]).toMatchObject({
      provider: "anthropic", accessKeyId: "c1", surface: "cli", sourceIp: "1.2.3.4",
      exitIp: "9.9.9.9", reverseProxy: true, status: 200,
      reportId: "r1", traceId: "t1", leaseId: "l1", quotaSubjectId: "c1",
      requestStartedAt: 100n, upstreamCompletedAt: 200n, snapshotObservedAt: 250n,
      primaryReason: "LATE_USAGE_RECONCILED",
    });
    expect(t.getQueueForTesting()).toHaveLength(0);
  });

  it("flush 每批最多写 1000 行", async () => {
    const prisma = makePrisma();
    const t = new RequestLogTracker(prisma, { autoStart: false });
    for (let i = 0; i < 1001; i++) t.record({ provider: "codex", reportId: `r${i}` });

    await t.flush();

    const data = (prisma.requestLog.createMany as any).mock.calls[0][0].data;
    expect(data).toHaveLength(1000);
    expect(t.getQueueForTesting()).toHaveLength(1);
    expect(t.getQueueForTesting()[0].reportId).toBe("r1000");
  });

  it("前一次 flush 未完成时不会启动第二个并发写入", async () => {
    let resolveCreateMany!: (value: { count: number }) => void;
    const createMany = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveCreateMany = resolve;
      }))
      .mockResolvedValue({ count: 1 });
    const prisma = makePrisma();
    prisma.requestLog.createMany = createMany;
    const t = new RequestLogTracker(prisma, { autoStart: false });
    t.record({ provider: "codex", reportId: "r1" });

    const first = t.flush();
    await Promise.resolve();
    t.record({ provider: "codex", reportId: "r2" });
    const second = t.flush();

    expect(createMany).toHaveBeenCalledOnce();
    resolveCreateMany({ count: 1 });
    await Promise.all([first, second]);
    expect(t.getQueueForTesting().map((row) => row.reportId)).toEqual(["r2"]);

    await t.flush();
    expect(createMany).toHaveBeenCalledTimes(2);
  });

  it("缺 provider 的事件被忽略", () => {
    const t = new RequestLogTracker(makePrisma(), { autoStart: false });
    t.record({ provider: "", accountId: 1 } as any);
    expect(t.getQueueForTesting()).toHaveLength(0);
  });

  it("超大 headers 截断", async () => {
    const prisma = makePrisma();
    const t = new RequestLogTracker(prisma, { autoStart: false });
    t.record({ provider: "codex", headers: "x".repeat(20000) });
    await t.flush();
    const data = (prisma.requestLog.createMany as any).mock.calls[0][0].data;
    expect(data[0].headers.length).toBeLessThanOrEqual(2000);
  });

  it("服务端递归移除凭证头,不信任客户端过滤", () => {
    const t = new RequestLogTracker(makePrisma(), { autoStart: false });
    t.record({
      provider: "anthropic",
      headers: JSON.stringify({
        "user-agent": "claude-cli/2",
        Authorization: "Bearer secret",
        Cookie: "session=secret",
        nested: { "x-api-key": "secret", harmless: "kept" },
      }),
    });
    const stored = JSON.parse(t.getQueueForTesting()[0].headers);
    expect(stored).toEqual({ "user-agent": "claude-cli/2", nested: { harmless: "kept" } });
  });

  it("pruneOld 删 48 小时保留期之前的行", async () => {
    const prisma = makePrisma();
    const now = REQUEST_LOG_RETENTION_MS + 5000;
    const t = new RequestLogTracker(prisma, { autoStart: false, now: () => now });
    await t.pruneOld();
    const where = (prisma.requestLog.findMany as any).mock.calls[0][0].where;
    expect(where.at.lt).toBeInstanceOf(Date);
    expect(where.at.lt.getTime()).toBe(5000); // now - 保留期
  });

  it("体积兜底:行数超上限 → 按 ID 小批删除最旧行", async () => {
    const prisma = makePrisma();
    prisma.requestLog.count = vi.fn().mockResolvedValue(REQUEST_LOG_MAX_ROWS + 600);
    prisma.requestLog.findMany = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => ({ id: i + 1 })))
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ id: i + 501 })));
    prisma.requestLog.deleteMany = vi.fn()
      .mockResolvedValueOnce({ count: 500 })
      .mockResolvedValueOnce({ count: 100 });
    const t = new RequestLogTracker(prisma, { autoStart: false });
    await t.pruneOld();

    const fmCalls = (prisma.requestLog.findMany as any).mock.calls;
    expect(fmCalls[1][0]).toMatchObject({ orderBy: { at: "asc" }, take: 500, select: { id: true } });
    expect(fmCalls[2][0]).toMatchObject({ orderBy: { at: "asc" }, take: 100, select: { id: true } });
    expect(fmCalls[1][0]).not.toHaveProperty("skip");
    const delCalls = (prisma.requestLog.deleteMany as any).mock.calls;
    expect(delCalls).toHaveLength(2);
    expect(delCalls[0][0].where.id.in).toHaveLength(500);
    expect(delCalls[1][0].where.id.in).toHaveLength(100);
  });

  it("行数未超上限 → 不做体积兜底", async () => {
    const prisma = makePrisma();
    prisma.requestLog.count = vi.fn().mockResolvedValue(100);
    const t = new RequestLogTracker(prisma, { autoStart: false });
    await t.pruneOld();
    expect(prisma.requestLog.findMany).toHaveBeenCalledTimes(1); // 仅 TTL 小批扫描
    expect((prisma.requestLog.deleteMany as any).mock.calls).toHaveLength(0);
  });

  it("清理达到 5 秒时间上限后停止后续批次", async () => {
    const prisma = makePrisma();
    let now = 0;
    prisma.requestLog.findMany = vi.fn().mockImplementation(async () => {
      now += 3_000;
      return Array.from({ length: 500 }, (_, i) => ({ id: i + 1 }));
    });
    prisma.requestLog.deleteMany = vi.fn().mockResolvedValue({ count: 500 });
    const t = new RequestLogTracker(prisma, { autoStart: false, now: () => now });

    await t.pruneOld();

    expect(prisma.requestLog.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.requestLog.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.requestLog.count).not.toHaveBeenCalled();
  });

  it("队列封顶并暴露溢出计数", () => {
    const t = new RequestLogTracker(makePrisma(), { autoStart: false });
    for (let i = 0; i < 10_001; i++) t.record({ provider: "codex", reportId: `r${i}` });
    expect(t.getQueueForTesting()).toHaveLength(10_000);
    expect(t.getQueueForTesting()[0].reportId).toBe("r1");
    expect(t.getOverflowCountForTesting()).toBe(1);
  });

  it("空队列 flush 不调库;flush 失败不抛", async () => {
    const prisma = { requestLog: { createMany: vi.fn().mockRejectedValue(new Error("db down")), deleteMany: vi.fn() } };
    const t = new RequestLogTracker(prisma, { autoStart: false });
    await t.flush();
    expect(prisma.requestLog.createMany).not.toHaveBeenCalled();
    t.record({ provider: "codex" });
    await expect(t.flush()).resolves.toBeUndefined();
  });

  it("flush 失败会把同一批诊断事件放回队首并在下次成功写入", async () => {
    const prisma = makePrisma();
    prisma.requestLog.createMany = vi.fn()
      .mockRejectedValueOnce(new Error("db busy"))
      .mockResolvedValueOnce({ count: 2 });
    const t = new RequestLogTracker(prisma, { autoStart: false });
    t.record({ provider: "codex", reportId: "r1" });
    t.record({ provider: "codex", reportId: "r2" });

    await expect(t.flush()).resolves.toBeUndefined();
    expect(t.getQueueForTesting().map((row) => row.reportId)).toEqual(["r1", "r2"]);

    await t.flush();
    expect(prisma.requestLog.createMany).toHaveBeenCalledTimes(2);
    expect(t.getQueueForTesting()).toHaveLength(0);
  });
});
