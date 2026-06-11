/**
 * session-token-resolver.ts — customer session JWT → subscription (cardId) on
 * the lease hot path.
 *
 * The desktop client authenticates lease/report calls with the customer's
 * session JWT (Authorization: Bearer, typ "user-session") instead of a card
 * key. This resolver verifies the token OUTSIDE a guard context (the store is a
 * plain class, not a Nest route), re-running the same checks the
 * CustomerJwtStrategy performs for guarded routes, PLUS the lease-specific
 * device/subscription checks:
 *
 *   bad signature / expired / wrong typ / tv mismatch / customer disabled
 *     → 401 SESSION_INVALID
 *   no deviceId claim (web login token)
 *     → 401 SESSION_INVALID  (leasing requires a client login)
 *   device missing / REVOKED / sessionJti rotated
 *     → 403 DEVICE_REVOKED
 *   no ACTIVE, unexpired subscription covering the product
 *     → 403 SUBSCRIPTION_EXPIRED
 *
 * Success returns the chosen Subscription id — which IS the shadow
 * AccessKeyRecord id, so the whole quota engine keys off it unchanged.
 */
import { Injectable, Logger } from "@nestjs/common";

import { CustomerTokenService } from "../web/customer-auth/customer-token.service";
import { PrismaService } from "../../shared/prisma/prisma.service";

export type SessionResolution =
  | { ok: true; cardId: string }
  | { ok: false; statusCode: number; error: string; message: string };

@Injectable()
export class SessionTokenResolver {
  private readonly logger = new Logger(SessionTokenResolver.name);

  constructor(
    private readonly customerTokens: CustomerTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async resolve(bearerToken: string, opts: { product?: string } = {}): Promise<SessionResolution> {
    const payload = this.customerTokens.verify(bearerToken);
    if (!payload) {
      return this.deny(401, "SESSION_INVALID", "登录状态无效，请重新登录");
    }

    const customer = await this.prisma.customer.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true, tokenVersion: true },
    });
    if (!customer || customer.status !== "ACTIVE" || customer.tokenVersion !== payload.tv) {
      return this.deny(401, "SESSION_INVALID", "登录状态已失效，请重新登录");
    }

    // Web-surface tokens carry no deviceId — they may browse the portal but must
    // NOT lease upstream tokens. Leasing requires a device-bound client login.
    if (!payload.deviceId) {
      return this.deny(401, "SESSION_INVALID", "请使用客户端登录后再使用（网页登录态不能租用模型）");
    }

    const device = await this.prisma.device.findUnique({
      where: { customerId_deviceId: { customerId: customer.id, deviceId: payload.deviceId } },
      select: { status: true, sessionJti: true },
    });
    if (!device || device.status === "REVOKED" || device.sessionJti !== payload.jti) {
      return this.deny(403, "DEVICE_REVOKED", "设备登录已失效，请在客户端重新登录");
    }

    const now = new Date();
    const subs = await this.prisma.subscription.findMany({
      where: {
        customerId: customer.id,
        status: "ACTIVE",
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true, expiresAt: true, productEntitlements: true },
    });

    const product = String(opts.product || "").trim();
    const covering = subs.filter((s) => {
      if (!product) return true; // product-less call (e.g. report/sr) — any active sub
      return parseProducts(s.productEntitlements).includes(product);
    });
    if (covering.length === 0) {
      return this.deny(403, "SUBSCRIPTION_EXPIRED", "无有效订阅或已到期");
    }

    // Multiple covering subscriptions: pick the longest-lived (null expiry = ∞).
    const best = covering.reduce((a, b) => (expiryMs(b.expiresAt) > expiryMs(a.expiresAt) ? b : a));
    return { ok: true, cardId: best.id };
  }

  /**
   * First-use expiry resync (SessionResolverLike hook, called fire-and-forget
   * by AccessKeyStore OFF the await chain): a migrated never-used card keeps
   * Subscription.expiresAt null until its shadow record arms firstUsedAt +
   * durationMs on the first lease. Persist that effective expiry onto the row
   * so the portal shows a real date and the expiry cron can act on it.
   *
   * Best-effort by contract: guarded by `expiresAt: null` in the where (never
   * clobbers a real expiry; naturally idempotent), failures are logged and
   * never surface into — let alone block — the lease.
   */
  onShadowRecordFirstUse(cardId: string, effectiveExpiresAtIso: string): Promise<void> {
    const ts = Date.parse(String(effectiveExpiresAtIso || ""));
    if (!cardId || !Number.isFinite(ts)) return Promise.resolve();
    return this.prisma.subscription
      .updateMany({
        where: { id: cardId, expiresAt: null },
        data: { expiresAt: new Date(ts) },
      })
      .then((res) => {
        if (res.count > 0) {
          this.logger.log(`first-use expiry resync: subscription ${cardId} expiresAt=${new Date(ts).toISOString()}`);
        }
      })
      .catch((err: any) => {
        this.logger.warn(`first-use expiry resync failed for subscription ${cardId}: ${err?.message || err}`);
      });
  }

  private deny(statusCode: number, error: string, message: string): SessionResolution {
    return { ok: false, statusCode, error, message };
  }
}

function expiryMs(expiresAt: Date | null): number {
  return expiresAt ? expiresAt.getTime() : Number.POSITIVE_INFINITY;
}

function parseProducts(json: string): string[] {
  try {
    const parsed = JSON.parse(String(json || "[]"));
    return Array.isArray(parsed) ? parsed.map((p) => String(p)) : [];
  } catch {
    return [];
  }
}
