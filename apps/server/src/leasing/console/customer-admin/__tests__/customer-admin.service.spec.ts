/**
 * customer-admin.service.spec.ts — console customer management against the real
 * Prisma test db. grantSubscription uses a REAL SubscriptionService with a
 * mocked EntitlementSyncService (shadow-record side effects covered elsewhere).
 *
 * Security: every read path is asserted to omit passwordHash / tokenVersion.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";

import { CustomerAdminService } from "../customer-admin.service";
import { SubscriptionService } from "../../../subscription/subscription.service";
import type { EntitlementSyncService } from "../../../subscription/entitlement-sync.service";
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

let entitlementSync: { syncSubscription: ReturnType<typeof vi.fn>; expireShadowRecord: ReturnType<typeof vi.fn> };
let service: CustomerAdminService;

async function createPlan(overrides: Record<string, unknown> = {}) {
  return prisma.plan.create({
    data: {
      name: `套餐 ${++seq}`,
      priceCents: 9900,
      durationDays: 30,
      productEntitlements: JSON.stringify(["antigravity"]),
      ...overrides,
    },
  });
}

async function createOrder(customerId: string, planId: string, overrides: Partial<{ status: string; amountCents: number }> = {}) {
  return prisma.planOrder.create({
    data: {
      customerId,
      planId,
      amountCents: overrides.amountCents ?? 9900,
      payChannel: "ALIPAY",
      outTradeNo: `OT${Date.now()}${++seq}`,
      status: (overrides.status ?? "PAID") as any,
      paidAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
}

async function createSub(customerId: string, overrides: Partial<{ status: string; planId: string | null }> = {}) {
  return prisma.subscription.create({
    data: {
      customerId,
      planId: overrides.planId ?? null,
      status: (overrides.status ?? "ACTIVE") as any,
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      productEntitlements: JSON.stringify(["antigravity"]),
      backingKeyValue: `sub_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}${++seq}`,
    },
  });
}

async function createDevice(customerId: string, status = "ACTIVE") {
  return prisma.device.create({
    data: { customerId, deviceId: `dev-${++seq}`, status: status as any },
  });
}

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await cleanCustomerTables();
  entitlementSync = { syncSubscription: vi.fn(), expireShadowRecord: vi.fn() };
  const subscriptionService = new SubscriptionService(
    prisma as any,
    entitlementSync as unknown as EntitlementSyncService,
  );
  service = new CustomerAdminService(prisma as any, subscriptionService);
});

afterAll(async () => {
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

describe("CustomerAdminService.listCustomers", () => {
  it("paginates and never leaks passwordHash / tokenVersion", async () => {
    await createTestCustomer();
    await createTestCustomer();
    await createTestCustomer();

    const result = await service.listCustomers({ page: 1, pageSize: 2 });

    expect(result.total).toBe(3);
    expect(result.customers).toHaveLength(2);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);
    for (const c of result.customers) {
      expect(c).not.toHaveProperty("passwordHash");
      expect(c).not.toHaveProperty("tokenVersion");
    }
  });

  it("computes per-row aggregates (active subs, order count, paid sum, active devices)", async () => {
    const customer = await createTestCustomer();
    const plan = await createPlan();
    await createSub(customer.id, { status: "ACTIVE", planId: plan.id });
    await createSub(customer.id, { status: "CANCELLED", planId: plan.id }); // excluded
    await createOrder(customer.id, plan.id, { status: "PAID", amountCents: 9900 });
    await createOrder(customer.id, plan.id, { status: "PAID", amountCents: 5000 });
    await createOrder(customer.id, plan.id, { status: "REFUNDED", amountCents: 9900 }); // not in paid sum
    await createDevice(customer.id, "ACTIVE");
    await createDevice(customer.id, "REVOKED"); // excluded

    const { customers } = await service.listCustomers({ page: 1, pageSize: 20 });
    const row = customers.find((c) => c.id === customer.id)!;

    expect(row.activeSubscriptions).toBe(1);
    expect(row.orderCount).toBe(3);
    expect(row.totalPaidCents).toBe(14900);
    expect(row.deviceCount).toBe(1);
  });

  it("filters by status and searches email / referralCode", async () => {
    await createTestCustomer({ email: "alice@search.test" });
    const banned = await createTestCustomer({ email: "bob@search.test", status: "DISABLED" });

    const byStatus = await service.listCustomers({ page: 1, pageSize: 20, status: "DISABLED" });
    expect(byStatus.customers.map((c) => c.id)).toEqual([banned.id]);

    const byEmail = await service.listCustomers({ page: 1, pageSize: 20, search: "alice@search" });
    expect(byEmail.total).toBe(1);
    expect(byEmail.customers[0].email).toBe("alice@search.test");
  });
});

describe("CustomerAdminService.getCustomer", () => {
  it("returns detail with inlined subscriptions / orders / devices and no secrets", async () => {
    const customer = await createTestCustomer();
    const plan = await createPlan();
    await createSub(customer.id, { planId: plan.id });
    await createOrder(customer.id, plan.id);
    await createDevice(customer.id);

    const detail = await service.getCustomer(customer.id);

    expect(detail.id).toBe(customer.id);
    expect(detail).not.toHaveProperty("passwordHash");
    expect(detail).not.toHaveProperty("tokenVersion");
    expect(detail.subscriptions).toHaveLength(1);
    expect(detail.planOrders).toHaveLength(1);
    expect(detail.devices).toHaveLength(1);
  });

  it("throws 404 for an unknown customer", async () => {
    await expect(service.getCustomer("no-such-customer")).rejects.toThrow(NotFoundException);
  });
});

describe("CustomerAdminService.updateCustomer", () => {
  it("disabling bumps tokenVersion (forced logout); re-enabling does not", async () => {
    const customer = await createTestCustomer({ tokenVersion: 0 });

    await service.updateCustomer(customer.id, { status: "DISABLED" });
    let raw = await prisma.customer.findUnique({ where: { id: customer.id } });
    expect(raw!.status).toBe("DISABLED");
    expect(raw!.tokenVersion).toBe(1);

    await service.updateCustomer(customer.id, { status: "ACTIVE" });
    raw = await prisma.customer.findUnique({ where: { id: customer.id } });
    expect(raw!.status).toBe("ACTIVE");
    expect(raw!.tokenVersion).toBe(1); // unchanged on re-enable
  });

  it("updates displayName / creditCents and returns a whitelisted row", async () => {
    const customer = await createTestCustomer();
    const result = await service.updateCustomer(customer.id, { displayName: "VIP", creditCents: 500 });

    expect(result.displayName).toBe("VIP");
    expect(result.creditCents).toBe(500);
    expect(result).not.toHaveProperty("passwordHash");
    expect(result).not.toHaveProperty("tokenVersion");
  });

  it("throws 404 for an unknown customer", async () => {
    await expect(service.updateCustomer("no-such-customer", { displayName: "x" })).rejects.toThrow(NotFoundException);
  });
});

describe("CustomerAdminService.grantSubscription", () => {
  it("activates a plan subscription (ACTIVE) and mints a shadow record", async () => {
    const customer = await createTestCustomer();
    const plan = await createPlan();

    const sub = await service.grantSubscription(customer.id, plan.id);

    expect(sub.status).toBe("ACTIVE");
    expect(sub.customerId).toBe(customer.id);
    expect(sub.planId).toBe(plan.id);
    expect(entitlementSync.syncSubscription).toHaveBeenCalledTimes(1);
    expect(await prisma.subscription.count({ where: { customerId: customer.id, status: "ACTIVE" } })).toBe(1);
  });

  it("throws 404 for an unknown customer", async () => {
    const plan = await createPlan();
    await expect(service.grantSubscription("no-such-customer", plan.id)).rejects.toThrow(NotFoundException);
  });
});
