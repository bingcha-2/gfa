/**
 * subscription.service.ts — subscription lifecycle (purchase activation,
 * extension, expiry/cancellation). Payment itself lives elsewhere (the epay
 * callback / reconcile call activateForOrder after a confirmed payment); this
 * service never talks to epay.
 *
 * Catalog-only lifecycle (the legacy Plan table and plan-based path are gone):
 *  (a) A paid order carries a computePurchase config snapshot (含显式 line) +
 *      catalogVersion. activateForOrder → createFromCatalog writes that config
 *      verbatim into Subscription.config (single source of truth) and resolves
 *      the validity window from the catalog version's durationDays.
 *  (b) Same-config再买 (config 指纹命中一条 ACTIVE 订阅) → EXTEND: expiresAt =
 *      max(now, expiresAt) + durationDays, reusing the shadow record + seats.
 *      不同配置 → 新建并存订阅(catalog purchases NEVER auto-cancel anything).
 *  (c) New sub: id auto-cuid; config snapshot + legacy mirror columns written;
 *      backingKeyValue = `sub_` + 48 hex chars; shadow record minted via
 *      EntitlementSyncService (bind line assigns seats → config.bindings).
 */
import * as crypto from "crypto";

import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Subscription } from "@prisma/client";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { EntitlementSyncService } from "./entitlement-sync.service";
import { PlanCatalogService } from "../plan-catalog/plan-catalog.service";
import { sameConfigFingerprint } from "./config-fingerprint";
import { rowToConfig } from "./subscription-config";

const DAY_MS = 24 * 60 * 60 * 1000;

export function newBackingKeyValue(): string {
  return `sub_${crypto.randomBytes(24).toString("hex")}`; // sub_ + 48 hex chars
}

/** The PlanOrder fields catalog activation needs. */
export interface OrderForActivation {
  id: string;
  customerId: string;
  config: string | null;
  catalogVersion: number | null;
}

export interface ActivationOptions {
  durationDaysOverride?: number;
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlementSync: EntitlementSyncService,
    private readonly planCatalog: PlanCatalogService,
  ) {}

  /**
   * Activate a paid order. Catalog-only: every order carries a config snapshot —
   * route straight to createFromCatalog. Single entry point so epay-callback and
   * billing-reconcile activate uniformly. See spec §8.
   */
  async activateForOrder(order: OrderForActivation, options: ActivationOptions = {}): Promise<Subscription> {
    return this.createFromCatalog(order, options);
  }

  /**
   * Catalog-based activation (spec §8): the order already carries the
   * computePurchase config snapshot (含显式 line) + catalogVersion. We write that
   * config verbatim into Subscription.config (single source of truth), resolve the
   * validity window from the catalog version's durationDays, mint a backing key,
   * then sync (bind line assigns seats → config.bindings; pool line skips seats).
   *
   * 不同配置再买默认并存(新建订阅);"同配置续费"(config 指纹去重延长)留后,见 spec §8。
   */
  async createFromCatalog(order: OrderForActivation, options: ActivationOptions = {}): Promise<Subscription> {
    if (!order.config) {
      throw new NotFoundException(`Catalog order "${order.id}" has no config snapshot`);
    }
    const customer = await this.prisma.customer.findUnique({
      where: { id: order.customerId },
      select: { id: true, email: true },
    });
    if (!customer) throw new NotFoundException(`Customer "${order.customerId}" not found`);

    const config = JSON.parse(order.config) as Record<string, any>;
    const durationDays = this.resolveDurationDaysOverride(options.durationDaysOverride)
      ?? await this.resolveDurationDays(order.catalogVersion);

    const now = new Date();
    const durationMs = durationDays * DAY_MS;

    // 同配置续费(spec §8):命中一条 config 等价的 ACTIVE 订阅 → 延长 expiresAt 复用,
    // 不新建。判断键 = sameConfigFingerprint(line + 排序后 products + deviceLimit +
    // 用量/levels+weight),排除 bindings(座位分配结果)与 windowMs(锁死)。绑定线续期
    // 走 syncSubscription:它对已绑产品短路复用,不重分配座位、不占新份额。
    const actives = await this.prisma.subscription.findMany({
      where: { customerId: order.customerId, status: "ACTIVE" },
    });
    const same = actives.find((s) => sameConfigFingerprint(parseConfig(s.config), config));
    if (same) {
      const base = Math.max(now.getTime(), same.expiresAt ? same.expiresAt.getTime() : now.getTime());
      const renewalConfig = mergeRenewalConfig(rowToConfig(same as any) as Record<string, any>, config);
      const extended = await this.prisma.subscription.update({
        where: { id: same.id },
        data: {
          expiresAt: new Date(base + durationMs),
          catalogVersion: order.catalogVersion,
          config: JSON.stringify(renewalConfig),
          productEntitlements: JSON.stringify(Array.isArray(renewalConfig.products) ? renewalConfig.products : []),
          bucketLimits: renewalConfig.bucketLimits ? JSON.stringify(renewalConfig.bucketLimits) : null,
          levels: renewalConfig.levels ? JSON.stringify(renewalConfig.levels) : null,
          weight: Number.isFinite(renewalConfig.shareSeats) ? Number(renewalConfig.shareSeats) : Number(renewalConfig.weight || 1),
          deviceLimit: Number.isFinite(renewalConfig.deviceLimit) ? Number(renewalConfig.deviceLimit) : 1,
          weeklyTokenLimit: Number.isFinite(renewalConfig.weeklyTokenLimit) ? Number(renewalConfig.weeklyTokenLimit) : null,
          windowMs: Number.isFinite(renewalConfig.windowMs) ? Number(renewalConfig.windowMs) : 18_000_000,
          // 订单链移到最新一单(对账/退款)。
          activatedFromOrderId: order.id,
        },
      });
      await this.entitlementSync.syncSubscription(extended, { customerEmail: customer.email });
      const resynced = (await this.prisma.subscription.findUnique({ where: { id: extended.id } }))!;
      return this.mirrorBindingsFromConfig(resynced);
    }

    const sub = await this.prisma.subscription.create({
      data: {
        customerId: order.customerId,
        status: "ACTIVE",
        startsAt: now,
        expiresAt: new Date(now.getTime() + durationMs),
        config: order.config, // computePurchase 快照,单一真相源
        catalogVersion: order.catalogVersion,
        // Legacy 列从 config 派生:productEntitlements 为 NOT NULL,其余供 lease-service 仍读的镜像。
        productEntitlements: JSON.stringify(Array.isArray(config.products) ? config.products : []),
        bucketLimits: config.bucketLimits ? JSON.stringify(config.bucketLimits) : null,
        levels: config.levels ? JSON.stringify(config.levels) : null,
        weight: Number.isFinite(config.shareSeats) ? Number(config.shareSeats) : Number(config.weight || 1),
        deviceLimit: Number.isFinite(config.deviceLimit) ? Number(config.deviceLimit) : 1,
        weeklyTokenLimit: Number.isFinite(config.weeklyTokenLimit) ? Number(config.weeklyTokenLimit) : null,
        windowMs: Number.isFinite(config.windowMs) ? Number(config.windowMs) : 18_000_000,
        backingKeyValue: newBackingKeyValue(),
        activatedFromOrderId: order.id,
      },
    });
    await this.entitlementSync.syncSubscription(sub, { customerEmail: customer.email });
    // sync 在 config 里写入了分配到的 bindings(绑定线);镜像回 legacy bindings 列供 lease-service。
    const synced = (await this.prisma.subscription.findUnique({ where: { id: sub.id } }))!;
    return this.mirrorBindingsFromConfig(synced);
  }

  /** 解析该版 catalog 的 durationDays(版本不可变,溯源稳定);缺则抛错(无法确定有效期)。 */
  private async resolveDurationDays(catalogVersion: number | null): Promise<number> {
    if (catalogVersion == null) {
      throw new NotFoundException(`Catalog order missing catalogVersion — cannot resolve duration`);
    }
    const catalog = await this.planCatalog.getByVersion(catalogVersion);
    const days = catalog?.config?.durationDays;
    if (!Number.isFinite(days) || days <= 0) {
      throw new NotFoundException(`PlanCatalog version ${catalogVersion} has no valid durationDays`);
    }
    return Number(days);
  }

  private resolveDurationDaysOverride(days: number | undefined): number | null {
    if (days === undefined) return null;
    if (!Number.isInteger(days) || days <= 0) return null;
    return days;
  }

  /**
   * 把 config.bindings(sync 写入的座位结果,单一真相源)镜像回 legacy bindings 列。
   * lease-service 仍读 bindings 列判号池/绑定(本任务不动它),故下单后保持两者一致。
   * 号池线 config 无 bindings → 列写 null(保持号池语义)。
   */
  private async mirrorBindingsFromConfig(sub: Subscription): Promise<Subscription> {
    let bindings: Record<string, number> = {};
    try {
      const config = JSON.parse(String(sub.config || "{}"));
      if (config?.line === "bind" && config.bindings && typeof config.bindings === "object") {
        bindings = config.bindings;
      }
    } catch {
      // malformed config → leave bindings empty (pool semantics).
    }
    const mirrored = Object.keys(bindings).length > 0 ? JSON.stringify(bindings) : null;
    if (mirrored === (sub.bindings ?? null)) return sub; // no change
    return this.prisma.subscription.update({
      where: { id: sub.id },
      data: { bindings: mirrored },
    });
  }

  /** Natural expiry: status EXPIRED + shadow record expired (usage retained). */
  async expireSubscription(id: string): Promise<Subscription> {
    const sub = await this.prisma.subscription.update({
      where: { id },
      data: { status: "EXPIRED" },
    });
    this.entitlementSync.expireShadowRecord(id);
    return sub;
  }

  /** Cancellation (superseded by a new plan, or manual): status CANCELLED. */
  async cancelSubscription(id: string): Promise<Subscription> {
    const sub = await this.prisma.subscription.update({
      where: { id },
      data: { status: "CANCELLED" },
    });
    this.entitlementSync.expireShadowRecord(id);
    return sub;
  }
}

/** Parse a subscription's config JSON into an object (empty on malformed). */
function parseConfig(json: string | null): Record<string, any> {
  try {
    const parsed = JSON.parse(String(json || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergeRenewalConfig(existing: Record<string, any>, next: Record<string, any>): Record<string, any> {
  const merged = { ...next };
  if (existing.bindings && typeof existing.bindings === "object" && !Array.isArray(existing.bindings)) {
    merged.bindings = existing.bindings;
  }
  if (
    existing.displayBindings &&
    typeof existing.displayBindings === "object" &&
    !Array.isArray(existing.displayBindings)
  ) {
    merged.displayBindings = existing.displayBindings;
  }
  return merged;
}
