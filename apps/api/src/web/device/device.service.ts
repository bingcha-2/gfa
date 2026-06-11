import { Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../../prisma/prisma.service";

export interface DeviceView {
  id: string;
  deviceId: string;
  name: string | null;
  platform: string | null;
  status: string;
  lastSeenAt: Date | null;
  lastIp: string | null;
}

function toDeviceView(device: {
  id: string;
  deviceId: string;
  name: string | null;
  platform: string | null;
  status: string;
  lastSeenAt: Date | null;
  lastIp: string | null;
}): DeviceView {
  return {
    id: device.id,
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    status: device.status,
    lastSeenAt: device.lastSeenAt,
    lastIp: device.lastIp
  };
}

@Injectable()
export class DeviceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the max(deviceLimit) across ACTIVE subscriptions that are not
   * expired (expiresAt null OR > now). Falls back to 1 if no qualifying
   * subscription exists.
   */
  async effectiveDeviceLimit(customerId: string): Promise<number> {
    const now = new Date();
    const subs = await this.prisma.subscription.findMany({
      where: {
        customerId,
        status: "ACTIVE",
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } }
        ]
      },
      select: { deviceLimit: true }
    });

    if (subs.length === 0) return 1;
    return Math.max(...subs.map(s => s.deviceLimit));
  }

  /**
   * GET /api/web/devices
   * Returns the customer's devices (ordered by lastSeenAt desc, nulls last)
   * and their effective device limit.
   */
  async list(customerId: string): Promise<{ devices: DeviceView[]; deviceLimit: number }> {
    const [rawDevices, deviceLimit] = await Promise.all([
      this.prisma.device.findMany({
        where: { customerId },
        orderBy: { lastSeenAt: "desc" }
      }),
      this.effectiveDeviceLimit(customerId)
    ]);

    return {
      devices: rawDevices.map(toDeviceView),
      deviceLimit
    };
  }

  /**
   * PATCH /api/web/devices/:id
   * Renames a device. Returns the updated device view.
   * Ownership enforced: 404 DEVICE_NOT_FOUND if device doesn't exist or belongs
   * to a different customer (same response to avoid probing).
   */
  async rename(customerId: string, id: string, name: string): Promise<{ device: DeviceView }> {
    const device = await this.prisma.device.findUnique({ where: { id } });

    if (!device || device.customerId !== customerId) {
      throw new NotFoundException({ error: "DEVICE_NOT_FOUND", message: "Device not found" });
    }

    const updated = await this.prisma.device.update({
      where: { id },
      data: { name }
    });

    return { device: toDeviceView(updated) };
  }

  /**
   * POST /api/web/devices/:id/revoke
   * Sets status REVOKED and clears sessionJti (invalidating the session signal).
   * Idempotent: revoking an already-REVOKED device returns {ok:true}.
   * Ownership enforced: 404 DEVICE_NOT_FOUND if not found or wrong customer.
   */
  async revoke(customerId: string, id: string): Promise<{ ok: true }> {
    const device = await this.prisma.device.findUnique({ where: { id } });

    if (!device || device.customerId !== customerId) {
      throw new NotFoundException({ error: "DEVICE_NOT_FOUND", message: "Device not found" });
    }

    await this.prisma.device.update({
      where: { id },
      data: { status: "REVOKED", sessionJti: null }
    });

    return { ok: true };
  }
}
