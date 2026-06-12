/**
 * subscription.service.ts — subscription lifecycle (purchase activation,
 * extension, expiry/cancellation). Payment itself lives elsewhere (M8 calls
 * activateOrExtend after a confirmed payment); this service never talks to
 * epay.
 *
 * Rules:
 *  (a) An ACTIVE sub with the SAME planId → EXTEND: expiresAt = max(now,
 *      expiresAt) + plan.durationDays. Shadow record + seats are kept; only the
 *      expiry moves (resync).
 *  (b) Other PLAN-BACKED (planId != null) ACTIVE subs whose product sets
 *      intersect the new plan's → CANCELLED + shadow record expired (a customer
 *      holds at most one plan per product). Migrated card subs (planId null)
 *      are NEVER auto-cancelled by purchases.
 *  (c) New sub: id auto-cuid; plan snapshot copied (entitlements/limits/levels/
 *      weight/deviceLimit/weeklyTokenLimit/windowMs); backingKeyValue =
 *      `sub_` + 48 hex chars; shadow record minted via EntitlementSyncService.
 */
import * as crypto from "crypto";

import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Plan, Subscription } from "@prisma/client";

import { PrismaService } from "../../shared/prisma/prisma.service";
import { EntitlementSyncService } from "./entitlement-sync.service";
import { PlanCatalogService } from "../plan-catalog/plan-catalog.service";
import { planColumnsToInitialConfig } from "./subscription-config";

const DAY_MS = 24 * 60 * 60 * 1000;

export function newBackingKeyValue(): string {
  return `sub_${crypto.randomBytes(24).toString("hex")}`; // sub_ + 48 hex chars
}

/** The PlanOrder fields activation needs — works for both plan-based and catalog-based orders. */
export interface OrderForActivation {
  id: string;
  customerId: string;
  planId: string | null;
  config: string | null;
  catalogVersion: number | null;
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
   * Activate a paid order. Branches on the ordering path:
   *  - catalog-based (planId null) → createFromCatalog using the order's config snapshot;
   *  - plan-based    (planId set)  → activateOrExtend(planId) (legacy).
   * Single entry point so epay-callback and billing-reconcile route uniformly. See spec §8.
   */
  async activateForOrder(order: OrderForActivation): Promise<Subscription> {
    if (order.planId == null) {
      return this.createFromCatalog(order);
    }
    return this.activateOrExtend(order.customerId, order.planId, { orderId: order.id });
  }

  /** Convenience for M8: resolve the plan, then createFromPlan. */
  async activateOrExtend(customerId: string, planId: string, opts: { orderId?: string } = {}): Promise<Subscription> {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException(`Plan "${planId}" not found`);
    return this.createFromPlan(customerId, plan, opts);
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
  async createFromCatalog(order: OrderForActivation): Promise<Subscription> {
    if (!order.config) {
      throw new NotFoundException(`Catalog order "${order.id}" has no config snapshot`);
    }
    const customer = await this.prisma.customer.findUnique({
      where: { id: order.customerId },
      select: { id: true, email: true },
    });
    if (!customer) throw new NotFoundException(`Customer "${order.customerId}" not found`);

    const config = JSON.parse(order.config) as Record<string, any>;
    const durationDays = await this.resolveDurationDays(order.catalogVersion);

    const now = new Date();
    const sub = await this.prisma.subscription.create({
      data: {
        customerId: order.customerId,
        planId: null,
        status: "ACTIVE",
        startsAt: now,
        expiresAt: new Date(now.getTime() + durationDays * DAY_MS),
        config: order.config, // computePurchase 快照,单一真相源
        catalogVersion: order.catalogVersion,
        // Legacy 列从 config 派生:productEntitlements 为 NOT NULL,其余供 lease-service 仍读的镜像。
        productEntitlements: JSON.stringify(Array.isArray(config.products) ? config.products : []),
        bucketLimits: config.bucketLimits ? JSON.stringify(config.bucketLimits) : null,
        levels: config.levels ? JSON.stringify(config.levels) : null,
        weight: Number.isFinite(config.weight) ? Number(config.weight) : 1,
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

  async createFromPlan(customerId: string, plan: Plan, opts: { orderId?: string } = {}): Promise<Subscription> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, email: true },
    });
    if (!customer) throw new NotFoundException(`Customer "${customerId}" not found`);

    const now = new Date();
    const durationMs = plan.durationDays * DAY_MS;
    const actives = await this.prisma.subscription.findMany({
      where: { customerId, status: "ACTIVE" },
    });

    // (a) Same plan again → extend from max(now, current expiry).
    const same = actives.find((s) => s.planId === plan.id);
    if (same) {
      const base = Math.max(now.getTime(), same.expiresAt ? same.expiresAt.getTime() : now.getTime());
      const extended = await this.prisma.subscription.update({
        where: { id: same.id },
        data: {
          expiresAt: new Date(base + durationMs),
          // Exact order→sub link (reconcile/refund): the LATEST activating order.
          ...(opts.orderId ? { activatedFromOrderId: opts.orderId } : {}),
        },
      });
      await this.entitlementSync.syncSubscription(extended, { customerEmail: customer.email });
      // sync 可能在 config 里更新了 bindings(绑定线);镜像回 legacy 列供 lease-service。
      const resynced = (await this.prisma.subscription.findUnique({ where: { id: extended.id } }))!;
      return this.mirrorBindingsFromConfig(resynced);
    }

    // (b) Cancel overlapping plan-backed subs. Migrated card subs (planId null)
    // are never auto-cancelled by a purchase.
    const newProducts = parseProducts(plan.productEntitlements);
    for (const sub of actives) {
      if (!sub.planId) continue;
      const overlap = parseProducts(sub.productEntitlements).some((p) => newProducts.includes(p));
      if (!overlap) continue;
      this.logger.log(`createFromPlan: cancelling overlapping subscription ${sub.id} (plan ${sub.planId}) for customer ${customerId}`);
      await this.cancelSubscription(sub.id);
    }

    // (c) Create the new subscription with purchase-time plan snapshots.
    // 去影子:下单即把限额配置快照进 config(单一真相源,含显式 line)。line 据 plan 意图定
    // (配 levels=绑定线、否则号池线),绑定线 bindings 留空待 sync 分配座位 —— 必须在 sync 前写
    // config,因为 syncSubscription 读 config.line 决定走绑定还是号池。catalogVersion:Plan 路径无目录 → null。
    const initialConfig = planColumnsToInitialConfig({
      productEntitlements: plan.productEntitlements,
      bucketLimits: plan.bucketLimits,
      bindings: null,
      levels: plan.levels,
      weight: plan.weight,
      deviceLimit: plan.deviceLimit,
      weeklyTokenLimit: plan.weeklyTokenLimit,
      windowMs: plan.windowMs,
    });
    const sub = await this.prisma.subscription.create({
      data: {
        customerId,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: now,
        expiresAt: new Date(now.getTime() + durationMs),
        config: JSON.stringify(initialConfig),
        productEntitlements: plan.productEntitlements,
        bucketLimits: plan.bucketLimits,
        levels: plan.levels,
        weight: plan.weight,
        deviceLimit: plan.deviceLimit,
        weeklyTokenLimit: plan.weeklyTokenLimit,
        windowMs: plan.windowMs,
        backingKeyValue: newBackingKeyValue(),
        activatedFromOrderId: opts.orderId ?? null,
      },
    });
    await this.entitlementSync.syncSubscription(sub, { customerEmail: customer.email });
    // sync 在 config 里写入了分配到的 bindings(绑定线);镜像回 legacy bindings 列供 lease-service
    // (它仍据 boundAccountId/bindings 列区分号池/绑定,本任务不动它)。
    const synced = (await this.prisma.subscription.findUnique({ where: { id: sub.id } }))!;
    return this.mirrorBindingsFromConfig(synced);
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

function parseProducts(json: string | null): string[] {
  try {
    const parsed = JSON.parse(String(json || "[]"));
    return Array.isArray(parsed) ? parsed.map((p) => String(p)) : [];
  } catch {
    return [];
  }
}
