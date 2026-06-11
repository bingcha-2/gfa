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

import { PrismaService } from "../prisma/prisma.service";
import { EntitlementSyncService } from "./entitlement-sync.service";

const DAY_MS = 24 * 60 * 60 * 1000;

export function newBackingKeyValue(): string {
  return `sub_${crypto.randomBytes(24).toString("hex")}`; // sub_ + 48 hex chars
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlementSync: EntitlementSyncService,
  ) {}

  /** Convenience for M8: resolve the plan, then createFromPlan. */
  async activateOrExtend(customerId: string, planId: string, opts: { orderId?: string } = {}): Promise<Subscription> {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException(`Plan "${planId}" not found`);
    return this.createFromPlan(customerId, plan, opts);
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
      return (await this.prisma.subscription.findUnique({ where: { id: extended.id } }))!;
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
    const sub = await this.prisma.subscription.create({
      data: {
        customerId,
        planId: plan.id,
        status: "ACTIVE",
        startsAt: now,
        expiresAt: new Date(now.getTime() + durationMs),
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
    // Re-read: the sync persists auto-assigned seat bindings onto the row.
    return (await this.prisma.subscription.findUnique({ where: { id: sub.id } }))!;
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
