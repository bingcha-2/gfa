/**
 * referral-admin.service.ts — console-side referral-reward query. ReferralReward
 * stores bare ids (no Prisma relations), so referrer/invitee emails and the
 * order number are resolved with batched lookups over the page.
 */
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../../shared/prisma/prisma.service";

@Injectable()
export class ReferralAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listRewards(params: {
    page: number;
    pageSize: number;
    status?: string;
    search?: string;
  }) {
    const page = Number.isFinite(params.page) ? Math.max(1, Math.floor(params.page)) : 1;
    const pageSize = Number.isFinite(params.pageSize)
      ? Math.min(100, Math.max(1, Math.floor(params.pageSize)))
      : 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.ReferralRewardWhereInput = {};
    const status = params.status?.trim();
    if (status === "PENDING" || status === "GRANTED" || status === "REVOKED") {
      where.status = status;
    }
    // Search by referrer email → resolve to ids first.
    const search = params.search?.trim();
    if (search) {
      const matched = await this.prisma.customer.findMany({
        where: { email: { contains: search } },
        select: { id: true },
      });
      where.referrerId = { in: matched.map((m) => m.id) };
    }

    const [rows, total] = await Promise.all([
      this.prisma.referralReward.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.referralReward.count({ where }),
    ]);

    // Batch-resolve referrer/invitee emails + order numbers.
    const custIds = [...new Set(rows.flatMap((r) => [r.referrerId, r.inviteeId]))];
    const orderIds = rows.map((r) => r.planOrderId);
    const [custs, orders] = await Promise.all([
      custIds.length
        ? this.prisma.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, email: true } })
        : Promise.resolve([]),
      orderIds.length
        ? this.prisma.planOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, outTradeNo: true } })
        : Promise.resolve([]),
    ]);
    const emailMap = new Map(custs.map((c) => [c.id, c.email]));
    const orderMap = new Map(orders.map((o) => [o.id, o.outTradeNo]));

    const rewards = rows.map((r) => ({
      id: r.id,
      status: r.status,
      amountCents: r.amountCents,
      createdAt: r.createdAt,
      referrerId: r.referrerId,
      referrerEmail: emailMap.get(r.referrerId) ?? null,
      inviteeId: r.inviteeId,
      inviteeEmail: emailMap.get(r.inviteeId) ?? null,
      planOrderId: r.planOrderId,
      outTradeNo: orderMap.get(r.planOrderId) ?? null,
    }));

    return { rewards, total, page, pageSize };
  }
}
