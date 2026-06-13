import {
  ForbiddenException,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { CustomerAuthService } from "../../account/customer-auth/customer-auth.service";
import { CustomerTokenService } from "../../account/customer-auth/customer-token.service";
import { DeviceService } from "../../account/device/device.service";

function buildSubscriptionSummary(subscription: {
  status: string;
  expiresAt: Date | null;
  deviceLimit: number;
  productEntitlements: string;
} | null) {
  if (!subscription) return null;

  let products: any;
  try {
    products = JSON.parse(subscription.productEntitlements);
  } catch {
    products = [];
  }

  return {
    // Catalog-only: subscriptions carry no single plan name — clients localize
    // their own label from products[]. Always null.
    planName: null,
    status: subscription.status,
    expiresAt: subscription.expiresAt,
    deviceLimit: subscription.deviceLimit,
    products
  };
}

@Injectable()
export class AppAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customerAuthService: CustomerAuthService,
    private readonly tokenService: CustomerTokenService,
    private readonly deviceService: DeviceService
  ) {}

  private async getActiveSubscription(customerId: string) {
    const now = new Date();
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        customerId,
        status: "ACTIVE",
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } }
        ]
      },
      orderBy: { createdAt: "desc" }
    });
    return subscription;
  }

  async login(dto: {
    email: string;
    password: string;
    deviceId: string;
    deviceName?: string;
    clientVersion?: string;
    platform?: string;
    lastIp?: string;
  }) {
    // Validate credentials — returns the raw Customer in a SINGLE fetch.
    // (A second findUnique here would race with a concurrent password change:
    // we could sign a token for a tokenVersion that was just bumped.)
    const customer = await this.customerAuthService.validateCredentials(
      dto.email,
      dto.password
    );

    // Device-limit enforcement (Milestone 6) — AFTER credential validation,
    // BEFORE issuing the token. Re-login on an existing ACTIVE device is always
    // allowed (doesn't add an active slot). A new device OR a REVOKED device
    // being reactivated both add an active slot, so they're rejected at the
    // limit. Reject-don't-auto-kick: the client links users to the web portal
    // to free a slot.
    const existingDevice = await this.prisma.device.findUnique({
      where: {
        customerId_deviceId: { customerId: customer.id, deviceId: dto.deviceId }
      }
    });

    if (!existingDevice || existingDevice.status !== "ACTIVE") {
      const [activeCount, deviceLimit] = await Promise.all([
        this.prisma.device.count({
          where: { customerId: customer.id, status: "ACTIVE" }
        }),
        this.deviceService.effectiveDeviceLimit(customer.id)
      ]);

      if (activeCount >= deviceLimit) {
        throw new ForbiddenException({
          error: "DEVICE_LIMIT_EXCEEDED",
          message: "设备数量已达上限，请先在网页端移除不用的设备"
        });
      }
    }

    // Sign a token WITH the deviceId so heartbeat can verify it.
    // We need the jti from the token — sign first, then decode.
    const token = this.tokenService.sign({
      customerId: customer.id,
      email: customer.email,
      tokenVersion: customer.tokenVersion,
      deviceId: dto.deviceId
    });

    const payload = this.tokenService.verify(token);
    if (!payload) {
      throw new Error("Internal: token verify failed immediately after sign");
    }

    const sessionJti = payload.jti;
    const now = new Date();

    // Atomic upsert on @@unique(customerId, deviceId) — find-then-create/update
    // was a TOCTOU: two simultaneous logins could both take the create path and
    // the loser would 500 on P2002. Upsert lets Prisma resolve the race.
    // REVOKED device re-login reactivates to ACTIVE (documented choice:
    // re-login is an explicit user action, so we restore access rather than blocking).
    await this.prisma.device.upsert({
      where: {
        customerId_deviceId: { customerId: customer.id, deviceId: dto.deviceId }
      },
      create: {
        customerId: customer.id,
        deviceId: dto.deviceId,
        name: dto.deviceName ?? null,
        platform: dto.platform ?? null,
        status: "ACTIVE",
        lastSeenAt: now,
        lastIp: dto.lastIp ?? null,
        sessionJti
      },
      update: {
        // Keep existing name/platform unless the client sent new values
        ...(dto.deviceName !== undefined ? { name: dto.deviceName } : {}),
        ...(dto.platform !== undefined ? { platform: dto.platform } : {}),
        status: "ACTIVE", // reactivate REVOKED device on re-login
        lastSeenAt: now,
        lastIp: dto.lastIp ?? null,
        sessionJti
      }
    });

    // Compute token expiry (30d from now)
    const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const subscription = await this.getActiveSubscription(customer.id);

    return {
      token,
      tokenExpiresAt,
      account: {
        email: customer.email,
        displayName: customer.displayName
      },
      subscription: buildSubscriptionSummary(subscription)
    };
  }

  async heartbeat(dto: {
    customerId: string;
    jti: string;
    tokenDeviceId: string | undefined;
    deviceId: string;
  }) {
    // Token deviceId must match body deviceId
    if (dto.tokenDeviceId !== dto.deviceId) {
      throw new UnauthorizedException({
        error: "SESSION_INVALID",
        message: "Device ID mismatch"
      });
    }

    const device = await this.prisma.device.findUnique({
      where: { customerId_deviceId: { customerId: dto.customerId, deviceId: dto.deviceId } }
    });

    if (!device) {
      throw new UnauthorizedException({
        error: "SESSION_INVALID",
        message: "Device not found"
      });
    }

    // REVOKED status or stale jti (logged in elsewhere) → DEVICE_REVOKED
    if (device.status === "REVOKED" || device.sessionJti !== dto.jti) {
      throw new ForbiddenException({
        error: "DEVICE_REVOKED",
        message: "Device session has been revoked"
      });
    }

    // Update lastSeenAt
    await this.prisma.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() }
    });

    const subscription = await this.getActiveSubscription(dto.customerId);

    return {
      ok: true,
      subscription: buildSubscriptionSummary(subscription),
      device: { status: "ACTIVE" }
    };
  }

  async logout(dto: {
    customerId: string;
    deviceId: string;
  }) {
    // Clear sessionJti — row stays, status remains ACTIVE
    const device = await this.prisma.device.findUnique({
      where: { customerId_deviceId: { customerId: dto.customerId, deviceId: dto.deviceId } }
    });

    if (device) {
      await this.prisma.device.update({
        where: { id: device.id },
        data: { sessionJti: null }
      });
    }

    return { ok: true };
  }
}
