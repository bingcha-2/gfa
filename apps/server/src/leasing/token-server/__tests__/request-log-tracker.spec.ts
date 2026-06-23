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
  it("record 缓冲,flush 批量 createMany 后清空队列", async () => {
    const prisma = makePrisma();
    const t = new RequestLogTracker(prisma, { autoStart: false, now: () => 1000 });
    t.record({
      provider: "anthropic", accountId: 1, accountEmail: "a@x.com", accessKeyId: "c1",
      status: 200, totalTokens: 50, reverseProxy: true, surface: "cli", sourceIp: "1.2.3.4",
      exitIp: "9.9.9.9", headers: '{"user-agent":"claude-cli/2"}',
    });
    expect(t.getQueueForTesting()).toHaveLength(1);

    await t.flush();
    expect(prisma.requestLog.createMany).toHaveBeenCalledTimes(1);
    const data = (prisma.requestLog.createMany as any).mock.calls[0][0].data;
    expect(data[0]).toMatchObject({
      provider: "anthropic", accessKeyId: "c1", surface: "cli", sourceIp: "1.2.3.4",
      exitIp: "9.9.9.9", reverseProxy: true, status: 200,
    });
    expect(t.getQueueForTesting()).toHaveLength(0);
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
    expect(data[0].headers.length).toBeLessThanOrEqual(8000);
  });

  it("pruneOld 删保留期之前的行", async () => {
    const prisma = makePrisma();
    const now = REQUEST_LOG_RETENTION_MS + 5000;
    const t = new RequestLogTracker(prisma, { autoStart: false, now: () => now });
    await t.pruneOld();
    const where = (prisma.requestLog.deleteMany as any).mock.calls[0][0].where;
    expect(where.at.lt).toBeInstanceOf(Date);
    expect(where.at.lt.getTime()).toBe(5000); // now - 保留期
  });

  it("体积兜底:行数超上限 → 按第 MAX 新行的 at 删更旧的", async () => {
    const boundaryAt = new Date("2026-06-20T00:00:00Z");
    const prisma = makePrisma();
    prisma.requestLog.count = vi.fn().mockResolvedValue(REQUEST_LOG_MAX_ROWS + 1000);
    prisma.requestLog.findMany = vi.fn().mockResolvedValue([{ at: boundaryAt }]);
    const t = new RequestLogTracker(prisma, { autoStart: false });
    await t.pruneOld();

    // findMany 用 skip=MAX、take=1、按 at 倒序取边界行
    const fmArg = (prisma.requestLog.findMany as any).mock.calls[0][0];
    expect(fmArg).toMatchObject({ orderBy: { at: "desc" }, skip: REQUEST_LOG_MAX_ROWS, take: 1 });
    // 第二次 deleteMany 删 < 边界 at
    const delCalls = (prisma.requestLog.deleteMany as any).mock.calls;
    expect(delCalls[delCalls.length - 1][0].where.at.lt).toEqual(boundaryAt);
  });

  it("行数未超上限 → 不做体积兜底", async () => {
    const prisma = makePrisma();
    prisma.requestLog.count = vi.fn().mockResolvedValue(100);
    const t = new RequestLogTracker(prisma, { autoStart: false });
    await t.pruneOld();
    expect(prisma.requestLog.findMany).not.toHaveBeenCalled();
    expect((prisma.requestLog.deleteMany as any).mock.calls).toHaveLength(1); // 只有时间删除
  });

  it("空队列 flush 不调库;flush 失败不抛", async () => {
    const prisma = { requestLog: { createMany: vi.fn().mockRejectedValue(new Error("db down")), deleteMany: vi.fn() } };
    const t = new RequestLogTracker(prisma, { autoStart: false });
    await t.flush();
    expect(prisma.requestLog.createMany).not.toHaveBeenCalled();
    t.record({ provider: "codex" });
    await expect(t.flush()).resolves.toBeUndefined();
  });
});
