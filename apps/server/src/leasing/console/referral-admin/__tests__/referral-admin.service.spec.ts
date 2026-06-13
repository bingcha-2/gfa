/**
 * referral-admin.service.spec.ts — console referral-reward query against the
 * real Prisma test db. ReferralReward has no Prisma relations, so the service
 * resolves referrer/invitee emails + order numbers via batched lookups; this
 * suite asserts that resolution. cleanCustomerTables does NOT touch
 * ReferralReward, so it is cleared here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ReferralAdminService } from "../referral-admin.service";
import {
  cleanCustomerTables,
  createTestCustomer,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../../../shared/__tests__/customer-test-db";

const prisma = getCustomerPrisma();
let seq = 0;
let service: ReferralAdminService;

async function createOrder(customerId: string) {
  return prisma.planOrder.create({
    data: {
      customerId,
      amountCents: 9900,
      payChannel: "ALIPAY",
      outTradeNo: `OT${Date.now()}${++seq}`,
      status: "PAID",
      paidAt: new Date(),
      catalogVersion: 1,
      config: JSON.stringify({ line: "pool", products: ["antigravity"] }),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
}

async function createReward(referrerId: string, inviteeId: string, planOrderId: string, status = "GRANTED") {
  return prisma.referralReward.create({
    data: { referrerId, inviteeId, planOrderId, amountCents: 1000, status: status as any },
  });
}

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await prisma.referralReward.deleteMany();
  await cleanCustomerTables();
  service = new ReferralAdminService(prisma as any);
});

afterAll(async () => {
  await prisma.referralReward.deleteMany();
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

describe("ReferralAdminService.listRewards", () => {
  it("resolves referrer / invitee emails + order number", async () => {
    const referrer = await createTestCustomer({ email: "ref@reward.test" });
    const invitee = await createTestCustomer({ email: "inv@reward.test" });
    const order = await createOrder(invitee.id);
    await createReward(referrer.id, invitee.id, order.id);

    const result = await service.listRewards({ page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
    const r = result.rewards[0];
    expect(r.referrerEmail).toBe("ref@reward.test");
    expect(r.inviteeEmail).toBe("inv@reward.test");
    expect(r.outTradeNo).toBe(order.outTradeNo);
    expect(r.amountCents).toBe(1000);
  });

  it("filters by status", async () => {
    const referrer = await createTestCustomer();
    const invitee = await createTestCustomer();
    const o1 = await createOrder(invitee.id);
    const o2 = await createOrder(invitee.id);
    await createReward(referrer.id, invitee.id, o1.id, "GRANTED");
    await createReward(referrer.id, invitee.id, o2.id, "REVOKED");

    const granted = await service.listRewards({ page: 1, pageSize: 20, status: "GRANTED" });
    expect(granted.total).toBe(1);
    expect(granted.rewards[0].status).toBe("GRANTED");
  });

  it("searches by referrer email", async () => {
    const alice = await createTestCustomer({ email: "alice@ref.test" });
    const bob = await createTestCustomer({ email: "bob@ref.test" });
    const invitee = await createTestCustomer();
    const o1 = await createOrder(invitee.id);
    const o2 = await createOrder(invitee.id);
    await createReward(alice.id, invitee.id, o1.id);
    await createReward(bob.id, invitee.id, o2.id);

    const result = await service.listRewards({ page: 1, pageSize: 20, search: "alice@ref" });
    expect(result.total).toBe(1);
    expect(result.rewards[0].referrerEmail).toBe("alice@ref.test");
  });
});
