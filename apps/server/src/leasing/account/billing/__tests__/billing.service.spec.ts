/**
 * billing.service.spec.ts — BillingService unit tests (mocked Prisma).
 *
 * Focus: order get, list, subscriptions list — no real DB needed.
 * (Catalog ordering is covered by billing.service.catalog.spec.ts; the legacy
 * plan-based createOrder path was removed with the Plan table.)
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BillingService } from "../billing.service";
import { NotFoundException } from "@nestjs/common";

// Minimal Prisma mock factory
function makeMockPrisma(overrides: Record<string, any> = {}) {
  return {
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

function buildService(prisma: any) {
  return new BillingService(prisma, {} as any, {} as any, {} as any, {} as any);
}

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
    expect(result.orders[0].planName).toBeNull(); // catalog orders carry no Plan name
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

  it("clamps negative page to 1 (no negative skip → no Prisma 500)", async () => {
    prisma.planOrder.findMany.mockResolvedValue([]);
    prisma.planOrder.count.mockResolvedValue(0);
    await service.listOrders("cust-1", -5, 10);
    const callArgs = prisma.planOrder.findMany.mock.calls[0][0];
    expect(callArgs.skip).toBe(0); // clamped page 1 → skip (1-1)*10 = 0
    expect(callArgs.skip).toBeGreaterThanOrEqual(0);
  });

  it("clamps page 0 to 1", async () => {
    prisma.planOrder.findMany.mockResolvedValue([]);
    prisma.planOrder.count.mockResolvedValue(0);
    await service.listOrders("cust-1", 0, 10);
    expect(prisma.planOrder.findMany.mock.calls[0][0].skip).toBe(0);
  });

  it("clamps pageSize to a max of 100", async () => {
    prisma.planOrder.findMany.mockResolvedValue([]);
    prisma.planOrder.count.mockResolvedValue(0);
    await service.listOrders("cust-1", 1, 9999);
    expect(prisma.planOrder.findMany.mock.calls[0][0].take).toBe(100);
  });

  it("clamps non-positive pageSize up to 1 (no negative take → no Prisma 500)", async () => {
    prisma.planOrder.findMany.mockResolvedValue([]);
    prisma.planOrder.count.mockResolvedValue(0);
    await service.listOrders("cust-1", 1, 0);
    expect(prisma.planOrder.findMany.mock.calls[0][0].take).toBe(1);

    await service.listOrders("cust-1", 1, -10);
    expect(prisma.planOrder.findMany.mock.calls[1][0].take).toBe(1);
  });
});

describe("BillingService.listSubscriptions", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let service: BillingService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = buildService(prisma);
  });

  it("maps catalog subscriptions with products-joined planName and parsed products", async () => {
    const expiry = new Date("2026-12-31T00:00:00Z");
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: "sub-1",
        migratedFromKey: null,
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
    expect(sub.planName).toBe("antigravity+codex"); // 目录订阅:products 拼接为展示名
    expect(sub.status).toBe("ACTIVE");
    expect(sub.products).toEqual(["antigravity", "codex"]);
    expect(sub.expiresAt).toBe("2026-12-31T00:00:00.000Z");
    expect(sub.deviceLimit).toBe(3);
    expect(sub.weight).toBe(2);
    expect(sub.migratedFromCard).toBe(false);
  });

  it("migratedFromKey set → planName null + migratedFromCard true + products parsed", async () => {
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: "sub-mig",
        migratedFromKey: "BCAI-AAAA-BBBB",
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
        migratedFromKey: null,
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

describe("BillingService.refundOwnOrder", () => {
  const PAID = {
    id: "o1", customerId: "c1", outTradeNo: "T1", status: "PAID",
    payChannel: "ALIPAY", amountCents: 1000,
    paidAt: new Date("2026-06-01"), createdAt: new Date("2026-06-01"),
    subscriptionId: "s1",
  };

  function setup(
    order: any,
    opts: { usage?: number; refundOk?: boolean; casCount?: number; sub?: any } = {},
  ) {
    const prisma = {
      planOrder: {
        findUnique: vi.fn().mockResolvedValue(order),
        updateMany: vi.fn().mockResolvedValue({ count: opts.casCount ?? 1 }),
      },
      cardTokenUsage: { count: vi.fn().mockResolvedValue(opts.usage ?? 0) },
      subscription: {
        findUnique: vi.fn().mockResolvedValue(opts.sub ?? null),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as any;
    const subscriptions = { cancelSubscription: vi.fn().mockResolvedValue({}) } as any;
    const service = new BillingService(prisma, {} as any, {} as any, {} as any, subscriptions);
    vi.spyOn(service, "refundEpayOrder").mockResolvedValue({ ok: opts.refundOk ?? true });
    return { service, prisma, subscriptions };
  }

  it("他人订单 → 404(不泄露存在性)", async () => {
    const { service } = setup({ ...PAID, customerId: "other" });
    await expect(service.refundOwnOrder("c1", "T1")).rejects.toThrow(NotFoundException);
  });

  it("非 PAID → 拒绝", async () => {
    const { service } = setup({ ...PAID, status: "PENDING" });
    await expect(service.refundOwnOrder("c1", "T1")).rejects.toThrow(/已支付/);
  });

  it("GRANT/¥0 → 拒绝", async () => {
    const { service } = setup({ ...PAID, payChannel: "GRANT" });
    await expect(service.refundOwnOrder("c1", "T1")).rejects.toThrow(/可退款金额/);
  });

  it("支付后有用量 → 拒绝(防买了用完再退)", async () => {
    const { service } = setup(PAID, { usage: 2 });
    await expect(service.refundOwnOrder("c1", "T1")).rejects.toThrow(/使用记录/);
  });

  it("正常:退 96.4% + CAS 翻 REFUNDED + 取消订阅", async () => {
    const { service, prisma, subscriptions } = setup(PAID, { sub: { id: "s1", status: "ACTIVE" } });
    const res = await service.refundOwnOrder("c1", "T1");
    expect(service.refundEpayOrder).toHaveBeenCalledWith("T1", 964); // 1000 × 0.964
    expect(prisma.planOrder.updateMany).toHaveBeenCalledWith({
      where: { id: "o1", status: "PAID" },
      data: { status: "REFUNDED" },
    });
    expect(subscriptions.cancelSubscription).toHaveBeenCalledWith("s1");
    expect(res).toMatchObject({ ok: true, refundedCents: 964 });
  });

  it("网关退款失败 → 抛错,订单不翻状态", async () => {
    const { service, prisma } = setup(PAID, { refundOk: false });
    await expect(service.refundOwnOrder("c1", "T1")).rejects.toThrow(/退款失败/);
    expect(prisma.planOrder.updateMany).not.toHaveBeenCalled();
  });

  it("已 REFUNDED → 幂等返回,不重复退款", async () => {
    const { service } = setup({ ...PAID, status: "REFUNDED" });
    const res = await service.refundOwnOrder("c1", "T1");
    expect(res).toMatchObject({ ok: true, alreadyRefunded: true });
    expect(service.refundEpayOrder).not.toHaveBeenCalled();
  });
});
