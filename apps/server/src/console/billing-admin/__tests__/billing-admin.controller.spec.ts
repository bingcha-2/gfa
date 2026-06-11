/**
 * billing-admin.controller.spec.ts — wiring of the console refund/revoke
 * endpoints: guard + roles metadata (admin-mutation convention) and the
 * audit-log entry written per mutation.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { BillingAdminController } from "../billing-admin.controller";
import { ConsoleJwtGuard } from "../../console-jwt.guard";
import { ROLES_KEY } from "../../../auth/roles.decorator";

let billingAdmin: { refundOrder: ReturnType<typeof vi.fn>; revokeSubscription: ReturnType<typeof vi.fn> };
let auditLog: { log: ReturnType<typeof vi.fn> };
let controller: BillingAdminController;

const req = { user: { id: "admin-1" } } as any;

beforeEach(() => {
  billingAdmin = { refundOrder: vi.fn(), revokeSubscription: vi.fn() };
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
