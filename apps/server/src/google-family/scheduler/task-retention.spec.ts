import { describe, expect, it, vi } from "vitest";

import {
  pruneTaskLogsBatch,
  pruneTasksBatch,
  TASK_CLEANUP_STATUSES,
} from "./task-retention";

describe("task retention", () => {
  it("prunes only safe terminal task logs in bounded batches", async () => {
    const execute = vi.fn(async () => 17);
    const cutoff = new Date("2026-07-14T00:00:00.000Z");

    await expect(pruneTaskLogsBatch({ $executeRawUnsafe: execute } as any, cutoff, 500)).resolves.toBe(17);

    const [sql, ...params] = execute.mock.calls[0];
    expect(sql).toContain("JOIN Task t ON t.id = tl.taskId");
    expect(sql).toContain("LIMIT ?");
    expect(params).toEqual([...TASK_CLEANUP_STATUSES, cutoff, 500]);
    expect(params).not.toContain("FAILED_RETRYABLE");
    expect(params).not.toContain("MANUAL_REVIEW");
    expect(params).not.toContain("FAILED_FINAL");
  });

  it("prunes task main records with the same safe status guard", async () => {
    const execute = vi.fn(async () => 5);
    const cutoff = new Date("2026-06-30T00:00:00.000Z");

    await expect(pruneTasksBatch({ $executeRawUnsafe: execute } as any, cutoff, 200)).resolves.toBe(5);
    expect(execute.mock.calls[0][0]).toContain("DELETE FROM Task WHERE rowid IN");
    expect(execute.mock.calls[0].slice(1)).toEqual([...TASK_CLEANUP_STATUSES, cutoff, 200]);
  });
});
