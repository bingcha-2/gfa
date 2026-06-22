/**
 * billing-admin.service.spec.ts — console refund/revoke against the real
 * Prisma test db with a REAL SubscriptionService and a mocked
 * EntitlementSyncService (record-side effects are covered by
 * subscription.service.spec; here we assert the expire call is made).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";

import { BillingAdminService } from "../billing-admin.service";
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

let entitlementSync: { syncSubscription: ReturnType<typeof vi.fn>; expireShadowRecord: ReturnType<typeof vi.fn> };
let billing: {
  refundEpayOrder: ReturnType<typeof vi.fn>;
  revokeReferralRewardForOrder: ReturnType<typeof vi.fn>;
};
let service: BillingAdminService;

let seq = 0;

async function createSub(customerId: string, overrides: Partial<{
  status: "ACTIVE" | "EXPIRED" | "CANCELLED";
  activatedFromOrderId: string | null;
}> = {}) {
  return prisma.subscription.create({
    data: {
      customerId,
      status: (overrides.status ?? "ACTIVE") as any,
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      productEntitlements: JSON.stringify(["antigravity"]),
      backingKeyValue: `sub_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}${++seq}`,
      activatedFromOrderId: overrides.activatedFromOrderId ?? null,
    },
  });
}

async function createOrder(customerId: string, overrides: Partial<{
  status: "PENDING" | "PAID" | "FAILED" | "REFUNDED" | "EXPIRED";
  subscriptionId: string | null;
}> = {}) {
  return prisma.planOrder.create({
    data: {
      customerId,
      amountCents: 9900,
      payChannel: "ALIPAY",
      outTradeNo: `OT${Date.now()}${++seq}`,
      status: (overrides.status ?? "PAID") as any,
      subscriptionId: overrides.subscriptionId ?? null,
      paidAt: overrides.status === "PENDING" ? null : new Date(),
      catalogVersion: 1,
      config: JSON.stringify({ line: "pool", products: ["antigravity"] }),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
}

beforeAll(async () => {
  await ensureCustomerSchema();
});

beforeEach(async () => {
  await cleanCustomerTables();
  entitlementSync = { syncSubscription: vi.fn(), expireShadowRecord: vi.fn() };
  // refund/revoke only exercise SubscriptionService.cancelSubscription, which
  // touches neither the catalog nor rosetta — stub them.
  const subscriptionService = new SubscriptionService(
    prisma as any,
    entitlementSync as unknown as EntitlementSyncService,
    {} as any,
  );
  // 网关退款默认成功(code=0 → ok);各用例可改 mock 模拟失败/已退款。
  billing = {
    refundEpayOrder: vi.fn().mockResolvedValue({ ok: true }),
    revokeReferralRewardForOrder: vi.fn().mockResolvedValue(undefined),
  };
  service = new BillingAdminService(prisma as any, subscriptionService, billing as any, entitlementSync as any);
});

afterAll(async () => {
  await cleanCustomerTables();
  await disconnectCustomerDb();
});

describe("BillingAdminService.refundOrder", () => {
  it("refunds a PAID order: REFUNDED + linked sub CANCELLED + shadow expired + BILLING notification", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);
    const order = await createOrder(customer.id, { subscriptionId: sub.id });

    const result = await service.refundOrder(order.id);

    expect(result.alreadyRefunded).toBe(false);
    expect(result.cancelledSubscriptionId).toBe(sub.id);
    expect(result.order.status).toBe("REFUNDED");
    expect((await prisma.planOrder.findUnique({ where: { id: order.id } }))!.status).toBe("REFUNDED");
    expect((await prisma.subscription.findUnique({ where: { id: sub.id } }))!.status).toBe("CANCELLED");
    expect(entitlementSync.expireShadowRecord).toHaveBeenCalledWith(sub.id);

    const notifications = await prisma.notification.findMany({ where: { customerId: customer.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("BILLING");
    expect(notifications[0].title).toBe("订单已退款");

    // 真打款:网关退款 API 按订单的 outTradeNo + 实付毛额(分)被调用一次。
    expect(billing.refundEpayOrder).toHaveBeenCalledWith(order.outTradeNo, 9900);
  });

  it("网关退款失败 → 503,订单保持 PAID、订阅不取消、不通知(钱没退回绝不翻状态)", async () => {
    billing.refundEpayOrder.mockResolvedValue({ ok: false, msg: "余额不足" });
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);
    const order = await createOrder(customer.id, { subscriptionId: sub.id });

    await expect(service.refundOrder(order.id)).rejects.toThrow(ServiceUnavailableException);

    expect((await prisma.planOrder.findUnique({ where: { id: order.id } }))!.status).toBe("PAID");
    expect((await prisma.subscription.findUnique({ where: { id: sub.id } }))!.status).toBe("ACTIVE");
    expect(await prisma.notification.count({ where: { customerId: customer.id } })).toBe(0);
  });

  it("GRANT / ¥0 订单(管理员授予)→ 跳过网关,只做内部状态流转", async () => {
    const customer = await createTestCustomer();
    const grant = await prisma.planOrder.create({
      data: {
        customerId: customer.id,
        amountCents: 0,
        payChannel: "GRANT",
        outTradeNo: `GRANT${Date.now()}${++seq}`,
        status: "PAID",
        paidAt: new Date(),
        catalogVersion: 1,
        config: JSON.stringify({ line: "pool", products: ["antigravity"] }),
        expiresAt: new Date(),
      },
    });

    const result = await service.refundOrder(grant.id);

    expect(billing.refundEpayOrder).not.toHaveBeenCalled(); // 无真实支付,不调网关
    expect(result.order.status).toBe("REFUNDED");
  });

  it("falls back to the activatedFromOrderId link when order.subscriptionId is null", async () => {
    const customer = await createTestCustomer();
    const order = await createOrder(customer.id, { subscriptionId: null });
    const sub = await createSub(customer.id, { activatedFromOrderId: order.id });

    const result = await service.refundOrder(order.id);

    expect(result.cancelledSubscriptionId).toBe(sub.id);
    expect((await prisma.subscription.findUnique({ where: { id: sub.id } }))!.status).toBe("CANCELLED");
  });

  it("refunds an order with no subscription at all (state flip + notification only)", async () => {
    const customer = await createTestCustomer();
    const order = await createOrder(customer.id);

    const result = await service.refundOrder(order.id);

    expect(result.order.status).toBe("REFUNDED");
    expect(result.cancelledSubscriptionId).toBeNull();
    expect(entitlementSync.expireShadowRecord).not.toHaveBeenCalled();
  });

  it("rejects refunding a non-PAID order with 409", async () => {
    const customer = await createTestCustomer();
    const pending = await createOrder(customer.id, { status: "PENDING" });
    const expired = await createOrder(customer.id, { status: "EXPIRED" });

    await expect(service.refundOrder(pending.id)).rejects.toThrow(ConflictException);
    await expect(service.refundOrder(expired.id)).rejects.toThrow(ConflictException);
    expect((await prisma.planOrder.findUnique({ where: { id: pending.id } }))!.status).toBe("PENDING");
  });

  it("unknown order id → 404", async () => {
    await expect(service.refundOrder("no-such-order")).rejects.toThrow(NotFoundException);
  });

  it("is idempotent: refunding an already-REFUNDED order is a no-op success", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);
    const order = await createOrder(customer.id, { subscriptionId: sub.id });

    await service.refundOrder(order.id);
    const second = await service.refundOrder(order.id);

    expect(second.alreadyRefunded).toBe(true);
    expect(second.order.status).toBe("REFUNDED");
    // No second cancellation, no duplicate notification.
    expect(entitlementSync.expireShadowRecord).toHaveBeenCalledTimes(1);
    expect(await prisma.notification.count({ where: { customerId: customer.id } })).toBe(1);
  });

  it("skips cancellation when the linked subscription is already CANCELLED", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id, { status: "CANCELLED" });
    const order = await createOrder(customer.id, { subscriptionId: sub.id });

    const result = await service.refundOrder(order.id);

    expect(result.order.status).toBe("REFUNDED");
    expect(result.cancelledSubscriptionId).toBeNull();
    expect(entitlementSync.expireShadowRecord).not.toHaveBeenCalled();
  });

  it("survives a dangling subscriptionId link (refund still completes)", async () => {
    const customer = await createTestCustomer();
    const order = await createOrder(customer.id, { subscriptionId: "ghost-sub" });

    const result = await service.refundOrder(order.id);

    expect(result.order.status).toBe("REFUNDED");
    expect(result.cancelledSubscriptionId).toBeNull();
  });
});

describe("BillingAdminService.revokeSubscription", () => {
  it("revokes an ACTIVE sub: CANCELLED + shadow expired + BILLING notification", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);

    const result = await service.revokeSubscription(sub.id);

    expect(result.alreadyCancelled).toBe(false);
    expect(result.subscription.status).toBe("CANCELLED");
    expect((await prisma.subscription.findUnique({ where: { id: sub.id } }))!.status).toBe("CANCELLED");
    expect(entitlementSync.expireShadowRecord).toHaveBeenCalledWith(sub.id);

    const notifications = await prisma.notification.findMany({ where: { customerId: customer.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("BILLING");
    expect(notifications[0].title).toBe("订阅已取消");
  });

  it("revokes an EXPIRED sub too (terminal CANCELLED, record expiry re-asserted)", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id, { status: "EXPIRED" });

    const result = await service.revokeSubscription(sub.id);

    expect(result.subscription.status).toBe("CANCELLED");
    expect(entitlementSync.expireShadowRecord).toHaveBeenCalledWith(sub.id);
  });

  it("unknown subscription id → 404", async () => {
    await expect(service.revokeSubscription("no-such-sub")).rejects.toThrow(NotFoundException);
  });

  it("is idempotent: revoking an already-CANCELLED sub is a no-op success", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);

    await service.revokeSubscription(sub.id);
    const second = await service.revokeSubscription(sub.id);

    expect(second.alreadyCancelled).toBe(true);
    expect(second.subscription.status).toBe("CANCELLED");
    expect(entitlementSync.expireShadowRecord).toHaveBeenCalledTimes(1);
    expect(await prisma.notification.count({ where: { customerId: customer.id } })).toBe(1);
  });
});

describe("BillingAdminService.updateSubscription", () => {
  it("updates expiresAt and resyncs the subscription shadow record", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);
    const nextExpiry = new Date(Date.now() + 45 * DAY_MS);

    const result = await service.updateSubscription(sub.id, { expiresAt: nextExpiry.toISOString() });

    expect(result.subscription.id).toBe(sub.id);
    expect(result.subscription.expiresAt!.toISOString()).toBe(nextExpiry.toISOString());
    expect((await prisma.subscription.findUnique({ where: { id: sub.id } }))!.expiresAt!.toISOString()).toBe(
      nextExpiry.toISOString(),
    );
    expect(entitlementSync.syncSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ id: sub.id, expiresAt: nextExpiry }),
    );
  });

  it("rejects an invalid expiresAt value", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);

    await expect(service.updateSubscription(sub.id, { expiresAt: "not-a-date" })).rejects.toThrow(ConflictException);
  });

  it("throws 404 for an unknown subscription", async () => {
    await expect(service.updateSubscription("no-such-sub", { expiresAt: new Date().toISOString() })).rejects.toThrow(
      NotFoundException,
    );
  });
});
