/**
 * referral.service.spec.ts — unit tests for ReferralService
 *
 * Coverage:
 *   1. getSummary: referralCode, referralLink (WEB_BASE_URL + code), creditCents
 *   2. invitees: ordered newest first; rewarded flag from GRANTED ReferralReward
 *   3. rewards totals: sum of GRANTED amountCents + grantedCount
 *   4. invitee with no reward → rewarded:false; with GRANTED → rewarded:true
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { ReferralService } from "../referral.service";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCustomer(overrides: Partial<{
  id: string;
  referralCode: string;
  creditCents: number;
}> = {}) {
  return {
    id: overrides.id ?? "cust-1",
    referralCode: overrides.referralCode ?? "MYREF123",
    creditCents: overrides.creditCents ?? 0,
  };
}

function makeInvitee(overrides: Partial<{
  id: string;
  email: string;
  createdAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "inv-1",
    email: overrides.email ?? "invitee@test.com",
    createdAt: overrides.createdAt ?? new Date("2026-05-01T00:00:00Z"),
  };
}

function makeReward(overrides: Partial<{
  id: string;
  referrerId: string;
  inviteeId: string;
  amountCents: number;
  status: string;
}> = {}) {
  return {
    id: overrides.id ?? "rew-1",
    referrerId: overrides.referrerId ?? "cust-1",
    inviteeId: overrides.inviteeId ?? "inv-1",
    amountCents: overrides.amountCents ?? 1000,
    status: overrides.status ?? "GRANTED",
  };
}

function makePrisma(opts: {
  customer?: ReturnType<typeof makeCustomer>;
  invitees?: ReturnType<typeof makeInvitee>[];
  rewards?: ReturnType<typeof makeReward>[];
} = {}) {
  const customer = opts.customer ?? makeCustomer();
  const invitees = opts.invitees ?? [];
  const rewards = opts.rewards ?? [];

  return {
    customer: {
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        if (where.id === customer.id) return customer;
        throw new Error("Not found");
      }),
      findMany: vi.fn(async ({ where }: any) => {
        return invitees.filter((inv) => {
          // invitedById is set at the Prisma query level; our mock just returns all
          return true;
        });
      }),
    },
    referralReward: {
      findMany: vi.fn(async ({ where }: any) => {
        return rewards.filter((r) => {
          if (where?.referrerId && r.referrerId !== where.referrerId) return false;
          if (where?.status && r.status !== where.status) return false;
          return true;
        });
      }),
    },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ReferralService.getSummary", () => {
  afterEach(() => {
    delete process.env.WEB_BASE_URL;
  });

  it("returns referralCode from customer", async () => {
    const prisma = makePrisma({
      customer: makeCustomer({ referralCode: "TESTREF" }),
    });
    const service = new ReferralService(prisma as any);

    const result = await service.getSummary("cust-1");

    expect(result.referralCode).toBe("TESTREF");
  });

  it("builds referralLink using WEB_BASE_URL env var", async () => {
    process.env.WEB_BASE_URL = "https://myapp.example.com";
    const prisma = makePrisma({
      customer: makeCustomer({ referralCode: "ABC123" }),
    });
    const service = new ReferralService(prisma as any);

    const result = await service.getSummary("cust-1");

    expect(result.referralLink).toBe("https://myapp.example.com/account/register?ref=ABC123");
  });

  it("referralLink defaults to bcai.lol when WEB_BASE_URL is not set", async () => {
    const prisma = makePrisma({
      customer: makeCustomer({ referralCode: "XYZ" }),
    });
    const service = new ReferralService(prisma as any);

    const result = await service.getSummary("cust-1");

    expect(result.referralLink).toBe("https://bcai.lol/account/register?ref=XYZ");
  });

  it("returns creditCents from customer", async () => {
    const prisma = makePrisma({
      customer: makeCustomer({ creditCents: 2500 }),
    });
    const service = new ReferralService(prisma as any);

    const result = await service.getSummary("cust-1");

    expect(result.creditCents).toBe(2500);
  });

  it("returns empty invitees and zero rewards when no invitees", async () => {
    const prisma = makePrisma({ invitees: [], rewards: [] });
    const service = new ReferralService(prisma as any);

    const result = await service.getSummary("cust-1");

    expect(result.invitees).toHaveLength(0);
    expect(result.rewards.totalCents).toBe(0);
    expect(result.rewards.grantedCount).toBe(0);
  });

  it("invitee with no GRANTED reward has rewarded:false", async () => {
    const invitee = makeInvitee({ id: "inv-1", email: "a@test.com" });
    const prisma = makePrisma({ invitees: [invitee], rewards: [] });
    const service = new ReferralService(prisma as any);

    const result = await service.getSummary("cust-1");

    expect(result.invitees[0].rewarded).toBe(false);
  });

  it("invitee with matching GRANTED reward has rewarded:true", async () => {
    const invitee = makeInvitee({ id: "inv-1", email: "a@test.com" });
    const reward = makeReward({ referrerId: "cust-1", inviteeId: "inv-1", status: "GRANTED" });
    const prisma = makePrisma({ invitees: [invitee], rewards: [reward] });
    const service = new ReferralService(prisma as any);

    const result = await service.getSummary("cust-1");

    expect(result.invitees[0].rewarded).toBe(true);
  });

  it("rewards.totalCents sums all GRANTED reward amounts", async () => {
    const invitees = [
      makeInvitee({ id: "inv-1" }),
      makeInvitee({ id: "inv-2" }),
    ];
    const rewards = [
      makeReward({ inviteeId: "inv-1", amountCents: 1000, status: "GRANTED" }),
      makeReward({ id: "rew-2", inviteeId: "inv-2", amountCents: 500, status: "GRANTED" }),
    ];
    const prisma = makePrisma({ invitees, rewards });
    const service = new ReferralService(prisma as any);

    const result = await service.getSummary("cust-1");

    expect(result.rewards.totalCents).toBe(1500);
    expect(result.rewards.grantedCount).toBe(2);
  });

  it("invitee registeredAt is an ISO string", async () => {
    const registeredAt = new Date("2026-04-15T12:00:00Z");
    const invitee = makeInvitee({ createdAt: registeredAt });
    const prisma = makePrisma({ invitees: [invitee] });
    const service = new ReferralService(prisma as any);

    const result = await service.getSummary("cust-1");

    expect(result.invitees[0].registeredAt).toBe(registeredAt.toISOString());
  });

  it("invitee shape includes email, registeredAt, rewarded", async () => {
    const invitee = makeInvitee({ id: "inv-1", email: "invitee@example.com" });
    const prisma = makePrisma({ invitees: [invitee] });
    const service = new ReferralService(prisma as any);

    const result = await service.getSummary("cust-1");

    const inv = result.invitees[0];
    expect(inv).toHaveProperty("email");
    expect(inv).toHaveProperty("registeredAt");
    expect(inv).toHaveProperty("rewarded");
    expect(Object.keys(inv)).toHaveLength(3);
  });
});
