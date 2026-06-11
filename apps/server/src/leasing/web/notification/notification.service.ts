import { Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../../../shared/prisma/prisma.service";

@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  // ── List notifications ─────────────────────────────────────────────────────

  async list(
    customerId: string,
    opts: { page?: number; pageSize?: number },
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));

    const where = { customerId };

    const [notifications, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          readAt: true,
          createdAt: true,
        },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { customerId, readAt: null } }),
    ]);

    return {
      notifications: notifications.map((n) => ({
        id: n.id,
        type: n.type as string,
        title: n.title,
        body: n.body ?? null,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
      })),
      total,
      unread,
    };
  }

  // ── Mark one notification read ─────────────────────────────────────────────

  async markRead(customerId: string, id: string): Promise<{ ok: true }> {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
      select: { id: true, customerId: true },
    });

    if (!notification || notification.customerId !== customerId) {
      throw new NotFoundException({ error: "NOTIFICATION_NOT_FOUND", message: "Notification not found" });
    }

    await this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });

    return { ok: true };
  }

  // ── Mark all unread notifications read ────────────────────────────────────

  async markAllRead(customerId: string): Promise<{ ok: true; updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { customerId, readAt: null },
      data: { readAt: new Date() },
    });

    return { ok: true, updated: result.count };
  }
}
