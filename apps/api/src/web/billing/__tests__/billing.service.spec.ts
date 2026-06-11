/**
 * billing.service.spec.ts — BillingService unit tests (mocked Prisma).
 *
 * Focus: order create, get, list, subscriptions list — no real DB needed.
 */
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingService } from "../billing.service";
import { NotFoundException, BadRequestException } from "@nestjs/common";

// Minimal Prisma mock factory
function makeMockPrisma(overrides: Record<string, any> = {}) {
  return {
    plan: {
      findUnique: vi.fn(),
    },
    customer: {
      findUnique: vi.fn(),
    },
    planOrder: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    subscription: {
      findMany: vi.fn(),
    },
    ...overrides,
  } as any;
}

const fixedPlan = {
  id: "plan-1",
  name: "Pro 月卡",
  priceCents: 990,
  durationDays: 30,
  productEntitlements: JSON.stringify(["antigravity"]),
  active: true,
};

const fixedCustomer = {
  id: "cust-1",
  invitedById: "referrer-1",
};

function buildService(prisma: any) {
  return new BillingService(prisma);
}

describe("BillingService.createOrder", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let service: BillingService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = buildService(prisma);

    prisma.plan.findUnique.mockResolvedValue(fixedPlan);
    prisma.customer.findUnique.mockResolvedValue(fixedCustomer);
    prisma.planOrder.create.mockImplementation(async ({ data }: any) => ({
      id: "order-id-1",
      outTradeNo: data.outTradeNo,
      amountCents: data.amountCents,
      payChannel: data.payChannel,
      status: "PENDING",
      expiresAt: data.expiresAt,
      referrerId: data.referrerId,
      createdAt: new Date(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a PENDING order with correct amountCents and referrerId snapshot", async () => {
    const result = await service.createOrder("cust-1", "plan-1", "ALIPAY");

    expect(prisma.planOrder.create).toHaveBeenCalledOnce();
    const createArg = prisma.planOrder.create.mock.calls[0][0].data;
    expect(createArg.customerId).toBe("cust-1");
    expect(createArg.planId).toBe("plan-1");
    expect(createArg.status).toBe("PENDING");
    expect(createArg.amountCents).toBe(990);
    expect(createArg.payChannel).toBe("ALIPAY");
    expect(createArg.referrerId).toBe("referrer-1"); // snapshot from customer.invitedById

    // expiresAt is ~30 minutes from now
    const nowMs = Date.now();
    const expiresMs = createArg.expiresAt.getTime();
    expect(expiresMs - nowMs).toBeGreaterThan(29 * 60 * 1000);
    expect(expiresMs - nowMs).toBeLessThan(31 * 60 * 1000);
  });

  it("returns qrDataUri starting with 'data:image/png;base64,'", async () => {
    const result = await service.createOrder("cust-1", "plan-1", "ALIPAY");
    expect(result.qrDataUri).toMatch(/^data:image\/png;base64,/);
  });

  it("formats money correctly: 990 cents → '9.90'", async () => {
    await service.createOrder("cust-1", "plan-1", "ALIPAY");
    const createArg = prisma.planOrder.create.mock.calls[0][0].data;
    // Check the payUrl includes money=9.90
    // We need to verify the payUrl was built with "9.90"
    const result = await service.createOrder("cust-1", "plan-1", "ALIPAY");
    expect(result.payUrl).toContain("money=9.90");
  });

  it("formats money correctly: 10000 cents → '100.00'", async () => {
    prisma.plan.findUnique.mockResolvedValue({ ...fixedPlan, priceCents: 10000 });
    const result = await service.createOrder("cust-1", "plan-1", "ALIPAY");
    expect(result.payUrl).toContain("money=100.00");
  });

  it("payUrl contains 'sign=' query parameter", async () => {
    const result = await service.createOrder("cust-1", "plan-1", "ALIPAY");
    expect(result.payUrl).toMatch(/sign=[0-9a-f]{32}/);
  });

  it("payUrl uses type=alipay for ALIPAY channel", async () => {
    const result = await service.createOrder("cust-1", "plan-1", "ALIPAY");
    expect(result.payUrl).toContain("type=alipay");
  });

  it("payUrl uses type=wxpay for WXPAY channel", async () => {
    const result = await service.createOrder("cust-1", "plan-1", "WXPAY");
    expect(result.payUrl).toContain("type=wxpay");
  });

  it("returns expiresAt as ISO string", async () => {
    const result = await service.createOrder("cust-1", "plan-1", "ALIPAY");
    expect(() => new Date(result.expiresAt)).not.toThrow();
    expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("referrerId null when customer has no invitedById", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", invitedById: null });
    await service.createOrder("cust-1", "plan-1", "ALIPAY");
    const createArg = prisma.planOrder.create.mock.calls[0][0].data;
    expect(createArg.referrerId).toBeNull();
  });

  it("throws NotFoundException when plan not found", async () => {
    prisma.plan.findUnique.mockResolvedValue(null);
    await expect(service.createOrder("cust-1", "plan-bad", "ALIPAY")).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException when plan is inactive", async () => {
    prisma.plan.findUnique.mockResolvedValue({ ...fixedPlan, active: false });
    await expect(service.createOrder("cust-1", "plan-1", "ALIPAY")).rejects.toThrow(BadRequestException);
  });
});

describe("BillingService.getOrder", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let service: BillingService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = buildService(prisma);
  });

  it("returns order fields for matching customer", async () => {
    prisma.planOrder.findUnique.mockResolvedValue({
      outTradeNo: "gfa123",
      customerId: "cust-1",
      status: "PAID",
      paidAt: new Date("2026-01-01T00:00:00Z"),
      subscriptionId: "sub-1",
    });
    const result = await service.getOrder("cust-1", "gfa123");
    expect(result.outTradeNo).toBe("gfa123");
    expect(result.status).toBe("PAID");
    expect(result.paidAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.subscriptionId).toBe("sub-1");
  });

  it("throws NotFoundException when outTradeNo does not exist", async () => {
    prisma.planOrder.findUnique.mockResolvedValue(null);
    await expect(service.getOrder("cust-1", "gfa-nonexistent")).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException for ownership mismatch (other customer's order)", async () => {
    prisma.planOrder.findUnique.mockResolvedValue({
      outTradeNo: "gfa123",
      customerId: "OTHER-CUST",
      status: "PENDING",
      paidAt: null,
      subscriptionId: null,
    });
    await expect(service.getOrder("cust-1", "gfa123")).rejects.toThrow(NotFoundException);
  });

  it("paidAt is null when order not paid", async () => {
    prisma.planOrder.findUnique.mockResolvedValue({
      outTradeNo: "gfa123",
      customerId: "cust-1",
      status: "PENDING",
      paidAt: null,
      subscriptionId: null,
    });
    const result = await service.getOrder("cust-1", "gfa123");
    expect(result.paidAt).toBeNull();
    expect(result.subscriptionId).toBeNull();
  });
});

describe("BillingService.listOrders", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let service: BillingService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = buildService(prisma);
  });

  it("returns paginated orders with total", async () => {
    const now = new Date();
    prisma.planOrder.findMany.mockResolvedValue([
      {
        outTradeNo: "gfa1",
        plan: { name: "Pro 月卡" },
        amountCents: 990,
        payChannel: "ALIPAY",
        status: "PAID",
        createdAt: now,
        paidAt: now,
      },
    ]);
    prisma.planOrder.count.mockResolvedValue(5);

    const result = await service.listOrders("cust-1", 1, 10);
    expect(result.total).toBe(5);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].planName).toBe("Pro 月卡");
    expect(result.orders[0].outTradeNo).toBe("gfa1");
    expect(result.orders[0].paidAt).toBe(now.toISOString());
  });

  it("passes skip/take correctly for page 2, pageSize 5", async () => {
    prisma.planOrder.findMany.mockResolvedValue([]);
    prisma.planOrder.count.mockResolvedValue(0);
    await service.listOrders("cust-1", 2, 5);
    const callArgs = prisma.planOrder.findMany.mock.calls[0][0];
    expect(callArgs.skip).toBe(5);  // (2-1) * 5
    expect(callArgs.take).toBe(5);
  });

  it("scopes to customerId only", async () => {
    prisma.planOrder.findMany.mockResolvedValue([]);
    prisma.planOrder.count.mockResolvedValue(0);
    await service.listOrders("cust-1", 1, 10);
    const callArgs = prisma.planOrder.findMany.mock.calls[0][0];
    expect(callArgs.where.customerId).toBe("cust-1");
  });
});

describe("BillingService.listSubscriptions", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let service: BillingService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = buildService(prisma);
  });

  it("maps subscriptions with planName and parsed products", async () => {
    const expiry = new Date("2026-12-31T00:00:00Z");
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: "sub-1",
        planId: "plan-1",
        plan: { name: "Pro 月卡" },
        status: "ACTIVE",
        productEntitlements: JSON.stringify(["antigravity", "codex"]),
        expiresAt: expiry,
        deviceLimit: 3,
        weight: 2,
      },
    ]);
    const result = await service.listSubscriptions("cust-1");
    expect(result.subscriptions).toHaveLength(1);
    const sub = result.subscriptions[0];
    expect(sub.id).toBe("sub-1");
    expect(sub.planName).toBe("Pro 月卡");
    expect(sub.status).toBe("ACTIVE");
    expect(sub.products).toEqual(["antigravity", "codex"]);
    expect(sub.expiresAt).toBe("2026-12-31T00:00:00.000Z");
    expect(sub.deviceLimit).toBe(3);
    expect(sub.weight).toBe(2);
    expect(sub.migratedFromCard).toBe(false);
  });

  it("planId null → planName null + migratedFromCard true + products parsed", async () => {
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: "sub-mig",
        planId: null,
        plan: null,
        status: "ACTIVE",
        productEntitlements: JSON.stringify(["antigravity"]),
        expiresAt: null,
        deviceLimit: 1,
        weight: 1,
      },
    ]);
    const result = await service.listSubscriptions("cust-1");
    const sub = result.subscriptions[0];
    expect(sub.planName).toBeNull();
    expect(sub.migratedFromCard).toBe(true);
    expect(sub.products).toEqual(["antigravity"]);
    expect(sub.expiresAt).toBeNull();
  });

  it("handles malformed productEntitlements gracefully", async () => {
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: "sub-bad",
        planId: "p1",
        plan: { name: "X" },
        status: "ACTIVE",
        productEntitlements: "not-json",
        expiresAt: null,
        deviceLimit: 1,
        weight: 1,
      },
    ]);
    const result = await service.listSubscriptions("cust-1");
    expect(result.subscriptions[0].products).toEqual([]);
  });
});
