import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanDb,
  createMockJob,
  createTestAccount,
  createTestTask,
  disconnectDb,
  getPrisma,
} from "./helpers";
import { MockBrowserPool } from "./mock-browser-pool";
import { processRemove } from "../processors/remove.processor";

describe("Remove Processor Integration", () => {
  const db = getPrisma();
  const mockPool = new MockBrowserPool();
  const workerId = "test-worker-remove";

  beforeEach(async () => {
    await cleanDb();
    mockPool.reset();
  });

  afterEach(async () => {
    mockPool.reset();
    await cleanDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it("should mark Task as FAILED_RETRYABLE when pool is exhausted", async () => {
    const account = await createTestAccount({
      adspowerProfileId: "profile-remove-pool-test",
    });
    const task = await createTestTask("REMOVE_MEMBER", {
      accountId: account.id,
    });

    mockPool.exhausted = true;

    const job = createMockJob(
      {
        taskId: task.id,
        familyGroupId: "fake-group",
        accountId: account.id,
        memberEmail: "old@example.com",
      },
      { id: task.id }
    );

    const deps = {
      prisma: db,
      adspower: {} as any,
      pool: mockPool as any,
      workerId,
    };

    await expect(processRemove(job, deps as any)).rejects.toThrow("No free profile available");

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    expect(updatedTask!.status).toBe("FAILED_RETRYABLE");
    expect(updatedTask!.lastErrorCode).toBe("PROFILE_ACQUIRE_FAILED");
  });
});
