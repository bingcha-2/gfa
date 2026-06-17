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
  updateSubscription: ReturnType<typeof vi.fn>;
};
let auditLog: { log: ReturnType<typeof vi.fn> };
let controller: BillingAdminController;

const req = { user: { id: "admin-1" } } as any;

beforeEach(() => {
  billingAdmin = { refundOrder: vi.fn(), revokeSubscription: vi.fn(), updateSubscription: vi.fn() };
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

describe("PATCH console/subscriptions/:id", () => {
  it("delegates to the service and audit-logs the expiry update", async () => {
    billingAdmin.updateSubscription.mockResolvedValue({
      subscription: { id: "sub-1", customerId: "cust-1", expiresAt: new Date("2026-07-01T00:00:00.000Z") },
      previousExpiresAt: new Date("2026-06-01T00:00:00.000Z"),
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
      },
    });
  });
});
