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
import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";

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

  @Get("plan-orders")
  listOrders(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("pageSize", new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
    @Query("status") status?: string,
    @Query("payChannel") payChannel?: string,
    @Query("search") search?: string,
  ) {
    return this.billingAdmin.listOrders({ page, pageSize, status, payChannel, search });
  }

  @Get("subscriptions")
  listSubscriptions(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("pageSize", new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
    @Query("status") status?: string,
    @Query("search") search?: string,
  ) {
    return this.billingAdmin.listSubscriptions({ page, pageSize, status, search });
  }

  @Get("billing-stats")
  billingStats() {
    return this.billingAdmin.billingStats();
  }

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
