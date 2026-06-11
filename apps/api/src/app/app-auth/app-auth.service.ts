import {
  ForbiddenException,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";

import { PrismaService } from "../../prisma/prisma.service";
import { CustomerAuthService } from "../../web/customer-auth/customer-auth.service";
import { CustomerTokenService } from "../../web/customer-auth/customer-token.service";

// TODO(Milestone 6): add device-count enforcement here (currently unlimited).

function buildSubscriptionSummary(subscription: {
  planId: string | null;
  status: string;
  expiresAt: Date | null;
  deviceLimit: number;
  productEntitlements: string;
  plan?: { name: string } | null;
} | null) {
  if (!subscription) return null;

  let products: any;
  try {
    products = JSON.parse(subscription.productEntitlements);
  } catch {
    products = [];
  }

  return {
    planName: subscription.plan?.name ?? "已绑定套餐",
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
    private readonly tokenService: CustomerTokenService
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
      orderBy: { createdAt: "desc" },
      include: { plan: { select: { name: true } } }
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
    // Validate credentials via CustomerAuthService
    const result = await this.customerAuthService.login({
      email: dto.email,
      password: dto.password
    });

    const customer = await this.prisma.customer.findUnique({
      where: { email: dto.email.toLowerCase().trim() }
    });

    if (!customer) {
      // Should never happen after successful login, but guard anyway
      throw new UnauthorizedException({
        error: "SESSION_INVALID",
        message: "Customer not found"
      });
    }

    // Sign a token WITH the deviceId so heartbeat can verify it
    const jtiHolder = { jti: "" };

    // We need the jti from the token — sign first, then decode
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

    // Upsert Device by @@unique(customerId, deviceId)
    // If an existing REVOKED device re-logs in → reactivate to ACTIVE (documented choice:
    // re-login is an explicit user action, so we restore access rather than blocking).
    const existing = await this.prisma.device.findUnique({
      where: { customerId_deviceId: { customerId: customer.id, deviceId: dto.deviceId } }
    });

    if (existing) {
      await this.prisma.device.update({
        where: { id: existing.id },
        data: {
          name: dto.deviceName ?? existing.name,
          platform: dto.platform ?? existing.platform,
          status: "ACTIVE", // reactivate REVOKED device on re-login
          lastSeenAt: now,
          lastIp: dto.lastIp ?? null,
          sessionJti
        }
      });
    } else {
      await this.prisma.device.create({
        data: {
          customerId: customer.id,
          deviceId: dto.deviceId,
          name: dto.deviceName ?? null,
          platform: dto.platform ?? null,
          status: "ACTIVE",
          lastSeenAt: now,
          lastIp: dto.lastIp ?? null,
          sessionJti
        }
      });
    }

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
