/**
 * notification.service.spec.ts — unit tests for NotificationService
 *
 * Coverage:
 *   1. list: returns paginated notifications with unread count
 *   2. markRead: marks one notification; ownership 404 for other's notification
 *   3. markAllRead: marks all unread; returns updated count
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";

import { NotificationService } from "../notification.service";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeNotification(overrides: Partial<{
  id: string;
  customerId: string;
  type: string;
  title: string;
  body: string | null;
  readAt: Date | null;
  createdAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "notif-1",
    customerId: overrides.customerId ?? "cust-1",
    type: overrides.type ?? "SYSTEM",
    title: overrides.title ?? "Test notification",
    body: overrides.body !== undefined ? overrides.body : "Body text",
    readAt: overrides.readAt !== undefined ? overrides.readAt : null,
    createdAt: overrides.createdAt ?? new Date("2026-06-01T00:00:00Z"),
  };
}

function makePrisma(opts: {
  notifications?: ReturnType<typeof makeNotification>[];
  updateManyCount?: number;
} = {}) {
  const notifications = opts.notifications ?? [];
  const updateManyCount = opts.updateManyCount ?? 0;

  return {
    notification: {
      findMany: vi.fn(async ({ where, orderBy, skip, take, select }: any) => {
        let filtered = notifications.filter((n) => {
          if (where?.customerId && n.customerId !== where.customerId) return false;
          return true;
        });
        // Apply ordering by createdAt desc
        filtered = [...filtered].sort((a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime(),
        );
        // Pagination
        const s = skip ?? 0;
        const t = take ?? filtered.length;
        return filtered.slice(s, s + t);
      }),
      count: vi.fn(async ({ where }: any) => {
        return notifications.filter((n) => {
          if (where?.customerId && n.customerId !== where.customerId) return false;
          if ("readAt" in where && where.readAt === null) return n.readAt === null;
          return true;
        }).length;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.id) return notifications.find((n) => n.id === where.id) ?? null;
        return null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const idx = notifications.findIndex((n) => n.id === where.id);
        if (idx >= 0) {
          notifications[idx] = { ...notifications[idx], ...data };
          return notifications[idx];
        }
        return null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const n of notifications) {
          if (where?.customerId && n.customerId !== where.customerId) continue;
          if ("readAt" in where && where.readAt === null && n.readAt !== null) continue;
          n.readAt = data.readAt;
          count++;
        }
        return { count };
      }),
    },
  };
}

// ── 1. list ───────────────────────────────────────────────────────────────────

describe("NotificationService.list", () => {
  it("returns notifications for the customer ordered newest first", async () => {
    const n1 = makeNotification({ id: "n1", customerId: "cust-1", createdAt: new Date("2026-06-01") });
    const n2 = makeNotification({ id: "n2", customerId: "cust-1", createdAt: new Date("2026-06-03") });
    const other = makeNotification({ id: "n3", customerId: "cust-OTHER" });
    const prisma = makePrisma({ notifications: [n1, n2, other] });
    const service = new NotificationService(prisma as any);

    const result = await service.list("cust-1", {});

    expect(result.notifications).toHaveLength(2);
    expect(result.notifications[0].id).toBe("n2"); // newest first
    expect(result.notifications[1].id).toBe("n1");
  });

  it("unread count reflects only unread notifications", async () => {
    const unread1 = makeNotification({ id: "n1", customerId: "cust-1", readAt: null });
    const unread2 = makeNotification({ id: "n2", customerId: "cust-1", readAt: null });
    const read1 = makeNotification({ id: "n3", customerId: "cust-1", readAt: new Date() });
    const prisma = makePrisma({ notifications: [unread1, unread2, read1] });
    const service = new NotificationService(prisma as any);

    const result = await service.list("cust-1", {});

    expect(result.unread).toBe(2);
    expect(result.total).toBe(3);
  });

  it("notification shape: readAt is null when not read, ISO string when read", async () => {
    const readDate = new Date("2026-06-10T10:00:00Z");
    const n = makeNotification({ id: "n1", customerId: "cust-1", readAt: readDate, body: null });
    const prisma = makePrisma({ notifications: [n] });
    const service = new NotificationService(prisma as any);

    const result = await service.list("cust-1", {});

    expect(result.notifications[0].readAt).toBe(readDate.toISOString());
    expect(result.notifications[0].body).toBeNull();
  });

  it("paginates correctly", async () => {
    const notifications = Array.from({ length: 25 }, (_, i) =>
      makeNotification({
        id: `n${i}`,
        customerId: "cust-1",
        createdAt: new Date(2026, 0, i + 1),
      }),
    );
    const prisma = makePrisma({ notifications });
    const service = new NotificationService(prisma as any);

    const result = await service.list("cust-1", { page: 2, pageSize: 10 });

    expect(result.notifications).toHaveLength(10);
    expect(result.total).toBe(25);
  });
});

// ── 2. markRead ───────────────────────────────────────────────────────────────

describe("NotificationService.markRead", () => {
  it("marks notification as read and returns {ok:true}", async () => {
    const n = makeNotification({ id: "n1", customerId: "cust-1", readAt: null });
    const prisma = makePrisma({ notifications: [n] });
    const service = new NotificationService(prisma as any);

    const result = await service.markRead("cust-1", "n1");

    expect(result).toEqual({ ok: true });
    expect(prisma.notification.update).toHaveBeenCalled();
  });

  it("throws 404 NOTIFICATION_NOT_FOUND when notification doesn't exist", async () => {
    const prisma = makePrisma({ notifications: [] });
    const service = new NotificationService(prisma as any);

    await expect(service.markRead("cust-1", "nonexistent")).rejects.toThrow(NotFoundException);

    try {
      await service.markRead("cust-1", "nonexistent");
    } catch (err: any) {
      expect(err.response.error).toBe("NOTIFICATION_NOT_FOUND");
    }
  });

  it("throws 404 NOTIFICATION_NOT_FOUND when notification belongs to another customer (ownership)", async () => {
    const n = makeNotification({ id: "n1", customerId: "cust-OTHER" });
    const prisma = makePrisma({ notifications: [n] });
    const service = new NotificationService(prisma as any);

    await expect(service.markRead("cust-1", "n1")).rejects.toThrow(NotFoundException);

    try {
      await service.markRead("cust-1", "n1");
    } catch (err: any) {
      expect(err.response.error).toBe("NOTIFICATION_NOT_FOUND");
    }
  });
});

// ── 3. markAllRead ────────────────────────────────────────────────────────────

describe("NotificationService.markAllRead", () => {
  it("marks all unread notifications as read and returns {ok:true, updated:n}", async () => {
    const n1 = makeNotification({ id: "n1", customerId: "cust-1", readAt: null });
    const n2 = makeNotification({ id: "n2", customerId: "cust-1", readAt: null });
    const n3 = makeNotification({ id: "n3", customerId: "cust-1", readAt: new Date() }); // already read
    const prisma = makePrisma({ notifications: [n1, n2, n3] });
    const service = new NotificationService(prisma as any);

    const result = await service.markAllRead("cust-1");

    expect(result.ok).toBe(true);
    expect(result.updated).toBe(2); // only the 2 unread ones
  });

  it("returns updated:0 when no unread notifications", async () => {
    const n = makeNotification({ id: "n1", customerId: "cust-1", readAt: new Date() });
    const prisma = makePrisma({ notifications: [n] });
    const service = new NotificationService(prisma as any);

    const result = await service.markAllRead("cust-1");

    expect(result.ok).toBe(true);
    expect(result.updated).toBe(0);
  });

  it("only marks the requesting customer's notifications (not other customers')", async () => {
    const mine = makeNotification({ id: "n1", customerId: "cust-1", readAt: null });
    const other = makeNotification({ id: "n2", customerId: "cust-OTHER", readAt: null });
    const prisma = makePrisma({ notifications: [mine, other] });
    const service = new NotificationService(prisma as any);

    const result = await service.markAllRead("cust-1");

    expect(result.updated).toBe(1);

    // Verify the updateMany was called with customerId scope
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { customerId: "cust-1", readAt: null },
      data: expect.objectContaining({ readAt: expect.any(Date) }),
    });
  });
});
