/**
 * customer-admin.service.ts — console-side customer management:
 * paginated/searchable list (with aggregates), detail (with subscriptions /
 * orders / devices), enable-disable + profile edit, and manual subscription
 * grant.
 *
 * Security: every read goes through an explicit field whitelist — passwordHash
 * and tokenVersion are NEVER returned. Disabling a customer bumps tokenVersion
 * so all their existing JWTs are revoked (forced logout).
 */
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { SubscriptionService } from "../../subscription/subscription.service";
import { UpdateCustomerDto } from "./dto/customer-admin.dto";

export interface ListCustomersParams {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
}

@Injectable()
export class CustomerAdminService {
  private readonly logger = new Logger(CustomerAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  /**
   * Paginated customer list with per-row aggregates (active subscriptions,
   * order count, total paid, active device count). Aggregates are batched into
   * groupBy queries over the page's ids — no N+1.
   */
  async listCustomers(params: ListCustomersParams) {
    const page = Number.isFinite(params.page) ? Math.max(1, Math.floor(params.page)) : 1;
    const pageSize = Number.isFinite(params.pageSize)
      ? Math.min(100, Math.max(1, Math.floor(params.pageSize)))
      : 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.CustomerWhereInput = {};
    if (params.status === "ACTIVE" || params.status === "DISABLED") {
      where.status = params.status;
    }
    const search = params.search?.trim();
    if (search) {
      where.OR = [
        { email: { contains: search } },
        { displayName: { contains: search } },
        { referralCode: { contains: search } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        select: {
          id: true,
          email: true,
          status: true,
          emailVerified: true,
          displayName: true,
          referralCode: true,
          creditCents: true,
          createdAt: true,
          invitedById: true,
          _count: { select: { planOrders: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.customer.count({ where }),
    ]);

    const ids = rows.map((r) => r.id);
    const subMap = new Map<string, number>();
    const paidMap = new Map<string, number>();
    const devMap = new Map<string, number>();

    if (ids.length > 0) {
      const [activeSubs, paidAgg, activeDevices] = await Promise.all([
        this.prisma.subscription.groupBy({
          by: ["customerId"],
          where: { customerId: { in: ids }, status: "ACTIVE" },
          _count: true,
        }),
        this.prisma.planOrder.groupBy({
          by: ["customerId"],
          where: { customerId: { in: ids }, status: "PAID" },
          _sum: { amountCents: true },
        }),
        this.prisma.device.groupBy({
          by: ["customerId"],
          where: { customerId: { in: ids }, status: "ACTIVE" },
          _count: true,
        }),
      ]);
      for (const s of activeSubs) subMap.set(s.customerId, s._count);
      for (const p of paidAgg) paidMap.set(p.customerId, p._sum.amountCents ?? 0);
      for (const d of activeDevices) devMap.set(d.customerId, d._count);
    }

    const customers = rows.map((r) => ({
      id: r.id,
      email: r.email,
      status: r.status,
      emailVerified: r.emailVerified,
      displayName: r.displayName,
      referralCode: r.referralCode,
      creditCents: r.creditCents,
      createdAt: r.createdAt,
      invitedById: r.invitedById,
      orderCount: r._count.planOrders,
      activeSubscriptions: subMap.get(r.id) ?? 0,
      totalPaidCents: paidMap.get(r.id) ?? 0,
      deviceCount: devMap.get(r.id) ?? 0,
    }));

    return { customers, total, page, pageSize };
  }

  /** Customer detail with inlined subscriptions / orders / devices. */
  async getCustomer(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        status: true,
        emailVerified: true,
        displayName: true,
        referralCode: true,
        creditCents: true,
        invitedById: true,
        createdAt: true,
        updatedAt: true,
        subscriptions: {
          select: {
            id: true,
            planId: true,
            status: true,
            startsAt: true,
            expiresAt: true,
            productEntitlements: true,
            weight: true,
            deviceLimit: true,
            createdAt: true,
            plan: { select: { name: true } },
          },
          orderBy: { createdAt: "desc" },
        },
        planOrders: {
          select: {
            id: true,
            outTradeNo: true,
            amountCents: true,
            payChannel: true,
            status: true,
            paidAt: true,
            createdAt: true,
            plan: { select: { name: true } },
          },
          orderBy: { createdAt: "desc" },
        },
        devices: {
          select: {
            id: true,
            deviceId: true,
            name: true,
            platform: true,
            status: true,
            lastSeenAt: true,
            lastIp: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!customer) throw new NotFoundException(`Customer "${id}" not found`);
    return customer;
  }

  /**
   * Enable/disable + profile edit. Disabling bumps tokenVersion (revokes all
   * existing JWTs → forced logout). Returns the whitelisted row.
   */
  async updateCustomer(id: string, dto: UpdateCustomerDto) {
    const existing = await this.prisma.customer.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException(`Customer "${id}" not found`);

    const data: Prisma.CustomerUpdateInput = {};
    if (dto.status !== undefined) {
      data.status = dto.status;
      if (dto.status === "DISABLED" && existing.status !== "DISABLED") {
        data.tokenVersion = { increment: 1 };
      }
    }
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.creditCents !== undefined) data.creditCents = dto.creditCents;

    const updated = await this.prisma.customer.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        status: true,
        emailVerified: true,
        displayName: true,
        referralCode: true,
        creditCents: true,
        createdAt: true,
        invitedById: true,
      },
    });

    this.logger.log(`[customer-admin] customer ${id} updated (${JSON.stringify(dto)})`);
    return updated;
  }

  /**
   * Manually grant a subscription (bypasses payment). Reuses
   * SubscriptionService.activateOrExtend — validates the plan, cancels
   * overlapping plan-backed subs, mints the shadow record.
   */
  async grantSubscription(id: string, planId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException(`Customer "${id}" not found`);

    const sub = await this.subscriptionService.activateOrExtend(id, planId, {});
    this.logger.log(`[customer-admin] granted subscription ${sub.id} (plan ${planId}) to customer ${id}`);
    return sub;
  }
}
