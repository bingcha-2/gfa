import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreditTracker } from "../credit-tracker";

describe("CreditTracker", () => {
  let tracker: CreditTracker;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      creditConsumption: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    tracker = new CreditTracker(mockPrisma);
  });

  afterEach(() => {
    tracker.destroy();
  });

  // ── record() tracks every change, skips only no-op ──────────────────────

  it("records a consumption event when credits decrease", () => {
    tracker.record(1, "alpha@example.com", 500, 450);

    const queue = tracker.getQueueForTesting();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      accountId: 1,
      email: "alpha@example.com",
      oldAmount: 500,
      newAmount: 450,
      consumed: 50,
    });
  });

  it("records when credits increase (refill)", () => {
    tracker.record(1, "alpha@example.com", 200, 500);

    const queue = tracker.getQueueForTesting();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      accountId: 1,
      email: "alpha@example.com",
      oldAmount: 200,
      newAmount: 500,
      consumed: -300,
    });
  });

  it("does NOT record when credits stay the same", () => {
    tracker.record(1, "alpha@example.com", 300, 300);

    const queue = tracker.getQueueForTesting();
    expect(queue).toHaveLength(0);
  });

  it("records when old amount is zero (new account)", () => {
    tracker.record(1, "alpha@example.com", 0, 500);

    const queue = tracker.getQueueForTesting();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      accountId: 1,
      email: "alpha@example.com",
      oldAmount: 0,
      newAmount: 500,
      consumed: -500,
    });
  });

  // ── flush() batch writes ────────────────────────────────────────────────

  it("flushes queued events to Prisma in batch", async () => {
    tracker.record(1, "a@x.com", 500, 450);
    tracker.record(2, "b@x.com", 300, 280);

    await tracker.flush();

    expect(mockPrisma.creditConsumption.createMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.creditConsumption.createMany.mock.calls[0][0];
    expect(call.data).toHaveLength(2);
    expect(call.data[0]).toMatchObject({ accountId: 1, consumed: 50 });
    expect(call.data[1]).toMatchObject({ accountId: 2, consumed: 20 });
  });

  it("clears queue after successful flush", async () => {
    tracker.record(1, "a@x.com", 500, 450);
    await tracker.flush();

    expect(tracker.getQueueForTesting()).toHaveLength(0);

    // Second flush should be a no-op
    await tracker.flush();
    expect(mockPrisma.creditConsumption.createMany).toHaveBeenCalledTimes(1);
  });

  it("does nothing when queue is empty", async () => {
    await tracker.flush();
    expect(mockPrisma.creditConsumption.createMany).not.toHaveBeenCalled();
  });

  // ── error resilience ────────────────────────────────────────────────────

  it("does NOT throw when flush fails — events are dropped", async () => {
    mockPrisma.creditConsumption.createMany.mockRejectedValue(
      new Error("DB connection lost"),
    );

    tracker.record(1, "a@x.com", 500, 450);

    // Should not throw
    await expect(tracker.flush()).resolves.toBeUndefined();

    // Queue should be cleared (events dropped, not retried)
    expect(tracker.getQueueForTesting()).toHaveLength(0);
  });

  // ── multiple records for same account ───────────────────────────────────

  it("records multiple consumption events for the same account", () => {
    tracker.record(1, "a@x.com", 500, 480);
    tracker.record(1, "a@x.com", 480, 460);

    const queue = tracker.getQueueForTesting();
    expect(queue).toHaveLength(2);
    expect(queue[0].consumed).toBe(20);
    expect(queue[1].consumed).toBe(20);
  });
});
