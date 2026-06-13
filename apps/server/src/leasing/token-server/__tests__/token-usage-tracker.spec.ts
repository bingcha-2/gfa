import { describe, expect, it, vi } from "vitest";
import { TokenUsageTracker } from "../token-usage-tracker";

function makePrisma() {
  return { cardTokenUsage: { createMany: vi.fn().mockResolvedValue({ count: 1 }) } };
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

  it("flush → createMany 收到含 customerId 的行", async () => {
    const prisma = makePrisma();
    const tracker = new TokenUsageTracker(prisma);
    tracker.record({
      accessKeyId: "sub-1", customerId: "cust-1",
      modelKey: "gpt-5-codex", bucket: "codex-gpt", status: 200,
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
    });
    await tracker.flush();
    expect(prisma.cardTokenUsage.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ accessKeyId: "sub-1", customerId: "cust-1" })],
    });
    tracker.destroy();
  });
});
