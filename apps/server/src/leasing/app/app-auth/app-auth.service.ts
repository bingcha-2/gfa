import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { AccessKeyStore } from "../../token-server/access-key-store";
import { ACCOUNT_SHARE_CAPACITY } from "../../token-server/token-billing";
import { sharedFairShareRegistry } from "../../token-server/fair-share-registry";
import { CustomerAuthService } from "../../account/customer-auth/customer-auth.service";
import { CustomerTokenService } from "../../account/customer-auth/customer-token.service";
import { DeviceService } from "../../account/device/device.service";

// 单产品的整号 5h/周剩余(逐订阅展示用)。来自 AccountQuotaSnapshot,百分比 0-100;null=无数据。
// my* 字段:该订阅在绑定母号上的「我的份额」(fair-share),供客户端逐订阅画双层血条
// (母号 hourlyPercent 打底 + 我的 myHourlyFraction 叠加)。来自 FairShareTracker 实时现算,
// 取不到则缺省 → 客户端退回单层。myShare=e_i(我的份额占整号比例,双层外层几何)。
export interface ProductQuotaWindow {
  hourlyPercent: number | null;
  weeklyPercent: number | null;
  hourlyResetAt: string | null;
  weeklyResetAt: string | null;
  myHourlyFraction?: number | null;
  myWeeklyFraction?: number | null;
  // myShare = 客户端双层血条「我那一席」的【名义份额 X/Y】= weight/号总份数(遮超卖,超卖前口径)。
  // 注意:不是真实 e_i=w/D —— 真实份额会随超卖(D=max(N,Σw))被摊薄(如 1/8 变 1/12),
  // 客户端 carousel 直接拿它当 nominalShare 画条,下发真实值会让没用过的卡也显示掉血。与 Dashboard 一致。
  myShare?: number | null;
  // 独享(营销标签):该卡是否独享。权威标志,客户端据此画单层「剩余 X%」血条,
  // 不走拼车双层(我的总剩余/账号总剩余)。缺省/false → 客户端走双层。
  exclusive?: boolean;
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
  remainFraction: number | null = null,
  productQuota: Record<string, ProductQuotaWindow> = {}
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
    remainFraction,
    // 每产品(该订阅 bindings 绑定号)的整号 5h/周剩余,供客户端逐订阅按产品画 5h/周血条。
    // 多产品订阅 → 多个 key;无绑定/无快照 → 该产品缺省。
    productQuota
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

  /**
   * 逐产品整号 5h/周剩余 —— 解析订阅 bindings(产品→accountId),按每个绑定号读最新一条
   * AccountQuotaSnapshot(provider=产品)。供客户端逐订阅、逐产品画 5h/周血条(不必正在租号)。
   * 「我的份额」是跨同号用户的现算值(不在此表),故这里只给整号余量;客户端对正在用的订阅
   * 叠加实时份额。Best-effort:解析/查询异常一律降级为缺省(绝不阻断心跳)。
   */
  private async productQuotaForSubscription(
    subscriptionId: string,
    bindingsJson: string | null | undefined
  ): Promise<Record<string, ProductQuotaWindow>> {
    if (!bindingsJson) return {};
    let bindings: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bindingsJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      bindings = parsed as Record<string, unknown>;
    } catch {
      return {};
    }
    const out: Record<string, ProductQuotaWindow> = {};
    // 独享是卡级(整个订阅)标志,与具体 product 无关:一次判定,逐 product 盖章。
    // 与血条数字同源(access-key-store.isExclusiveCard):显式 exclusive 或 weight≥号总份数。
    const exclusive = this.store.isExclusiveCard(subscriptionId);
    // 名义份额 = weight/号总份数(遮超卖,超卖前口径)。下发给客户端当双层条的「我那一席」几何,
    // 不下发真实 e_i=w/D(会随超卖摊薄,让没用过的卡也掉血,即 11.1.2 回归的根因)。
    const cardWeight = Math.max(1, Math.floor(Number((this.store.findById(subscriptionId) as any)?.weight) || 1));
    const nominalShare = Math.min(1, Math.max(0, cardWeight / ACCOUNT_SHARE_CAPACITY));
    for (const [product, rawId] of Object.entries(bindings)) {
      const accountId = Number(rawId);
      if (!Number.isFinite(accountId) || accountId <= 0) continue;
      let snap: any;
      try {
        snap = await this.prisma.accountQuotaSnapshot.findFirst({
          where: { provider: product, accountId },
          orderBy: { timestamp: "desc" }
        });
      } catch {
        continue;
      }
      if (!snap) continue;
      const iso = (d: any) => (d ? new Date(d).toISOString() : null);
      // 我的份额(fair-share):该订阅(=cardId)在母号 accountId 上的实时自份额剩余 + e_i。
      // tracker 按 provider 现算;取该产品下「最紧桶」为代表(与账号级最紧桶口径一致)。
      // Best-effort:无 tracker/无数据一律缺省,客户端退单层,绝不阻断心跳。
      const my = this.myFairShareForProduct(product, accountId, subscriptionId);
      out[product] = {
        hourlyPercent: snap.hourlyPercent ?? null,
        weeklyPercent: snap.weeklyPercent ?? null,
        hourlyResetAt: iso(snap.hourlyResetAt),
        weeklyResetAt: iso(snap.weeklyResetAt),
        myHourlyFraction: my.hourlyFraction,
        myWeeklyFraction: my.weeklyFraction,
        myShare: nominalShare,
        exclusive
      };
    }
    return out;
  }

  /**
   * 该订阅在母号上的「我的份额」(fair-share)5h/周剩余 + e_i,实时取自 FairShareTracker。
   * 同一 provider 可能有多个复合桶(多模型),取「最紧」(fraction 最小)为该产品代表;
   * e_i(share)对同一(母号,卡)恒定,取代表桶的即可。取不到一律 null。
   */
  private myFairShareForProduct(
    product: string,
    accountId: number,
    cardId: string
  ): { hourlyFraction: number | null; weeklyFraction: number | null; share: number | null } {
    const tracker = sharedFairShareRegistry.get(product);
    if (!tracker) return { hourlyFraction: null, weeklyFraction: null, share: null };
    const tightest = (
      map: Record<string, { fraction: number; share: number }>
    ): { fraction: number; share: number } | null => {
      let best: { fraction: number; share: number } | null = null;
      for (const v of Object.values(map)) {
        if (!Number.isFinite(v.fraction) || v.fraction < 0) continue; // -1=未知,跳过
        if (!best || v.fraction < best.fraction) best = { fraction: v.fraction, share: v.share };
      }
      return best;
    };
    try {
      const h = tightest(tracker.getCardQuotaFractions(accountId, cardId));
      const w = tightest(tracker.getCardWeeklyQuotaFractions(accountId, cardId));
      return {
        hourlyFraction: h ? h.fraction : null,
        weeklyFraction: w ? w.fraction : null,
        share: h ? h.share : w ? w.share : null
      };
    } catch {
      return { hourlyFraction: null, weeklyFraction: null, share: null };
    }
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
      select: { id: true, status: true, expiresAt: true, deviceLimit: true, priority: true, productEntitlements: true, levels: true, bindings: true }
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
    const subscriptions = await Promise.all(
      subs.map(async (s) =>
        buildSubscriptionSummary(
          s,
          this.subscriptionRemainFraction(s.id),
          await this.productQuotaForSubscription(s.id, (s as { bindings?: string | null }).bindings)
        )
      )
    );

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
