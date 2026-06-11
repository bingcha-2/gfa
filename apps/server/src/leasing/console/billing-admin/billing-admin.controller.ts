/**
 * billing-admin.controller.ts — console refund/revoke endpoints.
 *
 *   POST console/plan-orders/:id/refund   — internal refund state flip
 *   POST console/subscriptions/:id/revoke — cancel a subscription
 *
 * Follows the console admin-mutation convention (see plan-admin.controller):
 * ConsoleJwtGuard + @Roles("ADMIN","OPERATIONS") at class level, every
 * mutation audit-logged with the operator id.
 */
import { Controller, Param, Post, Request, UseGuards } from "@nestjs/common";

import { ConsoleJwtGuard } from "../../../shared/auth/console-jwt.guard";
import { Roles } from "../../../shared/auth/roles.decorator";
import { AuditLogService } from "../../../shared/audit-log/audit-log.service";
import { BillingAdminService } from "./billing-admin.service";

@Controller("console")
@UseGuards(ConsoleJwtGuard)
@Roles("ADMIN", "OPERATIONS")
export class BillingAdminController {
  constructor(
    private readonly billingAdmin: BillingAdminService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Post("plan-orders/:id/refund")
  async refundOrder(@Param("id") id: string, @Request() req: any) {
    const result = await this.billingAdmin.refundOrder(id);

    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "REFUND_PLAN_ORDER",
      targetType: "PlanOrder",
      targetId: id,
      detail: {
        alreadyRefunded: result.alreadyRefunded,
        cancelledSubscriptionId: result.cancelledSubscriptionId,
        customerId: result.order.customerId,
        amountCents: result.order.amountCents,
      },
    });

    return result;
  }

  @Post("subscriptions/:id/revoke")
  async revokeSubscription(@Param("id") id: string, @Request() req: any) {
    const result = await this.billingAdmin.revokeSubscription(id);

    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "REVOKE_SUBSCRIPTION",
      targetType: "Subscription",
      targetId: id,
      detail: {
        alreadyCancelled: result.alreadyCancelled,
        customerId: result.subscription.customerId,
      },
    });

    return result;
  }
}
