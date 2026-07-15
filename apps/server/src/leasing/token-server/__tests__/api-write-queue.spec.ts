import { describe, expect, it, vi } from "vitest";

import { AccountQuotaSnapshotTracker } from "../account-quota-snapshot-tracker";
import { ApiWriteQueue } from "../api-write-queue";
import { RequestLogTracker } from "../request-log-tracker";
import { TokenUsageTracker } from "../token-usage-tracker";

describe("ApiWriteQueue", () => {
  it("serializes RequestLog, TokenUsage, and quota snapshot writes", async () => {
    const writeQueue = new ApiWriteQueue();
    const order: string[] = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const write = (name: string) => vi.fn(async () => {
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      order.push(`${name}:start`);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      order.push(`${name}:end`);
      activeWrites--;
      return { count: 1 };
    });

    const requestWrite = write("request");
    const tokenWrite = write("token");
    const snapshotWrite = write("snapshot");
    const requestLogs = new RequestLogTracker(
      { requestLog: { createMany: requestWrite } },
      { autoStart: false, writeQueue },
    );
    const tokenUsage = new TokenUsageTracker(
      { cardUsageHourly: { upsert: tokenWrite } },
      { autoStart: false, writeQueue },
    );
    const snapshots = new AccountQuotaSnapshotTracker(
      { accountQuotaSnapshot: { createMany: snapshotWrite } },
      { autoStart: false, writeQueue },
    );

    requestLogs.record({ provider: "codex", reportId: "r1" });
    tokenUsage.record({
      accessKeyId: "sub-1", modelKey: "gpt-5-codex", bucket: "codex-gpt",
      status: 200, inputTokens: 1, outputTokens: 1, totalTokens: 2,
    });
    snapshots.record({ provider: "codex", accountId: 1, modelKey: "codex", hourlyPercent: 80 });

    await Promise.all([requestLogs.flush(), tokenUsage.flush(), snapshots.flush()]);

    expect(maxActiveWrites).toBe(1);
    expect(order).toEqual([
      "request:start", "request:end",
      "token:start", "token:end",
      "snapshot:start", "snapshot:end",
    ]);
    expect(writeQueue.getPendingCountForTesting()).toBe(0);
  });

  it("continues with the next write after a failed task", async () => {
    const writeQueue = new ApiWriteQueue();
    const failed = writeQueue.enqueue(async () => {
      throw new Error("database busy");
    });
    const next = writeQueue.enqueue(async () => "ok");

    await expect(failed).rejects.toThrow("database busy");
    await expect(next).resolves.toBe("ok");
  });
});
