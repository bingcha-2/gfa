/**
 * billing-admin.controller.spec.ts — wiring of the console refund/revoke
 * endpoints: guard + roles metadata (admin-mutation convention) and the
 * audit-log entry written per mutation.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { BillingAdminController } from "../billing-admin.controller";
import { ConsoleJwtGuard } from "../../../../shared/auth/console-jwt.guard";
import { ROLES_KEY } from "../../../../shared/auth/roles.decorator";

let billingAdmin: {
  refundOrder: ReturnType<typeof vi.fn>;
  revokeSubscription: ReturnType<typeof vi.fn>;
  upgradeSubscriptionSeats: ReturnType<typeof vi.fn>;
  updateSubscription: ReturnType<typeof vi.fn>;
  resetSubscriptionUsdQuotaUsage: ReturnType<typeof vi.fn>;
};
let auditLog: { log: ReturnType<typeof vi.fn> };
let controller: BillingAdminController;

const req = { user: { id: "admin-1" } } as any;

beforeEach(() => {
  billingAdmin = {
    refundOrder: vi.fn(),
    revokeSubscription: vi.fn(),
    upgradeSubscriptionSeats: vi.fn(),
    updateSubscription: vi.fn(),
    resetSubscriptionUsdQuotaUsage: vi.fn(),
  };
  auditLog = { log: vi.fn() };
  controller = new BillingAdminController(billingAdmin as any, auditLog as any);
});

describe("BillingAdminController metadata", () => {
  it("is guarded by ConsoleJwtGuard and restricted to ADMIN/OPERATIONS", () => {
    const guards = Reflect.getMetadata("__guards__", BillingAdminController) ?? [];
    expect(guards).toContain(ConsoleJwtGuard);
    expect(Reflect.getMetadata(ROLES_KEY, BillingAdminController)).toEqual(["ADMIN", "OPERATIONS"]);
  });
});

describe("POST console/plan-orders/:id/refund", () => {
  it("delegates to the service and audit-logs the refund with the operator id", async () => {
    billingAdmin.refundOrder.mockResolvedValue({
      order: { id: "order-1", customerId: "cust-1", amountCents: 9900, status: "REFUNDED" },
      alreadyRefunded: false,
      cancelledSubscriptionId: "sub-1",
    });

    const result = await controller.refundOrder("order-1", req);

    expect(billingAdmin.refundOrder).toHaveBeenCalledWith("order-1");
    expect(result.cancelledSubscriptionId).toBe("sub-1");
    expect(auditLog.log).toHaveBeenCalledWith({
      operatorId: "admin-1",
      action: "REFUND_PLAN_ORDER",
      targetType: "PlanOrder",
      targetId: "order-1",
      detail: {
        alreadyRefunded: false,
        cancelledSubscriptionId: "sub-1",
        customerId: "cust-1",
        amountCents: 9900,
      },
    });
  });

  it("does NOT audit-log when the service rejects", async () => {
    billingAdmin.refundOrder.mockRejectedValue(new Error("conflict"));

    await expect(controller.refundOrder("order-1", req)).rejects.toThrow("conflict");
    expect(auditLog.log).not.toHaveBeenCalled();
  });
});

describe("POST console/subscriptions/:id/revoke", () => {
  it("delegates to the service and audit-logs the revoke with the operator id", async () => {
    billingAdmin.revokeSubscription.mockResolvedValue({
      subscription: { id: "sub-1", customerId: "cust-1", status: "CANCELLED" },
      alreadyCancelled: false,
    });

    const result = await controller.revokeSubscription("sub-1", req);

    expect(billingAdmin.revokeSubscription).toHaveBeenCalledWith("sub-1");
    expect(result.subscription.status).toBe("CANCELLED");
    expect(auditLog.log).toHaveBeenCalledWith({
      operatorId: "admin-1",
      action: "REVOKE_SUBSCRIPTION",
      targetType: "Subscription",
      targetId: "sub-1",
      detail: { alreadyCancelled: false, customerId: "cust-1" },
    });
  });
});

describe("POST console/subscriptions/:id/seats/upgrade", () => {
  it("delegates the in-place seat upgrade and records unchanged subscription dates", async () => {
    billingAdmin.upgradeSubscriptionSeats.mockResolvedValue({
      subscription: {
        id: "sub-1",
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

    const result = await controller.upgradeSubscriptionSeats("sub-1", { shareSeats: 2 }, req);

    expect(billingAdmin.upgradeSubscriptionSeats).toHaveBeenCalledWith("sub-1", 2);
    expect(result.shareSeats).toBe(2);
    expect(auditLog.log).toHaveBeenCalledWith({
      operatorId: "admin-1",
      action: "UPGRADE_SUBSCRIPTION_SEATS",
      targetType: "Subscription",
      targetId: "sub-1",
      detail: {
        customerId: "cust-1",
        previousShareSeats: 1,
        shareSeats: 2,
        alreadyAtTarget: false,
        reboundProducts: [],
        startsAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-08-01T00:00:00.000Z",
      },
    });
  });
});

describe("PATCH console/subscriptions/:id", () => {
  it("edits device limit independently and records old and new limits", async () => {
    billingAdmin.updateSubscription.mockResolvedValue({
      subscription: { id: "sub-1", customerId: "cust-1", expiresAt: null, deviceLimit: 3, config: "{}" },
      previousExpiresAt: null, previousDeviceLimit: 1, previousUsdQuotaByProduct: {},
    });
    await controller.updateSubscription("sub-1", { deviceLimit: 3 }, req);
    expect(billingAdmin.updateSubscription).toHaveBeenCalledWith("sub-1", { deviceLimit: 3 });
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({ previousDeviceLimit: 1, deviceLimit: 3 }),
    }));
  });
  it("delegates to the service and audit-logs the expiry update", async () => {
    billingAdmin.updateSubscription.mockResolvedValue({
      subscription: {
        id: "sub-1",
        customerId: "cust-1",
        expiresAt: new Date("2026-07-01T00:00:00.000Z"),
        config: JSON.stringify({ usdQuotaByProduct: { codex: { fiveHour: 25, weekly: 100 } } }),
      },
      previousExpiresAt: new Date("2026-06-01T00:00:00.000Z"),
      previousUsdQuotaByProduct: { codex: { fiveHour: 10, weekly: 50 } },
    });

    const result = await controller.updateSubscription(
      "sub-1",
      { expiresAt: "2026-07-01T00:00:00.000Z" },
      req,
    );

    expect(billingAdmin.updateSubscription).toHaveBeenCalledWith("sub-1", {
      expiresAt: "2026-07-01T00:00:00.000Z",
    });
    expect(result.subscription.customerId).toBe("cust-1");
    expect(auditLog.log).toHaveBeenCalledWith({
      operatorId: "admin-1",
      action: "UPDATE_SUBSCRIPTION",
      targetType: "Subscription",
      targetId: "sub-1",
      detail: {
        customerId: "cust-1",
        previousExpiresAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-07-01T00:00:00.000Z",
        previousUsdQuotaByProduct: { codex: { fiveHour: 10, weekly: 50 } },
        usdQuotaByProduct: { codex: { fiveHour: 25, weekly: 100 } },
      },
    });
  });

  it("passes USD-only edits through without requiring expiresAt", async () => {
    billingAdmin.updateSubscription.mockResolvedValue({
      subscription: {
        id: "sub-1", customerId: "cust-1", expiresAt: null,
        config: JSON.stringify({ usdQuotaByProduct: { codex: { fiveHour: 12.5, weekly: 80 } } }),
      },
      previousExpiresAt: null,
      previousUsdQuotaByProduct: {},
    });

    const quota = { codex: { fiveHour: 12.5, weekly: 80 } };
    await controller.updateSubscription("sub-1", { usdQuotaPerSeatByProduct: quota }, req);

    expect(billingAdmin.updateSubscription).toHaveBeenCalledWith("sub-1", {
      usdQuotaPerSeatByProduct: quota,
    });
  });
});

describe("POST console/subscriptions/:id/usd-quota/reset", () => {
  it("delegates one product window reset and records the previous amount in the audit log", async () => {
    billingAdmin.resetSubscriptionUsdQuotaUsage.mockResolvedValue({
      subscriptionId: "sub-1",
      customerId: "cust-1",
      product: "codex",
      scope: "weekly",
      previousUsed: 12.5,
      limit: 100,
      usageByProduct: { codex: { fiveHour: null, weekly: { used: 0, limit: 100 } } },
    });

    await controller.resetSubscriptionUsdQuotaUsage(
      "sub-1",
      { product: "codex", scope: "weekly" },
      req,
    );

    expect(billingAdmin.resetSubscriptionUsdQuotaUsage).toHaveBeenCalledWith("sub-1", "codex", "weekly");
    expect(auditLog.log).toHaveBeenCalledWith({
      operatorId: "admin-1",
      action: "RESET_SUBSCRIPTION_USD_QUOTA",
      targetType: "Subscription",
      targetId: "sub-1",
      detail: {
        customerId: "cust-1",
        product: "codex",
        scope: "weekly",
        previousUsed: 12.5,
        limit: 100,
      },
    });
  });
});
