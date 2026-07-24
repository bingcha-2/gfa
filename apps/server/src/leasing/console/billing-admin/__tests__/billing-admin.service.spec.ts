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

let entitlementSync: {
  syncSubscription: ReturnType<typeof vi.fn>;
  expireShadowRecord: ReturnType<typeof vi.fn>;
  resetSubscriptionUsdQuotaUsage: ReturnType<typeof vi.fn>;
  upgradeSubscriptionSeats: ReturnType<typeof vi.fn>;
};
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
  entitlementSync = {
    syncSubscription: vi.fn(),
    expireShadowRecord: vi.fn(),
    resetSubscriptionUsdQuotaUsage: vi.fn(),
    upgradeSubscriptionSeats: vi.fn(),
  };
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

describe("BillingAdminService.upgradeSubscriptionSeats", () => {
  it("delegates the in-place upgrade and returns the preserved subscription", async () => {
    entitlementSync.upgradeSubscriptionSeats.mockResolvedValue({
      ok: true,
      subscription: {
        id: "sub-upgrade",
        customerId: "cust-1",
        startsAt: new Date("2026-07-01T00:00:00.000Z"),
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      previousShareSeats: 1,
      shareSeats: 2,
      alreadyAtTarget: false,
      reboundProducts: [],
      usageByProduct: { codex: { weekly: { used: 100, limit: 200 } } },
    });

    const result = await service.upgradeSubscriptionSeats("sub-upgrade", 2);

    expect(entitlementSync.upgradeSubscriptionSeats).toHaveBeenCalledWith("sub-upgrade", 2);
    expect(result).toMatchObject({
      previousShareSeats: 1,
      shareSeats: 2,
      usageByProduct: { codex: { weekly: { used: 100, limit: 200 } } },
    });
  });

  it("maps an unsafe upgrade plan to a console conflict", async () => {
    entitlementSync.upgradeSubscriptionSeats.mockResolvedValue({
      ok: false,
      error: "No enabled codex pro account can hold 2 seats",
    });

    await expect(service.upgradeSubscriptionSeats("sub-upgrade", 2))
      .rejects.toThrow(ConflictException);
  });
});

describe("BillingAdminService.updateSubscription", () => {
  it("updates USD limits inside config, preserves the live window, and resyncs immediately", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        config: JSON.stringify({
          line: "bind",
          products: ["anthropic"],
          bindings: { anthropic: 7 },
          shareSeats: 2,
          usdQuotaByProduct: { anthropic: { fiveHour: 16, weekly: 80 } },
        }),
        windowState: JSON.stringify({ windowStartedAt: 123, tokenUsageEvents: [{ at: 123, apiValueUsd: 6 }] }),
      },
    });

    const result = await service.updateSubscription(sub.id, {
      usdQuotaPerSeatByProduct: { anthropic: { fiveHour: 5, weekly: 20 } },
    });
    const saved = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    const config = JSON.parse(saved.config!);

    expect(config.usdQuotaByProduct).toEqual({ anthropic: { fiveHour: 10, weekly: 40 } });
    expect(config.usdQuotaSource).toBe("manual");
    expect(config.usdQuotaMigrationVersion).toBe(5);
    expect(saved.windowState).toContain('apiValueUsd');
    expect(saved.expiresAt?.toISOString()).toBe(sub.expiresAt?.toISOString());
    expect(result.previousUsdQuotaByProduct).toEqual({ anthropic: { fiveHour: 16, weekly: 80 } });
    expect(entitlementSync.syncSubscription).toHaveBeenCalledWith(expect.objectContaining({ id: sub.id }));
  });

  it("rolls the database and runtime record back when immediate resync fails", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);
    const originalConfig = JSON.stringify({
      line: "bind", products: ["codex"], shareSeats: 1,
      usdQuotaByProduct: { codex: { fiveHour: 0, weekly: 40 } },
      usdQuotaMigrationVersion: 4,
    });
    await prisma.subscription.update({ where: { id: sub.id }, data: { config: originalConfig } });
    entitlementSync.syncSubscription.mockRejectedValueOnce(new Error("runtime refresh failed"));

    await expect(service.updateSubscription(sub.id, {
      usdQuotaPerSeatByProduct: { codex: { fiveHour: 0, weekly: 50 } },
    })).rejects.toThrow("runtime refresh failed");

    const restored = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(restored.config).toBe(originalConfig);
    expect(entitlementSync.syncSubscription).toHaveBeenCalledTimes(2);
    expect(JSON.parse(entitlementSync.syncSubscription.mock.calls[1][0].config)).toEqual(JSON.parse(originalConfig));
  });

  it("rejects negative or non-finite USD limits", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);

    await expect(service.updateSubscription(sub.id, {
      usdQuotaPerSeatByProduct: { codex: { fiveHour: -1, weekly: 10 } },
    })).rejects.toThrow(ConflictException);
    await expect(service.updateSubscription(sub.id, {
      usdQuotaPerSeatByProduct: { codex: { fiveHour: 1, weekly: Number.NaN } },
    })).rejects.toThrow(ConflictException);
  });

  it("rejects disabling both USD windows so a migrated subscription cannot become unlimited", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { config: JSON.stringify({ line: "bind", products: ["codex"], usdQuotaByProduct: { codex: { fiveHour: 10, weekly: 50 } } }) },
    });

    await expect(
      service.updateSubscription(sub.id, { usdQuotaPerSeatByProduct: { codex: { fiveHour: 0, weekly: 0 } } }),
    ).rejects.toThrow("codex 的 5 小时和每周额度不能同时为 0");
  });

  it("requires every supported product in a mixed subscription", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        config: JSON.stringify({
          line: "bind",
          products: ["codex", "anthropic"],
          shareSeats: 2,
          usdQuotaByProduct: {
            codex: { fiveHour: 2, weekly: 10 },
            anthropic: { fiveHour: 4, weekly: 20 },
          },
        }),
      },
    });

    await expect(service.updateSubscription(sub.id, {
      usdQuotaPerSeatByProduct: { codex: { fiveHour: 1, weekly: 5 } },
    })).rejects.toThrow("缺少产品额度配置: anthropic");
  });

  it("rejects USD limits for subscriptions without Codex or Anthropic", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);

    await expect(service.updateSubscription(sub.id, {
      usdQuotaPerSeatByProduct: { codex: { fiveHour: 10, weekly: 0 } },
    })).rejects.toThrow(
      "产品 codex 不支持美元额度或不属于该订阅",
    );
  });

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

describe("BillingAdminService.resetSubscriptionUsdQuotaUsage", () => {
  it("resets only the requested product window", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);
    entitlementSync.resetSubscriptionUsdQuotaUsage = vi.fn().mockResolvedValue({
      previousUsed: 7.25,
      limit: 80,
      usageByProduct: {
        anthropic: {
          fiveHour: { used: 2, limit: 10 },
          weekly: { used: 0, limit: 80 },
        },
      },
    });

    const result = await service.resetSubscriptionUsdQuotaUsage(sub.id, "anthropic", "weekly");

    expect(entitlementSync.resetSubscriptionUsdQuotaUsage).toHaveBeenCalledWith(sub.id, "anthropic", "weekly");
    expect(result).toMatchObject({
      subscriptionId: sub.id,
      customerId: customer.id,
      product: "anthropic",
      scope: "weekly",
      previousUsed: 7.25,
      limit: 80,
    });
  });

  it("rejects disabled windows and unknown subscriptions", async () => {
    const customer = await createTestCustomer();
    const sub = await createSub(customer.id);
    entitlementSync.resetSubscriptionUsdQuotaUsage = vi.fn().mockResolvedValue(null);

    await expect(service.resetSubscriptionUsdQuotaUsage(sub.id, "codex", "fiveHour"))
      .rejects.toThrow("codex 的 5 小时额度未启用");
    await expect(service.resetSubscriptionUsdQuotaUsage("missing", "codex", "weekly"))
      .rejects.toThrow(NotFoundException);
  });
});
