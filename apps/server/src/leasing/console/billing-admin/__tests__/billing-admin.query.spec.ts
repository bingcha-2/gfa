/**
 * billing-admin.query.spec.ts — console read surfaces added to BillingAdminService:
 * plan-order list, subscription list, and the billing-stats dashboard, against
 * the real Prisma test db. (refund/revoke are covered by billing-admin.service.spec.)
 *
 * SubscriptionService is not exercised by these read paths, so a bare stub is passed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingAdminService } from "../billing-admin.service";
import type { SubscriptionService } from "../../../subscription/subscription.service";
import {
  cleanCustomerTables,
  createTestCustomer,
  disconnectCustomerDb,
  ensureCustomerSchema,
  getCustomerPrisma,
} from "../../../../shared/__tests__/customer-test-db";

const prisma = getCustomerPrisma();
const DAY_MS = 24 * 60 * 60 * 1000;
let seq = 0;
let service: BillingAdminService;

const subStub = {} as unknown as SubscriptionService;

async function createOrder(customerId: string, overrides: Partial<{ status: string; payChannel: string; amountCents: number; paidAt: Date | null; createdAt: Date }> = {}) {
  return prisma.planOrder.create({
    data: {
      customerId,
      amountCents: overrides.amountCents ?? 9900,
      payChannel: (overrides.payChannel ?? "ALIPAY") as any,
      outTradeNo: `OT${Date.now()}${++seq}`,
      status: (overrides.status ?? "PAID") as any,
      paidAt: overrides.paidAt === undefined ? new Date() : overrides.paidAt,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      catalogVersion: 1,
      config: JSON.stringify({ line: "pool", products: ["antigravity"] }),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
}

async function createSub(customerId: string, status = "ACTIVE") {
  return prisma.subscription.create({
    data: {
      customerId,
      status: status as any,
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      productEntitlements: JSON.stringify(["antigravity"]),
      backingKeyValue: `sub_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}${++seq}`,
    },
  });
}

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await cleanCustomerTables();
  // 查询用例不触发退款;billing 仅为构造参数,给个空 stub 即可。
  service = new BillingAdminService(prisma as any, subStub, { refundEpayOrder: vi.fn() } as any, { lookupPoolAccount: vi.fn().mockReturnValue(null) } as any);
});

afterAll(async () => {
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

describe("BillingAdminService.listOrders", () => {
  it("joins customer email, paginates", async () => {
    const customer = await createTestCustomer({ email: "buyer@orders.test" });
    await createOrder(customer.id);
    await createOrder(customer.id);

    const result = await service.listOrders({ page: 1, pageSize: 1 });
    expect(result.total).toBe(2);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].customer?.email).toBe("buyer@orders.test");
  });

  it("filters by status / payChannel and searches outTradeNo / email", async () => {
    const customer = await createTestCustomer({ email: "alice@orders.test" });
    await createOrder(customer.id, { status: "PAID", payChannel: "ALIPAY" });
    await createOrder(customer.id, { status: "REFUNDED", payChannel: "WXPAY" });

    expect((await service.listOrders({ page: 1, pageSize: 20, status: "PAID" })).total).toBe(1);
    expect((await service.listOrders({ page: 1, pageSize: 20, payChannel: "WXPAY" })).total).toBe(1);
    expect((await service.listOrders({ page: 1, pageSize: 20, search: "alice@orders" })).total).toBe(2);
  });
});

describe("BillingAdminService.listSubscriptions", () => {
  it("joins customer, filters by status and searches customer email", async () => {
    const customer = await createTestCustomer({ email: "sub@subs.test" });
    await createSub(customer.id, "ACTIVE");
    await createSub(customer.id, "CANCELLED");

    const active = await service.listSubscriptions({ page: 1, pageSize: 20, status: "ACTIVE" });
    expect(active.total).toBe(1);
    expect(active.subscriptions[0].customer?.email).toBe("sub@subs.test");

    const byEmail = await service.listSubscriptions({ page: 1, pageSize: 20, search: "sub@subs" });
    expect(byEmail.total).toBe(2);
  });

  it("bind 订阅:附带 line=bind + boundAccounts(按 accountId 解析绑定号邮箱)", async () => {
    const customer = await createTestCustomer({ email: "bind@subs.test" });
    await prisma.subscription.create({
      data: {
        customerId: customer.id,
        status: "ACTIVE",
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        productEntitlements: JSON.stringify(["anthropic"]),
        backingKeyValue: `sub_bind_${Date.now()}${++seq}`,
        config: JSON.stringify({ line: "bind", products: ["anthropic"], bindings: { anthropic: 2 }, levels: { anthropic: "max-20x" } }),
      },
    });
    const lookupPoolAccount = vi.fn().mockReturnValue({ id: 2, email: "seat@team.com" });
    const svc = new BillingAdminService(prisma as any, subStub, { refundEpayOrder: vi.fn() } as any, { lookupPoolAccount } as any);

    const res = await svc.listSubscriptions({ page: 1, pageSize: 20, search: "bind@subs" });
    expect(res.subscriptions[0].line).toBe("bind");
    expect((res.subscriptions[0] as any).boundAccounts).toEqual({ anthropic: { id: 2, email: "seat@team.com" } });
    expect(lookupPoolAccount).toHaveBeenCalledWith("anthropic", 2);
  });

  it("bind 订阅但绑定号已从池中删除 → boundAccounts 降级为仅 id(email null)", async () => {
    const customer = await createTestCustomer({ email: "gone@subs.test" });
    await prisma.subscription.create({
      data: {
        customerId: customer.id,
        status: "ACTIVE",
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        productEntitlements: JSON.stringify(["anthropic"]),
        backingKeyValue: `sub_gone_${Date.now()}${++seq}`,
        config: JSON.stringify({ line: "bind", products: ["anthropic"], bindings: { anthropic: 9 } }),
      },
    });
    const svc = new BillingAdminService(prisma as any, subStub, { refundEpayOrder: vi.fn() } as any, { lookupPoolAccount: vi.fn().mockReturnValue(null) } as any);

    const res = await svc.listSubscriptions({ page: 1, pageSize: 20, search: "gone@subs" });
    expect((res.subscriptions[0] as any).boundAccounts).toEqual({ anthropic: { id: 9, email: null } });
  });
});

describe("BillingAdminService.billingStats", () => {
  it("aggregates today's customers / revenue, active subs, 30-day refund rate, plan distribution", async () => {
    const customer = await createTestCustomer(); // createdAt = now → counts toward today

    await createSub(customer.id, "ACTIVE");
    await createSub(customer.id, "CANCELLED"); // not active

    // Today's revenue: 2 PAID orders today.
    await createOrder(customer.id, { status: "PAID", amountCents: 9900 });
    await createOrder(customer.id, { status: "PAID", amountCents: 100 });
    // One REFUNDED in the window → refund rate = 1 refunded / 3 (paid+refunded).
    await createOrder(customer.id, { status: "REFUNDED" });

    const stats = await service.billingStats();

    expect(stats.todayNewCustomers).toBe(1);
    expect(stats.activeSubscriptions).toBe(1);
    expect(stats.todayPaidCents).toBe(10000);
    expect(stats.todayPaidCount).toBe(2);
    expect(stats.refundRate30d).toBeCloseTo(1 / 3, 5);
    // Catalog-only: all PAID orders bucket under the collective 目录套餐 label.
    const catalogBucket = stats.planDistribution.find((p) => p.planName === "目录套餐");
    expect(catalogBucket?.count).toBe(2); // 2 PAID orders
  });
});
