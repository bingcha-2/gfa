import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../../shared/prisma/prisma.service";

function webBaseUrl(): string {
  return process.env.WEB_BASE_URL ?? "https://bcai.lol";
}

@Injectable()
export class ReferralService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Referral summary ───────────────────────────────────────────────────────

  async getSummary(customerId: string) {
    const [customer, invitees, rewards] = await Promise.all([
      this.prisma.customer.findUniqueOrThrow({
        where: { id: customerId },
        select: { referralCode: true, creditCents: true },
      }),
      // Customers who were invited by this customer
      this.prisma.customer.findMany({
        where: { invitedById: customerId },
        orderBy: { createdAt: "desc" },
        select: { id: true, email: true, createdAt: true },
      }),
      // All GRANTED rewards for this referrer
      this.prisma.referralReward.findMany({
        where: { referrerId: customerId, status: "GRANTED" },
        select: { inviteeId: true, amountCents: true },
      }),
    ]);

    const referralCode = customer.referralCode;
    const referralLink = `${webBaseUrl()}/account/register?ref=${referralCode}`;

    // Build a set of rewarded invitee ids for O(1) lookup
    const rewardedInviteeIds = new Set(rewards.map((r) => r.inviteeId));

    const inviteeViews = invitees.map((inv) => ({
      email: inv.email,
      registeredAt: inv.createdAt.toISOString(),
      rewarded: rewardedInviteeIds.has(inv.id),
    }));

    const totalCents = rewards.reduce((sum, r) => sum + r.amountCents, 0);
    const grantedCount = rewards.length;

    return {
      referralCode,
      referralLink,
      invitees: inviteeViews,
      rewards: {
        totalCents,
        grantedCount,
      },
      creditCents: customer.creditCents,
    };
  }
}
