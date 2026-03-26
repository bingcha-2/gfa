import { afterAll, describe, expect, it, vi } from "vitest";

import { ExpireScanService } from "./expire-scan.service";

// ---- Mock helpers ----

function makePrisma({ orders = [] as any[], claimCount = 1 } = {}) {
  return {
    order: {
      findMany: vi.fn().mockResolvedValue(orders),
      // CAS lock: returns { count: 1 } = claimed, { count: 0 } = already taken
      updateMany: vi.fn().mockResolvedValue({ count: claimCount }),
      count: vi.fn().mockResolvedValue(orders.length)
    },
    task: {
      // Returns a Task-like object with a stable id used as taskId in the Job
      create: vi.fn().mockResolvedValue({ id: "task-uuid-1" })
    }
  };
}

function makeRemoveQueue() {
  return { add: vi.fn().mockResolvedValue({ id: "job-1" }) };
}

function makeService(prisma: any, removeQueue: any) {
  return new ExpireScanService(prisma as any, removeQueue as any);
}

// ---- Tests ----

describe("ExpireScanService", () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe("scanExpiredOrders", () => {
    it("should return empty array when no orders are expired", async () => {
      const prisma = makePrisma({ orders: [] });
      const queue = makeRemoveQueue();
      const service = makeService(prisma, queue);

      const result = await service.scanExpiredOrders();

      expect(result).toHaveLength(0);
      expect(prisma.task.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it("should CAS-claim order, create Task, enqueue remove job, and push to results", async () => {
      const fakeOrders = [
        {
          id: "order-1",
          orderNo: "GFA-001",
          userEmail: "alice@gmail.com",
          familyGroupId: "group-1",
          status: "COMPLETED",
          familyGroup: { accountId: "acct-1" }
        }
      ];

      const prisma = makePrisma({ orders: fakeOrders });
      const queue = makeRemoveQueue();
      const service = makeService(prisma, queue);

      const result = await service.scanExpiredOrders();

      expect(result).toHaveLength(1);

      // CAS: updateMany must be called to atomically claim the order
      expect(prisma.order.updateMany).toHaveBeenCalledOnce();
      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "order-1" }),
          data: expect.objectContaining({ status: "EXPIRED" })
        })
      );

      // Task DB record must be created
      expect(prisma.task.create).toHaveBeenCalledOnce();
      expect(prisma.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "REMOVE_MEMBER",
            orderId: "order-1",
            familyGroupId: "group-1",
            accountId: "acct-1"
          })
        })
      );

      // Job payload must carry taskId from the DB Task record
      expect(queue.add).toHaveBeenCalledOnce();
      expect(queue.add).toHaveBeenCalledWith(
        "remove-expired-member",
        expect.objectContaining({
          taskId: "task-uuid-1",
          familyGroupId: "group-1",
          accountId: "acct-1",
          memberEmail: "alice@gmail.com",
          orderId: "order-1",
          reason: "EXPIRED"
        }),
        expect.objectContaining({ jobId: "expire-order-1" })
      );
    });

    it("should skip Task + queue when CAS returns count=0 (another pod claimed first)", async () => {
      const fakeOrders = [
        {
          id: "order-2",
          orderNo: "GFA-002",
          userEmail: "bob@gmail.com",
          familyGroupId: "group-2",
          status: "COMPLETED",
          familyGroup: { accountId: "acct-2" }
        }
      ];

      const prisma = makePrisma({ orders: fakeOrders });
      // Simulate another pod already claimed: count=0
      prisma.order.updateMany.mockResolvedValue({ count: 0 });
      const queue = makeRemoveQueue();
      const service = makeService(prisma, queue);

      const result = await service.scanExpiredOrders();

      // Nothing processed — another pod claimed it
      expect(result).toHaveLength(0);
      expect(prisma.task.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("should skip Task + queue but still CAS-claim when order has no family group", async () => {
      const fakeOrders = [
        {
          id: "order-3",
          orderNo: "GFA-003",
          userEmail: "carol@gmail.com",
          familyGroupId: null,
          status: "CODE_VERIFIED",
          familyGroup: null
        }
      ];

      const prisma = makePrisma({ orders: fakeOrders });
      const queue = makeRemoveQueue();
      const service = makeService(prisma, queue);

      const result = await service.scanExpiredOrders();

      expect(result).toHaveLength(1);
      // CAS runs (to mark EXPIRED and prevent re-scan)
      expect(prisma.order.updateMany).toHaveBeenCalledOnce();
      // No group → no Task, no queue
      expect(prisma.task.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("should drop run when already scanning (single-process guard)", async () => {
      const prisma = makePrisma({ orders: [] });
      const queue = makeRemoveQueue();
      const service = makeService(prisma, queue);

      (service as any).scanning = true;

      const result = await service.scanExpiredOrders();
      expect(result).toHaveLength(0);
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });
  });

  describe("getStatus", () => {
    it("should populate lastRunAt+lastRunCount after completing a scan", async () => {
      const prisma = makePrisma({ orders: [] });
      const queue = makeRemoveQueue();
      const service = makeService(prisma, queue);

      const before = await service.getStatus();
      expect(before.lastRunAt).toBeNull();
      expect(before.lastRunCount).toBe(0);

      await service.scanExpiredOrders();

      const after = await service.getStatus();
      expect(after.lastRunAt).toBeInstanceOf(Date);
      expect(after.lastRunCount).toBe(0);
    });
  });
});
