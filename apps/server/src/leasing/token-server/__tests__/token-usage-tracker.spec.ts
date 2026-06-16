import { describe, expect, it, vi } from "vitest";
import { TokenUsageTracker } from "../token-usage-tracker";

function makePrisma() {
  return {
    cardUsageHourly: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

describe("TokenUsageTracker — customerId 透传", () => {
  it("record 带 customerId → 进入队列", () => {
    const tracker = new TokenUsageTracker(makePrisma());
    tracker.record({
      accessKeyId: "sub-1", customerId: "cust-1",
      modelKey: "gpt-5-codex", bucket: "codex-gpt", status: 200,
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
    });
    expect(tracker.getQueueForTesting()[0]).toMatchObject({ accessKeyId: "sub-1", customerId: "cust-1" });
    tracker.destroy();
  });

  it("flush → 小时表 upsert 带上 customerId", async () => {
    const prisma = makePrisma();
    const tracker = new TokenUsageTracker(prisma);
    tracker.record({
      accessKeyId: "sub-1", customerId: "cust-1",
      modelKey: "gpt-5-codex", bucket: "codex-gpt", status: 200,
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
    });
    await tracker.flush();
    const arg = (prisma.cardUsageHourly.upsert as any).mock.calls[0][0];
    expect(arg.create).toMatchObject({ accessKeyId: "sub-1", customerId: "cust-1" });
    tracker.destroy();
  });
});

describe("TokenUsageTracker — 小时聚合 (CardUsageHourly)", () => {
  const at = new Date("2026-06-10T03:30:00Z"); // 同一整点桶

  it("同一(小时·卡·号·客户·模型·bucket)的多条 → 合并成 1 次 upsert,token/requests 累加", async () => {
    const prisma = makePrisma();
    const tracker = new TokenUsageTracker(prisma);
    const base = {
      accessKeyId: "sub-1", customerId: "cust-1", accountEmail: "a@x.com",
      modelKey: "gpt-5-codex", bucket: "codex-gpt", status: 200, timestamp: at,
    } as any;
    // record() 用 new Date() 盖 timestamp,这里直接构造队列以固定 hourStart。
    (tracker as any).queue.push(
      { ...base, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, rawTotalTokens: 15, totalTokens: 15 },
      { ...base, inputTokens: 20, outputTokens: 3, cachedInputTokens: 0, rawTotalTokens: 23, totalTokens: 23 },
    );
    await tracker.flush();

    expect(prisma.cardUsageHourly.upsert).toHaveBeenCalledTimes(1);
    const arg = (prisma.cardUsageHourly.upsert as any).mock.calls[0][0];
    expect(arg.where.hourStart_accessKeyId_accountEmail_customerId_modelKey_bucket).toMatchObject({
      accessKeyId: "sub-1", accountEmail: "a@x.com", customerId: "cust-1",
      modelKey: "gpt-5-codex", bucket: "codex-gpt",
    });
    expect(arg.create).toMatchObject({ requests: 2, failedRequests: 0, inputTokens: 30, outputTokens: 8, totalTokens: 38 });
    expect(arg.update.requests).toEqual({ increment: 2 });
    expect(arg.update.totalTokens).toEqual({ increment: 38 });
    tracker.destroy();
  });

  it("非 2xx 计入 failedRequests;null 邮箱/客户落为空串", async () => {
    const prisma = makePrisma();
    const tracker = new TokenUsageTracker(prisma);
    (tracker as any).queue.push(
      { accessKeyId: "sub-2", modelKey: "claude", bucket: "anthropic-claude", status: 429,
        inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, rawTotalTokens: 2, totalTokens: 2, timestamp: at },
    );
    await tracker.flush();

    const arg = (prisma.cardUsageHourly.upsert as any).mock.calls[0][0];
    expect(arg.create).toMatchObject({ requests: 1, failedRequests: 1, accountEmail: "", customerId: "" });
    tracker.destroy();
  });

  it("不同小时桶 → 分别 upsert", async () => {
    const prisma = makePrisma();
    const tracker = new TokenUsageTracker(prisma);
    const base = {
      accessKeyId: "sub-1", customerId: "c", accountEmail: "a@x.com",
      modelKey: "m", bucket: "codex-gpt", status: 200,
      inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, rawTotalTokens: 2, totalTokens: 2,
    } as any;
    (tracker as any).queue.push(
      { ...base, timestamp: new Date("2026-06-10T03:30:00Z") },
      { ...base, timestamp: new Date("2026-06-10T04:30:00Z") },
    );
    await tracker.flush();
    expect(prisma.cardUsageHourly.upsert).toHaveBeenCalledTimes(2);
    tracker.destroy();
  });
});
