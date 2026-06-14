import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";

import { Public } from "../../../shared/auth/public.decorator";
import { CustomerJwtGuard } from "../customer-auth/customer-jwt.guard";
import { CurrentCustomer } from "../customer-auth/customer.decorator";
import { CustomerUser } from "../customer-auth/customer-jwt.strategy";
import { PortalService } from "./portal.service";

/**
 * PortalController — customer web portal overview and usage history.
 *
 * All routes are @Public() (skip global admin JwtAuthGuard) but protected
 * by CustomerJwtGuard via @UseGuards.
 */
@Controller("account/portal")
@Public()
@UseGuards(CustomerJwtGuard)
export class PortalController {
  constructor(private readonly portalService: PortalService) {}

  /**
   * GET /api/account/portal/overview
   * → { customer, subscriptions, devices, unreadNotifications }
   */
  @Get("overview")
  overview(@CurrentCustomer() customer: CustomerUser) {
    return this.portalService.getOverview(customer.customerId);
  }
}

/**
 * UsageController — customer usage history (/api/account/usage).
 *
 * Separate @Controller path — usage conceptually belongs to portal domain
 * but lives at /api/account/usage per contract.
 */
@Controller("account/usage")
@Public()
@UseGuards(CustomerJwtGuard)
export class UsageController {
  constructor(private readonly portalService: PortalService) {}

  /**
   * GET /api/account/usage?page=&pageSize=&days=
   * days ∈ {1,7,30}, default 7; pageSize default 20 cap 100
   * → { records, total, page, pageSize }
   */
  @Get()
  usage(
    @CurrentCustomer() customer: CustomerUser,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("days") days?: string,
  ) {
    return this.portalService.getUsage(customer.customerId, {
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      days: days ? parseInt(days, 10) : undefined,
    });
  }

  /**
   * GET /api/account/usage/stats?days=
   * days ∈ {1,7,30}, default 7
   * → { granularity, points, byModel, status, totals } — 历史记录页统计图
   */
  @Get("stats")
  usageStats(
    @CurrentCustomer() customer: CustomerUser,
    @Query("days") days?: string,
  ) {
    return this.portalService.getUsageStats(customer.customerId, {
      days: days ? parseInt(days, 10) : undefined,
    });
  }
}

/**
 * SubscriptionPriorityController — set the priority (relay order) of a subscription.
 *
 * POST /api/account/subscriptions/priority  body: { subscriptionId, priority }
 * → { ok: true, subscriptions: [...] }
 */
@Controller("account/subscriptions")
@Public()
@UseGuards(CustomerJwtGuard)
export class SubscriptionPriorityController {
  constructor(private readonly portalService: PortalService) {}

  /** POST /api/account/subscriptions/priority  body: { subscriptionId, priority } */
  @Post("priority")
  setPriority(
    @CurrentCustomer() customer: CustomerUser,
    @Body() body: { subscriptionId: string; priority: number },
  ) {
    return this.portalService.setSubscriptionPriority(customer.customerId, body.subscriptionId, Number(body.priority));
  }
}
