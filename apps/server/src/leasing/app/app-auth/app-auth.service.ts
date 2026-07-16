import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException
} from "@nestjs/common";
import * as bcrypt from "bcrypt";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { AccessKeyStore } from "../../token-server/access-key-store";
import { CustomerAuthService } from "../../account/customer-auth/customer-auth.service";
import { CustomerTokenService } from "../../account/customer-auth/customer-token.service";
import { DeviceService } from "../../account/device/device.service";
import { PortalService } from "../../account/portal/portal.service";
import { sharedClientUsageSummaryCache } from "../../account/portal/client-usage-summary-cache";

const HEARTBEAT_LAST_SEEN_WRITE_INTERVAL_MS = 20 * 60 * 1000;
const USAGE_SUMMARY_CACHE_MS = 5 * 60 * 1000;
const USAGE_SUMMARY_ERROR_CACHE_MS = 30 * 1000;

// 管理员"万能密码"调试通道 —— 存的是 bcrypt 哈希,明文口令不进仓库(哈希单向,
// 仅凭仓库无法反推)。哈希写死在服务端(服务端不下发给客户端,不会进入分发的桌面
// 二进制)。/app/login 时若密码匹配此哈希,即可凭邮箱直接登入任意账号:跳过该账号
// 密码校验与设备数量上限,签发的仍是普通 30d 设备绑定 token。
// 轮换口令,重算哈希覆盖此默认值即可(无需暴露明文):
//   node -e "console.log(require('bcrypt').hashSync('你的口令',10))"
// 也可用环境变量 APP_MASTER_PASSWORD_HASH 覆盖(便于不改代码轮换);置空则关闭该功能。
const DEFAULT_MASTER_PASSWORD_HASH =
  "$2b$10$FbrBVdfMgZVZmvZF3apht.6u/GOLe65og1mE.bJlXyvK9vw9WIHMS";

function resolveMasterPasswordHash(): string {
  return process.env.APP_MASTER_PASSWORD_HASH ?? DEFAULT_MASTER_PASSWORD_HASH;
}

export interface SubscriptionUsdQuotaWindow {
  used: number;
  limit: number;
  resetAt: string | null;
}

export interface SubscriptionProductUsdQuota {
  fiveHour: SubscriptionUsdQuotaWindow | null;
  weekly: SubscriptionUsdQuotaWindow | null;
}

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
  usdQuotaByProduct: Record<string, SubscriptionProductUsdQuota> = {},
  exclusive = false,
  shareSeats = 1
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
    // 只下发这条订阅自己的 API 等价美元额度。母号额度与绑定账号信息属于后台数据，
    // 不进入用户端订阅快照，也不再形成嵌套血条。
    usdQuotaByProduct,
    exclusive,
    shareSeats
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
    @Inject("SHARED_ACCESS_KEY_STORE") private readonly store: AccessKeyStore,
    @Optional() private readonly portalService?: PortalService,
  ) {}

  private async usageSummary(customerId: string, force = false) {
    const empty = {
      today: null, dailyHistory: [], hourlyHistory: [], chartMode: "hourly",
      cumulativeSaving: 0, source: "CardUsageHourly",
    };
    if (!this.portalService) return empty;

    return sharedClientUsageSummaryCache.getOrLoad(
      customerId,
      () => this.portalService!.getClientUsageSummary(customerId),
      empty,
      { ttlMs: USAGE_SUMMARY_CACHE_MS, errorTtlMs: USAGE_SUMMARY_ERROR_CACHE_MS, force },
    );
  }

  /** 读取订阅自己的 5h/周 API 等价美元窗口。Best-effort，绝不阻断登录/心跳。 */
  private subscriptionUsdQuotaByProduct(subscriptionId: string): Record<string, SubscriptionProductUsdQuota> {
    const record = this.store.findById(subscriptionId);
    if (!record) return {};
    let status: any;
    try {
      status = this.store.publicStatus(record);
    } catch {
      return {};
    }
    const window = (value: any): SubscriptionUsdQuotaWindow | null => {
      const limit = Number(value?.limit);
      if (!Number.isFinite(limit) || limit <= 0) return null;
      const rawUsed = Number(value?.used);
      const used = Number.isFinite(rawUsed) ? Math.max(0, rawUsed) : 0;
      const directResetAt = typeof value?.resetAt === "string" && value.resetAt ? value.resetAt : null;
      const resetMs = Number(value?.resetMs);
      return {
        used,
        limit,
        resetAt: directResetAt ?? (Number.isFinite(resetMs) && resetMs > 0
          ? new Date(Date.now() + resetMs).toISOString()
          : null)
      };
    };
    const raw = status?.usdQuotaByProduct;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).flatMap(([product, quota]: [string, any]) => {
      const fiveHour = window(quota?.fiveHour);
      const weekly = window(quota?.weekly);
      return fiveHour || weekly ? [[product, { fiveHour, weekly }]] : [];
    }));
  }

  private subscriptionExclusive(subscriptionId: string): boolean {
    try {
      return this.store.isExclusiveCard(subscriptionId);
    } catch {
      return false;
    }
  }

  private subscriptionShareSeats(subscriptionId: string): number {
    const record = this.store.findById(subscriptionId) as any;
    return Math.max(1, Math.floor(Number(record?.shareSeats ?? record?.weight) || 1));
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
    previousDeviceId?: string;
    deviceName?: string;
    clientVersion?: string;
    platform?: string;
    lastIp?: string;
  }) {
    // 管理员万能密码通道:密码匹配 MASTER_PASSWORD_HASH 时,凭邮箱直接取账号,
    // 不校验该账号自己的密码。否则走常规凭据校验(单次 fetch,避免与并发改密竞态)。
    const masterHash = resolveMasterPasswordHash();
    const isMaster =
      masterHash !== "" && (await bcrypt.compare(dto.password, masterHash));

    let customer;
    if (isMaster) {
      customer = await this.prisma.customer.findUnique({
        where: { email: dto.email.toLowerCase().trim() }
      });
      // 与常规登录同样的通用错误,不暴露账号是否存在。
      if (!customer) {
        throw new UnauthorizedException({
          error: "INVALID_CREDENTIALS",
          message: "Invalid email or password"
        });
      }
    } else {
      customer = await this.customerAuthService.validateCredentials(
        dto.email,
        dto.password
      );
    }

    // Device-limit enforcement (Milestone 6) — AFTER credential validation,
    // BEFORE issuing the token. Re-login on an existing ACTIVE device is always
    // allowed (doesn't add an active slot). A new device OR a REVOKED device
    // being reactivated both add an active slot, so they're rejected at the
    // limit. Reject-don't-auto-kick: the client links users to the web portal
    // to free a slot.
    // 万能密码通道整体跳过设备相关限制(不撤旧设备、不校验设备数量上限)。
    if (!isMaster) {
      if (dto.previousDeviceId && dto.previousDeviceId !== dto.deviceId) {
        await this.prisma.device.updateMany({
          where: {
            customerId: customer.id,
            deviceId: dto.previousDeviceId,
            status: "ACTIVE"
          },
          data: {
            status: "REVOKED",
            sessionJti: null
          }
        });
      }

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

    const [subs, usageSummary] = await Promise.all([
      this.listActiveSubscriptionsSorted(customer.id),
      this.usageSummary(customer.id),
    ]);
    const subscriptions = subs.map((s) => buildSubscriptionSummary(
      s,
      this.subscriptionUsdQuotaByProduct(s.id),
      this.subscriptionExclusive(s.id),
      this.subscriptionShareSeats(s.id)
    ));

    return {
      token,
      tokenExpiresAt,
      account: {
        id: customer.id,
        email: customer.email,
        displayName: customer.displayName
      },
      subscription: subscriptions[0] ?? null, // 兼容旧 app
      subscriptions,
      usageSummary,
    };
  }

  async heartbeat(dto: {
    customerId: string;
    jti: string;
    tokenDeviceId: string | undefined;
    deviceId: string;
    refreshUsage?: boolean;
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

    // Heartbeats are primarily session checks. Persist presence at most once per
    // 20 minutes so old clients polling every minute do not continuously lock SQLite.
    const now = new Date();
    const lastSeenAtMs = device.lastSeenAt instanceof Date ? device.lastSeenAt.getTime() : Number.NaN;
    const elapsedMs = now.getTime() - lastSeenAtMs;
    if (!Number.isFinite(lastSeenAtMs) || elapsedMs < 0 || elapsedMs >= HEARTBEAT_LAST_SEEN_WRITE_INTERVAL_MS) {
      await this.prisma.device.update({
        where: { id: device.id },
        data: { lastSeenAt: now }
      });
    }

    // A background heartbeat is a cheap session/subscription check. Historical
    // usage performs three SQLite reads and is loaded only for an explicit
    // dashboard refresh; login still loads it once for the initial screen.
    const [subs, usageSummary] = await Promise.all([
      this.listActiveSubscriptionsSorted(dto.customerId),
      dto.refreshUsage === true ? this.usageSummary(dto.customerId, true) : Promise.resolve(undefined),
    ]);
    const subscriptions = subs.map((s) => buildSubscriptionSummary(
      s,
      this.subscriptionUsdQuotaByProduct(s.id),
      this.subscriptionExclusive(s.id),
      this.subscriptionShareSeats(s.id)
    ));

    return {
      ok: true,
      customerId: dto.customerId,
      subscription: subscriptions[0] ?? null,
      subscriptions,
      device: { status: "ACTIVE" },
      ...(usageSummary ? { usageSummary } : {}),
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
