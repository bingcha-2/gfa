import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { AccessKeyStore } from "../../token-server/access-key-store";
import { CustomerAuthService } from "../../account/customer-auth/customer-auth.service";
import { CustomerTokenService } from "../../account/customer-auth/customer-token.service";
import { DeviceService } from "../../account/device/device.service";

function buildSubscriptionSummary(
  subscription: {
    id: string;
    status: string;
    expiresAt: Date | null;
    deviceLimit: number;
    priority: number;
    productEntitlements: string;
    levels?: string | null;
  } | null,
  remainFraction: number | null = null
) {
  if (!subscription) return null;

  let products: any;
  try {
    products = JSON.parse(subscription.productEntitlements);
  } catch {
    products = [];
  }

  return {
    id: subscription.id,
    // Catalog-only: subscriptions carry no single plan name — clients localize
    // their own label from products[]. Always null.
    planName: null,
    status: subscription.status,
    expiresAt: subscription.expiresAt,
    deviceLimit: subscription.deviceLimit,
    priority: subscription.priority,
    products,
    levels: parseLevels(subscription.levels),
    // 每订阅「最紧复合桶」的剩余额度比例(0-1);null=无限额/无额度数据。客户端据此画余量条,
    // 用来区分同产品同到期的多个订阅(谁在消耗、谁备用满额)。
    remainFraction
  };
}

function parseLevels(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "string" && value.trim() !== "")
        .map(([key, value]) => [key, String(value)])
    );
  } catch {
    return {};
  }
}

@Injectable()
export class AppAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customerAuthService: CustomerAuthService,
    private readonly tokenService: CustomerTokenService,
    private readonly deviceService: DeviceService,
    @Inject("SHARED_ACCESS_KEY_STORE") private readonly store: AccessKeyStore
  ) {}

  /**
   * 单个订阅的剩余额度比例 —— 取该订阅「最紧复合桶」的 (limit-used)/limit(0-1)。
   * 订阅 record 未加载 / 无限额(无 bucket 上限)→ null。供客户端多订阅余量条、区分订阅。
   * Best-effort:store 读取/计算异常一律降级为 null(绝不阻断登录/心跳)。
   */
  private subscriptionRemainFraction(subscriptionId: string): number | null {
    const record = this.store.findById(subscriptionId);
    if (!record) return null;
    let status: any;
    try {
      status = this.store.publicStatus(record);
    } catch {
      return null;
    }
    const buckets = Array.isArray(status?.buckets) ? status.buckets : [];
    let min = 1;
    let has = false;
    for (const b of buckets) {
      const limit = Number(b?.limit) || 0;
      if (limit <= 0) continue;
      has = true;
      const frac = Math.max(0, Math.min(1, (limit - (Number(b?.used) || 0)) / limit));
      if (frac < min) min = frac;
    }
    return has ? min : null;
  }

  private async listActiveSubscriptionsSorted(customerId: string) {
    const now = new Date();
    const rows = await this.prisma.subscription.findMany({
      where: {
        customerId,
        status: "ACTIVE",
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      },
      orderBy: { priority: "asc" },
      select: { id: true, status: true, expiresAt: true, deviceLimit: true, priority: true, productEntitlements: true, levels: true }
    });
    // Secondary JS sort ensures stable order even in test mocks that ignore orderBy
    return rows.slice().sort((a, b) => a.priority - b.priority);
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

    const subs = await this.listActiveSubscriptionsSorted(customer.id);
    const subscriptions = subs.map((s) => buildSubscriptionSummary(s, this.subscriptionRemainFraction(s.id)));

    return {
      token,
      tokenExpiresAt,
      account: {
        email: customer.email,
        displayName: customer.displayName
      },
      subscription: subscriptions[0] ?? null, // 兼容旧 app
      subscriptions
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

    const subs = await this.listActiveSubscriptionsSorted(dto.customerId);
    const subscriptions = subs.map((s) => buildSubscriptionSummary(s, this.subscriptionRemainFraction(s.id)));

    return {
      ok: true,
      subscription: subscriptions[0] ?? null,
      subscriptions,
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
