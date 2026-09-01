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
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Patch,
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

  @Get("subscriptions/:id")
  getSubscription(@Param("id") id: string) {
    return this.billingAdmin.getSubscription(id);
  }

  @Post("plan-orders/:id/sync")
  async syncOrderPayment(@Param("id") id: string) {
    return this.billingAdmin.syncOrderPayment(id);
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

  @Post("subscriptions/:id/rebind")
  async rebindSubscription(
    @Param("id") id: string,
    @Body() body: { product?: string; accountId?: number; force?: boolean },
    @Request() req: any,
  ) {
    const result = await this.billingAdmin.rebindSubscription(
      id,
      String(body?.product || ""),
      Number(body?.accountId || 0),
      body?.force === true,
    );
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "REBIND_SUBSCRIPTION",
      targetType: "Subscription",
      targetId: id,
      detail: { product: result.product, accountId: result.accountId, force: body?.force === true },
    });
    return result;
  }

  @Post("account-bindings/reset")
  async resetBoundAccountQuotas(
    @Body() body: { product?: string; accountId?: number },
    @Request() req: any,
  ) {
    const result = await this.billingAdmin.resetBoundAccountQuotas(String(body?.product || ""), Number(body?.accountId || 0));
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "RESET_ACCOUNT_BOUND_USD_QUOTAS",
      targetType: "UpstreamAccount",
      targetId: `${result.product}:${result.accountId}`,
      detail: result,
    });
    return result;
  }

  @Post("account-bindings/rebind")
  async rebindBoundAccountSubscriptions(
    @Body() body: { product?: string; accountId?: number; force?: boolean },
    @Request() req: any,
  ) {
    const force = body?.force === true;
    const result = await this.billingAdmin.rebindBoundAccountSubscriptions(String(body?.product || ""), Number(body?.accountId || 0), force);
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "REBIND_ACCOUNT_SUBSCRIPTIONS",
      targetType: "UpstreamAccount",
      targetId: `${result.product}:${result.sourceAccountId}`,
      detail: { ...result, force },
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

  @Post("subscriptions/:id/seats/upgrade")
  async upgradeSubscriptionSeats(
    @Param("id") id: string,
    @Body() body: { shareSeats?: number },
    @Request() req: any,
  ) {
    const result = await this.billingAdmin.upgradeSubscriptionSeats(id, Number(body?.shareSeats || 0));
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "UPGRADE_SUBSCRIPTION_SEATS",
      targetType: "Subscription",
      targetId: id,
      detail: {
        customerId: result.subscription.customerId,
        previousShareSeats: result.previousShareSeats,
        shareSeats: result.shareSeats,
        alreadyAtTarget: result.alreadyAtTarget,
        reboundProducts: result.reboundProducts,
        startsAt: result.subscription.startsAt?.toISOString() ?? null,
        expiresAt: result.subscription.expiresAt?.toISOString() ?? null,
      },
    });
    return result;
  }

  @Post("subscriptions/:id/usd-quota/reset")
  async resetSubscriptionUsdQuotaUsage(
    @Param("id") id: string,
    @Body() body: { product?: string; scope?: "fiveHour" | "weekly" },
    @Request() req: any,
  ) {
    const product = String(body?.product || "");
    const scope = String(body?.scope || "") as "fiveHour" | "weekly";
    const result = await this.billingAdmin.resetSubscriptionUsdQuotaUsage(id, product, scope);
    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "RESET_SUBSCRIPTION_USD_QUOTA",
      targetType: "Subscription",
      targetId: id,
      detail: {
        customerId: result.customerId,
        product: result.product,
        scope: result.scope,
        previousUsed: result.previousUsed,
        limit: result.limit,
      },
    });
    return result;
  }

  @Patch("subscriptions/:id")
  async updateSubscription(
    @Param("id") id: string,
    @Body() body: { expiresAt?: string; usdQuotaPerSeatByProduct?: Record<string, { fiveHour?: number; weekly?: number }> },
    @Request() req: any,
  ) {
    const result = await this.billingAdmin.updateSubscription(id, body);

    await this.auditLog.log({
      operatorId: req.user?.id,
      action: "UPDATE_SUBSCRIPTION",
      targetType: "Subscription",
      targetId: id,
      detail: {
        customerId: result.subscription.customerId,
        previousExpiresAt: result.previousExpiresAt?.toISOString() ?? null,
        expiresAt: result.subscription.expiresAt?.toISOString() ?? null,
        previousUsdQuotaByProduct: result.previousUsdQuotaByProduct,
        usdQuotaByProduct: result.subscription.config ? JSON.parse(result.subscription.config).usdQuotaByProduct ?? {} : {},
      },
    });

    return result;
  }
}
